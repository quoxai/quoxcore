// JWT authentication middleware — mirrors memory service pattern
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { verifyStepUpHeader, stepUpEnforced } from '../lib/stepUpToken.js'

// MCPB-HARDEN-1b: constant-time string compare to prevent timing attacks on
// the service key comparison.
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

const JWT_SECRET = process.env.JWT_SECRET

function parseCookieHeader(cookieHeader) {
  const cookies = {}
  if (!cookieHeader) return cookies
  cookieHeader.split(';').forEach(c => {
    const [name, ...rest] = c.trim().split('=')
    if (name) cookies[name.trim()] = rest.join('=').trim()
  })
  return cookies
}

function extractToken(req) {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  const cookies = parseCookieHeader(req.headers.cookie)
  if (cookies.access_token) {
    return cookies.access_token
  }
  return null
}

export function authenticate(req, res, next) {
  // Allow internal service-to-service calls via X-Service-Key + X-Org-Id
  const serviceKey = req.headers['x-service-key']
  const internalKey = process.env.INTERNAL_SERVICE_KEY
  if (serviceKey && internalKey && safeCompare(serviceKey, internalKey)) {
    req.org_id = req.headers['x-org-id'] || 'default'
    req.user_id = req.headers['x-user-id'] || 'service'
    req.user = { org_id: req.org_id, sub: req.user_id, role: 'service' }
    // P0a: mark that this request was authenticated by the shared service key
    // (not a real human session). The X-User-Id above is attacker-supplied, so
    // this flag lets HITL-approval routes refuse a spoofed-human self-approval.
    req.viaServiceKey = true
    return next()
  }

  const token = extractToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization' })
  }

  try {
    // P0a: pin the algorithm (matches services/auth/utils/crypto.js), so the
    // tasks verifier and the auth signer agree on exactly one algorithm rather
    // than accepting any of jsonwebtoken's default HMAC algorithms.
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
    req.user = decoded
    req.user_id = decoded.sub || decoded.user_id || decoded.userId
    // TRUST-GATE-MT: org-less user tokens get a personal per-user bucket,
    // not the shared 'default' org (cross-tenant read risk) — mirrors
    // services/memory/middleware/auth.js.
    req.org_id = decoded.org_id || decoded.orgId
      || (req.user_id ? `user:${req.user_id}` : 'default')
    next()
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

// P0a (QUOXPERTICUS HARD INVARIANT #1): HITL approvals are for humans. A caller
// authenticated by the shared INTERNAL_SERVICE_KEY (req.viaServiceKey) must NOT
// be able to approve, reject, or halt a HITL checkpoint — the service-key branch
// trusts an attacker-supplied X-User-Id, so allowing it would let any key holder
// self-approve as a spoofed human. Mount AFTER authenticate on those routes.
export function requireHumanApprover(req, res, next) {
  // P0a: the shared service key is not a human. P0b (DEC-3): neither is an agent
  // acting as a user — a token carrying an agent_id is agent actor_type, and an
  // agent may never approve a HITL item in a real context (the disposable-test
  // instance exception is added server-side later, not here). Both fail closed.
  // SVC-AUTH #447 bridge: agent_ops JWTs are real user sessions OPERATED BY
  // an agent — allowed everywhere else, barred here so the no-agent-HITL-
  // self-approval invariant is enforced by code, not etiquette.
  if (req.viaServiceKey || req.user?.agent_id || req.user?.agent_ops) {
    return res.status(403).json({
      error: 'HITL approval requires a human session; a service key or agent identity cannot approve, reject, or halt',
    })
  }
  next()
}

/**
 * P0b (DEC-3): same human-only rule, with the ONE designed exception — a
 * disposable_test instance holding an unexpired test-approver lease (read
 * server-side from auth, fail-safe locked), so the QUOXPERTICUS sandbox loop
 * can exercise the objective spine (approve-plan and friends) end to end.
 * Every real instance behaves exactly like requireHumanApprover.
 */
export function requireHumanApproverUnlessSandbox(req, res, next) {
  if (!req.viaServiceKey && !req.user?.agent_id && !req.user?.agent_ops) return next()
  import('../lib/disposableTestInstance.js')
    .then(({ hasActiveSandboxApprovalGrant }) => hasActiveSandboxApprovalGrant())
    .catch(() => false)
    .then((grantActive) => {
      if (grantActive) return next()
      return res.status(403).json({
        error: 'HITL approval requires a human session; a service key or agent identity cannot approve, reject, or halt',
      })
    })
}

/**
 * QUOXON-STEPUP: approving a plan or checkpoint is a person's decision. A human JWT proves a login, not
 * a person (an agent can hold `quox -p <human>`), so approval needs a live step-up token minted by auth
 * after a PIN verify, bound to this user, session, org and the `approve` scope. Objectives and
 * checkpoints are agent-raised by nature, so this is unconditional. The disposable-test sandbox lease
 * (read server-side from auth, fail-safe locked) is the one exemption. Mount AFTER the human-approver gate.
 */
export function requireStepUpApprove(req, res, next) {
  import('../lib/disposableTestInstance.js')
    .then(({ hasActiveSandboxApprovalGrant }) => hasActiveSandboxApprovalGrant())
    .catch(() => false)
    .then((grantActive) => {
      if (grantActive) return next()
      const chk = verifyStepUpHeader(req, {
        userId: req.user_id,
        sessionId: req.user?.session_id || null,
        orgId: req.user?.org_id || req.user?.orgId || null,
        scope: 'approve',
        secret: JWT_SECRET,
      })
      if (chk.ok) return next()
      if (!stepUpEnforced()) { console.warn(`[StepUp] would require step-up (not enforced): tasks approve, reason=${chk.reason}`); return next() }
      return res.status(403).json({
        error: 'step_up_required',
        reason: chk.reason,
        scope: 'approve',
        message: 'A person must confirm this approval with their step-up PIN',
      })
    })
}
