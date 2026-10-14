'use strict';
/**
 * QUOXON C5 (events contract v1.1, docs/QUOXON_EVENTS_v1_1.md): the per-turn
 * event log behind durable turns.
 *
 * Every SSE event of a /chat/stream turn is stamped with a monotonically
 * increasing `seq` (1, 2, 3, ...) and appended here, so a client that lost its
 * connection can replay `?after=<seq>` and then follow the turn live.
 *
 * TENANCY: a log is addressable only after `bind()` with the org and user from
 * the verified claim (the same identity the turn registry uses). Lookup by
 * another org, user or conversation answers `foreign`, which the route turns
 * into a 404 identical to "no such turn". An unbound log (a service caller with
 * no user) is never addressable and keeps only a tiny buffer.
 *
 * BOUNDS (Loop Hygiene): per turn, events and bytes are capped and the OLDEST
 * events are dropped first (the newest, including turn.finished, always stay;
 * a replay that falls into the dropped range is told so with a gap). Globally,
 * the number of logs and total bytes are capped (oldest finished evicted
 * first). Finished logs expire after `ttlMs` (default 30 min) and leave a
 * tombstone so a late reattach gets 410 instead of 404.
 *
 * PERSISTENCE: when a better-sqlite3 handle is given, events are written in
 * batched transactions (never one write per event on the hot path), sealed at
 * rest with `seal` (AES-GCM via lib/encryption.js by default). Flush failures
 * are counted distinctly (`flushFailures`, `lastFlushError`), retried with a
 * capped backoff, and the pending queue is bounded (oldest rows retired and
 * counted in `droppedPendingRows`), so a broken store can never grow memory or
 * spin. On start, logs left `running` by a previous process are marked `lost`;
 * replaying one ends with an honest `turn.finished` status `failed`, reason
 * `server_restarted`. An org with transcript storage disabled
 * (`persistAllowed(orgId) === false`) is kept in memory only.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turn_event_logs (
  org_id TEXT NOT NULL, turn_id TEXT NOT NULL, user_id TEXT NOT NULL, conversation_id TEXT,
  status TEXT NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  PRIMARY KEY (org_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_event_logs_turn ON turn_event_logs(turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_event_logs_finished ON turn_event_logs(status, finished_at);
CREATE TABLE IF NOT EXISTS turn_events (
  org_id TEXT NOT NULL, turn_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (org_id, turn_id, seq)
);
`;

const UNBOUND_MAX_EVENTS = 50;

function defaultSeal() {
  const { encrypt, decrypt } = require('./encryption.js');
  return { seal: encrypt, open: decrypt };
}

function createTurnEventLog({
  db = null,
  now = () => Date.now(),
  ttlMs = 30 * 60 * 1000,
  tombstoneTtlMs = 24 * 60 * 60 * 1000,
  maxEventsPerTurn = 5000,
  maxBytesPerTurn = 1024 * 1024,
  maxTurns = 500,
  maxTotalBytes = 64 * 1024 * 1024,
  maxTombstones = 20000,
  maxPendingRows = 20000,
  flushMs = 250,
  maxFlushBackoffMs = 30000,
  dbPruneEveryMs = 60 * 1000,
  memPruneEveryMs = 5 * 1000,
  persistAllowed = () => true,
  seal,
  open,
  logger = console,
} = {}) {
  if (db && (!seal || !open)) { const d = defaultSeal(); seal = seal || d.seal; open = open || d.open; }
  const logs = new Map(); // key -> log (bound only, insertion ordered)
  const tombstones = new Map(); // key -> { orgId, userId, conversationId, turnId, at }
  let totalBytes = 0;
  let pending = []; // { orgId, turnId, seq, json }
  const dirty = new Set(); // logs whose meta row needs an upsert
  let timer = null;
  let failStreak = 0;
  let lastWarnAt = 0;
  let lastDbPrune = 0;
  let lastMemPrune = 0;
  let dbPruneDue = false;
  let dbOk = Boolean(db);
  const stats = { appended: 0, droppedEvents: 0, evictedLogs: 0, expiredLogs: 0, flushes: 0, flushFailures: 0, lastFlushError: null, droppedPendingRows: 0, sealFailures: 0, openFailures: 0 };

  const keyOf = (orgId, turnId) => `${orgId}\u0000${turnId}`;

  if (db) {
    try {
      db.exec(SCHEMA);
      db.prepare("UPDATE turn_event_logs SET status = 'lost', finished_at = ? WHERE status = 'running'").run(now());
    } catch (e) {
      dbOk = false;
      stats.lastFlushError = `init: ${e.message}`;
      logger.error(`[TurnEventLog] sqlite init failed (${e.message}); durable turn events are memory-only`);
    }
  }

  function ownerMatches(o, { userId, conversationId }) {
    if (o.userId !== userId) return false;
    return !o.conversationId || !conversationId || o.conversationId === conversationId;
  }

  // ---- write path ------------------------------------------------------------------------------
  function open_({ turnId, conversationId = null }) {
    return { key: null, orgId: null, userId: null, turnId, conversationId, status: 'running', events: [], firstSeq: 1, lastSeq: 0, bytes: 0, startedAt: now(), finishedAt: null, subs: new Set(), persist: false, persisted: false, lost: false };
  }

  function dropOldest(log) {
    const e = log.events.shift();
    if (!e) return;
    log.bytes -= e.bytes;
    if (log.key) totalBytes -= e.bytes;
    log.firstSeq = log.events.length ? log.events[0].ev.seq : log.lastSeq + 1;
    stats.droppedEvents++;
    if (log.persist) dirty.add(log);
  }

  function append(log, event) {
    const seq = ++log.lastSeq;
    const ev = { ...event, seq };
    const json = JSON.stringify(ev);
    const bytes = Buffer.byteLength(json);
    log.events.push({ ev, json, bytes });
    log.bytes += bytes;
    if (log.key) totalBytes += bytes;
    stats.appended++;
    const maxEvents = log.key ? maxEventsPerTurn : UNBOUND_MAX_EVENTS;
    while (log.events.length > maxEvents || (log.bytes > maxBytesPerTurn && log.events.length > 1)) dropOldest(log);
    if (log.events.length === 1) log.firstSeq = seq;
    if (log.persist) { pending.push({ orgId: log.orgId, turnId: log.turnId, seq, json }); boundPending(); dirty.add(log); scheduleFlush(); }
    for (const fn of log.subs) { try { fn(ev); } catch { /* a broken subscriber never breaks the turn */ } }
    if (log.key) enforceGlobal(log);
    return ev;
  }

  function bind(log, { orgId, userId }) {
    if (!log || log.key || !orgId || !userId) return false;
    sweep();
    log.orgId = orgId; log.userId = userId; log.key = keyOf(orgId, log.turnId);
    logs.delete(log.key);
    logs.set(log.key, log);
    tombstones.delete(log.key);
    totalBytes += log.bytes;
    let allowed = true;
    try { allowed = persistAllowed(orgId) !== false; } catch { allowed = false; }
    log.persist = dbOk && allowed;
    if (log.persist) {
      log.persisted = true;
      for (const e of log.events) pending.push({ orgId, turnId: log.turnId, seq: e.ev.seq, json: e.json });
      boundPending();
      dirty.add(log);
      scheduleFlush();
    }
    enforceGlobal(log);
    return true;
  }

  function finish(log) {
    if (!log || log.status === 'finished') return;
    log.status = 'finished';
    log.finishedAt = now();
    if (log.persist) { dirty.add(log); scheduleFlush(); }
    const subs = [...log.subs];
    log.subs.clear();
    for (const fn of subs) { try { fn(null); } catch { /* ignore */ } }
  }

  function subscribe(log, fn) {
    if (!log || log.status === 'finished') { try { fn(null); } catch { /* ignore */ } return () => {}; }
    log.subs.add(fn);
    return () => log.subs.delete(fn);
  }

  // ---- bounds and expiry -----------------------------------------------------------------------
  function tombstone(log, at = now()) {
    tombstones.delete(log.key);
    tombstones.set(log.key, { orgId: log.orgId, userId: log.userId, conversationId: log.conversationId, turnId: log.turnId, at });
    while (tombstones.size > maxTombstones) tombstones.delete(tombstones.keys().next().value);
  }

  function evict(log, { expired }) {
    logs.delete(log.key);
    totalBytes -= log.bytes;
    // A log still within its TTL and safely in sqlite stays reachable there; otherwise it is gone (410).
    if (expired || !log.persisted || !dbOk) tombstone(log);
    if (expired) { stats.expiredLogs++; if (log.persisted) dbPruneDue = true; } else stats.evictedLogs++;
    for (const fn of log.subs) { try { fn(null); } catch { /* ignore */ } }
    log.subs.clear();
  }

  function enforceGlobal(keep) {
    if (logs.size <= maxTurns && totalBytes <= maxTotalBytes) return;
    for (const log of [...logs.values()]) {
      if (logs.size <= maxTurns && totalBytes <= maxTotalBytes) return;
      if (log.status === 'finished' && log !== keep) evict(log, { expired: false });
    }
    // Only running logs left over the byte cap: trim the oldest events of the oldest running logs.
    for (const log of logs.values()) {
      while (totalBytes > maxTotalBytes && log.events.length > 1) dropOldest(log);
      if (totalBytes <= maxTotalBytes) return;
    }
  }

  function sweep(force = false) {
    const t = now();
    if (!force && t - lastMemPrune < memPruneEveryMs) return;
    lastMemPrune = t;
    for (const log of [...logs.values()]) {
      if (log.status === 'finished' && t - log.finishedAt > ttlMs) evict(log, { expired: true });
    }
    for (const [k, s] of tombstones) { if (t - s.at > tombstoneTtlMs) tombstones.delete(k); else break; }
  }

  function prune() { sweep(true); if (dbOk) dbPruneDue = true; }

  // ---- sqlite ----------------------------------------------------------------------------------
  function boundPending() {
    if (pending.length > maxPendingRows) {
      const n = pending.length - maxPendingRows;
      pending = pending.slice(n);
      stats.droppedPendingRows += n;
    }
  }

  function scheduleFlush(delay = flushMs) {
    if (!dbOk || timer || flushMs <= 0) return;
    timer = setTimeout(() => { timer = null; flush(); }, delay);
    if (timer.unref) timer.unref();
  }

  function flush() {
    if (!dbOk) return;
    const t = now();
    const doPrune = dbPruneDue || t - lastDbPrune > dbPruneEveryMs;
    if (!pending.length && !dirty.size && !doPrune) return;
    const batch = pending;
    const metas = [...dirty];
    try {
      const ins = db.prepare('INSERT OR IGNORE INTO turn_events (org_id, turn_id, seq, data) VALUES (?, ?, ?, ?)');
      const up = db.prepare(`INSERT INTO turn_event_logs (org_id, turn_id, user_id, conversation_id, status, first_seq, last_seq, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id, turn_id) DO UPDATE SET status = excluded.status, first_seq = excluded.first_seq, last_seq = excluded.last_seq, finished_at = excluded.finished_at`);
      const delOld = db.prepare('DELETE FROM turn_events WHERE org_id = ? AND turn_id = ? AND seq < ?');
      db.transaction(() => {
        for (const r of batch) {
          let sealed;
          try { sealed = seal(r.json); } catch { stats.sealFailures++; continue; } // never store plaintext
          ins.run(r.orgId, r.turnId, r.seq, sealed);
        }
        for (const log of metas) {
          up.run(log.orgId, log.turnId, log.userId, log.conversationId, log.status, log.firstSeq, log.lastSeq, log.startedAt, log.finishedAt);
          delOld.run(log.orgId, log.turnId, log.firstSeq);
        }
        if (doPrune) {
          const cutoff = t - ttlMs;
          const old = db.prepare("SELECT org_id, turn_id FROM turn_event_logs WHERE status IN ('finished', 'lost') AND finished_at < ?").all(cutoff);
          const delAll = db.prepare('DELETE FROM turn_events WHERE org_id = ? AND turn_id = ?');
          const mark = db.prepare("UPDATE turn_event_logs SET status = 'expired' WHERE org_id = ? AND turn_id = ?");
          for (const r of old) {
            // A log this process is still serving from memory is expired by the memory sweep, not here.
            const live = logs.get(keyOf(r.org_id, r.turn_id));
            if (live && !(live.status === 'finished' && t - live.finishedAt > ttlMs)) continue;
            delAll.run(r.org_id, r.turn_id); mark.run(r.org_id, r.turn_id);
          }
          db.prepare("DELETE FROM turn_event_logs WHERE status = 'expired' AND finished_at < ?").run(t - tombstoneTtlMs);
        }
      })();
      pending = pending.slice(batch.length);
      for (const log of metas) dirty.delete(log);
      if (doPrune) { lastDbPrune = t; dbPruneDue = false; }
      stats.flushes++;
      failStreak = 0;
      if (pending.length || dirty.size) scheduleFlush();
    } catch (e) {
      stats.flushFailures++;
      stats.lastFlushError = String(e && e.message || e).slice(0, 200);
      failStreak++;
      boundPending();
      if (t - lastWarnAt > 60000) { lastWarnAt = t; logger.warn(`[TurnEventLog] flush failed (${stats.lastFlushError}); ${pending.length} rows pending, ${stats.flushFailures} failures so far`); }
      scheduleFlush(Math.min(Math.max(flushMs, 1) * 2 ** failStreak, maxFlushBackoffMs));
    }
  }

  function hydrate(row) {
    const log = open_({ turnId: row.turn_id, conversationId: row.conversation_id });
    log.orgId = row.org_id; log.userId = row.user_id; log.key = keyOf(row.org_id, row.turn_id);
    log.status = 'finished'; log.persisted = true; log.lost = row.status === 'lost';
    log.startedAt = row.started_at; log.finishedAt = row.finished_at || now();
    const rows = db.prepare('SELECT seq, data FROM turn_events WHERE org_id = ? AND turn_id = ? AND seq >= ? ORDER BY seq').all(row.org_id, row.turn_id, row.first_seq);
    for (const r of rows) {
      let json;
      try { json = open(r.data); } catch { stats.openFailures++; continue; } // undecryptable: skip, never leak ciphertext
      let ev;
      try { ev = JSON.parse(json); } catch { stats.openFailures++; continue; }
      const bytes = Buffer.byteLength(json);
      log.events.push({ ev, json, bytes }); log.bytes += bytes;
    }
    log.lastSeq = row.last_seq;
    log.firstSeq = log.events.length ? log.events[0].ev.seq : row.last_seq + 1;
    const last = log.events[log.events.length - 1];
    if (log.lost && !(last && last.ev.type === 'turn.finished')) {
      // Honest terminal event for a turn the previous process never finished. Deterministic seq.
      const ev = { type: 'turn.finished', turn_id: row.turn_id, ts: new Date(log.finishedAt).toISOString(), status: 'failed', reason: 'server_restarted', conversation_id: row.conversation_id, seq: row.last_seq + 1 };
      const json = JSON.stringify(ev);
      log.events.push({ ev, json, bytes: Buffer.byteLength(json) });
      log.lastSeq = ev.seq;
    }
    logs.set(log.key, log);
    totalBytes += log.bytes;
    enforceGlobal(log);
    return log;
  }

  // ---- read path -------------------------------------------------------------------------------
  /** @returns {{state:'running'|'finished'|'expired'|'foreign'|'none', log?:object}} */
  function lookup({ orgId, userId, conversationId = null, turnId }) {
    if (!orgId || !userId || !turnId) return { state: 'none' };
    sweep();
    const key = keyOf(orgId, turnId);
    const who = { userId, conversationId };
    const log = logs.get(key);
    if (log) {
      if (!ownerMatches(log, who)) return { state: 'foreign' };
      if (log.status === 'finished' && now() - log.finishedAt > ttlMs) { evict(log, { expired: true }); return { state: 'expired' }; }
      return { state: log.status, log };
    }
    const tomb = tombstones.get(key);
    if (tomb) return ownerMatches(tomb, who) ? { state: 'expired' } : { state: 'foreign' };
    if (dbOk) {
      try {
        const row = db.prepare('SELECT * FROM turn_event_logs WHERE org_id = ? AND turn_id = ?').get(orgId, turnId);
        if (row) {
          if (!ownerMatches({ userId: row.user_id, conversationId: row.conversation_id }, who)) return { state: 'foreign' };
          if (row.status === 'expired' || (row.finished_at && now() - row.finished_at > ttlMs)) return { state: 'expired' };
          if (row.status === 'running') return { state: 'expired' }; // running in another process: not servable here
          return { state: 'finished', log: hydrate(row) };
        }
      } catch (e) { stats.lastFlushError = `read: ${String(e.message).slice(0, 180)}`; }
    }
    for (const l of logs.values()) if (l.turnId === turnId) return { state: 'foreign' };
    for (const s of tombstones.values()) if (s.turnId === turnId) return { state: 'foreign' };
    if (dbOk) {
      try { if (db.prepare('SELECT 1 FROM turn_event_logs WHERE turn_id = ? LIMIT 1').get(turnId)) return { state: 'foreign' }; } catch { /* treat as none */ }
    }
    return { state: 'none' };
  }

  /** Buffered events with seq > after; `gap` names a range that was dropped by the caps. */
  function eventsAfter(log, after = 0) {
    const a = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
    const events = [];
    for (const e of log.events) if (e.ev.seq > a) events.push(e.ev);
    const gap = a < log.firstSeq - 1 ? { from: a + 1, to: log.firstSeq - 1 } : null;
    return { events, gap };
  }

  function close() {
    if (timer) { clearTimeout(timer); timer = null; }
    try { flush(); } catch { /* best effort */ }
    dbOk = false;
  }

  return {
    open: open_, bind, append, finish, subscribe, lookup, eventsAfter, flush, prune, close,
    lastSeq: (log) => (log ? log.lastSeq : null),
    stats: () => ({ ...stats, logs: logs.size, tombstones: tombstones.size, totalBytes, pendingRows: pending.length, persistent: dbOk }),
  };
}

/** Production store: a small sqlite file next to the chat-session-turns DB. Memory-only on failure. */
function openTurnEventDb(dbPath = process.env.TURN_EVENTS_DB_PATH || '/var/lib/quox/turn-events.db') {
  try {
    const Database = require('better-sqlite3');
    const { existsSync, mkdirSync } = require('fs');
    const { dirname } = require('path');
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    return db;
  } catch (e) {
    console.error(`[TurnEventLog] cannot open ${dbPath} (${e.message}); durable turn events are memory-only`);
    return null;
  }
}

module.exports = { createTurnEventLog, openTurnEventDb };
