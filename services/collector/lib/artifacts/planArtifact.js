/**
 * Plan-artifact logic (COMMANDERQ P5) — intended-vs-actual diff + deviation gate.
 *
 * A plan artifact declares steps up front (approve-once). As it executes, the
 * caller supplies the ACTUAL steps; this computes the deviation between intended
 * and actual and decides whether a deviation-GATED plan needs re-approval.
 *
 * Pure — no crypto, no store, no network.
 */

'use strict';

/**
 * @param {object} planArtifact  a validated artifact_type==='plan' artifact
 * @param {Array}  actualSteps   [{ id, status:'done'|'skipped'|'changed' }]
 * @returns {{ matched, missing, extra, changed, deviated, reapproval_required }}
 */
function computePlanDiff(planArtifact, actualSteps) {
  const plannedSteps = (planArtifact && planArtifact.body && Array.isArray(planArtifact.body.steps))
    ? planArtifact.body.steps
    : [];
  const plannedIds = plannedSteps.map(s => s && s.id).filter(Boolean);
  const plannedSet = new Set(plannedIds);

  const actual = Array.isArray(actualSteps) ? actualSteps : [];
  const actualById = new Map();
  for (const a of actual) {
    if (a && a.id) actualById.set(a.id, a.status || 'done');
  }

  const matched = [];   // planned + actually done
  const missing = [];   // planned but not done (absent or skipped)
  const changed = [];   // planned + actual status 'changed'
  for (const id of plannedIds) {
    const status = actualById.get(id);
    if (status === 'done') matched.push(id);
    else if (status === 'changed') changed.push(id);
    else missing.push(id); // absent or 'skipped'
  }

  // actual steps not in the plan at all
  const extra = [...actualById.keys()].filter(id => !plannedSet.has(id));

  const deviated = missing.length > 0 || extra.length > 0 || changed.length > 0;

  const policy = planArtifact && planArtifact.body ? planArtifact.body.deviation_policy : undefined;
  const reapproval_required = policy === 'gated' && deviated;

  return { matched, missing, extra, changed, deviated, reapproval_required };
}

module.exports = { computePlanDiff };
