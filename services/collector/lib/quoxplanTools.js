/**
 * QuoxPlan Agent Tools (QUOXPLAN-P4, write tools added QUOXPLAN-P7)
 *
 * Tool handlers giving ROADY (and the orchestrator) direct access to the
 * QuoxPlan store, which since the 2026-07-25 cutover IS the canonical Quox
 * roadmap (roadmap id quox-strategic) alongside the Meridian demo corpus.
 * The legacy roadmap_* tools are retired pointers; quoxplan_* is the only
 * live tool family.
 *
 * Reads (quoxplan_roadmaps, quoxplan_streams, quoxplan_stream_brief) fetch
 * the QuoxPlan server directly (same URL/env var the collector's
 * /api/v1/quoxplan/* proxy uses — server.js ~:8406), with a 5s timeout and a
 * graceful error string on any failure (network, timeout, non-2xx, bad JSON)
 * so a missing/unreachable QuoxPlan server never throws into the agent loop.
 * No evidence requirement for reads, so the direct hop is preferred for
 * lower latency.
 *
 * Injection hardening: the only user-controlled inputs are roadmap_id,
 * stream_id and lens, all of which are encodeURIComponent'd into the URL
 * path/query — never string-interpolated into a shell command or template
 * that could be reinterpreted, and `lens` is validated against an allowlist
 * before use (invalid values fall back to 'focus').
 *
 * QUOXPLAN-P7 write tools (quoxplan_add_note, quoxplan_set_status,
 * quoxplan_tick_phase, quoxplan_request_complete) route their mutating
 * calls through the collector's OWN /api/v1/quoxplan/* proxy (server.js
 * ~:8474) rather than hitting the QuoxPlan server directly — the proxy is
 * the ONLY place AEE emission (resolveQuoxplanAeeIntent/emitQuoxplanAEE) and
 * WARD witnessing happen, so a direct-to-server write would be unwitnessed
 * despite the tool descriptions' claims. Authenticated with X-Service-Key
 * (INTERNAL_SERVICE_KEY), which requireServiceOrUserAuth() accepts as a
 * service-to-service caller; x-org-id is forwarded when the calling agent's
 * ctx carries an orgId. Same fetch/timeout/error-shape discipline as reads,
 * plus two hard guardrails:
 *  - Post-cutover: quox-strategic is writable like any roadmap (the old
 *    read-replica refusal was lifted at cutover); every mutation is
 *    evented and AEE-witnessed at the governed proxy boundary.
 *  - COMPLETE guard: agents can never set a stream to COMPLETE directly.
 *    quoxplan_set_status refuses locally (never even calls the server);
 *    quoxplan_request_complete is the HITL escape hatch — it files an
 *    HITL Inbox approval (mirrors pushWazuhApproval, server.js ~:7005) and the
 *    actual COMPLETE PATCH + quoxplan.stream.completed AEE envelope only
 *    happen once the owner approves, via the collector's
 *    /api/internal/quoxplan/approvals/decide handler.
 */

const QUOXPLAN_URL = process.env.QUOXPLAN_URL || 'http://host.docker.internal:3107';
// QUOXPLAN-P7 governance fix: write tools no longer hit QUOXPLAN_URL
// directly — they go through the collector's own /api/v1/quoxplan/* proxy
// (same process, loopback), which is the sole boundary where AEE evidence
// is emitted for these mutations. See module doc comment above.
const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const FETCH_TIMEOUT_MS = 5000;
// Writes go through the collector's governed proxy, which waits up to 30s on QuoxPlan. The tool must wait LONGER,
// so a slow QuoxPlan gets a definite answer from the proxy instead of the tool aborting a write that may land
// (plan-proof-tick-phase ev_mvbytalv_e151b8, 2026-10-17).
const QUOXPLAN_WRITE_TIMEOUT_MS = 35000;
const VALID_LENSES = ['focus', 'tier', 'all'];

// HITL completion (quoxplan_request_complete, below): mints an HITL Inbox
// approval card directly, same shape as pushWazuhApproval (server.js ~:7005)
// — this module has no access to server.js's private helper, so the
// mint call is self-contained here. The decide callback lives in server.js
// at /api/internal/quoxplan/approvals/decide (mirrors /api/internal/wazuh/
// approvals/decide verbatim), which is where the actual COMPLETE PATCH and
// the quoxplan.stream.completed AEE envelope are issued once approved.
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const { mintInboxItem } = require('./inboxMint.js');

async function quoxplanGet(path) {
  const url = `${QUOXPLAN_URL}${path}`;
  let res;
  try {
    // QuoxPlan's serviceKeyGate requires X-Service-Key on reads as well as
    // writes (BRAIN2-AUDIT 2026-10-05: every agent read tool 401'd).
    const headers = {};
    if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`QuoxPlan server unreachable (${err.message}). Is it running on ${QUOXPLAN_URL}?`);
  }
  if (!res.ok) {
    let bodyExcerpt = '';
    try { bodyExcerpt = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`QuoxPlan server returned ${res.status} ${res.statusText}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`QuoxPlan server returned invalid JSON (${err.message})`);
  }
}

/** Shared POST/PATCH request helper (QUOXPLAN-P7 write tools). Routes
 * through the collector's own /api/v1/quoxplan/* proxy (server.js ~:8474),
 * NOT the QuoxPlan server directly — the proxy is the governed boundary
 * where AEE evidence is emitted for a successful mutation, so any write
 * that bypassed it would be silently unwitnessed. `path` is the
 * quoxplan-relative path WITHOUT the `/api/v1` prefix (e.g.
 * `/streams/CL-SUPPORT-KB/notes`); the proxy's own rewrite adds `/api/v1`
 * back on before forwarding to the QuoxPlan server, so passing it here too
 * would double it up.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY) — requireServiceOrUserAuth()
 * (utils/httpAuth.js) accepts this as a service-to-service caller. When the
 * calling tool's ctx carries an orgId (agent invocation context), it is
 * forwarded as x-org-id so the proxy can scope the mutation.
 *
 * Mirrors quoxplanGet's timeout/error-shape discipline: network failures,
 * timeouts and non-2xx responses all become a single readable Error whose
 * .message is safe to hand straight back to the agent as the "error" field.
 * 4xx bodies are JSON ({ error: '...' }); that message is folded into the
 * thrown error so validation failures (bad status, missing note body, etc.)
 * surface as readable text rather than a stack trace. */
async function quoxplanWrite(method, path, body, ctx) {
  const url = `${COLLECTOR_URL}/api/v1/quoxplan${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  if (ctx && ctx.orgId) headers['x-org-id'] = ctx.orgId;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(QUOXPLAN_WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout is an UNKNOWN outcome, not "unreachable": the proxy may already have applied the write, and
    // retrying a note would duplicate it.
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`QuoxPlan did not answer within ${Math.round(QUOXPLAN_WRITE_TIMEOUT_MS / 1000)}s, so this change may or may not have been applied. Read the stream back (quoxplan_stream_brief or quoxplan_notes) before retrying.`);
    }
    throw new Error(`QuoxPlan governed proxy unreachable (${err.message}). Is the collector running on ${COLLECTOR_URL}?`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* body may be empty/non-JSON */ }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `${res.status} ${res.statusText}`;
    throw new Error(`QuoxPlan server rejected the request (${res.status}): ${detail}`);
  }
  return json;
}

/**
 * Fetches a stream's full detail for write-path callers. Since the
 * 2026-07-25 cutover QuoxPlan IS the canonical roadmap store, so
 * quox-strategic is writable like any other roadmap (the pre-cutover
 * replica refusal is gone). COMPLETE stays owner-gated via the HITL flow.
 * Returns the detail object ({ stream, phases, ... }) so callers that also
 * need it (e.g. quoxplan_tick_phase resolving a phase id) don't fetch twice.
 * Throws a readable Error for "not found"; callers catch and wrap into
 * { success: false, error }.
 */
async function assertWritableStream(streamId) {
  const detail = await quoxplanGet(`/api/v1/streams/${encodeURIComponent(streamId)}`);
  if (!detail || !detail.stream) {
    throw new Error(`Stream "${streamId}" not found`);
  }
  return detail;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** Push a QuoxPlan stream-completion approval card to HITL Inbox. Mirrors
 * pushWazuhApproval's shape (server.js ~:7005): POST to the auth service's
 * internal inbox endpoint with the service key, kind='approval', and a
 * payload carrying the action + action_params + callback_url the collector's
 * decide endpoint expects. Returns { ok, itemId, error }. */
async function pushQuoxplanApproval({ orgId, title, bodyMd, actionParams }) {
  if (!INTERNAL_SERVICE_KEY) {
    console.error('[QuoxPlan HITL] INTERNAL_SERVICE_KEY not set — cannot push inbox approval');
    return { ok: false, itemId: null, error: 'INTERNAL_SERVICE_KEY not configured' };
  }
  const org = orgId || 'system';
  // quox#562: mechanics live in lib/inboxMint.js (one tested shape for the
  // auth 201 { item: { id } } and dedup 200 { existing_item_id } responses).
  const r = await mintInboxItem({
    orgId: org, title, bodyMd, kind: 'approval', priority: 'high',
    payload: {
      source: 'quoxplan',
      what: {
        action: 'mark stream COMPLETE',
        target: `stream ${actionParams?.streamId || actionParams?.stream_id || actionParams?.id || 'unknown'}`,
        summary: `mark QuoxPlan stream ${actionParams?.streamId || actionParams?.stream_id || actionParams?.id || 'unknown'} COMPLETE`,
      },
      action: 'quoxplan.stream.complete',
      action_params: actionParams,
      callback_url: '/api/internal/quoxplan/approvals/decide',
    },
  }, { authBaseUrl: AUTH_SERVICE_URL, serviceKey: INTERNAL_SERVICE_KEY });
  return { ok: r.ok, itemId: r.itemId, error: r.error };
}

/** Flattens the nested (substreams / tier-grouped) response of
 * GET /roadmaps/:id/streams into compact lines. */
function flattenStreamLines(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) flattenStreamLines(item, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  // Tier-grouped shape: { tier, streams: [...] }
  if (Array.isArray(node.streams)) {
    flattenStreamLines(node.streams, out);
    return out;
  }
  // Stream node shape (rowToStream + optional substreams/focus_reasons)
  if (node.id) {
    out.push({
      id: node.id,
      name: node.name,
      tier: node.tier,
      status: node.status,
      blocked_by: Array.isArray(node.depends_on) && node.depends_on.length > 0 ? node.depends_on : undefined,
    });
    if (Array.isArray(node.substreams) && node.substreams.length > 0) {
      flattenStreamLines(node.substreams, out);
    }
  }
  return out;
}

// ─── Org gate (CROSS-ORG LEAK FIX, 2026-08-15) ──────────────────────────────
// QuoxPlan is single-tenant today, and these tools hopped straight to it with
// no org check — so ANY org's MCP identity received the LIVE strategic
// roadmap (found by the field agent on a ExampleVPN dev server, confirmed by the
// owner). Until per-org QuoxPlan lands (DEVSUITE plan v6), the roadmap is
// served ONLY to the instance's owning org, recorded server-side in auth's
// instance_config under 'quoxplan.owner_org_id' (no env-only config; a
// Settings surface for it is filed). Fail-closed: unset key or missing
// caller org both deny.
const AUTH_SERVICE_URL_FOR_GATE = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
let _ownerOrgCache = { value: undefined, expires: 0 };

async function resolveQuoxplanOwnerOrgId() {
  if (_ownerOrgCache.expires > Date.now()) return _ownerOrgCache.value;
  try {
    const res = await fetch(`${AUTH_SERVICE_URL_FOR_GATE}/api/internal/instance/disposable-test`, {
      headers: { 'x-service-key': process.env.INTERNAL_SERVICE_KEY || '' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined; // do not cache failures
    const body = await res.json();
    _ownerOrgCache = { value: body.quoxplan_owner_org_id || null, expires: Date.now() + 60000 };
    return _ownerOrgCache.value;
  } catch {
    return undefined;
  }
}

const QUOXPLAN_ORG_DENIED =
  'QuoxPlan is not available to this organisation. The roadmap store is currently '
  + 'single-tenant and served only to the instance\'s owning organisation; '
  + 'per-organisation roadmaps are a registered roadmap item (DEVSUITE plan v6).';

// Test-only escape hatch: handler-logic suites predate the gate and test the
// handlers, not the gate; the gate suite flips this back on explicitly.
// globalThis-backed so it survives vi.resetModules() re-requires in the suite.
function _setOrgGateDisabledForTests(v) {
  globalThis.__QUOXPLAN_ORG_GATE_DISABLED__ = !!v;
  _ownerOrgCache = { value: undefined, expires: 0 };
}

async function quoxplanOrgGate(ctx) {
  if (globalThis.__QUOXPLAN_ORG_GATE_DISABLED__) return null;
  const ownerOrg = await resolveQuoxplanOwnerOrgId();
  if (ownerOrg === undefined) return { success: false, error: 'QuoxPlan org gate could not resolve the owning organisation (auth unreachable) — failing closed.' };
  if (!ownerOrg) return { success: false, error: 'QuoxPlan owner organisation is not configured on this instance (instance_config quoxplan.owner_org_id) — failing closed.' };
  const callerOrg = ctx && ctx.orgId;
  if (!callerOrg || callerOrg !== ownerOrg) return { success: false, error: QUOXPLAN_ORG_DENIED };
  return null;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const QUOXPLAN_TOOLS = {

  quoxplan_roadmaps: {
    name: 'quoxplan_roadmaps',
    description: 'List the QuoxPlan roadmaps (the LIVE canonical roadmap store since the 2026-07-25 cutover; org-gated to the Quox strategic roadmap). Returns each roadmap with a compact status-count breakdown. Use for "what roadmaps exist in QuoxPlan" or to resolve a roadmap name to its id.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      try {
        const data = await quoxplanGet('/api/v1/roadmaps');
        const roadmaps = (data.roadmaps || []).map((r) => ({
          id: r.id,
          name: r.name,
          stream_count: r.stream_count,
          status_counts: r.status_counts,
        }));
        return { success: true, count: roadmaps.length, roadmaps };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_streams: {
    name: 'quoxplan_streams',
    description: 'List streams in one QuoxPlan roadmap (the LIVE canonical roadmap store, org-gated to the owning organisation). Returns compact lines: id, name, tier, status, blocked_by. Default lens="focus" (what matters now: blockers, decisions needed, in-progress); use lens="all" for the full list or lens="tier" for tier-grouped. Use quoxplan_roadmaps first to find a roadmap_id.',
    input_schema: {
      type: 'object',
      properties: {
        roadmap_id: { type: 'string', description: 'QuoxPlan roadmap id (from quoxplan_roadmaps)' },
        lens: { type: 'string', enum: VALID_LENSES, description: 'focus (default), tier, or all' },
      },
      required: ['roadmap_id'],
    },
    execute: async ({ roadmap_id, lens }) => {
      if (!roadmap_id) return { success: false, error: 'roadmap_id is required' };
      const safeLens = VALID_LENSES.includes(lens) ? lens : 'focus';
      try {
        const data = await quoxplanGet(
          `/api/v1/roadmaps/${encodeURIComponent(roadmap_id)}/streams?lens=${encodeURIComponent(safeLens)}`
        );
        const streams = flattenStreamLines(data.streams, []);
        return { success: true, roadmap_id, lens: safeLens, count: streams.length, streams };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_notes: {
    name: 'quoxplan_notes',
    description: 'Read the FULL append-only note history for one QuoxPlan stream, newest first. quoxplan_stream_brief truncates notes to a few lines inside its context pack; this returns them in full so you can read the actual progress log / timeline. (Tooling audit 2026-09-21: roady had no clean note reader.)',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'QuoxPlan stream id' },
        limit: { type: 'number', description: 'Max notes to return (default 20, max 100)' },
      },
      required: ['stream_id'],
    },
    execute: async ({ stream_id, limit }) => {
      if (!stream_id) return { success: false, error: 'stream_id is required' };
      try {
        const detail = await quoxplanGet(`/api/v1/streams/${encodeURIComponent(stream_id)}`);
        if (!detail || !detail.stream) return { success: false, error: `Stream "${stream_id}" not found` };
        const allNotes = Array.isArray(detail.notes) ? detail.notes : [];
        const cap = Math.min(Math.max(1, parseInt(limit) || 20), 100);
        const notes = allNotes.slice(0, cap).map((n) => ({ created_at: n.created_at, author: n.author || null, body: n.body }));
        return { success: true, stream_id, count: notes.length, total: allNotes.length, notes };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_stream_brief: {
    name: 'quoxplan_stream_brief',
    description: 'Get a distilled context pack for one QuoxPlan stream (the LIVE canonical roadmap store, org-gated to the owning organisation): header, phase progress, latest notes, start of the plan doc, dependencies, and recent events. This is the orientation tool — use it before answering questions about a specific QuoxPlan stream.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'QuoxPlan stream id' },
      },
      required: ['stream_id'],
    },
    execute: async ({ stream_id }) => {
      if (!stream_id) return { success: false, error: 'stream_id is required' };
      try {
        const detail = await quoxplanGet(`/api/v1/streams/${encodeURIComponent(stream_id)}`);
        const { stream, phases = [], plan, notes = [], events = [], depends_on = [], dependents = [] } = detail;
        if (!stream) return { success: false, error: `Stream "${stream_id}" not found` };

        const phasesDone = phases.filter((p) => p.status === 'DONE').length;
        const lines = [];
        lines.push(`${stream.id} — ${stream.name} (tier ${stream.tier}, ${stream.status}, priority ${stream.priority})`);
        if (stream.summary) lines.push(stream.summary);
        lines.push(`Phases: ${phasesDone}/${phases.length} done` + (phases.length > 0
          // One phase per entry with its own number and status: the old "a, b ✓" list read as if the first was
          // done (plan-proof-tick-phase, 2026-10-17).
          ? ` (${phases.map((p, i) => `${p.seq ?? i + 1}. ${p.title}: ${p.status || 'TODO'}`).join('; ')})`
          : ''));

        const latestNotes = notes.slice(0, 3);
        if (latestNotes.length > 0) {
          lines.push('Latest notes:');
          for (const n of latestNotes) {
            lines.push(`- [${n.created_at}]${n.author ? ` ${n.author}:` : ''} ${truncate(n.body, 300)}`);
          }
        }

        if (plan && plan.body) {
          lines.push('Plan (excerpt):');
          lines.push(truncate(plan.body, 600));
        }

        if (depends_on.length > 0) {
          lines.push(`Depends on: ${depends_on.map((d) => `${d.id} (${d.status})`).join(', ')}`);
        }
        if (dependents.length > 0) {
          lines.push(`Dependents: ${dependents.map((d) => `${d.id} (${d.status})`).join(', ')}`);
        }

        const recentEvents = events.slice(0, 5);
        if (recentEvents.length > 0) {
          lines.push('Recent events:');
          for (const e of recentEvents) {
            lines.push(`- [${e.created_at}] ${e.verb} by ${e.actor}`);
          }
        }

        return {
          success: true,
          stream_id: stream.id,
          roadmap_id: stream.roadmap_id,
          context_pack: lines.join('\n'),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  // ─── Write tools (QUOXPLAN-P7) ──────────────────────────────────────────

  quoxplan_add_note: {
    name: 'quoxplan_add_note',
    description: 'Add a note to a QuoxPlan stream (mutates the LIVE canonical QuoxPlan store, org-gated to the owning organisation). Prefer reading first with quoxplan_stream_brief before writing. quox-strategic is the live Quox roadmap: write deliberately — the write routes through the collector\'s own governed proxy and is AEE-witnessed.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'QuoxPlan stream id to attach the note to' },
        note: { type: 'string', description: 'Note body text' },
      },
      required: ['stream_id', 'note'],
    },
    execute: async ({ stream_id, note }, ctx) => {
      if (!stream_id) return { success: false, error: 'stream_id is required' };
      if (!note || !String(note).trim()) return { success: false, error: 'note is required' };
      try {
        await assertWritableStream(stream_id);
        const actor = ctx && ctx.agentId ? `agent:${ctx.agentId}` : 'agent';
        const created = await quoxplanWrite('POST', `/streams/${encodeURIComponent(stream_id)}/notes`, {
          body: note,
          actor,
        }, ctx);
        return {
          success: true,
          stream_id,
          note_id: created ? created.id : null,
          created_at: created ? created.created_at : null,
          message: `Note added to ${stream_id}${created ? ` (note #${created.id})` : ''}.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_set_status: {
    name: 'quoxplan_set_status',
    description: 'Set a QuoxPlan stream\'s status (mutates the LIVE canonical QuoxPlan store, org-gated to the owning organisation). Valid statuses: NOT_STARTED, IN_PROGRESS, BLOCKED, DECISION_NEEDED. COMPLETE is refused — completion is owner-gated and must go through a human via the HITL approval flow. Prefer reading first with quoxplan_stream_brief before writing. quox-strategic is the live Quox roadmap: write deliberately — the write routes through the collector\'s own governed proxy and is AEE-witnessed.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'QuoxPlan stream id' },
        status: { type: 'string', description: 'NOT_STARTED, IN_PROGRESS, BLOCKED, or DECISION_NEEDED (COMPLETE is refused)' },
      },
      required: ['stream_id', 'status'],
    },
    execute: async ({ stream_id, status }, ctx) => {
      if (!stream_id) return { success: false, error: 'stream_id is required' };
      if (!status) return { success: false, error: 'status is required' };
      const normalized = String(status).trim().toUpperCase();
      if (normalized === 'COMPLETE') {
        return {
          success: false,
          error: 'Refused: marking a stream COMPLETE is owner-gated. Agents cannot set COMPLETE status directly — use quoxplan_request_complete to file an owner approval instead.',
        };
      }
      try {
        await assertWritableStream(stream_id);
        const actor = ctx && ctx.agentId ? `agent:${ctx.agentId}` : 'agent';
        const detail = await quoxplanWrite('PATCH', `/streams/${encodeURIComponent(stream_id)}`, {
          status: normalized,
          actor,
        }, ctx);
        return {
          success: true,
          stream_id,
          status: detail && detail.stream ? detail.stream.status : normalized,
          message: `${stream_id} status set to ${normalized}.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_tick_phase: {
    name: 'quoxplan_tick_phase',
    description: 'Mark a QuoxPlan stream phase DONE or TODO by its sequence number (mutates the LIVE canonical QuoxPlan store, org-gated to the owning organisation). Resolves the phase id via the stream detail, then updates its status. Prefer reading first with quoxplan_stream_brief before writing. quox-strategic is the live Quox roadmap: write deliberately — the write routes through the collector\'s own governed proxy and is AEE-witnessed.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'QuoxPlan stream id' },
        phase_seq: { type: 'number', description: 'Phase sequence number (1-based, from quoxplan_stream_brief or GET streams/:id)' },
        done: { type: 'boolean', description: 'true to mark DONE, false to mark TODO' },
      },
      required: ['stream_id', 'phase_seq', 'done'],
    },
    execute: async ({ stream_id, phase_seq, done }, ctx) => {
      if (!stream_id) return { success: false, error: 'stream_id is required' };
      if (phase_seq === undefined || phase_seq === null || Number.isNaN(Number(phase_seq))) {
        return { success: false, error: 'phase_seq is required (number)' };
      }
      try {
        const detail = await assertWritableStream(stream_id);
        const phases = Array.isArray(detail.phases) ? detail.phases : [];
        const phase = phases.find((p) => Number(p.seq) === Number(phase_seq));
        if (!phase) {
          return {
            success: false,
            error: `No phase with seq ${phase_seq} found on stream "${stream_id}" (stream has ${phases.length} phase(s)).`,
          };
        }
        const actor = ctx && ctx.agentId ? `agent:${ctx.agentId}` : 'agent';
        const targetStatus = done ? 'DONE' : 'TODO';
        await quoxplanWrite('PATCH', `/phases/${encodeURIComponent(phase.id)}`, {
          status: targetStatus,
          actor,
        }, ctx);
        return {
          success: true,
          stream_id,
          phase_id: phase.id,
          phase_seq: phase.seq,
          phase_title: phase.title,
          status: targetStatus,
          message: `Phase ${phase.seq} ("${phase.title}") on ${stream_id} set to ${targetStatus}.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_add_phase: {
    name: 'quoxplan_add_phase',
    description: 'Add a new phase (checklist item) to an existing QuoxPlan stream (mutates the LIVE canonical QuoxPlan store, org-gated to the owning organisation — formerly mislabelled as demo data, NOT the live Quox roadmap unless targeting quox-strategic). Appends at the end by default; pass seq to insert at a specific 1-based position. The write routes through the collector\'s own governed proxy and is AEE-witnessed.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'QuoxPlan stream id' },
        title: { type: 'string', description: 'Phase title/description' },
        seq: { type: 'number', description: 'Optional 1-based position to insert at (omit to append at the end)' },
      },
      required: ['stream_id', 'title'],
    },
    execute: async ({ stream_id, title, seq }, ctx) => {
      if (!stream_id) return { success: false, error: 'stream_id is required' };
      if (!title || !String(title).trim()) return { success: false, error: 'title is required' };
      try {
        const before = await assertWritableStream(stream_id);
        const beforeIds = new Set((before.phases || []).map((p) => p.id));
        const actor = ctx && ctx.agentId ? `agent:${ctx.agentId}` : 'agent';
        const body = { title, actor };
        if (seq !== undefined && seq !== null) body.seq = seq;
        const result = await quoxplanWrite('POST', `/streams/${encodeURIComponent(stream_id)}/phases`, body, ctx);
        const phases = Array.isArray(result && result.phases) ? result.phases : [];
        const added = phases.find((p) => !beforeIds.has(p.id)) || null;
        return {
          success: true,
          stream_id,
          phase: added,
          total_phases: phases.length,
          message: `Phase "${title}" added to ${stream_id}.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_create_stream: {
    name: 'quoxplan_create_stream',
    description: 'Create a new stream on a QuoxPlan roadmap (mutates the LIVE canonical QuoxPlan store, org-gated to the owning organisation — formerly mislabelled as demo data, NOT the live Quox roadmap unless targeting quox-strategic). Refuses if the stream id already exists on that roadmap. The write routes through the collector\'s own governed proxy and is AEE-witnessed.',
    input_schema: {
      type: 'object',
      properties: {
        roadmap_id: { type: 'string', description: 'Roadmap to create the stream on (e.g. quox-strategic)' },
        id: { type: 'string', description: 'New stream id, must be unique on the roadmap' },
        name: { type: 'string', description: 'Stream name/title' },
        summary: { type: 'string', description: 'Optional stream summary' },
        tier: { type: 'number', description: 'Optional tier 0-5 (default 3)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Optional stream ids this depends on' },
        parent_id: { type: 'string', description: 'Optional parent stream id (for a substream)' },
      },
      required: ['roadmap_id', 'id', 'name'],
    },
    execute: async ({ roadmap_id, id, name, summary, tier, tags, depends_on, parent_id }, ctx) => {
      if (!roadmap_id) return { success: false, error: 'roadmap_id is required' };
      if (!id) return { success: false, error: 'id is required' };
      if (!name || !String(name).trim()) return { success: false, error: 'name is required' };
      try {
        const actor = ctx && ctx.agentId ? `agent:${ctx.agentId}` : 'agent';
        const body = { id, name, actor };
        if (summary !== undefined) body.summary = summary;
        if (tier !== undefined) body.tier = tier;
        if (tags !== undefined) body.tags = tags;
        if (depends_on !== undefined) body.depends_on = depends_on;
        if (parent_id !== undefined) body.parent_id = parent_id;
        const result = await quoxplanWrite('POST', `/roadmaps/${encodeURIComponent(roadmap_id)}/streams`, body, ctx);
        return {
          success: true,
          roadmap_id,
          stream_id: id,
          stream: (result && result.stream) || null,
          message: `Stream "${id}" created on roadmap ${roadmap_id}.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxplan_request_complete: {
    name: 'quoxplan_request_complete',
    description: 'Request that a QuoxPlan stream be marked COMPLETE (mutates the LIVE canonical QuoxPlan store, org-gated to the owning organisation). Agents cannot set COMPLETE directly (see quoxplan_set_status); this files an owner approval in the HITL inbox instead. Returns immediately with an "awaiting_approval" status and the inbox item id — completion only happens once the owner approves. Works on any roadmap including quox-strategic (the live Quox roadmap).',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'QuoxPlan stream id to request completion for' },
        reason: { type: 'string', description: 'Why this stream is considered done — shown to the owner on the approval card' },
      },
      required: ['stream_id', 'reason'],
    },
    execute: async ({ stream_id, reason }, ctx) => {
      if (!stream_id) return { success: false, error: 'stream_id is required' };
      if (!reason || !String(reason).trim()) return { success: false, error: 'reason is required' };
      try {
        const detail = await assertWritableStream(stream_id);
        const streamName = detail.stream ? detail.stream.name : stream_id;
        const roadmapId = detail.stream ? detail.stream.roadmap_id : undefined;
        const requester = ctx && ctx.agentId ? `agent:${ctx.agentId}` : 'agent';
        const orgId = (ctx && ctx.orgId) || null;

        const bodyMd = [
          '**QuoxPlan Stream Completion Request**',
          '',
          '| Field | Value |',
          '|-------|-------|',
          `| Stream | \`${stream_id}\` — ${streamName} |`,
          `| Roadmap | \`${roadmapId}\` |`,
          `| Requested by | \`${requester}\` |`,
          `| Reason | ${reason} |`,
          '',
          'Approving will mark this stream COMPLETE in QuoxPlan.',
        ].join('\n');

        const approval = await pushQuoxplanApproval({
          orgId,
          title: `QuoxPlan: Mark ${stream_id} COMPLETE`,
          bodyMd,
          actionParams: { stream_id, reason, requester, org_id: orgId },
        });

        if (!approval.ok) {
          return { success: false, error: `Failed to queue approval: ${approval.error}` };
        }

        return {
          success: true,
          stream_id,
          status: 'awaiting_approval',
          inbox_item_id: approval.itemId,
          message: `Completion request for ${stream_id} queued for owner approval (inbox item ${approval.itemId}).`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

function getQuoxplanToolDefinitions() {
  return Object.values(QUOXPLAN_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function executeQuoxplanTool(name, input, ctx) {
  const tool = QUOXPLAN_TOOLS[name];
  if (!tool) throw new Error(`Unknown quoxplan tool: ${name}`);
  return tool.execute(input || {}, ctx || {});
}

// Apply the org gate to EVERY quoxplan tool uniformly — reads leak exactly
// like writes (the live roadmap IS the sensitive content).
for (const tool of Object.values(QUOXPLAN_TOOLS)) {
  const inner = tool.execute;
  tool.execute = async (args, ctx) => {
    const denied = await quoxplanOrgGate(ctx);
    if (denied) return denied;
    return inner(args, ctx);
  };
}

module.exports = {
  QUOXPLAN_TOOLS,
  QUOXPLAN_WRITE_TIMEOUT_MS,
  getQuoxplanToolDefinitions,
  executeQuoxplanTool,
  resolveQuoxplanOwnerOrgId,
  quoxplanOrgGate,
  _setOrgGateDisabledForTests,
};
