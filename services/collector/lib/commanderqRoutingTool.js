/**
 * CommanderQ outcome-learned routing advisory tool (COMMANDERQ P7 / B1+B2).
 *
 * Before delegating a task, Q can ask which specialist has the best empirical
 * track record for this KIND of task in THIS tenant. The answer is derived from
 * the signed routing_verdict artifacts P6 emits (completion vs breach/degrade,
 * latency), and cites the artifact_ids it is based on. Read-only; self-fetches
 * the governed /api/v1/commanderq/routing-profile route. Never throws.
 *
 * HONEST: this ranks by delegation RELIABILITY, not answer correctness. Q should
 * treat a low_confidence result (small sample) as a weak prior, not a verdict.
 */

'use strict';

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

async function callCollector(path, ctx) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY,
    ...(ctx && ctx.orgId ? { 'x-org-id': ctx.orgId } : {}),
    ...(ctx && ctx.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
  };
  try {
    const res = await fetch(`${COLLECTOR_URL}${path}`, { headers, signal: AbortSignal.timeout(15000) });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Collector unreachable (${err.message}).` } };
  }
}

const COMMANDERQ_ROUTING_TOOL = {
  delegation_router_advise: {
    name: 'delegation_router_advise',
    description: 'Before you delegate, consult the outcome-learned routing profile: which specialist has the best empirical track record for THIS kind of task in this tenant, derived from signed routing_verdict evidence (in-budget completion vs breach/degrade + latency), citing the artifact_ids it is based on. Pass task_class as a short stable snake_case label for the KIND of work (e.g. security_audit, fleet_status, code_review, network_diag, research) and delegate with the SAME task_class so the profile keeps learning. Returns a recommended_agent + ranked list; treat low_confidence (small sample) as a weak prior, not a verdict. It ranks reliability, NOT answer correctness. Omit task_class to see the whole per-agent profile.',
    input_schema: {
      type: 'object',
      properties: {
        task_class: { type: 'string', description: 'Short stable snake_case class for the KIND of task (e.g. security_audit, fleet_status). Omit to see the full profile across all classes.' },
        since: { type: 'string', description: 'Optional ISO8601 start of the window to learn from.' },
      },
    },
    async execute(input, ctx) {
      const params = new URLSearchParams();
      if (input && input.task_class) params.set('task_class', String(input.task_class));
      if (input && input.since) params.set('since', String(input.since));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const r = await callCollector(`/api/v1/commanderq/routing-profile${qs}`, ctx);
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `routing advice failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },
};

module.exports = { COMMANDERQ_ROUTING_TOOL };
