'use strict';

/**
 * runtime.js — BLAST-RADIUS-P2
 *
 * A single, injected runtime for reach evaluation, set once at server.js
 * boot (same wiring point as P1's setReachEvaluator, right next to it) and
 * consumed by every door a reach evaluation can come through: the GET
 * route (trigger 'api'), the approval gate (trigger 'approval_gate'), and
 * the reach_agent agent tool (trigger 'agent_tool'). One runtime means one
 * evaluation shape regardless of which door it came through, and one place
 * that can never forget to witness it.
 *
 * setReachRuntime({ resolveStaticReach, computeActionRadius, audit }):
 *   - resolveStaticReach(agentId, orgId) => Promise<reach result>  (P0)
 *   - computeActionRadius(call, deps)     => Promise<action-radius result> (P1)
 *   - audit(envelope)                     => void  (server.js's storeAuditEnvelope)
 *
 * getReachRuntime() throws a clear error if the runtime was never set —
 * a caller reaching for it before boot-wiring is a programming error, not
 * a degrade-silently case.
 */

let runtime = null;

// BLAST-RADIUS-P3: in-memory static-reach cache keyed `orgId:agentId`, so
// policy gating (checkStorePolicies, evaluated on every governed tool call)
// doesn't re-run the full resolver (auth + bastion + egress fetches) per
// call. TTL-based only: a grant change (new credential, new host, revoked
// delegation) can take up to `ttlMs` to be reflected in a policy decision.
// That is an honest, bounded staleness window, not silent drift — a later
// phase can add event-driven invalidation (e.g. on grant/revoke writes)
// to close it; this phase intentionally does not.
const reachCache = new Map();

/**
 * getCachedStaticReach(agentId, orgId, { ttlMs }) — cache-or-compute wrapper
 * around getReachRuntime().resolveStaticReach. A cache hit returns the prior
 * result with no side effects (no re-fetch, no envelope). A cache miss (or
 * stale entry) computes fresh AND emits the witnessed 'policy_check' trigger
 * envelope via auditReachEvaluation — so every actual resolution is still
 * witnessed, only the cached re-reads are silent.
 */
async function getCachedStaticReach(agentId, orgId, { ttlMs = 60000 } = {}) {
  const key = `${orgId}:${agentId}`;
  const now = Date.now();
  const cached = reachCache.get(key);
  if (cached && (now - cached.at) < ttlMs) {
    return cached.result;
  }

  const { resolveStaticReach } = getReachRuntime();
  const result = await resolveStaticReach(agentId, orgId);
  reachCache.set(key, { result, at: now });
  auditReachEvaluation({ trigger: 'policy_check', orgId, agentId, result });
  return result;
}

// Test-only cache reset, mirrors _resetReachRuntimeForTests below.
function _clearReachCache() {
  reachCache.clear();
}

function setReachRuntime(deps) {
  if (!deps || typeof deps.resolveStaticReach !== 'function') {
    throw new Error('setReachRuntime: deps.resolveStaticReach is required');
  }
  if (typeof deps.computeActionRadius !== 'function') {
    throw new Error('setReachRuntime: deps.computeActionRadius is required');
  }
  if (typeof deps.audit !== 'function') {
    throw new Error('setReachRuntime: deps.audit is required');
  }
  runtime = deps;
}

function getReachRuntime() {
  if (!runtime) {
    throw new Error('getReachRuntime: reach runtime not initialised — server.js must call setReachRuntime() before any reach evaluation runs');
  }
  return runtime;
}

// Test-only reset so suites don't leak runtime state across files.
function _resetReachRuntimeForTests() {
  runtime = null;
}

function defaultCorr() {
  return `REACH_${Date.now()}`;
}

/**
 * Emit ONE AEE envelope per reach evaluation, regardless of caller. Pattern
 * mirrors agentAttachKit.js:309 (quox.identity.attach_kit_fetch): try/caught
 * around the audit call so an audit-store failure can never break the
 * evaluation itself, with exactly one warn line on failure (never silent,
 * never noisy).
 *
 * `result` is the full reach/actionRadius result. By construction (see
 * reachResolver.js's HONESTY RULES header) it carries no secret values —
 * credential entries are { id, integration_type, name } only — so the
 * envelope payload is safe to store and witness verbatim.
 */
function auditReachEvaluation({ trigger, orgId, agentId, corr, result }) {
  const { audit } = getReachRuntime();
  try {
    audit({
      type: 'event',
      from: 'collector.reach',
      to: 'audit.system',
      intent: 'quox.reach.evaluate',
      corr: corr || defaultCorr(),
      org_id: orgId,
      payload: {
        trigger,
        subject: { type: 'agent', id: agentId },
        result,
      },
    });
  } catch (err) {
    console.warn('[Reach] audit envelope emit failed (non-fatal):', (err && err.message) || err);
  }
}

module.exports = {
  setReachRuntime,
  getReachRuntime,
  auditReachEvaluation,
  getCachedStaticReach,
  _resetReachRuntimeForTests,
  _clearReachCache,
};
