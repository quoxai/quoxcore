/**
 * AOCL-CUTOVER-2 — L7 dispatch adapter for chat.
 *
 * The L7 delegate contract expects:
 *   dispatch(aoclCtx, finalPrompt, opts) => { text, tokensUsed, toolsUsed, model, path }
 *
 * This module builds such a dispatcher from the existing collector handlers:
 *   invokeMessagesApi  → PATH 1: Anthropic Messages API (native tool_use)
 *   invokeClaudeCli    → PATH 2: OAuth/CLI (regex pre-exec + spawn)
 *
 * The handlers themselves live in server.js — this adapter is a thin shell
 * that normalises their output to the L7 contract. The two handlers aren't
 * imported directly yet (they're hundreds of lines of mutable state);
 * Phase 2b in the cutover will refactor them into self-contained callables.
 *
 * Path selection: caller passes `path: 'api' | 'cli'`. If omitted, picks
 * whichever handler was provided. Throws if neither.
 *
 * LLM-CHOICE 3.2b — internal-to-anthropic-branch, not a provider selector.
 * This module is load-bearing: stackModeDispatch.js calls buildChatDispatcher
 * for every stack-mode chat request, but ONLY ever passes path: 'api' | 'cli'
 * (invokeMessagesApi / invokeClaudeCli — both Anthropic-only). Non-Anthropic
 * providers (openai/gemini/etc.) never flow through here; they're dispatched
 * elsewhere in the L0-L10 stack (see chatProviders.js / aoclStack.js). Do not
 * extend this module to "add a provider" — it has no concept of provider,
 * only of Anthropic's two transports (API key vs OAuth/CLI).
 */

function buildChatDispatcher(opts = {}) {
  const {
    invokeMessagesApi,   // async ({ aoclCtx, prompt, ...opts }) => { text, tokensUsed, toolsUsed }
    invokeClaudeCli,     // async ({ aoclCtx, prompt, ...opts }) => { text, tokensUsed, toolsUsed }
    path,                // 'api' | 'cli' (optional — auto-picks)
    model,               // passed through as-is
  } = opts;

  const preferredPath = path ||
    (typeof invokeMessagesApi === 'function' ? 'api' :
     typeof invokeClaudeCli === 'function' ? 'cli' : null);

  if (!preferredPath) {
    return async () => {
      throw new Error('chatDispatcher: no handler (invokeMessagesApi or invokeClaudeCli) provided');
    };
  }

  const handler = preferredPath === 'api' ? invokeMessagesApi : invokeClaudeCli;
  if (typeof handler !== 'function') {
    return async () => {
      throw new Error(`chatDispatcher: no handler for path "${preferredPath}"`);
    };
  }

  return async function dispatch(aoclCtx, prompt, _opts = {}) {
    const result = await handler({ aoclCtx, prompt, model, ..._opts });
    return {
      text: typeof result?.text === 'string' ? result.text : '',
      tokensUsed: typeof result?.tokensUsed === 'number' ? result.tokensUsed : 0,
      toolsUsed: Array.isArray(result?.toolsUsed) ? result.toolsUsed : [],
      model: result?.model || model || null,
      path: preferredPath,
    };
  };
}

module.exports = { buildChatDispatcher };
