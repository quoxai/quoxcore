/**
 * CommanderQ PLAN tools (COMMANDERQ P5) — Plan-as-Artifact.
 *
 * Thin, never-throw self-fetch wrappers over the governed
 * /api/v1/artifacts/plan routes (defined in server.js). CommanderQ uses these
 * to turn a proposed plan into a SIGNED, WARD-witnessed, retrievable artifact
 * (P4 spine), approve-once + deviation-gated:
 *   - plan_artifact_create : mint a signed plan; if gated+approval.required the
 *                            route files ONE HITL approval card (never
 *                            auto-approves — a human resolves it).
 *   - plan_artifact_get    : fetch a plan artifact + its live verify verdict.
 *   - plan_artifact_diff   : compare declared steps vs actual; a gated plan that
 *                            deviated flags reapproval_required (deviation gate).
 *
 * Self-fetch helper is a local copy (same posture as commanderqReachTools /
 * commanderqWriteTools — each tool family stays independently reviewable).
 */

'use strict';

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 15000;

async function callCollector(path, ctx, { method = 'GET', body } = {}) {
  const url = `${COLLECTOR_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY,
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
    try { data = await res.json(); }
    catch { try { data = { raw: await res.text() }; } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Collector unreachable (${err.message}). Is it running on ${COLLECTOR_URL}?` } };
  }
}

const COMMANDERQ_PLAN_TOOLS = {
  plan_artifact_create: {
    name: 'plan_artifact_create',
    description: 'Turn a plan into a SIGNED, WARD-witnessed plan artifact (approve-once). Provide the plan title, a one-line intent, and the steps. Set deviation_policy to "gated" (re-approval required if execution deviates), "notify", or "free". If approval.required is true and the policy is gated, ONE human approval card is filed — you do NOT self-approve. Returns the artifact_id, its signature, whether an approval card was filed, and the verify verdict. Use this to commit to a plan before executing multi-step work.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short plan title.' },
        intent: { type: 'string', description: 'One line: what this plan is for.' },
        steps: {
          type: 'array',
          description: 'Ordered plan steps.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable step id (e.g. s1).' },
              description: { type: 'string' },
              tool: { type: 'string', description: 'Optional tool the step will use.' },
              agent: { type: 'string', description: 'Optional agent the step delegates to.' },
            },
            required: ['id', 'description'],
          },
        },
        deviation_policy: { type: 'string', enum: ['gated', 'notify', 'free'], description: 'gated = re-approve on deviation (default).' },
        approval_required: { type: 'boolean', description: 'Whether this plan needs human approval before execution (default true for gated).' },
      },
      required: ['title', 'intent', 'steps'],
    },
    async execute(input, ctx) {
      const deviation_policy = input.deviation_policy || 'gated';
      const approval_required = typeof input.approval_required === 'boolean'
        ? input.approval_required
        : (deviation_policy === 'gated');
      const r = await callCollector('/api/v1/artifacts/plan', ctx, {
        method: 'POST',
        body: {
          title: input.title,
          intent: input.intent,
          steps: Array.isArray(input.steps) ? input.steps : [],
          deviation_policy,
          approval: { required: approval_required },
        },
      });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `create failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  plan_artifact_get: {
    name: 'plan_artifact_get',
    description: 'Fetch a plan (or any) artifact by id and re-verify its signature. Returns the artifact plus a verify verdict (valid, signatureOk, keySource). Use to confirm a plan exists, is untampered, and is signed by the trust anchor before acting on it.',
    input_schema: {
      type: 'object',
      properties: { artifact_id: { type: 'string', description: 'The artifact id returned by plan_artifact_create.' } },
      required: ['artifact_id'],
    },
    async execute(input, ctx) {
      const id = encodeURIComponent(input.artifact_id || '');
      const r = await callCollector(`/api/v1/artifacts/${id}`, ctx, { method: 'GET' });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `get failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },

  plan_artifact_diff: {
    name: 'plan_artifact_diff',
    description: 'Compare a plan artifact\'s declared steps against what ACTUALLY happened. Provide actual_steps as [{id, status}] where status is done|skipped|changed. Returns matched/missing/extra/changed, whether the plan deviated, and reapproval_required (true only when a gated plan deviated — the deviation gate; the route files a fresh approval card in that case). Use before declaring a plan complete.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        actual_steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['done', 'skipped', 'changed'] },
            },
            required: ['id'],
          },
        },
      },
      required: ['artifact_id', 'actual_steps'],
    },
    async execute(input, ctx) {
      const id = encodeURIComponent(input.artifact_id || '');
      const r = await callCollector(`/api/v1/artifacts/plan/${id}/diff`, ctx, {
        method: 'POST',
        body: { actual_steps: Array.isArray(input.actual_steps) ? input.actual_steps : [] },
      });
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `diff failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },
};

module.exports = { COMMANDERQ_PLAN_TOOLS };
