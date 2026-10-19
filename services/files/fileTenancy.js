/**
 * F01 A' (SITE-CLI audit ENG_01M4Z02S830K0X3K61W50K0X3K): server-side tenancy for the legacy files store.
 *
 * The store kept every org's files in one flat directory and trusted the browser to separate tenants, so any
 * signed-in user of any org could list, read, overwrite metadata for, or delete any org's files. Each metadata record
 * now carries its owning orgId. Every route resolves the caller's org from a credential verified HERE (an access JWT,
 * or the internal service key plus X-Org-Id) and only ever sees that org's records. A file with no proven owner is
 * QUARANTINED: hidden from every org until an instance owner assigns it (never guessed).
 *
 * Pure, no I/O, no Express (server.js binds a port at load), so it is unit-tested directly (fileTenancy.test.js).
 */
const { createHmac, timingSafeEqual } = require('crypto')

function header(req, name) {
  const v = req && req.headers ? req.headers[name.toLowerCase()] : undefined
  return Array.isArray(v) ? v[0] : v
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Verify an HS256 access JWT signed with the shared JWT_SECRET. Returns its claims, or null. */
function verifyAccessJwt(token, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token || !secret) return null
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  let head, claims
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch { return null }
  if (!head || head.alg !== 'HS256') return null
  const sig = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url')
  if (!safeEqual(sig, parts[2])) return null
  if (!claims || typeof claims !== 'object') return null
  if (claims.exp != null && Number(claims.exp) <= nowSec) return null
  if (claims.type !== 'access') return null // auth always mints type 'access'; untyped or refresh tokens are refused
  return claims
}

function bearerOrCookie(req) {
  const auth = header(req, 'authorization')
  const m = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
  if (m) return m[1].trim()
  const cookie = header(req, 'cookie')
  const c = typeof cookie === 'string' ? /(?:^|;\s*)access_token=([^;\s]+)/.exec(cookie) : null
  return c ? c[1] : null
}

/**
 * The caller's VERIFIED org. A JWT is checked against jwtSecret and must carry org_id; X-Org-Id is honoured ONLY with
 * the internal service key (the collector acting for a known org). Anything else: null (the route answers 401).
 */
function resolveCaller(req, { jwtSecret, serviceKey } = {}) {
  const svc = header(req, 'x-service-key')
  if (svc) {
    if (!serviceKey || !safeEqual(svc, serviceKey)) return null
    const org = header(req, 'x-org-id')
    return org ? { orgId: String(org), userId: null, role: null, via: 'service' } : null
  }
  const claims = verifyAccessJwt(bearerOrCookie(req), jwtSecret)
  if (!claims || !claims.org_id) return null
  return { orgId: String(claims.org_id), userId: claims.sub || claims.user_id || null, role: claims.role || null, via: 'jwt' }
}

const isQuarantined = (r) => !r || !r.orgId

function visibleRecords(metadata, orgId) {
  return (Array.isArray(metadata) ? metadata : []).filter((r) => r && r.orgId && r.orgId === orgId)
}

function ownsFile(metadata, fileId, orgId) {
  return (Array.isArray(metadata) ? metadata : []).some((r) => r && r.id === fileId && r.orgId && r.orgId === orgId)
}

function stampOrg(records, orgId) {
  return (records || []).map((r) => ({ ...r, orgId }))
}

/**
 * The caller org's view replaces its own records; every other org's records and every quarantined record are kept
 * byte-for-byte. An incoming record whose id already belongs to another org or is quarantined is ignored, so a
 * caller can never claim (or overwrite) a file it does not own.
 */
function mergeOrgMetadata(existing, incoming, orgId) {
  const prior = Array.isArray(existing) ? existing : []
  const foreignIds = new Set(prior.filter((r) => r && r.orgId !== orgId).map((r) => r.id))
  const kept = prior.filter((r) => r && r.orgId !== orgId)
  const mine = (Array.isArray(incoming) ? incoming : [])
    .filter((r) => r && typeof r.id === 'string' && !foreignIds.has(r.id))
    .map((r) => ({ ...r, orgId }))
  return [...kept, ...mine]
}

/** Folders: { byOrg: { <orgId>: [...] }, quarantine: [...] }. A legacy flat array is unowned, so quarantined. */
function normaliseFolders(store) {
  if (Array.isArray(store)) return { byOrg: {}, quarantine: store }
  const s = store && typeof store === 'object' ? store : {}
  return { byOrg: { ...(s.byOrg || {}) }, ...(s.quarantine ? { quarantine: s.quarantine } : {}) }
}

function orgFolders(store, orgId) {
  return normaliseFolders(store).byOrg[orgId] || []
}

function setOrgFolders(store, orgId, folders) {
  const s = normaliseFolders(store)
  s.byOrg[orgId] = Array.isArray(folders) ? folders : []
  return s
}

module.exports = { resolveCaller, verifyAccessJwt, isQuarantined, visibleRecords, ownsFile, stampOrg, mergeOrgMetadata, orgFolders, setOrgFolders }
