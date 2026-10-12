/**
 * devServersStore.js — durable persistence for registered dev-mode hosts.
 *
 * DEVSUITE-DEVMODE Phase 3. quoxagent's `dev` builtin plugin family
 * (dev.register capability, quoxagent commit 865a17b) reports its
 * registerStatus() shape on the existing fleet heartbeat
 * (POST /api/v1/heartbeat, server.js) via a `dev_capabilities` field:
 *
 *   {
 *     host_id: string,
 *     hostname: string,
 *     profile_verified: boolean,
 *     profile_version: string,
 *     enabled_capabilities: string[],   // e.g. ["dev.register"]
 *     known_capabilities: string[],     // e.g. ["dev.register","dev.build","dev.clarify","dev.gripe","dev.docs"]
 *     checked_at: string  // RFC3339
 *   }
 *
 * This mirrors B1 (QUOXGPU #149)'s lib/gpuNodesStore.js pattern exactly: the
 * in-memory `agents` Map in server.js remains the fast liveness cache for hot
 * paths, but it now sits OVER this durable `dev_servers` table (schema owned
 * by migrations/aee/005-dev-servers-table.sql, applied to the existing aeeDb
 * via runMigrations()) — a collector restart must not drop the dev-server
 * fleet. Every heartbeat carrying `dev_capabilities` UPSERTs a row here;
 * plain QuoxAgent hosts without the dev plugin enabled are never persisted.
 *
 * Self-contained + dependency-injected (no server.js import) so it can be
 * unit-tested directly against a better-sqlite3 db, same as gpuNodesStore.js.
 */

'use strict';

// Only heartbeats that actually carry a dev_capabilities blob (quoxagent's
// dev.register capability enabled) are dev-server nodes — plain QuoxAgent
// heartbeats are never persisted to this table.
function isDevCapabilitiesHeartbeat(heartbeat) {
  const dc = heartbeat && heartbeat.dev_capabilities;
  return !!dc && typeof dc === 'object' && Array.isArray(dc.known_capabilities);
}

function safeParseJson(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function rowToRecord(row) {
  return {
    host_id: row.host_id,
    org_id: row.org_id,
    hostname: row.hostname || null,
    profile_verified: !!row.profile_verified,
    profile_version: row.profile_version || null,
    enabled_capabilities: safeParseJson(row.enabled_capabilities, []),
    known_capabilities: safeParseJson(row.known_capabilities, []),
    checked_at: row.checked_at || null,
    first_registered_at: row.first_registered_at,
    last_seen_at: row.last_seen_at,
    // quox#453 phase 15 — resident identity provisioning outcome. null on
    // both fields means never attempted (pre-phase-15 host, or a host whose
    // enable predates this column). See migrations/aee/018-dev-server-
    // resident.sql and setResidentState() below.
    resident_state: row.resident_state || null,
    resident_detail: row.resident_detail || null,
    resident_updated_at: row.resident_updated_at || null,
    // DEVSUITE-DEVMODE phase 15 follow-on — headless supervisor switch. See
    // migrations/aee/019-dev-supervisor.sql and getSupervisorSettings() below
    // for the full contract; surfaced here too since rowToRecord is a
    // whitelist and any caller reading a raw list/get record should see it.
    supervisor_enabled: !!row.supervisor_enabled,
    supervisor_slot: row.supervisor_slot || null,
    supervisor_config: safeParseJson(row.supervisor_config, null),
    supervisor_updated_at: row.supervisor_updated_at || null,
    supervisor_updated_by: row.supervisor_updated_by || null,
  };
}

// UPSERT a dev_servers row from an inbound heartbeat. No-op for heartbeats
// without a dev_capabilities blob (returns null). first_registered_at is set
// once on INSERT and never touched again; every other field is refreshed on
// every beat — same UPSERT discipline as recordGpuHeartbeat.
//
// Returns { record, isNewRegistration } rather than a bare record: the
// UPSERT's VALUES clause sets first_registered_at AND last_seen_at to the
// same @now on a fresh INSERT, while the ON CONFLICT branch only ever
// touches last_seen_at (first_registered_at is never in the UPDATE SET
// list, so it stays frozen at whatever it was on the original insert). That
// means immediately after this statement runs, first_registered_at ===
// last_seen_at if and only if this call was the row's first-ever insert —
// any later heartbeat moves last_seen_at forward while first_registered_at
// stays put, so the two values diverge. Callers use isNewRegistration to
// trigger one-time-only side effects (e.g. skill pack auto-install) without
// re-running them on every ~60s heartbeat.
function recordDevServerHeartbeat(db, heartbeat, { now = () => Date.now() } = {}) {
  if (!db || !heartbeat || !heartbeat.host_id || !isDevCapabilitiesHeartbeat(heartbeat)) return null;

  const dc = heartbeat.dev_capabilities;
  const t = now();
  const params = {
    host_id: heartbeat.host_id,
    org_id: heartbeat.org_id || 'default',
    now: t,
    hostname: dc.hostname || null,
    profile_verified: dc.profile_verified ? 1 : 0,
    profile_version: dc.profile_version || null,
    enabled_capabilities: JSON.stringify(Array.isArray(dc.enabled_capabilities) ? dc.enabled_capabilities : []),
    known_capabilities: JSON.stringify(Array.isArray(dc.known_capabilities) ? dc.known_capabilities : []),
    checked_at: dc.checked_at || null,
  };

  db.prepare(`
    INSERT INTO dev_servers (host_id, org_id, first_registered_at, last_seen_at, hostname, profile_verified, profile_version, enabled_capabilities, known_capabilities, checked_at)
    VALUES (@host_id, @org_id, @now, @now, @hostname, @profile_verified, @profile_version, @enabled_capabilities, @known_capabilities, @checked_at)
    ON CONFLICT(host_id) DO UPDATE SET
      org_id = CASE
        WHEN dev_servers.org_id IS NOT NULL AND dev_servers.org_id != 'default' AND @org_id = 'default'
          THEN dev_servers.org_id
        ELSE @org_id
      END,
      last_seen_at = @now,
      hostname = @hostname,
      profile_verified = @profile_verified,
      profile_version = @profile_version,
      enabled_capabilities = @enabled_capabilities,
      known_capabilities = @known_capabilities,
      checked_at = @checked_at
  `).run(params);

  const record = rowToRecord(db.prepare('SELECT * FROM dev_servers WHERE host_id = ?').get(heartbeat.host_id));
  return { record, isNewRegistration: record.first_registered_at === record.last_seen_at };
}

function listDevServers(db, { orgId } = {}) {
  if (!db) return [];
  const rows = orgId
    ? db.prepare('SELECT * FROM dev_servers WHERE org_id = ? ORDER BY host_id').all(orgId)
    : db.prepare('SELECT * FROM dev_servers ORDER BY host_id').all();
  return rows.map(rowToRecord);
}

// DEVSUITE-SKILLS Phase 3 — single-host lookup, used by the skill-pack sync
// endpoint (devServerSkillPacksStore.js's createSkillPackSyncHandler) to
// resolve a host's enabled_capabilities/org_id before re-running
// installSkillPack() against it.
function getDevServer(db, hostId) {
  if (!db || !hostId) return null;
  const row = db.prepare('SELECT * FROM dev_servers WHERE host_id = ?').get(hostId);
  return row ? rowToRecord(row) : null;
}

// GET /api/v1/dev-servers — reads the durable table directly (not the
// in-memory agents Map), so registered dev hosts are visible even before the
// next heartbeat lands post-restart.
//
// ORG-SCOPE, DEVSUITE phase 5 (fixed 2026-08-18). This handler used to have no
// auth gate at all, and took its org from `req.query.org_id` — a value the
// caller supplies and nobody verifies. Omitting the parameter returned EVERY
// registered host on the install. On this box that was nine hosts across
// several orgs, complete with hostnames, capability sets and agent versions,
// and the walkthrough documented it as a known gap rather than a fix.
//
// "Fleet telemetry with no secrets" was the old justification and it does not
// survive contact with a second tenant: an inventory of another customer's dev
// machines is their data whether or not any single field looks sensitive.
//
// Three changes, matching the precedent set by GET /aee/query:
//   - a JWT caller is scoped to their OWN org, and can never widen it by
//     passing a query string
//   - a service-key caller (CLI, agents, internal jobs) may still name an org,
//     because it has no session to derive one from
//   - no resolvable org FAILS CLOSED with 403, rather than falling through to
//     the whole table. That last one is the actual bug: the old default for
//     "I don't know who you are" was "here is everything".
//
// listDevServers(db) with no orgId still returns everything, deliberately: the
// startup collector-URL check counts dev hosts install-wide and is not a
// caller-facing path. Same split as query/queryOrgScoped in server.js.
function createDevServersListHandler(deps = {}) {
  const { getDb } = deps;
  return function devServersListHandler(req, res) {
    try {
      const orgId = req.user?.org_id
        || (req.service ? (req.query && req.query.org_id) : null)
        || null;

      if (!orgId) {
        return res.status(403).json({
          error: 'organisation_context_required',
          message: 'Dev servers are org-scoped. Sign in, or pass org_id with a service key.',
        });
      }

      const db = getDb();
      const servers = listDevServers(db, { orgId });
      return res.json({ count: servers.length, servers, org_id: orgId });
    } catch (err) {
      return res.status(500).json({ error: 'dev_servers_list_failed', detail: err.message });
    }
  };
}

/**
 * ORG-SCOPE (2026-08-15): stamp the org binding on a host's registry row at
 * dev-enable time (the signed profile is the org truth; heartbeats carry no
 * org today). Creates a stub row when the host has never heartbeated, so an
 * enable-before-first-beat still binds. The heartbeat UPSERT preserves any
 * non-default stamp (see the CASE in recordDevServerHeartbeat).
 */
function setDevServerOrgBinding(db, hostId, orgId, { now = () => Date.now() } = {}) {
  if (!db || !hostId || !orgId) throw new Error('setDevServerOrgBinding: db, hostId and orgId are required');
  const t = now();
  db.prepare(`
    INSERT INTO dev_servers (host_id, org_id, first_registered_at, last_seen_at, enabled_capabilities, known_capabilities)
    VALUES (?, ?, ?, ?, '[]', '[]')
    ON CONFLICT(host_id) DO UPDATE SET org_id = excluded.org_id
  `).run(hostId, orgId, t, t);
}

// quox#453 phase 15 — record the outcome of provisionResidentIdentity()
// (lib/devResidentProvisioner.js) against the durable registry row. Called
// from the dev-profiles/enable handler right after result.resident is
// attached; best-effort by design (the caller wraps this in a try/catch
// that only console.warns, matching setDevServerOrgBinding's discipline —
// a resident-state write failure must never fail the enable response).
//
// No-op (not an insert) when the host has never registered a row: this
// function records state on an EXISTING dev server, it does not create one.
// setDevServerOrgBinding creates stub rows for that purpose; this doesn't,
// because a resident outcome with no dev_servers row to attach it to has
// nothing to describe.
function setResidentState(db, hostId, state, detail, { now = () => new Date().toISOString() } = {}) {
  if (!db || !hostId) throw new Error('setResidentState: db and hostId are required');
  const result = db.prepare(`
    UPDATE dev_servers
    SET resident_state = ?, resident_detail = ?, resident_updated_at = ?
    WHERE host_id = ?
  `).run(state ?? null, detail ?? null, now(), hostId);
  return result.changes > 0;
}

// DEVSUITE-DEVMODE headless supervisor (quox#453 phase 15 follow-on). A
// resident's runner loop (`quox dev supervisor`, a separate CLI build) polls
// GET .../supervisor every cycle and stops itself the instant enabled reads
// false — these two functions are the entire server-side contract that loop
// depends on, so both defaults and validation live here, not scattered
// across the route.
const SUPERVISOR_DEFAULTS = Object.freeze({
  poll_seconds: 15,
  turn_timeout_seconds: 150,
  max_turns_per_hour: 20,
});

const SUPERVISOR_RANGES = Object.freeze({
  poll_seconds: [5, 300],
  turn_timeout_seconds: [30, 600],
  max_turns_per_hour: [1, 120],
});

const SUPERVISOR_SLOT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function defaultSupervisorSettings(hostId) {
  return {
    host_id: hostId,
    enabled: false,
    slot: null,
    poll_seconds: SUPERVISOR_DEFAULTS.poll_seconds,
    turn_timeout_seconds: SUPERVISOR_DEFAULTS.turn_timeout_seconds,
    max_turns_per_hour: SUPERVISOR_DEFAULTS.max_turns_per_hour,
    updated_at: null,
    updated_by: null,
  };
}

// GET-side read. Always returns the full shape (defaults filled in) even for
// a host with no dev_servers row at all — the runner's poll contract must
// stay stable across "never enabled" and "explicitly disabled" alike; only
// `enabled` distinguishes them, and both read false.
function getSupervisorSettings(db, hostId) {
  if (!hostId) throw new Error('getSupervisorSettings: hostId is required');
  const fallback = defaultSupervisorSettings(hostId);
  if (!db) return fallback;
  const row = db.prepare(
    'SELECT supervisor_enabled, supervisor_slot, supervisor_config, supervisor_updated_at, supervisor_updated_by FROM dev_servers WHERE host_id = ?'
  ).get(hostId);
  if (!row) return fallback;

  const cfg = safeParseJson(row.supervisor_config, {}) || {};
  return {
    host_id: hostId,
    enabled: !!row.supervisor_enabled,
    slot: row.supervisor_slot || null,
    poll_seconds: Number.isInteger(cfg.poll_seconds) ? cfg.poll_seconds : SUPERVISOR_DEFAULTS.poll_seconds,
    turn_timeout_seconds: Number.isInteger(cfg.turn_timeout_seconds) ? cfg.turn_timeout_seconds : SUPERVISOR_DEFAULTS.turn_timeout_seconds,
    max_turns_per_hour: Number.isInteger(cfg.max_turns_per_hour) ? cfg.max_turns_per_hour : SUPERVISOR_DEFAULTS.max_turns_per_hour,
    updated_at: row.supervisor_updated_at || null,
    updated_by: row.supervisor_updated_by || null,
  };
}

// Validates one poll_seconds/turn_timeout_seconds/max_turns_per_hour field
// against its documented range. Absent/undefined/null falls back to the
// documented default — REJECTS out-of-range input rather than clamping it
// silently, so a caller that fat-fingers 9999 gets a 400 naming the field,
// not a quietly-capped value it never asked for.
function validateSupervisorConfigField(field, value) {
  if (value === undefined || value === null) return { ok: true, value: SUPERVISOR_DEFAULTS[field] };
  const n = Number(value);
  const [min, max] = SUPERVISOR_RANGES[field];
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, field, error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

function validateSupervisorSlot(slot) {
  if (slot === undefined || slot === null || slot === '') return { ok: true, value: null };
  if (typeof slot !== 'string' || !SUPERVISOR_SLOT_PATTERN.test(slot)) {
    return { ok: false, field: 'slot', error: 'slot must match /^[A-Za-z0-9._-]{1,64}$/' };
  }
  return { ok: true, value: slot };
}

// Write side — the ONLY writer of these columns. Route-level auth
// (requireHumanAdmin, server.js) is what actually enforces the "a resident
// can never switch itself on" invariant; this function enforces field
// validity, not who is allowed to call it, and does not know about auth at
// all. Rejects out of range / malformed input with { ok: false, field,
// error } naming the offending field, rather than clamping or guessing.
//
// Creates a stub dev_servers row when the host has never registered one
// (same posture as setDevServerOrgBinding above): a human should be able to
// pre-authorise a host's supervisor before its first heartbeat lands.
function setSupervisorSettings(db, hostId, { enabled, slot, config, updatedBy } = {}, { now = () => new Date().toISOString() } = {}) {
  if (!db || !hostId) throw new Error('setSupervisorSettings: db and hostId are required');
  if (typeof enabled !== 'boolean') {
    return { ok: false, field: 'enabled', error: 'enabled must be a boolean' };
  }

  const slotResult = validateSupervisorSlot(slot);
  if (!slotResult.ok) return slotResult;

  const cfg = config || {};
  const resolved = {};
  for (const field of ['poll_seconds', 'turn_timeout_seconds', 'max_turns_per_hour']) {
    const fieldResult = validateSupervisorConfigField(field, cfg[field]);
    if (!fieldResult.ok) return fieldResult;
    resolved[field] = fieldResult.value;
  }

  const t = now();
  db.prepare(`
    INSERT INTO dev_servers (host_id, org_id, first_registered_at, last_seen_at, enabled_capabilities, known_capabilities, supervisor_enabled, supervisor_slot, supervisor_config, supervisor_updated_at, supervisor_updated_by)
    VALUES (?, 'default', ?, ?, '[]', '[]', ?, ?, ?, ?, ?)
    ON CONFLICT(host_id) DO UPDATE SET
      supervisor_enabled = excluded.supervisor_enabled,
      supervisor_slot = excluded.supervisor_slot,
      supervisor_config = excluded.supervisor_config,
      supervisor_updated_at = excluded.supervisor_updated_at,
      supervisor_updated_by = excluded.supervisor_updated_by
  `).run(
    hostId,
    t, t,
    enabled ? 1 : 0,
    slotResult.value,
    JSON.stringify(resolved),
    t,
    updatedBy || null
  );

  return { ok: true, settings: getSupervisorSettings(db, hostId) };
}

module.exports = {
  isDevCapabilitiesHeartbeat,
  recordDevServerHeartbeat,
  listDevServers,
  getDevServer,
  setDevServerOrgBinding,
  setResidentState,
  createDevServersListHandler,
  getSupervisorSettings,
  setSupervisorSettings,
};
