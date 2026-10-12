/**
 * lib/quoxperticusInstance.js — QUOXPERTICUS P0b (DEC-1, DEC-4)
 *
 * Instance-level switch helpers. The disposable_test property marks an ENTIRE
 * instance as a throwaway sandbox (no real data, no path to prod); only such an
 * instance may ever grant the QUOXPERTICUS agent-approval relaxation. DEC-4
 * adds the test-approver LEASE (instance.test_approver_lease_until): the
 * relaxation must be leased/expiring, not latched, so an accidental on-state
 * self-heals when the lease runs out.
 *
 * Read-only. Both values are written ONLY through the human-admin config PATCH
 * (routes/admin.js, behind requireInstanceAdmin — no service/agent path), so a
 * resident agent cannot flip its own sandbox status or extend its own lease.
 * Fail-safe: any absent/unknown/error state returns false/null, so the
 * relaxation is never granted by accident.
 *
 * P1 adds getQuoxperticusMode(db) (instance.mode.quoxperticus): the per-instance
 * resident-agent operating level, OFF | OBSERVE | PARTIAL | FULL. Same
 * human-admin-writable-only path as the two properties above. FULL is reachable
 * ONLY on a disposable_test instance — on a real instance a stored FULL resolves
 * to PARTIAL (a cap, not an error). Any absent/unknown/garbage value resolves to
 * OFF (fail-safe).
 */
export const DISPOSABLE_TEST_KEY = 'instance.disposable_test';
export const TEST_APPROVER_LEASE_KEY = 'instance.test_approver_lease_until';
export const QUOXPERTICUS_MODE_KEY = 'instance.mode.quoxperticus';
export const QUOXPERTICUS_ORG_KEY = 'instance.quoxperticus.org_id';
export const QUOXPERTICUS_MODES = ['OFF', 'OBSERVE', 'PARTIAL', 'FULL'];

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} true only if the instance_config row is exactly 'true'.
 */
export function isDisposableTestInstance(db) {
  try {
    const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(DISPOSABLE_TEST_KEY);
    return row ? row.value === 'true' : false;
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {string|null} the stored lease-expiry string, or null when absent/empty/error.
 *   Not parsed or validated here — the collector evaluates expiry.
 */
export function getTestApproverLeaseUntil(db) {
  try {
    const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(TEST_APPROVER_LEASE_KEY);
    return row && row.value ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {string} one of QUOXPERTICUS_MODES. Absent/unknown/garbage resolves
 *   to 'OFF' (fail-safe). A stored 'FULL' is capped to 'PARTIAL' unless the
 *   instance is disposable_test.
 */
export function getQuoxperticusMode(db) {
  try {
    const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(QUOXPERTICUS_MODE_KEY);
    const value = row && row.value ? String(row.value).trim().toUpperCase() : '';
    const mode = QUOXPERTICUS_MODES.includes(value) ? value : 'OFF';
    if (mode === 'FULL' && !isDisposableTestInstance(db)) return 'PARTIAL';
    return mode;
  } catch {
    return 'OFF';
  }
}

/**
 * P3: the org the resident agent operates under on this instance
 * (instance.quoxperticus.org_id, migration 096). The wake seam refuses to
 * create patrols while unbound. Same human-admin-only write path as every
 * other key here.
 * @param {import('better-sqlite3').Database} db
 * @returns {string|null} the bound org id, or null when absent/empty/error.
 */
export function getQuoxperticusOrgId(db) {
  try {
    const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(QUOXPERTICUS_ORG_KEY);
    return row && row.value ? row.value : null;
  } catch {
    return null;
  }
}
