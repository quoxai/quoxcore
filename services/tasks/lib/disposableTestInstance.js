/**
 * Disposable Test Instance (tasks-side client)
 *
 * P0b (QUOXPERTICUS DEC-1 + DEC-4 + DEC-9): "is this whole instance a
 * throwaway sandbox, and does it currently hold an unexpired test-approver
 * lease?". The tasks service asks so loop dispatch can stamp a loop as
 * sandbox-leased and the loop consumer can halt it when the lease lapses
 * (DEC-9: lease expiry halts in-flight execution, not just new approvals).
 * ESM sibling of services/collector/lib/disposableTestInstance.js, same
 * contract against the same auth endpoint.
 *
 * Both values are INSTANCE properties, read server-side from the auth service
 * over the internal service-key channel. They are deliberately NOT taken from
 * any caller-supplied value — an agent that could set its own sandbox flag or
 * lease could unlock (or un-leash) itself.
 *
 * Fail-safe false: any transport error, non-2xx, or malformed body answers
 * false (locked) and is NOT cached, so a transient auth blip cannot pin an
 * instance open. Only a successful answer is cached (60s). Lease EXPIRY is
 * evaluated at CALL time against the cached value, so a lease running out
 * inside the TTL flips to locked immediately, never waiting on a refetch.
 */

const CACHE_TTL_MS = 60_000

// { disposable: boolean, leaseUntil: string|null, mode: string,
//   orgId: string|null, expiresAt: number } | null — successful answers only.
let _cache = null

// P1: the per-instance QUOXPERTICUS mode, resolved (and FULL-capped) by the
// auth service. The client only validates shape and fails safe OFF.
const QUOXPERTICUS_MODES = new Set(['OFF', 'OBSERVE', 'PARTIAL', 'FULL'])

async function getInstanceSandboxStatus() {
  if (_cache && _cache.expiresAt > Date.now()) {
    return { disposable: _cache.disposable, leaseUntil: _cache.leaseUntil, mode: _cache.mode, orgId: _cache.orgId }
  }

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101'
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''

  try {
    const res = await fetch(`${authUrl}/api/internal/instance/disposable-test`, {
      headers: {
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
      },
      signal: AbortSignal.timeout(5000),
    })

    // Status BEFORE body: an error body is not data.
    if (!res || !res.ok) {
      console.warn(`[DisposableTestInstance] auth service returned HTTP ${res && res.status}; treating instance as NOT disposable.`)
      return { disposable: false, leaseUntil: null, mode: 'OFF', orgId: null }
    }

    const body = await res.json()
    if (!body || typeof body !== 'object' || typeof body.disposable_test !== 'boolean') {
      console.warn('[DisposableTestInstance] malformed response body; treating instance as NOT disposable.')
      return { disposable: false, leaseUntil: null, mode: 'OFF', orgId: null }
    }

    const leaseUntil = typeof body.test_approver_lease_until === 'string' && body.test_approver_lease_until
      ? body.test_approver_lease_until
      : null

    // P1: absent (older auth) or unrecognized mode is simply OFF.
    const rawMode = typeof body.quoxperticus_mode === 'string' ? body.quoxperticus_mode.trim().toUpperCase() : ''
    const mode = QUOXPERTICUS_MODES.has(rawMode) ? rawMode : 'OFF'

    // P3: the org binding the wake seam patrols under; absent/empty = unbound.
    const orgId = typeof body.quoxperticus_org_id === 'string' && body.quoxperticus_org_id
      ? body.quoxperticus_org_id
      : null

    const disposable = body.disposable_test === true
    _cache = { disposable, leaseUntil, mode, orgId, expiresAt: Date.now() + CACHE_TTL_MS }
    return { disposable, leaseUntil, mode, orgId }
  } catch (err) {
    console.warn('[DisposableTestInstance] lookup failed, treating instance as NOT disposable:', err && err.message)
    return { disposable: false, leaseUntil: null, mode: 'OFF', orgId: null }
  }
}

/**
 * @returns {Promise<boolean>} true only when the auth service positively
 * reports this instance as a disposable test instance.
 */
export async function isDisposableTestInstance() {
  const status = await getInstanceSandboxStatus()
  return status.disposable
}

/**
 * The sandbox approval grant: disposable instance AND a test-approver lease
 * whose ISO-8601 expiry is strictly in the future right now. A missing,
 * empty, or unparseable lease is no lease.
 */
export async function hasActiveSandboxApprovalGrant() {
  const status = await getInstanceSandboxStatus()
  if (!status.disposable || !status.leaseUntil) return false
  const expiry = Date.parse(status.leaseUntil)
  if (!Number.isFinite(expiry)) return false
  return expiry > Date.now()
}

/**
 * P1: the per-instance QUOXPERTICUS mode (OFF | OBSERVE | PARTIAL | FULL),
 * as resolved and FULL-capped by the auth service. Fail-safe 'OFF'.
 */
export async function getQuoxperticusMode() {
  const status = await getInstanceSandboxStatus()
  return status.mode || 'OFF'
}

/**
 * P3: the org id the resident agent operates under on this instance, as
 * bound by an instance admin (instance.quoxperticus.org_id). Null = unbound
 * (and the wake seam refuses). Fail-safe null.
 */
export async function getQuoxperticusOrgId() {
  const status = await getInstanceSandboxStatus()
  return status.orgId || null
}

/** Test-only: drop the memoised answer so the next call refetches. */
export function _resetCacheForTests() {
  _cache = null
}
