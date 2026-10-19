/**
 * Phase 25: org-scoped platform settings store — the write path behind
 * lib/platformCapabilities.js's read-only registry (owner mandate,
 * 2026-08-06: a read-only capability list is explicitly NOT sufficient).
 *
 * Mirrors lib/policyStore.js + lib/policyHistory.js: a single
 * init*(db)-style schema function, plain CRUD against better-sqlite3, and
 * an append-only history table for the audit trail. Extends the same voltDb
 * this collector process already owns rather than a new store or a new
 * cross-service dependency.
 *
 * Scope: every `classification: 'user'` entry in platformCapabilities.CAPABILITIES
 * whose type is settable (boolean/string/number/enum — VAULT-INTEG P14
 * slice 1 extended this past boolean-only) is settable (SETTABLE_KEYS).
 * Every write is validated against that set and against the flag's
 * declared type + constraints (platformCapabilities.validateSettingValue())
 * before it touches the table — a PATCH for an unknown key or a value of
 * the wrong shape throws before anything is persisted or audited.
 *
 * getEffectiveFlag()/listEffectiveFlags() are the DB-composing wrapper
 * around platformCapabilities.resolveEffectiveCapability() — THE shared
 * precedence resolver. This module never re-implements precedence itself,
 * it only fetches the raw stored value and hands it to that one function.
 */

const { CAPABILITIES, resolveEffectiveCapability, isSettableEntry, validateSettingValue } = require('./platformCapabilities.js');

// VAULT-INTEG P14 slice 1: SETTABLE_KEYS now spans every settable type
// (boolean/string/number/enum), not boolean-only — isSettableEntry() is
// the one shared rule (classification 'user' + a settable type, and for
// 'enum' a declared allowedValues set).
const SETTABLE_KEYS = new Set(
  CAPABILITIES.filter((c) => isSettableEntry(c)).map((c) => c.key)
);

const CAPABILITY_BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));

/**
 * VAULT-INTEG P17: the reserved scope for instance-wide (non-org) settings —
 * MUST stay byte-identical to lib/configResolver.js's own INSTANCE_SCOPE_ORG_ID
 * constant. Duplicated rather than imported because configResolver.js already
 * requires this module (getEffectiveFlag) — importing it back here would be
 * circular. configResolver.js's own comment block points back at this store
 * as the (still-missing, until this phase) write side; this is that write
 * side, so the two constants now need to move together by hand if the
 * sentinel string ever changes. Not a real org id — org_platform_settings'
 * primary key is (org_id, key), and this string is not, and will never be,
 * assigned to a real org.
 */
const INSTANCE_SCOPE_ORG_ID = '__instance__';

function initPlatformSettingsStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_platform_settings (
      org_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT,
      PRIMARY KEY (org_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_org_platform_settings_org ON org_platform_settings(org_id);

    CREATE TABLE IF NOT EXISTS org_platform_settings_history (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      actor_id TEXT NOT NULL DEFAULT 'unknown',
      actor_label TEXT,
      actor_source TEXT NOT NULL DEFAULT 'api',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_org_platform_settings_history_org_key
      ON org_platform_settings_history(org_id, key, created_at DESC);
  `);
}

function generateHistoryId() {
  return `OPSH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Raw stored value for one org+key, or undefined if never set. Never
 * fabricates a default — "unset" is a real, distinct state from "set to
 * env's default value".
 */
function getOrgSettingRaw(db, orgId, key) {
  if (!db || !orgId) return undefined;
  const row = db.prepare('SELECT value FROM org_platform_settings WHERE org_id = ? AND key = ?').get(orgId, key);
  return row ? row.value : undefined;
}

/** Every stored setting for an org, as a flat { key: value } map. */
function listOrgSettings(db, orgId) {
  if (!db || !orgId) return {};
  const rows = db.prepare('SELECT key, value FROM org_platform_settings WHERE org_id = ?').all(orgId);
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function appendSettingsHistory(db, entry) {
  const row = {
    id: generateHistoryId(),
    org_id: entry.org_id,
    key: entry.key,
    old_value: entry.old_value ?? null,
    new_value: entry.new_value,
    actor_id: entry.actor_id || 'unknown',
    actor_label: entry.actor_label ?? null,
    actor_source: entry.actor_source || 'api',
    created_at: new Date().toISOString(),
  };
  db.prepare(`
    INSERT INTO org_platform_settings_history (id, org_id, key, old_value, new_value, actor_id, actor_label, actor_source, created_at)
    VALUES (@id, @org_id, @key, @old_value, @new_value, @actor_id, @actor_label, @actor_source, @created_at)
  `).run(row);
  return row;
}

function listSettingsHistory(db, { org_id, key, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (org_id) { where.push('org_id = ?'); params.push(org_id); }
  if (key) { where.push('key = ?'); params.push(key); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM org_platform_settings_history ${whereSql}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/**
 * Validate + persist one org's override for one flag, and append the
 * before/after audit row in the same call. Throws (writes nothing) for an
 * unknown key or a value that doesn't match the flag's declared type — a
 * bad PATCH body can never reach the table or the audit log.
 *
 * @param {object} db - better-sqlite3 handle (this collector's voltDb)
 * @param {string} orgId
 * @param {string} key - must be in SETTABLE_KEYS
 * @param {string} rawValue - shape depends on the entry's declared type:
 *   'true'|'false' for boolean; a string within maxLength for string; a
 *   number-parseable string within min/max for number; one of
 *   allowedValues for enum.
 * @param {{ actorId?: string, actorLabel?: string, actorSource?: string }} [actor]
 * @returns {{ key: string, org_id: string, old_value: string|null, new_value: string }}
 */
function setOrgSetting(db, orgId, key, rawValue, actor = {}) {
  if (!db) throw new Error('platform settings storage not available');
  if (!orgId) throw new Error('org_id is required');
  if (!SETTABLE_KEYS.has(key)) {
    throw new Error(`not a settable flag: ${key}`);
  }
  const entry = CAPABILITY_BY_KEY.get(key);
  // VAULT-INTEG P14 slice 1: validation lives in ONE place —
  // platformCapabilities.validateSettingValue() — keyed off the entry's
  // declared type + constraints. This is the only enforcement point; the
  // resolver (resolveEffectiveCapability) calls the exact same function.
  const { valid, reason } = validateSettingValue(entry, rawValue);
  if (!valid) {
    throw new Error(reason || `invalid value for ${key}`);
  }
  // quox#1061: an ORG-supplied integration URL the collector fetches
  // server-side is checked against the monitoring egress policy (no
  // loopback/metadata/internal service targets). The instance scope is
  // operator controlled and keeps the plain URL check above.
  if (entry.orgEgressPolicy === 'monitoring-integration' && orgId !== INSTANCE_SCOPE_ORG_ID) {
    const refusal = require('./monitoringEgressPolicy.js').orgMonitoringUrlRefusal(rawValue);
    if (refusal) throw new Error(`invalid value for ${key}: ${refusal}`);
  }

  const oldValue = getOrgSettingRaw(db, orgId, key) ?? null;

  db.prepare(`
    INSERT INTO org_platform_settings (org_id, key, value, updated_at, updated_by)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(org_id, key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(orgId, key, rawValue, actor.actorId || null);

  appendSettingsHistory(db, {
    org_id: orgId,
    key,
    old_value: oldValue,
    new_value: rawValue,
    actor_id: actor.actorId || 'unknown',
    actor_label: actor.actorLabel || actor.actorId || null,
    actor_source: actor.actorSource || 'api',
  });

  return { key, org_id: orgId, old_value: oldValue, new_value: rawValue };
}

/**
 * VAULT-INTEG P17: the write path behind configResolver.getInstanceSetting()
 * — a thin wrapper over setOrgSetting() pinned to the reserved instance
 * sentinel scope. Same validation (validateSettingValue via setOrgSetting),
 * same audit history table, same SETTABLE_KEYS enforcement as the org-scoped
 * write path; the only difference is which "org" the row lands under. Never
 * accepts an orgId argument — the caller cannot aim this at a real org, and
 * a real org's row can never be mistaken for the instance scope (see the
 * sentinel guard on the org-scoped HTTP route in server.js, which rejects
 * INSTANCE_SCOPE_ORG_ID before it ever reaches setOrgSetting()).
 *
 * @param {object} db - better-sqlite3 handle (this collector's voltDb)
 * @param {string} key - must be in SETTABLE_KEYS
 * @param {string} rawValue - same shape rules as setOrgSetting()
 * @param {{ actorId?: string, actorLabel?: string, actorSource?: string }} [actor]
 * @returns {{ key: string, org_id: string, old_value: string|null, new_value: string }}
 */
function setInstanceSetting(db, key, rawValue, actor = {}) {
  return setOrgSetting(db, INSTANCE_SCOPE_ORG_ID, key, rawValue, actor);
}

/**
 * The DB-composing wrapper around resolveEffectiveCapability() — fetches
 * the raw stored value (best-effort, never throws even on a missing db or
 * unknown key) and hands it to the one shared precedence function.
 *
 * @param {object|null} db
 * @param {string|null} orgId
 * @param {string} key
 * @param {{ env?: object }} [opts]
 */
function getEffectiveFlag(db, orgId, key, opts = {}) {
  const { env = process.env } = opts;
  const entry = CAPABILITY_BY_KEY.get(key);
  if (!entry) {
    return { value: 'false', on: false, source: 'env', invalidSetting: true };
  }

  let settingValue;
  try {
    settingValue = getOrgSettingRaw(db, orgId, key);
  } catch (err) {
    settingValue = undefined;
  }

  return resolveEffectiveCapability(entry, { env, settingValue });
}

/** Every settable flag's full capability metadata + effective value/source. */
function listEffectiveFlags(db, orgId, opts = {}) {
  return CAPABILITIES
    .filter((entry) => SETTABLE_KEYS.has(entry.key))
    .map((entry) => {
      const effective = getEffectiveFlag(db, orgId, entry.key, opts);
      return {
        key: entry.key,
        name: entry.name,
        description: entry.description,
        service: entry.service,
        group: entry.group || null,
        default: entry.default,
        requiresRestart: !!entry.requiresRestart,
        restartNote: entry.restartNote || null,
        // VAULT-INTEG P14 slice 1: typed-value metadata so the Settings UI
        // can render the right control (toggle/text/number/select) and
        // validate client-side before the round trip.
        type: entry.type,
        ...(Array.isArray(entry.allowedValues) ? { allowedValues: entry.allowedValues } : {}),
        ...(typeof entry.min === 'number' ? { min: entry.min } : {}),
        ...(typeof entry.max === 'number' ? { max: entry.max } : {}),
        ...(typeof entry.maxLength === 'number' ? { maxLength: entry.maxLength } : {}),
        ...(entry.note ? { note: entry.note } : {}),
        ...effective,
      };
    });
}

module.exports = {
  SETTABLE_KEYS,
  INSTANCE_SCOPE_ORG_ID,
  initPlatformSettingsStore,
  getOrgSettingRaw,
  listOrgSettings,
  setOrgSetting,
  setInstanceSetting,
  appendSettingsHistory,
  listSettingsHistory,
  getEffectiveFlag,
  listEffectiveFlags,
};
