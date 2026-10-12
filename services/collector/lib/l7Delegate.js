/**
 * AOCL-FULL-6 — L7 delegate.execute.
 *
 * The layer that actually dispatches to the LLM / tool / agent. All upstream
 * layers (L0..L6) have shaped the request; L7 takes C5.finalPrompt and calls
 * the injected dispatcher. Whatever the dispatcher returns is captured onto
 * C5.llmResponse (raw output) so L8.verify and L9.assemble can work on it.
 *
 * Dependency injection: L7 does not know whether the dispatcher is the
 * Anthropic Messages API, the Claude CLI, an OpenAI call, an MCP tool chain,
 * or a plugin. It just calls `dispatch(aoclCtx, finalPrompt, opts)` and
 * treats the result as an opaque response object.
 *
 * Contract for dispatchers:
 *   async dispatch(aoclCtx, finalPrompt, opts) => {
 *     text: string,                // the raw textual output
 *     tokensUsed?: number,
 *     toolsUsed?: Array<{name, ok, ...}>,
 *     model?: string,
 *     path?: 'api' | 'cli' | 'mcp' | 'plugin' | ...,
 *   }
 *
 * Error handling:
 *  - dispatch throws → { proceed: false, reason: 'l7.dispatch_failed' }.
 *    Pipeline halts; L8/L9/L10 bypass or record the denial state.
 *  - aoclCtx.halt set by an earlier layer (e.g. L2 fast-path) → L7 skips
 *    dispatch entirely, returns proceed:true with a 'bypassed_reason'.
 *  - no dispatcher provided → { proceed: false, reason: 'l7.no_dispatcher' }.
 */

/**
 * Run the L7 delegate.
 *
 * @param {object} aoclCtx
 * @param {object} [opts]
 * @param {(aoclCtx, finalPrompt, opts) => Promise<object>} [opts.dispatch]
 */
async function runL7(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const c5 = aoclCtx.C5 || (aoclCtx.C5 = {});

  // Fast-path: an earlier layer halted the pipeline; L7 doesn't dispatch.
  if (aoclCtx.halt) {
    return {
      proceed: true,
      extras: {
        bypassed: true,
        bypassed_reason: aoclCtx.halt.reason || 'upstream_halt',
        duration_ms: Date.now() - startedAt,
      },
    };
  }

  if (typeof opts.dispatch !== 'function') {
    return {
      proceed: false,
      reason: 'l7.no_dispatcher',
      extras: { duration_ms: Date.now() - startedAt },
    };
  }

  const finalPrompt = c5.finalPrompt ?? aoclCtx.C2?.rawUserPrompt ?? '';

  try {
    const r = await opts.dispatch(aoclCtx, finalPrompt, opts);
    const text = typeof r?.text === 'string' ? r.text : '';
    const tokensUsed = typeof r?.tokensUsed === 'number' ? r.tokensUsed : 0;
    const toolsUsed = Array.isArray(r?.toolsUsed) ? r.toolsUsed : [];
    const model = typeof r?.model === 'string' ? r.model : null;
    const path = typeof r?.path === 'string' ? r.path : null;

    c5.llmResponse = text;
    c5.toolsUsed = toolsUsed;
    c5.toolExecutions = Array.isArray(r?.toolExecutions) ? r.toolExecutions : [];
    c5.model = model;
    c5.tokensUsed = tokensUsed;
    c5.dispatchPath = path;

    return {
      proceed: true,
      extras: {
        response_length: text.length,
        tokens_used: tokensUsed,
        tools_used: toolsUsed,
        model,
        path,
        duration_ms: Date.now() - startedAt,
      },
    };
  } catch (err) {
    c5.llmResponse = null;
    return {
      proceed: false,
      reason: 'l7.dispatch_failed',
      extras: {
        error: err?.message || String(err),
        duration_ms: Date.now() - startedAt,
      },
    };
  }
}

module.exports = { runL7 };
