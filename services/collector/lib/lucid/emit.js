/**
 * In-process LUCID emitter for collector code paths (the HITL hook). Never
 * throws into the caller: awareness must not be able to break an approval.
 * A failure is logged loudly, not swallowed silently.
 */

function emit(ev) {
  try {
    const journal = require('./journal.js');
    if (!journal.isReady() || !ev || !ev.org_id) return null;
    return journal.append({ ...ev, source: { surface: 'collector', feed: 'hitl', ...(ev.source || {}) } });
  } catch (err) {
    console.error('[LUCID] emit failed:', ev && ev.subject, err && err.message);
    return null;
  }
}

const TERMINAL_APPROVAL = new Set(['approved', 'denied', 'expired', 'error', 'expire_close_failed']);

/** Approval lifecycle -> one subject per approval, approval:<id>. */
function approvalEvent(row, status) {
  if (!row || !row.org_id || !row.approval_id) return null;
  const subject = `approval:${row.approval_id}`;
  const tool = row.tool_name || 'tool';
  const who = row.agent_id ? ` for ${row.agent_id}` : '';
  if (status === 'pending') {
    return emit({ org_id: row.org_id, ledger: 'social', subject, kind: 'ask', state: { status: 'pending', tool_name: tool, ...(row.agent_id ? { agent_id: String(row.agent_id) } : {}) },
      summary: `${tool} needs approval${who}`, salience: { needs: 'owner', gates: [`tool:${tool}`] } });
  }
  if (TERMINAL_APPROVAL.has(status)) {
    // No summary: the subject keeps the human title it already has (who asked, for what).
    return emit({ org_id: row.org_id, ledger: 'social', subject, kind: 'retract', state: { status: status === 'expire_close_failed' ? 'expired' : status, tool_name: tool } });
  }
  return emit({ org_id: row.org_id, ledger: 'social', subject, kind: 'state', state: { status, tool_name: tool },
    salience: { needs: 'agent', gates: [`tool:${tool}`] } });
}


// ---------------------------------------------------------------------------
// LUCID v2 live hooks. Every helper goes through emit() so none can throw into
// the store that calls it. `feed` overrides the default 'hitl' feed name.
// ---------------------------------------------------------------------------

function safe(fn, label) {
  try { return fn(); } catch (err) {
    console.error(`[LUCID] ${label} hook failed:`, err && err.message);
    return null;
  }
}

function clip(v, n = 160) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n); }

/** Never put a raw phone number in LUCID. Digit-heavy labels become "number ending 123". */
function maskCaller(label) {
  const raw = clip(label, 80);
  if (!raw) return 'an unknown caller';
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 6 && digits.length >= raw.replace(/[\s()+\-.]/g, '').length - 1) return `number ending ${digits.slice(-3)}`;
  return raw;
}

const ISO_MS = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t; };

/**
 * Governed call object (callStore.js). row = calls row after the change.
 * ended/cancelled -> retract; blocked/failed -> ask (owner); else a state.
 */
function callEvent(row) {
  return safe(() => {
    if (!row || !row.org_id || !row.call_ref) return null;
    const subject = `call:${row.call_ref}`;
    const who = maskCaller(row.recipient);
    const facts = { caller: who, direction: row.direction || 'outbound', channel: row.channel || null, purpose: clip(row.purpose, 120) || null };
    const actor = { type: 'system', id: 'telephony', name: 'Telephony' };
    const src = { feed: 'voice' };
    switch (row.state) {
      case 'ended': case 'cancelled':
        return emit({ org_id: row.org_id, ledger: 'social', subject, kind: 'retract', source: src, state: { status: row.state, outcome: row.state === 'ended' ? 'answered' : 'cancelled', ...facts, actor } });
      case 'failed': case 'blocked':
        return emit({ org_id: row.org_id, ledger: 'social', subject, kind: 'ask', source: src, state: { status: row.state, outcome: row.state, reason: clip(row.block_reason, 120) || null, since: ISO_MS(row.updated_at), ...facts, actor },
          summary: row.state === 'failed' ? `Call to ${who} failed` : `Call to ${who} was held back`, salience: { needs: 'owner', gates: [] } });
      case 'connected':
        return emit({ org_id: row.org_id, ledger: 'social', subject, kind: 'state', source: src, state: { status: 'in_progress', since: ISO_MS(row.updated_at), ...facts, actor },
          summary: `On a call with ${who}`, salience: { needs: 'none', gates: [] } });
      default:
        return emit({ org_id: row.org_id, ledger: 'social', subject, kind: 'state', source: src, state: { status: 'ringing', since: ISO_MS(row.created_at), ...facts, actor },
          summary: `Calling ${who}`, salience: { needs: 'none', gates: [] } });
    }
  }, 'call');
}

/**
 * Completed bridge call (voiceCallStore.upsertCall). The record is only pushed
 * at call end: an inbound call with no conversation at all is a missed call.
 */
function voiceCallEvent(rec) {
  return safe(() => {
    if (!rec || !rec.org_id || !rec.call_sid) return null;
    const subject = `call:${rec.call_sid}`;
    const who = maskCaller(rec.peer);
    const inbound = !String(rec.direction || '').toLowerCase().startsWith('out');
    const turns = Array.isArray(rec.transcript) ? rec.transcript.length : 0;
    const facts = { caller: who, direction: inbound ? 'inbound' : 'outbound', turns, call_summary: clip(rec.summary, 200) || null };
    const actor = { type: 'system', id: 'telephony', name: 'Telephony' };
    const src = { feed: 'voice' };
    if (inbound && turns === 0 && !rec.summary) {
      return emit({ org_id: rec.org_id, ledger: 'social', subject, kind: 'ask', source: src,
        state: { status: 'missed', outcome: 'missed', since: rec.ended_at || rec.started_at || undefined, ...facts, actor },
        summary: `Missed call from ${who}`, salience: { needs: 'owner', gates: [] } });
    }
    return emit({ org_id: rec.org_id, ledger: 'social', subject, kind: 'retract', source: src,
      state: { status: 'answered', outcome: 'answered', ...facts, actor } });
  }, 'voice call');
}

const HIGH_SEV = new Set(['high', 'critical']);

/** Security finding lifecycle. status: candidate|confirmed|refuted|resolved (finding row after change). */
function findingEvent(f) {
  return safe(() => {
    if (!f || !f.org_id || !f.id) return null;
    const subject = `security:${f.id}`;
    const facts = { severity: f.severity, target: clip(f.target_value, 120), finding_title: clip(f.title, 160), engagement: f.engagement_id || null,
      category: clip(f.category || f.finding_type || f.type, 60) || null };
    const actor = { type: 'system', id: 'quoxsecurity', name: f.reported_by || 'QuoxSecurity' };
    const src = { feed: 'security' };
    if (f.status === 'resolved' || f.status === 'refuted') {
      return emit({ org_id: f.org_id, ledger: 'security', subject, kind: 'retract', source: src, state: { status: f.status, outcome: f.status, ...facts, actor } });
    }
    const high = HIGH_SEV.has(f.severity);
    return emit({ org_id: f.org_id, ledger: 'security', subject, kind: high ? 'ask' : 'state', source: src,
      state: { status: f.status || 'candidate', ...facts, actor },
      summary: `${f.severity} finding: ${clip(f.title, 120)}`,
      salience: { needs: high ? 'owner' : 'none', gates: [] } });
  }, 'finding');
}

/** Build receipt (buildReceiptsStore.recordBuildReceipt result record). One subject per target: build:last:<target>. */
function buildEvent(rec) {
  return safe(() => {
    if (!rec || !rec.target) return null;
    const orgId = rec.org_id || rec.orgId || 'default';
    const res = String(rec.result || '').toLowerCase();
    const ok = /^(ok|pass|passed|success|succeeded|done|built)$/.test(res);
    const status = ok ? 'succeeded' : 'failed';
    return emit({ org_id: orgId, ledger: 'operational', subject: `build:last:${rec.target}`, kind: 'state', source: { feed: 'build' },
      state: { status, target: rec.target, outcome: status, duration_seconds: rec.duration_seconds ?? null, stream: rec.stream || null, host: rec.host || null,
        build_message: clip(rec.message, 160) || null, actor: { type: 'session', id: clip(rec.terminal, 60) || 'build-daemon', name: clip(rec.terminal, 60) || 'Build daemon' } },
      summary: ok ? `${rec.target} built` : `${rec.target} build failed${rec.message ? `: ${clip(rec.message, 100)}` : ''}`,
      salience: { needs: 'none', gates: [] } });
  }, 'build');
}

/** VOLT run lifecycle: run.started / run.completed / run.failed ONLY. */
// A run "family" is the thing that runs repeatedly: a workflow (named in its run id) or an agent.
function runFamily(subject, actor) {
  const wf = String(subject).match(/^run:VR_wf-(.+)-[A-Z0-9]{8}_\d+$/);
  if (wf) return `wf:${wf[1]}`;
  const id = actor && actor.id;
  return id && id !== 'unknown' ? `agent:${id}` : null;
}

// When the same workflow or agent later succeeds, its earlier failures are history, not a need.
function clearEarlierFailures(orgId, family, exceptSubject) {
  if (!family) return 0;
  try {
    const journal = require('./journal.js');
    let n = 0;
    for (const s of journal.listOpenSubjects(orgId, { ledger: 'operational' })) {
      if (!s.subject.startsWith('run:') || s.subject === exceptSubject || s.status !== 'failed') continue;
      if (runFamily(s.subject, s.state && s.state.actor) !== family) continue;
      emit({ org_id: orgId, ledger: 'operational', subject: s.subject, kind: 'retract', source: { feed: 'runs' },
        state: { status: 'superseded', outcome: 'a later run succeeded' } });
      n += 1;
    }
    return n;
  } catch (err) {
    console.error('[LUCID] clearing earlier run failures failed:', err && err.message);
    return 0;
  }
}

function runEvent(eventType, runId, context, payload) {
  return safe(() => {
    if (!runId || !context || !context.org_id) return null;
    const agent = context.agent_id || 'an agent';
    const subject = `run:${runId}`;
    const actor = { type: 'agent', id: context.agent_id || 'unknown', name: agent };
    const src = { feed: 'runs' };
    const orgId = context.org_id;
    // Successful runs are not news: scheduled workflows run constantly and recording every start and
    // finish turned the journal into ~8,000 rows a day of "is working: dealt with". Only failures are
    // recorded; a success is used solely to clear earlier failures of the same workflow or agent.
    if (eventType === 'run.started') return null;
    if (eventType === 'run.completed') {
      clearEarlierFailures(orgId, runFamily(subject, actor), subject);
      return null;
    }
    if (eventType === 'run.failed') {
      // A run ended by a collector restart or the orphan sweep is not a failure that needs the owner.
      const err = String((payload && payload.error) || '');
      if (/shutdown|sigterm|sigint|orphan_sweep|no_terminal_envelope|flow\.cancelled|cancelled/i.test(err)) {
        return emit({ org_id: orgId, ledger: 'operational', subject, kind: 'retract', source: src,
          state: { status: 'interrupted', outcome: /cancel/i.test(err) ? 'cancelled' : 'cut off by a restart', run_error: clip(err, 200), actor } });
      }
      return emit({ org_id: orgId, ledger: 'operational', subject, kind: 'ask', source: src,
        state: { status: 'failed', outcome: 'failed', run_error: clip(payload && payload.error, 200) || null, urgency: 'today', actor },
        summary: `${agent} run failed${payload && payload.error ? `: ${clip(payload.error, 100)}` : ''}`,
        salience: { needs: 'owner', gates: [], hint: 0.8 } });
    }
    return null;
  }, 'run');
}

/**
 * InboxQ message that earned a place: urgent, watched, or awaiting the owner.
 * Returns null (emits nothing) for everything else. m = parsed message, cls = classification.
 */
function emailEvent(orgId, { id, folder, m, cls, watched }) {
  return safe(() => {
    if (!orgId || !id || !m) return null;
    // A first sync of an old mailbox is history, not news.
    if (m.dateTs && Date.now() - Number(m.dateTs) > 3 * 86400000) return null;
    const flags = (cls && cls.flags) || [];
    const urgentFolder = /urgent/i.test(String(folder || ''));
    const awaiting = (cls && cls.zone === 'focus') && flags.includes('needs_action');
    const urgent = urgentFolder || (awaiting && flags.includes('has_deadline'));
    if (!urgent && !watched && !awaiting) return null;
    const from = clip(m.fromName, 80) || clip(m.fromAddr, 80) || 'someone';
    const subjectLine = clip(m.subject, 140) || '(no subject)';
    const priority = urgent ? 'urgent' : (watched ? 'watched' : 'normal');
    return emit({ org_id: orgId, ledger: 'social', subject: `email:${id}`, kind: 'ask', source: { feed: 'inboxq' },
      state: { status: awaiting ? 'awaiting_reply' : 'new', since: m.dateTs || undefined, from, subject_line: subjectLine, priority, watched: Boolean(watched),
        awaiting_reply_by: awaiting ? 'owner' : null, actor: { type: 'human', id: clip(m.fromAddr, 80) || from, name: from } },
      summary: `${from} emailed: ${subjectLine}`, salience: { needs: awaiting || urgent ? 'owner' : 'none', gates: [] } });
  }, 'email');
}

/** Owner-directed direct message on Telegram/Slack. phase: 'received' | 'answered'. */
function messageEvent(feed, orgId, { chat, msg, from, phase }) {
  return safe(() => {
    if (!orgId || chat == null || msg == null) return null;
    const subject = `message:${chat}:${msg}`;
    const name = clip(from, 60) || 'someone';
    const actor = { type: 'human', id: String(chat), name };
    const src = { feed };
    if (phase === 'answered') {
      return emit({ org_id: orgId, ledger: 'social', subject, kind: 'retract', source: src, state: { status: 'answered', outcome: 'answered', from: name, channel: feed, actor } });
    }
    return emit({ org_id: orgId, ledger: 'social', subject, kind: 'state', source: src, state: { status: 'received', from: name, channel: feed, actor },
      summary: `${name} messaged on ${feed}`, salience: { needs: 'agent', gates: [] } });
  }, 'message');
}

// ---------------------------------------------------------------------------
// Heartbeats: silence must be detectable. Failures are counted distinctly from
// quiet ticks, a failing tick backs off (capped), and the counts are logged.
// ---------------------------------------------------------------------------
// The collector hosts these sources in-process, so its being alive is their liveness.
// inboxq is deliberately NOT here: a stalled mail sync must read as silent, not live.
const HEARTBEAT_FEEDS = ['voice', 'security', 'runs'];
const HEARTBEAT_EVERY_MS = 60_000;
const HEARTBEAT_TTL_S = 180;
const MAX_BACKOFF_TICKS = 8;

function createHeartbeat(orgIdsFn, opts = {}) {
  const feeds = opts.feeds || HEARTBEAT_FEEDS;
  const st = { ticks: 0, beats: 0, failures: 0, consecutiveFailures: 0, skip: 0 };
  function tick() {
    if (st.skip > 0) { st.skip -= 1; return st; }
    st.ticks += 1;
    let failed = 0;
    try {
      const journal = require('./journal.js');
      if (!journal.isReady()) return st;
      const orgs = orgIdsFn() || [];
      for (const org of orgs) {
        // Only orgs that already have an aware_feeds row: don't invent awareness for strangers.
        if (!journal.listFeeds(org).length) continue;
        for (const feed of feeds) {
          try {
            journal.append({ org_id: org, kind: 'heartbeat', ttl_s: HEARTBEAT_TTL_S, source: { surface: 'collector', feed } });
            st.beats += 1;
          } catch (err) { failed += 1; console.error(`[LUCID] heartbeat ${feed}/${org} failed:`, err && err.message); }
        }
      }
    } catch (err) { failed += 1; console.error('[LUCID] heartbeat tick failed:', err && err.message); }
    if (failed) {
      st.failures += failed; st.consecutiveFailures += 1;
      st.skip = Math.min(2 ** (st.consecutiveFailures - 1), MAX_BACKOFF_TICKS);
      console.error(`[LUCID] heartbeat: ${failed} failed this tick (${st.failures} total), backing off ${st.skip} tick(s)`);
    } else { st.consecutiveFailures = 0; }
    return st;
  }
  return { tick, state: st };
}

/** Start the 60s heartbeat loop. orgIdsFn() -> array of org ids. Returns { stop, tick, state }. */
function startHeartbeats(orgIdsFn) {
  if (typeof orgIdsFn !== 'function') { console.error('[LUCID] startHeartbeats needs an orgIdsFn; not started'); return { stop() {}, tick() {}, state: {} }; }
  const hb = createHeartbeat(orgIdsFn);
  hb.tick();
  const timer = setInterval(hb.tick, HEARTBEAT_EVERY_MS);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), tick: hb.tick, state: hb.state };
}

module.exports = {
  emit, approvalEvent, callEvent, voiceCallEvent, findingEvent, buildEvent, runEvent, emailEvent, messageEvent,
  maskCaller, startHeartbeats, createHeartbeat, HEARTBEAT_FEEDS,
};
