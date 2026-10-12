'use strict';

/**
 * devLoopSessionsStore.js — DEVSUITE-DEVMODE fleet spawn seam: durable
 * store for loop-session rows and their agent-pushed event streams
 * (migrations/aee/010). Same DI shape as devServersStore.js: every
 * function takes the better-sqlite3 db handle, so tests run against a
 * throwaway db with zero module state.
 *
 * Trust model: the collector mints a random ingest token per session at
 * spawn time and stores ONLY its sha256. The agent's EventForwarder echoes
 * the raw token on every batch; ingestBatch verifies by hash. Events are
 * (session_id, seq) primary-keyed, so the forwarder's at-least-once
 * delivery is idempotent, and reads resume from any seq.
 */

const crypto = require('crypto');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Session id generator — crypto-based, no external dep. The collector's
// package.json does not carry `ulid` (using it here crashlooped the
// collector on MODULE_NOT_FOUND, fixed 2026-08-13); a random hex id is
// fine — nothing depends on these being lexicographically time-sortable.
function newSessionId() {
  return `dls_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Create a session row; returns { id, ingestToken } — the ONLY time the
 * raw token is available.
 */
function createLoopSession(db, { orgId, hostId, backend }) {
  if (!db || !orgId || !hostId || !backend) {
    throw new Error('createLoopSession: db, orgId, hostId and backend are required');
  }
  const id = newSessionId();
  const ingestToken = crypto.randomBytes(24).toString('hex');
  db.prepare(`
    INSERT INTO dev_loop_sessions (id, org_id, host_id, backend, ingest_token_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'spawned', datetime('now'))
  `).run(id, orgId, hostId, backend, sha256Hex(ingestToken));
  return { id, ingestToken };
}

function getLoopSession(db, id) {
  return db.prepare('SELECT * FROM dev_loop_sessions WHERE id = ?').get(id) || null;
}

/** Record the agent-side session id once the spawn call returns it. */
function setAgentSessionId(db, id, agentSessionId) {
  db.prepare('UPDATE dev_loop_sessions SET agent_session_id = ?, status = ? WHERE id = ?')
    .run(agentSessionId, 'streaming', id);
}

function markLoopSessionError(db, id, message) {
  db.prepare(`UPDATE dev_loop_sessions SET status = 'error', done_at = datetime('now') WHERE id = ?`).run(id);
  // The error detail goes into the event stream so readers see it inline,
  // after whatever the last real event was.
  const last = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM dev_loop_session_events WHERE session_id = ?').get(id).m;
  db.prepare(`
    INSERT OR IGNORE INTO dev_loop_session_events (session_id, seq, type, raw, received_at)
    VALUES (?, ?, 'seam_error', ?, datetime('now'))
  `).run(id, last + 1, JSON.stringify({ type: 'seam_error', message: String(message).slice(0, 2000) }));
}

/**
 * Ingest one agent batch. Returns { ok, inserted, done, session, newEvents }
 * or throws with .code set for the route to map onto an HTTP status:
 *   'unknown_session' → 404, 'bad_token' → 401.
 * Idempotent under retry: replayed events hit the (session_id, seq) PK
 * and are ignored.
 *
 * newEvents holds only the GENUINELY-NEW rows (info.changes === 1), each as
 * { seq, type, rawSha256 }, so the route can WARD-witness every turn's
 * content hash exactly once. The agent EventForwarder is at-least-once, so a
 * full-duplicate retry returns newEvents = [] and must never be re-witnessed.
 * session is the loop-session row so the route has org_id/host_id to hand.
 */
function ingestEventBatch(db, sessionId, { ingestToken, events = [], done = false } = {}) {
  const session = getLoopSession(db, sessionId);
  if (!session) {
    const err = new Error(`unknown dev loop session ${sessionId}`);
    err.code = 'unknown_session';
    throw err;
  }
  if (sha256Hex(ingestToken || '') !== session.ingest_token_hash) {
    const err = new Error('ingest token mismatch');
    err.code = 'bad_token';
    throw err;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO dev_loop_session_events (session_id, seq, type, raw, received_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  let inserted = 0;
  const newEvents = [];
  const insertAll = db.transaction(() => {
    for (const e of events) {
      if (!e || !Number.isInteger(e.seq) || e.seq < 1) continue;
      const raw = typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw ?? null);
      const type = String(e.type || '');
      const info = insert.run(sessionId, e.seq, type, raw);
      inserted += info.changes;
      // Only genuinely-new rows (not skipped duplicates) get witnessed, so
      // the WARD chain binds seq -> hash exactly once per (session, seq).
      if (info.changes === 1) {
        newEvents.push({ seq: e.seq, type, rawSha256: sha256Hex(raw) });
      }
    }
  });
  insertAll();

  if (done) {
    db.prepare(`UPDATE dev_loop_sessions SET status = 'done', done_at = datetime('now') WHERE id = ? AND status != 'error'`).run(sessionId);
  }
  return { ok: true, inserted, done: !!done, session, newEvents };
}

/**
 * Read events after sinceSeq, oldest first, plus the session's status so
 * a poller can stop once status is terminal AND it has drained past the
 * last stored seq.
 */
function listEventsSince(db, sessionId, sinceSeq = 0, limit = 200) {
  const session = getLoopSession(db, sessionId);
  if (!session) {
    const err = new Error(`unknown dev loop session ${sessionId}`);
    err.code = 'unknown_session';
    throw err;
  }
  const rows = db.prepare(`
    SELECT seq, type, raw, received_at FROM dev_loop_session_events
    WHERE session_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `).all(sessionId, sinceSeq, Math.min(Math.max(1, limit), 1000));
  return {
    session_id: sessionId,
    status: session.status,
    done_at: session.done_at || null,
    events: rows,
  };
}

/**
 * List an org's loop sessions, newest first, optionally filtered to one
 * host (the DEVSUITE-HUB dev.sessions window). Each row carries latest_seq
 * (0 when no events yet) and never the ingest token hash — this is a
 * read surface for the dashboard, the hash stays server-side.
 */
function listLoopSessions(db, { orgId, hostId, limit = 50 } = {}) {
  if (!db || !orgId) throw new Error('listLoopSessions: db and orgId are required');
  const params = [orgId];
  let where = 's.org_id = ?';
  if (hostId) { where += ' AND s.host_id = ?'; params.push(hostId); }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  return db.prepare(`
    SELECT s.id, s.org_id, s.host_id, s.backend, s.agent_session_id, s.status,
           s.created_at, s.done_at,
           COALESCE((SELECT MAX(e.seq) FROM dev_loop_session_events e WHERE e.session_id = s.id), 0) AS latest_seq,
           (SELECT MAX(e.received_at) FROM dev_loop_session_events e WHERE e.session_id = s.id) AS last_turn_at
    FROM dev_loop_sessions s
    WHERE ${where}
    ORDER BY s.created_at DESC, s.rowid DESC
    LIMIT ?
  `).all(...params);
}

module.exports = {
  createLoopSession,
  getLoopSession,
  setAgentSessionId,
  markLoopSessionError,
  ingestEventBatch,
  listEventsSince,
  listLoopSessions,
  _sha256Hex: sha256Hex,
};
