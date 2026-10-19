/**
 * Reflection Mining Watermark Store — TRUST-GATE-1.25 (CPU/alert-flood fix).
 *
 * Root cause (live evidence 2026-07-03, sustained 82% CPU / 11.5h, dozens of
 * `[ReflectionMining] org=<id>: processed N conversation(s), extracted 0
 * memor(y/ies), 3 alert(s)` log lines repeating per cycle across 50+ orgs):
 *
 *   TRUST-GATE-1.24 made the scheduler enumerate ALL live orgs instead of the
 *   single hardcoded 'default' org. That was correct, but it exposed two
 *   pre-existing gaps that were harmless with one org and catastrophic with
 *   fifty:
 *
 *   1. Conversation "already processed" tracking lived in a pure in-memory
 *      Set (`globalProcessedConversations`, module-level, never persisted).
 *      Every cycle re-queried the full 24h lookback window per org with no
 *      way to cheaply say "nothing new since last time" — the SQLite query
 *      + in-JS filtering ran at full cost every 5 minutes for every org
 *      forever, and a process restart wiped all progress (reprocesses
 *      everything from scratch on boot).
 *
 *   2. The pattern-detection -> proactive-alert path had ZERO idempotency:
 *      every cycle re-ran detectPatterns() over the same recent envelopes
 *      and re-POSTed the exact same ~3 alerts to the memory service, per
 *      org, every 5 minutes, forever. This is the direct cause of the log
 *      pattern above and the bulk of the alert-store flood.
 *
 * Fix: a small durable (SQLite-backed) key/value store, scoped per-org, for
 * (a) the high-water mark of the last conversation activity actually mined
 * for that org, and (b) a dedup fingerprint of alerts already emitted so the
 * same condition doesn't create a new alert row every cycle. Both are
 * seeded from the durable file on first access within a process — NOT a
 * pure in-memory map that reprocesses everything on restart.
 *
 * Every operation here is best-effort and never throws: this feeds a
 * background scheduler. If the DB can't be opened/written (e.g. missing
 * permissions), every function degrades to "no durable state available"
 * (get* returns null/false) and logs loudly exactly once per failure —
 * the scheduler falls back to its pre-existing full-lookback behavior
 * rather than crashing.
 */

'use strict';

const Database = require('better-sqlite3');
const { existsSync, mkdirSync } = require('fs');
const { dirname } = require('path');

const DEFAULT_DB_PATH = process.env.REFLECTION_MINING_DB_PATH || '/var/lib/quox/reflection-mining.db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reflection_mining_watermark (
    org_id            TEXT PRIMARY KEY,
    last_processed_ts TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reflection_chat_mining_marks (
    org_id        TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    last_mined_ts INTEGER NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (org_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS reflection_mining_alert_dedup (
    dedup_key   TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    last_seen_ts TEXT NOT NULL
  );
`;

// Connections are cached per resolved dbPath so tests can point at an
// isolated temp file without disturbing (or being disturbed by) the
// production default, and so repeated calls within a process reuse one
// open handle instead of re-opening the file every call.
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
    _connections.set(resolvedPath, db);
    return db;
  } catch (err) {
    if (!_warnedPaths.has(resolvedPath)) {
      console.error(`[ReflectionMiningWatermark] failed to open durable store at ${resolvedPath} — falling back to no-watermark behavior this process — ${err.message}`);
      _warnedPaths.add(resolvedPath);
    }
    _connections.set(resolvedPath, null); // cache the failure too — don't retry every call
    return null;
  }
}

/**
 * The durable high-water mark for an org: the ISO timestamp of the most
 * recent conversation activity actually mined for that org. Returns null
 * if unknown (first run, or store unavailable) — callers must treat null
 * as "no watermark, use the full lookback window" rather than an error.
 */
function getWatermark(orgId, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT last_processed_ts FROM reflection_mining_watermark WHERE org_id = ?').get(orgId);
    return row ? row.last_processed_ts : null;
  } catch (err) {
    console.error(`[ReflectionMiningWatermark] org=${orgId}: read failed — ${err.message}`);
    return null;
  }
}

/**
 * Persist the new high-water mark for an org. Monotonic by convention —
 * callers should only call this with the max lastTs of conversations
 * actually processed this cycle, never move it backwards.
 */
function setWatermark(orgId, ts, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO reflection_mining_watermark (org_id, last_processed_ts, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET last_processed_ts = excluded.last_processed_ts, updated_at = excluded.updated_at
    `).run(orgId, ts, new Date().toISOString());
    return true;
  } catch (err) {
    console.error(`[ReflectionMiningWatermark] org=${orgId}: write failed — ${err.message}`);
    return false;
  }
}

/**
 * Has this exact alert condition (dedupKey = org + alert-type + subject)
 * already been emitted within `withinMs`? Used to stop regenerating an
 * identical alert every scheduler tick. If `withinMs` is null/undefined,
 * any prior record at all counts as "already sent" (never re-fires).
 */
function alertAlreadySent(dedupKey, { withinMs, dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return false; // no durable store available — degrade to "always fresh" (pre-fix behavior)
  try {
    const row = db.prepare('SELECT last_seen_ts FROM reflection_mining_alert_dedup WHERE dedup_key = ?').get(dedupKey);
    if (!row) return false;
    if (withinMs === null || withinMs === undefined) return true;
    return (Date.now() - new Date(row.last_seen_ts).getTime()) < withinMs;
  } catch (err) {
    console.error(`[ReflectionMiningWatermark] dedup read failed for ${dedupKey} — ${err.message}`);
    return false;
  }
}

function recordAlertSent(dedupKey, orgId, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO reflection_mining_alert_dedup (dedup_key, org_id, last_seen_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(dedup_key) DO UPDATE SET last_seen_ts = excluded.last_seen_ts
    `).run(dedupKey, orgId, new Date().toISOString());
    return true;
  } catch (err) {
    console.error(`[ReflectionMiningWatermark] dedup write failed for ${dedupKey} — ${err.message}`);
    return false;
  }
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

/**
 * BRAIN2-FABLE11 quox#1193 chat mining: the newest chat turn (epoch ms) already mined for one
 * session. Durable, so a continued session or a collector restart never mines the same turns
 * twice. Returns null when the session was never mined (or the store is unreadable).
 */
function getChatMark(orgId, sessionId, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT last_mined_ts FROM reflection_chat_mining_marks WHERE org_id = ? AND session_id = ?').get(String(orgId), String(sessionId));
    return row ? Number(row.last_mined_ts) : null;
  } catch (err) {
    console.error(`[ReflectionMiningWatermark] org=${orgId}: chat mark read failed — ${err.message}`);
    return null;
  }
}

/** Advance a session's chat mark (never backwards). */
function setChatMark(orgId, sessionId, ts, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO reflection_chat_mining_marks (org_id, session_id, last_mined_ts, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, session_id) DO UPDATE SET
        last_mined_ts = MAX(last_mined_ts, excluded.last_mined_ts), updated_at = excluded.updated_at
    `).run(String(orgId), String(sessionId), Number(ts), new Date().toISOString());
    return true;
  } catch (err) {
    console.error(`[ReflectionMiningWatermark] org=${orgId}: chat mark write failed — ${err.message}`);
    return false;
  }
}

module.exports = {
  getChatMark,
  setChatMark,
  getWatermark,
  setWatermark,
  alertAlreadySent,
  recordAlertSent,
  _closeForTest,
  DEFAULT_DB_PATH,
};
