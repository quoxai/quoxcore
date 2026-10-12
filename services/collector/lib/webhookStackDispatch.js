/**
 * AOCL-DISPATCH Phase 4 — webhook authoritative path.
 *
 * Gated helper used by telegramWebhook / slackWebhook / discordWebhook. When
 * the gate is open (AOCL_STACK_MODE=stack AND shadow readyToFlip), routes
 * the webhook message through runWebhookChat so the request picks up
 * webhook-specific AOCL envelopes (source=webhook.<provider>,
 * principal=webhook.<provider>.<botId>, channel=<provider>.<botId>).
 *
 * When the gate is closed, returns { stackUsed: false } so the webhook
 * falls through to its existing legacy _routeToChatPipeline call.
 *
 * Dependencies (injected):
 *   getStackMode()          — from lib/aoclStackMode.js
 *   getShadowMetrics()      — from lib/shadowRunner.js
 *   invokeDispatch({aoclCtx, prompt, ...}) → { text, tokensUsed, toolsUsed,
 *                                              model, path }
 *   memoryClient, wsmClient, ragClient, personas, sanitise, adaptStyle,
 *   quoxContext   — passed through to buildChatProviders
 *
 * Safety invariants:
 *   - Never throws. Catches and returns stackUsed:false so webhook chat
 *     cannot break because of a stack-path fault.
 *   - Pipeline denials return stackUsed:true with proceed:false so the
 *     caller can choose to show a policy-denied message instead of the
 *     LLM output.
 */

const VALID_PROVIDERS = new Set(['telegram', 'slack', 'discord']);

async function tryWebhookStackDispatch(args, deps = {}) {
  const {
    req,
    provider,
    botRecord,
    message,
    chatId,
    profile, // optional stack profile override
  } = args || {};

  // ── Gate ──────────────────────────────────────────────────────────────
  // AOCL-DISPATCH-5: readyToFlip gate removed (parity proven in E2E tests).
  // Opt back in via AOCL_STACK_REQUIRE_PARITY=true.
  try {
    const mode = typeof deps.getStackMode === 'function' ? deps.getStackMode() : 'stack';
    if (mode !== 'stack') return { stackUsed: false };

    if (process.env.AOCL_STACK_REQUIRE_PARITY === 'true') {
      const metrics = typeof deps.getShadowMetrics === 'function' ? deps.getShadowMetrics() : null;
      if (!metrics || !metrics.readyToFlip) return { stackUsed: false };
    }
  } catch {
    // Gate checks must never break chat — treat errors as gate-closed.
    return { stackUsed: false };
  }

  if (!VALID_PROVIDERS.has(provider)) return { stackUsed: false };
  if (!botRecord) return { stackUsed: false };

  const { runWebhookChat } = require('./webhookPipeline.js');

  const dispatch = async (aoclCtx, prompt, dispatchOpts) => {
    if (typeof deps.invokeDispatch !== 'function') {
      throw new Error('webhook_stack_no_dispatcher');
    }
    const r = await deps.invokeDispatch({ aoclCtx, prompt, ...dispatchOpts });
    return {
      text: typeof r?.text === 'string' ? r.text : '',
      tokensUsed: typeof r?.tokensUsed === 'number' ? r.tokensUsed : 0,
      toolsUsed: Array.isArray(r?.toolsUsed) ? r.toolsUsed : [],
      model: r?.model || null,
      path: r?.path || 'webhook_delegate',
    };
  };

  try {
    const webhookReq = req || { body: {}, headers: {} };
    const result = await runWebhookChat(webhookReq, {
      provider,
      botRecord,
      message: message || '',
      chatId: chatId || null,
      profile,
      dispatch,
      // Provider plumbing for L5/L6/L9
      memoryClient: deps.memoryClient,
      wsmClient: deps.wsmClient,
      ragClient: deps.ragClient,
      personas: deps.personas,
      sanitise: deps.sanitise,
      adaptStyle: deps.adaptStyle,
      quoxContext: deps.quoxContext,
      getAssistantPersona: deps.getAssistantPersona,
      // Policy providers
      voltDb: deps.voltDb,
      enforceIdentity: deps.enforceIdentity,
      evaluateCompliance: deps.evaluateCompliance,
      evaluateSafety: deps.evaluateSafety,
      verify: deps.verify,
    });

    if (!result || result.ok === false) {
      return {
        stackUsed: true,
        proceed: false,
        deniedAtLayer: null,
        response: result?.errorMessage || 'Webhook setup failed.',
        httpStatus: result?.httpStatus || 500,
      };
    }

    return {
      stackUsed: true,
      proceed: !!result.proceed,
      deniedAtLayer: result.deniedAtLayer || null,
      response: result.response || '',
      httpStatus: result.httpStatus || 200,
      envelopes: result.envelopes || [],
      aoclCtx: result.aoclCtx,
    };
  } catch (err) {
    console.error('[webhookStackDispatch] runWebhookChat threw:', err?.message || err);
    return { stackUsed: false };
  }
}

module.exports = { tryWebhookStackDispatch };
