'use strict';
/**
 * QUOXMIND #1110: the [CURRENT FOCUS] block, the per-turn working set.
 *
 * Before: QuoxFocus had no working-set state (nothing ever wrote it),
 * QuoxSense had no producer, and QuoxExecutive/QuoxTemporal were display only
 * (`quox mind`, the topology). No chat prompt read any of them.
 *
 * After: on every HUMAN chat turn (POST /chat and POST /chat/stream; not the
 * internal agent-invoke path, which is automated work, not a user's ask) this
 * makes one call to the tasks service (POST /api/internal/focus/turn) that
 *   - records the ask (QuoxFocus fires; bounded per user+org),
 *   - lets QuoxSense perceive this org's fleet concerns and failed objectives
 *     once each into implant_signals,
 *   - returns in-flight objectives and loops (Executive), task load and time
 *     pattern (Temporal), recent asks and open loops (Focus), notable now
 *     (Sense, max 3),
 * and one call to auth for the user's pending approvals. Both run in parallel
 * under a hard deadline; whatever is late or failing is reported as
 * unavailable, never guessed and never awaited past the deadline.
 *
 * QuoxInsight stays unwired on purpose: it is a Pro faculty that correlates
 * sense signals, and it gets real input now; feeding its clusters into turns
 * is a separate Pro-gated step.
 *
 * Budget: MAX_CHARS (about 300 tokens). One log line per injecting turn.
 * Kill switch: QUOX_SERVER_FOCUS_ENABLED='false'. Never throws.
 */

const { redactSensitive } = require('./contentRedactor.js');

const MAX_TOKENS = 300;
const MAX_CHARS = MAX_TOKENS * 4;
const DEFAULT_DEADLINE_MS = 600;
const TITLE_CHARS = 70;
const ASK_CHARS = 70;
const NOTABLE_CHARS = 90;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isFocusEnabled(env = process.env) {
  return (env || {}).QUOX_SERVER_FOCUS_ENABLED !== 'false';
}

// Data text (titles, asks, signal summaries) is the org's own, but it must
// never be able to open or close a bracketed prompt section.
function clean(text, max) {
  const s = String(text == null ? '' : text).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function hhmm(d) { return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }
function when(iso, now) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? `${hhmm(d)} UTC` : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hhmm(d)} UTC`;
}

function withDeadline(promiseFactory, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), ms); });
  let work;
  try {
    work = Promise.resolve(promiseFactory()).then((value) => value, (err) => ({ ok: false, why: err && err.name === 'TimeoutError' ? 'timeout' : 'error' }));
  } catch {
    work = Promise.resolve({ ok: false, why: 'error' });
  }
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function getJson(fetchFn, url, opts, label, ms) {
  const res = await fetchFn(url, { ...opts, signal: AbortSignal.timeout(ms) });
  if (!res || !res.ok) return { ok: false, why: `${label} HTTP ${res ? res.status : '?'}` };
  const data = await res.json();
  return { ok: true, data };
}

function formatFocusBlock({ focus, approvals, now }) {
  const lines = ['[CURRENT FOCUS] Server truth for this user and org, read this turn. Use it to answer "what am I in the middle of", to resolve "that one" or "the other one", and to anticipate; never recite it unprompted.'];
  if (focus.ok) {
    const d = focus.data || {};
    const obj = d.objectives || { inFlight: 0, top: [] };
    const tasksInFlight = (d.tasks && d.tasks.inFlight) || 0;
    const taskPart = `${tasksInFlight} task${tasksInFlight === 1 ? '' : 's'} running or queued`;
    if (obj.inFlight > 0) {
      const tops = (obj.top || []).map((o) => {
        const bits = [o.mode === 'loop' ? 'loop' : 'objective', o.status];
        const since = when(o.since, now);
        if (since) bits.push(`since ${since}`);
        return `"${clean(o.title, TITLE_CHARS)}" (${bits.join(', ')})`;
      });
      const more = obj.inFlight > tops.length ? ` and ${obj.inFlight - tops.length} more` : '';
      lines.push(`In flight: ${obj.inFlight} objective${obj.inFlight === 1 ? '' : 's'}: ${tops.join('; ')}${more}. ${taskPart}.`);
    } else {
      lines.push(`In flight: no objectives or loops running; ${taskPart}.`);
    }
  } else {
    lines.push(`In flight, recent asks, activity and notable: unavailable this turn (${focus.why}); say so rather than guess.`);
  }

  if (approvals.ok) {
    const n = Number((approvals.data || {}).pending_approvals) || 0;
    lines.push(`Approvals waiting on you: ${n > 0 ? n : 'none'}.`);
  } else {
    lines.push(`Approvals: unavailable this turn (${approvals.why}).`);
  }

  if (focus.ok) {
    const d = focus.data || {};
    const asks = (d.asks || []).map((a) => `"${clean(a.text, ASK_CHARS)}"${a.at ? ` (${when(a.at, now)})` : ''}`);
    if (asks.length) lines.push(`Your previous asks: ${asks.join('; ')}.`);
    if (Array.isArray(d.openLoops) && d.openLoops.length) {
      lines.push(`Open loops: ${d.openLoops.map((l) => `${clean(l.description, TITLE_CHARS)}${l.priority ? ` (${l.priority})` : ''}`).join('; ')}.`);
    }
  }

  const t = focus.ok ? (focus.data || {}).temporal : null;
  let timeLine = `Time: ${DAYS[now.getUTCDay()]} ${hhmm(now)} UTC.`;
  if (t && t.tasks7d > 0) {
    timeLine += ` Activity: ${t.tasks24h} tasks in 24h, ${t.tasks7d} in 7d`;
    if (Number.isInteger(t.peakHourUtc)) timeLine += `, busiest hour ${pad2(t.peakHourUtc)}:00 UTC`;
    if (t.lastActivityAt) timeLine += `, last task ${when(t.lastActivityAt, now)}`;
    timeLine += '.';
  } else if (t) {
    timeLine += ' Activity: no tasks in the last 7 days.';
  }
  lines.push(timeLine);

  if (focus.ok) {
    const n = (focus.data || {}).notable || { count: 0, items: [] };
    if (n.items && n.items.length) {
      const items = n.items.slice(0, 3).map((i) => clean(i.summary, NOTABLE_CHARS));
      const more = n.count > items.length ? ` (+${n.count - items.length} more)` : '';
      lines.push(`Notable now (QuoxSense, last hour): ${items.join('; ')}${more}.`);
    } else {
      lines.push('Notable now: nothing (no fleet concerns or failed objectives in the last hour).');
    }
  }
  lines.push('[/CURRENT FOCUS]');
  return lines.join('\n');
}

function fitBudget(block, maxChars) {
  if (block.length <= maxChars) return block;
  const end = '\n[/CURRENT FOCUS]';
  const lines = block.split('\n').slice(0, -1);
  while (lines.length > 1 && lines.join('\n').length + end.length > maxChars) {
    // Shorten the longest line first; drop it only when it cannot shrink.
    let idx = 0;
    for (let i = 1; i < lines.length; i++) if (lines[i].length > lines[idx].length) idx = i;
    const target = lines.join('\n').length + end.length - maxChars;
    const keep = lines[idx].length - target - 1;
    if (keep >= 40) lines[idx] = `${lines[idx].slice(0, keep)}…`;
    else lines.splice(idx, 1);
  }
  return `${lines.join('\n')}${end}`.slice(0, maxChars);
}

/**
 * Build the [CURRENT FOCUS] block for one human chat turn. Never throws.
 */
async function buildFocusImplant({
  orgId, userId, agentId = '', prompt = '',
  fetchFn = (typeof fetch === 'function' ? fetch : null),
  tasksUrl = process.env.TASKS_SERVICE_URL || 'http://tasks:3104',
  authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101',
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  getOrgConcerns = null,
  deadlineMs = DEFAULT_DEADLINE_MS,
  maxChars = MAX_CHARS,
  now = () => new Date(),
  log = (line) => console.log(line),
  env = process.env,
} = {}) {
  try {
    if (!isFocusEnabled(env) || !orgId || !userId || typeof fetchFn !== 'function') return '';
    const t0 = Date.now();
    let concerns = [];
    try { concerns = typeof getOrgConcerns === 'function' ? (getOrgConcerns(orgId) || []).slice(0, 5) : []; } catch { concerns = []; }
    const headers = { 'Content-Type': 'application/json', ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) };
    const ask = clean(redactSensitive(String(prompt || '')), 160);
    const [focus, approvals] = await Promise.all([
      withDeadline(() => getJson(fetchFn, `${tasksUrl}/api/internal/focus/turn`, {
        method: 'POST', headers, body: JSON.stringify({ org_id: orgId, user_id: userId, prompt: ask, concerns }),
      }, 'tasks', deadlineMs), deadlineMs).then((r) => (r.ok || r.why !== 'timeout' ? r : { ok: false, why: 'tasks timeout' })),
      withDeadline(() => getJson(fetchFn, `${authUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/stats?user_id=${encodeURIComponent(userId)}`, {
        headers,
      }, 'auth', deadlineMs), deadlineMs).then((r) => (r.ok || r.why !== 'timeout' ? r : { ok: false, why: 'auth timeout' })),
    ]);
    if (!focus.ok && focus.why === 'error') focus.why = 'tasks error';
    if (!approvals.ok && approvals.why === 'error') approvals.why = 'auth error';
    const block = fitBudget(formatFocusBlock({ focus, approvals, now: now() }), maxChars);
    const d = focus.ok ? focus.data || {} : {};
    try {
      log(`[FocusImplant] org=${orgId} user=${userId} agent=${agentId || '-'} chars=${block.length} ` +
        `objectives=${focus.ok ? (d.objectives || {}).inFlight || 0 : 'na'} ` +
        `approvals=${approvals.ok ? Number((approvals.data || {}).pending_approvals) || 0 : 'na'} ` +
        `asks=${focus.ok ? (d.asks || []).length : 'na'} notable=${focus.ok ? ((d.notable || {}).count || 0) : 'na'} ` +
        `sensed=${focus.ok ? ((d.recorded || {}).signals || 0) : 'na'} ` +
        `tasks=${focus.ok ? 'ok' : focus.why} auth=${approvals.ok ? 'ok' : approvals.why} ms=${Date.now() - t0}`);
    } catch { /* logging never blocks a turn */ }
    return block;
  } catch (err) {
    try { console.warn(`[FocusImplant] build failed, proceeding without it: ${err.message}`); } catch { /* ignore */ }
    return '';
  }
}

/** Merge [SELF-KNOWLEDGE] and [CURRENT FOCUS] into one quox_context prefix. */
function joinBlocks(...blocks) {
  return blocks.filter(Boolean).join('\n\n');
}

module.exports = { buildFocusImplant, formatFocusBlock, joinBlocks, isFocusEnabled, MAX_CHARS, MAX_TOKENS, DEFAULT_DEADLINE_MS };
