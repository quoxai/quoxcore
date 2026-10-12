'use strict';

/**
 * loopTools.js — QUOXIFY PASS 1 (DEVSUITE phase 14): the governed tool
 * surface LOOP-Q reasons over.
 *
 * The bundle quoxification audit (QuoxPlan DEVSUITE note #2842) found
 * AGENTIC was the biggest shared gap: QLoop is the flagship, its backend is
 * the most governed thing in the suite (full AEE + VOLT + AOCL + WARD), and
 * yet nobody could ASK it anything. A running loop is exactly the shape that
 * wants a conversational agent, because it is a domain that changes across
 * turns: "what has it actually done", "is it going in circles", "stop it".
 *
 * Three tools, deliberately no more:
 *   loop_sessions - which loops exist and what state are they in
 *   loop_turns    - the WITNESSED turn record for one loop
 *   loop_halt     - stop it, through the approval gate
 *
 * Design rules this file follows, all borrowed rather than invented:
 *   - Every call goes through the collector's OWN governed routes with the
 *     internal service key, never a direct DB read, so org scoping and the
 *     evidence emit stay in one place (same discipline as qlarityTools.js
 *     and quoxplanTools.js).
 *   - org_id travels explicitly. A tool that cannot resolve an org refuses
 *     rather than falling back to a default (multi-tenant, fail closed).
 *   - loop_halt is wrapped in withApprovalGate, the same helper
 *     bob_mark_build_outcome uses. An agent must never be able to stop a
 *     governed loop without a human in the path. This matters more than
 *     usual here: QUOXPERTICUS Invariant #1 (no agent self-approving its own
 *     HITL) is already flagged as unenforceable in code, so the halt path
 *     must not quietly add another way for an agent to act unilaterally.
 *
 * Read tools are honest about emptiness: "no turns recorded" is a real
 * answer and must never be dressed up as "the loop is fine".
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 15000;

const QUOXPLAN_URL = process.env.QUOXPLAN_URL || 'http://quoxplan:3107';
const DEFAULT_ROADMAP_ID = 'quox-strategic';
const { buildProposals } = require('./loopSuggest');

/**
 * Read the roadmap's streams for loop_suggest context. Direct instance-global
 * GET, no auth header — mirrors feedQuoxplanSource.defaultListStreams and the
 * standalone quoxplan CLI's own client (reads carry no evidence implication).
 * Best-effort: returns [] on any failure so the advisor still works from its
 * catalog when QuoxPlan is unreachable.
 */
async function quoxplanListStreams(roadmapId = DEFAULT_ROADMAP_ID) {
  const url = `${QUOXPLAN_URL}/api/v1/roadmaps/${encodeURIComponent(roadmapId)}/streams?lens=all`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET roadmap streams failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body && body.streams) ? body.streams : [];
}

/**
 * Shared request helper. Mirrors qlarityCall: one readable Error for every
 * failure mode (unreachable, timeout, non-2xx), safe to hand to the model.
 */
async function collectorCall(method, path, { orgId, body } = {}) {
  if (!orgId) {
    throw new Error('org_context_required: loop tools need an authenticated org context.');
  }
  const sep = path.includes('?') ? '&' : '?';
  const url = `${COLLECTOR_URL}${path}${sep}org_id=${encodeURIComponent(orgId)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  const hasBody = !['GET', 'HEAD'].includes(method);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(body || {}) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Loop control plane unreachable (${err.message}). Is the collector running on ${COLLECTOR_URL}?`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* body may be empty or non-JSON */ }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `${res.status} ${res.statusText}`;
    throw new Error(`Loop request failed (${res.status}): ${detail}`);
  }
  return json;
}

// Turn events carry a lot of machinery the conductor does not need to reason
// well. Keep the shape small so a long loop still fits in a useful answer.
//
// The persisted row is { seq, type, raw, received_at } (dev_loop_session_events):
// the witness timestamp is received_at, and the turn's ACTUAL content lives in
// the raw stream-json blob, shaped differently per event type. An earlier
// version of this read created_at/ts for `at` and summary/text for `summary`,
// neither of which the row carries, so loop-q got seq+kind and a null timestamp
// and a null summary for every turn - it could see THAT a turn happened but not
// WHAT it did or WHEN, which is the one thing the conductor exists to report.
// created_at/ts/summary/text are still honoured first for any caller that hands
// in a pre-normalised event.
function summariseEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const kind = ev.kind || ev.type || null;
  const at = ev.received_at || ev.created_at || ev.ts || null;

  let raw = ev.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }

  let summary = null;
  if (typeof ev.summary === 'string') summary = ev.summary;
  else if (typeof ev.text === 'string') summary = ev.text;
  else if (raw && typeof raw === 'object') summary = summariseRaw(kind, raw);

  return {
    seq: ev.seq ?? null,
    kind,
    at,
    summary: summary ? String(summary).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
  };
}

// Render one short, type-aware line from a claude -p / codex exec stream-json
// event so the conductor can cite what a turn DID. Everything here is derived
// from fields the loop backends actually emit (see dev_loop_session_events raw
// blobs). Unknown shapes fall back to any obvious message/text field rather
// than to null, so a new event type degrades to "something readable", never to
// a silent blank the agent would mistake for an empty turn.
function summariseRaw(kind, raw) {
  switch (kind) {
    case 'system': {
      const sub = raw.subtype || 'system';
      const nTools = Array.isArray(raw.tools) ? raw.tools.length : null;
      const cwd = raw.cwd ? ` cwd ${raw.cwd}` : '';
      return `system/${sub}${cwd}${nTools != null ? ` (${nTools} tools)` : ''}`;
    }
    case 'assistant':
    case 'user': {
      const content = raw.message && Array.isArray(raw.message.content) ? raw.message.content : [];
      const texts = [];
      const tools = [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b.type === 'thinking') tools.push('thinking');
        else if (b.type === 'tool_use' && b.name) tools.push(toolCallHint(b));
        else if (b.type === 'tool_result') texts.push(toolResultHint(b));
      }
      const parts = [];
      if (texts.length) parts.push(texts.join(' '));
      if (tools.length) parts.push(tools.map((t) => `⚙ ${t}`).join(', '));
      const joined = parts.filter(Boolean).join(' · ');
      if (joined) return joined;
      const role = raw.message && raw.message.role;
      return role ? `${role} turn (no text)` : null;
    }
    case 'result': {
      const status = raw.is_error ? 'ERROR' : 'ok';
      const turns = raw.num_turns != null ? `${raw.num_turns} turn${raw.num_turns === 1 ? '' : 's'}` : null;
      const stop = raw.stop_reason || raw.subtype || null;
      const cost = typeof raw.total_cost_usd === 'number' ? `$${raw.total_cost_usd.toFixed(4)}` : null;
      return ['result:', status, turns, stop, cost].filter(Boolean).join(' ');
    }
    case 'rate_limit_event': {
      const info = raw.rate_limit_info || {};
      const bits = [`rate limit ${info.status || '?'}`];
      if (info.rateLimitType) bits.push(info.rateLimitType);
      if (info.overageStatus && info.overageStatus !== 'allowed') {
        bits.push(`overage ${info.overageStatus}${info.overageDisabledReason ? `: ${info.overageDisabledReason}` : ''}`);
      }
      return bits.join(', ');
    }
    case 'seam_error':
      return raw.message ? `seam error: ${raw.message}` : 'seam error';
    default:
      if (typeof raw.message === 'string') return raw.message;
      if (typeof raw.text === 'string') return raw.text;
      return null;
  }
}

// One representative argument turns "Bash" into "Bash(git status)", which reads
// as a diagnosis instead of a category. Capped so a long command cannot blow
// the per-turn budget.
function toolCallHint(block) {
  const name = block.name || 'tool';
  const inp = block.input || {};
  let hint = '';
  for (const key of ['command', 'file_path', 'path', 'query', 'url', 'description', 'pattern']) {
    if (typeof inp[key] === 'string' && inp[key].trim()) { hint = inp[key]; break; }
  }
  hint = hint.replace(/\s+/g, ' ').trim().slice(0, 60);
  return hint ? `${name}(${hint})` : name;
}

function toolResultHint(block) {
  const c = block.content;
  const prefix = block.is_error ? 'tool error' : 'tool result';
  if (typeof c === 'string') return `${prefix}: ${c.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
  if (Array.isArray(c)) {
    const t = c.find((x) => x && x.type === 'text' && typeof x.text === 'string');
    if (t) return `${prefix}: ${t.text.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
  }
  return prefix;
}

const LOOP_TOOLS = {

  loop_sessions: {
    name: 'loop_sessions',
    description: "List the org's QLoop loop sessions (execution_mode='loop' objectives handed to a model's own native loop on a governed dev server). Read-only. Use this first for any 'what is running', 'which loops are live', or 'what happened on host X' question, then loop_turns for the detail of one session. Returns [] when the org has no loop sessions, which means exactly that and must not be reported as healthy or as an error.",
    input_schema: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: 'Optional dev server host id to filter to one host.' },
        limit: { type: 'number', description: 'Max sessions to return (default 20).' },
      },
      required: [],
    },
    execute: async ({ host_id, limit }, ctx) => {
      try {
        const qs = new URLSearchParams();
        if (host_id) qs.set('host_id', host_id);
        qs.set('limit', String(limit && limit > 0 ? Math.min(limit, 100) : 20));
        const data = await collectorCall('GET', `/api/v1/dev-sessions?${qs.toString()}`, { orgId: ctx && ctx.orgId });
        const sessions = Array.isArray(data && data.sessions) ? data.sessions : [];
        return {
          success: true,
          count: sessions.length,
          sessions: sessions.map((s) => ({
            id: s.id,
            host_id: s.host_id,
            status: s.status,
            objective_id: s.objective_id || null,
            backend: s.backend || null,
            created_at: s.created_at || null,
            last_turn_at: s.last_turn_at || null,
          })),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  loop_turns: {
    name: 'loop_turns',
    description: "Read the WITNESSED turn record for one loop session: what the loop actually did, turn by turn, as recorded server-side. This is the evidence trail, not a reconstruction, so cite it rather than guessing at what a loop 'probably' did. Use since_seq to page forward through a long loop. An empty list means no turns have been recorded for that session yet; say so plainly rather than implying the loop is idle or healthy.",
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The loop session id (from loop_sessions).' },
        since_seq: { type: 'number', description: 'Return only events after this sequence number (default 0, the start).' },
        limit: { type: 'number', description: 'Max events to return (default 50).' },
      },
      required: ['session_id'],
    },
    execute: async ({ session_id, since_seq, limit }, ctx) => {
      if (!session_id || !String(session_id).trim()) {
        return { success: false, error: 'session_id is required' };
      }
      try {
        const qs = new URLSearchParams();
        qs.set('since_seq', String(since_seq || 0));
        qs.set('limit', String(limit && limit > 0 ? Math.min(limit, 200) : 50));
        const data = await collectorCall(
          'GET',
          `/api/v1/dev-sessions/${encodeURIComponent(session_id)}/events?${qs.toString()}`,
          { orgId: ctx && ctx.orgId }
        );
        const events = Array.isArray(data && data.events) ? data.events : (Array.isArray(data) ? data : []);
        return {
          success: true,
          session_id,
          count: events.length,
          turns: events.map(summariseEvent).filter(Boolean),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  loop_halt: {
    name: 'loop_halt',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: "Stop a running loop. This delivers the governed signed kill to the host and is WITNESSED; it is not a soft pause and the loop does not resume. ALWAYS goes through the approval gate: you can only ever propose a halt, a human resolves it, so say plainly that you have requested it rather than reporting the loop as stopped. Establish first (with loop_turns) that the loop actually warrants stopping, and give a specific reason citing what you saw.",
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The loop session id to halt (from loop_sessions).' },
        reason: { type: 'string', description: 'Why this loop should stop, citing what you observed in its turns. Witnessed alongside the halt.' },
      },
      required: ['session_id', 'reason'],
    },
    execute: async (input, ctx) => {
      const { session_id, reason } = input || {};
      if (!session_id || !String(session_id).trim()) return { success: false, error: 'session_id is required' };
      if (!reason || !String(reason).trim()) {
        return { success: false, error: 'reason is required: a halt is witnessed, and an unexplained halt is not auditable' };
      }
      // Tenancy, belt and braces. The interrupt route pins JWT users to their
      // own org, but these tools call as an internal SERVICE caller, which by
      // design crosses orgs. So confirm here that the session the agent named
      // is actually one of ITS org's sessions before proposing a halt.
      // Without this, an agent that learned a session id from anywhere could
      // propose halting another tenant's loop.
      try {
        const list = await collectorCall('GET', '/api/v1/dev-sessions?limit=100', { orgId: ctx && ctx.orgId });
        const owned = Array.isArray(list && list.sessions) && list.sessions.some((s) => s.id === session_id);
        if (!owned) {
          return { success: false, error: `unknown session ${session_id} for this org` };
        }
      } catch (err) {
        return { success: false, error: `could not verify the session belongs to this org: ${err.message}` };
      }

      const { withApprovalGate } = require('./approvalGate');
      return withApprovalGate('loop_halt', input, async () => {
        try {
          const data = await collectorCall(
            'POST',
            `/api/v1/dev-sessions/${encodeURIComponent(session_id)}/interrupt`,
            { orgId: ctx && ctx.orgId, body: { reason } }
          );
          return { success: true, session_id, killed: !!(data && data.killed), reason };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, ctx || {});
    },
  },

  loop_suggest: {
    name: 'loop_suggest',
    description: "Advise what to run as a QLoop loop (or what to SCHEDULE instead). Reads the real open roadmap (QuoxPlan streams/phases) plus the currently-running loops, matches open work to the loopy-plugin recipe catalog, and returns ranked, mode-tagged proposals: mode:'loop' for open-ended compounding goals, mode:'schedule' for fixed-cadence work that must NOT be looped (looping a schedule pays a model to reason every tick for nothing). Pass an optional `situation` to get a straight loop-vs-schedule verdict on one specific thing. This is honest by design: it will tell you to cron something rather than loop it. Read-only; it never spawns anything, it proposes and you approve.",
    input_schema: {
      type: 'object',
      properties: {
        situation: { type: 'string', description: 'Optional: describe one specific job to get a loop-vs-schedule verdict on it (e.g. "drain the aging backlog" or "send a nightly status digest").' },
        limit: { type: 'number', description: 'Max proposals to return (default 5, max 25).' },
      },
      required: [],
    },
    execute: async ({ situation, limit }, ctx) => {
      // Both context reads are best-effort and degrade INDEPENDENTLY: the
      // advisor is still useful from its catalog + the situation gate when
      // QuoxPlan is unreachable or there is no org context for loop_sessions.
      let streams = [];
      try {
        streams = await quoxplanListStreams();
      } catch (err) {
        console.error(`[loop_suggest] roadmap read failed (advisor falls back to catalog): ${err.message}`);
      }
      let runningLoops = [];
      try {
        const data = await collectorCall('GET', '/api/v1/dev-sessions?limit=50', { orgId: ctx && ctx.orgId });
        runningLoops = Array.isArray(data && data.sessions) ? data.sessions : [];
      } catch (err) {
        // No org context or collector unreachable: skip running-loop dedup.
      }
      const { proposals, running, note } = buildProposals({ streams, runningLoops, situation, limit });
      return {
        success: true,
        count: proposals.length,
        running,
        note,
        roadmap_streams_read: streams.length,
        proposals,
      };
    },
  },
};

function getLoopToolDefinitions() {
  return Object.values(LOOP_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function executeLoopTool(name, input, ctx) {
  const tool = LOOP_TOOLS[name];
  if (!tool) throw new Error(`Unknown loop tool: ${name}`);
  return tool.execute(input || {}, ctx || {});
}

module.exports = {
  LOOP_TOOLS,
  getLoopToolDefinitions,
  executeLoopTool,
  summariseEvent,
};
