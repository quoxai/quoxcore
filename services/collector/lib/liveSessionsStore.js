'use strict';

/**
 * liveSessionsStore.js - DEVSUITE phase 19: server-side, org-scoped register
 * of live working sessions (migrations/aee/041-live-sessions.sql).
 *
 * Hosts POST their full session list; reportSessions upserts each row and
 * deletes that host's rows missing from the report. Everything runs
 * synchronously on the collector event loop, so every query carries org_id,
 * uses the (org_id, last_seen_at) index or the primary key, and is LIMITed.
 * Plain functions taking the db handle first (clock injectable via opts.now).
 */

const MAX_PER_REPORT = 50;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const cap = (v, n) => (v == null ? null : String(v).slice(0, n));
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

function reportSessions(db, { orgId, host, sessions, now = () => Date.now() } = {}) {
    if (!db) throw new Error('db required');
    if (!orgId) throw new Error('orgId required');
    if (!host) throw new Error('host required');
    const list = (Array.isArray(sessions) ? sessions : []).slice(0, MAX_PER_REPORT);
    const nowMs = now();
    const stamp = new Date(nowMs).toISOString();
    const h = db;
    const upsert = h.prepare(`INSERT INTO live_sessions
      (org_id, host, name, program, tmux, attached, slot, agent, splinter, stream, pid, started_at, last_seen_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, host, name) DO UPDATE SET
        program=excluded.program, tmux=excluded.tmux, attached=excluded.attached, slot=excluded.slot,
        agent=excluded.agent, splinter=excluded.splinter, stream=excluded.stream, pid=excluded.pid,
        started_at=excluded.started_at, last_seen_at=excluded.last_seen_at, meta=excluded.meta`);
    const existing = h.prepare('SELECT name FROM live_sessions WHERE org_id = ? AND host = ? LIMIT 1000');
    const del = h.prepare('DELETE FROM live_sessions WHERE org_id = ? AND host = ? AND name = ?');
    const prune = h.prepare(`DELETE FROM live_sessions WHERE rowid IN (
      SELECT rowid FROM live_sessions WHERE org_id = ? AND last_seen_at < ? LIMIT ${PRUNE_BATCH})`);
    let upserted = 0;
    let ended = 0;
    let pruned = 0;
    h.transaction(() => {
      const keep = new Set();
      for (const s of list) {
        const name = cap(s && s.name, 128);
        if (!name) continue;
        keep.add(name);
        const pid = Number.isInteger(s.pid) ? s.pid : null;
        let meta = null;
        if (s.meta && typeof s.meta === 'object') {
          const j = JSON.stringify(s.meta);
          meta = j.length <= 2048 ? j : null;
        }
        upsert.run(orgId, host, name, cap(s.program, 64), flag(s.tmux), flag(s.attached),
          cap(s.slot, 64), cap(s.agent, 128), cap(s.splinter, 128), cap(s.stream, 64),
          pid, cap(s.started_at, 40), stamp, meta);
        upserted += 1;
      }
      for (const r of existing.all(orgId, host)) {
        if (!keep.has(r.name)) ended += del.run(orgId, host, r.name).changes;
      }
      pruned = prune.run(orgId, new Date(nowMs - PRUNE_AFTER_MS).toISOString()).changes;
    })();
    return { upserted, ended, pruned };
  }

function listSessions(db, { orgId, staleAfterMs = DEFAULT_STALE_MS, limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
    if (!orgId) throw new Error('orgId required');
    const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const cutoff = now() - staleAfterMs;
    const rows = db.prepare(
      'SELECT * FROM live_sessions WHERE org_id = ? ORDER BY last_seen_at DESC LIMIT ?',
    ).all(orgId, lim);
    return rows.map((r) => {
      let meta = null;
      try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { meta = null; }
      return {
        ...r, tmux: !!r.tmux, attached: !!r.attached, meta,
        live: Date.parse(r.last_seen_at) >= cutoff,
      };
    });
  }

/**
 * Strict body validation for POST /api/v1/live-sessions/report. Returns
 * { ok:true, host, sessions } or { ok:false, error }.
 */
function validateReportBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  if (typeof body.host !== 'string' || !body.host.trim() || body.host.length > 128) {
    return { ok: false, error: 'host must be a non-empty string up to 128 chars' };
  }
  if (!Array.isArray(body.sessions)) return { ok: false, error: 'sessions must be an array' };
  if (body.sessions.length > MAX_PER_REPORT) return { ok: false, error: `sessions capped at ${MAX_PER_REPORT} per report` };
  const strFields = { name: 128, program: 64, slot: 64, agent: 128, splinter: 128, stream: 64, started_at: 40 };
  const sessions = [];
  for (const s of body.sessions) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'each session must be an object' };
    if (typeof s.name !== 'string' || !s.name.trim()) return { ok: false, error: 'each session needs a name' };
    const out = { tmux: flag(s.tmux) === 1, attached: flag(s.attached) === 1 };
    for (const [k, max] of Object.entries(strFields)) {
      if (s[k] == null) continue;
      if (typeof s[k] !== 'string' || s[k].length > max) return { ok: false, error: `${k} must be a string up to ${max} chars` };
      out[k] = s[k];
    }
    if (s.pid != null) {
      if (!Number.isInteger(s.pid) || s.pid < 0) return { ok: false, error: 'pid must be a non-negative integer' };
      out.pid = s.pid;
    }
    if (s.meta != null) {
      if (typeof s.meta !== 'object' || Array.isArray(s.meta)) return { ok: false, error: 'meta must be an object' };
      out.meta = s.meta;
    }
    sessions.push(out);
  }
  return { ok: true, host: body.host.trim(), sessions };
}

module.exports = { reportSessions, listSessions, validateReportBody, MAX_PER_REPORT, PRUNE_AFTER_MS };
