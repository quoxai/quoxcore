/**
 * AOCL-CUTOVER-2b — shadow runner + cumulative parity metrics.
 *
 * Wraps the "run the new buildChatStack alongside the legacy pipeline and
 * diff the outcomes" pattern so handleCollectorChat + webhook handlers
 * each integrate with one import:
 *
 *   const shadowRunner = require('./lib/shadowRunner');
 *   // after legacy runPreLLMPipeline result:
 *   await shadowRunner.maybeRunShadow({ mode, aoclCtx, legacyResult });
 *
 * Legacy stays authoritative. Shadow is fire-and-forget observability —
 * even if everything inside this module crashes, the caller never
 * sees an exception. Metrics accumulate in a module-level counter
 * exposed via getShadowMetrics() so /collector/chat/status can report
 * parity readiness.
 *
 * Shadow only runs the 'policy-only' profile (L0/L1/L2/L3/L10) — five
 * cheap, synchronous layers with no dispatcher or memory dependencies.
 * This validates the parts of the cutover that can be validated safely
 * without duplicating the LLM call.
 */

const { buildChatStack } = require('./aoclStack.js');
const aoclPipelineModule = require('./aoclPipeline.js');
const { compareShadowRun, summariseDiff } = require('./shadowComparator.js');

const _runs = [];
let _errors = 0;

function resetShadowMetrics() {
  _runs.length = 0;
  _errors = 0;
}

function getShadowMetrics() {
  const summary = summariseDiff(_runs);
  return {
    runs: summary.total,
    identical: summary.identical,
    parityRate: summary.parityRate,
    readyToFlip: summary.readyToFlip,
    issueCounts: summary.issueCounts,
    errors: _errors,
  };
}

function buildShadowStackDef(deps) {
  return buildChatStack({ profile: 'policy-only', ...deps });
}

/**
 * Shallow-clone the ctx so the shadow run's side-effects (halt, denial
 * stamping, partition writes) don't leak back to the authoritative legacy
 * path. Not a deep clone — that would be expensive — but we duplicate
 * the top-level mutable fields.
 */
function forkCtx(ctx) {
  return {
    ...ctx,
    C0: { ...(ctx.C0 || {}) },
    C1: { ...(ctx.C1 || {}) },
    C2: { ...(ctx.C2 || {}) },
    C3: { ...(ctx.C3 || {}) },
    C4: { ...(ctx.C4 || {}) },
    C5: { ...(ctx.C5 || {}) },
    C6: { ...(ctx.C6 || {}) },
    layerResults: { ...(ctx.layerResults || {}) },
    warnings: [...(ctx.warnings || [])],
  };
}

/**
 * Fire the shadow pipeline if mode requires it. Never throws.
 *
 * @param {object} args
 * @param {'legacy'|'shadow'|'stack'} args.mode
 * @param {object} args.aoclCtx           — the legacy-authoritative ctx
 * @param {object} args.legacyResult      — what runPreLLMPipeline returned
 * @param {object} [args.deps]            — providers for buildChatStack
 * @param {Function} [args.runPipeline]   — override for testing
 */
async function maybeRunShadow({ mode, aoclCtx, legacyResult, deps = {}, runPipeline }) {
  if (mode !== 'shadow' && mode !== 'stack') return;
  if (!aoclCtx) return;

  try {
    const pipelineFn = typeof runPipeline === 'function' ? runPipeline : aoclPipelineModule.runPipeline;
    const stackDef = buildShadowStackDef(deps);
    const shadowCtx = forkCtx(aoclCtx);

    const stackResult = await pipelineFn(shadowCtx, stackDef, { budgets: false });

    const diff = compareShadowRun(
      {
        layersRun: Object.keys(aoclCtx.layerResults || {}),
        finalResponse: aoclCtx.C5?.finalResponse || '',
        denied: legacyResult?.proceed === false,
        deniedAtLayer: legacyResult?.deniedAtLayer || null,
      },
      {
        layersRun: Object.keys(shadowCtx.layerResults || {}),
        finalResponse: shadowCtx.C5?.finalResponse || '',
        denied: stackResult?.proceed === false,
        deniedAtLayer: stackResult?.deniedAtLayer || shadowCtx.deniedAtLayer || null,
      },
    );
    _runs.push(diff);
  } catch (err) {
    _errors++;
    // Never propagate — shadow is strictly observational
  }
}

/**
 * Webhook variant: fire a shadow run through runWebhookChat when mode is
 * shadow/stack. Captures parity into the same metrics bucket as chat
 * shadow runs so operators see one unified gauge across all entry points.
 */
async function maybeRunWebhookShadow({ mode, provider, botRecord, message, chatId, deps = {} }) {
  if (mode !== 'shadow' && mode !== 'stack') return;
  if (!provider || !botRecord) return;

  try {
    const { runWebhookChat } = require('./webhookPipeline.js');
    const req = { body: {}, headers: {} };
    const r = await runWebhookChat(req, {
      provider,
      botRecord,
      message: message || '',
      chatId: chatId || null,
      profile: 'policy-only',
      ...deps,
    });
    // Record as a one-diff sample: did the pipeline accept or deny?
    _runs.push({
      identical: r.ok && r.proceed,
      issues: r.ok && r.proceed ? [] : [`webhook_${provider}_denied_at_${r.deniedAtLayer || 'unknown'}`],
    });
  } catch {
    _errors++;
  }
}

module.exports = {
  maybeRunShadow,
  maybeRunWebhookShadow,
  getShadowMetrics,
  resetShadowMetrics,
  buildShadowStackDef,
};
