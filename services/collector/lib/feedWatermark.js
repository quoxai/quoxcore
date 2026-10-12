/**
 * The Feed — source registry + watermark store (WP1, F1 slice).
 *
 * Mirrors reflectionMiningWatermark.js's durable per-org high-water-mark
 * pattern exactly (same SQLite-connection-cache-per-dbPath approach, same
 * "never throw, degrade to null/false + log once" contract), but scoped
 * per (org, source_type) instead of per-org only — The Feed ingests
 * multiple independent sources per org (conversation, transcript, git,
 * fleet, ...) and each needs its own cursor.
 *
 * Deliberately a SEPARATE table/db-role from reflection_mining_watermark —
 * the plan (docs/STREAM_QUOXBRAIN_FEED_PLAN.md) is explicit that The Feed
 * and ReflectionMining consume the same AEE conversations independently,
 * so they must not share (or clobber) each other's cursors.
 *
 * Also owns feed_sources — the governed per-org source registry (F4's
 * Settings surface reads/writes this later; WP1 only needs get/upsert
 * helpers so feedConversationSource.js and its tests have somewhere to
 * read enabled/config from if/when they need it).
 */

'use strict';

const Database = require('better-sqlite3');
const { existsSync, mkdirSync } = require('fs');
const { dirname } = require('path');

// Same default directory reflectionMiningWatermark.js uses
// (/var/lib/quox/), but its OWN file — never share a db file with
// reflection-mining.db (independent lifecycles, independent lock
// contention).
const DEFAULT_DB_PATH = process.env.FEED_DB_PATH || '/var/lib/quox/feed.db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feed_sources (
    org_id      TEXT NOT NULL,
    source_type TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'org',
    enabled     INTEGER NOT NULL DEFAULT 1,
    config      TEXT,
    last_sync   TEXT,
    last_status TEXT,
    last_count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, source_type)
  );
  CREATE TABLE IF NOT EXISTS feed_watermark (
    org_id            TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    last_processed_ts TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (org_id, source_type)
  );
`;

// Connections cached per resolved dbPath — same rationale as
// reflectionMiningWatermark.js: tests point at an isolated temp file
// without disturbing (or being disturbed by) the production default, and
// repeated calls within a process reuse one open handle.
const _connections = new Map();
const _warnedPaths = new Set();

function resolveDb(dbPath) {
  const resolvedPath = dbPath || DEFAULT_DB_PATH;
  if (_connections.has(resolvedPath)) return _connections.get(resolvedPath);

  try {
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    // BRAIN2-W12 B3: owner of a private (scope 'user') source. Idempotent column add.
    const cols = db.prepare('PRAGMA table_info(feed_sources)').all();
    if (!cols.some((c) => c.name === 'owner_user_id')) db.exec('ALTER TABLE feed_sources ADD COLUMN owner_user_id TEXT');
    _connections.set(resolvedPath, db);
    return db;
  } catch (err) {
    if (!_warnedPaths.has(resolvedPath)) {
      console.error(`[FeedWatermark] failed to open durable store at ${resolvedPath} — falling back to no-watermark behavior this process — ${err.message}`);
      _warnedPaths.add(resolvedPath);
    }
    _connections.set(resolvedPath, null); // cache the failure too — don't retry every call
    return null;
  }
}

/**
 * The durable high-water mark for (org, source_type): the ISO timestamp of
 * the newest item The Feed has actually pushed for that source. Returns
 * null if unknown (first run, or store unavailable) — callers must treat
 * null as "no watermark, pull everything bounded by maxConversations"
 * rather than an error.
 */
function getWatermark(orgId, sourceType, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT last_processed_ts FROM feed_watermark WHERE org_id = ? AND source_type = ?').get(orgId, sourceType);
    return row ? row.last_processed_ts : null;
  } catch (err) {
    console.error(`[FeedWatermark] org=${orgId} source=${sourceType}: read failed — ${err.message}`);
    return null;
  }
}

/**
 * Persist the new high-water mark for (org, source_type). Monotonic by
 * convention — callers should only call this with the max timestamp of
 * items actually pushed this cycle, never move it backwards.
 */
function setWatermark(orgId, sourceType, ts, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO feed_watermark (org_id, source_type, last_processed_ts, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, source_type) DO UPDATE SET last_processed_ts = excluded.last_processed_ts, updated_at = excluded.updated_at
    `).run(orgId, sourceType, ts, new Date().toISOString());
    return true;
  } catch (err) {
    console.error(`[FeedWatermark] org=${orgId} source=${sourceType}: write failed — ${err.message}`);
    return false;
  }
}

/**
 * Reads the feed_sources registry row for (org, source_type). Returns null
 * if the source has never been registered (callers should treat an
 * unregistered autopilot source as enabled-by-default per the plan's
 * "Autopilot sources default-enabled" — WP2's scheduler makes that call,
 * not this store).
 */
function getSource(orgId, sourceType, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT * FROM feed_sources WHERE org_id = ? AND source_type = ?').get(orgId, sourceType);
    if (!row) return null;
    return { ...row, enabled: !!row.enabled };
  } catch (err) {
    console.error(`[FeedWatermark] org=${orgId} source=${sourceType}: getSource failed — ${err.message}`);
    return null;
  }
}

/**
 * BRAIN2-W7 A 017: org ids that have at least one ENABLED connected source.
 * Lets the scheduler enroll an org the moment it connects a source, without
 * an operator editing QUOXFEED_ORGS. Returns [] when the store is unavailable.
 */
function listEnrolledOrgs({ dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return [];
  try {
    return db.prepare('SELECT DISTINCT org_id FROM feed_sources WHERE enabled = 1').all().map((r) => r.org_id).filter(Boolean);
  } catch (err) {
    console.error(`[FeedWatermark] listEnrolledOrgs failed: ${err.message}`);
    return [];
  }
}

/**
 * Upserts a feed_sources row. `fields` may set any subset of
 * {scope, enabled, config, last_sync, last_status, last_count} — omitted
 * fields keep their existing value (or the column default on first
 * insert).
 */
function upsertSource(orgId, sourceType, fields = {}, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return false;
  try {
    const existing = db.prepare('SELECT * FROM feed_sources WHERE org_id = ? AND source_type = ?').get(orgId, sourceType);
    const merged = {
      scope: fields.scope ?? existing?.scope ?? 'org',
      enabled: fields.enabled === undefined ? (existing ? existing.enabled : 1) : (fields.enabled ? 1 : 0),
      config: fields.config === undefined ? (existing?.config ?? null) : (typeof fields.config === 'string' ? fields.config : JSON.stringify(fields.config)),
      last_sync: fields.last_sync === undefined ? (existing?.last_sync ?? null) : fields.last_sync,
      last_status: fields.last_status === undefined ? (existing?.last_status ?? null) : fields.last_status,
      last_count: fields.last_count === undefined ? (existing?.last_count ?? 0) : fields.last_count,
      owner_user_id: fields.owner_user_id === undefined ? (existing?.owner_user_id ?? null) : fields.owner_user_id,
    };
    db.prepare(`
      INSERT INTO feed_sources (org_id, source_type, scope, enabled, config, last_sync, last_status, last_count, owner_user_id)
      VALUES (@org_id, @source_type, @scope, @enabled, @config, @last_sync, @last_status, @last_count, @owner_user_id)
      ON CONFLICT(org_id, source_type) DO UPDATE SET
        scope = excluded.scope, enabled = excluded.enabled, config = excluded.config,
        last_sync = excluded.last_sync, last_status = excluded.last_status, last_count = excluded.last_count,
        owner_user_id = excluded.owner_user_id
    `).run({ org_id: orgId, source_type: sourceType, ...merged });
    return true;
  } catch (err) {
    console.error(`[FeedWatermark] org=${orgId} source=${sourceType}: upsertSource failed — ${err.message}`);
    return false;
  }
}


// ---------------------------------------------------------------------------
// Compound cursor (timestamp + stable id tiebreak)
//
// A plain "ts > watermark" cursor loses data when more items share the
// newest timestamp than one capped batch can carry: batch 1 advances the
// watermark to that shared ts, and the leftovers (same ts) are never
// strictly newer again. The compound cursor is stored in the same
// last_processed_ts TEXT column: either a plain ISO ts (legacy, nothing
// tied is pending) or `<ts>|<id>` (items at <ts> with id <= <id> are done,
// ties after it are still owed). Plain values stay valid, so old rows and
// old callers keep working.
// ---------------------------------------------------------------------------

function parseCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw);
  const i = s.indexOf('|');
  if (i < 0) return { ts: s, id: null };
  return { ts: s.slice(0, i), id: s.slice(i + 1) };
}

/** True when an item (ts, id) is still owed relative to the stored cursor. */
function isAfterCursor(raw, ts, id) {
  const c = parseCursor(raw);
  if (!c) return true;
  const t = String(ts);
  if (t > c.ts) return true;
  if (t < c.ts) return false;
  return c.id !== null && String(id ?? '') > c.id;
}

/** Comparator: ts ascending, then id ascending (stable total order). */
function compareByTsId(a, b) {
  const at = String(a.ts), bt = String(b.ts);
  if (at < bt) return -1;
  if (at > bt) return 1;
  const ai = String(a.id ?? ''), bi = String(b.id ?? '');
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * The cursor to persist after a batch.
 * @param {Array<{ts:string,id:string}>} processed items actually handled this tick
 * @param {Array<{ts:string,id:string}>} remaining eligible items NOT handled (cap cut them off)
 * @returns {string|null} null when nothing was processed
 */
function nextCursor(processed, remaining = []) {
  if (!processed || processed.length === 0) return null;
  const last = [...processed].sort(compareByTsId)[processed.length - 1];
  const tiesOwed = remaining.some((r) => String(r.ts) === String(last.ts));
  return tiesOwed ? `${last.ts}|${last.id ?? ''}` : String(last.ts);
}

/**
 * Test-only escape hatch: close and drop a cached connection so a test can
 * reopen the same dbPath fresh (simulating a process restart against the
 * same durable file) without connections leaking across test files.
 */
function _closeForTest(dbPath) {
  const resolvedPath = dbPath || DEFAULT_DB_PATH;
  const db = _connections.get(resolvedPath);
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  _connections.delete(resolvedPath);
  _warnedPaths.delete(resolvedPath);
}

module.exports = {
  getWatermark,
  setWatermark,
  getSource,
  upsertSource,
  listEnrolledOrgs,
  parseCursor,
  isAfterCursor,
  compareByTsId,
  nextCursor,
  _closeForTest,
  DEFAULT_DB_PATH,
};
