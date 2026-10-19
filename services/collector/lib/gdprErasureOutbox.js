/**
 * gdprErasureOutbox.js: durable retry for account erasure legs that failed
 * (FND_01M4HZQ5P004YSXH0BWY04YSXH follow-up). The collector purges its own
 * envelopes at once, so the brain conversation relPaths are stored here: by
 * retry time nothing else remembers them. Loop triad: failures are counted
 * apart from empty ticks, backoff is exponential (capped), and a row that keeps
 * failing is RETIRED loudly (kept, flagged, listed), never dropped.
 */
'use strict';

const MAX_ATTEMPTS = 20;
const BASE_MS = 60_000;
const CAP_MS = 6 * 3600_000;

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS gdpr_erasure_outbox (
    user_id TEXT PRIMARY KEY,
    conversations TEXT NOT NULL DEFAULT '[]',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    retired_at TEXT
  )`);
}

function mergeConversations(a = [], b = []) {
  const byOrg = new Map();
  for (const c of [...a, ...b]) {
    if (!c || typeof c.orgId !== 'string') continue;
    const set = byOrg.get(c.orgId) || new Set();
    for (const p of Array.isArray(c.relPaths) ? c.relPaths : []) if (typeof p === 'string') set.add(p);
    byOrg.set(c.orgId, set);
  }
  return [...byOrg].map(([orgId, s]) => ({ orgId, relPaths: [...s] }));
}

function backoffMs(attempts) { return Math.min(BASE_MS * 2 ** Math.max(0, attempts), CAP_MS); }

/** Queue (or re-arm) a user's erasure. First retry is due after BASE_MS. */
function enqueue(db, userId, conversations = [], error = null, now = Date.now()) {
  const prev = db.prepare('SELECT conversations FROM gdpr_erasure_outbox WHERE user_id = ?').get(userId);
  const merged = mergeConversations(prev ? JSON.parse(prev.conversations) : [], conversations);
  db.prepare(`INSERT INTO gdpr_erasure_outbox (user_id, conversations, attempts, next_attempt_at, last_error, created_at, retired_at)
    VALUES (?, ?, 0, ?, ?, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET conversations = excluded.conversations, attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error, retired_at = NULL`)
    .run(userId, JSON.stringify(merged), now + BASE_MS, error, new Date(now).toISOString());
}

function legErrors(out) {
  return ['memory', 'brain', 'tasks'].filter((k) => out?.[k] && !out[k].ok).map((k) => `${k}: ${out[k].error || 'failed'}`).join('; ') || 'incomplete';
}

/** One pass over due rows. Returns {due, drained, failed, retired}. */
async function drainTick(db, { runCascade, now = Date.now(), batch = 20 } = {}) {
  const res = { due: 0, drained: 0, failed: 0, retired: 0 };
  const due = db.prepare('SELECT * FROM gdpr_erasure_outbox WHERE retired_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?').all(now, batch);
  res.due = due.length;
  for (const row of due) {
    let out;
    try { out = await runCascade(row.user_id, { conversations: JSON.parse(row.conversations) }); } catch (err) { out = { complete: false, memory: { ok: false, error: err.message } }; }
    if (out && out.complete) {
      db.prepare('DELETE FROM gdpr_erasure_outbox WHERE user_id = ?').run(row.user_id);
      res.drained++;
      continue;
    }
    const attempts = row.attempts + 1;
    const err = legErrors(out);
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare('UPDATE gdpr_erasure_outbox SET attempts = ?, last_error = ?, retired_at = ? WHERE user_id = ?').run(attempts, err, new Date(now).toISOString(), row.user_id);
      console.error(`[GDPR] erasure for user ${row.user_id} RETIRED after ${attempts} attempts (${err}); needs an operator`);
      res.retired++;
    } else {
      db.prepare('UPDATE gdpr_erasure_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE user_id = ?').run(attempts, err, now + backoffMs(attempts), row.user_id);
      res.failed++;
    }
  }
  return res;
}

function listRetired(db) {
  return db.prepare('SELECT user_id, attempts, last_error, retired_at FROM gdpr_erasure_outbox WHERE retired_at IS NOT NULL').all();
}

module.exports = { ensureTable, enqueue, drainTick, listRetired, mergeConversations, MAX_ATTEMPTS };
