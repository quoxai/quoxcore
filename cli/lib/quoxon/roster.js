/**
 * QUOXON roster: what is actually running on this instance for this org. Pure
 * functions only (normalise server rows, build the view); fetching lives in api.js.
 * Rows come from real list endpoints; a source that cannot answer contributes
 * nothing (never a placeholder row).
 */
import { clip } from './theme.js';

export const GLYPH = { running: '◐', waiting: '⏸', done: '✔', failed: '✖' };
export const FRESH_MS = 10 * 60 * 1000;      // finished rows linger this long
export const USER_DONE_MS = 20 * 1000;       // a user-started completion vanishes quickly: rows come and go
export const PENDING_FRESH_MS = 24 * 3600 * 1000; // an older "pending" is stale, not waiting
export const MAX_ROWS = 4;
export const MIN_FULL_COLS = 60;
export const MIN_FULL_ROWS = 24;

/** Server timestamps: epoch ms, ISO, or SQLite "YYYY-MM-DD HH:MM:SS" (UTC, no zone). */
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isFinite(t) ? t : null;
}

export function elapsed(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}

const ACTIVE_RE = /^(running|planning|decompos|executing|in_progress|active)/;
const WAITING_RE = /^(paused|awaiting|blocked|plan_review|pending_approval|waiting)/;
const FAILED = new Set(['failed', 'error', 'halted', 'cancelled', 'canceled', 'timed_out', 'timeout']);

/** How long a finished row lingers before it leaves the roster (null while running/waiting). */
const expiryFor = (state, doneMs) => state === 'done' ? doneMs : state === 'failed' ? FRESH_MS : null;

/** -> state or null (not shown). */
function stateOf(status, { startedAt, createdAt, finishedAt, now, doneMs = FRESH_MS }) {
  const st = String(status || '').toLowerCase();
  if (ACTIVE_RE.test(st)) return 'running';
  if (WAITING_RE.test(st)) return 'waiting';
  if (st === 'pending' || st === 'queued') {
    const t = createdAt ?? startedAt;
    return t != null && now - t < PENDING_FRESH_MS ? 'waiting' : null;
  }
  if (st === 'completed' || st === 'complete' || st === 'succeeded' || FAILED.has(st)) {
    if (finishedAt == null) return null;
    const ok = st === 'completed' || st === 'complete' || st === 'succeeded';
    if (now - finishedAt > (ok ? doneMs : FRESH_MS)) return null;
    return ok ? 'done' : 'failed';
  }
  return null;
}

export function fromObjective(o, now = Date.now()) {
  const startedAt = parseTime(o.started_at);
  const createdAt = parseTime(o.created_at);
  const finishedAt = parseTime(o.completed_at);
  // Objectives and loops are always user-started work.
  const state = stateOf(o.status, { startedAt, createdAt, finishedAt, now, doneMs: USER_DONE_MS });
  if (!state) return null;
  const loop = o.execution_mode === 'loop';
  let activity = '';
  if (state === 'failed' && o.error_message) activity = String(o.error_message);
  else if (loop && o.max_iterations) activity = `iter ${o.iteration_count || 0}/${o.max_iterations}`;
  else if (o.task_count) activity = `${o.tasks_completed || 0}/${o.task_count} tasks`;
  else if (state === 'waiting') activity = 'waiting to start';
  const from = startedAt ?? createdAt;
  return {
    key: `objective:${o.id}`, id: o.id, source: 'objectives', background: false, kind: loop ? 'loop' : 'objective', state,
    name: o.title || o.id, activity, status: o.status,
    startedAt: from, finishedAt, ageMs: from != null ? (state === 'done' || state === 'failed' ? (finishedAt ?? now) - from : now - from) : null,
    expiryMs: expiryFor(state, USER_DONE_MS),
    detail: { description: o.description, error: o.error_message, tokens: o.tokens_used, toolCalls: o.tool_calls_used }
  };
}

const USER_TRIGGERS = new Set(['manual', 'chat', 'cli', 'user']);
const BACKGROUND_BY = /^(schedule|cron|interval|webhook|event|system)\b/i;
/**
 * Is this workflow execution background work (hidden from the roster by default)?
 * Fields relied on (live /api/executions rows, checked 2026-10-12): `triggerData.trigger`
 * ('schedule' on every live row) and `triggeredBy` ('schedule:trigger', 'event:<node>',
 * 'webhook:<node>' set by quoxflow's trigger-bootstrap). Rule: a background-looking triggeredBy
 * always wins; otherwise user-started only if the trigger is manual/chat/cli/user OR triggeredBy
 * equals the signed-in user's id. Unknown trigger with no such evidence is background.
 */
export function isBackgroundExecution(e, userId = null) {
  const by = e?.triggeredBy == null ? '' : String(e.triggeredBy);
  if (BACKGROUND_BY.test(by)) return true;
  if (userId && by && by === String(userId)) return false;
  return !USER_TRIGGERS.has(String(e?.triggerData?.trigger || '').toLowerCase());
}

export function fromExecution(e, now = Date.now(), { userId = null } = {}) {
  const startedAt = parseTime(e.startedAt);
  const finishedAt = parseTime(e.completedAt);
  const background = isBackgroundExecution(e, userId);
  const state = stateOf(e.status, { startedAt, createdAt: startedAt, finishedAt, now, doneMs: background ? FRESH_MS : USER_DONE_MS });
  if (!state) return null;
  let activity = '';
  if (state === 'failed' && e.error) activity = typeof e.error === 'string' ? e.error : (e.error.message || JSON.stringify(e.error));
  else if (e.nodeCount) activity = `${e.nodeCount} node${e.nodeCount === 1 ? '' : 's'}`;
  else if (e.triggerData?.trigger) activity = `via ${e.triggerData.trigger}`;
  return {
    key: `execution:${e.id}`, id: e.id, source: 'executions', kind: 'workflow', background, state,
    name: e.workflowName || e.workflowId || e.id, activity, status: e.status,
    startedAt, finishedAt, ageMs: startedAt != null ? (state === 'done' || state === 'failed' ? (finishedAt ?? now) - startedAt : now - startedAt) : null,
    expiryMs: expiryFor(state, background ? FRESH_MS : USER_DONE_MS),
    detail: { workflowId: e.workflowId, correlationId: e.correlationId, trigger: e.triggerData?.trigger, error: e.error }
  };
}

/** A pending approval (inbox item) for this user/org -> amber waiting row, always shown. */
export function fromApproval(it, now = Date.now()) {
  if (!it || !it.id) return null;
  const m = it.payload?.approval_context?.method || {};
  const name = m.tool ? (m.target ? `${m.tool} on ${m.target}` : m.tool) : String(it.title || it.summary || it.id);
  const createdAt = parseTime(it.created_at ?? it.createdAt);
  return { key: `approval:${it.id}`, id: it.id, source: 'approvals', kind: 'approval', state: 'waiting', background: false, name, activity: '/approvals', status: 'pending',
    startedAt: createdAt, finishedAt: null, ageMs: createdAt != null ? now - createdAt : null, detail: { description: it.title } };
}

/** Heartbeat style system work: nobody wants a row or a notification for it, working or failing. */
export const NOISE_NAME = /heartbeat|health[ _-]?check|keep[ _-]?alive|\bping\b/i;
export const isNoise = (r) => Boolean(r.background) && NOISE_NAME.test(String(r.name || ''));

/** Rows the user should see: background rows only with `all` (/roster all). */
export function selectRows(rows, { all = false } = {}) {
  return all ? rows : rows.filter(r => !r.background && !isNoise(r));
}

/** One line per workflow that is failing in the background (deduped); these feed the notifications bar. */
export function backgroundAlerts(rows) {
  const by = new Map();
  for (const r of rows) if (r.background && !isNoise(r) && r.state === 'failed') by.set(r.name, (by.get(r.name) || 0) + 1);
  return [...by].map(([name, n]) => `✖ ${name} failing (${n} in ${FRESH_MS / 60000}m) · /roster all`);
}

/** When the row last changed state: it started, or it finished (done/failed). */
export const changedAt = (r) => (r.state === 'done' || r.state === 'failed' ? r.finishedAt : null) ?? r.startedAt ?? 0;

/** Approvals pinned on top (oldest first, they need action); everything else most recent change first. */
export function sortRows(rows) {
  const ap = (r) => (r.kind === 'approval' ? 0 : 1);
  return [...rows].sort((a, b) => ap(a) - ap(b) || (ap(a) === 0 ? (a.startedAt ?? 0) - (b.startedAt ?? 0) : changedAt(b) - changedAt(a)));
}

export const isExpired = (r, now = Date.now()) => r.expiryMs != null && r.finishedAt != null && now - r.finishedAt > r.expiryMs;

/** Tone steps, brightest first (theme colour names). Position among non-approval rows, and for finished rows age toward expiry. */
export const TONES = ['text', 'placeholder', 'dim', 'faint'];
export function toneName(r, pos, now = Date.now()) {
  if (r.kind === 'approval') return TONES[0];
  let step = Math.min(Math.max(0, pos), TONES.length - 1);
  if (r.expiryMs && r.finishedAt != null) {
    const frac = Math.max(0, now - r.finishedAt) / r.expiryMs;
    step = Math.max(step, frac < 0.25 ? 0 : frac < 0.5 ? 1 : frac < 0.75 ? 2 : 3);
  }
  return TONES[step];
}

/** Live age text: a clock for running/waiting rows, recency ("done 3s ago") for finished ones. */
export function ageText(r, now = Date.now()) {
  if (r.state === 'done' || r.state === 'failed') return r.finishedAt != null ? `${r.state === 'done' ? 'done' : 'failed'} ${elapsed(now - r.finishedAt)} ago` : '';
  return r.startedAt != null ? elapsed(now - r.startedAt) : '';
}

export function countsLine(rows) {
  const n = (s) => rows.filter(r => r.state === s).length;
  return [['running', 'running'], ['waiting', 'waiting'], ['failed', 'failed'], ['done', 'finished']]
    .filter(([s]) => n(s)).map(([s, w]) => `${GLYPH[s]} ${n(s)} ${w}`).join(' · ');
}

/**
 * View model. mode: 'hidden' (off or nothing running) | 'summary' (narrow or short terminal) | 'full'.
 * lines: [{ state, text, selected }] where text is already clipped to cols.
 */
export function rosterView({ rows, cols, termRows = 40, max = MAX_ROWS, on = true, sel = 0, focus = false, now = Date.now() }) {
  if (!on || !rows.length) return { mode: 'hidden', lines: [], more: 0 };
  if (cols < MIN_FULL_COLS || termRows < MIN_FULL_ROWS) {
    return { mode: 'summary', lines: [], more: 0, summary: clip(' ' + countsLine(rows) + ' · /roster', cols - 1) };
  }
  const shown = rows.slice(0, max);
  const ageW = Math.max(5, ...shown.map(r => [...ageText(r, now)].length));
  let pos = 0;
  const kindW = Math.min(9, Math.max(...shown.map(r => r.kind.length)));
  const lines = shown.map((r, i) => {
    const el = ageText(r, now).padStart(ageW);
    const tone = toneName(r, pos, now); if (r.kind !== 'approval') pos++;
    const actW = Math.min(18, Math.max(0, ...shown.map(x => [...(x.activity || '')].length)));
    const act = clip(r.activity || '', actW).padEnd(actW);
    const fixed = 1 + 1 + 1 + kindW + 1 + 1 + actW + 1 + ageW; // marker glyph kind name act elapsed
    const nameW = Math.max(8, cols - 2 - fixed - 1);
    const name = clip(r.name, nameW).padEnd(nameW);
    const marker = focus && i === sel ? '›' : ' ';
    const rest = `${r.kind.padEnd(kindW)} ${name} ${act} ${el}`;
    return { key: r.key, state: r.state, tone, selected: focus && i === sel, marker, glyph: GLYPH[r.state], rest: ' ' + rest, text: `${marker}${GLYPH[r.state]} ${rest}` };
  });
  return { mode: 'full', lines, more: Math.max(0, rows.length - shown.length) };
}

export function peekLines(row, now = Date.now()) {
  if (!row) return [];
  const age = ageText(row, now);
  const out = [`${row.kind} ${row.id}`, `status ${row.status} · ${row.state}${age ? ` · ${age}` : ''}`, `name ${row.name}`];
  if (row.activity) out.push(`activity ${row.activity}`);
  const d = row.detail || {};
  if (d.description) out.push(`goal ${d.description}`);
  if (d.workflowId) out.push(`workflow ${d.workflowId}`);
  if (d.trigger) out.push(`trigger ${d.trigger}`);
  if (d.error && row.state === 'failed') out.push(`error ${typeof d.error === 'string' ? d.error : JSON.stringify(d.error)}`);
  return out;
}
