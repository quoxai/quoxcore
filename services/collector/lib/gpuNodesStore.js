/**
 * gpuNodesStore.js — durable persistence for GPU fleet nodes.
 *
 * B1 (roadmap #149 QUOXGPU, docs/STREAM_QUOXGPU_SETUP_WIZARD.md build-list
 * item 1). Fixes a zero-tolerance persistence-rule violation: GPU heartbeats
 * previously lived ONLY in the collector's in-memory `agents = new Map()`
 * (server.js:1698), so a collector restart silently emptied the GPU fleet.
 * Server-side storage must always be the source of truth — see CLAUDE.md
 * "Data Persistence (ZERO TOLERANCE)".
 *
 * This module adds a durable `gpu_nodes` table on the collector's existing
 * aeeDb (better-sqlite3, shared with lib/qlusterEnroll.js). It mirrors
 * qlusterEnroll.js's self-contained `ensureXSchema(db)` + dependency-injected
 * handler-factory pattern so it can be unit-tested against an in-memory
 * better-sqlite3 db without booting server.js.
 *
 * The in-memory `agents` Map remains the fast liveness cache for hot paths
 * (GET /api/v1/agents, WS broadcast) — it now sits OVER this durable store:
 *   - every heartbeat that carries `gpu_devices` UPSERTs a row here
 *     (recordGpuHeartbeat) — non-GPU QuoxAgent hosts are never persisted here
 *   - on boot, reseedGpuNodesIntoMap() replays known rows back into the Map
 *     (age-derived connection status) so a fresh restart/browser still shows
 *     the known GPU fleet instead of an empty list
 *   - GET /api/v1/gpu/nodes (createGpuNodesListHandler) reads the durable
 *     table directly, so the fleet is visible even before the first
 *     post-boot heartbeat lands
 */

'use strict';

function ensureGpuNodesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_nodes (
      host_id           TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL DEFAULT 'default',
      first_enrolled_at INTEGER NOT NULL,
      last_seen_at      INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'online',
      gpu_summary       TEXT NOT NULL DEFAULT '{}',
      backends          TEXT NOT NULL DEFAULT '[]',
      models_json       TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_gpu_nodes_org ON gpu_nodes(org_id);
  `);
  // B2 (QUOXGPU #149) — real enrollment + WARD receipt columns. Guarded
  // migration (mirrors lib/qlusterEnroll.js's ensureColumn) so existing rows
  // (from heartbeat-only UPSERTs pre-B2) gain these columns without a
  // destructive rebuild. `enrolled` defaults to 0 — a node that has only
  // ever heartbeat (never exchanged a real enrollment token) stays 0.
  ensureColumn(db, 'gpu_nodes', 'enrolled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'gpu_nodes', 'token_hash', 'TEXT');
  ensureColumn(db, 'gpu_nodes', 'ward_digest', 'TEXT');
  // B3 (QUOXGPU #149) — fleet-level live telemetry (GPU Setup wizard's real-
  // path HUD). Derived per-heartbeat from gpu_devices (see
  // deriveFleetTelemetry) rather than stored inside gpu_summary, so the
  // (a) existing gpu_summary shape stays untouched for older consumers and
  // (b) NULL cleanly means "unknown" (SQLite REAL columns default to NULL,
  // never 0) instead of requiring JSON-null handling.
  ensureColumn(db, 'gpu_nodes', 'util_pct', 'REAL');
  ensureColumn(db, 'gpu_nodes', 'temp_c', 'REAL');
}

// Guarded ALTER TABLE ADD COLUMN — SQLite has no "ADD COLUMN IF NOT EXISTS".
// Mirrors lib/qlusterEnroll.js's ensureColumn helper exactly.
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Only agents that actually carry gpu_devices are GPU nodes — plain
// QuoxAgent heartbeats (no GPU) are never persisted to this table.
function isGpuHeartbeat(heartbeat) {
  return Array.isArray(heartbeat && heartbeat.gpu_devices) && heartbeat.gpu_devices.length > 0;
}

function summarizeGpuDevices(devices) {
  const list = Array.isArray(devices) ? devices : [];
  return {
    device_count: list.length,
    names: list.map((d) => (d && (d.name || d.model)) || 'unknown'),
    vram_total_mb: list.reduce((sum, d) => sum + (Number(d && d.vram_total_mb) || 0), 0),
  };
}

// B3 (QUOXGPU #149) — fleet-level util/temp from a heartbeat's gpu_devices[].
// The daemon uses -1 as its "unknown/unsupported" sentinel for both fields
// (never a real reading) — those entries are excluded, not treated as 0.
// Takes the max across devices (worst-case is the most actionable single
// number for a fleet-summary HUD). Returns null for either field when no
// device reports a known value, so callers never fabricate a 0.
function deriveFleetTelemetry(devices) {
  const list = Array.isArray(devices) ? devices : [];
  let maxUtil = null;
  let maxTemp = null;
  for (const d of list) {
    const util = Number(d && d.utilisation_pct);
    if (Number.isFinite(util) && util !== -1 && (maxUtil === null || util > maxUtil)) maxUtil = util;
    const temp = Number(d && d.temperature_c);
    if (Number.isFinite(temp) && temp !== -1 && (maxTemp === null || temp > maxTemp)) maxTemp = temp;
  }
  return { util_pct: maxUtil, temp_c: maxTemp };
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
    first_enrolled_at: row.first_enrolled_at,
    last_seen_at: row.last_seen_at,
    status: row.status,
    gpu_summary: safeParseJson(row.gpu_summary, {}),
    backends: safeParseJson(row.backends, []),
    loaded_models: safeParseJson(row.models_json, []),
    // B2 (QUOXGPU #149) — real enrollment state + WARD receipt digest. Never
    // expose token_hash (mirrors lib/qlusterEnroll.js's controllers-list
    // convention of never returning the raw hash).
    enrolled: !!row.enrolled,
    ward_digest: row.ward_digest || null,
    // B3 (QUOXGPU #149) — null (not 0) when unknown; see deriveFleetTelemetry.
    util_pct: row.util_pct === null || row.util_pct === undefined ? null : row.util_pct,
    temp_c: row.temp_c === null || row.temp_c === undefined ? null : row.temp_c,
  };
}

// B2 (QUOXGPU #149) — mark a gpu_nodes row enrolled via a real, exchanged
// enrollment token (lib/gpuEnroll.js exchangeGpuEnrollToken), storing the
// WARD-witness digest produced at exchange time. UPSERT that ONLY touches
// enrollment-owned columns (enrolled/token_hash/ward_digest/org_id) — the
// heartbeat-owned columns (status/gpu_summary/backends/models_json/
// last_seen_at) are left alone here so a later heartbeat still governs
// liveness, and first_enrolled_at is set once on INSERT and never touched
// again (mirrors recordGpuHeartbeat's UPSERT discipline).
function markGpuNodeEnrolled(db, { hostId, orgId, tokenHash, wardDigest, now = () => Date.now() } = {}) {
  if (!db || !hostId) return null;

  const params = {
    host_id: hostId,
    org_id: orgId || 'default',
    now: now(),
    token_hash: tokenHash || null,
    ward_digest: wardDigest || null,
  };

  db.prepare(`
    INSERT INTO gpu_nodes (host_id, org_id, first_enrolled_at, last_seen_at, status, gpu_summary, backends, models_json, enrolled, token_hash, ward_digest)
    VALUES (@host_id, @org_id, @now, @now, 'enrolled', '{}', '[]', '[]', 1, @token_hash, @ward_digest)
    ON CONFLICT(host_id) DO UPDATE SET
      org_id = @org_id,
      enrolled = 1,
      token_hash = @token_hash,
      ward_digest = @ward_digest
  `).run(params);

  return rowToRecord(db.prepare('SELECT * FROM gpu_nodes WHERE host_id = ?').get(hostId));
}

// UPSERT a gpu_nodes row from an inbound heartbeat. No-op for non-GPU
// heartbeats (returns null). first_enrolled_at is set once on INSERT and
// never touched again; every field below is refreshed on every beat.
function recordGpuHeartbeat(db, heartbeat, { now = () => Date.now() } = {}) {
  if (!db || !heartbeat || !heartbeat.host_id || !isGpuHeartbeat(heartbeat)) return null;

  const t = now();
  const telemetry = deriveFleetTelemetry(heartbeat.gpu_devices);
  const params = {
    host_id: heartbeat.host_id,
    org_id: heartbeat.org_id || 'default',
    now: t,
    status: (heartbeat.status && heartbeat.status.connection) || 'online',
    gpu_summary: JSON.stringify(summarizeGpuDevices(heartbeat.gpu_devices)),
    backends: JSON.stringify(Array.isArray(heartbeat.inference_backends) ? heartbeat.inference_backends : []),
    models_json: JSON.stringify(Array.isArray(heartbeat.loaded_models) ? heartbeat.loaded_models : []),
    util_pct: telemetry.util_pct,
    temp_c: telemetry.temp_c,
  };

  db.prepare(`
    INSERT INTO gpu_nodes (host_id, org_id, first_enrolled_at, last_seen_at, status, gpu_summary, backends, models_json, util_pct, temp_c)
    VALUES (@host_id, @org_id, @now, @now, @status, @gpu_summary, @backends, @models_json, @util_pct, @temp_c)
    ON CONFLICT(host_id) DO UPDATE SET
      org_id = @org_id,
      last_seen_at = @now,
      status = @status,
      gpu_summary = @gpu_summary,
      backends = @backends,
      models_json = @models_json,
      util_pct = @util_pct,
      temp_c = @temp_c
  `).run(params);

  return rowToRecord(db.prepare('SELECT * FROM gpu_nodes WHERE host_id = ?').get(heartbeat.host_id));
}

function listGpuNodes(db, { orgId } = {}) {
  if (!db) return [];
  const rows = orgId
    ? db.prepare('SELECT * FROM gpu_nodes WHERE org_id = ? ORDER BY host_id').all(orgId)
    : db.prepare('SELECT * FROM gpu_nodes ORDER BY host_id').all();
  return rows.map(rowToRecord);
}

// Boot-reseed: replay durable gpu_nodes rows into the in-memory liveness Map
// (the same shape/keys `agents.set()` uses in the heartbeat handler) so a
// freshly-booted collector — before any new heartbeat has landed — still
// serves the known GPU fleet from GET /api/v1/agents instead of an empty
// list. Reseeded entries carry `reseeded: true` and a connection status
// derived from row age; a real heartbeat overwrites them with live data.
// Synthesizes a minimal `gpu_devices`/`inference_backends` shape from the
// persisted summary so existing fleet-list filters (which key off
// `gpu_devices.length`/`inference_backends.length`) still recognize the node.
function reseedGpuNodesIntoMap(db, agentsMap, { now = () => Date.now(), timeoutMs = 90000, deadMs = 300000 } = {}) {
  if (!db || !agentsMap) return 0;
  const t = now();
  const rows = listGpuNodes(db);
  let reseeded = 0;
  for (const row of rows) {
    if (agentsMap.has(row.host_id)) continue; // a real heartbeat already landed post-boot
    const age = t - row.last_seen_at;
    let connection = 'connected';
    if (age > deadMs) connection = 'dead';
    else if (age > timeoutMs) connection = 'stale';

    const names = Array.isArray(row.gpu_summary && row.gpu_summary.names) ? row.gpu_summary.names : [];
    agentsMap.set(row.host_id, {
      host_id: row.host_id,
      org_id: row.org_id,
      gpu_devices: names.map((name) => ({ name, reseeded: true })),
      inference_backends: row.backends,
      loaded_models: row.loaded_models,
      received_at: row.last_seen_at,
      remote_addr: null,
      reseeded: true,
      status: { connection, reseeded: true },
    });
    reseeded++;
  }
  return reseeded;
}

function createGpuNodesListHandler(deps = {}) {
  const { getDb } = deps;
  return function gpuNodesListHandler(req, res) {
    try {
      const db = getDb();
      // AEE-ORG-1 (tenant isolation): gpu_nodes carries a NOT NULL org_id, so a
      // node belongs to a tenant. A JWT/cookie user is LOCKED to their own org
      // and CANNOT widen it with ?org_id. A trusted service-key caller (fleet
      // oversight, the "one admin per server" model) may request a specific org
      // or the whole fleet. An unidentified caller gets nothing — never every
      // tenant's fleet, which was the previous behaviour (absent query param ->
      // orgId=undefined -> "all nodes", readable by anyone).
      const userOrg = req.user && req.user.org_id;
      if (userOrg) {
        const nodes = listGpuNodes(db, { orgId: userOrg });
        return res.json({ count: nodes.length, nodes });
      }
      if (req.service) {
        const qOrg = req.query && req.query.org_id;
        const nodes = qOrg ? listGpuNodes(db, { orgId: qOrg }) : listGpuNodes(db);
        return res.json({ count: nodes.length, nodes });
      }
      return res.json({ count: 0, nodes: [] });
    } catch (err) {
      return res.status(500).json({ error: 'gpu_nodes_list_failed', detail: err.message });
    }
  };
}

module.exports = {
  ensureGpuNodesSchema,
  isGpuHeartbeat,
  summarizeGpuDevices,
  deriveFleetTelemetry,
  recordGpuHeartbeat,
  markGpuNodeEnrolled,
  listGpuNodes,
  reseedGpuNodesIntoMap,
  createGpuNodesListHandler,
};
