/**
 * QUOXON E5: "What happened while I was away?" A factual digest since a moment, from real sources only:
 * approvals (auth inbox), objectives (tasks), workflow executions (quoxflow), LUCID needs_you + its blind
 * feeds, Qortex decisions (quoxbrain), agent activity and failed turns (AEE envelopes).
 *
 * Every item carries its source and time. A source that cannot be read is NEVER an empty list: it is
 * named in `blind` with the reason, alongside the feeds LUCID already knows are silent, failing or not
 * connected. Nothing here is summarised by a model.
 */

const toMs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(t) ? t : null;
};
const isoOf = (v) => { const t = toMs(v); return t == null ? null : new Date(t).toISOString(); };
const clip = (s, n = 140) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const errText = (e) => {
  if (!e) return '';
  if (typeof e === 'string') { try { return errText(JSON.parse(e)); } catch { return e; } }
  return e.message || e.error || '';
};

const DECISION = { approve: 'Approved', approved: 'Approved', reject: 'Denied', rejected: 'Denied', deny: 'Denied', denied: 'Denied' };

/** Approvals: every one still waiting (it needs you now, whenever filed), resolved ones inside the window. */
function mapApprovals(waiting, resolved, sinceMs) {
  const out = [];
  for (const it of waiting || []) {
    out.push({ kind: 'approval_waiting', title: clip(`Waiting: ${it.title || it.id}`), source: 'approvals', ts: isoOf(it.created_at), ref: it.id });
  }
  for (const it of resolved || []) {
    const at = toMs(it.resolved_at || it.updated_at);
    if (at == null || at < sinceMs) continue;
    let resp = it.response || null;
    if (!resp && it.response_json) { try { resp = JSON.parse(it.response_json); } catch { resp = null; } }
    const action = String((resp && (resp.action || resp.decision)) || '').toLowerCase();
    const word = DECISION[action] || 'Resolved';
    out.push({ kind: 'approval_resolved', title: clip(`${word}: ${it.title || it.id}`), source: 'approvals', ts: isoOf(at), ref: it.id, status: word.toLowerCase() });
  }
  return out;
}

const FAILED = new Set(['failed', 'error', 'errored', 'timeout', 'timed_out']);
const DONE = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished']);

function mapObjectives(list, sinceMs) {
  const out = [];
  for (const o of list || []) {
    const st = String(o.status || '').toLowerCase();
    if (!FAILED.has(st) && !DONE.has(st)) continue;
    const at = toMs(o.completed_at || o.completedAt || o.updated_at);
    if (at == null || at < sinceMs) continue;
    const name = clip(o.title || o.goal || o.id, 80);
    const why = FAILED.has(st) ? errText(o.error || o.failure_reason || o.last_error) : '';
    out.push({ kind: FAILED.has(st) ? 'objective_failed' : 'objective_finished', title: clip(`Objective "${name}" ${FAILED.has(st) ? 'failed' : 'finished'}${why ? `: ${why}` : ''}`), source: 'objectives', ts: isoOf(at), ref: o.id });
  }
  return out;
}

const USER_TRIGGERS = new Set(['manual', 'chat', 'cli', 'user']);
const BACKGROUND_BY = /^(schedule|cron|interval|webhook|event|system)\b/i;
/** Same rule as the quox client roster (cli/lib/quoxon/roster.js isBackgroundExecution). */
function isBackgroundExecution(e, userId = null) {
  const by = e && e.triggeredBy != null ? String(e.triggeredBy) : (e && e.triggered_by != null ? String(e.triggered_by) : '');
  if (BACKGROUND_BY.test(by)) return true;
  // quoxflow records a person-started run as user:<id> (RunActor); a bare id is an older row
  if (userId && by && (by === String(userId) || by === `user:${userId}`)) return false;
  let td = e && (e.triggerData || e.trigger_data);
  if (typeof td === 'string') { try { td = JSON.parse(td); } catch { td = null; } }
  return !USER_TRIGGERS.has(String((td && td.trigger) || '').toLowerCase());
}

/** Failures always; a finished run only when a person started it (scheduled heartbeats are not news). */
function mapExecutions(list, sinceMs, userId = null) {
  const out = [];
  for (const e of list || []) {
    const st = String(e.status || '').toLowerCase();
    if (!FAILED.has(st) && !DONE.has(st)) continue;
    if (DONE.has(st) && isBackgroundExecution(e, userId)) continue;
    const at = toMs(e.completedAt || e.completed_at || e.finishedAt || e.finished_at);
    if (at == null || at < sinceMs) continue;
    const name = clip(e.workflowName || e.workflow_name || e.workflowId || e.workflow_id || e.id, 80);
    const why = FAILED.has(st) ? errText(e.error) : '';
    out.push({ kind: FAILED.has(st) ? 'workflow_failed' : 'workflow_finished', title: clip(`Workflow "${name}" ${FAILED.has(st) ? 'failed' : 'finished'}${why ? `: ${why}` : ''}`), source: 'workflows', ts: isoOf(at), ref: e.id });
  }
  return out;
}

const hours = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/**
 * LUCID: needs_you items that began inside the window, or are urgent now (approvals excluded: they are
 * their own source). Older standing items are counted, not listed: they did not happen while you were away.
 */
function mapSituation(sit, sinceMs = 0) {
  const items = [];
  let standing = 0;
  for (const it of (sit && sit.needs_you) || []) {
    if (it.kind === 'approval') continue;
    const at = toMs((it.L1 && it.L1.when && it.L1.when.since) || it.status_since || it.since);
    if (it.urgency !== 'now' && (at == null || at < sinceMs)) { standing += 1; continue; }
    items.push({ kind: 'alert', title: clip(it.L0 || it.ref), source: 'lucid', ts: isoOf(at), ref: it.ref, urgency: it.urgency });
  }
  const cs = (sit && sit.cannot_see) || {};
  const blind = [
    ...(cs.silent || []).map((s) => ({ source: `lucid:${s.feed}`, reason: `silent ${hours(s.silent_ms)}` })),
    ...(cs.failing || []).map((f) => ({ source: `lucid:${f.feed}`, reason: `failing: ${clip(f.error, 60)}` })),
    ...(cs.unwired || []).map((n) => ({ source: `lucid:${n}`, reason: 'not connected' })),
  ];
  return { items, blind, standing: { count: standing, source: 'lucid' } };
}

/** "HTTP 401 session_revoked": the status plus a JSON body's error code, never the rest of the body. */
function httpReason(status, body) {
  let code = '';
  try { const j = JSON.parse(body); code = j && typeof j.error === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(j.error) ? j.error : ''; } catch { code = ''; }
  return `HTTP ${status}${code ? ` ${code}` : ''}`;
}

function mapDecisions(list) {
  return (list || []).map((n) => ({ kind: 'decision', title: clip(n.title || n.id), source: 'qortex', ts: isoOf(n.created_at), ref: n.id }));
}

/**
 * Agent actions per agent from AEE envelopes in the window. The scan is capped (newest rows first via the
 * ts index) so a busy box never pins the event loop; partial:true says the count is a floor.
 */
function agentActivity(db, { orgId, sinceMs, scanCap = 20000 }) {
  const rows = db.prepare(
    'SELECT "from" AS f, org_id FROM envelopes WHERE ts >= ? ORDER BY ts DESC LIMIT ?'
  ).all(new Date(sinceMs).toISOString(), scanCap);
  const by = new Map();
  let total = 0;
  for (const r of rows) {
    if (r.org_id !== orgId || typeof r.f !== 'string' || !r.f.startsWith('agent.')) continue;
    const a = r.f.slice(6);
    by.set(a, (by.get(a) || 0) + 1);
    total += 1;
  }
  const agents = [...by.entries()].map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent));
  return { total, agents, source: 'aee', partial: rows.length >= scanCap };
}

const TURN_ERRORS = ['quox.chat.stream_error', 'quox.chat.error', 'quox.chat.cli_error'];

/** Failed chat turns: the error envelopes every chat path writes (org scoped; envelopes carry no user). */
function failedTurns(db, { orgId, sinceMs, limit = 50 }) {
  const rows = db.prepare(
    `SELECT id, ts, "from" AS f, payload FROM envelopes WHERE intent IN (${TURN_ERRORS.map(() => '?').join(',')}) AND ts >= ? AND org_id = ? ORDER BY ts DESC LIMIT ?`
  ).all(...TURN_ERRORS, new Date(sinceMs).toISOString(), orgId, limit);
  return rows.map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload || '{}') || {}; } catch { p = {}; }
    const who = typeof r.f === 'string' && r.f.startsWith('agent.') ? r.f.slice(6) : 'an agent';
    const why = clip(p.error || '', 80);
    return { kind: 'turn_failed', title: clip(`A turn by ${who} failed${why ? `: ${why}` : ''}`), source: 'turns', ts: isoOf(r.ts), ref: r.id };
  });
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'timeout' })), ms); }),
  ]);
}

/**
 * readers: { [sourceId]: async ({ orgId, userId, sinceMs, now }) => { items?, blind?, activity? } }.
 * -> { since, until, items (newest first), activity, blind, sources: [{ id, ok, count }] }
 */
async function buildAwayDigest({ orgId, userId, sinceMs, now = Date.now(), readers = {}, timeoutMs = 6000 }) {
  const ids = Object.keys(readers);
  const settled = await Promise.allSettled(ids.map((id) => withTimeout(Promise.resolve().then(() => readers[id]({ orgId, userId, sinceMs, now })), timeoutMs)));
  const items = [];
  const blind = [];
  const extra = [];
  const sources = [];
  let activity = null;
  let standing = null;
  settled.forEach((s, i) => {
    const id = ids[i];
    if (s.status === 'rejected') {
      const e = s.reason || {};
      blind.push({ source: id, reason: clip(e.code === 'timeout' || e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : (e.message || 'failed'), 80) });
      sources.push({ id, ok: false, count: 0 });
      return;
    }
    const v = s.value || {};
    const got = (v.items || []).filter((it) => it && it.title);
    items.push(...got);
    if (v.blind) extra.push(...v.blind);
    if (v.activity) activity = v.activity;
    if (v.standing) standing = v.standing;
    sources.push({ id, ok: true, count: got.length });
  });
  items.sort((a, b) => (toMs(b.ts) || 0) - (toMs(a.ts) || 0));
  return { since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString(), items, activity, standing, blind: [...blind, ...extra], sources };
}

module.exports = { buildAwayDigest, httpReason, isBackgroundExecution, mapApprovals, mapObjectives, mapExecutions, mapSituation, mapDecisions, agentActivity, failedTurns, toMs };
