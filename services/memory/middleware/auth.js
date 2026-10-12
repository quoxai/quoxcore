// Internal service-to-service auth for the memory service — TRUST-GATE-1.12a
//
// Before: services/memory/server.js's authenticate() accepted ONLY a user
// JWT (Bearer header or access_token cookie). Every internal collector call
// (session journals, memory consolidation, memory-implant injection) 401'd
// in production because there was no system-caller path.
//
// After: an X-Service-Key header matching INTERNAL_SERVICE_KEY authenticates
// the caller as a trusted internal service, with org/user scope taken from
// X-Org-Id / X-User-Id headers — never from the request body (same
// tenant-injection defence server.js already applies on the JWT path).
// Mirrors the house pattern already used in services/tasks/middleware/auth.js
// (and by approvalGate.js / quoxchat.js / memoryConsolidationScheduler.js /
// responseEnrichment.js elsewhere in the ecosystem). The existing user-JWT
// path is unchanged; service-key is checked first, JWT is the fallback.

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

/**
 * Authenticate a request either as an internal service (X-Service-Key +
 * X-Org-Id/X-User-Id scoping headers) or as a user (JWT Bearer/cookie).
 * On success sets req.org_id, req.user_id, req.user.
 */
export function authenticate(req, res, next) {
  const serviceKey = req.headers['x-service-key']
  const internalKey = process.env.INTERNAL_SERVICE_KEY
  if (serviceKey && internalKey && safeCompare(serviceKey, internalKey)) {
    req.org_id = req.headers['x-org-id'] || 'default'
    req.user_id = req.headers['x-user-id'] || 'service'
    req.user = { org_id: req.org_id, sub: req.user_id, role: 'service' }
    // Set only here, never from a token claim: gates instance-only routes (erase-user).
    req.service = true
    return next()
  }

  const token = extractToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization header' })
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    // BRAIN2-W5 005: a refresh token must never work as a bearer credential
    // (parity with quoxbrain). Tokens with no type claim stay accepted.
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
    next()
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

/**
 * Boot-time guard, mirroring the fail-loud-in-production / warn-elsewhere
 * pattern already used for other required secrets (e.g. services/auth's
 * POWERS_SKIP_* production guard, this service's own JWT_SECRET check).
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

  warnFn('[Memory Service] WARNING: INTERNAL_SERVICE_KEY not set — internal service-to-service calls (X-Service-Key) will 401 in this environment')
  return true
}
