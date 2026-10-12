/**
 * Disposable Test Instance
 *
 * P0b (QUOXPERTICUS DEC-1 + DEC-4): "is this whole instance a throwaway
 * sandbox, and does it currently hold an unexpired test-approver lease?".
 * A sandbox instance with an active lease may relax the propose-not-resolve
 * gate in approvalGate.js so the full HITL loop can be exercised without a
 * human in it; a real instance never may, and even a sandbox locks again the
 * moment its lease expires (leased, not latched — an accidental on-state
 * self-heals).
 *
 * Both values are INSTANCE properties, read server-side from the auth service
 * over the internal service-key channel. They are deliberately NOT taken from
 * ctx, tool input, a header, or any other caller-supplied value — an agent
 * that could set its own sandbox flag or lease could unlock its own veto,
 * which is the exact invariant this exists to protect.
 *
 * Fail-safe false: any transport error, non-2xx, or malformed body answers
 * false (locked) and is NOT cached, so a transient auth-service blip cannot
 * pin an instance open OR leave it wrongly locked for the full TTL — the next
 * call retries. Only a successful answer is cached. Lease EXPIRY is evaluated
 * at CALL time against the cached value: the cache TTL (60s) is far below the
 * lease granularity (minutes-to-hours), and a lease that runs out inside the
 * TTL flips to locked immediately, never waiting on a refetch.
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

const CACHE_TTL_MS = 60_000;

// { disposable: boolean, leaseUntil: string|null, mode: string, expiresAt: number }
// | null — successful answers only.
let _cache = null;

// P1: the per-instance QUOXPERTICUS mode, resolved (and FULL-capped) by the
// auth service. The client only validates shape and fails safe OFF.
const QUOXPERTICUS_MODES = new Set(['OFF', 'OBSERVE', 'PARTIAL', 'FULL']);

/**
 * Fetch (or serve from cache) the instance sandbox status.
 * @returns {Promise<{disposable: boolean, leaseUntil: string|null}>}
 *   Fail-safe: any error path reports a locked real instance.
 */
async function getInstanceSandboxStatus() {
  if (_cache && _cache.expiresAt > Date.now()) {
    return { disposable: _cache.disposable, leaseUntil: _cache.leaseUntil, mode: _cache.mode };
  }

  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/internal/instance/disposable-test`, {
      headers: {
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });

    // Status BEFORE body: an error body is not data. A 401/404 payload that
    // happens to carry disposable_test:true must never unlock the instance.
    if (!res || !res.ok) {
      console.warn(`[DisposableTestInstance] auth service returned HTTP ${res && res.status}; treating instance as NOT disposable.`);
      return { disposable: false, leaseUntil: null, mode: 'OFF' };
    }

    const body = await res.json();
    if (!body || typeof body !== 'object' || typeof body.disposable_test !== 'boolean') {
      console.warn('[DisposableTestInstance] malformed response body; treating instance as NOT disposable.');
      return { disposable: false, leaseUntil: null, mode: 'OFF' };
    }

    // Older auth services omit the lease field entirely; that is simply "no
    // lease", not an error.
    const leaseUntil = typeof body.test_approver_lease_until === 'string' && body.test_approver_lease_until
      ? body.test_approver_lease_until
      : null;

    // P1: absent (older auth) or unrecognized mode is simply OFF.
    const rawMode = typeof body.quoxperticus_mode === 'string' ? body.quoxperticus_mode.trim().toUpperCase() : '';
    const mode = QUOXPERTICUS_MODES.has(rawMode) ? rawMode : 'OFF';

    const disposable = body.disposable_test === true;
    _cache = { disposable, leaseUntil, mode, expiresAt: Date.now() + CACHE_TTL_MS };
    return { disposable, leaseUntil, mode };
  } catch (err) {
    console.warn('[DisposableTestInstance] lookup failed, treating instance as NOT disposable:', err && err.message);
    return { disposable: false, leaseUntil: null, mode: 'OFF' };
  }
}

/**
 * @returns {Promise<boolean>} true only when the auth service positively
 * reports this instance as a disposable test instance.
 */
async function isDisposableTestInstance() {
  const status = await getInstanceSandboxStatus();
  return status.disposable;
}

/**
 * P0b step 4 (DEC-4 + property 5): the sandbox approval grant. True only when
 * the instance is disposable AND holds a test-approver lease whose ISO-8601
 * expiry is strictly in the future right now. A missing, empty, or
 * unparseable lease is no lease.
 */
async function hasActiveSandboxApprovalGrant() {
  const status = await getInstanceSandboxStatus();
  if (!status.disposable || !status.leaseUntil) return false;
  const expiry = Date.parse(status.leaseUntil);
  if (!Number.isFinite(expiry)) return false;
  return expiry > Date.now();
}

/**
 * P1: the per-instance QUOXPERTICUS mode (OFF | OBSERVE | PARTIAL | FULL),
 * as resolved and FULL-capped by the auth service. Fail-safe 'OFF'.
 */
async function getQuoxperticusMode() {
  const status = await getInstanceSandboxStatus();
  return status.mode || 'OFF';
}

/** Test-only: drop the memoised answer so the next call refetches. */
function _resetCacheForTests() {
  _cache = null;
}

module.exports = {
  isDisposableTestInstance,
  hasActiveSandboxApprovalGrant,
  getQuoxperticusMode,
  _resetCacheForTests,
};
