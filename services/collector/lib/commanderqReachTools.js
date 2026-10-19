/**
 * CommanderQ Reachability Tools (COMMANDERQ-P2, read-only)
 *
 * Six read-only tools wiring CommanderQ (QUOX orchestrator) to collector
 * routes it currently has no tool path to: the AGH-Chain honesty
 * leaderboard, NOC tool-outcome telemetry, DoneEngine readiness snapshots,
 * QuoxLens findings/lenses, GRC compliance artifacts, and governance policy
 * state. Every call is a self-fetch back into the collector's OWN routes on
 * loopback (http://localhost:9848), same governed-boundary discipline as
 * quoxplanTools.js's quoxplanWrite — authenticated with X-Service-Key
 * (INTERNAL_SERVICE_KEY, accepted by requireServiceOrUserAuth() as a
 * service-to-service caller) plus x-org-id forwarded from the calling
 * agent's ctx so org-scoped routes see the right tenant.
 *
 * All six are READS. No write/mutate verb is exposed here by design —
 * governance_read explicitly excludes the enable/resolve policy mutations
 * that live alongside the routes it reads.
 *
 * readCollector() never throws past a tool: network failure, timeout, non-2xx
 * status and bad JSON all resolve to a value the caller can inspect (status +
 * body), so a missing snapshot (404) or an unentitled plugin (403) surfaces
 * as data rather than crashing the agent loop.
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const FETCH_TIMEOUT_MS = 15000;
// QUOXTRUST v1.1 PB3 (cross-tenant repeatability finding): org scoping MUST use
// the shared helper so an authenticated ctx.orgId always wins over a
// caller/LLM-supplied input.org_id. These compliance tools were added after the
// F1 fix (toolExecuteOrgScope) and reintroduced the banned inverted precedence.
const { resolveToolOrgId } = require('./toolExecuteOrgScope.js');

/** Self-fetch helper: GET or POST the collector's own routes on loopback.
 * Returns { ok, status, data } — `ok` mirrors res.ok, `data` is the parsed
 * JSON body (or a { raw } wrapper if the body isn't JSON). Never throws;
 * network/timeout failures resolve to { ok: false, status: 0, data: { error } }. */
async function readCollector(path, ctx, { method = 'GET', body } = {}) {
  const url = `${COLLECTOR_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
    ...(ctx && ctx.orgId ? { 'x-org-id': ctx.orgId } : {}),
    ...(ctx && ctx.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
  };
  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      try { data = { raw: await res.text() }; } catch { data = null; }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Collector unreachable (${err.message}). Is it running on ${COLLECTOR_URL}?` } };
  }
}

function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

const COMMANDERQ_REACH_TOOLS = {

  agh_chain_leaderboard: {
    name: 'agh_chain_leaderboard',
    description: 'Read the AGH-Chain agent self-correction/honesty leaderboard: which agents have been reliable vs. failing/self-correcting recently, per-agent event history, org-wide correction log, and chain status. Consult this BEFORE delegating a risky or high-stakes task to an agent — it tells you which agent has been reliable lately and which has been flagging its own mistakes.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['org', 'agent', 'events', 'corrections', 'status'], description: 'org (default): org-wide leaderboard; agent: one agent\'s leaderboard entry; events: one agent\'s scored events; corrections: org-wide correction log; status: chain health status' },
        agent_id: { type: 'string', description: 'Required for action=agent or action=events' },
        window: { type: 'string', enum: ['24h', '7d', '30d'], description: 'Time window (default 7d server-side)' },
        guard: { type: 'string', description: 'Optional guard filter for action=events' },
        limit: { type: 'number', description: 'Optional limit for action=corrections' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      // Models reach for the word they see ("leaderboard", "board"): those mean the org view.
      const raw = String(input.action || 'org').toLowerCase();
      const action = ['leaderboard', 'board', 'org-wide', 'all'].includes(raw) ? 'org' : raw;
      try {
        let path;
        if (action === 'org') {
          path = `/api/v1/agh-chain/leaderboard${qs({ window: input.window })}`;
        } else if (action === 'agent') {
          if (!input.agent_id) return { success: false, error: 'agent_id is required for action=agent' };
          path = `/api/v1/agh-chain/leaderboard/${encodeURIComponent(input.agent_id)}${qs({ window: input.window })}`;
        } else if (action === 'events') {
          if (!input.agent_id) return { success: false, error: 'agent_id is required for action=events' };
          path = `/api/v1/agh-chain/leaderboard/${encodeURIComponent(input.agent_id)}/events${qs({ window: input.window, guard: input.guard })}`;
        } else if (action === 'corrections') {
          path = `/api/v1/agh-chain/corrections${qs({ window: input.window, limit: input.limit })}`;
        } else if (action === 'status') {
          path = '/api/v1/agh-chain/status';
        } else {
          return { success: false, error: `Unknown action "${action}"` };
        }
        const { ok, status, data } = await readCollector(path, ctx);
        if (!ok) return { success: false, error: `AGH-Chain returned ${status}`, status, data };
        return { success: true, action, ...data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  noc_tool_outcomes: {
    name: 'noc_tool_outcomes',
    description: 'Read NOC tool-execution outcome telemetry: raw call log (tool, agent, org, success, duration, timestamp) or aggregated per-tool success-rate/error-count stats over a rolling window. For "which tools fail most often / success rate" ALWAYS use stats=true with a window (one small per-tool table; raw rows are huge and cannot be summarised without a shell). Use to check whether a specific tool or agent has been failing lately before relying on it.',
    input_schema: {
      type: 'object',
      properties: {
        stats: { type: 'boolean', description: 'true for aggregated stats (window defaults to 7d); false (default, capped at 50 rows unless limit given) for raw outcome rows' },
        window: { type: 'string', enum: ['1h', '24h', '7d', '30d'], description: 'Rolling window for stats=true (default 7d)' },
        tool: { type: 'string', description: 'Filter by tool name' },
        agent: { type: 'string', description: 'Filter by agent id' },
        orgId: { type: 'string', description: 'Filter by org id (defaults to caller org if omitted)' },
        success: { type: 'boolean', description: 'Filter raw rows by success/failure (raw mode only)' },
        since: { type: 'string', description: 'ISO date — only rows after this time (raw mode only)' },
        limit: { type: 'number', description: 'Max rows to return (raw mode only)' },
        offset: { type: 'number', description: 'Pagination offset (raw mode only)' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const stats = !!input.stats;
      if (stats && !input.window) input = { ...input, window: '7d' };
      if (!stats && !(Number(input.limit) > 0)) input = { ...input, limit: 50 };
      try {
        const orgId = input.orgId || (ctx && ctx.orgId) || undefined;
        const path = stats
          ? `/noc/tool-outcomes/stats${qs({ window: input.window, tool: input.tool, agent: input.agent, orgId })}`
          : `/noc/tool-outcomes${qs({ tool: input.tool, agent: input.agent, orgId, success: input.success, since: input.since, limit: input.limit, offset: input.offset })}`;
        const { ok, status, data } = await readCollector(path, ctx);
        if (!ok) return { success: false, error: `NOC tool-outcomes returned ${status}`, status, data };
        return { success: true, stats, ...data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  doneengine_readiness: {
    name: 'doneengine_readiness',
    description: 'Read DoneEngine readiness (the "quox done" instrument). action=board: the ESTATE BOARD, every surface with its score and gate counts (use it for any per-surface score or for how many surfaces there are; pass surface=<NAME> for one row). action=latest / list: per-pack readiness SNAPSHOTS (launch-spine, dev-suite). All of these are recorded readings, not a live measurement: always tell the user when it was taken (taken_at / age_days), and say so when stale=true. For a live reading the user runs refresh_command or live_command. Never suggest gauge.mjs. Absence of a reading is absence of evidence, not proof of readiness or unreadiness, and is reported honestly, not as an error.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['board', 'list', 'latest'], description: 'board (estate board: every surface and its score), list (all pack snapshots) or latest (default: newest pack snapshot)' },
        pack: { type: 'string', description: 'Pack name filter for action=latest' },
        surface: { type: 'string', description: 'For action=board: one surface name (e.g. COLLECTOR_AUTH)' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const action = input.action || 'latest';
      if (action === 'board') {
        try {
          const { ok, status, data } = await readCollector(`/api/v1/doneengine/board${qs({ surface: input.surface })}`, ctx);
          if (!ok) {
            if (status === 404 && data && data.error === 'no_board') return { success: true, no_board: true, message: data.message, refresh_command: data.refresh_command };
            return { success: false, error: `DoneEngine board returned ${status}`, status, data };
          }
          const compact = (s) => s && ({ surface: s.surface, score: s.score, attested: `${s.attested_passed}/${s.attested_total}`, machine: `${s.machine_passed}/${s.machine_total}`, status_doc: s.file });
          const out = { success: true, action, taken_at: data.taken_at, age_days: data.age_days, stale: data.stale, refresh_command: data.refresh_command, surface_count: data.surface_count };
          if (input.surface) { out.surface = compact(data.surface); if (!data.surface) out.known_surfaces = data.known_surfaces; }
          else out.surfaces = (data.board && data.board.surfaces || []).map(compact);
          return out;
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
      try {
        const path = action === 'list'
          ? '/api/v1/doneengine/snapshots'
          : `/api/v1/doneengine/snapshots/latest${qs({ pack: input.pack })}`;
        const { ok, status, data } = await readCollector(path, ctx);
        if (!ok) {
          if (status === 404 && data && data.error === 'no_snapshot') {
            return { success: true, no_snapshot: true, message: data.message || 'No DoneEngine readiness snapshot exists yet.', refresh_command: data.refresh_command, live_command: data.live_command };
          }
          return { success: false, error: `DoneEngine returned ${status}`, status, data };
        }
        return { success: true, action, ...data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxlens_read: {
    name: 'quoxlens_read',
    description: 'Read QuoxLens: available lenses, one lens by id, all drift findings scopes, or one findings scope in full (findings, lifecycle state, evidence quotes). Requires the org to hold the quoxlens plugin entitlement — an unentitled org gets a clear error instead of a raw 403.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lenses', 'lens', 'findings', 'finding'], description: 'lenses: list all lenses; lens: one lens by id; findings (default): list findings scopes; finding: one findings scope in full' },
        id: { type: 'string', description: 'Lens id, required for action=lens' },
        scope: { type: 'string', description: 'Findings scope path suffix (e.g. "sweep/target"), required for action=finding' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const action = input.action || 'findings';
      try {
        let path;
        if (action === 'lenses') {
          path = '/api/v1/lens/lenses';
        } else if (action === 'lens') {
          if (!input.id) return { success: false, error: 'id is required for action=lens' };
          path = `/api/v1/lens/lenses/${encodeURIComponent(input.id)}`;
        } else if (action === 'findings') {
          path = '/api/v1/lens/findings';
        } else if (action === 'finding') {
          if (!input.scope) return { success: false, error: 'scope is required for action=finding' };
          path = `/api/v1/lens/findings/${input.scope}`;
        } else {
          return { success: false, error: `Unknown action "${action}". Use one of: lenses, lens, findings (lists the findings scopes), finding.` }; // 2026-10-17: a model that guessed ("scopes") gets it right next call
        }
        const { ok, status, data } = await readCollector(path, ctx);
        if (!ok) {
          if (status === 403) return { success: false, error: 'quoxlens not entitled for this org' };
          return { success: false, error: `QuoxLens returned ${status}`, status, data };
        }
        return { success: true, action, ...data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  compliance_read: {
    name: 'compliance_read',
    description: 'Read GRC compliance artifacts: SoA (Statement of Applicability, ISO 27001), DPIA (GDPR Art.35 privacy impact assessments), or EU AI Act system classifications. Omit id to list all artifacts of that type for the org; pass id to get one in full. extra="definitions" (soa) or extra="questions" (classification) fetches the reference question/control trees instead.',
    input_schema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', enum: ['soa', 'dpia', 'classification'], description: 'Which compliance artifact family to read' },
        id: { type: 'string', description: 'Specific artifact id (omit to list)' },
        org_id: { type: 'string', description: 'Org to scope the query to (defaults to caller org)' },
        extra: { type: 'string', enum: ['definitions', 'questions'], description: 'soa: "definitions" for ISO control reference; classification: "questions" for the EU AI Act question tree' },
      },
      required: ['artifact'],
    },
    execute: async (input, ctx) => {
      if (!input.artifact) return { success: false, error: 'artifact is required' };
      const orgId = resolveToolOrgId(ctx, input);
      try {
        let path;
        if (input.artifact === 'soa' && input.extra === 'definitions') {
          path = '/api/v1/compliance/soa/definitions';
        } else if (input.artifact === 'classification' && input.extra === 'questions') {
          path = '/api/v1/compliance/classification/questions';
        } else if (input.id) {
          // #937: the by-id read dropped org_id, so resolveComplianceOrgId got null for a service
          // caller and orgOwns() 404'd every fetch. Scope it like the list path below.
          path = `/api/v1/compliance/${input.artifact}/${encodeURIComponent(input.id)}${qs({ org_id: orgId })}`;
        } else {
          path = `/api/v1/compliance/${input.artifact}${qs({ org_id: orgId })}`;
        }
        const { ok, status, data } = await readCollector(path, ctx);
        if (!ok) return { success: false, error: `Compliance API returned ${status}`, status, data };
        return { success: true, artifact: input.artifact, ...data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  governance_read: {
    name: 'governance_read',
    description: 'Read governance policy state (READ-ONLY: no enable/resolve/mutate action is exposed here). pending_approvals: policy approvals awaiting a decision. pack_conflicts: dry-run check of conflicts a policy pack WOULD introduce (does not enable it). history: policy change history, org-wide or for one policy_id.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pending_approvals', 'pack_conflicts', 'history'], description: 'Which governance read to perform' },
        pack_id: { type: 'string', description: 'Policy pack id, required for action=pack_conflicts' },
        org_id: { type: 'string', description: 'Org to scope to (defaults to caller org)' },
        policy_id: { type: 'string', description: 'Optional policy id for action=history (per-policy history instead of org-wide)' },
      },
      required: ['action'],
    },
    execute: async (input, ctx) => {
      if (!input.action) return { success: false, error: 'action is required' };
      const orgId = resolveToolOrgId(ctx, input);
      try {
        let result;
        if (input.action === 'pending_approvals') {
          // Route requires org_id even for service callers (returns 400 without).
          result = await readCollector(`/api/v1/policies/approvals/pending${qs({ org_id: orgId })}`, ctx);
        } else if (input.action === 'pack_conflicts') {
          if (!input.pack_id) return { success: false, error: 'pack_id is required for action=pack_conflicts' };
          // Dry-run conflict check only — does NOT enable the pack.
          result = await readCollector(
            `/api/v1/policies/templates/${encodeURIComponent(input.pack_id)}/conflicts`,
            ctx,
            { method: 'POST', body: { org_id: orgId } }
          );
        } else if (input.action === 'history') {
          result = input.policy_id
            ? await readCollector(`/api/v1/policies/${encodeURIComponent(input.policy_id)}/history`, ctx)
            : await readCollector(`/api/v1/policies/history${qs({ org_id: orgId })}`, ctx);
        } else {
          return { success: false, error: `Unknown action "${input.action}"` };
        }
        const { ok, status, data } = result;
        if (!ok) return { success: false, error: `Governance API returned ${status}`, status, data };
        return { success: true, action: input.action, ...data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

module.exports = { COMMANDERQ_REACH_TOOLS };
