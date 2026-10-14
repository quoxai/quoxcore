'use strict';

/**
 * sessionsIndex.js - QUOXON J1: one org-scoped index of everything live on
 * this server (tmux-wrapped Claude/Codex sessions, the caller's quox
 * conversations, held slots, running objectives/loops/workflows; residents are
 * a declared placeholder source).
 *
 * Storage: tmux sessions reuse the live_sessions table (migration 041). The
 * `quox claude` wrapper heartbeats ONE row at a time (heartbeatSession), so,
 * unlike the host-wide report, a beat never deletes sibling rows. A wrapper row
 * carries meta.source='wrapper' and meta.interval_s; it expires after
 * MISSED_BEATS missed beats. Rows written by the host-wide report (the
 * one-shot backfill, `quox sessions report`) keep the report's 15 min window.
 *
 * Everything else is pure: buildIndex takes already-fetched source rows and a
 * clock and returns { rows, groups, counts, sources }.
 */

const MISSED_BEATS = 3;
const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 15;
const MAX_INTERVAL_S = 600;
const REPORT_STALE_MS = 15 * 60 * 1000;
const WORKING_MS = 2 * 60 * 1000;
const CONVERSATION_WINDOW_MS = 24 * 3600 * 1000;
const FAILED_FRESH_MS = 10 * 60 * 1000;
const PENDING_FRESH_MS = 24 * 3600 * 1000;
const LIST_LIMIT = 500;
const PREFIX = 'quox-';
const TAGS = ['codex', 'gemini', 'tui'];

const cap = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Epoch ms, ISO, or SQLite "YYYY-MM-DD HH:MM:SS" (UTC, no zone) -> ms or null. */
function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v);
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isFinite(t) ? t : null;
}
const isoOf = (ms) => (ms == null ? null : new Date(ms).toISOString());

// ---------------------------------------------------------------- storage

function validateHeartbeatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  if (typeof body.host !== 'string' || !body.host.trim() || body.host.length > 128) {
    return { ok: false, error: 'host must be a non-empty string up to 128 chars' };
  }
  const s = body.session;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'session must be an object' };
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 128) return { ok: false, error: 'session.name must be a non-empty string up to 128 chars' };
  const out = { name: s.name.trim(), attached: s.attached === true };
  for (const [k, max] of Object.entries({ program: 64, slot: 64, agent: 128, started_at: 40 })) {
    if (s[k] == null) continue;
    if (typeof s[k] !== 'string' || s[k].length > max) return { ok: false, error: `session.${k} must be a string up to ${max} chars` };
    out[k] = s[k];
  }
  if (s.pid != null) {
    if (!Number.isInteger(s.pid) || s.pid < 0) return { ok: false, error: 'session.pid must be a non-negative integer' };
    out.pid = s.pid;
  }
  const iv = s.interval_s == null ? DEFAULT_INTERVAL_S : s.interval_s;
  if (!Number.isInteger(iv) || iv < MIN_INTERVAL_S || iv > MAX_INTERVAL_S) {
    return { ok: false, error: `session.interval_s must be an integer ${MIN_INTERVAL_S}-${MAX_INTERVAL_S}` };
  }
  out.interval_s = iv;
  if (s.last_active != null) {
    if (typeof s.last_active !== 'string' || parseTime(s.last_active) == null) return { ok: false, error: 'session.last_active must be an ISO timestamp' };
    out.last_active = new Date(parseTime(s.last_active)).toISOString();
  }
  return { ok: true, host: body.host.trim(), session: out };
}

/** Upsert ONE wrapper session; never deletes other rows (the report path does that). */
function heartbeatSession(db, { orgId, host, session, now = () => Date.now() } = {}) {
  if (!db) throw new Error('db required');
  if (!orgId) throw new Error('orgId required');
  if (!host) throw new Error('host required');
  if (!session || !session.name) throw new Error('session.name required');
  const stamp = new Date(now()).toISOString();
  const meta = JSON.stringify({
    source: 'wrapper',
    interval_s: session.interval_s || DEFAULT_INTERVAL_S,
    last_active: session.last_active || null,
  });
  db.prepare(`INSERT INTO live_sessions
    (org_id, host, name, program, tmux, attached, slot, agent, splinter, stream, pid, started_at, last_seen_at, meta)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    ON CONFLICT(org_id, host, name) DO UPDATE SET
      program=excluded.program, tmux=1, attached=excluded.attached, slot=excluded.slot, agent=excluded.agent,
      pid=excluded.pid, started_at=COALESCE(excluded.started_at, live_sessions.started_at),
      last_seen_at=excluded.last_seen_at, meta=excluded.meta`)
    .run(orgId, host, cap(session.name, 128), cap(session.program, 64), session.attached ? 1 : 0,
      cap(session.slot, 64), cap(session.agent, 128), Number.isInteger(session.pid) ? session.pid : null,
      cap(session.started_at, 40), stamp, meta);
  return { ok: true, last_seen_at: stamp };
}

function endSession(db, { orgId, host, name } = {}) {
  if (!orgId || !host || !name) throw new Error('orgId, host and name required');
  return { ended: db.prepare('DELETE FROM live_sessions WHERE org_id = ? AND host = ? AND name = ?').run(orgId, host, name).changes };
}

function parseMeta(m) {
  if (!m) return null;
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch { return null; }
}

function isWrapper(meta) { return !!(meta && meta.source === 'wrapper'); }
function intervalMs(meta) {
  const iv = meta && Number.isInteger(meta.interval_s) ? meta.interval_s : DEFAULT_INTERVAL_S;
  return iv * 1000;
}

/** True when the row is past its expiry (3 missed beats for wrapper rows, 15 min for report rows). */
function isExpired(row, nowMs) {
  const seen = parseTime(row.last_seen_at);
  if (seen == null) return true;
  const meta = parseMeta(row.meta);
  const window = isWrapper(meta) ? MISSED_BEATS * intervalMs(meta) : REPORT_STALE_MS;
  return nowMs - seen > window;
}

/** Live (unexpired) tmux rows for one org, newest first. Org-indexed and LIMITed. */
function listLiveRows(db, { orgId, now = () => Date.now(), limit = LIST_LIMIT } = {}) {
  if (!orgId) throw new Error('orgId required');
  const nowMs = now();
  const rows = db.prepare('SELECT * FROM live_sessions WHERE org_id = ? ORDER BY last_seen_at DESC LIMIT ?')
    .all(orgId, Math.max(1, Math.min(LIST_LIMIT, Number(limit) || LIST_LIMIT)));
  return rows
    .map((r) => ({ ...r, tmux: !!r.tmux, attached: !!r.attached, meta: parseMeta(r.meta) }))
    .filter((r) => !isExpired(r, nowMs));
}

// ---------------------------------------------------------------- mapping

function backendOf(bare, program) {
  for (const t of TAGS) if (bare.startsWith(`${t}-`)) return t;
  const m = /^run-([^-]+)-/.exec(bare);
  if (m) return m[1];
  return program || null;
}

function activityState(lastActiveMs, nowMs) {
  return lastActiveMs != null && nowMs - lastActiveMs <= WORKING_MS ? 'working' : 'resting';
}

function fromLiveRow(r, nowMs) {
  const meta = r.meta || {};
  const prefixed = r.name.startsWith(PREFIX) && r.name.length > PREFIX.length;
  const bare = prefixed ? r.name.slice(PREFIX.length) : r.name;
  const lastActive = parseTime(meta.last_active);
  let state = activityState(lastActive, nowMs);
  const seen = parseTime(r.last_seen_at);
  if (isWrapper(meta) && seen != null && nowMs - seen > 1.5 * intervalMs(meta)) state = 'failing';
  return {
    kind: 'tmux',
    id: `${r.host}/${r.name}`,
    name: bare,
    agent: r.agent || null,
    host: r.host,
    state,
    last_active: isoOf(lastActive ?? seen),
    attach_hint: prefixed ? `quox sessions attach ${bare}` : `tmux attach -t ${r.name}`,
    backend: backendOf(bare, r.program),
    slot: r.slot || null,
    attached: !!r.attached,
    pid: r.pid ?? null,
    started_at: r.started_at || null,
    source: isWrapper(meta) ? 'heartbeat' : 'report',
    state_reason: state === 'failing' ? 'missed heartbeat' : null,
  };
}

/**
 * A conversation is working only while the turn registry holds a running turn
 * for it; a finished turn is resting however recent (a --print that ended 7 s
 * ago is not "working"). Registry is in-memory: after a collector restart a
 * conversation reads resting until its next turn.
 */
function fromConversation(c, nowMs, host, running) {
  const t = parseTime(c.updated_at);
  if (t == null || nowMs - t > CONVERSATION_WINDOW_MS) return null;
  return {
    kind: 'conversation',
    id: c.id,
    name: (c.title && String(c.title).trim()) || '(untitled)',
    agent: c.agent || null,
    host: host || null,
    state: running && running.has(c.id) ? 'working' : 'resting',
    last_active: isoOf(t),
    attach_hint: `quox --conversation ${c.id}`,
    turns: c.turn_count ?? null,
  };
}

function fromSlot(s, nowMs) {
  const hb = parseTime(s.last_heartbeat_at);
  let state = 'resting';
  if (s.state === 'stale') state = 'failing';
  else if (Number(s.unread_count) > 0) state = 'waiting';
  return {
    kind: 'slot',
    id: s.id || s.name,
    name: s.name,
    agent: s.assigned_to || null,
    host: s.host_id || null,
    state,
    last_active: isoOf(hb ?? parseTime(s.checked_out_at)),
    attach_hint: `quox slot read ${s.name}`,
    holder_session: s.holder_session || null,
    unread: Number(s.unread_count) || 0,
    state_reason: state === 'failing' ? 'slot heartbeat stale' : state === 'waiting' ? 'unread slot messages' : null,
  };
}

const ACTIVE_RE = /^(running|planning|decompos|executing|in_progress|active)/;
const WAITING_RE = /^(paused|awaiting|blocked|plan_review|pending_approval|waiting)/;
const FAILED = new Set(['failed', 'error', 'halted', 'cancelled', 'canceled', 'timed_out', 'timeout']);

/** Same status vocabulary as the quoxon roster (cli/lib/quoxon/roster.js); completed work is not live. */
function workState(status, { createdAt, finishedAt, nowMs }) {
  const st = String(status || '').toLowerCase();
  if (ACTIVE_RE.test(st)) return 'working';
  if (WAITING_RE.test(st)) return 'waiting';
  if (st === 'pending' || st === 'queued') return createdAt != null && nowMs - createdAt < PENDING_FRESH_MS ? 'waiting' : null;
  if (FAILED.has(st)) return finishedAt != null && nowMs - finishedAt <= FAILED_FRESH_MS ? 'failing' : null;
  return null;
}

function fromObjective(o, nowMs) {
  const startedAt = parseTime(o.started_at);
  const createdAt = parseTime(o.created_at) ?? startedAt;
  const finishedAt = parseTime(o.completed_at);
  const state = workState(o.status, { createdAt, finishedAt, nowMs });
  if (!state) return null;
  return {
    kind: o.execution_mode === 'loop' ? 'loop' : 'objective',
    id: o.id,
    name: o.title || o.id,
    agent: o.orchestrator_agent_id || o.agent_id || null,
    host: null,
    state,
    last_active: isoOf(finishedAt ?? parseTime(o.updated_at) ?? startedAt ?? createdAt),
    attach_hint: `quox objective get ${o.id}`,
    status: o.status,
  };
}

function fromExecution(e, nowMs) {
  const startedAt = parseTime(e.startedAt ?? e.started_at);
  const finishedAt = parseTime(e.completedAt ?? e.completed_at);
  const state = workState(e.status, { createdAt: startedAt, finishedAt, nowMs });
  if (!state) return null;
  return {
    kind: 'workflow',
    id: e.id,
    name: e.workflowName || e.workflowId || e.id,
    agent: e.agentId || null,
    host: null,
    state,
    last_active: isoOf(finishedAt ?? startedAt),
    attach_hint: `quox run get ${e.id}`,
    status: e.status,
    trigger: (e.triggerData && e.triggerData.trigger) || null,
  };
}

const SOURCE_LABELS = {
  tmux: 'tmux sessions (quox claude/codex wrapper + backfill)',
  conversations: 'your quox conversations (last 24 h)',
  slots: 'held slots',
  objectives: 'objectives and loops (tasks)',
  executions: 'workflow executions (quoxflow)',
  residents: 'residents',
};

const timeOf = (r) => parseTime(r.last_active) ?? -Infinity;
const newestFirst = (a, b) => timeOf(b) - timeOf(a);

/**
 * -> { rows, groups:[{ agent, rows }], counts, sources:[{ id, label, state, count, note? }] }.
 * sourceStates: { [id]: { state:'error'|'unavailable', note } } for sources the caller could not read.
 */
function buildIndex({ now = Date.now(), host = null, liveRows = [], conversations = [], runningConversations = null, slots = [], objectives = [], executions = [], sourceStates = {} } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const tmux = liveRows.map((r) => fromLiveRow(r, nowMs));
  const byHolder = new Map();
  for (const t of tmux) {
    byHolder.set(t.name, t);
    byHolder.set(`${PREFIX}${t.name}`, t);
  }
  const slotRows = [];
  for (const s of slots || []) {
    if (!s || (s.state !== 'held' && s.state !== 'stale')) continue;
    const holder = s.holder_session && byHolder.get(s.holder_session);
    if (holder) {
      if (!holder.slot) holder.slot = s.name;
      if (!holder.agent && s.assigned_to) holder.agent = s.assigned_to;
      continue;
    }
    slotRows.push(fromSlot(s, nowMs));
  }
  const parts = {
    tmux,
    conversations: (conversations || []).map((c) => fromConversation(c, nowMs, host, runningConversations ? new Set(runningConversations) : null)).filter(Boolean),
    slots: slotRows,
    objectives: (objectives || []).map((o) => fromObjective(o, nowMs)).filter(Boolean),
    executions: (executions || []).map((e) => fromExecution(e, nowMs)).filter(Boolean),
    residents: [],
  };
  const defaults = { residents: { state: 'unavailable', note: 'placeholder: residents are not listed yet' } };
  const sources = Object.keys(SOURCE_LABELS).map((id) => {
    const st = sourceStates[id] || defaults[id] || { state: 'connected' };
    return { id, label: SOURCE_LABELS[id], state: st.state, count: parts[id].length, ...(st.note ? { note: st.note } : {}) };
  });
  const rows = Object.values(parts).flat().sort(newestFirst);
  const groupMap = new Map();
  for (const r of rows) {
    const k = r.agent || null;
    if (!groupMap.has(k)) groupMap.set(k, []);
    groupMap.get(k).push(r);
  }
  const groups = [...groupMap.entries()]
    .map(([agent, rs]) => ({ agent, rows: rs }))
    .sort((a, b) => timeOf(b.rows[0]) - timeOf(a.rows[0]));
  const counts = { total: rows.length, working: 0, waiting: 0, resting: 0, failing: 0 };
  for (const r of rows) counts[r.state] += 1;
  return { rows, groups, counts, sources };
}

module.exports = {
  validateHeartbeatBody, heartbeatSession, endSession, listLiveRows, isExpired, buildIndex, parseTime,
  MISSED_BEATS, DEFAULT_INTERVAL_S, WORKING_MS,
};
