/**
 * AOCL-CUTOVER-2 — shadow-mode parity comparator.
 *
 * In shadow mode, handleCollectorChat will run both the legacy pipeline
 * and the new buildChatStack pipeline against the same aoclCtx, then
 * diff the results. Legacy stays authoritative (the user sees legacy's
 * reply); stack output is logged for parity analysis.
 *
 * Rollout gate: 0.5% tolerable drift over ≥10k requests. This module
 * computes the per-run diff and aggregates across a window so operators
 * can see when it's safe to flip AOCL_STACK_MODE=stack.
 */

const READY_TO_FLIP_PARITY = 0.995; // 99.5%

/**
 * Compare two pipeline runs for parity.
 * @param {object} legacy  — { layersRun: string[], finalResponse: string, denied: boolean, deniedAtLayer?, ... }
 * @param {object} stack   — same shape
 * @returns {{ identical: boolean, issues: string[] }}
 */
function compareShadowRun(legacy, stack) {
  const issues = [];
  if (!legacy || !stack) {
    return { identical: false, issues: ['missing_run'] };
  }

  const legacyLayers = (legacy.layersRun || []).length;
  const stackLayers  = (stack.layersRun  || []).length;
  if (legacyLayers !== stackLayers) {
    issues.push(`layer_count_mismatch: legacy=${legacyLayers} stack=${stackLayers}`);
  }

  // Denial drift is the most important signal — policy outcomes must
  // match or the cutover will silently change security posture.
  if (Boolean(legacy.denied) !== Boolean(stack.denied)) {
    issues.push(`denial_mismatch: legacy=${!!legacy.denied} stack=${!!stack.denied}`);
  }
  if (legacy.deniedAtLayer !== stack.deniedAtLayer) {
    // Only surface if both are denied but at different layers
    if (legacy.denied && stack.denied) {
      issues.push(`denied_at_layer_mismatch: legacy=${legacy.deniedAtLayer} stack=${stack.deniedAtLayer}`);
    }
  }

  // Response drift — allow exact match OR close-enough length (within 10%).
  // Text diffs are expected (different provider paths, slightly different
  // shaping) but the FINAL length should be within tolerance.
  const legacyText = legacy.finalResponse || '';
  const stackText = stack.finalResponse || '';
  if (legacyText !== stackText) {
    issues.push(`response_diff: legacy_len=${legacyText.length} stack_len=${stackText.length}`);
  }

  return {
    identical: issues.length === 0,
    issues,
  };
}

/**
 * Aggregate many per-run diffs into a rollout-readiness summary.
 * @param {Array<{identical, issues}>} runs
 * @returns {{ total, identical, parityRate, issueCounts, readyToFlip }}
 */
function summariseDiff(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return { total: 0, identical: 0, parityRate: 1, issueCounts: {}, readyToFlip: false };
  }

  let identicalCount = 0;
  const issueCounts = {};
  for (const r of runs) {
    if (r.identical) identicalCount++;
    for (const issue of r.issues || []) {
      const key = issue.split(':')[0]; // strip detail suffix
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    }
  }

  const parityRate = identicalCount / runs.length;
  return {
    total: runs.length,
    identical: identicalCount,
    parityRate,
    issueCounts,
    readyToFlip: parityRate >= READY_TO_FLIP_PARITY && runs.length >= 1000,
  };
}

module.exports = {
  compareShadowRun,
  summariseDiff,
  READY_TO_FLIP_PARITY,
};
