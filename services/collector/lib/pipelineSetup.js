/**
 * AOCL-FULL-2 — Pipeline setup helper.
 *
 * Every chat-ish entry point (POST /chat, GET /chat/stream, POST /quoxchat/
 * message, webhook.telegram, webhook.slack, webhook.discord, /chat/resolve-
 * plan) funnels through this helper to produce a ready-to-run aoclCtx.
 *
 * Audit revealed that SSE streaming and the three webhook endpoints bypass
 * the AOCL pipeline entirely. Their caller-identity resolution is ad-hoc.
 * This helper canonicalises:
 *   - where orgId / userId / agentId come from per-source
 *   - who the "user" is for a webhook (principal = webhook.<provider>.<botId>)
 *   - consistent source + channel labels for L0 ingress.normalize
 *
 * The helper is PURE with respect to side effects it triggers on aoclCtx:
 * it calls buildAoclContext and returns. It does NOT invoke runPipeline
 * here — the caller does that so request-specific timeouts / streaming
 * semantics stay in the route handler.
 *
 * Return shape:
 *   { ok: true, aoclCtx, source, channel }                  — happy path
 *   { ok: false, httpStatus, errorCode, errorMessage, aoclCtx? } — rejected before pipeline
 *
 * A rejected setup still produces an aoclCtx when possible so the caller can
 * emit an L0.reject envelope for audit.
 */

const { buildAoclContext } = require('./aoclContext.js');

/**
 * Source constants — used as aoclCtx.C0.source and webhook principal prefix.
 */
const SOURCES = Object.freeze({
  CHAT: 'chat',
  SSE: 'sse',
  WIDGET: 'widget',
  WEBHOOK_TELEGRAM: 'webhook.telegram',
  WEBHOOK_SLACK: 'webhook.slack',
  WEBHOOK_DISCORD: 'webhook.discord',
  RESOLVE_PLAN: 'resolve-plan',
});

/**
 * Extract jwtOrgId / jwtUserId from the usual Express places.
 * Mirrors server.js's existing auth resolution.
 */
function extractJwt(req) {
  const serviceAuth = !!req?.isServiceAuth;
  if (serviceAuth && req.body?.org_id && req.body?.user_id) {
    return { jwtOrgId: req.body.org_id, jwtUserId: req.body.user_id, serviceAuth: true };
  }
  // TRUST-GATE-MT: org-scoped service calls without a human user (workflow
  // invokes) must keep their org — mirrors the /chat handler's fix; without
  // this the request degrades to '__default__' downstream.
  if (serviceAuth && req.body?.org_id && !req.body?.user_id) {
    return { jwtOrgId: req.body.org_id, jwtUserId: '', serviceAuth: true };
  }
  const jwtOrgId = req?.user?.orgId || req?.user?.org_id || '';
  const jwtUserId = req?.user?.id || '';
  return { jwtOrgId, jwtUserId, serviceAuth };
}

/**
 * Setup for direct chat requests (POST /chat, POST /chat/claude).
 * Identity from JWT; prompt + session_id from body.
 */
function setupChat(req) {
  const { jwtOrgId, jwtUserId, serviceAuth } = extractJwt(req);
  const body = req.body || {};
  const aoclCtx = buildAoclContext({
    jwtOrgId,
    jwtUserId,
    serviceAuth,
    sessionId: body.session_id || body.effectiveSessionId || null,
    selectedAgent: body.selected_agent || 'quox',
    prompt: body.prompt || '',
    provider: body.provider || null,
    model: body.model || null,
  });
  aoclCtx.C0.source = SOURCES.CHAT;
  aoclCtx.C0.channel = 'api';
  return { ok: true, aoclCtx, source: SOURCES.CHAT, channel: 'api' };
}

/**
 * Setup for SSE streaming (/chat/stream).
 *
 * GET with no body — query params carry the session. Policy checks must
 * happen BEFORE res.write() starts streaming, otherwise SSE clients see
 * "success" framing before a possible policy denial.
 */
function setupSSE(req) {
  const { jwtOrgId, jwtUserId, serviceAuth } = extractJwt(req);
  // quox#782: POST /chat/stream carries the session in the JSON body (normalised
  // into req._streamParams); the legacy GET still uses the query string.
  const q = req?._streamParams || req?.query || {};
  if (!q.query_id) {
    return {
      ok: false,
      httpStatus: 400,
      errorCode: 'missing_query_id',
      errorMessage: 'query_id is required for SSE setup',
    };
  }
  const aoclCtx = buildAoclContext({
    jwtOrgId,
    jwtUserId,
    serviceAuth,
    sessionId: q.session_id || q.query_id,
    selectedAgent: q.assistant || 'quox',
    prompt: typeof q.prompt === 'string' ? (req?._streamParams ? q.prompt : decodeURIComponent(q.prompt)) : '',
    provider: null,
    model: null,
  });
  aoclCtx.C0.source = SOURCES.SSE;
  aoclCtx.C0.channel = 'sse';
  return { ok: true, aoclCtx, source: SOURCES.SSE, channel: 'sse' };
}

/**
 * Setup for embed widget (POST /quoxchat/message).
 * Org resolved via public_key (widget registration); user identity is
 * anonymous-visitor unless tied to an end-user session.
 */
function setupWidget(req, { widgetRecord } = {}) {
  if (!widgetRecord) {
    return {
      ok: false,
      httpStatus: 401,
      errorCode: 'unknown_widget',
      errorMessage: 'widget public_key did not resolve to a registered widget',
    };
  }
  const body = req.body || {};
  // Widget principal is the site visitor — use visitor_id only (not session id)
  // so the principal stays stable across sessions from the same visitor cookie.
  // Anonymous if no visitor_id.
  const visitorId = body.visitor_id || '';
  const principal = `visitor.${visitorId || 'anonymous'}`;
  const aoclCtx = buildAoclContext({
    jwtOrgId: widgetRecord.org_id,
    jwtUserId: principal,
    serviceAuth: false,
    sessionId: body.session_id || null,
    selectedAgent: widgetRecord.agent_id || 'quox',
    prompt: body.message || '',
    provider: null,
    model: null,
  });
  aoclCtx.C0.source = SOURCES.WIDGET;
  aoclCtx.C0.channel = `widget.${widgetRecord.id || widgetRecord.public_key?.slice(0, 8) || 'unknown'}`;
  aoclCtx.C1.userId = principal;
  return { ok: true, aoclCtx, source: SOURCES.WIDGET, channel: aoclCtx.C0.channel };
}

/**
 * Setup for a webhook chat (telegram / slack / discord).
 *
 * Identity model: the "principal" is the webhook integration, not a human.
 *   from: webhook.<provider>.<botId>
 *   userId: same
 *   orgId: resolved from the bot registration record supplied by the route
 *
 * If botRecord is missing or lacks an org_id, setup fails with
 * unknown_integration — the webhook should be rejected at the HTTP layer,
 * not silently run without a policy gate.
 */
function setupWebhook(req, { provider, botRecord, message, chatId } = {}) {
  const validProviders = ['telegram', 'slack', 'discord'];
  if (!validProviders.includes(provider)) {
    return {
      ok: false,
      httpStatus: 400,
      errorCode: 'invalid_webhook_provider',
      errorMessage: `webhook provider must be one of: ${validProviders.join(', ')}`,
    };
  }
  if (!botRecord || !botRecord.org_id) {
    return {
      ok: false,
      httpStatus: 401,
      errorCode: 'unknown_integration',
      errorMessage: `webhook ${provider} bot is not registered — refusing to run pipeline without org scope`,
    };
  }
  const botId = botRecord.bot_id || botRecord.id || 'unknown';
  const principalId = `webhook.${provider}.${botId}`;
  const aoclCtx = buildAoclContext({
    jwtOrgId: botRecord.org_id,
    jwtUserId: principalId,
    serviceAuth: true, // webhooks authenticate via signature, not JWT
    sessionId: `${provider.toUpperCase()}_${chatId || 'nochat'}_${Date.now()}`,
    selectedAgent: botRecord.agent_id || 'quox',
    prompt: message || '',
    provider: null,
    model: null,
  });
  aoclCtx.C0.source = `webhook.${provider}`;
  aoclCtx.C0.channel = `${provider}.${botId}`;
  aoclCtx.C1.userId = principalId;
  aoclCtx.C1.serviceAuth = true;
  return { ok: true, aoclCtx, source: `webhook.${provider}`, channel: aoclCtx.C0.channel };
}

/**
 * Setup for /chat/resolve-plan approval endpoint.
 * Full pre-pipeline so approval gates are uniformly enforced — not just a
 * post-check as it used to be.
 */
function setupResolvePlan(req) {
  const { jwtOrgId, jwtUserId, serviceAuth } = extractJwt(req);
  const body = req.body || {};
  const aoclCtx = buildAoclContext({
    jwtOrgId,
    jwtUserId,
    serviceAuth,
    sessionId: body.session_id || body.corr || null,
    selectedAgent: body.selected_agent || 'quox',
    prompt: body.query || body.prompt || '',
    provider: body.provider || null,
    model: body.model || null,
  });
  aoclCtx.C0.source = SOURCES.RESOLVE_PLAN;
  aoclCtx.C0.channel = 'api';
  return { ok: true, aoclCtx, source: SOURCES.RESOLVE_PLAN, channel: 'api' };
}

/**
 * Dispatcher — route to the correct setter by source type.
 * Most callers use this rather than the source-specific helpers directly.
 */
function setupPipelinePhase(req, opts = {}) {
  const source = opts.source;
  switch (source) {
    case SOURCES.CHAT:          return setupChat(req);
    case SOURCES.SSE:           return setupSSE(req);
    case SOURCES.WIDGET:        return setupWidget(req, opts);
    case SOURCES.WEBHOOK_TELEGRAM: return setupWebhook(req, { ...opts, provider: 'telegram' });
    case SOURCES.WEBHOOK_SLACK:    return setupWebhook(req, { ...opts, provider: 'slack' });
    case SOURCES.WEBHOOK_DISCORD:  return setupWebhook(req, { ...opts, provider: 'discord' });
    case SOURCES.RESOLVE_PLAN:  return setupResolvePlan(req);
    default:
      return {
        ok: false,
        httpStatus: 400,
        errorCode: 'unknown_source',
        errorMessage: `setupPipelinePhase: unknown source '${source}'`,
      };
  }
}

module.exports = {
  SOURCES,
  setupPipelinePhase,
  setupChat,
  setupSSE,
  setupWidget,
  setupWebhook,
  setupResolvePlan,
};
