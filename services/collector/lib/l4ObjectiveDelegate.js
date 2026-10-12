/**
 * AUDIT-REAL-4a — L4 objective delegation.
 *
 * Wires L4's shouldOrchestrate/createObjective hooks (see l4Planner.js) to
 * the real tasks service. Kept as small, independently-testable factories
 * so the stack-mode caller only has to close over per-request values
 * (the allow_orchestration flag, service credentials) rather than
 * reimplement policy/HTTP logic inline.
 *
 * Governance: chat-originated objective creation is an ACT, not a passive
 * read. shouldOrchestrate() requires explicit opt-in via
 * req.body.allow_orchestration === true (threaded through as
 * `allowOrchestration`) AND a plan with more than one step. There is no
 * silent/implicit auto-creation path.
 *
 * createObjective() ALWAYS hardcodes require_approval_before_start: true —
 * auto-created objectives must land in the HITL approval flow, never
 * auto-run. This is not configurable from this path.
 */

const DEFAULT_TASKS_URL = 'http://tasks:3104';
const TITLE_MAX_LEN = 200;

/**
 * @param {boolean} allowOrchestration - resolved from req.body.allow_orchestration === true
 * @returns {(aoclCtx, plan) => boolean}
 */
function makeShouldOrchestrate(allowOrchestration) {
  return function shouldOrchestrate(_aoclCtx, plan) {
    if (allowOrchestration !== true) return false;
    if (!plan || !Array.isArray(plan.steps)) return false;
    return plan.steps.length > 1;
  };
}

function buildTitle(plan, aoclCtx) {
  const firstStepText = plan?.steps?.[0]?.text;
  if (typeof firstStepText === 'string' && firstStepText.trim()) {
    return firstStepText.trim().slice(0, TITLE_MAX_LEN);
  }
  const promptPreview = aoclCtx?.C2?.rawUserPrompt || aoclCtx?.query || '';
  const trimmed = typeof promptPreview === 'string' ? promptPreview.trim() : '';
  return (trimmed ? trimmed.slice(0, TITLE_MAX_LEN) : 'Objective from chat');
}

function buildDescription(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return steps.map((s, i) => `${i + 1}. ${s?.text ?? ''}`).join('\n');
}

/**
 * @param {object} [deps]
 * @param {function} [deps.fetchFn] - fetch implementation (defaults to global fetch)
 * @param {string} [deps.tasksServiceUrl]
 * @param {string} [deps.internalServiceKey]
 * @param {(aoclCtx, layer, outcome, payload) => void} [deps.emitEnvelope] - e.g. lib/aoclPipeline.js emitLayerEnvelope
 * @returns {(aoclCtx, plan) => Promise<{objectiveId: string}|null>}
 */
function makeCreateObjective(deps = {}) {
  const {
    fetchFn = (typeof fetch === 'function' ? fetch : undefined),
    tasksServiceUrl = process.env.TASKS_SERVICE_URL || DEFAULT_TASKS_URL,
    internalServiceKey = process.env.INTERNAL_SERVICE_KEY || '',
    emitEnvelope,
  } = deps;

  return async function createObjective(aoclCtx, plan) {
    if (typeof fetchFn !== 'function') return null;

    const orgId = aoclCtx?.orgId || 'default';
    const userId = aoclCtx?.userId || 'service';
    const corrId = aoclCtx?.corr;

    const body = {
      title: buildTitle(plan, aoclCtx),
      description: buildDescription(plan),
      corr_id: corrId,
      // ALWAYS true — auto-created-from-chat objectives are a
      // governance-sensitive ACT and must land in the HITL approval flow,
      // never auto-run. Not configurable from this path.
      require_approval_before_start: true,
    };

    let res;
    try {
      res = await fetchFn(`${tasksServiceUrl}/api/objectives`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': internalServiceKey,
          'x-org-id': orgId,
          'x-user-id': userId,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.warn('[L4] createObjective fetch failed (non-fatal):', err?.message || err);
      return null;
    }

    if (!res || !res.ok) {
      console.warn(`[L4] createObjective non-2xx response: ${res?.status}`);
      return null;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.warn('[L4] createObjective response parse failed (non-fatal):', err?.message || err);
      return null;
    }

    const objectiveId = data?.id;
    if (typeof objectiveId !== 'string' || !objectiveId) return null;

    if (typeof emitEnvelope === 'function') {
      try {
        emitEnvelope(aoclCtx, 'L4', 'objective_created', {
          objective_id: objectiveId,
          step_count: Array.isArray(plan?.steps) ? plan.steps.length : 0,
        });
      } catch (err) {
        // Envelope emission must never break objective creation.
        console.warn('[L4] objective_created envelope emission failed (non-fatal):', err?.message || err);
      }
    }

    return { objectiveId };
  };
}

module.exports = { makeShouldOrchestrate, makeCreateObjective };
