/**
 * configResolver.js — VAULT-INTEG P13 slice 2.
 *
 * The collector has never had a general-purpose config module: every knob
 * that wasn't a boolean feature flag was read as a bare `process.env`
 * lookup assigned to a top-level const, at the top of its owning file,
 * once, at require() time. A DB-backed
 * override in org_platform_settings (platformSettingsStore.js) can never
 * reach a value frozen into a module-load constant — the process would
 * have to restart AND re-require the file for a stored override to have
 * any effect at all, and several of these constants are read exactly once
 * ever, at require() time, so even a restart wouldn't help.
 *
 * getSetting(orgId, key) and getInstanceSetting(key) are the fix: both
 * resolve fresh on every call, through the SAME shared precedence function
 * every other settings consumer in this codebase uses
 * (platformCapabilities.resolveEffectiveCapability, via
 * platformSettingsStore.getEffectiveFlag) — stored override wins, env is
 * the fallback, the registry's declared default is the last resort.
 *
 * Production wiring: this module is explicitly OUT of server.js's
 * init-sequence territory for this slice (another agent owns server.js),
 * so it cannot receive a voltDb handle the way approvalGate.js/
 * contentRedactor.js/conversationRecall.js do (their setDatabase()/
 * configure() calls all live in server.js). Instead it opens its OWN
 * readonly connection to the same on-disk file server.js's own voltDb
 * points at (VOLT_DB_PATH) — this is not a new pattern: lib/feedDbSource.js
 * already does exactly this (openReadonlyDb: readonly + `query_only`
 * pragma) for the identical reason (a lib module that needs to read the
 * collector's db without being threaded through server.js's boot
 * sequence). volt.db runs in WAL mode (server.js sets `journal_mode =
 * WAL` on its own handle), which is what makes a second, independent
 * reader safe to open alongside the writer.
 *
 * getSetting(orgId, key) — org-scoped. Precedence: this org's stored
 * override in org_platform_settings > env > the registry's declared
 * default (platformCapabilities.CAPABILITIES).
 *
 * getInstanceSetting(key) — for knobs that govern the WHOLE process
 * (a scheduler's tick cadence, a storage quota, a tool executor's
 * timeout) rather than one org's behaviour. Resolved against a reserved
 * sentinel scope (INSTANCE_SCOPE_ORG_ID) in the SAME org_platform_settings
 * table — no schema change, just a fixed value nothing else will collide
 * with (org_platform_settings' primary key is (org_id, key); this string
 * is not, and will never be, a real org id).
 *
 * HONESTY NOTE: no write surface exists yet that lets an operator PATCH
 * the instance-wide sentinel scope — the Settings API's write path
 * (routes covering platformSettingsStore.setOrgSetting) is scoped to the
 * authenticated caller's real org_id. An instance-wide override can be
 * seeded directly into org_platform_settings today (org_id =
 * INSTANCE_SCOPE_ORG_ID); a dedicated instance-settings write path is a
 * follow-on, not shipped in this slice. Until one lands,
 * getInstanceSetting() will report `source: 'env'` in every real
 * deployment — that is surfaced honestly by resolveEffectiveCapability
 * itself, not hidden here. Every call site rewired to use it still gets a
 * genuine call-time (never module-load) env read either way, which is the
 * P13 slice 2 scope: give the read sites a real config module to call
 * through, so the write side (this slice's follow-on) has somewhere to
 * land.
 *
 * Both functions degrade to a safe env-only resolution — never throw —
 * exactly like every other platformSettingsStore consumer in this
 * codebase, when the db file doesn't exist yet, isn't reachable, or the
 * org_platform_settings table hasn't been created (a fresh collector
 * mid-boot): platformSettingsStore.getEffectiveFlag() already wraps its
 * own raw-value lookup in a try/catch for exactly this case.
 */

'use strict';

const Database = require('better-sqlite3');
const { getEffectiveFlag } = require('./platformSettingsStore.js');

// Reserved scope for instance-wide (non-org) settings. Not a real org id —
// nothing else in the org_platform_settings schema uses or will ever
// collide with this string.
const INSTANCE_SCOPE_ORG_ID = '__instance__';

// No caching by default — every call re-reads the store, which is what
// makes this a genuine call-time resolver rather than a slow-motion
// module-load snapshot. A short TTL cache is a reasonable FUTURE
// optimisation if a read site here ever becomes request-hot (none of the
// P13 slice 2 sites are — a handful of scheduler ticks and per-tool-call
// reads), and this module deliberately does NOT grow a new env var for its
// own tuning to get one: the collector's env-registry ratchet
// (scripts/pre-commit-env-check.sh) blocks any newly-introduced,
// unregistered process.env read under services/, and this slice's whole
// point is rewiring EXISTING reads, not adding one. _setCacheTtlMsForTest()
// below exists purely so a test can exercise the cache code path without
// one.
let _cacheTtlMs = 0;

let _db; // undefined = not yet attempted; null = attempted and unavailable
const _cache = new Map(); // `${scope}::${key}` -> { at, result }

function _dbPath() {
  return process.env.VOLT_DB_PATH || '/var/lib/quox/volt.db';
}

/**
 * Lazily opens a readonly connection to volt.db (mirrors
 * lib/feedDbSource.js's openReadonlyDb: readonly + `query_only` pragma —
 * this module never writes). Best-effort: any failure (file missing,
 * table not yet created because the collector hasn't finished booting)
 * degrades to "no db available" rather than throwing. Opened at most once
 * per process (or once per _resetForTest() call in tests).
 */
function _openDb() {
  if (_db !== undefined) return _db;
  try {
    const db = new Database(_dbPath(), { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    _db = db;
  } catch (err) {
    _db = null;
  }
  return _db;
}

function _resolve(scope, key) {
  const cacheKey = `${scope}::${key}`;
  if (_cacheTtlMs > 0) {
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.at <= _cacheTtlMs) return hit.result;
  }

  const db = _openDb();
  let result;
  try {
    result = getEffectiveFlag(db, scope, key);
  } catch (err) {
    // getEffectiveFlag is itself already non-throwing today, but this
    // resolver must never be the thing that turns a settings-store hiccup
    // into a scheduler/tool-executor crash — belt-and-suspenders.
    result = { value: 'false', on: false, source: 'env', invalidSetting: true };
  }

  if (_cacheTtlMs > 0) _cache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/**
 * Org-scoped resolution. Resolved fresh (subject to the opt-in TTL cache
 * above) on every call — never once at module load.
 *
 * @param {string|null} orgId
 * @param {string} key - a platformCapabilities.CAPABILITIES key
 * @returns {{ value: string, on: boolean, source: 'setting'|'env', invalidSetting?: boolean }}
 */
function getSetting(orgId, key) {
  return _resolve(orgId || null, key);
}

/**
 * Instance-wide (non-org) resolution — see the module-level HONESTY NOTE
 * above for the current write-side gap.
 *
 * @param {string} key - a platformCapabilities.CAPABILITIES key
 * @returns {{ value: string, on: boolean, source: 'setting'|'env', invalidSetting?: boolean }}
 */
function getInstanceSetting(key) {
  return _resolve(INSTANCE_SCOPE_ORG_ID, key);
}

/**
 * Test-only: drops the open db handle (closing it first, so a temp db file
 * backing it can be deleted cleanly) and clears every cached resolution.
 * Call this after pointing VOLT_DB_PATH at a fresh test db, or after
 * mutating stored settings a test needs re-read immediately.
 */
function _resetForTest() {
  if (_db && typeof _db.close === 'function') {
    try { _db.close(); } catch (err) { /* already closed, or never opened cleanly — fine either way */ }
  }
  _db = undefined;
  _cache.clear();
  _cacheTtlMs = 0;
}

/**
 * Test-only: turns on the (off-by-default) resolution cache with the given
 * TTL, without a new env var — see the module-level note above _cacheTtlMs.
 */
function _setCacheTtlMsForTest(ms) {
  _cacheTtlMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  _cache.clear();
}

module.exports = {
  INSTANCE_SCOPE_ORG_ID,
  getSetting,
  getInstanceSetting,
  _resolve,
  _resetForTest,
  _setCacheTtlMsForTest,
};
