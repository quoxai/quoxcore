/**
 * AOCL-FULL-3 — per-layer timeout budget.
 *
 * Wraps a layer `run` function in a Promise.race against a timeout. When
 * the layer exceeds its budget, we emit `aocl.layer.<id>.bypass` with
 * { reason: 'l<n>.timeout', budgetMs, actualMs } and the pipeline proceeds.
 * A stalled layer never blocks the request; audit stays complete because
 * the bypass envelope captures the timeout.
 *
 * Budgets are tuned per-layer based on the projected p95 from the
 * benchmark baseline (see perf/aoclPipelineBench.js). L7 is "LLM-owned"
 * and not budgeted by this module (its timeouts live inside the provider
 * client).
 *
 * Design notes:
 *   - setTimeout + race — keep it simple; AbortController can be added
 *     later when layers natively support it.
 *   - The wrapped function MUST still return a proper LayerResult even on
 *     timeout — runPipeline looks at `bypass: true` to emit .bypass
 *     instead of .complete.
 *   - Setting budgetMs to 0 or Infinity disables the budget for that
 *     layer (used by L7 and for tests).
 */

/** Default per-layer budgets (ms). Derived from the baseline benchmark. */
const DEFAULT_BUDGETS_MS = Object.freeze({
  L0: 50,
  L1: 50,
  L2: 50,
  L3: 200,
  L4: 100,
  L5: 300,
  L6: 50,
  L7: 0,   // LLM-owned; provider clients handle their own timeouts
  L8: 100,
  L9: 50,
  L10: 50,
});

/**
 * Returns the budget in ms for a given layer id, honouring overrides.
 * Overrides take precedence; 0 or Infinity disables budgeting.
 */
function getBudgetMs(layerId, overrides = {}) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, layerId)) {
    return overrides[layerId];
  }
  return DEFAULT_BUDGETS_MS[layerId] ?? 0;
}

/**
 * Wrap an async layer run function. On timeout, resolves with a LayerResult
 * that signals `bypass: true` so runPipeline emits aocl.layer.<id>.bypass.
 *
 * @param {string} layerId
 * @param {(ctx: object) => Promise<object>} runFn
 * @param {{ budgetMs?: number, overrides?: object }} [opts]
 * @returns {(ctx: object) => Promise<object>}
 */
function withBudget(layerId, runFn, opts = {}) {
  const budgetMs = opts.budgetMs ?? getBudgetMs(layerId, opts.overrides);
  // 0 or Infinity → no budget
  if (!budgetMs || !Number.isFinite(budgetMs)) {
    return runFn;
  }
  return async function budgetedRun(ctx) {
    const startedAt = Date.now();
    let timedOut = false;
    let timeoutHandle;
    const timeoutPromise = new Promise(resolve => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve({
          proceed: true,
          bypass: true,
          reason: `${layerId.toLowerCase()}.timeout`,
          extras: { budgetMs, actualMs: Date.now() - startedAt },
          warnings: [`${layerId} timed out after ${budgetMs}ms`],
        });
      }, budgetMs);
    });
    try {
      const actualRun = Promise.resolve().then(() => runFn(ctx));
      const result = await Promise.race([actualRun, timeoutPromise]);
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };
}

/**
 * Apply budget wrapping to every layer in a stack definition.
 * Called by runPipeline just before iteration — or by test helpers that
 * want pre-wrapped stacks.
 */
function applyBudgets(stackDef, overrides = {}) {
  if (!stackDef || !Array.isArray(stackDef.layers)) return stackDef;
  return {
    ...stackDef,
    layers: stackDef.layers.map(layer => {
      if (!layer || typeof layer.run !== 'function') return layer;
      return {
        ...layer,
        run: withBudget(layer.id, layer.run, { overrides }),
      };
    }),
  };
}

module.exports = {
  DEFAULT_BUDGETS_MS,
  getBudgetMs,
  withBudget,
  applyBudgets,
};
