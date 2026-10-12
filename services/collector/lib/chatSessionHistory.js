/**
 * Chat session history, quoxai/quox#706.
 *
 * Conversation history on the chat route used to be CLIENT-supplied only, so
 * `quox chat --conversation <id>`, Discord/Slack/generic webhooks and CLI-tools
 * session ids (SESSION_ENV_*) had no memory of the previous turn. This store is
 * the server-side source of truth: each successful exchange is appended, and a
 * turn with no client history is hydrated from it.
 *
 * TENANCY: a turn is readable only when stored org_id AND identity match the
 * caller's authenticated org/user (service callers without a user are their own
 * '__svc__' identity). A session id from another org/user hydrates nothing and
 * is indistinguishable from an unknown session.
 *
 * Own SQLite file (same idiom as channelConversationStore.js); every failure
 * degrades to "no history" and never breaks a live reply.
 */
'use strict';

const Database = require('better-sqlite3');
const { existsSync, mkdirSync } = require('fs');
const { dirname } = require('path');
const { encrypt, decrypt } = require('./encryption.js');

const DEFAULT_DB_PATH = process.env.CHAT_SESSION_TURNS_DB_PATH || '/var/lib/quox/chat-session-turns.db';
const SVC_IDENTITY = '__svc__';
const MAX_TURN_CHARS = 4000;
const MAX_TURNS_PER_SESSION = 50;
const PRUNE_BATCH = 500;
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_CHARS = 12000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_session_turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     TEXT NOT NULL,
    identity   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_session_turns_lookup
    ON chat_session_turns(org_id, identity, session_id, ts, id);
  CREATE INDEX IF NOT EXISTS idx_chat_session_turns_ts ON chat_session_turns(ts);
  CREATE INDEX IF NOT EXISTS idx_chat_session_turns_identity ON chat_session_turns(identity);
`;

const _connections = new Map();
const _warned = new Set();

function resolveDb(dbPath) {
  const p = dbPath || DEFAULT_DB_PATH;
  if (_connections.has(p)) return _connections.get(p);
  try {
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    _connections.set(p, db);
    return db;
  } catch (err) {
    if (!_warned.has(p)) {
      console.error(`[ChatSessionHistory] cannot open store at ${p}, history hydration disabled this process: ${err.message}`);
      _warned.add(p);
    }
    _connections.set(p, null);
    return null;
  }
}

function envInt(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function identityOf(userId) {
  return userId ? String(userId) : SVC_IDENTITY;
}

/** Append one user+assistant exchange. Returns true on durable write. */
function recordExchange({ orgId, userId, sessionId, prompt, reply }, { dbPath } = {}) {
  if (!orgId || !sessionId) return false;
  if (typeof prompt !== 'string' || typeof reply !== 'string' || !prompt || !reply) return false;
  const db = resolveDb(dbPath);
  if (!db) return false;
  const org = String(orgId), ident = identityOf(userId), sid = String(sessionId);
  const now = Date.now();
  // Encrypted at rest with the same master key as transcripts (lib/encryption.js).
  // Fail CLOSED: no key / cipher error means nothing is stored, never plaintext.
  let encUser, encReply;
  try {
    encUser = encrypt(prompt.slice(0, MAX_TURN_CHARS));
    encReply = encrypt(reply.slice(0, MAX_TURN_CHARS));
  } catch (err) {
    console.error(`[ChatSessionHistory] encryption unavailable, turn NOT stored: ${err.message.split('\n')[0]}`);
    return false;
  }
  try {
    const ins = db.prepare('INSERT INTO chat_session_turns (org_id, identity, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      ins.run(org, ident, sid, 'user', encUser, now);
      ins.run(org, ident, sid, 'assistant', encReply, now);
      db.prepare(`DELETE FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ?
                  AND id NOT IN (SELECT id FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? ORDER BY id DESC LIMIT ?)`)
        .run(org, ident, sid, org, ident, sid, MAX_TURNS_PER_SESSION);
      // TTL prune, bounded batch via the ts index (no full-table scan).
      db.prepare('DELETE FROM chat_session_turns WHERE id IN (SELECT id FROM chat_session_turns WHERE ts < ? ORDER BY ts LIMIT ?)')
        .run(now - envInt('CHAT_SESSION_TURNS_TTL_DAYS', DEFAULT_TTL_DAYS) * 86400000, PRUNE_BATCH);
    })();
    return true;
  } catch (err) {
    console.error(`[ChatSessionHistory] record failed: ${err.message}`);
    return false;
  }
}

/**
 * Client-supplied non-empty history wins untouched. Otherwise return the last
 * `limit` turns (oldest first) for this exact org+identity+session, within
 * `maxChars` (newest turns kept).
 * @returns {{ history: Array, hydrated: number }}
 */
function hydrateHistory({ orgId, userId, sessionId, clientHistory } = {}, { dbPath, limit, maxChars } = {}) {
  if (Array.isArray(clientHistory) && clientHistory.length > 0) return { history: clientHistory, hydrated: 0 };
  const empty = { history: Array.isArray(clientHistory) ? clientHistory : [], hydrated: 0 };
  if (!orgId || !sessionId) return empty;
  const db = resolveDb(dbPath);
  if (!db) return empty;
  const lim = limit || envInt('CHAT_HISTORY_HYDRATE_TURNS', 12);
  const budget = maxChars || envInt('CHAT_HISTORY_HYDRATE_MAX_CHARS', DEFAULT_MAX_CHARS);
  try {
    const rows = db.prepare(`SELECT role, content FROM chat_session_turns
      WHERE org_id = ? AND identity = ? AND session_id = ? ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(String(orgId), identityOf(userId), String(sessionId), lim);
    const kept = [];
    let used = 0;
    for (const r of rows) { // newest first
      let text;
      try { text = decrypt(r.content); } catch { break; } // undecryptable: stop, never leak ciphertext
      if (used + text.length > budget) break;
      used += text.length;
      kept.push({ role: r.role, content: text });
    }
    kept.reverse();
    return { history: kept, hydrated: kept.length };
  } catch (err) {
    console.error(`[ChatSessionHistory] hydrate failed: ${err.message}`);
    return empty;
  }
}

/** GDPR erasure: remove every turn a user created (all orgs). Returns rows deleted. */
function purgeUser(userId, { dbPath } = {}) {
  if (!userId) return 0;
  const db = resolveDb(dbPath);
  if (!db) return 0;
  try { return db.prepare('DELETE FROM chat_session_turns WHERE identity = ?').run(String(userId)).changes; }
  catch (err) { console.error(`[ChatSessionHistory] purgeUser failed: ${err.message}`); return 0; }
}

/** Org erasure: remove every turn in an org. Returns rows deleted. */
function purgeOrg(orgId, { dbPath } = {}) {
  if (!orgId) return 0;
  const db = resolveDb(dbPath);
  if (!db) return 0;
  try { return db.prepare('DELETE FROM chat_session_turns WHERE org_id = ?').run(String(orgId)).changes; }
  catch (err) { console.error(`[ChatSessionHistory] purgeOrg failed: ${err.message}`); return 0; }
}

/** Test hook: backdate all turns. */
function _backdateForTest(dbPath, ms) {
  const db = _connections.get(dbPath || DEFAULT_DB_PATH);
  if (db) db.prepare('UPDATE chat_session_turns SET ts = ts - ?').run(ms);
}

function _rawRowsForTest(dbPath) {
  const db = _connections.get(dbPath || DEFAULT_DB_PATH);
  return db ? db.prepare('SELECT * FROM chat_session_turns').all() : [];
}

function _resetForTest(dbPath) {
  const p = dbPath || DEFAULT_DB_PATH;
  const db = _connections.get(p);
  if (db) { try { db.exec('DELETE FROM chat_session_turns'); } catch { /* ignore */ } }
}

module.exports = { recordExchange, hydrateHistory, purgeUser, purgeOrg, _resetForTest, _backdateForTest, _rawRowsForTest };
