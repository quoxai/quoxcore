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
// CLI-QUOX B1 (G0 port): a bounded, scrubbed summary of the tool calls a governed turn
// made, stored as an 'activity' row beside the exchange. Only an opt-in hydrate reads it.
const ACTIVITY_ROLE = 'activity';
const MAX_ACTIVITY_CHARS = 1500;
// /compact: a summary row is the head of the history. Turns it replaced are kept
// (compacted = 1) for audit and export, never hydrated again.
const SUMMARY_ROLE = 'summary';
const MAX_SUMMARY_CHARS = 8000;
const SUMMARY_PREFIX = '[Conversation summary: the earlier part of this conversation, compacted on request]\n';

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
  -- CLI-QUOX continuity: one Claude CLI session per (org, user, conversation, agent),
  -- resumed with --resume on the next quox turn. Additive table; nothing reads it
  -- unless the caller is the quox client.
  CREATE TABLE IF NOT EXISTS chat_cli_sessions (
    org_id         TEXT NOT NULL,
    identity       TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    cli_session_id TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_used      INTEGER NOT NULL,
    context_tokens INTEGER,
    context_window INTEGER,
    last_msg_id    INTEGER NOT NULL DEFAULT 0,
    turns          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, identity, session_id, agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_cli_sessions_identity ON chat_cli_sessions(identity);
  CREATE INDEX IF NOT EXISTS idx_chat_cli_sessions_last_used ON chat_cli_sessions(last_used);
  -- D2: who owns each Claude CLI session FILE (HOME/.claude/projects/*/<id>.jsonl).
  -- Outlives the mapping row above (which moves on when a session is replaced),
  -- so GDPR purge and the TTL prune can find and delete every file an org or user owns.
  CREATE TABLE IF NOT EXISTS chat_cli_session_files (
    cli_session_id TEXT PRIMARY KEY,
    org_id         TEXT NOT NULL,
    identity       TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_used      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_cli_session_files_org ON chat_cli_session_files(org_id);
  CREATE INDEX IF NOT EXISTS idx_chat_cli_session_files_identity ON chat_cli_session_files(identity);
  CREATE INDEX IF NOT EXISTS idx_chat_cli_session_files_last_used ON chat_cli_session_files(last_used);
`;

const _connections = new Map();
const _warned = new Set();

// D2: the CLI projects dir (RUNTIME_HOME/.claude/projects), set once by server.js
// at boot. Unset: rows are still tagged and purged, files are left (and logged).
let _cliProjectsDir = null;
function setCliProjectsDir(dir) { _cliProjectsDir = dir ? String(dir) : null; }
function projectsDirFor(opts) { return (opts && opts.cliProjectsDir) || _cliProjectsDir; }
const cliFiles = require('./cliSessionFiles.js');

function resolveDb(dbPath) {
  const p = dbPath || DEFAULT_DB_PATH;
  if (_connections.has(p)) return _connections.get(p);
  try {
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    // CLI-QUOXON Q2: turn id per exchange (additive, nullable; pre-existing rows stay null).
    try {
      const cols = db.prepare('PRAGMA table_info(chat_session_turns)').all();
      if (!cols.some((c) => c.name === 'turn_id')) db.exec('ALTER TABLE chat_session_turns ADD COLUMN turn_id TEXT');
      // QUOXON J2: the agent each exchange ran under (what turn.started reports), for the session index.
      if (!cols.some((c) => c.name === 'agent_id')) db.exec('ALTER TABLE chat_session_turns ADD COLUMN agent_id TEXT');
    } catch (migErr) {
      console.error(`[ChatSessionHistory] turn_id migration failed (${migErr.message}); turn ids will not be stored`);
    }
    // /compact (additive): compacted flag, and the provider/model that answered each exchange.
    try {
      const cols = db.prepare('PRAGMA table_info(chat_session_turns)').all().map((c) => c.name);
      if (!cols.includes('compacted')) db.exec('ALTER TABLE chat_session_turns ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0');
      if (!cols.includes('provider')) db.exec('ALTER TABLE chat_session_turns ADD COLUMN provider TEXT');
      if (!cols.includes('model')) db.exec('ALTER TABLE chat_session_turns ADD COLUMN model TEXT');
    } catch (migErr) {
      console.error(`[ChatSessionHistory] compaction migration failed (${migErr.message}); /compact disabled for this store`);
    }
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
function recordExchange({ orgId, userId, sessionId, prompt, reply, turnId, activity, agentId, provider, model }, { dbPath } = {}) {
  if (!orgId || !sessionId) return false;
  if (typeof prompt !== 'string' || typeof reply !== 'string' || !prompt || !reply) return false;
  const db = resolveDb(dbPath);
  if (!db) return false;
  const org = String(orgId), ident = identityOf(userId), sid = String(sessionId);
  const now = Date.now();
  // Encrypted at rest with the same master key as transcripts (lib/encryption.js).
  // Fail CLOSED: no key / cipher error means nothing is stored, never plaintext.
  let encUser, encReply, encActivity = null;
  try {
    encUser = encrypt(prompt.slice(0, MAX_TURN_CHARS));
    encReply = encrypt(reply.slice(0, MAX_TURN_CHARS));
    if (typeof activity === 'string' && activity.trim()) encActivity = encrypt(activity.slice(0, MAX_ACTIVITY_CHARS));
  } catch (err) {
    console.error(`[ChatSessionHistory] encryption unavailable, turn NOT stored: ${err.message.split('\n')[0]}`);
    return false;
  }
  try {
    const tid = typeof turnId === 'string' && turnId ? turnId.slice(0, 80) : null;
    const aid = typeof agentId === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(agentId) ? agentId : null;
    const prov = typeof provider === 'string' && provider ? provider.slice(0, 40) : null;
    const mdl = typeof model === 'string' && model ? model.slice(0, 120) : null;
    const hasMeta = hasCompactionColumns(db);
    const ins = hasMeta
      ? db.prepare('INSERT INTO chat_session_turns (org_id, identity, session_id, role, content, ts, turn_id, agent_id, provider, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      : db.prepare('INSERT INTO chat_session_turns (org_id, identity, session_id, role, content, ts, turn_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const put = (role, enc) => (hasMeta ? ins.run(org, ident, sid, role, enc, now, tid, aid, prov, mdl) : ins.run(org, ident, sid, role, enc, now, tid, aid));
    db.transaction(() => {
      put('user', encUser);
      if (encActivity) put(ACTIVITY_ROLE, encActivity);
      put('assistant', encReply);
      // Row cap per session. The summary rows are outside the cap: pruning the head of
      // a compacted history would silently drop everything it stands for.
      db.prepare(`DELETE FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? AND role != '${SUMMARY_ROLE}'
                  AND id NOT IN (SELECT id FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? AND role != '${SUMMARY_ROLE}' ORDER BY id DESC LIMIT ?)`)
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
function hydrateHistory({ orgId, userId, sessionId, clientHistory, includeActivity = false } = {}, { dbPath, limit, maxChars } = {}) {
  if (Array.isArray(clientHistory) && clientHistory.length > 0) return { history: clientHistory, hydrated: 0 };
  const empty = { history: Array.isArray(clientHistory) ? clientHistory : [], hydrated: 0 };
  if (!orgId || !sessionId) return empty;
  const db = resolveDb(dbPath);
  if (!db) return empty;
  const lim = limit || envInt('CHAT_HISTORY_HYDRATE_TURNS', 12);
  let budget = maxChars || envInt('CHAT_HISTORY_HYDRATE_MAX_CHARS', DEFAULT_MAX_CHARS);
  try {
    const compactable = hasCompactionColumns(db);
    // /compact: the latest summary heads the history; only turns not compacted follow it.
    const head = compactable ? latestSummary(db, orgId, userId, sessionId) : null;
    if (head) budget = Math.max(0, budget - head.length);
    const live = compactable ? `AND compacted = 0 AND role != '${SUMMARY_ROLE}'` : '';
    // Activity rows never count against the turn limit and are never a message of their own.
    const rows = includeActivity
      ? db.prepare(`SELECT role, content FROM chat_session_turns
          WHERE org_id = ? AND identity = ? AND session_id = ? ${live} ORDER BY ts DESC, id DESC LIMIT ?`)
        .all(String(orgId), identityOf(userId), String(sessionId), lim * 2)
      : db.prepare(`SELECT role, content FROM chat_session_turns
          WHERE org_id = ? AND identity = ? AND session_id = ? AND role != '${ACTIVITY_ROLE}' ${live} ORDER BY ts DESC, id DESC LIMIT ?`)
        .all(String(orgId), identityOf(userId), String(sessionId), lim);
    const kept = [];
    let used = 0;
    let messages = 0;
    for (const r of rows) { // newest first: assistant, then that turn's activity, then user
      let text;
      try { text = decrypt(r.content); } catch { break; } // undecryptable: stop, never leak ciphertext
      if (r.role === ACTIVITY_ROLE) {
        const last = kept[kept.length - 1];
        if (!last || last.role !== 'assistant' || last._activity) continue; // orphaned: skip
        const prefix = `[Tool activity] ${text}\n\n`;
        if (used + prefix.length > budget) continue;
        used += prefix.length;
        last.content = prefix + last.content;
        last._activity = true;
        continue;
      }
      if (messages >= lim) break;
      if (used + text.length > budget) break;
      used += text.length;
      messages++;
      kept.push({ role: r.role, content: text });
    }
    for (const k of kept) delete k._activity;
    kept.reverse();
    // Role 'user' so every provider builder accepts it (they rebuild { role, content });
    // `summary: true` lets the CLI Recent Conversation block label it as a summary.
    if (head) kept.unshift({ role: 'user', content: head, summary: true });
    return { history: kept, hydrated: kept.length };
  } catch (err) {
    console.error(`[ChatSessionHistory] hydrate failed: ${err.message}`);
    return empty;
  }
}


/**
 * CLI-QUOXON Q2: conversation index for this caller (org + identity scoped, same
 * tenancy rule as hydrateHistory). Newest first. Title = first user message
 * (decrypted, truncated). Turn ids are not persisted in this table, so callers
 * get no last_turn_id (honest gap, see GET /api/v1/conversations).
 * @returns {Array<{id:string,title:string,updated_at:number,turn_count:number}>}
 */
function listSessions({ orgId, userId, limit } = {}, { dbPath } = {}) {
  if (!orgId) return [];
  const db = resolveDb(dbPath);
  if (!db) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    const sessions = db.prepare(`SELECT session_id, MAX(ts) AS updated, MAX(id) AS last_id, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS turns
      FROM chat_session_turns WHERE org_id = ? AND identity = ? GROUP BY session_id ORDER BY last_id DESC LIMIT ?`)
      .all(String(orgId), identityOf(userId), lim);
    const first = db.prepare(`SELECT content FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`);
    const lastTid = db.prepare(`SELECT turn_id FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? AND turn_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
    const lastAgent = db.prepare(`SELECT agent_id FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? AND agent_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
    const cliAgent = db.prepare(`SELECT agent_id FROM chat_cli_sessions WHERE org_id = ? AND identity = ? AND session_id = ? ORDER BY last_used DESC LIMIT 1`);
    return sessions.map((r) => {
      let title = '';
      try {
        const row = first.get(String(orgId), identityOf(userId), r.session_id);
        if (row) title = decrypt(row.content).replace(/\s+/g, ' ').trim().slice(0, 80);
      } catch { title = ''; } // undecryptable: no title, never ciphertext
      let lastTurnId = null;
      try {
        const t = lastTid.get(String(orgId), identityOf(userId), r.session_id);
        lastTurnId = (t && t.turn_id) || null;
      } catch { lastTurnId = null; }
      // Exchanges before the agent column existed fall back to the conversation's CLI session agent.
      let agent = null;
      try {
        const a = lastAgent.get(String(orgId), identityOf(userId), r.session_id) || cliAgent.get(String(orgId), identityOf(userId), r.session_id);
        agent = (a && a.agent_id) || null;
      } catch { agent = null; }
      return { id: r.session_id, title, updated_at: r.updated, turn_count: r.turns, last_turn_id: lastTurnId, agent };
    });
  } catch (err) {
    console.error(`[ChatSessionHistory] listSessions failed: ${err.message}`);
    return [];
  }
}

/**
 * Persisted messages of one conversation, oldest first, strictly after `after`
 * (a message id from a previous call). Another org/user's session id returns [].
 * @returns {Array<{id:number,role:string,content:string,ts:number}>}
 */
function listMessages({ orgId, userId, sessionId, after, limit } = {}, { dbPath } = {}) {
  if (!orgId || !sessionId) return [];
  const db = resolveDb(dbPath);
  if (!db) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const cursor = Number.isFinite(parseInt(after, 10)) ? parseInt(after, 10) : 0;
  try {
    const cols = hasCompactionColumns(db) ? ', compacted' : '';
    const rows = db.prepare(`SELECT id, role, content, ts, turn_id${cols} FROM chat_session_turns
      WHERE org_id = ? AND identity = ? AND session_id = ? AND id > ? AND role != '${ACTIVITY_ROLE}' ORDER BY id ASC LIMIT ?`)
      .all(String(orgId), identityOf(userId), String(sessionId), cursor, lim);
    const out = [];
    out.skipped = 0;
    out.lastId = rows.length ? rows[rows.length - 1].id : null;
    for (const r of rows) {
      let text;
      try { text = decrypt(r.content); } catch { out.skipped++; continue; } // never expose ciphertext; keep paging
      out.push({ id: r.id, role: r.role, content: text, ts: r.ts, turn_id: r.turn_id || null, compacted: !!r.compacted });
    }
    if (out.skipped) console.warn(`[ChatSessionHistory] listMessages skipped ${out.skipped} undecryptable row(s) in one page`);
    return out;
  } catch (err) {
    console.error(`[ChatSessionHistory] listMessages failed: ${err.message}`);
    return [];
  }
}

/** Highest stored message id of one conversation for this org + user (0 when none). */
/** Epoch ms of the newest stored turn for (org, user, session); 0 when none or on error. */
function lastTurnAt({ orgId, userId, sessionId } = {}, { dbPath } = {}) {
  if (!orgId || !sessionId) return 0;
  const db = resolveDb(dbPath);
  if (!db) return 0;
  try {
    const r = db.prepare('SELECT MAX(ts) AS m FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ?')
      .get(String(orgId), identityOf(userId), String(sessionId));
    return (r && r.m) || 0;
  } catch (err) {
    console.error(`[ChatSessionHistory] lastTurnAt failed: ${err.message}`);
    return 0;
  }
}

function lastMessageId({ orgId, userId, sessionId } = {}, { dbPath } = {}) {
  if (!orgId || !sessionId) return 0;
  const db = resolveDb(dbPath);
  if (!db) return 0;
  try {
    const r = db.prepare('SELECT MAX(id) AS m FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ?')
      .get(String(orgId), identityOf(userId), String(sessionId));
    return (r && r.m) || 0;
  } catch (err) {
    console.error(`[ChatSessionHistory] lastMessageId failed: ${err.message}`);
    return 0;
  }
}

const _compactionCols = new WeakMap();
function hasCompactionColumns(db) {
  if (_compactionCols.has(db)) return _compactionCols.get(db);
  let ok = false;
  try {
    const cols = db.prepare('PRAGMA table_info(chat_session_turns)').all().map((c) => c.name);
    ok = cols.includes('compacted') && cols.includes('provider') && cols.includes('model');
  } catch { ok = false; }
  _compactionCols.set(db, ok);
  return ok;
}

/** Decrypted text of the newest summary row (with its prefix), or null. Undecryptable: null. */
function latestSummary(db, orgId, userId, sessionId) {
  const row = db.prepare(`SELECT content FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? AND role = '${SUMMARY_ROLE}'
    ORDER BY id DESC LIMIT 1`).get(String(orgId), identityOf(userId), String(sessionId));
  if (!row) return null;
  try { return SUMMARY_PREFIX + decrypt(row.content); } catch { return null; }
}

/**
 * /compact source: the current summary (without prefix) and every live turn
 * (user, assistant, activity; oldest first) up to and including `upToId`, the
 * highest row id at read time. Rows written after it (a turn racing the model
 * call) stay live. Returns null when the conversation has nothing for this
 * org + user (indistinguishable from someone else's conversation).
 */
function compactionSource({ orgId, userId, sessionId } = {}, { dbPath } = {}) {
  if (!orgId || !sessionId) return null;
  const db = resolveDb(dbPath);
  if (!db || !hasCompactionColumns(db)) return null;
  const args = [String(orgId), identityOf(userId), String(sessionId)];
  const max = db.prepare('SELECT MAX(id) AS m FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ?').get(...args);
  if (!max || !max.m) return null;
  const upToId = max.m;
  let summary = null;
  const s = db.prepare(`SELECT content FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ? AND role = '${SUMMARY_ROLE}' ORDER BY id DESC LIMIT 1`).get(...args);
  if (s) { try { summary = decrypt(s.content); } catch { summary = null; } }
  const rows = db.prepare(`SELECT id, role, content FROM chat_session_turns WHERE org_id = ? AND identity = ? AND session_id = ?
    AND compacted = 0 AND role != '${SUMMARY_ROLE}' AND id <= ? ORDER BY id ASC`).all(...args, upToId);
  const turns = [];
  let skipped = 0;
  for (const r of rows) {
    try { turns.push({ id: r.id, role: r.role, content: decrypt(r.content) }); } catch { skipped++; }
  }
  return { summary, turns, upToId, skipped };
}

/**
 * Store a summary as the new head and mark every row up to `upToId` (older
 * summaries included) compacted, in one transaction. Encrypted like turns; fail
 * closed (nothing stored, nothing marked). Returns the summary row id or 0.
 */
function storeSummary({ orgId, userId, sessionId, summary, upToId, provider, model } = {}, { dbPath } = {}) {
  if (!orgId || !sessionId || typeof summary !== 'string' || !summary.trim() || !(upToId > 0)) return 0;
  const db = resolveDb(dbPath);
  if (!db || !hasCompactionColumns(db)) return 0;
  let enc;
  try { enc = encrypt(summary.slice(0, MAX_SUMMARY_CHARS)); } catch (err) {
    console.error(`[ChatSessionHistory] encryption unavailable, summary NOT stored: ${err.message.split('\n')[0]}`);
    return 0;
  }
  const args = [String(orgId), identityOf(userId), String(sessionId)];
  try {
    let id = 0;
    db.transaction(() => {
      db.prepare('UPDATE chat_session_turns SET compacted = 1 WHERE org_id = ? AND identity = ? AND session_id = ? AND id <= ?').run(...args, upToId);
      id = db.prepare(`INSERT INTO chat_session_turns (org_id, identity, session_id, role, content, ts, turn_id, compacted, provider, model) VALUES (?, ?, ?, '${SUMMARY_ROLE}', ?, ?, NULL, 0, ?, ?)`)
        .run(...args, enc, Date.now(), provider ? String(provider).slice(0, 40) : null, model ? String(model).slice(0, 120) : null).lastInsertRowid;
      // Superseded summaries are history, not head: keep them flagged compacted.
      db.prepare(`UPDATE chat_session_turns SET compacted = 1 WHERE org_id = ? AND identity = ? AND session_id = ? AND role = '${SUMMARY_ROLE}' AND id < ?`).run(...args, id);
    })();
    return Number(id) || 0;
  } catch (err) {
    console.error(`[ChatSessionHistory] storeSummary failed: ${err.message}`);
    return 0;
  }
}

/**
 * /context numbers for one conversation (org + user scoped). null when nothing is stored.
 * live_chars = what hydration would carry (summary + live user/assistant turns, unbounded).
 */
function conversationStats({ orgId, userId, sessionId } = {}, { dbPath } = {}) {
  if (!orgId || !sessionId) return null;
  const db = resolveDb(dbPath);
  if (!db || !hasCompactionColumns(db)) return null;
  const args = [String(orgId), identityOf(userId), String(sessionId)];
  try {
    const rows = db.prepare(`SELECT id, role, content, ts, compacted, provider, model FROM chat_session_turns
      WHERE org_id = ? AND identity = ? AND session_id = ? ORDER BY id ASC`).all(...args);
    if (!rows.length) return null;
    let turns = 0, compactedTurns = 0, liveChars = 0, provider = null, model = null, summaryAt = null, lastTs = 0, headSummary = null;
    for (const r of rows) {
      lastTs = Math.max(lastTs, r.ts);
      if (r.role === 'user') { if (r.compacted) compactedTurns++; else turns++; }
      if (r.role === 'summary' && !r.compacted) { headSummary = r; summaryAt = r.ts; }
      if (r.role !== 'summary' && r.provider) { provider = r.provider; model = r.model || null; }
      if (!r.compacted && r.role !== ACTIVITY_ROLE && r.role !== 'summary') {
        try { liveChars += decrypt(r.content).length; } catch { /* undecryptable: not hydrated either */ }
      }
    }
    if (headSummary) { try { liveChars += SUMMARY_PREFIX.length + decrypt(headSummary.content).length; } catch { /* ignore */ } }
    const cli = db.prepare('SELECT context_tokens, context_window, last_used FROM chat_cli_sessions WHERE org_id = ? AND identity = ? AND session_id = ? ORDER BY last_used DESC LIMIT 1').get(...args) || null;
    return { turns, compactedTurns, liveChars, summaryPresent: !!headSummary, summaryAt, provider, model, lastTs, cli };
  } catch (err) {
    console.error(`[ChatSessionHistory] conversationStats failed: ${err.message}`);
    return null;
  }
}

/** Drop the CLI resume mapping(s) of one conversation (every agent). Session files stay owned + TTL-pruned. */
function resetCliSessions({ orgId, userId, sessionId } = {}, { dbPath } = {}) {
  if (!orgId || !userId || !sessionId) return 0;
  const db = resolveDb(dbPath);
  if (!db) return 0;
  try {
    return db.prepare('DELETE FROM chat_cli_sessions WHERE org_id = ? AND identity = ? AND session_id = ?')
      .run(String(orgId), String(userId), String(sessionId).slice(0, 200)).changes;
  } catch (err) {
    console.error(`[ChatSessionHistory] resetCliSessions failed: ${err.message}`);
    return 0;
  }
}

// CLI-QUOX continuity. A REAL user is required (never the shared '__svc__'
// identity): a resumed CLI session carries tool results, so it must never be
// reachable from another user or org that happens to hold the same conversation id.
function cliKey({ orgId, userId, conversationId, agentId }) {
  if (!orgId || !userId || !conversationId || !agentId) return null;
  return [String(orgId), String(userId), String(conversationId).slice(0, 200), String(agentId).slice(0, 80)];
}

/** The stored CLI session for (org, user, conversation, agent), or null. */
function getCliSession(key, { dbPath } = {}) {
  const k = cliKey(key || {});
  if (!k) return null;
  const db = resolveDb(dbPath);
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM chat_cli_sessions WHERE org_id = ? AND identity = ? AND session_id = ? AND agent_id = ?').get(...k) || null;
  } catch (err) {
    console.error(`[ChatSessionHistory] getCliSession failed: ${err.message}`);
    return null;
  }
}

/** Upsert the CLI session a turn ran in. Returns true on durable write. */
function recordCliSession({ cliSessionId, contextTokens, contextWindow, lastMsgId, ...key } = {}, opts = {}) {
  const { dbPath } = opts;
  const k = cliKey(key);
  if (!k || typeof cliSessionId !== 'string' || !cliSessionId) return false;
  const db = resolveDb(dbPath);
  if (!db) return false;
  const now = Date.now();
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  try {
    db.prepare(`INSERT INTO chat_cli_sessions (org_id, identity, session_id, agent_id, cli_session_id, created_at, last_used, context_tokens, context_window, last_msg_id, turns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(org_id, identity, session_id, agent_id) DO UPDATE SET
        cli_session_id = excluded.cli_session_id,
        created_at = CASE WHEN chat_cli_sessions.cli_session_id = excluded.cli_session_id THEN chat_cli_sessions.created_at ELSE excluded.created_at END,
        last_used = excluded.last_used,
        context_tokens = excluded.context_tokens,
        context_window = excluded.context_window,
        last_msg_id = excluded.last_msg_id,
        turns = CASE WHEN chat_cli_sessions.cli_session_id = excluded.cli_session_id THEN chat_cli_sessions.turns + 1 ELSE 1 END`)
      .run(...k, cliSessionId.slice(0, 80), now, now, num(contextTokens), num(contextWindow), num(lastMsgId) || 0);
    tagCliSessionFile(db, k[0], k[1], cliSessionId, now);
    // Idle rows past the history TTL are dead weight: bounded prune.
    db.prepare('DELETE FROM chat_cli_sessions WHERE rowid IN (SELECT rowid FROM chat_cli_sessions WHERE last_used < ? LIMIT ?)')
      .run(now - ttlMs(), PRUNE_BATCH);
    pruneCliSessionFiles(opts);
    return true;
  } catch (err) {
    console.error(`[ChatSessionHistory] recordCliSession failed: ${err.message}`);
    return false;
  }
}

function ttlMs() { return envInt('CHAT_SESSION_TURNS_TTL_DAYS', DEFAULT_TTL_DAYS) * 86400000; }

function tagCliSessionFile(db, orgId, identity, cliSessionId, now) {
  db.prepare(`INSERT INTO chat_cli_session_files (cli_session_id, org_id, identity, created_at, last_used)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(cli_session_id) DO UPDATE SET last_used = excluded.last_used`)
    .run(String(cliSessionId).slice(0, 80), String(orgId), String(identity), now, now);
}

/**
 * D2: tag a CLI session file with its org + user at write time (every CLI turn
 * that reported a session id, resumed or not, quox client or dashboard/voice).
 * Service callers without a user are '__svc__'. Returns true on durable write.
 */
function recordCliSessionFile({ orgId, userId, cliSessionId } = {}, opts = {}) {
  if (!orgId || typeof cliSessionId !== 'string' || !cliFiles.UUID_RE.test(cliSessionId)) return false;
  const db = resolveDb(opts.dbPath);
  if (!db) return false;
  try {
    tagCliSessionFile(db, orgId, identityOf(userId), cliSessionId, Date.now());
    return true;
  } catch (err) {
    console.error(`[ChatSessionHistory] recordCliSessionFile failed: ${err.message}`);
    return false;
  }
}

function listCliSessionFiles({ orgId, userId } = {}, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return [];
  try {
    if (orgId) return db.prepare('SELECT * FROM chat_cli_session_files WHERE org_id = ? ORDER BY created_at').all(String(orgId));
    if (userId) return db.prepare('SELECT * FROM chat_cli_session_files WHERE identity = ? ORDER BY created_at').all(String(userId));
    return [];
  } catch { return []; }
}

/** True when either table knows this CLI session id (the orphan sweep keeps those). */
function isKnownCliSession(cliSessionId, { dbPath } = {}) {
  const db = resolveDb(dbPath);
  if (!db) return true; // cannot tell: keep the file
  try {
    const id = String(cliSessionId);
    return !!(db.prepare('SELECT 1 FROM chat_cli_session_files WHERE cli_session_id = ?').get(id)
      || db.prepare('SELECT 1 FROM chat_cli_sessions WHERE cli_session_id = ? LIMIT 1').get(id));
  } catch { return true; }
}

/** Delete the files of these ids, then their ownership rows (only when the files went). */
function deleteOwnedFiles(db, ids, why, opts) {
  if (!ids.length) return cliFiles.deleteSessionFiles([], { root: projectsDirFor(opts) });
  const dryRun = !!(opts && opts.dryRun);
  const c = cliFiles.deleteSessionFiles(ids, { root: projectsDirFor(opts), dryRun });
  console.log(`[ChatSessionHistory] cli session files (${why}): ${ids.length} owned id(s), ${cliFiles.describeCounts(c)}`);
  if (!dryRun && !c.skipped && !c.errors) {
    const del = db.prepare('DELETE FROM chat_cli_session_files WHERE cli_session_id = ?');
    db.transaction((xs) => { for (const x of xs) del.run(x); })(ids);
  }
  return c;
}

/** D2 TTL prune: owned files idle past the history TTL go with their rows (bounded). */
function pruneCliSessionFiles(opts = {}) {
  const db = resolveDb(opts.dbPath);
  if (!db) return null;
  try {
    const ids = db.prepare('SELECT cli_session_id FROM chat_cli_session_files WHERE last_used < ? LIMIT ?')
      .all(Date.now() - ttlMs(), PRUNE_BATCH).map((r) => r.cli_session_id);
    if (!ids.length) return { files: 0, dirs: 0, bytes: 0 };
    return deleteOwnedFiles(db, ids, 'ttl prune', opts);
  } catch (err) {
    console.error(`[ChatSessionHistory] pruneCliSessionFiles failed: ${err.message}`);
    return null;
  }
}

function purgeCliFilesWhere(db, col, val, why, opts) {
  try {
    const ids = new Set(db.prepare(`SELECT cli_session_id FROM chat_cli_session_files WHERE ${col} = ?`).all(val).map((r) => r.cli_session_id));
    for (const r of db.prepare(`SELECT cli_session_id FROM chat_cli_sessions WHERE ${col} = ?`).all(val)) ids.add(r.cli_session_id);
    return deleteOwnedFiles(db, Array.from(ids), why, opts);
  } catch (err) {
    console.error(`[ChatSessionHistory] ${why} cli session files failed: ${err.message}`);
    return null;
  }
}

/** GDPR erasure: remove every turn a user created (all orgs). Returns rows deleted. */
function purgeUser(userId, opts = {}) {
  const { dbPath } = opts;
  if (!userId) return 0;
  const db = resolveDb(dbPath);
  if (!db) return 0;
  purgeCliFilesWhere(db, 'identity', String(userId), 'purgeUser', opts);
  try { db.prepare('DELETE FROM chat_cli_sessions WHERE identity = ?').run(String(userId)); } catch (err) { console.error(`[ChatSessionHistory] purgeUser cli sessions failed: ${err.message}`); }
  try { return db.prepare('DELETE FROM chat_session_turns WHERE identity = ?').run(String(userId)).changes; }
  catch (err) { console.error(`[ChatSessionHistory] purgeUser failed: ${err.message}`); return 0; }
}

/** Org erasure: remove every turn in an org. Returns rows deleted. */
function purgeOrg(orgId, opts = {}) {
  const { dbPath } = opts;
  if (!orgId) return 0;
  const db = resolveDb(dbPath);
  if (!db) return 0;
  purgeCliFilesWhere(db, 'org_id', String(orgId), 'purgeOrg', opts);
  try { db.prepare('DELETE FROM chat_cli_sessions WHERE org_id = ?').run(String(orgId)); } catch (err) { console.error(`[ChatSessionHistory] purgeOrg cli sessions failed: ${err.message}`); }
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

function _resetCliSessionsForTest(dbPath) {
  const db = _connections.get(dbPath || DEFAULT_DB_PATH) || resolveDb(dbPath);
  if (db) { try { db.exec('DELETE FROM chat_cli_sessions; DELETE FROM chat_cli_session_files;'); } catch { /* ignore */ } }
}

function _backdateCliFilesForTest(dbPath, ms) {
  const db = _connections.get(dbPath || DEFAULT_DB_PATH);
  if (db) db.prepare('UPDATE chat_cli_session_files SET last_used = last_used - ?').run(ms);
}

module.exports = {
  recordExchange, hydrateHistory, listSessions, listMessages, lastMessageId, lastTurnAt, getCliSession, recordCliSession, purgeUser, purgeOrg,
  compactionSource, storeSummary, conversationStats, resetCliSessions, SUMMARY_PREFIX, MAX_SUMMARY_CHARS,
  setCliProjectsDir, recordCliSessionFile, listCliSessionFiles, isKnownCliSession, pruneCliSessionFiles,
  _resetForTest, _backdateForTest, _rawRowsForTest, _resetCliSessionsForTest, _backdateCliFilesForTest,
};
