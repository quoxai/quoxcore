/**
 * LUCID Herald (P3): it speaks first. Contract: docs/LUCID_P3_HERALD.md.
 *
 * Deterministic policy, no model. For every item that needs the owner, a budget says how
 * long it may wait before LUCID reaches out; then a ladder, coalesced per item:
 *   L1 inbox  (here, in the collector)  one HITL item per item (approvals are already in the inbox)
 *   L2 slot   (host runner)             one plain message to the owner's slot
 *   L3 call   (host runner, opt-in)     one phone call, never in quiet hours unless urgent and security/site-down
 * L2/L3 are exposed as "due" steps (dueSteps) and recorded by recordDone; the host runner does the talking.
 *
 * Loop hygiene (the triad): a tick counts FAILURES apart from "nothing due"; an org whose tick
 * fails backs off (capped); an escalated item is never re-escalated (durable aware_escalations row,
 * leases and an attempt cap on the host steps, resolved rows retired after a week).
 *
 * Nothing in here throws into the collector: runTick/startHerald catch and count everything.
 */

const journal = require('./journal.js');
const witness = require('./witness.js');
const { mintInboxItem } = require('./../inboxMint.js');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const URGENCY_BUDGET_MIN = { now: 5, today: 60, 'this week': 24 * 60 };
const L2_FLOOR_MS = 10 * MIN;
const L3_AFTER_L2_MS = 5 * MIN;
const LEASE_MS = 10 * MIN;
const MAX_STEP_ATTEMPTS = 3;
const MAX_CALL_ATTEMPTS = 2; // the call plus at most one retry
const CALL_RETRY_GAP_MS = 30 * MIN;
const DIGEST_MIN_GAP_MS = 10 * MIN;
const MORNING_WINDOW_MS = 6 * HOUR;
const RETIRE_RESOLVED_MS = 7 * DAY;
const TICK_MS = 60 * 1000;
const BACKOFF_CAP_MS = 15 * MIN;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, inbox: true, slot: true, slot_name: 'lucid', call: false,
  quiet_start: '22:00', quiet_end: '07:30', tz: 'Europe/London', morning_at: '08:00', max_items_per_hour: 4,
  call_per_hour: 1, call_per_day: 3,
  // Plain-language summaries by the org's configured model (cloud processing: off unless the org opts in).
  synth: false,
});

function bad(message) {
  const e = new Error(message);
  e.code = 'bad_request';
  return e;
}

// ---- settings ------------------------------------------------------------------------

const BOOLS = ['enabled', 'inbox', 'slot', 'call', 'synth'];
const HHMM = ['quiet_start', 'quiet_end', 'morning_at'];

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

function normBool(k, v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'on' || v === 'yes' || v === '1' || v === 1) return true;
  if (v === 'false' || v === 'off' || v === 'no' || v === '0' || v === 0) return false;
  throw bad(`${k} must be true or false`);
}

/** Validate a PARTIAL update; returns the cleaned partial. Throws bad_request naming the key. */
function validateSettings(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw bad('settings must be an object');
  const out = {};
  for (const [k, v] of Object.entries(partial)) {
    if (!(k in DEFAULT_SETTINGS)) throw bad(`unknown setting ${k}; valid: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
    if (BOOLS.includes(k)) out[k] = normBool(k, v);
    else if (HHMM.includes(k)) {
      if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${k} must be HH:MM (24 hour)`);
      out[k] = v;
    } else if (k === 'slot_name') {
      if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(v)) throw bad('slot_name must be 1-40 letters, digits, dot, dash or underscore');
      out[k] = v;
    } else if (k === 'tz') {
      if (typeof v !== 'string' || !validTz(v)) throw bad('tz must be an IANA time zone such as Europe/London');
      out[k] = v;
    } else if (k === 'call_per_hour' || k === 'call_per_day') {
      const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
      const max = k === 'call_per_hour' ? 10 : 50;
      if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`${k} must be a whole number from 1 to ${max}`);
      out[k] = n;
    } else if (k === 'max_items_per_hour') {
      const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
      if (!Number.isInteger(n) || n < 1 || n > 50) throw bad('max_items_per_hour must be a whole number from 1 to 50');
      out[k] = n;
    }
  }
  return out;
}

function getSettings(orgId) {
  return { ...DEFAULT_SETTINGS, ...(journal.getHeraldSettings(orgId) || {}) };
}

function updateSettings(orgId, partial, now = Date.now()) {
  const clean = validateSettings(partial);
  const next = { ...getSettings(orgId), ...clean };
  journal.setHeraldSettings(orgId, next, now);
  return next;
}

// ---- time ----------------------------------------------------------------------------

function localParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}

function hhmm(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

function inQuiet(now, settings) {
  const { minutes } = localParts(now, settings.tz);
  const a = hhmm(settings.quiet_start);
  const b = hhmm(settings.quiet_end);
  if (a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

// ---- policy --------------------------------------------------------------------------

function sevOf(item) {
  const st = (item.L3 && item.L3.state) || {};
  return String(st.severity || '').toLowerCase();
}

/** How long (ms) an item may wait before LUCID reaches out; null = never. */
function budgetFor(item) {
  const base = URGENCY_BUDGET_MIN[item.urgency];
  const cands = [];
  if (base != null) cands.push(base * MIN);
  if (item.kind === 'site' && item.urgency === 'now') cands.push(2 * MIN);
  if (item.kind === 'security' && ['high', 'critical'].includes(sevOf(item))) cands.push(0);
  if (item.kind === 'session') cands.push(15 * MIN);
  const gates = Array.isArray(item.gates) ? item.gates : ((item.L3 && item.L3.gates) || []);
  if (gates.some((g) => /^deploy:/i.test(g) || /deploy/i.test(g))) cands.push(10 * MIN);
  return cands.length ? Math.min(...cands) : null;
}

const isApproval = (item) => item.kind === 'approval' || String(item.ref).startsWith('approval:');
const canEscalate = (item) => item.urgency === 'now' || item.urgency === 'today';

function gatesOf(item) {
  return Array.isArray(item.gates) ? item.gates : ((item.L3 && item.L3.gates) || []);
}
const isRun = (ref) => String(ref).startsWith('run:');
const kindOf = (ref, item, row) => (item && item.kind) || (row && row.item_kind) || (String(ref).startsWith('security:') ? 'security' : null);
/** A security finding only counts once a human has verified it; agent-filed candidates are inbox-only. */
function securityVerified(item) {
  const st = String(((item && item.L3 && item.L3.state) || {}).status || '').toLowerCase();
  return st === 'confirmed' || st === 'verified';
}
function inboxOnly(ref, item, row) {
  if (isRun(ref)) return true; // cron/workflow run failures never go beyond L1
  return kindOf(ref, item, row) === 'security' && !securityVerified(item);
}
/** Only a site-down or a human-verified security finding may break quiet hours (and only for the call). */
function urgentSystem(ref, item, row) {
  const k = kindOf(ref, item, row);
  return k === 'site' || (k === 'security' && securityVerified(item));
}
/** Approvals only ring the phone when they gate a deploy, a security item or the site. */
function callEligible(ref, item, row) {
  if (inboxOnly(ref, item, row)) return false;
  const approval = item ? isApproval(item) : String(ref).startsWith('approval:');
  if (approval) return gatesOf(item || {}).some((g) => /deploy|security|site/i.test(g));
  return true;
}

function sinceOf(item) {
  return item.since != null ? item.since : (item.L1 && item.L1.when && item.L1.when.since) || 0;
}

const safeMeasure = (m) => !m.risk || m.risk === 'safe';

/** The first measure that is safe to say aloud / send: never a dangerous or gated one. */
function measureLine(item) {
  const m = ((item.L2 && item.L2.measures) || []).find((x) => safeMeasure(x) && (x.say || x.label));
  return m ? String(m.say || m.label).trim() : 'Ask me what to do about it';
}

function plainMessage(item, row) {
  const why = item.L1 && item.L1.why ? ` ${String(item.L1.why).replace(/\s+$/, '')}` : '';
  const how = measureLine(item).replace(/[.!?]+$/, '');
  const l0 = String((row && row.l0) || item.L0 || item.ref).replace(/[.]+$/, '');
  return `${l0}.${/[.!?]$/.test(why) || !why ? why : `${why}.`} You can: ${how}.`.replace(/\s+/g, ' ').trim();
}

function bodyFor(item, sit) {
  const lines = [];
  const L1 = item.L1 || {};
  if (L1.what) lines.push(L1.what);
  if (L1.why) lines.push(`Why: ${L1.why}`);
  const ms = ((item.L2 && item.L2.measures) || []).filter((m) => m.say || m.command).slice(0, 4);
  if (ms.length) lines.push(`What you can do:\n${ms.map((m) => `- ${m.say || m.label}${m.command ? ` (${m.command})` : ''}`).join('\n')}`);
  if (sit && sit.L0) lines.push(`The picture right now: ${sit.L0}`);
  lines.push(`Ref: ${item.ref}`);
  return lines.join('\n\n');
}

const prioOf = (u) => (u === 'now' ? 'urgent' : u === 'today' ? 'high' : 'normal');

function entriesOf(sitValue) {
  const needs = (sitValue && sitValue.situation && sitValue.situation.needs_you) || [];
  const byRef = new Map();
  for (const it of needs) {
    byRef.set(it.ref, it);
    for (const r of it.also || []) if (!byRef.has(r)) byRef.set(r, it);
  }
  return { needs, byRef };
}

// ---- dependencies --------------------------------------------------------------------

function authBase(deps) {
  return deps.authBaseUrl || process.env.AUTH_SERVICE_URL
    || `http://${process.env.AUTH_HOST || 'quox-auth'}:${process.env.AUTH_PORT || '3101'}`;
}
function svcKey(deps) { return deps.serviceKey !== undefined ? deps.serviceKey : process.env.INTERNAL_SERVICE_KEY; }

function depsFor(deps = {}) {
  return {
    now: deps.now || (() => Date.now()),
    log: deps.log || ((m) => console.log(m)),
    situation: deps.situation || ((orgId) => require('./routes.js').situationFor(orgId, { since: 'last', viewer: 'herald', surface: 'herald', advance: false })),
    mint: deps.mint || ((fields) => mintInboxItem(fields, deps)),
    // Close = resolve the item through the auth service's internal route (service key + actor type service).
    close: deps.close || (async (orgId, itemId) => {
      const key = svcKey(deps);
      if (!key) return { ok: false, error: 'INTERNAL_SERVICE_KEY not configured' };
      try {
        const res = await (deps.fetchImpl || fetch)(`${authBase(deps)}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/${encodeURIComponent(itemId)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-service-key': key, 'x-actor-type': 'service', 'x-actor-id': 'lucid-herald' },
          body: JSON.stringify({ action: 'resolved', reason: 'LUCID: this no longer needs you.' }),
          signal: AbortSignal.timeout(deps.timeoutMs || 10000),
        });
        return res.ok ? { ok: true } : { ok: false, error: `auth ${res.status}` };
      } catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
    }),
    // Is the filed inbox item still open? null = could not tell (treated as open).
    itemStatus: deps.itemStatus || (async (orgId, itemId) => {
      const key = svcKey(deps);
      if (!key) return null;
      try {
        const res = await (deps.fetchImpl || fetch)(`${authBase(deps)}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items/${encodeURIComponent(itemId)}`, {
          headers: { 'x-service-key': key }, signal: AbortSignal.timeout(deps.timeoutMs || 10000),
        });
        if (res.status === 404) return 'gone';
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({}));
        return (data.item && data.item.status) || null;
      } catch { return null; }
    }),
  };
}

const OPEN_STATUSES = new Set(['open', 'in_progress', 'waiting']);

// ---- journal -------------------------------------------------------------------------

function step(orgId, ref, status, summary, extra, ts, kind = 'state') {
  try {
    const r = journal.append({
      org_id: orgId, ledger: 'social', subject: `herald:${ref}`, kind, ts,
      state: { status, ...(extra || {}) }, summary: String(summary || '').slice(0, 300),
      source: { surface: 'herald', feed: 'herald', writer: 'herald' },
    });
    // Witness the step (queued, async, deduped with the journal observer; never throws).
    if (r && r.journaled && r.seq) witness.witnessSeq(orgId, r.seq);
  } catch (err) { console.error('[LUCID/Herald] journal step failed:', err && err.message); }
}

// ---- stats (failures are counted apart from "nothing due") -----------------------------

const _stats = { ticks: 0, ok_ticks: 0, failed_ticks: 0, nothing_due_ticks: 0, backoff_skips: 0, filed: 0, queued: 0, resolved: 0, close_failed: 0, last_error: null, last_error_at: null };
const _orgState = new Map(); // org -> { fails, nextAt }
function getStats() { return { ..._stats, orgs_backing_off: [..._orgState.entries()].filter(([, s]) => s.fails > 0).map(([o, s]) => ({ org_id: o, fails: s.fails, next_at: s.nextAt })) }; }
function _resetForTests() { _orgState.clear(); for (const k of Object.keys(_stats)) _stats[k] = typeof _stats[k] === 'number' ? 0 : null; }

// ---- the tick ------------------------------------------------------------------------

async function closeFiled(orgId, row, d) {
  if (!row.filed_item_id) return null;
  const r = await d.close(orgId, row.filed_item_id).catch((e) => ({ ok: false, error: e && e.message }));
  if (!r.ok) _stats.close_failed += 1;
  return r.ok;
}

async function tickCore(orgId, d) {
  const now = d.now();
  const settings = getSettings(orgId);
  const out = { filed: 0, queued: 0, resolved: 0, digest: false, morning: false, failures: [] };
  if (!settings.enabled) return { ...out, disabled: true };

  const sitValue = d.situation(orgId);
  const sit = sitValue.situation;
  const { needs, byRef } = entriesOf(sitValue);
  const fail = (what, err) => out.failures.push(`${what}: ${err}`);

  // 1. Resolution: an item that left needs_you is resolved; its inbox item is closed if we can.
  for (const row of journal.listEscalations(orgId, { status: 'open' })) {
    if (byRef.has(row.ref)) continue;
    const closed = await closeFiled(orgId, row, d);
    journal.saveEscalation(orgId, row.ref, { status: 'resolved', level: 'resolved', resolved_at: now, closed_ok: closed }, now);
    step(orgId, row.ref, 'resolved', `No longer needs you: ${row.l0}${closed === false ? ' (the inbox item could not be closed)' : ''}`, { closed_ok: closed }, now, 'retract');
    out.resolved += 1;
    _stats.resolved += 1;
  }
  for (const row of journal.listEscalations(orgId, { status: 'resolved' })) {
    if (row.resolved_at && now - row.resolved_at > RETIRE_RESOLVED_MS) journal.deleteEscalation(orgId, row.ref);
  }

  // 1a. Retire run:* (6h) and session:* (12h) subjects nobody has heard from, so they leave every view.
  try {
    const { isStale, MAX_AGE } = require('./situation.js');
    for (const sub of journal.listOpenSubjects(orgId)) {
      const rule = MAX_AGE.find(([p]) => String(sub.subject).startsWith(p));
      if (!rule || sub.expected_by != null || !isStale(sub, now)) continue;
      journal.append({ org_id: orgId, ledger: sub.ledger, subject: sub.subject, kind: 'retract', ts: now,
        state: { status: `gone, no word for ${rule[1] / HOUR}h` }, source: { surface: 'herald', feed: sub.feed || 'herald', writer: 'herald' } });
    }
  } catch (err) { fail('retire stale', err && err.message ? err.message : err); }

  // 1b. Refresh open rows from the live item so urgency/kind do not freeze at filing time.
  for (const row of journal.listEscalations(orgId, { status: 'open' })) {
    const live = byRef.get(row.ref);
    if (!live) continue;
    const patch = {};
    if (live.urgency && live.urgency !== row.urgency) patch.urgency = live.urgency;
    if (live.kind && live.kind !== row.item_kind) patch.item_kind = live.kind;
    if (Object.keys(patch).length) journal.saveEscalation(orgId, row.ref, patch, now);
  }

  // 2. Budget check, then L1 for anything past its budget that has no escalation yet.
  const filedLastHour = () => journal.listEscalations(orgId).filter((r) => r.filed_item_id && r.l1_at && now - r.l1_at < HOUR && r.item_kind !== 'digest').length;
  let used = filedLastHour();
  for (const item of needs) {
    const budget = budgetFor(item);
    if (budget == null) continue;
    const since = sinceOf(item);
    if (now - since < budget) continue;
    let row = journal.getEscalation(orgId, item.ref);
    if (row && row.status === 'resolved') {
      if (since > row.episode_since) { journal.deleteEscalation(orgId, item.ref); row = null; } else continue; // same episode: stays retired
    }
    if (row && row.level !== 'queued') continue; // already escalated: updated by later steps, never re-fired

    const base = { episode_since: since, urgency: item.urgency, l0: String(item.L0).slice(0, 300), item_kind: item.kind, budget_ms: budget };
    if (isApproval(item)) {
      journal.saveEscalation(orgId, item.ref, { ...base, level: 'l1_inbox', l1_at: now }, now);
      step(orgId, item.ref, 'l1_inbox', `Already waiting in Approvals: ${item.L0}`, { urgency: item.urgency, via: 'approvals' }, now);
      out.filed += 1;
      continue;
    }
    if (!settings.inbox) {
      journal.saveEscalation(orgId, item.ref, { ...base, level: 'l1_inbox', l1_at: now }, now);
      step(orgId, item.ref, 'l1_inbox', `Inbox is switched off; noted: ${item.L0}`, { urgency: item.urgency, via: 'none' }, now);
      continue;
    }
    if (used >= settings.max_items_per_hour) {
      if (!row) {
        journal.saveEscalation(orgId, item.ref, { ...base, level: 'queued' }, now);
        out.queued += 1;
        _stats.queued += 1;
      }
      continue;
    }
    const minted = await d.mint({
      orgId, title: `LUCID: ${item.L0}`.slice(0, 200), bodyMd: bodyFor(item, sit),
      kind: item.needs && item.needs !== 'none' && item.needs !== 'agent' ? 'task' : 'info', priority: prioOf(item.urgency),
      payload: { source: 'lucid-herald', ref: item.ref, urgency: item.urgency },
    });
    if (!minted || !minted.ok) { fail(`file ${item.ref}`, (minted && minted.error) || 'mint failed'); continue; }
    journal.saveEscalation(orgId, item.ref, { ...base, level: 'l1_inbox', filed_item_id: minted.itemId || null, l1_at: now }, now);
    step(orgId, item.ref, 'l1_inbox', `Told you in the inbox: ${item.L0}`, { urgency: item.urgency, inbox_item: minted.itemId || null }, now);
    used += 1;
    out.filed += 1;
    _stats.filed += 1;
  }

  // 3. Digest for the ones the rate limit held back (one at a time; replaced when the count changes).
  const queued = journal.listEscalations(orgId, { status: 'open' }).filter((r) => r.level === 'queued');
  const dg = journal.getHeraldMeta(orgId, 'digest');
  if (queued.length) {
    if ((!dg || dg.n !== queued.length) && (!dg || now - dg.at >= DIGEST_MIN_GAP_MS)) {
      if (dg && dg.item_id) await d.close(orgId, dg.item_id).catch(() => null);
      const n = queued.length;
      const minted = await d.mint({
        orgId, title: `LUCID: ${n} more thing${n === 1 ? '' : 's'} ${n === 1 ? 'needs' : 'need'} you`,
        bodyMd: `${queued.map((r) => `- ${r.l0}`).join('\n')}\n\nThese are held back so the inbox does not flood. They will each get their own item as room frees up.`,
        kind: 'task', priority: 'normal', payload: { source: 'lucid-herald', digest: true, count: n },
      });
      if (!minted || !minted.ok) fail('digest', (minted && minted.error) || 'mint failed');
      else { journal.setHeraldMeta(orgId, 'digest', { n, item_id: minted.itemId || null, at: now }, now); out.digest = true; }
    }
  } else if (dg) {
    if (dg.item_id) await d.close(orgId, dg.item_id).catch(() => null);
    journal.setHeraldMeta(orgId, 'digest', null, now);
  }

  // 4. Morning briefing, once per local day.
  const lp = localParts(now, settings.tz);
  const mAt = hhmm(settings.morning_at);
  if (lp.minutes >= mAt && journal.getHeraldMeta(orgId, 'morning_date') !== lp.date) {
    if ((lp.minutes - mAt) * MIN > MORNING_WINDOW_MS) {
      journal.setHeraldMeta(orgId, 'morning_date', lp.date, now); // too late to be a morning briefing; do not send one at teatime
    } else {
      const lines = needs.slice(0, 8).map((it, i) => `${i + 1}. ${it.L0}`);
      const spoken = sitValue.spoken || sit.L0;
      let ok = true;
      if (settings.inbox) {
        const minted = await d.mint({
          orgId, title: 'LUCID: good morning', bodyMd: `${spoken}${lines.length ? `\n\nNeeds you:\n${lines.join('\n')}` : '\n\nNothing needs you.'}`,
          kind: 'info', priority: 'normal', payload: { source: 'lucid-herald', morning: lp.date },
        });
        if (!minted || !minted.ok) { ok = false; fail('morning', (minted && minted.error) || 'mint failed'); }
      }
      if (ok) {
        journal.setHeraldMeta(orgId, 'morning_date', lp.date, now);
        if (settings.slot) journal.setHeraldMeta(orgId, 'morning_pending', { date: lp.date, message: `Good morning. ${spoken}${lines.length ? ` Needs you: ${lines.join(' ')}` : ''}`.replace(/\s+/g, ' ').slice(0, 1500), issued_at: null, attempts: 0 }, now);
        step(orgId, `morning:${lp.date}`, 'l1_inbox', 'Morning briefing filed', { date: lp.date }, now);
        witness.briefingIssued(orgId, { viewer: 'herald', surface: 'herald', kind: 'morning' }, sitValue);
        out.morning = true;
      }
    }
  }
  return out;
}

/**
 * One tick for one org. Never throws. Returns { ok, backoff?, nothing_due, ... }.
 * ok=false means the tick FAILED (not "nothing to do"); consecutive failures back the org off.
 */
async function runTick(orgId, deps = {}) {
  const d = depsFor(deps);
  const now = d.now();
  _stats.ticks += 1;
  const st = _orgState.get(orgId) || { fails: 0, nextAt: 0 };
  if (st.nextAt > now) { _stats.backoff_skips += 1; return { ok: true, backoff: true, next_at: st.nextAt }; }
  let res;
  try {
    if (!journal.isReady()) throw new Error('journal not ready');
    res = await tickCore(orgId, d);
  } catch (err) {
    res = { filed: 0, queued: 0, resolved: 0, failures: [`tick: ${err && err.message ? err.message : err}`] };
  }
  if (res.failures.length) {
    st.fails += 1;
    st.nextAt = now + Math.min(TICK_MS * 2 ** st.fails, BACKOFF_CAP_MS);
    _orgState.set(orgId, st);
    _stats.failed_ticks += 1;
    _stats.last_error = res.failures[0];
    _stats.last_error_at = now;
    d.log(`[LUCID/Herald] ${orgId}: tick failed (${st.fails}x), backing off to ${new Date(st.nextAt).toISOString()}: ${res.failures.join('; ')}`);
    return { ok: false, failures: res.failures, fails: st.fails, next_at: st.nextAt, ...res };
  }
  _orgState.delete(orgId);
  const acted = res.filed + res.queued + res.resolved + (res.digest ? 1 : 0) + (res.morning ? 1 : 0);
  if (!acted) _stats.nothing_due_ticks += 1;
  _stats.ok_ticks += 1;
  return { ok: true, nothing_due: !acted, ...res };
}

/**
 * Start the herald loop. orgIdsFn: () => string[] (sync or async).
 * Wiring (server.js, after journal.ensure): require('./lib/lucid/herald.js').startHerald(() => <org ids>, {})
 * Returns { stop, stats }.
 */
function startHerald(orgIdsFn, deps = {}) {
  const intervalMs = deps.intervalMs || TICK_MS;
  let stopped = false;
  let running = false;
  let timer = null;
  const loop = async () => {
    if (stopped) return;
    if (!running) {
      running = true;
      try {
        const ids = await orgIdsFn();
        for (const id of ids || []) await runTick(id, deps);
      } catch (err) {
        _stats.failed_ticks += 1;
        _stats.last_error = `orgs: ${err && err.message ? err.message : err}`;
        _stats.last_error_at = Date.now();
        console.error('[LUCID/Herald] loop error:', err && err.message);
      } finally { running = false; }
    }
    if (!stopped) { timer = setTimeout(loop, intervalMs); if (timer.unref) timer.unref(); }
  };
  timer = setTimeout(loop, deps.initialDelayMs != null ? deps.initialDelayMs : 30000);
  if (timer.unref) timer.unref();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); }, stats: getStats };
}

// ---- call caps and quiet hours (shared by dueSteps and describeEscalations) -----------

function callLog(orgId, now) {
  const l = journal.getHeraldMeta(orgId, 'call_log');
  return (Array.isArray(l) ? l : []).filter((t) => Number.isFinite(t) && now - t < DAY);
}
/** { ok, at } : ok=false means a cap is reached; at = when the oldest counted call leaves the window. */
function callCapState(orgId, settings, now) {
  const log = callLog(orgId, now).sort((a, b) => a - b);
  const lastHour = log.filter((t) => now - t < HOUR);
  if (lastHour.length >= settings.call_per_hour) return { ok: false, at: lastHour[lastHour.length - settings.call_per_hour] + HOUR };
  if (log.length >= settings.call_per_day) return { ok: false, at: log[log.length - settings.call_per_day] + DAY };
  return { ok: true, at: null };
}
function noteCall(orgId, now) {
  journal.setHeraldMeta(orgId, 'call_log', [...callLog(orgId, now), now], now);
}
/** The next moment (minute resolution) the quiet window ends; null when not in quiet hours. */
function quietEndsAt(now, settings) {
  if (!inQuiet(now, settings)) return null;
  const { minutes } = localParts(now, settings.tz);
  const delta = (hhmm(settings.quiet_end) - minutes + 1440) % 1440;
  return now - (now % MIN) + delta * MIN;
}

// ---- L2 / L3: what the host runner should do now ---------------------------------------

/**
 * Steps due for the host runner. Issuing a step takes a 10 minute lease and counts an attempt
 * (3 max), so a runner polling twice, or failing, can never double-fire or loop forever.
 */
async function dueSteps(orgId, deps = {}) {
  const d = depsFor(deps);
  const now = d.now();
  const settings = getSettings(orgId);
  const steps = [];
  if (!settings.enabled) return steps;
  const sitValue = d.situation(orgId);
  const { byRef } = entriesOf(sitValue);
  const rows = journal.listEscalations(orgId, { status: 'open' });
  const leased = (issued) => issued != null && now - issued < LEASE_MS;
  let callBusy = rows.some((r) => leased(r.l3_issued_at) && r.l3_at == null);
  const quiet = inQuiet(now, settings);

  // Ask the inbox about every candidate item at once, not one after another (was ~1s per item serially).
  for (const row of rows) { // live urgency wins over the urgency frozen at filing time
    const live = byRef.get(row.ref);
    if (live && live.urgency) { row.urgency = live.urgency; if (live.kind) row.item_kind = live.kind; }
  }
  const candidates = rows.filter((row) => byRef.get(row.ref) && row.l1_at != null && ['now', 'today'].includes(row.urgency));
  const statuses = new Map(await Promise.all(candidates.filter((r) => r.filed_item_id)
    .map(async (r) => [r.ref, await d.itemStatus(orgId, r.filed_item_id).catch(() => null)])));

  for (const row of candidates) {
    const item = byRef.get(row.ref);
    const handled = statuses.get(row.ref) || null;
    if (handled && !OPEN_STATUSES.has(handled)) continue; // you already dealt with the inbox item
    if (inboxOnly(row.ref, item, row)) continue; // run failures and unverified security findings stay in the inbox
    const msg = plainMessage(item, row);

    // A quiet-hours step is deferred, not dropped: it becomes due the first poll after quiet_end.
    if (settings.slot && !quiet && row.l2_at == null && row.attempts_l2 < MAX_STEP_ATTEMPTS && !leased(row.l2_issued_at)
        && now - row.l1_at >= Math.max(row.budget_ms || 0, L2_FLOOR_MS)) {
      journal.saveEscalation(orgId, row.ref, { l2_issued_at: now, attempts_l2: row.attempts_l2 + 1 }, now);
      steps.push({ ref: row.ref, level: 'l2_slot', message: msg, slot_name: settings.slot_name });
      continue;
    }
    const urgent = urgentSystem(row.ref, item, row);
    // Quiet hours: only an urgent system item may call, and then without waiting on the (held) slot nudge.
    const l2Unavailable = !settings.slot || row.attempts_l2 >= MAX_STEP_ATTEMPTS;
    const pastFloor = now - row.l1_at >= Math.max(row.budget_ms || 0, L2_FLOOR_MS) + L3_AFTER_L2_MS;
    const l3Ready = row.l2_at != null
      ? now - row.l2_at >= L3_AFTER_L2_MS
      : (quiet ? urgent && pastFloor : l2Unavailable && pastFloor);
    if (settings.call && row.urgency === 'now' && callEligible(row.ref, item, row) && row.l3_at == null
        && row.attempts_l3 < MAX_CALL_ATTEMPTS && !leased(row.l3_issued_at) && l3Ready && !callBusy
        && (row.l3_issued_at == null || now - row.l3_issued_at >= CALL_RETRY_GAP_MS)
        && (!quiet || urgent) && callCapState(orgId, settings, now).ok) {
      journal.saveEscalation(orgId, row.ref, { l3_issued_at: now, attempts_l3: row.attempts_l3 + 1 }, now);
      noteCall(orgId, now);
      steps.push({ ref: row.ref, level: 'l3_call', message: msg, slot_name: settings.slot_name });
      callBusy = true;
    }
  }

  const mp = journal.getHeraldMeta(orgId, 'morning_pending');
  if (mp && settings.slot && !quiet && mp.attempts < MAX_STEP_ATTEMPTS && !leased(mp.issued_at)) {
    journal.setHeraldMeta(orgId, 'morning_pending', { ...mp, issued_at: now, attempts: mp.attempts + 1 }, now);
    steps.push({ ref: `morning:${mp.date}`, level: 'l2_slot', message: mp.message, slot_name: settings.slot_name });
  }
  return steps;
}

/** Record the outcome of an L2/L3 step the host runner performed. */
function recordDone(orgId, { ref, level, ok, detail, owner_said: ownerSaid } = {}, deps = {}) {
  const now = depsFor(deps).now();
  if (typeof ref !== 'string' || !ref) throw bad('ref required');
  if (!['l2_slot', 'l3_call'].includes(level)) throw bad('level must be l2_slot or l3_call');
  const det = detail == null ? null : String(detail).slice(0, 500);
  const said = ownerSaid == null ? null : String(ownerSaid).slice(0, 1000);

  if (ref.startsWith('morning:')) {
    const mp = journal.getHeraldMeta(orgId, 'morning_pending');
    if (!mp || `morning:${mp.date}` !== ref) throw Object.assign(new Error('no such morning step'), { code: 'not_found' });
    if (ok) journal.setHeraldMeta(orgId, 'morning_pending', null, now);
    step(orgId, ref, ok ? 'l2_slot' : 'l2_failed', ok ? 'Morning briefing posted to your slot' : `Morning briefing could not be posted: ${det || 'unknown'}`, { ok: !!ok, detail: det }, now);
    return { ok: true, recorded: true };
  }
  const row = journal.getEscalation(orgId, ref);
  if (!row) throw Object.assign(new Error('no such escalation'), { code: 'not_found' });
  const l2 = level === 'l2_slot';
  if (ok) {
    journal.saveEscalation(orgId, ref, { [l2 ? 'l2_at' : 'l3_at']: now, level, last_error: null, ...(said ? { owner_said: said } : {}) }, now);
    step(orgId, ref, level, l2 ? `Messaged your slot: ${row.l0}` : `Phoned you: ${row.l0}${said ? ` You said: ${said}` : ''}`, { ok: true, detail: det, ...(said ? { owner_said: said } : {}) }, now);
  } else {
    journal.saveEscalation(orgId, ref, { last_error: det || 'failed', ...(said ? { owner_said: said } : {}) }, now);
    step(orgId, ref, l2 ? 'l2_failed' : 'l3_failed', `${l2 ? 'Slot message' : 'Phone call'} did not go through: ${det || 'unknown'}`, { ok: false, detail: det }, now);
  }
  return { ok: true, recorded: true };
}

// ---- views ---------------------------------------------------------------------------

function describeEscalations(orgId, deps = {}) {
  const d = depsFor(deps);
  const now = d.now();
  const settings = getSettings(orgId);
  let byRef = new Map();
  try { byRef = entriesOf(d.situation(orgId)).byRef; } catch { /* fall back to the stored row */ }
  const quietEnd = quietEndsAt(now, settings);
  const hhmmOf = (ms) => { const m = localParts(ms, settings.tz).minutes; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const when = (ms) => (ms > now ? ms : null); // a past time is never shown
  return journal.listEscalations(orgId, { status: 'open' }).map((r) => {
    const item = byRef.get(r.ref) || null;
    let next = null;
    let at = null;
    let note = null;
    const esc = ['now', 'today'].includes(r.urgency);
    if (r.level === 'queued') { next = 'l1_inbox'; note = 'waiting for room under the hourly inbox limit'; }
    else if (inboxOnly(r.ref, item, r)) { note = isRun(r.ref) ? 'run failures stay in the inbox' : 'not verified by a human yet, so inbox only'; }
    else if (r.l2_at == null && settings.slot && esc && r.l1_at != null && r.attempts_l2 < MAX_STEP_ATTEMPTS) {
      next = 'l2_slot';
      at = Math.max(r.l1_at + Math.max(r.budget_ms || 0, L2_FLOOR_MS), r.l2_issued_at != null ? r.l2_issued_at + LEASE_MS : 0);
      if (quietEnd != null && at < quietEnd) { at = quietEnd; note = `waiting for quiet hours to end at ${hhmmOf(quietEnd)}`; }
    } else if (r.l3_at == null && settings.call && r.urgency === 'now' && callEligible(r.ref, item, r) && r.attempts_l3 < MAX_CALL_ATTEMPTS
        && (r.l2_at != null || (urgentSystem(r.ref, item, r) && quietEnd != null) || (quietEnd == null && (!settings.slot || r.attempts_l2 >= MAX_STEP_ATTEMPTS)))) {
      next = 'l3_call';
      const base = r.l2_at != null ? r.l2_at + L3_AFTER_L2_MS : r.l1_at + Math.max(r.budget_ms || 0, L2_FLOOR_MS) + L3_AFTER_L2_MS;
      at = Math.max(base, r.l3_issued_at != null ? r.l3_issued_at + CALL_RETRY_GAP_MS : 0);
      if (quietEnd != null && !urgentSystem(r.ref, item, r) && at < quietEnd) { at = quietEnd; note = `waiting for quiet hours to end at ${hhmmOf(quietEnd)}`; }
      const cap = callCapState(orgId, settings, now);
      if (!cap.ok && cap.at > at) { at = cap.at; note = 'call cap reached'; }
    }
    if (at != null && at <= now) { note = note || 'due on the next check'; at = null; }
    const last = Math.max(r.l1_at || 0, r.l2_at || 0, r.l3_at || 0) || null;
    return { ref: r.ref, L0: r.l0, urgency: r.urgency, level: r.level, filed_item_id: r.filed_item_id, since: r.episode_since, last_step_at: last, next_step: next, next_step_at: when(at), next_step_note: note, now };
  });
}

/** Dry run: what would happen right now. Files nothing, changes nothing. */
function dryRun(orgId, deps = {}) {
  const d = depsFor(deps);
  const now = d.now();
  const settings = getSettings(orgId);
  const { needs } = entriesOf(d.situation(orgId));
  const used = journal.listEscalations(orgId).filter((r) => r.filed_item_id && r.l1_at && now - r.l1_at < HOUR).length;
  return {
    enabled: settings.enabled,
    items: needs.map((item) => {
      const budget = budgetFor(item);
      const row = journal.getEscalation(orgId, item.ref);
      let would;
      if (!settings.enabled) would = 'nothing (herald is off)';
      else if (budget == null) would = 'nothing (this one can wait)';
      else if (row && row.status === 'open' && row.level !== 'queued') would = `already told you (${row.level})`;
      else if (now - sinceOf(item) < budget) would = `wait ${Math.ceil((budget - (now - sinceOf(item))) / MIN)} more min`;
      else if (isApproval(item)) would = 'note it (already in Approvals); may message or call later';
      else if (!settings.inbox) would = 'note it (inbox is off)';
      else if (used >= settings.max_items_per_hour) would = 'hold it for the digest (hourly limit reached)';
      else would = 'file an inbox item';
      return { ref: item.ref, L0: item.L0, urgency: item.urgency, budget_min: budget == null ? null : Math.round(budget / MIN), waited_min: Math.round((now - sinceOf(item)) / MIN), would };
    }),
  };
}

module.exports = {
  DEFAULT_SETTINGS, validateSettings, getSettings, updateSettings, budgetFor, inQuiet, localParts,
  runTick, startHerald, dueSteps, recordDone, describeEscalations, dryRun, getStats, _resetForTests,
  TICK_MS,
};
