/**
 * AOCL-CUTOVER-3 — unified webhook → AOCL pipeline adapter.
 *
 * Before this module, each webhook handler (telegram / slack / discord) had
 * its own ad-hoc envelope emission and dispatched to Claude directly,
 * bypassing the AOCL stack entirely. That meant a Telegram chat produced a
 * different audit trail than a web chat: zero of the L0-L10 envelopes fired.
 *
 * runWebhookChat(req, deps) unifies them. One code path:
 *   1. setupWebhook() validates provider + bot registration, builds aoclCtx
 *      with source=webhook.<provider>, channel=<provider>.<botId>,
 *      principal=webhook.<provider>.<botId>
 *   2. buildChatStack() assembles the 11-layer pipeline with caller-supplied
 *      dispatch + providers
 *   3. runPipeline() executes and captures every layer envelope
 *   4. Returns { ok, aoclCtx, response, envelopes, proceed, deniedAtLayer }
 *
 * The existing telegramWebhook.js / slackWebhook.js / discordWebhook.js
 * stay intact — migration to this module is a follow-up commit so Phase 3
 * ships with zero prod risk. Once those handlers migrate, every entry point
 * (web chat, SSE, webhooks, resolve-plan) produces the same 10+ envelope
 * audit trail.
 */

const { setupPipelinePhase, SOURCES } = require('./pipelineSetup.js');
const { buildChatStack } = require('./aoclStack.js');
const aoclPipelineModule = require('./aoclPipeline.js');
const { runPipeline, setLayerEnvelopeEmitter } = aoclPipelineModule;

const SOURCE_MAP = {
  telegram: SOURCES.WEBHOOK_TELEGRAM,
  slack:    SOURCES.WEBHOOK_SLACK,
  discord:  SOURCES.WEBHOOK_DISCORD,
};

/**
 * Run a webhook message through the full AOCL pipeline.
 *
 * @param {object} req — the Express request (used by pipelineSetup)
 * @param {object} opts
 * @param {'telegram'|'slack'|'discord'} opts.provider
 * @param {object} opts.botRecord — {bot_id, org_id, agent_id, ...}
 * @param {string} opts.message   — the user's text from the webhook payload
 * @param {string} [opts.chatId]  — provider-specific conversation id
 * @param {string} [opts.profile] — stack profile: default|minimal|policy-only
 * @param {(ctx, prompt, opts) => Promise<{text, ...}>} [opts.dispatch] — L7 dispatcher
 * @param {Function} [opts.fetchMemory] — L5 provider
 * @param {Function} [opts.fetchWorkingSet] — L5 provider
 * @param {Function} [opts.fetchRAG] — L5 provider
 * @param {string}   [opts.quoxContext] — L6 context string
 * @param {Function} [opts.getAssistantPersona] — L6 persona lookup
 * @param {Function} [opts.redact] — L9 sanitiser
 */
async function runWebhookChat(req, opts = {}) {
  const {
    provider,
    botRecord,
    message,
    chatId,
    profile,
    ...stackDeps
  } = opts;

  const source = SOURCE_MAP[provider];
  if (!source) {
    return {
      ok: false,
      httpStatus: 400,
      errorCode: 'invalid_webhook_provider',
      errorMessage: `webhook provider must be one of: telegram, slack, discord`,
    };
  }

  const setup = setupPipelinePhase(req, {
    source,
    provider,
    botRecord,
    message: message || '',
    chatId,
  });
  if (!setup.ok) return setup;

  const aoclCtx = setup.aoclCtx;
  const emitted = [];
  // Capture while forwarding to any previously-set emitter so callers
  // (tests, AEE sinks, observers) aren't clobbered.
  const prev = typeof aoclPipelineModule.getLayerEnvelopeEmitter === 'function'
    ? aoclPipelineModule.getLayerEnvelopeEmitter()
    : null;
  setLayerEnvelopeEmitter(env => {
    emitted.push(env);
    if (typeof prev === 'function') {
      try { prev(env); } catch { /* never let a downstream listener break us */ }
    }
  });

  try {
    const stack = buildChatStack({ profile, ...stackDeps });
    const result = await runPipeline(aoclCtx, stack, { budgets: false });

    // If L2 fast-path halted, the canned response lives on aoclCtx.halt.response;
    // otherwise L9 populates aoclCtx.C5.finalResponse from the dispatcher output.
    const response = aoclCtx.halt?.response
      ?? aoclCtx.C5?.finalResponse
      ?? '';

    return {
      ok: true,
      aoclCtx,
      response,
      envelopes: emitted,
      proceed: result.proceed,
      deniedAtLayer: result.deniedAtLayer || aoclCtx.deniedAtLayer || null,
      httpStatus: result.httpStatus || 200,
    };
  } finally {
    setLayerEnvelopeEmitter(prev);
  }
}

module.exports = { runWebhookChat };
