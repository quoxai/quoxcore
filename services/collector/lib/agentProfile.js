/**
 * Agent Profile Composer — QSKL-AP-1
 *
 * Composes per-agent capability inventory from multiple sources:
 *   - skill_count + top_5_skills: GET ${QUOXFLOW_URL}/api/quox-skills?agentId=...
 *   - tool_count + top_5_tools:   AGENT_TOOLS[agentId] (local, no HTTP hop)
 *   - workflow_count:              GET ${QUOXFLOW_URL}/api/workflows/count?agentId=...
 *
 * Anti-placeholder discipline (feedback_no_placeholder_shipping_2026_05_12.md):
 *   - Unknown agent → AGENT_NOT_FOUND error (status 404), never 200 with zeros.
 *   - quoxflow unavailable for skills → UPSTREAM_UNREACHABLE (status 503).
 *   - Upstream endpoint missing (404) → field OMITTED from response, not defaulted to 0.
 *   - Honest zero from a working endpoint → field IS 0 (correct signal).
 */

'use strict';

const { AGENT_TOOLS } = require('./agentTools.js');

const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Normalise a skill record to the AP-1 shape.
 * lastUsedAt is OMITTED (not set to null) when the source field is absent.
 */
function normaliseSkill(s) {
  const out = {
    id: s.id,
    name: s.name,
    category: s.category,
    version: s.version,
  };
  const luat = s.lastUsedAt || s.last_used_at;
  if (luat) out.lastUsedAt = luat;
  return out;
}

/**
 * Build a headers object for quoxflow calls.
 * Passes through the caller's Authorization header when present.
 */
function buildHeaders(ctx) {
  const headers = { 'Content-Type': 'application/json' };
  if (ctx && ctx.authHeader) headers.Authorization = ctx.authHeader;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (serviceKey) headers['X-Service-Key'] = serviceKey;
  // QF-MT: quoxflow's auth middleware resolves X-Service-Key BEFORE the
  // bearer, so the caller's org must ride the X-Org-Id header — the ?orgId=
  // query param (withOrg) is ignored on the service path and the read
  // degrades to unscoped system scope (advisory-logged, 403 once enforced).
  if (ctx && ctx.orgId) headers['X-Org-Id'] = ctx.orgId;
  return headers;
}

/**
 * Append orgId query param when the context supplies one.
 */
function withOrg(url, ctx) {
  if (ctx && ctx.orgId) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}orgId=${encodeURIComponent(ctx.orgId)}`;
  }
  return url;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a profile for a single agent.
 *
 * @param {string} agentId
 * @param {{ orgId?: string, authHeader?: string, emitEnvelope?: Function }} ctx
 * @returns {Promise<object>} Profile object — fields with no honest source are omitted.
 * @throws {{ code: 'AGENT_NOT_FOUND', status: 404 }} when agentId is not in AGENT_TOOLS.
 * @throws {{ code: 'UPSTREAM_UNREACHABLE', status: 503 }} when quoxflow skills call fails.
 */
async function getAgentProfile(agentId, ctx = {}) {
  // Lookup is done against lowercase keys since AGENT_TOOLS uses lowercase IDs.
  const agentKey = (agentId || '').toLowerCase();
  if (!AGENT_TOOLS[agentKey]) {
    const err = new Error(`Unknown agent: ${agentId}`);
    err.code = 'AGENT_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const headers = buildHeaders(ctx);

  // ── Parallel fetches ──────────────────────────────────────────────────────
  // skills: required — 503 propagated if unavailable
  // workflows: optional — field omitted on failure or missing endpoint

  const skillsUrl = withOrg(
    `${QUOXFLOW_URL}/api/quox-skills?agentId=${encodeURIComponent(agentKey)}&limit=5&orderBy=last_used_at&order=desc`,
    ctx
  );
  const workflowsUrl = withOrg(
    `${QUOXFLOW_URL}/api/workflows/count?agentId=${encodeURIComponent(agentKey)}`,
    ctx
  );

  // Workflow fetch is silenced on network error — endpoint may not exist yet.
  // Wrapped in Promise.resolve().then() so that if fetch() itself throws synchronously
  // (e.g. in tests where the mock returns undefined), the catch still fires.
  const [skillsRes, workflowsRes] = await Promise.all([
    fetch(skillsUrl, { headers }),
    Promise.resolve().then(() => fetch(workflowsUrl, { headers })).catch(() => null),
  ]);

  // Skills call is mandatory — propagate as 503 if unavailable.
  if (!skillsRes.ok) {
    const err = new Error('quoxflow unreachable or returned error for skills');
    err.code = 'UPSTREAM_UNREACHABLE';
    err.status = 503;
    throw err;
  }

  const skillsBody = await skillsRes.json();
  // The quox-skills route wraps in { success, data, meta }
  const skillRecords = Array.isArray(skillsBody.data) ? skillsBody.data :
    Array.isArray(skillsBody.skills) ? skillsBody.skills : [];
  const top5Skills = skillRecords.slice(0, 5).map(normaliseSkill);

  // skill_count: use meta.total when exposed, otherwise count returned records.
  let skillCount;
  if (typeof skillsBody.meta?.total === 'number') {
    skillCount = skillsBody.meta.total;
  } else {
    // meta.total absent (e.g. older endpoint) — use array length as best estimate.
    skillCount = skillRecords.length;
  }

  const tools = AGENT_TOOLS[agentKey];

  const profile = {
    agentId: agentKey,
    skill_count: skillCount,
    tool_count: tools.length,
    top_5_skills: top5Skills,
    top_5_tools: tools.slice(0, 5),
  };

  // ── workflow_count: only when endpoint responded with valid data ──────────
  // Omit (not zero) when: fetch threw, endpoint returned 404, or response has no count.
  if (workflowsRes && workflowsRes.ok) {
    try {
      const wBody = await workflowsRes.json();
      // Endpoint returns { success, data: { count } }
      const rawCount = wBody.data?.count ?? wBody.count;
      if (typeof rawCount === 'number') {
        profile.workflow_count = rawCount;
      }
      // If count is missing/not-a-number, field stays omitted — not defaulted to 0.
    } catch (_) {
      // JSON parse failure — omit field.
    }
  }
  // Else: workflowsRes null (network error) or !ok (404, 503) — field omitted.

  // ── AOCL emit ─────────────────────────────────────────────────────────────
  if (typeof ctx.emitEnvelope === 'function') {
    try {
      await ctx.emitEnvelope({
        intent: 'agent.profile.read',
        payload: { agentId: agentKey, fieldsReturned: Object.keys(profile) },
      });
    } catch (_) {
      // Emit failure must NOT propagate — it's observability, not data.
    }
  }

  return profile;
}

/**
 * Build a summary across all registered agents.
 * Per-agent failures are captured as { agentId, error } entries — never abort the sweep.
 *
 * @param {{ orgId?: string, authHeader?: string }} ctx
 * @returns {Promise<object>}
 */
async function getProfileSummary(ctx = {}) {
  const agentIds = Object.keys(AGENT_TOOLS);

  // Bounded concurrency: 78 agents × 2 upstream fetches saturates quoxflow's
  // connection pool and yields ~60% UPSTREAM_UNREACHABLE. 8-wide keeps
  // tail latency in line and gives every agent a real chance to resolve.
  const CONCURRENCY = 8;
  const profiles = new Array(agentIds.length);
  let cursor = 0;
  async function worker() {
    while (cursor < agentIds.length) {
      const i = cursor++;
      const id = agentIds[i];
      try {
        profiles[i] = await getAgentProfile(id, ctx);
      } catch (err) {
        profiles[i] = {
          agentId: id,
          error: err.code || err.message || 'PROFILE_FAILED',
        };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const valid = profiles.filter(p => !p.error);

  return {
    agent_count: agentIds.length,
    skill_total: valid.reduce((sum, p) => sum + (p.skill_count ?? 0), 0),
    tool_total: valid.reduce((sum, p) => sum + (p.tool_count ?? 0), 0),
    workflow_total: valid.reduce((sum, p) => sum + (p.workflow_count ?? 0), 0),
    per_agent: profiles,
  };
}

module.exports = { getAgentProfile, getProfileSummary };
