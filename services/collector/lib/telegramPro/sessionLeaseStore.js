/**
 * Session Lease Store, QTG-PRO P0.
 *
 * Multiple parallel Claude Code sessions run on this dev box, each
 * nominally owning a terminal identity (T1..T8). A lease makes that
 * ownership queryable and time-bounded: a session acquires a lease on its
 * terminal, renews it with a heartbeat every 45s, and the lease expires
 * after a 120s TTL if the session dies or stops heartbeating. A later
 * phase uses an expired lease as the signal to divert that terminal's
 * inbound Telegram messages to the HITL inbox instead of routing them to
 * a session that is no longer actually there.
 *
 * Mirrors the proven durable-store idiom already used by
 * channelConversationStore.js / reflectionMiningWatermark.js / feedWatermark.js
 * / gpuNodesStore.js: its own SQLite file (never shares a file with
 * aee.db/volt.db/session-leases' telegram-pro siblings), a connection cache
 * keyed by resolved dbPath (so tests can point at an isolated temp file),
 * schema applied inline via CREATE TABLE IF NOT EXISTS (idempotent, no
 * separate migration runner needed for a self-contained store), and every
 * read/write wrapped so a DB failure degrades to "no durable state" (null
 * / false) and logs once, rather than throwing.
 */

'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const { existsSync, mkdirSync } = require('fs');
const { dirname } = require('path');

const DEFAULT_DB_PATH = process.env.SESSION_LEASES_DB_PATH || '/var/lib/quox/session-leases.db';

const LEASE_TTL_MS = 120000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_leases (
    terminal     TEXT PRIMARY KEY,
    lease_id     TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    host         TEXT,
    stream       TEXT,
    acquired_at  INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
`;

// Connections cached per resolved dbPath, same rationale as
// channelConversationStore.js: tests point at an isolated temp file without
// disturbing (or being disturbed by) the production default, and repeated
// calls within a process reuse one open handle.
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
      console.error(`[SessionLeaseStore] failed to open durable store at ${resolvedPath}, falling back to no-persistence behavior this process, ${err.message}`);
      _warnedPaths.add(resolvedPath);
    }
    _connections.set(resolvedPath, null); // cache the failure too, don't retry every call
    return null;
  }
}

function withAlive(row, now) {
  if (!row) return null;
  return { ...row, alive: row.expires_at > now };
}

/**
 * Acquires (or renews) the lease on a terminal identity.
 *
 * Succeeds when no lease exists yet, the existing lease has expired, or the
 * existing lease is already held by the same session_id (idempotent
 * re-acquire, e.g. a session restarting its heartbeat loop after a crash).
 * Fails with { ok:false, error:'held', holder } when a different, still
 * alive session currently holds the terminal.
 *
 * @returns {{ok:true, leaseId:string, renewed:boolean}|{ok:false, error:string, holder?:object}}
 */
function acquire({ terminal, sessionId, host = null, stream = null } = {}, { dbPath, now = Date.now() } = {}) {
  if (!terminal) throw new Error('acquire requires terminal');
  if (!sessionId) throw new Error('acquire requires sessionId');

  const db = resolveDb(dbPath);
  if (!db) return { ok: false, error: 'store unavailable' };

  try {
    const existing = db.prepare('SELECT * FROM session_leases WHERE terminal = ?').get(terminal);
    const nowMs = typeof now === 'function' ? now() : now;

    if (existing && existing.expires_at > nowMs && existing.session_id !== sessionId) {
      return {
        ok: false,
        error: 'held',
        holder: { sessionId: existing.session_id, expiresAt: existing.expires_at },
      };
    }

    const renewed = !!(existing && existing.session_id === sessionId);
    const leaseId = crypto.randomUUID();
    const expiresAt = nowMs + LEASE_TTL_MS;

    db.prepare(`
      INSERT INTO session_leases (terminal, lease_id, session_id, host, stream, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(terminal) DO UPDATE SET
        lease_id    = excluded.lease_id,
        session_id  = excluded.session_id,
        host        = excluded.host,
        stream      = excluded.stream,
        acquired_at = excluded.acquired_at,
        expires_at  = excluded.expires_at
    `).run(terminal, leaseId, sessionId, host, stream, nowMs, expiresAt);

    return { ok: true, leaseId, renewed };
  } catch (err) {
    console.error(`[SessionLeaseStore] acquire failed for ${terminal}, ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Extends an already-held lease's expiry. Fails with { ok:false,
 * error:'lost' } when the lease_id doesn't match the current row (someone
 * else acquired the terminal) or the row is missing/expired already.
 */
function heartbeat({ terminal, leaseId } = {}, { dbPath, now = Date.now() } = {}) {
  if (!terminal) throw new Error('heartbeat requires terminal');
  if (!leaseId) throw new Error('heartbeat requires leaseId');

  const db = resolveDb(dbPath);
  if (!db) return { ok: false, error: 'store unavailable' };

  try {
    const nowMs = typeof now === 'function' ? now() : now;
    const existing = db.prepare('SELECT * FROM session_leases WHERE terminal = ?').get(terminal);
    if (!existing || existing.lease_id !== leaseId || existing.expires_at <= nowMs) {
      return { ok: false, error: 'lost' };
    }

    const expiresAt = nowMs + LEASE_TTL_MS;
    db.prepare('UPDATE session_leases SET expires_at = ? WHERE terminal = ? AND lease_id = ?')
      .run(expiresAt, terminal, leaseId);

    return { ok: true, expiresAt };
  } catch (err) {
    console.error(`[SessionLeaseStore] heartbeat failed for ${terminal}, ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Releases a lease iff leaseId matches the current holder. Returns
 * { ok:true } on a successful delete, { ok:false } if the lease didn't
 * match (already stolen/expired) or the store is unavailable.
 */
function release({ terminal, leaseId } = {}, { dbPath } = {}) {
  if (!terminal) throw new Error('release requires terminal');
  if (!leaseId) throw new Error('release requires leaseId');

  const db = resolveDb(dbPath);
  if (!db) return { ok: false };

  try {
    const info = db.prepare('DELETE FROM session_leases WHERE terminal = ? AND lease_id = ?').run(terminal, leaseId);
    return { ok: info.changes > 0 };
  } catch (err) {
    console.error(`[SessionLeaseStore] release failed for ${terminal}, ${err.message}`);
    return { ok: false };
  }
}

/** Single lease row for a terminal, with computed `alive`, or null. */
function getLease(terminal, { dbPath, now = Date.now() } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT * FROM session_leases WHERE terminal = ?').get(terminal);
    const nowMs = typeof now === 'function' ? now() : now;
    return withAlive(row, nowMs);
  } catch (err) {
    console.error(`[SessionLeaseStore] getLease failed for ${terminal}, ${err.message}`);
    return null;
  }
}

/** All lease rows, most recently acquired first, each with computed `alive`. */
function list({ dbPath, now = Date.now() } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT * FROM session_leases ORDER BY acquired_at DESC').all();
    const nowMs = typeof now === 'function' ? now() : now;
    return rows.map(row => withAlive(row, nowMs));
  } catch (err) {
    console.error(`[SessionLeaseStore] list failed, ${err.message}`);
    return [];
  }
}

/**
 * Test-only escape hatch: close and drop a cached connection so a test can
 * reopen the same dbPath fresh without connections leaking across test
 * files.
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
  acquire,
  heartbeat,
  release,
  getLease,
  list,
  _closeForTest,
  DEFAULT_DB_PATH,
  LEASE_TTL_MS,
};
