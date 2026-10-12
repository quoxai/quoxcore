// Internal service-to-service auth for the brain service — mirrors
// services/memory/middleware/auth.js (TRUST-GATE-1.12a pattern).
//
// An X-Service-Key header matching INTERNAL_SERVICE_KEY authenticates the
// caller as a trusted internal service, with org/user scope taken from
// X-Org-Id / X-User-Id headers — never from the request body (same
// tenant-injection defence the JWT path applies). The existing user-JWT
// path (Bearer / access_token cookie) is unchanged; service-key is checked
// first, JWT is the fallback.
//
// One addition vs. the memory-service original: the service-key branch also
// sets req.service = true, so downstream org-resolution of the form
// `req.user?.org_id || (req.service ? req.query.org_id : null)` (the house
// pattern used across services/collector/server.js) works for this service
// too — a plain JWT caller can never use ?org_id to read another org's rows,
// only a trusted service-key caller can pass org scope via query params.

import jwt from 'jsonwebtoken'
import crypto from 'crypto'

// Constant-time compare to prevent timing attacks on the service key comparison.
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

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
  if (cookies.access_token) return cookies.access_token
  return null
}

// Default 6h (auth mints 1h access tokens; slack for deployments that raise JWT_ACCESS_EXPIRY). QUOXBRAIN_JWT_MAX_AGE_SECONDS overrides; 0 disables the bound.
function tokenMaxAgeSeconds() {
  const raw = process.env.QUOXBRAIN_JWT_MAX_AGE_SECONDS
  const n = raw === undefined || raw === '' ? 21600 : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// astra2 004 (membership): a signed org_id claim is re-checked against the auth
// service (GET /api/internal/identity/verify, service-key authenticated).
// Results are cached briefly (positive 60s, negative 15s, bounded). Errors are
// never cached and FAIL CLOSED (503), with one bounded exception: a member
// CONFIRMED within the last GRACE_MS rides out a transport fault (timeout,
// refused, 5xx) on the last known good answer. A definitive "not a member"
// replaces it at once, so revocation is never softened by the grace; it only
// covers the auth service being slow or down. Concurrent checks for one
// (org,user) share a single in-flight verify. The verifier and clock are
// injectable for tests.
// Why: live 2026-10-07, under box load the 2s verify timed out whenever the
// 60s entry expired and real members saw "Membership verification unavailable".
const POS_TTL_MS = 60_000
const NEG_TTL_MS = 15_000
const GRACE_MS = 5 * 60_000
const CACHE_MAX = 5000
const VERIFY_TIMEOUT_MS = 4000
const membershipCache = new Map()
const inflight = new Map()
let injectedVerifier = null
let clock = () => Date.now()

export function setMembershipVerifier(fn) { injectedVerifier = fn || null }
export function setMembershipClock(fn) { clock = fn || (() => Date.now()) }
export function clearMembershipCache() { membershipCache.clear(); inflight.clear() }

// Resolves {ok:boolean, role?}; throws on any transport/server fault.
export async function defaultMembershipVerifier(orgId, userId, { nodeEnv = process.env.NODE_ENV } = {}) {
  const base = process.env.AUTH_SERVICE_URL
  if (!base) {
    // Test fixtures only. In any other NODE_ENV a missing URL fails closed.
    if (nodeEnv === 'test') return { ok: true }
    throw new Error('AUTH_SERVICE_URL not configured')
  }
  const url = `${base.replace(/\/+$/, '')}/api/internal/identity/verify?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`
  const resp = await fetch(url, {
    headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  })
  if (resp.status === 404) return { ok: false }
  if (resp.status === 200) {
    const body = await resp.json().catch(() => ({}))
    return body.ok === false ? { ok: false } : { ok: true, role: body.role }
  }
  throw new Error(`identity verify returned ${resp.status}`)
}

async function verifyOnce(key, orgId, userId) {
  const result = await (injectedVerifier || defaultMembershipVerifier)(orgId, userId)
  const ok = !!(result && result.ok)
  membershipCache.delete(key)
  if (membershipCache.size >= CACHE_MAX) {
    membershipCache.delete(membershipCache.keys().next().value)
  }
  const now = clock()
  membershipCache.set(key, { ok, exp: now + (ok ? POS_TTL_MS : NEG_TTL_MS), confirmedAt: ok ? now : null })
  return ok
}

async function checkMembership(orgId, userId) {
  const key = `${orgId}\u0000${userId}`
  const hit = membershipCache.get(key)
  if (hit && hit.exp > clock()) return hit.ok
  let p = inflight.get(key)
  if (!p) {
    p = verifyOnce(key, orgId, userId).finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  try {
    return await p
  } catch (error) {
    const last = membershipCache.get(key)
    if (last && last.ok && last.confirmedAt != null && clock() - last.confirmedAt <= GRACE_MS) {
      console.warn('[Brain Service] membership verify failed, using last known good:', error.message)
      return true
    }
    throw error
  }
}

/**
 * Authenticate a request either as an internal service (X-Service-Key +
 * X-Org-Id/X-User-Id scoping headers) or as a user (JWT Bearer/cookie).
 * On success sets req.org_id, req.user_id, req.user (and req.service=true
 * for the service-key path).
 */
export async function authenticate(req, res, next) {
  const serviceKey = req.headers['x-service-key']
  const internalKey = process.env.INTERNAL_SERVICE_KEY
  if (serviceKey && internalKey && safeCompare(serviceKey, internalKey)) {
    req.org_id = req.headers['x-org-id'] || 'default'
    req.user_id = req.headers['x-user-id'] || 'service'
    req.user = { org_id: req.org_id, sub: req.user_id, role: 'service' }
    req.service = true
    return next()
  }

  const token = extractToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization header' })
  }

  try {
    // astra2 004: org/role claims are not re-checked against current membership,
    // so bound how long a signed token is honoured. maxAge counts from iat and is
    // independent of exp; tokens with no iat are rejected by jsonwebtoken when
    // maxAge is set, which is fine because services/auth always stamps iat.
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { maxAge: tokenMaxAgeSeconds() })
    // BRAIN2-AUDIT: services/auth stamps type:'access' on access tokens and
    // type:'refresh' on refresh tokens (utils/crypto.js). A refresh token must
    // never work as a bearer credential. A token carrying NO type claim is
    // still accepted, so internal signers that predate the claim keep working.
    if (decoded.type !== undefined && decoded.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' })
    }
    req.user = decoded
    req.user_id = decoded.sub || decoded.user_id || decoded.userId
    // TRUST-GATE-MT: a user token without an org claim is legitimate (login
    // before org creation) — but bucketing ALL such users into a shared
    // 'default' org let org-less tenants read each other's rows. Scope them
    // to a personal per-user bucket instead.
    req.org_id = decoded.org_id || decoded.orgId
      || (req.user_id ? `user:${req.user_id}` : 'default')
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  // Only a claimed real org needs a membership check; org-less tokens are
  // scoped to the personal user:<id> bucket and claim nothing.
  const claimedOrg = req.user.org_id || req.user.orgId
  if (claimedOrg && req.user_id) {
    try {
      if (!(await checkMembership(claimedOrg, req.user_id))) {
        return res.status(403).json({ error: 'Not a member of the claimed org' })
      }
    } catch (error) {
      console.error('[Brain Service] membership verification failed:', error.message)
      return res.status(503).json({ error: 'Membership verification unavailable' })
    }
  }
  next()
}

/**
 * Boot-time guard, mirroring the fail-loud-in-production / warn-elsewhere
 * pattern already used for other required secrets (e.g. services/auth's
 * POWERS_SKIP_* production guard, services/memory's own JWT_SECRET check).
 * Silent absence of INTERNAL_SERVICE_KEY in production would mean every
 * internal caller falls through to the (missing) JWT path and 401s with
 * no clear signal — so production refuses to boot instead.
 */
export function assertServiceKeyConfiguredForProduction({
  nodeEnv = process.env.NODE_ENV,
  internalServiceKey = process.env.INTERNAL_SERVICE_KEY,
  exitFn = process.exit,
  errorFn = console.error,
  warnFn = console.warn,
} = {}) {
  if (internalServiceKey) return true

  if (nodeEnv === 'production') {
    errorFn('FATAL: INTERNAL_SERVICE_KEY environment variable is required in production')
    errorFn('Set INTERNAL_SERVICE_KEY to the same value used by other Quox services for service-to-service auth (X-Service-Key)')
    exitFn(1)
    return false
  }

  warnFn('[Brain Service] WARNING: INTERNAL_SERVICE_KEY not set — internal service-to-service calls (X-Service-Key) will 401 in this environment')
  return true
}
