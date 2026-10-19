/**
 * QuoxChat Widget Routes (CW-8.0)
 *
 * Extracted from server.js for parallel-session safety.
 * All routes mounted at /quoxchat/* via app.use('/quoxchat', require('./routes/quoxchat'))
 *
 * CORS: Allows any origin (widgets run on customer sites).
 * Rate limiting: 10 req/min per IP on /message.
 */

const { Router } = require('express');
const cors = require('cors');
const { executeTool, registerVaultResolver, emailTranscript, transcriptDeliverable, resolveSecret } = require('../lib/quoxchatToolExecutors');
const configResolver = require('../lib/configResolver.js');
// QUOXCHAT-PRO P1 — office-hours evaluator + org alert channels.
const { evaluateAvailability } = require('../lib/quoxchatOfficeHours');
const { sendNotification } = require('../lib/notificationService');
const { buildWidgetEnvelope, buildAoclLayerEnvelope, hashInput, WIDGET_INTENTS } = require('../lib/quoxchatEnvelopes');
const { pickAgent, getPersona, DEFAULT_PERSONA_ID } = require('../lib/quoxchatDelegator');
const { sanitiseProactiveRules } = require('../lib/quoxchatProactive');
const { buildOverrideSystemPrompt, buildDefaultCustomerPrompt, isQuoxPersonaWidget, applyHandoffRule, buildGuardrailsBlock } = require('../lib/quoxchatPersonas');
const ingestLib = require('../lib/quoxchatIngest');
const { INJECTION_PATTERNS, makeCanary, canaryPreamble, canaryLeaked, requestedBareToken, isBareTokenReply, leaksSystemRules, REFUSAL: INJECTION_REFUSAL } = require('../lib/quoxchatInjectionGuard');
const { enrichVisitorPremises, stripConditionalYesNo, prepareKnowledge, buildAllowedUrls, enforceLinks, findUnsupportedFigures, figuresStillRemoved, buildGroundingRules, stripUnsupportedSentences, stripUnsupportedNegatives, redactDroppingFragments, stripKnowledgeLabels, buildRetrievalQuery, mergeCarriedChunks, stripBookingOffers, findBookingRoute, carryForwardLimit, applyTimeWindowGuard, applyOpenNowGuard, hasBookingTool, NO_BOOKING_RULE, confineBrowserContext, createSentenceGate, bestNextStep, modelIdentityReply, extractCaveats, asksForTranscript, strippedLeavesNonAnswer, isStrippedFragment, declineText, isPlainAbstain, isAbstainReply, CONFIDENT_ABSTAIN_SCORE, TRANSCRIPT_WITHHELD_REPLY } = require('../lib/quoxchatGrounding');
const quoxchatLexical = require('../lib/quoxchatLexical');
const { invalidateLexicalOnSuccess } = require('../lib/quoxchatLexicalInvalidate');
const lexicalInvalidate = invalidateLexicalOnSuccess((wid) => qdrantCollectionForWidget(wid));
const { buildPublicSources, selectCitedChunks, isSupersededSuggested, usedOutdatedSource } = require('../lib/quoxchatSourceRoutes');
const { fetchServerHistory, buildHistory } = require('../lib/quoxchatHistory');
const { modelHandoffAllowed, gateModelHandoff } = require('../lib/quoxchatHandoffIntent');
const { failoverOrder, mayFailOver, isRetryableProviderError, createProviderCooldowns, providerUnavailableReply } = require('../lib/quoxchatProviderFailover');
const { searchWithRetry, shouldReportRetrievalFailure, degradedRetrieval, RETRIEVAL_FAILED_REPLY } = require('../lib/quoxchatRetrievalGuard');
const { planStay, spanningProducts } = require('../lib/quoxchatSeasonStay');
const { priceCorrections, premiseFor: pricePremiseFor, enforcePriceCorrections } = require('../lib/quoxchatPricePremise');
const { planBlockTariff, enforceBlockTariff } = require('../lib/quoxchatBlockTariff');
const { completeDiscountFigure } = require('../lib/quoxchatDiscountFigure');
const { planOpenNow, enforceOpenNow } = require('../lib/quoxchatOpenNow');
const { planBandChange } = require('../lib/quoxchatBandChange');
const { planValidity, enforceValidity } = require('../lib/quoxchatValidity');
const { extractExceptions, matchedExceptions, exceptionPremises: buildExceptionPremises, enforceExceptions, stripOutsideWindowFigures } = require('../lib/quoxchatExceptions');
const { dateWindowPremises, applyDateWindowGuard } = require('../lib/quoxchatDateWindow');
const { dropDatedMoneyClaims, verifyClaims, stripClaimSentences, removeFlaggedSentences, pickVerifierModel, verifierOutageAction } = require('../lib/quoxchatClaimVerifier');
const { parseCompatConfig, assertCompatEgress, looksLikeToolsRejection, PROVIDER_ID: COMPAT_PROVIDER, SELF_HOSTED_LABEL } = require('../lib/quoxchatCompatLlm');
const requestDeadline = require('../lib/quoxchatDeadline');
const { markHistoryChunks } = require('../lib/quoxchatVersionArbiter');
const { applyPriceChange } = require('../lib/quoxchatPriceChange');
const { deadlinePlans, enforceDeadline, bandPremises } = require('../lib/quoxchatDueDate');
const { eligibilityChecks, enforceEligibility, capacityPremises } = require('../lib/quoxchatConditions');
const { canStartSecondPass, pickPricedRegen } = require('../lib/quoxchatSecondPass');
const { decideBudget, estimateAnswerCostMicro } = require('../lib/quoxchatBudget');
const { resolveKeySource } = require('../lib/quoxchatKeySource');
const handoffState = require('../lib/quoxchatHandoffState');
const { ledgerActionTexts, ledgerConfirmationReply, summariseOutcome, buildActionLedgerBlock, enforceActionHonesty, TRANSCRIPT_UNAVAILABLE_NOTE, buildDemoToolHint } = require('../lib/quoxchatActionLedger');
// Hard per-turn ceiling; must stay below the nginx/gateway read timeout (60 s).
// Keep lib/quoxchatSecondPass HARD_TURN_MS equal to this default.
let hardTurnDeadlineOverrideMs = null; // tests only
// QC W17: 30 s (was 45 s) so the visitor sees the apology well before the proxy gives up.
const hardTurnDeadlineMs = () => hardTurnDeadlineOverrideMs || 30000;
function _setHardTurnDeadlineMs(ms) { hardTurnDeadlineOverrideMs = ms || null; }
const DEADLINE_FALLBACK_TEXT = "Sorry, that took longer than I expected. Please try again in a moment, or ask to speak with the team.";
const providerCooldowns = createProviderCooldowns({ ms: 60000 });
let _groundingFaultForTest = false; // test seam: prove the gate fails closed
const { sanitiseToolResult, sanitiseString, redactPublicText } = require('../lib/quoxchatResultSanitiser');
const { defaultStore: sessionStore } = require('../lib/quoxchatSessionStore');
const { fetchAllowedDomains, fetchAllowedDomainsDetailed, enforceDomainGuard, extractHost, isDevOrigin } = require('../lib/quoxchatDomainGuard');
// LICENSE-ENFORCE LE-3f: entitlement gate on the public /message data plane.
const { isPluginLicensed: isPluginLicensedForOrg, licenseVerdict } = require('../lib/licenseGate');
const { validateOutboundUrlResolved, fetchWithRedirectValidation } = require('../lib/channels/baseDriver');
const { widgetTimezone, correctWeekdays, applyAllergyGuard, applyEmergencyGuard } = require('../lib/quoxchatSafety');
const { createStreamRedactor } = require('../lib/quoxchatStreamRedactor');
const { scrubEmDashes } = require('../lib/quoxchatVoiceScrub');
const { defaultStore: dailyCapStore } = require('../lib/quoxchatDailyCapStore');
// QUOXCHAT-PRO P2: governed Matrix room per handed-off conversation —
// provisioning, visitor puppet relay in, operator persistence, widget poll.
const matrixRelay = require('../lib/quoxchatMatrixRelay');
const { verifyCaptchaToken } = require('../lib/captchaVerifier');
const multer = require('multer');
const crypto = require('crypto');
const router = Router();

// ── QCL-IDENTITY P1 — verified visitor identity (HMAC) ──────────────────────
// A widget's identity_secret lets a host prove a visitor is who they say
// they are: user_hash = HMAC-SHA256(user_id, identity_secret), computed
// server-side by the host and passed to QuoxChat.identify(). We recompute
// the same HMAC here and compare it timing-safe (same pattern as
// lib/genericWebhook.js's validateWebhookSignature). Never throws — any
// malformed input (wrong-length hex, missing pieces) is just "not verified".
function verifyUserHash(userId, userHash, secret) {
  if (!userId || !userHash || !secret) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(String(userId)).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const suppliedBuf = Buffer.from(String(userHash), 'hex');
    if (expectedBuf.length === 0 || suppliedBuf.length === 0) return false;
    if (expectedBuf.length !== suppliedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, suppliedBuf);
  } catch {
    return false;
  }
}

// ── QCL-IDENTITY P2 — signed allowance (limit-bearing attrs) ───────────────
// The v1 signature covers user_id ONLY, so it can never vouch for an attr that
// raises a cap (a visitor with their own valid v1 hash could otherwise send
// action_quota_monthly=1000000000, ENG_01M4KR937C7A8P3DGCKG7A8P3D). Limit attrs
// are honoured only with a v2 allowance_sig:
//   allowance_sig = hex(HMAC-SHA256(identity_secret, canonical))
//   canonical     = "quoxchat-allowance-v2\nuser_id=<id>\n<attr>=<int>\n...\nexp=<unix seconds>"
// attrs sorted by name; today the only limit attr is action_quota_monthly.
// Any limit attr that differs from what was signed, or an expired exp, means
// the allowance is dropped (identity itself still verifies via v1).
const LIMIT_ATTRS = ['action_quota_monthly'];
const ALLOWANCE_PREFIX = 'quoxchat-allowance-v2';

function canonicalAllowance(userId, limits, exp) {
  const lines = [ALLOWANCE_PREFIX, `user_id=${String(userId)}`];
  for (const k of [...LIMIT_ATTRS].sort()) {
    if (limits && limits[k] !== undefined) lines.push(`${k}=${limits[k]}`);
  }
  lines.push(`exp=${exp}`);
  return lines.join('\n');
}

// Returns { ok, reason }. Never throws. `limits` = the limit attrs the caller
// supplied (all must be non-negative integers and are all covered by the sig).
function verifyAllowanceSig(userId, limits, exp, sig, secret, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    if (!userId || !sig || !secret) return { ok: false, reason: 'missing' };
    if (/[\r\n]/.test(String(userId))) return { ok: false, reason: 'bad_user_id' };
    const keys = Object.keys(limits || {}).filter((k) => limits[k] !== undefined);
    if (!keys.length) return { ok: false, reason: 'no_limits' };
    for (const k of keys) {
      if (!LIMIT_ATTRS.includes(k) || !Number.isInteger(limits[k]) || limits[k] < 0) return { ok: false, reason: 'bad_limit' };
    }
    const expN = typeof exp === 'string' && /^\d+$/.test(exp) ? Number(exp) : exp;
    if (!Number.isInteger(expN) || expN <= 0) return { ok: false, reason: 'bad_exp' };
    if (expN < nowSec) return { ok: false, reason: 'expired' };
    const expected = crypto.createHmac('sha256', secret).update(canonicalAllowance(userId, limits, expN)).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(sig), 'hex');
    if (a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, reason: 'ok' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// ── CW-9.2: Widget tool fetching + Anthropic tool_use loop ──────────────────

async function fetchWidgetTools(widgetId) {
  if (!widgetId || widgetId === 'demo') return [];
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return [];
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/tools`, {
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) {
      if (resp.status !== 404) console.warn(`[QuoxChat] fetch tools ${resp.status}`);
      return [];
    }
    const data = await resp.json().catch(() => ({}));
    return Array.isArray(data.tools) ? data.tools : [];
  } catch (err) {
    console.warn('[QuoxChat] fetchWidgetTools failed (non-fatal):', err.message);
    return [];
  }
}

// CW-9.3: returns conversation_id (existing active or newly created) so tools
// invoked during the LLM turn can attach side effects (leads, handoffs).
async function ensureConversation(widgetId, visitor_id) {
  if (!widgetId || widgetId === 'demo' || !visitor_id) return null;
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return null;
  // QC W17: one retry; under load a single 2 s attempt lost the conversation id
  // (visitor turns came back conversation_id:null and were never persisted).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/ensure-conversation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
        body: JSON.stringify({ visitor_id }),
        signal: AbortSignal.timeout(2500),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (data.conversation_id) return data.conversation_id;
      }
    } catch { /* retry once */ }
  }
  return null;
}

async function recordToolUsage(widgetId, toolId, success, visitorId, simulated) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey || !widgetId || !toolId) return;
  try {
    await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/tools/${encodeURIComponent(toolId)}/record-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify({ success: !!success, visitor_id: visitorId || null, simulated: !!simulated }),
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* fire-and-forget */ }
}

// ── QCL-SECURITY P0-1/P0-3/P1-2 — admin-only KB/simulation endpoints ────────
// The dashboard admin routes (KnowledgeTab, TrainingTab, SimulationTab,
// LogsTab) never call the widget on customer sites — they're proxied through
// auth's org-scoped /api/orgs/:orgId/widgets/:widgetId/* routes, which
// verify org membership + widget ownership, then forward here with
// x-service-key. This gate stops any internet caller from poisoning/reading
// a widget's KB or burning its LLM budget by hitting these routes directly
// with a guessed widget_id. Fail-closed: if INTERNAL_SERVICE_KEY is unset,
// every call is rejected (mirrors auth's requireInternalAuth in
// services/auth/routes/widgets.js and the /internal/tools/test-run check
// below). Timing-safe compare — same pattern as widgets.js's safeCompare.
function requireServiceKey(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return res.status(401).json({ error: 'service_key_not_configured' });
  const supplied = req.headers['x-service-key'];
  if (!supplied || typeof supplied !== 'string') return res.status(401).json({ error: 'unauthorized' });
  try {
    const expectedBuf = Buffer.from(expected);
    const suppliedBuf = Buffer.from(supplied);
    if (expectedBuf.length !== suppliedBuf.length || !crypto.timingSafeEqual(expectedBuf, suppliedBuf)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function toolsToAnthropicSchema(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.input_schema || { type: 'object', properties: {} },
  }));
}

// QCX-1.1: OpenAI function-calling schema. Same input → different shape.
function toolsToOpenAISchema(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

// QCX-1.2: Gemini functionDeclarations schema. All declarations live inside
// a single tools[0].functionDeclarations array (unlike OpenAI's tools[]).
function toolsToGeminiSchema(tools) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    })),
  }];
}

// QCX-4.1: Parse an Anthropic SSE response into the same shape the
// non-streaming JSON path returns ({ content, stop_reason, usage }).
// When onStream is provided, emits text deltas as they arrive.
// Tool-start events are deferred to the caller (emitted after input_json
// is fully assembled, so the widget can display real args).
async function readAnthropicStream(response, onStream) {
  const contentBlocksByIndex = new Map();     // index -> { type, id?, name?, text?, inputJson? }
  let stop_reason = null;
  let input_tokens = 0;
  let cache_creation_input_tokens = 0;
  let cache_read_input_tokens = 0;
  let output_tokens = 0;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse complete SSE events (separated by \n\n)
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      let data;
      try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }

      if (data.type === 'message_start') {
        input_tokens = data.message?.usage?.input_tokens || 0;
        cache_creation_input_tokens = data.message?.usage?.cache_creation_input_tokens || 0;
        cache_read_input_tokens = data.message?.usage?.cache_read_input_tokens || 0;
      } else if (data.type === 'content_block_start') {
        const block = { type: data.content_block?.type };
        if (block.type === 'text') {
          block.text = data.content_block.text || '';
        } else if (block.type === 'tool_use') {
          block.id = data.content_block.id;
          block.name = data.content_block.name;
          block.input = data.content_block.input || {};
          block.inputJson = '';
        }
        contentBlocksByIndex.set(data.index, block);
      } else if (data.type === 'content_block_delta') {
        const block = contentBlocksByIndex.get(data.index);
        if (!block) continue;
        if (data.delta?.type === 'text_delta' && block.type === 'text') {
          block.text += data.delta.text || '';
          if (onStream) { try { onStream({ type: 'text', delta: data.delta.text || '' }); } catch { /* non-fatal */ } }
        } else if (data.delta?.type === 'input_json_delta' && block.type === 'tool_use') {
          block.inputJson += data.delta.partial_json || '';
        }
      } else if (data.type === 'content_block_stop') {
        const block = contentBlocksByIndex.get(data.index);
        if (block?.type === 'tool_use') {
          if (block.inputJson) {
            try { block.input = JSON.parse(block.inputJson); } catch { /* keep empty */ }
          }
          if (onStream) {
            try { onStream({ type: 'tool_start', name: block.name, id: block.id, input: block.input || {} }); } catch { /* non-fatal */ }
          }
        }
      } else if (data.type === 'message_delta') {
        stop_reason = data.delta?.stop_reason || stop_reason;
        output_tokens = data.usage?.output_tokens || output_tokens;
      }
    }
  }

  const content = [];
  const indices = Array.from(contentBlocksByIndex.keys()).sort((a, b) => a - b);
  for (const i of indices) {
    const b = contentBlocksByIndex.get(i);
    if (b.type === 'text') content.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} });
  }
  return {
    content,
    stop_reason,
    usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens },
  };
}

// QCX-4.1: Parse an OpenAI SSE stream into the same shape the
// non-streaming JSON path returns ({ choices:[{message,finish_reason}], usage }).
// Accumulates tool_calls[] across delta frames — OpenAI streams tool-call
// arguments as string fragments by index; we reassemble into a parsed object
// and emit tool_start when the call completes (finish_reason === 'tool_calls').
async function readOpenAIStream(response, onStream) {
  const toolCalls = new Map();           // index -> { id, name, argsStr }
  let textContent = '';
  let finish_reason = null;
  let usage = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const raw = dataLines.join('\n');
      if (raw === '[DONE]') continue;

      let data;
      try { data = JSON.parse(raw); } catch { continue; }

      if (data.usage) usage = data.usage;
      const choice = Array.isArray(data.choices) ? data.choices[0] : null;
      if (!choice) continue;

      if (choice.finish_reason) finish_reason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        textContent += delta.content;
        if (onStream) { try { onStream({ type: 'text', delta: delta.content }); } catch { /* non-fatal */ } }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const slot = toolCalls.get(idx) || { id: null, name: null, argsStr: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') slot.argsStr += tc.function.arguments;
          toolCalls.set(idx, slot);
        }
      }
    }
  }

  // Finalise tool calls — parse args, emit tool_start now that each call is complete.
  const assembled = [];
  const indices = Array.from(toolCalls.keys()).sort((a, b) => a - b);
  for (const i of indices) {
    const slot = toolCalls.get(i);
    let args = {};
    try { args = slot.argsStr ? JSON.parse(slot.argsStr) : {}; } catch { args = {}; }
    if (onStream && slot.name) {
      try { onStream({ type: 'tool_start', name: slot.name, id: slot.id, input: args }); } catch { /* non-fatal */ }
    }
    assembled.push({
      id: slot.id,
      type: 'function',
      function: { name: slot.name, arguments: slot.argsStr || '{}' },
    });
  }

  return {
    choices: [{
      finish_reason,
      message: {
        role: 'assistant',
        content: textContent || null,
        ...(assembled.length > 0 ? { tool_calls: assembled } : {}),
      },
    }],
    usage: usage || {},
  };
}

// QCX-4.1: Parse a Gemini SSE stream into the same shape generateContent
// returns ({ candidates, usageMetadata }). Gemini streams text parts
// incrementally but functionCall parts arrive whole (one frame per call).
async function readGeminiStream(response, onStream) {
  const parts = [];
  let finishReason = null;
  let usageMetadata = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      let data;
      try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }

      if (data.usageMetadata) usageMetadata = data.usageMetadata;
      const candidate = data.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;

      for (const part of candidate.content?.parts || []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          // Merge successive text chunks into a single part so the caller sees
          // one coherent text block (the non-streaming path joins text parts
          // with \n, which would break up a streamed response mid-word).
          const last = parts[parts.length - 1];
          if (last && typeof last.text === 'string') last.text += part.text;
          else parts.push({ text: part.text });
          if (onStream) { try { onStream({ type: 'text', delta: part.text }); } catch { /* non-fatal */ } }
        } else if (part.functionCall) {
          const fc = part.functionCall;
          const input = (fc.args && typeof fc.args === 'object') ? fc.args : {};
          parts.push({ functionCall: fc });
          if (onStream) {
            try { onStream({ type: 'tool_start', name: fc.name, id: null, input }); } catch { /* non-fatal */ }
          }
        }
      }
    }
  }

  return {
    candidates: [{
      finishReason,
      content: { role: 'model', parts },
    }],
    usageMetadata: usageMetadata || {},
  };
}

// QCX-1.1: shared per-tool rate-limit check. Returns null when OK, an
// {ok:false,error:'rate_limited',...} execResult when exceeded.
//
// QCL-SECURITY P1-6: previously, a missing context.conversation_id fell
// back to `roundCounts` — a Map local to the current runXToolLoop() call
// (i.e. a single chat round). That reset on every request, so a caller
// that never sent (or rotated) conversation_id got `limit` tool calls PER
// MESSAGE with unlimited messages — the "session" cap never actually
// bound. Refuse outright instead: no durable session id means we cannot
// track usage across rounds, so we cannot safely allow a rate-limited
// tool at all. `roundCounts` param kept for call-site compatibility but is
// no longer read.
function checkToolRateLimit(tool, context, _roundCounts) {
  const limit = tool.rate_limit_per_session;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!context?.conversation_id) {
    return { ok: false, error: 'rate_limited', message: `${tool.name} requires an active session (conversation_id) for rate-limited tools` };
  }
  const check = sessionStore.checkAndIncrement(context.conversation_id, tool.id, limit);
  if (check.ok) return null;
  return { ok: false, error: 'rate_limited', message: `${tool.name} exceeded per-session limit (${limit})` };
}

/**
 * quox#547 — client-cancellation plumbing shared by the three tool loops.
 * A caller-supplied AbortSignal (e.g. the /chat/stream client disconnecting)
 * must stop the turn: no new provider request, no new tool execution, and
 * the in-flight provider fetch torn down. A tool ALREADY executing is
 * allowed to finish — a half-done side effect is worse than a completed one.
 *
 * Which callers pass a signal is a per-surface product decision, not a
 * blanket rule: /chat/stream and /teach/propose cancel on disconnect
 * (their output exists only on the open connection), while the /message
 * widget sites deliberately do NOT — the reply persists to conversation
 * history, so a visitor dropping mid-turn should still find the answer
 * waiting when they reload.
 */
function throwIfClientAborted(signal) {
  if (signal?.aborted) {
    const e = new Error('client_aborted: caller cancelled this turn');
    e.name = 'AbortError';
    e.code = 'client_aborted';
    throw e;
  }
}

function providerFetchSignal(signal, ms = 15000) {
  // Capped to what is left of the request's time budget (lib/quoxchatDeadline).
  const timeout = AbortSignal.timeout(requestDeadline.cappedTimeoutMs(ms));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Runs an agentic tool_use loop against the Anthropic Messages API.
 * Returns { text, inputTokens, outputTokens, toolCalls } — toolCalls is the
 * audit log of every tool invocation (for persistence + AEE).
 *
 * Bounds: 3 iterations max. Per-session rate limits enforced via
 * rate_limit_per_session on each tool (best-effort, in-process counter).
 */
async function runAnthropicToolLoop({ apiKey, model, systemPrompt, messages, tools, widget, context, onStream, signal }) {
  const toolSchemas = toolsToAnthropicSchema(tools);
  const toolsById = new Map();
  const toolsByName = new Map();
  for (const t of tools) {
    toolsById.set(t.id, t);
    toolsByName.set(t.name, t);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls = [];
  // Per-round fallback counter for conversations without an id.
  // The conversation-bound store (sessionStore) handles the normal path.
  const roundCounts = new Map();
  const workingMessages = messages.slice();
  let finalText = '';

  const MAX_ITERATIONS = 3;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    throwIfClientAborted(signal);
    // Per-request time budget: a later round stops and answers with what it
    // has; a first round that cannot start fails fast (no stacked 15s waits).
    if (iter > 0 && requestDeadline.remainingMs() < requestDeadline.MIN_USEFUL_MS) {
      finalText = finalText || DEADLINE_FALLBACK_TEXT;
      break;
    }
    if (iter === 0 && requestDeadline.expired()) throw requestDeadline.deadlineError();
    const body = {
      model,
      max_tokens: 1024,
      // QUOXCHAT-BRUTALOOP ITER 1: low temperature for a grounded support
      // bot (provider default 1.0 re-rolled premises on re-ask in wave 1).
      temperature: 0.2,
      // CW-12.2: Anthropic prompt caching. System prompt is stable across
      // turns of one chat → cache it so repeat turns pay ~10% of input cost
      // for the cached prefix. Using ephemeral (5m) cache tier; fine for
      // chat sessions. Costs accounting is billed by Anthropic.
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: workingMessages,
    };
    if (toolSchemas.length > 0) body.tools = toolSchemas;
    if (onStream) body.stream = true;

    const llmResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: providerFetchSignal(signal),
    });
    if (!llmResp.ok) {
      const errBody = await llmResp.text().catch(() => '');
      const e = new Error(`Anthropic ${llmResp.status}: ${errBody.slice(0, 200)}`);
      e.status = llmResp.status;
      throw e;
    }
    const llmData = onStream
      ? await readAnthropicStream(llmResp, onStream)
      : await llmResp.json();
    // CW-12.2: usage now also reports cache_creation_input_tokens and
    // cache_read_input_tokens. Aggregate into inputTokens so budget tracking
    // stays correct; callers who care about cache efficiency read llmData.usage
    // directly via the returned toolCalls metadata in future phases.
    const uncached = llmData.usage?.input_tokens || 0;
    const cacheCreate = llmData.usage?.cache_creation_input_tokens || 0;
    const cacheRead = llmData.usage?.cache_read_input_tokens || 0;
    inputTokens += uncached + cacheCreate + cacheRead;
    outputTokens += llmData.usage?.output_tokens || 0;

    const contentBlocks = Array.isArray(llmData.content) ? llmData.content : [];
    const textBlocks = contentBlocks.filter(b => b.type === 'text').map(b => b.text).filter(Boolean);
    const toolUseBlocks = contentBlocks.filter(b => b.type === 'tool_use');

    if (textBlocks.length > 0) finalText = textBlocks.join('\n');

    if (llmData.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) break;

    // Append assistant message with its tool_use blocks verbatim (Anthropic protocol)
    workingMessages.push({ role: 'assistant', content: contentBlocks });

    // Execute each tool, build tool_result content for the next turn
    const toolResultContent = [];
    for (const use of toolUseBlocks) {
      const tool = toolsByName.get(use.name);
      let execResult;
      if (!tool) {
        execResult = { ok: false, error: 'unknown_tool', message: `${use.name} not registered` };
      } else {
        // Per-session rate limit — conversation-bound (survives across chat
        // rounds). QCL-SECURITY P1-6: use the shared helper (refuses when
        // no conversation_id, rather than duplicating the old per-round
        // fallback here).
        throwIfClientAborted(signal);
        execResult = gateModelHandoff(tool, context) || checkToolRateLimit(tool, context, roundCounts);
        if (!execResult) {
          if (context) context.toolExecutions = (context.toolExecutions || 0) + 1;
          execResult = await executeTool({ widget, tool, input: use.input || {}, context });
        }
      }

      // QUOXCHAT-BRUTALOOP ITER 1: tool output is grounding support for the
      // post-generation figure/link gate (kept off toolCalls, which persist).
      if (execResult?.ok && context && Array.isArray(context.toolResultTexts)) {
        try { context.toolResultTexts.push(JSON.stringify(execResult.result ?? null).slice(0, 4000)); } catch { /* non-fatal */ }
      }
      toolCalls.push({
        tool_id: tool?.id || null,
        name: use.name,
        input: use.input || {},
        ok: !!execResult?.ok,
        error: execResult?.error || null,
        ts: new Date().toISOString(),
        // REPLY DETERMINISM: carry the executor's visitor-facing confirmation
        // so /message can make it win over whatever the LLM narrates.
        result_message: (execResult?.ok && typeof execResult?.result?.message === 'string') ? execResult.result.message : null,
        // needs_input fix — mirror the executor's needs_input (if any) so
        // /message can surface it top-level for the widget's inline form.
        needs_input: (execResult?.ok && execResult?.needs_input) ? execResult.needs_input : null,
        // Action ledger: reference / preferred time / duplicate only (no email).
        ...summariseOutcome(execResult),
      });
      if (tool?.id) recordToolUsage(widget?.id, tool.id, !!execResult?.ok, context?.visitor_id, context?.simulation);

      if (onStream) {
        try { onStream({ type: 'tool_result', name: use.name, ok: !!execResult?.ok, error: execResult?.error || null }); } catch { /* non-fatal */ }
      }

      const rawPayload = execResult?.ok ? (execResult.result ?? null) : { error: execResult?.error, message: execResult?.message || '' };
      toolResultContent.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(sanitiseToolResult(rawPayload)),
        is_error: !execResult?.ok,
      });
    }
    workingMessages.push({ role: 'user', content: toolResultContent });
  }

  return { text: finalText, inputTokens, outputTokens, toolCalls };
}

/**
 * QCX-1.1 — OpenAI tool loop. Parity with runAnthropicToolLoop.
 * Uses OpenAI's function-calling protocol:
 *   request:  tools[] + tool_choice:'auto'
 *   response: choices[0].message.tool_calls[].{id, function:{name, arguments}}
 *   feedback: assistant message with tool_calls + role:'tool' message per call
 * Same bounds (3 iterations, session rate limit, sanitised results).
 */
async function runOpenAIToolLoop({ apiKey, model, systemPrompt, messages, tools, widget, context, onStream, signal, compat }) {
  // compat (OpenAI-compatible endpoint, see lib/quoxchatCompatLlm.js):
  // { parsed } = the parsed widget llm config. The egress decision is taken
  // before every request; redirects are never followed.
  let toolSchemas = toolsToOpenAISchema(tools);
  let compatToolsDropped = false;
  const toolsByName = new Map();
  for (const t of tools) toolsByName.set(t.name, t);

  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls = [];
  const roundCounts = new Map();
  // OpenAI carries the system prompt as a message, not top-level.
  const workingMessages = [{ role: 'system', content: systemPrompt }, ...messages];
  let finalText = '';

  const MAX_ITERATIONS = 3;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    throwIfClientAborted(signal);
    // Per-request time budget: a later round stops and answers with what it
    // has; a first round that cannot start fails fast (no stacked 15s waits).
    if (iter > 0 && requestDeadline.remainingMs() < requestDeadline.MIN_USEFUL_MS) {
      finalText = finalText || DEADLINE_FALLBACK_TEXT;
      break;
    }
    if (iter === 0 && requestDeadline.expired()) throw requestDeadline.deadlineError();
    const body = {
      model,
      messages: workingMessages,
    };
    // gpt-5-family rejects max_tokens (requires max_completion_tokens) —
    // same rename lib/openaiRequest.js's buildOpenAIChatCompletionBody handles.
    if (/^gpt-5($|[-.])/.test(String(model || ''))) {
      body.max_completion_tokens = 1024;
    } else {
      body.max_tokens = 1024;
    }
    // QUOXCHAT-BRUTALOOP ITER 1: low temperature for grounded answers.
    // Reasoning families (gpt-5*, o-series) reject a non-default value.
    if (!/^(gpt-5|o\d)($|[-.])/.test(String(model || ''))) body.temperature = 0.2;
    if (toolSchemas.length > 0) {
      body.tools = toolSchemas;
      body.tool_choice = 'auto';
    }
    if (onStream) {
      body.stream = true;
      // Without include_usage, OpenAI omits the usage block in streamed responses.
      body.stream_options = { include_usage: true };
    }

    const callEndpoint = async (reqBody) => {
      if (!compat) {
        return fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          signal: providerFetchSignal(signal),
        });
      }
      await assertCompatEgress(compat.parsed, { resolver: compat.resolver });
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      return fetch(compat.parsed.chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        redirect: 'manual',
        signal: providerFetchSignal(signal),
      });
    };
    let llmResp = await callEndpoint(body);
    // Some self-hosted models/servers reject the tools parameter. Retry once
    // without tools and record it (the reply then cannot call widget tools).
    if (compat && !llmResp.ok && body.tools) {
      const peek = await llmResp.text().catch(() => '');
      if (looksLikeToolsRejection(llmResp.status, peek)) {
        delete body.tools; delete body.tool_choice;
        toolSchemas = []; compatToolsDropped = true;
        if (context) context.compatToolsUnsupported = true;
        llmResp = await callEndpoint(body);
      } else {
        llmResp = new Response(peek, { status: llmResp.status });
      }
    }
    if (!llmResp.ok) {
      const errBody = await llmResp.text().catch(() => '');
      const e = new Error(`${compat ? 'OpenAI-compatible endpoint' : 'OpenAI'} ${llmResp.status}: ${errBody.slice(0, 200)}`);
      e.status = llmResp.status;
      throw e;
    }
    const llmData = onStream
      ? await readOpenAIStream(llmResp, onStream)
      : await llmResp.json();
    inputTokens += llmData.usage?.prompt_tokens || 0;
    outputTokens += llmData.usage?.completion_tokens || 0;

    const choice = llmData.choices?.[0] || {};
    const message = choice.message || {};
    const toolCallList = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (typeof message.content === 'string' && message.content.length > 0) finalText = message.content;

    if (choice.finish_reason !== 'tool_calls' || toolCallList.length === 0) break;

    // Append assistant turn verbatim — OpenAI protocol requires the same
    // tool_calls array echoed back so subsequent role:tool messages can
    // reference tool_call_id.
    workingMessages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCallList,
    });

    for (const tc of toolCallList) {
      const fn = tc.function || {};
      const name = fn.name;
      let input = {};
      try { input = JSON.parse(fn.arguments || '{}'); }
      catch { input = {}; /* malformed → empty, never crash */ }

      const tool = toolsByName.get(name);
      let execResult;
      if (!tool) {
        execResult = { ok: false, error: 'unknown_tool', message: `${name} not registered` };
      } else {
        throwIfClientAborted(signal);
        execResult = gateModelHandoff(tool, context) || checkToolRateLimit(tool, context, roundCounts);
        if (!execResult) {
          if (context) context.toolExecutions = (context.toolExecutions || 0) + 1;
          execResult = await executeTool({ widget, tool, input, context });
        }
      }

      // QUOXCHAT-BRUTALOOP ITER 1: tool output is grounding support for the
      // post-generation figure/link gate (kept off toolCalls, which persist).
      if (execResult?.ok && context && Array.isArray(context.toolResultTexts)) {
        try { context.toolResultTexts.push(JSON.stringify(execResult.result ?? null).slice(0, 4000)); } catch { /* non-fatal */ }
      }
      toolCalls.push({
        tool_id: tool?.id || null,
        name,
        input,
        ok: !!execResult?.ok,
        error: execResult?.error || null,
        ts: new Date().toISOString(),
        // REPLY DETERMINISM: carry the executor's visitor-facing confirmation
        // so /message can make it win over whatever the LLM narrates.
        result_message: (execResult?.ok && typeof execResult?.result?.message === 'string') ? execResult.result.message : null,
        // needs_input fix — mirror the executor's needs_input (if any) so
        // /message can surface it top-level for the widget's inline form.
        needs_input: (execResult?.ok && execResult?.needs_input) ? execResult.needs_input : null,
        // Action ledger: reference / preferred time / duplicate only (no email).
        ...summariseOutcome(execResult),
      });
      if (tool?.id) recordToolUsage(widget?.id, tool.id, !!execResult?.ok, context?.visitor_id, context?.simulation);

      if (onStream) {
        try { onStream({ type: 'tool_result', name, ok: !!execResult?.ok, error: execResult?.error || null }); } catch { /* non-fatal */ }
      }

      const rawPayload = execResult?.ok ? (execResult.result ?? null) : { error: execResult?.error, message: execResult?.message || '' };
      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(sanitiseToolResult(rawPayload)),
      });
    }
  }

  return { text: finalText, inputTokens, outputTokens, toolCalls, ...(compatToolsDropped ? { toolsUnsupported: true } : {}) };
}


/**
 * QCX-1.2 — Gemini tool loop. Parity with the other two loops.
 * Uses Gemini's functionDeclarations protocol:
 *   request:  tools[0].functionDeclarations + toolConfig.functionCallingConfig.mode='AUTO'
 *   response: candidates[0].content.parts[].functionCall.{name, args}   (args is parsed object)
 *   feedback: assistant turn as role:model with functionCall parts +
 *             role:user turn with functionResponse parts
 * Same bounds (3 iterations, session rate limit, sanitised results).
 */
async function runGeminiToolLoop({ apiKey, model, systemPrompt, messages, tools, widget, context, onStream, signal, thinkingBudget }) {
  const toolSchemas = toolsToGeminiSchema(tools);
  const toolsByName = new Map();
  for (const t of tools) toolsByName.set(t.name, t);

  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls = [];
  const roundCounts = new Map();
  // Gemini carries the system prompt top-level; conversation history lives in contents[].
  const workingContents = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));
  let finalText = '';

  const MAX_ITERATIONS = 3;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    throwIfClientAborted(signal);
    // Per-request time budget: a later round stops and answers with what it
    // has; a first round that cannot start fails fast (no stacked 15s waits).
    if (iter > 0 && requestDeadline.remainingMs() < requestDeadline.MIN_USEFUL_MS) {
      finalText = finalText || DEADLINE_FALLBACK_TEXT;
      break;
    }
    if (iter === 0 && requestDeadline.expired()) throw requestDeadline.deadlineError();
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: workingContents,
      generationConfig: { maxOutputTokens: 1024, temperature: 0.2, ...(Number.isInteger(thinkingBudget) ? { thinkingConfig: { thinkingBudget } } : {}) },
    };
    if (tools.length > 0) {
      body.tools = toolSchemas;
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const endpoint = onStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}${onStream ? '&' : '?'}key=${apiKey}`;
    const llmResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: providerFetchSignal(signal),
    });
    if (!llmResp.ok) {
      const errBody = await llmResp.text().catch(() => '');
      const e = new Error(`Gemini ${llmResp.status}: ${errBody.slice(0, 200)}`);
      e.status = llmResp.status;
      throw e;
    }
    const llmData = onStream
      ? await readGeminiStream(llmResp, onStream)
      : await llmResp.json();
    inputTokens += llmData.usageMetadata?.promptTokenCount || 0;
    outputTokens += llmData.usageMetadata?.candidatesTokenCount || 0;

    const candidate = llmData.candidates?.[0] || {};
    const parts = candidate.content?.parts || [];
    const textParts = parts.filter(p => typeof p.text === 'string').map(p => p.text);
    const functionCalls = parts.filter(p => p.functionCall);

    if (textParts.length > 0) finalText = textParts.join('\n');

    // Detect "tool call" by presence of functionCall parts — finishReason is
    // typically STOP even when the model wants to call a tool.
    if (functionCalls.length === 0) break;

    // Echo the assistant turn verbatim (model-role parts) so the next call
    // has the full trace.
    workingContents.push({ role: 'model', parts: candidate.content?.parts || [] });

    const responseParts = [];
    for (const fcPart of functionCalls) {
      const fc = fcPart.functionCall || {};
      const name = fc.name;
      const input = (fc.args && typeof fc.args === 'object') ? fc.args : {};

      const tool = toolsByName.get(name);
      let execResult;
      if (!tool) {
        execResult = { ok: false, error: 'unknown_tool', message: `${name} not registered` };
      } else {
        throwIfClientAborted(signal);
        execResult = gateModelHandoff(tool, context) || checkToolRateLimit(tool, context, roundCounts);
        if (!execResult) {
          if (context) context.toolExecutions = (context.toolExecutions || 0) + 1;
          execResult = await executeTool({ widget, tool, input, context });
        }
      }

      // QUOXCHAT-BRUTALOOP ITER 1: tool output is grounding support for the
      // post-generation figure/link gate (kept off toolCalls, which persist).
      if (execResult?.ok && context && Array.isArray(context.toolResultTexts)) {
        try { context.toolResultTexts.push(JSON.stringify(execResult.result ?? null).slice(0, 4000)); } catch { /* non-fatal */ }
      }
      toolCalls.push({
        tool_id: tool?.id || null,
        name,
        input,
        ok: !!execResult?.ok,
        error: execResult?.error || null,
        ts: new Date().toISOString(),
        // REPLY DETERMINISM: carry the executor's visitor-facing confirmation
        // so /message can make it win over whatever the LLM narrates.
        result_message: (execResult?.ok && typeof execResult?.result?.message === 'string') ? execResult.result.message : null,
        // needs_input fix — mirror the executor's needs_input (if any) so
        // /message can surface it top-level for the widget's inline form.
        needs_input: (execResult?.ok && execResult?.needs_input) ? execResult.needs_input : null,
        // Action ledger: reference / preferred time / duplicate only (no email).
        ...summariseOutcome(execResult),
      });
      if (tool?.id) recordToolUsage(widget?.id, tool.id, !!execResult?.ok, context?.visitor_id, context?.simulation);

      if (onStream) {
        try { onStream({ type: 'tool_result', name, ok: !!execResult?.ok, error: execResult?.error || null }); } catch { /* non-fatal */ }
      }

      const rawPayload = execResult?.ok ? (execResult.result ?? null) : { error: execResult?.error, message: execResult?.message || '' };
      responseParts.push({
        functionResponse: {
          name,
          response: { content: sanitiseToolResult(rawPayload) },
        },
      });
    }
    workingContents.push({ role: 'user', parts: responseParts });
  }

  return { text: finalText, inputTokens, outputTokens, toolCalls };
}


// ── CORS: Allow any origin for widget endpoints ──
// Widgets run on customer websites — we can't predict their domains.
// Auth is via widget_id + public_key validation, not CORS.
router.use(cors({
  origin: true, // Allow all origins
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false, // Widgets don't use cookies
}));

// ── QC-HOLES embed blocker: helmet's app-level default is
// Cross-Origin-Resource-Policy: same-origin, which makes browsers refuse the
// <script src=".../quoxchat/widget.js"> tag on ANY customer domain
// (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin) even though CORS is open. These
// routes exist to be embedded cross-origin; override CORP for them only.
router.use((req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// ── Rate Limiting ──
// Simple in-memory rate limiter (adequate for single-instance collector)
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX = 10; // 10 requests per minute per IP

function rateLimit(req, res, next) {
  const key = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (entry && (now - entry.windowStart) < RATE_WINDOW_MS) {
    if (entry.count >= RATE_MAX) {
      return res.status(429).json({ error: 'Too many requests. Please try again in a moment.' });
    }
    entry.count++;
  } else {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
  }

  // Cleanup old entries every 100 requests
  if (rateLimitMap.size > 1000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.windowStart > RATE_WINDOW_MS * 2) rateLimitMap.delete(k);
    }
  }

  next();
}

// w5h: the public /message limiter. The shared per-IP limiter above (10/min)
// made an office of visitors behind one NAT 429 each other after ten messages
// in total. /message now counts per (IP, visitor_id) at the same 10/min, plus
// a higher per-IP ceiling that still bounds an abuser rotating visitor ids.
const MESSAGE_RATE_PER_VISITOR = 10; // per minute per (IP, visitor_id)
const MESSAGE_RATE_PER_IP = 120; // per minute per IP, all visitors combined

function _bumpRate(key, max, now) {
  const entry = rateLimitMap.get(key);
  if (entry && (now - entry.windowStart) < RATE_WINDOW_MS) {
    if (entry.count >= max) return false;
    entry.count++;
  } else {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
  }
  return true;
}

function messageRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const rawVisitor = req.body && typeof req.body.visitor_id === 'string' ? req.body.visitor_id : '';
  const visitor = rawVisitor.slice(0, 128) || 'anon';
  const now = Date.now();
  // Check both before counting either, so a refused request burns no budget.
  const ipEntry = rateLimitMap.get(`msg-ip:${ip}`);
  const vKey = `msg-v:${ip}:${visitor}`;
  const vEntry = rateLimitMap.get(vKey);
  const full = (e, max) => e && (now - e.windowStart) < RATE_WINDOW_MS && e.count >= max;
  if (full(ipEntry, MESSAGE_RATE_PER_IP) || full(vEntry, MESSAGE_RATE_PER_VISITOR)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a moment.' });
  }
  _bumpRate(`msg-ip:${ip}`, MESSAGE_RATE_PER_IP, now);
  _bumpRate(vKey, MESSAGE_RATE_PER_VISITOR, now);
  if (rateLimitMap.size > 1000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.windowStart > RATE_WINDOW_MS * 2) rateLimitMap.delete(k);
    }
  }
  next();
}

// ── Captcha degraded-mode fallback limiter (ledger critical #4, 2026-07-24) ──
// The transcript captcha is env-configured (owner-registered reCAPTCHA keys).
// Old behavior when the keys were absent: transcript email hard-denied
// (feature inert). New behavior: the captcha-gated surfaces degrade HONESTLY
// instead of going inert — the transcript executor runs without captcha
// (its structural belts still apply: self-only recipient, one send per
// conversation, daily side-effect cap), and /message + /transcript/email
// fall back to a per-IP rate limit tighter than the normal RATE_MAX. When
// the secret IS configured, this middleware is a pass-through and the
// captcha verification path fails closed exactly as designed.
// QUOXCHAT-EMAIL P2 — the env-keyed transcript captcha
// (QUOXCHAT_TRANSCRIPT_RECAPTCHA_*) is retired in favour of the per-widget
// bot_protection surface (#127). The tighter per-IP limit on
// /transcript/email below is now UNCONDITIONAL: transcript sends are rare by
// design (one per conversation), so 3/min/IP costs a human nothing and belts
// widgets that have not configured bot_protection.
const CAPTCHA_FALLBACK_TRANSCRIPT_MAX = 3; // transcript sends are rare by design
const captchaFallbackRateLimitMap = new Map();
function makeCaptchaFallbackRateLimit(max) {
  return function captchaFallbackRateLimit(req, res, next) {
    const key = `${max}:${req.ip || req.connection.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const entry = captchaFallbackRateLimitMap.get(key);
    if (entry && (now - entry.windowStart) < RATE_WINDOW_MS) {
      if (entry.count >= max) {
        return res.status(429).json({ error: 'Too many requests. Please try again in a moment.' });
      }
      entry.count++;
    } else {
      captchaFallbackRateLimitMap.set(key, { windowStart: now, count: 1 });
    }
    if (captchaFallbackRateLimitMap.size > 1000) {
      for (const [k, v] of captchaFallbackRateLimitMap) {
        if (now - v.windowStart > RATE_WINDOW_MS * 2) captchaFallbackRateLimitMap.delete(k);
      }
    }
    next();
  };
}
const captchaFallbackTranscriptLimit = makeCaptchaFallbackRateLimit(CAPTCHA_FALLBACK_TRANSCRIPT_MAX);
// Test-only: limiter state is per-IP and module-level; tests that exercise
// the 429 path reset BOTH maps (fallback + normal) so their request
// arithmetic is exact and files stay order-independent.
function _resetCaptchaFallbackRateLimit() {
  captchaFallbackRateLimitMap.clear();
  rateLimitMap.clear();
}

// Dependencies injected from server.js
let _getProviderKeys, _getClaudeKeys, _storeAuditEnvelope, _voltEmitter;

// QC-BRUTALOOP-W13: the visitor turn's provider-key resolution. A transient
// auth/vault blip (or the 10s negative cache after one) used to surface as
// "offline due to a configuration issue" for a single turn. Retry once after a
// short backoff with the negative cache dropped, and fall back to the last good
// resolution for a short TTL so a blip never reaches the visitor.
const LAST_GOOD_KEYS_TTL_MS = 5 * 60 * 1000;
const KEY_RETRY_BACKOFF_MS = 250;
const _lastGoodProviderKeys = new Map();
function _hasLlmKey(k) {
  return Boolean(k?.openai_api_key || k?.anthropic_api_key || k?.gemini_api_key
    || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
}
async function _getProviderKeysResilient(orgId) {
  const cacheKey = orgId || 'default';
  let keys = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { keys = await _getProviderKeys(orgId); } catch (e) { console.warn('[QuoxChat] provider key resolve failed:', e?.message); keys = null; }
    if (_hasLlmKey(keys)) {
      _lastGoodProviderKeys.set(cacheKey, { at: Date.now(), keys });
      return keys;
    }
    if (attempt === 0) {
      try { require('../lib/providerKeys').invalidate(orgId); } catch { /* best effort */ }
      await new Promise((r) => setTimeout(r, KEY_RETRY_BACKOFF_MS));
    }
  }
  const good = _lastGoodProviderKeys.get(cacheKey);
  if (good && (Date.now() - good.at) < LAST_GOOD_KEYS_TTL_MS) {
    console.warn(`[QuoxChat] provider key resolution empty for org ${orgId || 'default'}; serving last good resolution`);
    return good.keys;
  }
  return keys;
}

function init({ getProviderKeys, getClaudeKeys, storeAuditEnvelope, resolveCredentialById, resolveCredentials, voltEmitter }) {
  // Fresh dependencies, fresh caches (production calls init once at boot;
  // test suites call it per test, so cached widget orgs never leak).
  _widgetOrgCache.clear();
  _lastGoodProviderKeys.clear();
  _getProviderKeys = getProviderKeys;
  _getClaudeKeys = getClaudeKeys;
  _storeAuditEnvelope = storeAuditEnvelope;
  _voltEmitter = voltEmitter || null; // QCX-2.3: optional VOLT recorder
  // QCX-1.3: pipe the collector's existing QuoxVault resolver into the
  // executors module so connector credentials come from per-org vault
  // entries instead of platform env vars.
  if (typeof resolveCredentialById === 'function') {
    registerVaultResolver(resolveCredentialById);
  }
  // BRAIN2-FABLE11: the org's ollama connection (local embeddings) resolves through the same vault.
  ollamaEmbed.configureOllamaEmbed({ resolveCredentials, resolveCredentialById });
}

// CW-EMBED: pluggable RAG embedding provider. Defaults to Gemini
// (gemini-embedding-001) so existing dev collections are unaffected;
// set QUOXCHAT_EMBED_PROVIDER=openai (with an openai_api_key present) to
// embed via OpenAI text-embedding-3-small instead, so a widget can run
// entirely on an OpenAI key. Both paths request QDRANT_VECTOR_SIZE (768)
// dimensions so vectors keep matching the existing qdrant collection.
// Returns { vector, provider, model } on success, or null on any failure
// (missing key, non-ok response, network error/timeout) — callers already
// treat a missing/empty vector as "skip RAG for this call" and fall through.
// Single-retry fetch that backs off once on HTTP 429 (rate limit), honouring
// Retry-After when present (capped). Centralises the per-call 429 pause the
// scattered pre-embedText ingest sites used to do, so bulk ingest/crawl still
// survives provider rate limits. Any non-429 response (ok or not) returns as-is.
async function _embedFetch429(url, opts, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    if (resp.status !== 429 || attempt === 1) return resp;
    const ra = parseInt(resp.headers.get('retry-after') || '', 10);
    const waitMs = Math.min(Number.isFinite(ra) ? ra * 1000 : 2000, 5000);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// BRAIN2-SEMANTIC (2026-08-25): bound embed input client-side. OpenAI's
// text-embedding-3-small rejects >8192 tokens with a 400, which left
// over-length chunks permanently unembedded (the backfill retried them every
// tick). 24000 chars ≈ 6-8k tokens across prose/code — a truncated embedding
// still retrieves; an unembedded chunk never does. Applied to both providers
// so what gets embedded is provider-independent.
const EMBED_MAX_INPUT_CHARS = 24000;

// BRAIN2-W11: OpenAI model = BRAIN_EMBED_MODEL setting (lib/brainEmbedModel.js).
const { resolveOpenAIEmbedModel, openAIEmbedStamp } = require('../lib/brainEmbedModel.js');
// BRAIN2-FABLE11: local embeddings via the org's Ollama connection (zero third-party egress).
const ollamaEmbed = require('../lib/ollamaEmbed.js');

async function embedText(text, providerKeys, { timeoutMs = 10000, orgId = null, model = null, diag = null, ollamaDeps = undefined } = {}) {
  // QC-W18b: `diag` (optional) receives { provider, status } on failure: no bodies, no keys.
  const setDiag = (provider, status) => { if (diag) { diag.provider = provider; diag.status = status; } };
  if (typeof text === 'string' && text.length > EMBED_MAX_INPUT_CHARS) {
    text = text.slice(0, EMBED_MAX_INPUT_CHARS);
  }
  // Default to OpenAI: the OpenAI branch below falls through to Gemini when no
  // OpenAI key is present, so a widget with EITHER BYOK key always embeds.
  // The old 'gemini' default silently returned null for OpenAI-only widgets,
  // which killed RAG on prod for days (embedding_failed, degraded answers).
  //
  // VAULT-INTEG P17: was a bare process.env read — now resolved via
  // configResolver.getSetting(orgId, ...)/getInstanceSetting()
  // (platformCapabilities.js QUOXCHAT_EMBED_PROVIDER), org-scoped whenever
  // a caller resolved the widget/request org (see the 4 call sites below).
  // The registry entry's own default was corrected from the stale 'gemini'
  // to 'openai' in the same change — see that entry's note for why this
  // mattered: this read site NOW actually consults the default, where
  // before it only affected a read-only display.
  const embedProvider = (orgId
    ? configResolver.getSetting(orgId, 'QUOXCHAT_EMBED_PROVIDER').value
    : configResolver.getInstanceSetting('QUOXCHAT_EMBED_PROVIDER').value) || 'openai';

  // Default timeout matches what the ingestion call sites (chunk embedding
  // during crawl/upload) already learned they needed — those pass an explicit
  // 10000ms override. The live query paths (chat RAG search, knowledge/search)
  // used to fall through to a 5000ms default, tight enough that an ordinary
  // slow response from the embedding provider (not an outage, just latency)
  // silently killed RAG for that request. Confirmed intermittent on prod
  // 2026-08-09 (license-watch.sh's embed probe flapped ok/embed_broken every
  // ~15-90min with no permanent misconfiguration behind it).

  // BRAIN2-FABLE11: an org that chose ollama embeds locally or not at all. NO fallthrough
  // to OpenAI/Gemini on failure (that would be the egress the org opted out of), and an
  // explicit non-ollama model (a previous-space query) is refused for the same reason.
  // An explicit ollama stamp from an org on another provider is local, so it is allowed
  // (it is how a query reaches an ollama-embedded space after the provider is switched away).
  const explicitOllama = ollamaEmbed.isOllamaStamp(model);
  if (embedProvider === 'ollama' || explicitOllama) {
    if (embedProvider === 'ollama' && model && !explicitOllama) {
      console.warn(`[QuoxChat] embedText: refusing explicit model "${model}" for an org embedding via ollama (would send text to a third party).`);
      setDiag('ollama', null);
      if (diag) diag.error = 'third_party_model_refused';
      return null;
    }
    return ollamaEmbed.embedWithOllama(text, { orgId, model, timeoutMs, diag, deps: ollamaDeps });
  }

  if (embedProvider === 'openai') {
    const openaiKey = providerKeys?.openai_api_key || process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const openAiModel = resolveOpenAIEmbedModel(model);
      try {
        const resp = await _embedFetch429('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({ model: openAiModel, input: text, dimensions: QDRANT_VECTOR_SIZE }),
        }, timeoutMs);
        if (!resp.ok) {
          // Loud, not silent (2026-08-09): a caller only ever saw this as an
          // opaque embedding_failed 502, with zero server-side trace of why.
          const bodyExcerpt = await resp.text().catch(() => '');
          console.warn(`[QuoxChat] embedText: OpenAI embed HTTP ${resp.status}: ${bodyExcerpt.slice(0, 200)}`);
          setDiag('openai', resp.status);
          return null;
        }
        const data = await resp.json();
        const vector = data?.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length === 0) return null;
        return { vector, provider: 'openai', model: openAIEmbedStamp(openAiModel) };
      } catch (err) {
        console.warn(`[QuoxChat] embedText: OpenAI embed request failed (${err.name}): ${err.message}`);
        setDiag('openai', null);
        return null;
      }
    }
    // No OpenAI key configured — fall through to the Gemini path below.
  }

  const geminiKey = providerKeys?.gemini_api_key || process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    // Loud, not silent: neither provider had a usable key, so RAG is off. This
    // is the signal that was missing when embedding_failed hid on prod.
    if (!(providerKeys?.openai_api_key || process.env.OPENAI_API_KEY)) {
      console.warn('[QuoxChat] embedText: no embedding key (openai/gemini) resolved for this widget/org — RAG disabled until a BYOK embedding key is configured.');
    }
    return null;
  }
  try {
    const resp = await _embedFetch429(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, outputDimensionality: QDRANT_VECTOR_SIZE }),
    }, timeoutMs);
    if (!resp.ok) {
      const bodyExcerpt = await resp.text().catch(() => '');
      console.warn(`[QuoxChat] embedText: Gemini embed HTTP ${resp.status}: ${bodyExcerpt.slice(0, 200)}`);
      setDiag('gemini', resp.status);
      return null;
    }
    const data = await resp.json();
    const vector = data?.embedding?.values;
    if (!Array.isArray(vector) || vector.length === 0) return null;
    return { vector, provider: 'gemini', model: 'gemini-embedding-001' };
  } catch (err) {
    console.warn(`[QuoxChat] embedText: Gemini embed request failed (${err.name}): ${err.message}`);
    setDiag('gemini', null);
    return null;
  }
}

// QCL-2: provider keys scoped to a widget's org, so org-scoped BYOK vault
// credentials (e.g. the Quox website widget's OpenAI key) resolve on the
// ingest/search paths too — not just the message path. Falls back to
// instance-level keys when the widget's org can't be resolved. Used by the
// knowledge upload/crawl/qa/search endpoints, whose embeddings would otherwise
// fail (no key) under org-scoped BYOK.
//
// VAULT-INTEG P17: also returns the resolved orgId now (was providerKeys
// only) — a single fetchWidgetMeta call feeding BOTH org-scoped provider-key
// resolution AND configResolver.getSetting() org-scoping (e.g.
// QUOXCHAT_EMBED_PROVIDER), avoiding a second widget-meta round trip per
// call site. Renamed callers accordingly; no remaining caller needs
// providerKeys without also wanting orgId.
async function _providerKeysAndOrgForWidget(widget_id) {
  let orgId;
  try { orgId = (await fetchWidgetMeta(widget_id))?.org_id || undefined; } catch { orgId = undefined; }
  return { providerKeys: await _getProviderKeys(orgId), orgId };
}

// QCX-2.3: Start a VOLT run, emit one event, complete the run. Used by
// the "atomic" lifecycle endpoints (widget.opened, visitor.identified)
// where there's one event per HTTP call. Fire-and-forget: never throws.
function _voltAtomicEvent(corr, ctx, eventType, payload) {
  if (!_voltEmitter) return;
  try {
    const runId = _voltEmitter.startRun(corr, ctx || {});
    if (!runId) return;
    _voltEmitter.emit(runId, eventType, payload || {});
    _voltEmitter.completeRun(runId, 'ok');
  } catch (err) {
    console.warn('[QuoxChat] VOLT atomic event failed (non-fatal):', err?.message);
  }
}

// ── Health ──
router.get('/health', (req, res) => {
  // QUOXCHAT-BRUTALOOP: degraded mode is reported, never hidden. Counts per
  // provider only; no widget identifiers on this public endpoint.
  const providers = providerCooldowns.snapshot();
  res.json({ status: providers.degraded ? 'degraded' : 'ok', service: 'quoxchat', version: '1.0.0', providers });
});

// ── QCX-2.1 — Visitor lifecycle events ──
// The widget loader POSTs when it mounts (widget.opened) and when the host
// page calls QuoxChat.identify({email, name, ...}) (visitor.identified).
// Both are public (domain-guarded) and non-blocking — they feed the AEE
// chain that ties a visitor's journey together.
router.post('/events/widget-opened', rateLimit, domainGuard, (req, res) => {
  try {
    const { widget_id: rawWidgetId, visitor_id, page_url, user_agent, referrer } = req.body || {};
    const widget_id = rawWidgetId || 'demo';
    const v = visitor_id || 'anon';
    const payload = { page_url: page_url || null, user_agent: (user_agent || '').slice(0, 200), referrer: (referrer || '').slice(0, 200) };
    _storeAuditEnvelope(buildWidgetEnvelope({
      intent: WIDGET_INTENTS.WIDGET_OPENED,
      visitor_id: v,
      widget_id,
      payload,
    }));
    // QCX-2.3: also record in VOLT so compliance exports include the
    // visitor's first contact with the widget.
    _voltAtomicEvent(v, { widget_id, visitor_id: v }, 'quoxchat.widget.opened', payload);
    res.json({ ok: true });
  } catch (err) {
    console.warn('[QuoxChat] widget-opened emit failed:', err.message);
    res.status(500).json({ error: 'emit_failed' });
  }
});

// QUOXCHAT-PRO visitor name: canonical "what do we call this visitor"
// derivation from identify() attrs — `name` beats first/last composition,
// mirroring LogsTab's getVisitorIdentity() precedence.
function identifiedNameFromAttrs(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  const direct = typeof attrs.name === 'string' ? attrs.name.trim() : '';
  if (direct) return direct.slice(0, 120);
  const composed = [attrs.first_name, attrs.last_name]
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim())
    .join(' ');
  return composed ? composed.slice(0, 120) : null;
}

router.post('/events/visitor-identified', rateLimit, domainGuard, async (req, res) => {
  try {
    const { widget_id: rawWidgetId, visitor_id, attrs, conversation_id, user_id: rawUserId, user_hash: rawUserHash } = req.body || {};
    const widget_id = rawWidgetId || 'demo';
    const v = visitor_id || 'anon';

    // QCL-IDENTITY P1 — verified identity. user_id/user_hash may arrive at
    // the top level (widget SDK) or nested in attrs (older/generic callers
    // that just forward the whole identify() object) — accept either.
    const userId = rawUserId || attrs?.user_id || null;
    const userHash = rawUserHash || attrs?.user_hash || null;
    let verified = false;
    // QCL-IDENTITY P2: limit-bearing attrs (action_quota_monthly) need a v2
    // allowance_sig + allowance_exp over {user_id, limits, exp}; the v1 hash
    // alone never vouches for them.
    const allowanceSig = req.body?.allowance_sig || attrs?.allowance_sig || null;
    const allowanceExp = req.body?.allowance_exp ?? attrs?.allowance_exp ?? null;
    const suppliedLimits = {};
    for (const k of LIMIT_ATTRS) if (attrs && typeof attrs === 'object' && attrs[k] !== undefined) suppliedLimits[k] = attrs[k];
    let limitsSigned = false;
    let limitsDropReason = null;
    if (userId && userHash && widget_id !== 'demo') {
      const meta = await fetchWidgetMeta(widget_id).catch(() => null);
      verified = verifyUserHash(userId, userHash, meta?.identity_secret);
      if (verified && Object.keys(suppliedLimits).length) {
        const r = verifyAllowanceSig(userId, suppliedLimits, allowanceExp, allowanceSig, meta?.identity_secret);
        limitsSigned = r.ok;
        if (!r.ok) limitsDropReason = r.reason;
      }
    }
    if (Object.keys(suppliedLimits).length && !limitsSigned) {
      limitsDropReason = limitsDropReason || (verified ? 'unsigned' : 'unverified');
      console.warn(`[QuoxChat] identify: dropped limit attrs [${Object.keys(suppliedLimits).join(',')}] widget=${widget_id} visitor=${v} reason=${limitsDropReason}`);
    }

    // attrs may contain email/name/company — we fingerprint + also keep a
    // redacted summary so downstream tools can see that identification
    // happened + which fields were supplied.
    const supplied = attrs && typeof attrs === 'object' ? Object.keys(attrs) : [];
    const fingerprint = {
      attrs_hash: hashInput(attrs || {}), supplied_fields: supplied.slice(0, 10), verified,
      ...(limitsDropReason ? { limit_attrs_dropped: limitsDropReason } : {}),
    };
    _storeAuditEnvelope(buildWidgetEnvelope({
      intent: WIDGET_INTENTS.VISITOR_IDENTIFIED,
      visitor_id: v,
      widget_id,
      payload: fingerprint,
    }));
    // QCX-2.3: VOLT event carries the same (non-raw) fingerprint so the
    // evidence bundle never contains PII.
    _voltAtomicEvent(v, { widget_id, visitor_id: v }, 'quoxchat.visitor.identified', fingerprint);
    // QCX-3.2: persist identified attrs on the visitor memory row (auth-side,
    // under ATTR_ALLOWLIST). Non-fatal — the audit trail already captured
    // the event regardless of persistence success. QCL-IDENTITY P1: also
    // carries verified + external_user_id (only when actually verified —
    // an unverified user_id claim is never trusted as external_user_id).
    if (widget_id !== 'demo' && v !== 'anon') {
      // QCX-ACTIONS P2 — verified identify payloads may carry the visitor's
      // monthly action-quota override (the host computes it, e.g. from paid
      // services, and signs the identity). Forwarded ONLY when the hash
      // verified; auth additionally refuses it on unverified upserts.
      const quotaOverride = limitsSigned ? suppliedLimits.action_quota_monthly : undefined;
      // Limit attrs and the allowance signature never travel on as attrs.
      let safeAttrs = attrs;
      if (attrs && typeof attrs === 'object') {
        safeAttrs = { ...attrs };
        for (const k of [...LIMIT_ATTRS, 'allowance_sig', 'allowance_exp']) delete safeAttrs[k];
      }
      await upsertVisitorMemory(widget_id, {
        visitor_id: v,
        attrs: safeAttrs,
        limit_attrs_signed: limitsSigned,
        bump_conversation: false,
        verified,
        external_user_id: verified ? userId : null,
        action_quota_override: quotaOverride,
      });
      // QUOXCHAT-PRO visitor name: when the widget names the conversation
      // (pre-handoff name form, or a late name after an LLM-triggered
      // handoff), stamp name/email onto the conversation row so the HITL
      // inbox, Matrix room label, puppet displayname, and LogsTab all show
      // a person instead of a raw visitor id. Auth verifies the
      // conversation belongs to (widget, visitor). Fail-soft.
      const identifiedName = identifiedNameFromAttrs(attrs);
      const identifiedEmail = (attrs && typeof attrs.email === 'string' && attrs.email.trim()) || null;
      if (conversation_id && (identifiedName || identifiedEmail)) {
        await matrixRelay.setConversationVisitorIdentity(String(conversation_id), {
          widgetId: widget_id,
          visitorId: v,
          name: identifiedName,
          email: identifiedEmail,
        });
      }
    }
    res.json({ ok: true, verified });
  } catch (err) {
    console.warn('[QuoxChat] visitor-identified emit failed:', err.message);
    res.status(500).json({ error: 'emit_failed' });
  }
});

// ── QCX-1.4 — Per-tool Test Run ──
// Runs executeTool in isolation so admins can verify a tool from the
// ToolBuilderModal without shipping it live. Auth-side proxies an
// authenticated PATCH-equivalent here with x-service-key; we do not expose
// this publicly — executor invocation without domain-guard would be a
// hole otherwise.
router.post('/internal/tools/test-run', async (req, res) => {
  const sk = req.headers['x-service-key'];
  if (!sk || sk !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { tool, widget, input } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'missing_tool' });
  if (!widget) return res.status(400).json({ error: 'missing_widget' });

  const startMs = Date.now();
  const execResult = await executeTool({
    widget,
    tool,
    input: input && typeof input === 'object' ? input : {},
    context: { test_run: true, visitor_id: 'admin.test_run', conversation_id: null },
  });
  const duration_ms = Date.now() - startMs;

  // Redact secrets even on the admin path — same hardening applied to the
  // LLM-visible tool_result content.
  const safeResult = execResult?.ok
    ? { ...execResult, result: sanitiseToolResult(execResult.result ?? null) }
    : execResult;

  return res.json({ ...safeResult, duration_ms });
});

// ── CW-13.2 — Visitor widget bundle ─────────────────────────────────────
// Served with long-cache + CORS wide open. File lives in services/collector/public.
// QCX-4.2 / QCX-4.3: cache the composed widget in-process. Source rarely
// changes; recompose on every request wastes CPU. Invalidated only by
// process restart.
let _widgetJsCache = null;
function _stripCjs(src) {
  return src
    .replace(/^\s*['"]use strict['"];?\s*$/m, '')
    .replace(/^\s*module\.exports\s*=\s*\{[^}]*\};?\s*$/m, '');
}
function composeWidgetJs() {
  const fs = require('fs');
  const path = require('path');
  const widgetSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'quoxchat-widget.js'), 'utf8');
  const mdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'quoxchatMarkdown.js'), 'utf8');
  const cardsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'quoxchatWidgetCards.js'), 'utf8');
  // Both modules declare `function renderX(...)` at top level. In the widget
  // IIFE these shadow the `var renderX = ...` fallbacks. Private helpers
  // (_esc, _isSafeUrl, escapeHtml, isSafeUrl, etc.) are module-local names
  // and safe to coexist.
  return widgetSrc
    .replace('/* __QUOXCHAT_MARKDOWN_INJECT__ */', _stripCjs(mdSrc))
    .replace('/* __QUOXCHAT_CARDS_INJECT__ */', _stripCjs(cardsSrc));
}

router.get('/widget.js', (req, res) => {
  try {
    if (!_widgetJsCache) _widgetJsCache = composeWidgetJs();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300'); // 5 min — balances updates vs load
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(_widgetJsCache);
  } catch (err) {
    console.error('[QuoxChat] widget.js serve error:', err.message);
    res.status(500).type('text').send('// widget unavailable');
  }
});

// Wave 9: a simulation run (Go live self-test) must never fire real side
// effects. Honoured only with the valid service key; a public visitor sending
// simulation:true or a sim_ visitor_id is treated as a normal visitor.
function isSimulationRequest(req) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key || req.headers['x-service-key'] !== key) return false;
  const b = req.body || {};
  return b.simulation === true || (typeof b.visitor_id === 'string' && b.visitor_id.startsWith('sim_'));
}

// w5h: who may talk to a DRAFT widget (see the /message gate).
function draftServingAllowed(req) {
  if (process.env.QUOXCHAT_SERVE_DRAFT_PUBLIC === '1') return true;
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (key && req.headers['x-service-key'] === key) return true;
  const host = extractHost(req.headers.origin || req.headers.referer || null);
  // Wave 11 defect 16: Origin is forgeable, so a dev origin alone never serves
  // a draft. Only a non-production collector with the explicit dev flag does.
  if (host && isDevOrigin(host) && process.env.NODE_ENV !== 'production' && process.env.QUOXCHAT_DEV_DRAFT_ORIGINS === '1') return true;
  const preview = String(process.env.QUOXCHAT_PREVIEW_ORIGINS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (host && preview.some((p) => p === host || p === host.split(':')[0])) return true;
  return false;
}

// ── CW-13.3 — Domain guard middleware ──
// Enforces the widget's allowed_domains_json at request time. Dev origins
// and missing Origin pass through. Production origin not on the list → 403.
//
// LICENSE-ENFORCE LE-3f: this used to fail OPEN (next()) on any unexpected
// error in the try block — a transient bug here silently let every widget
// through with no domain check at all. Flipped to fail CLOSED (403), except
// the 'demo' widget (already exempted above the try, so it never reaches
// this catch).
async function domainGuard(req, res, next) {
  try {
    const widgetId = req.body?.widget_id;
    if (!widgetId || widgetId === 'demo') return next();
    const origin = req.headers.origin || req.headers.referer || null;
    const lookup = await fetchAllowedDomainsDetailed(widgetId);
    if (lookup.state === 'unavailable') {
      console.warn(`[QuoxChat] domain guard: auth unreachable and no cached domains for widget=${widgetId}; 503`);
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'verification_unavailable', message: 'We could not verify this chat right now. Please try again in a moment.' });
    }
    const allowed = lookup.domains;
    // W5 defect 10: /message (and its stream) must carry an Origin/Referer;
    // internal service-key calls are exempt.
    const isMessagePath = req.path === '/message';
    const isServiceCall = !!process.env.INTERNAL_SERVICE_KEY && req.headers['x-service-key'] === process.env.INTERNAL_SERVICE_KEY;
    const verdict = enforceDomainGuard(widgetId, origin, allowed, { requireOrigin: isMessagePath && !isServiceCall });
    if (!verdict.ok) {
      console.warn(`[QuoxChat] domain guard blocked: widget=${widgetId} origin=${origin} reason=${verdict.reason}`);
      return res.status(403).json({ error: 'origin_not_allowed', message: 'Chat is not available on this website.' });
    }
    next();
  } catch (err) {
    console.error('[QuoxChat] domain guard error — failing CLOSED:', err.message);
    return res.status(403).json({ error: 'origin_not_allowed', message: 'We could not verify this chat right now. Please try again shortly.' });
  }
}

// ── LICENSE-ENFORCE LE-3f — QuoxChat entitlement gate ──
// Resolves widget -> org (fetchWidgetMeta, already used elsewhere in this
// file for org-scoped file uploads) and requires the org holds a `quoxchat`
// entitlement before any LLM/tool spend happens. 'demo' is the only
// exemption (same widget that's exempt from domainGuard above). Fails
// CLOSED if the org can't be resolved (unknown widget or auth unreachable —
// fetchWidgetMeta can't distinguish the two, and this is a paid data-plane
// gate, not an existence check).
// LICENSE-ENFORCE cutover flag: enforcement is the DEFAULT; an install whose
// licence issuance has not been cut over yet (owner-gated) sets
// QUOXCHAT_LICENSE_ENFORCE=off to keep live widgets serving. Discovered the
// hard way 2026-07-24: shipping the gate to an install with no signed lease
// bricks every live widget with LICENSE_REQUIRED.
// LICENSE-LAUNCH LL-6b: read PER CALL, not once at module load. The off
// switch above is a revenue gate, and in production it now needs an unexpired
// break-glass record behind it (lib/enforcementPosture.js) — a value captured
// at boot could never see that record arrive or expire.
const { isEnforced: isPostureEnforced } = require('../lib/enforcementPosture.js');
function quoxchatLicenceEnforced() {
  return isPostureEnforced('QUOXCHAT_LICENSE_ENFORCE');
}
if (!quoxchatLicenceEnforced()) {
  console.warn('[QuoxChat] licence enforcement DISABLED via QUOXCHAT_LICENSE_ENFORCE=off (pre-cutover install)');
}

// Shared resolution for both gates below. Returns 'allow' | 'unresolved' |
// 'unlicensed'. The org is ALWAYS derived server-side from the widget
// (fetchWidgetMeta → auth), never taken from the caller's body: a request
// cannot name the org it wants to be judged as.
async function resolveQuoxchatLicence(widgetId) {
  if (!quoxchatLicenceEnforced()) return 'allow';
  if (!widgetId || widgetId === 'demo') return 'allow';
  const { meta, unavailable: metaUnavailable } = await fetchWidgetMetaVerdict(widgetId);
  const orgId = meta?.org_id;
  if (!orgId) {
    console.warn(`[QuoxChat] license gate: could not resolve org for widget=${widgetId} — failing CLOSED`);
    return metaUnavailable ? 'unavailable' : 'unresolved';
  }
  const verdict = await licenseVerdict(orgId, 'quoxchat');
  if (verdict.unavailable) {
    console.warn(`[QuoxChat] license gate: licence service unavailable for org=${orgId} — failing CLOSED (503, retryable)`);
    return 'unavailable';
  }
  if (!verdict.licensed) {
    console.warn(`[QuoxChat] license gate blocked: widget=${widgetId} org=${orgId} plugin=quoxchat`);
    return 'unlicensed';
  }
  return 'allow';
}

async function licenseGuard(req, res, next) {
  if (!quoxchatLicenceEnforced()) return next();
  const widgetId = req.body?.widget_id;
  if (!widgetId || widgetId === 'demo') return next();
  try {
    const verdict = await resolveQuoxchatLicence(widgetId);
    if (verdict === 'unavailable') {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'LICENSE_CHECK_UNAVAILABLE', retryable: true, message: 'We could not verify this chat right now. Please try again shortly.' });
    }
    if (verdict === 'unresolved') {
      return res.status(402).json({ error: 'LICENSE_REQUIRED', message: 'We could not verify this chat right now. Please try again shortly.' });
    }
    if (verdict === 'unlicensed') {
      return res.status(402).json({ error: 'LICENSE_REQUIRED', message: 'Chat is not available on this site right now.' });
    }
    next();
  } catch (err) {
    console.error('[QuoxChat] license gate error — failing CLOSED:', err.message);
    return res.status(402).json({ error: 'LICENSE_REQUIRED', message: 'We could not verify this chat right now. Please try again shortly.' });
  }
}

// ── LICENSE-LAUNCH LL-6a — entitlement gate for the ADMIN/KB spend paths ──
// The 2026-08-28 adversarial challenge found /message was the only gated
// QuoxChat route: crawl, upload, qa, search, teach/propose and simulate all
// burned embedding/LLM spend with no licence check, so an unlicensed org
// could run up a provider bill on every path except the one that 402'd.
//
// Same resolver, same fail-closed contract as licenseGuard above. The only
// difference is the response body: these routes are reached by the operator
// dashboard through the auth proxy, not by a website visitor, so they get the
// machine-readable { error, plugin } shape the rest of the platform's licence
// gates use (services/auth/routes/plugins.js requireBundleEntitlement) rather
// than the visitor-facing prose /message returns.
//
// Placement note: on multipart routes this MUST run after multer, otherwise
// req.body.widget_id does not exist yet and every request would fail closed
// (the same trap Ledger critical #5 hit on /visitor/upload).
async function licenseGuardAdmin(req, res, next) {
  if (!quoxchatLicenceEnforced()) return next();
  // LICENSE-LAUNCH LL-6c: the corpus-sync admin pair (GET/DELETE
  // /knowledge/sources, QCFT #213) is widget-scoped like every other route
  // here, but carries widget_id in the QUERY STRING because it has no JSON
  // body. Body first so the LL-6a routes are bit-for-bit unchanged.
  const widgetId = req.body?.widget_id || req.query?.widget_id;
  // Unlike the visitor gate, a missing widget_id is a DENIAL here, not a pass:
  // every one of these routes is widget-scoped, so no widget id means no org
  // to judge, and "unjudgeable" must never mean "free".
  if (!widgetId) return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: 'quoxchat' });
  try {
    const verdict = await resolveQuoxchatLicence(widgetId);
    if (verdict === 'allow') return next();
    if (verdict === 'unavailable') {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'LICENSE_CHECK_UNAVAILABLE', plugin: 'quoxchat', retryable: true });
    }
  } catch (err) {
    console.error('[QuoxChat] admin license gate error — failing CLOSED:', err.message);
  }
  return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: 'quoxchat' });
}

// ── QUOXCHAT-PRO P2 — operator relay in (appservice → widget) ──
// The quox-matrix appservice POSTs here when a HUMAN (@human.*) message
// lands in a room whose ai.quox.room state says node_type 'quoxchat'
// (src/quoxchatRelay.js). Resolve the conversation by room id (auth
// internal lookup), persist as role='operator' with the sender's display
// name; the widget's poll loop below delivers it. Service-key gated —
// mirrors /internal/tools/test-run (the public /quoxchat/* gateway
// exemption makes this reachable, so it must gate itself).
//
// QUOXCHAT-PRO Matrix-less handoff: also accepts {conversation_id,
// sender_name, body} directly: the by-conversation variant skips the
// Matrix room resolve entirely (prod installs with no Matrix stack), same
// persist path, same widget poll delivery.
router.post('/internal/operator-message', requireServiceKey, async (req, res) => {
  try {
    const { room_id, conversation_id, sender, sender_display, sender_name, body } = req.body || {};
    if (!body || (!room_id && !conversation_id)) {
      return res.status(400).json({ error: 'body and one of room_id or conversation_id required' });
    }

    let convId = conversation_id ? String(conversation_id) : null;
    if (!convId) {
      const conv = await matrixRelay.resolveConversationByRoom(room_id);
      if (!conv || !conv.conversation_id) return res.status(404).json({ error: 'conversation_not_found' });
      convId = conv.conversation_id;
    }

    // Display name for the widget bubble: explicit sender_name first (the
    // by-conversation callers pass the dashboard user's display name), then
    // the Matrix profile name when the appservice resolved one, else the
    // bare localpart minus the human. prefix (never the raw mxid with
    // server suffix).
    const senderName = (sender_name && String(sender_name).trim())
      || (sender_display && String(sender_display).trim())
      || (sender ? String(sender).replace(/^@/, '').split(':')[0].replace(/^human\./, '') : 'Operator');

    const persisted = await matrixRelay.persistOperatorMessage(convId, String(body), senderName);
    if (!persisted || !persisted.success) return res.status(502).json({ error: 'persist_failed' });

    res.json({ success: true, conversation_id: convId, message_id: persisted.message_id || null });
  } catch (err) {
    console.error('[QuoxChat] operator-message error:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── QUOXCHAT-PRO P2 — widget poll (operator replies) ──
// Public, rate-limited, conversation-scoped: the widget polls this every
// 10s ONLY while its conversation is handed off. Scoping matches the other
// public quoxchat endpoints — the caller must present the same
// (widget_id, visitor_id) pair the conversation belongs to (auth-side
// check), plus the origin-based domainGuard; a leaked conversation id
// alone reads nothing. Separate limiter from /message: a 10s poll (6/min)
// would exhaust the shared 10/min budget and 429 the visitor's messages.
const pollRateLimitMap = new Map();
const POLL_RATE_MAX = 30; // per IP per minute
function pollRateLimit(req, res, next) {
  const key = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = pollRateLimitMap.get(key);
  if (entry && (now - entry.windowStart) < RATE_WINDOW_MS) {
    if (entry.count >= POLL_RATE_MAX) {
      return res.status(429).json({ error: 'Too many requests. Please try again in a moment.' });
    }
    entry.count++;
  } else {
    pollRateLimitMap.set(key, { windowStart: now, count: 1 });
  }
  if (pollRateLimitMap.size > 1000) {
    for (const [k, v] of pollRateLimitMap) {
      if (now - v.windowStart > RATE_WINDOW_MS * 2) pollRateLimitMap.delete(k);
    }
  }
  next();
}
// domainGuard reads req.body.widget_id (POST-shaped); polls are GETs, so
// mirror the query param into the body before it runs.
function pollQueryShim(req, res, next) {
  req.body = req.body || {};
  if (!req.body.widget_id && req.query.widget_id) req.body.widget_id = req.query.widget_id;
  next();
}
// Ledger critical #5 (2026-07-24): /poll consumes paid resources (auth-side
// conversation reads on a 10s loop) and previously skipped the entitlement
// gate. pollQueryShim mirrors widget_id into req.body first, so licenseGuard
// reads the same field it does on the POST endpoints.
router.get('/poll/:conversationId', pollRateLimit, pollQueryShim, domainGuard, licenseGuard, async (req, res) => {
  try {
    const { widget_id: rawWidgetId, visitor_id, after } = req.query;
    if (!rawWidgetId || !visitor_id) return res.status(400).json({ error: 'widget_id and visitor_id required' });
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);

    const data = await matrixRelay.fetchOperatorMessages(req.params.conversationId, widget_id, String(visitor_id), after ? String(after) : null);
    if (!data) return res.status(404).json({ error: 'conversation_not_found' });

    res.json({
      success: true,
      conversation_id: data.conversation_id,
      status: data.status || null,
      messages: (data.messages || []).map((m) => ({
        id: m.id,
        content: m.content,
        // w5h: never expose an internal account/host identity to the visitor.
        sender_name: handoffState.visitorSafeOperatorName(m.sender_name),
        created_at: m.created_at,
      })),
    });
  } catch (err) {
    console.error('[QuoxChat] poll error:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Message (main conversation endpoint) ──
const VERIFIED_CHUNK = 32; // target chars per released delta in verified streaming
// W16: split on word boundaries so no frame ends mid-word. Each chunk is whole
// words (plus their trailing whitespace) up to ~max chars; a single word longer
// than max stays whole. The chunks always concatenate back to the exact text.
function chunkAtWordBoundaries(text, max = VERIFIED_CHUNK) {
  const t = String(text || '');
  const pieces = t.match(/\s*\S+\s*|\s+/g) || [];
  const out = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length > max) { out.push(cur); cur = ''; }
    cur += p;
  }
  if (cur) out.push(cur);
  return out;
}
// QC W17: whatever fails on /message (rate limit, domain/licence guard, 400,
// 5xx), the visitor-facing widget gets JSON with a visitor-safe `response`.
const MESSAGE_ERROR_FALLBACK_TEXT = 'Sorry, something went wrong and I could not answer that. Please try again in a moment, or ask to speak with the team.';
function messageErrorEnvelope(req, res, next) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && typeof body.response !== 'string') {
      const safe = typeof body.message === 'string' && body.message.trim() ? body.message
        : (typeof body.error === 'string' && /^(Too many requests|Message is required)/i.test(body.error) ? body.error : MESSAGE_ERROR_FALLBACK_TEXT);
      body = { ...body, response: safe };
    }
    return origJson(body);
  };
  next();
}
router.post('/message', messageErrorEnvelope, messageRateLimit, domainGuard, licenseGuard, async (req, res) => {
  const startMs = Date.now();

  // QCX-4.1c — streaming hooks. When the caller sets stream:true we emit an
  // SSE event for each text token + tool event, then a terminal `done` (or
  // `error`) event. Non-streaming callers still get the plain JSON shape.
  const streaming = req.body?.stream === true;
  let sseOpen = false;
  const openSse = () => {
    if (sseOpen) return;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    try { res.flushHeaders(); } catch { /* not all transports support flushHeaders */ }
    sseOpen = true;
  };
  const sseWrite = (event, data) => {
    if (!sseOpen) openSse();
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // QCL-SECURITY (SSE-stream redaction gap) — text deltas used to be written
  // to the wire directly from the provider's stream callback, BEFORE the
  // credential filter (below, on the fully-assembled responseText) ever ran.
  // A secret split across two token chunks would reach the visitor's
  // browser token-by-token, un-redacted. streamRedactor buffers a small
  // trailing window and redacts (reusing sanitiseString — same pattern set
  // as the final-response filter) at the emit boundary; flush() is called
  // right before the terminal `done`/`error` frame so nothing pending is
  // lost. No-op latency/behaviour change for clean text.
  const streamRedactor = streaming ? createStreamRedactor({
    emit: (text) => { try { sseWrite('token', { delta: text }); } catch { /* non-fatal */ } },
  }) : null;
  // Failover must never splice two models into one visible reply.
  let streamedCharsTotal = 0;
  // QUOXCHAT-BRUTALOOP: sentence-gated streaming. Allowed URLs and grounding
  // support start empty (fail closed) and are filled once knowledge is known.
  const streamGround = { allowed: new Set(), support: [], visitor: [] };
  const sentenceGate = streaming ? createSentenceGate({
    emit: (t) => { if (streamRedactor) streamRedactor.push(t); },
    allowed: () => streamGround.allowed,
    support: () => streamGround.support.concat(streamGround.toolTexts || []),
    visitor: () => streamGround.visitor,
    brandNames: () => streamGround.brandNames || [],
    clock: () => ({ now: new Date(), tz: streamGround.tz || 'UTC' }),
  }) : null;
  // VERIFIED STREAMING (wave 4): when the claim verifier runs for the turn the
  // model's tokens are HELD, not forwarded. The verifier only judges the whole
  // answer, so any live token could show a claim that is later stripped (a
  // visitor saw an unsupported EU-residency claim for 3.7s). Held turns send a
  // `status: checking` frame + SSE comment keepalives, then the final gated
  // text as small deltas, then `done`. `grounding.stream_mode: 'live'` opts
  // back into sentence-gated live tokens. Armed once the widget config is read.
  const verifiedStream = { hold: false, held: 0, pinged: false, timer: null };
  const stopKeepalive = () => { if (verifiedStream.timer) { clearInterval(verifiedStream.timer); verifiedStream.timer = null; } };
  res.on('close', stopKeepalive);
  const onStream = streaming ? (ev) => {
    try {
      if (ev.type === 'text' && verifiedStream.hold) {
        streamedCharsTotal += String(ev.delta || '').length;
        verifiedStream.held += String(ev.delta || '').length;
        if (!verifiedStream.pinged) {
          verifiedStream.pinged = true;
          sseWrite('status', { state: 'checking' });
          verifiedStream.timer = setInterval(() => { try { if (!res.writableEnded) res.write(': keepalive\n\n'); } catch { /* client gone */ } }, 10000);
          if (verifiedStream.timer.unref) verifiedStream.timer.unref();
        }
      }
      else if (ev.type === 'text') { streamedCharsTotal += String(ev.delta || '').length; if (sentenceGate) sentenceGate.push(ev.delta); }
      // Codex enum 2 #17: the model's raw tool input never reaches the visitor
      // (it is unredacted and ungrounded); the name is enough for the UI.
      else if (ev.type === 'tool_start') sseWrite('tool_start', { name: ev.name });
      else if (ev.type === 'tool_result') {
        if (ev.name === 'human_handoff' && !ev.ok) handoffFrameFailed = true;
        sseWrite('tool_result', { name: ev.name, ok: ev.ok, error: ev.error || null });
      }
    } catch { /* write-after-end / client hung up — non-fatal */ }
  } : null;
  // QC-BRUTALOOP-W14: every turn ends exactly once. The hard deadline below
  // settles a hung turn with a persisted fallback; a late respond is a no-op.
  let turnSettled = false;
  let hardDeadlineTimer = null;
  const turnCtx = { message: null, widget_id: null, visitor_id: null, page_url: null, injectionScore: 0, conversation_id: null };
  const settleTurn = () => {
    if (turnSettled) return false;
    turnSettled = true;
    if (hardDeadlineTimer) { clearTimeout(hardDeadlineTimer); hardDeadlineTimer = null; }
    return true;
  };
  // Persist the visitor turn plus an error-outcome assistant row so a failed
  // turn shows in Logs and counts as `error` in the unanswered analytics.
  // Best effort and bounded (3 s); returns the conversation id or null.
  const persistFailedTurn = async (errorOutcome, replyText) => {
    const wid = turnCtx.widget_id;
    if (!wid || wid === 'demo' || !turnCtx.message || !process.env.INTERNAL_SERVICE_KEY) return null;
    try {
      const pr = await fetch(`${process.env.AUTH_SERVICE_URL || 'http://auth:3101'}/api/internal/widgets/${encodeURIComponent(wid)}/persist-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': process.env.INTERNAL_SERVICE_KEY },
        body: JSON.stringify({
          visitor_id: turnCtx.visitor_id || 'anon',
          conversation_id: turnCtx.conversation_id || null,
          user_message: turnCtx.message,
          assistant_message: replyText,
          injection_score: turnCtx.injectionScore || 0,
          page_url: turnCtx.page_url || null,
          duration_ms: Date.now() - startMs,
          context: { error_outcome: errorOutcome, grounding: { withheld: true, error: errorOutcome } },
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (pr.ok) return (await pr.json().catch(() => ({}))).conversation_id || null;
      console.warn(`[QuoxChat] ${errorOutcome} turn persist returned ${pr.status}`);
    } catch (persistErr) {
      console.warn(`[QuoxChat] ${errorOutcome} turn persist failed (non-fatal):`, persistErr.message);
    }
    return null;
  };
  let handoffFrameFailed = false;
  const respondOk = (body) => {
    if (!settleTurn()) return;
    if (body && typeof body === 'object' && !body.conversation_id && turnCtx.conversation_id) body.conversation_id = turnCtx.conversation_id;
    if (streaming) {
      stopKeepalive();
      // Held tokens: release the FINAL gated text (same string as the final
      // frame) in small chunks so the widget still animates.
      if (verifiedStream.held > 0 && body && body.success !== false && typeof body.response === 'string' && body.response) {
        const t = body.response;
        for (const piece of chunkAtWordBoundaries(t)) {
          try { sseWrite('token', { delta: piece }); } catch { /* client gone */ }
        }
        verifiedStream.held = 0;
      }
      if (sentenceGate) { try { sentenceGate.flush(); } catch { /* non-fatal */ } }
      if (streamRedactor) { try { streamRedactor.flush(); } catch { /* non-fatal */ } }
      // W15: the executor reported failure but a handoff was persisted this
      // turn (post-turn path): correct the red card before the done frame.
      if (handoffFrameFailed && body && body.handed_off) {
        try { sseWrite('tool_result', { name: 'human_handoff', ok: true, error: null, corrected: true }); } catch { /* client gone */ }
      }
      // Stream semantics: success:false → `error`, success:true → `done`.
      sseWrite(body && body.success === false ? 'error' : 'done', body);
      res.end();
    } else {
      res.json(body);
    }
  };
  const respondErr = (status, body) => {
    if (!settleTurn()) return;
    if (body && typeof body === 'object' && !body.conversation_id && turnCtx.conversation_id) body.conversation_id = turnCtx.conversation_id;
    if (streaming) {
      stopKeepalive();
      if (sentenceGate) { try { sentenceGate.flush(); } catch { /* non-fatal */ } }
      if (streamRedactor) { try { streamRedactor.flush(); } catch { /* non-fatal */ } }
      sseWrite('error', body);
      res.end();
    }
    else res.status(status).json(body);
  };

  // Per-request time budget (lib/quoxchatDeadline): caps every provider call.
  requestDeadline.enterDeadline(requestDeadline.DEFAULT_BUDGET_MS);

  try {
    // CHIP DETERMINISM: `action` is set by the widget when a quick-action
    // chip triggered this send (the builtin kind, e.g. 'human_handoff').
    // needs_input fix (2026-07-24): action_input carries form-collected
    // values from an inline data-collection form (renderInlineForm on the
    // widget) so the chip-action branch below can execute the tool directly
    // with real data, no LLM round-trip.
    const { message, widget_id: rawWidgetId, conversation_history, page_url, page_context, visitor_id, action, action_input } = req.body;
    // CW-SEC-1: normalize to canonical internal id so Qdrant collection and
    // persist-message both key off a single identifier per widget.
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);
    turnCtx.message = typeof message === 'string' ? message : null;
    turnCtx.widget_id = widget_id;
    turnCtx.visitor_id = visitor_id;
    turnCtx.page_url = page_url;
    // QC-BRUTALOOP-W14: server-side hard turn deadline, well under the gateway
    // read timeout (60 s). Whatever is hung, the visitor gets a persisted
    // fallback reply (JSON) or a terminal SSE error frame, never a 502.
    hardDeadlineTimer = setTimeout(async () => {
      hardDeadlineTimer = null;
      if (turnSettled || res.writableEnded) return;
      turnSettled = true;
      stopKeepalive();
      const cid = await persistFailedTurn('timeout', DEADLINE_FALLBACK_TEXT);
      const body = { success: false, response: DEADLINE_FALLBACK_TEXT, error: 'timeout', ...((cid || turnCtx.conversation_id) ? { conversation_id: cid || turnCtx.conversation_id } : {}) };
      try {
        if (streaming) { sseWrite('error', body); res.end(); }
        else if (!res.headersSent) res.json(body);
      } catch { /* client gone */ }
    }, hardTurnDeadlineMs());
    if (hardDeadlineTimer.unref) hardDeadlineTimer.unref();
    const clearHardDeadline = () => { if (hardDeadlineTimer) { clearTimeout(hardDeadlineTimer); hardDeadlineTimer = null; } };
    res.on('close', clearHardDeadline);
    res.on('finish', clearHardDeadline);

    if (!message || !message.trim()) {
      return respondErr(400, { error: 'Message is required' });
    }

    if (message.length > 4000) {
      return respondErr(400, { error: 'Message too long (max 4000 characters)' });
    }

    // ── QUOXCHAT-PRO P2 — handed-off gate ──
    // Before this stream, handoff status changed NOTHING in the chat flow:
    // ensure-conversation / persist-message only match status='active', so
    // the AI kept answering in a brand-new forked conversation while the
    // visitor thought a human owned the chat. Now explicit: while a
    // handed-off conversation exists for (widget, visitor), visitor messages
    // skip the LLM entirely, persist against THAT conversation, and relay
    // into its governed Matrix room as the qc_ visitor puppet (provision is
    // retried here when still pending — the NULL matrix_room_id marker).
    // Operator replies come back via GET /quoxchat/poll/:conversationId.
    //
    // UX HOLES FIX (handed-off dead air): this gate used to return
    // response:'' for EVERY subsequent message and swallowed the action
    // chips too (the CHIP-ACTION branch sits later in this handler), so on
    // installs without an operator relay the visitor sat in permanent
    // silence. Now: (a) a repeat human_handoff chip returns a gentle
    // already-queued confirmation instead of re-executing, (b) the other
    // action chips FALL THROUGH so the CHIP-ACTION branch executes them
    // deterministically (handedOffConversationId threads the conversation
    // through so no new active conversation is forked and the reply carries
    // handed_off:true), (c) normal messages always get a short renderable
    // ack (first message the fuller sentence, then the short confirmation).
    let handedOffConversationId = null;
    // QC-HOLES staged handoff: between the handoff REQUEST and the first
    // human reply (operator_joined_at NULL, migration 087) the AI keeps
    // holding the visitor instead of going silent; messages still relay to
    // the room so operators see the backlog. Once a human has replied, the
    // AI mutes exactly as before.
    let handoffAwaitingPickup = false;
    // Codex enum 2 #11: relay result for the ack (null = no handoff gate hit).
    let handoffRelayPromise = null;
    if (widget_id && widget_id !== 'demo' && visitor_id) {
      let handoffLookup = null;
      try {
        // One short retry before degrading: a single blip must not change
        // what the visitor is told.
        handoffLookup = await handoffState.lookupWithRetry(
          () => matrixRelay.lookupHandoffConversationStrict(widget_id, visitor_id),
          { retries: 1, delayMs: 250 },
        );
      } catch (gateErr) {
        // Codex enum 2 #10: a failed lookup is NOT "no handoff", so the AI
        // must not answer inside a conversation a human may own. But the
        // "your conversation is with our team" text is only TRUE when this
        // conversation is known to be handed off (marker from the handoff
        // turn). For everyone else (zero-memory audit 2026-10-10: ANY
        // visitor got it) continue down the normal AI path.
        const known = handoffState.getHandedOff(widget_id, visitor_id);
        if (known) {
          console.warn('[QuoxChat] handoff gate lookup failed for a known handed-off conversation, failing closed:', gateErr.message);
          return respondOk({
            success: true,
            handed_off: true,
            response: HANDOFF_LOOKUP_FAILED_ACK,
            conversation_id: known.conversationId,
            degraded: 'handoff_state_unavailable',
          });
        }
        console.warn('[QuoxChat] handoff gate lookup failed, no known handoff for this visitor, continuing to AI path:', gateErr.message);
        handoffLookup = { conversation: null };
      }
      if (!handoffLookup.conversation) handoffState.clearHandedOff(widget_id, visitor_id);
      try {
        const handoffConv = handoffLookup.conversation;
        if (handoffConv) {
          handoffState.markHandedOff(widget_id, visitor_id, { conversationId: handoffConv.conversation_id });
          const chipAction = (typeof action === 'string' && action && WIDGET_ACTION_CHIPS[action]) ? action : null;
          // A Matrix outage must never block the visitor, but the ack must
          // not claim delivery it did not get: the promise is awaited (with
          // a short timeout) only on the branches that return an ack.
          handoffRelayPromise = matrixRelay.ensureRoomAndRelay({
            conversation: handoffConv,
            orgId: handoffConv.org_id,
            visitorId: visitor_id,
            text: message,
          }).then((id) => !!id, (e) => { console.warn('[QuoxChat] handoff relay failed (non-fatal):', e?.message); return false; });
          // Wave 10 #7: a name/email typed after a handoff (the bot asked
          // "please leave your email") belongs on the conversation whichever
          // handoff branch handles the turn, so the operator sees who is
          // waiting (probe 84, wave 10 opus 4: visitor_email stayed null).
          // Stored BEFORE the reply so the confirmation below is true.
          let handoffIdentity = { name: null, email: null };
          let handoffIdentityStored = false;
          try {
            handoffIdentity = handoffState.extractVisitorIdentity(message);
            if (handoffIdentity.name || handoffIdentity.email) {
              const stored = await matrixRelay.setConversationVisitorIdentity(handoffConv.conversation_id, {
                widgetId: widget_id, visitorId: visitor_id, name: handoffIdentity.name, email: handoffIdentity.email,
              });
              handoffIdentityStored = Boolean(stored) && stored.success !== false;
            }
          } catch (identErr) { console.warn('[QuoxChat] handoff identity capture failed (non-fatal):', identErr?.message); }
          if (!chipAction && handoffIdentityStored && handoffState.isIdentityOnlyMessage(message, handoffIdentity)) {
            // Confirm only when the team inbox was actually notified. The
            // relay is checked first so a failed notify falls through to the
            // normal path without the visitor message being persisted twice.
            let relayDelivered = false;
            try {
              let t;
              relayDelivered = await Promise.race([handoffRelayPromise, new Promise((resolve) => { t = setTimeout(() => resolve(false), HANDOFF_RELAY_TIMEOUT_MS); })]);
              clearTimeout(t);
            } catch { relayDelivered = false; }
            const st = relayDelivered ? await settleHandoffState(handoffConv.conversation_id, message, handoffRelayPromise) : { saved: false, delivered: false };
            if (st.saved && st.delivered) {
              return respondOk({
                success: true,
                handed_off: true,
                operator_joined: !!handoffConv.operator_joined_at,
                response: handoffState.emailCapturedAck(handoffIdentity.email),
                conversation_id: handoffConv.conversation_id,
                handoff_state: handoffStateLabel(st),
                visitor_email_saved: true,
              });
            }
          }
          if (chipAction && chipAction !== 'human_handoff') {
            // leave_message / book_appointment / schedule_demo while handed
            // off: skip the early return so the CHIP-ACTION branch executes
            // the tool and replies with its own confirmation. The visitor
            // message is NOT persisted here — persist-message later writes
            // the user+confirmation pair against this conversation (an
            // explicit conversation_id skips the active-only lookup).
            handedOffConversationId = handoffConv.conversation_id;
          } else if (chipAction === 'human_handoff') {
            const st = await settleHandoffState(handoffConv.conversation_id, message, handoffRelayPromise);
            return respondOk({
              success: true,
              handed_off: true,
              operator_joined: !!handoffConv.operator_joined_at,
              response: st.saved && st.delivered ? HANDOFF_ALREADY_QUEUED_ACK : handoffStateAck(st, handoffConv.conversation_id, true),
              conversation_id: handoffConv.conversation_id,
              handoff_state: handoffStateLabel(st),
            });
          } else if (!handoffConv.operator_joined_at && handoffState.isWaitQuestion(message)) {
            // Waiting visitor asking "are they coming? how long?": answer from
            // availability data in visitor voice. Without this the question
            // reached the model, which recited operator setup docs at them.
            const st = await settleHandoffState(handoffConv.conversation_id, message, handoffRelayPromise);
            const meta = await fetchWidgetMeta(widget_id);
            const marker = handoffState.getHandedOff(widget_id, visitor_id);
            return respondOk({
              success: true,
              handed_off: true,
              operator_joined: false,
              response: handoffState.buildWaitReply({
                availability: meta ? evaluateAvailability(meta) : null,
                handedOffAt: marker && Number.isFinite(marker.at) ? marker.at : null,
              }),
              conversation_id: handoffConv.conversation_id,
              handoff_state: handoffStateLabel(st),
            });
          } else if (!handoffConv.operator_joined_at) {
            // Requested but nobody has picked up: fall through to the AI
            // path against THIS conversation. The relay above already
            // carried the message to the room; the normal persist path
            // writes the user+assistant pair (explicit conversation_id
            // skips the active-only lookup), so no separate persist here.
            handedOffConversationId = handoffConv.conversation_id;
            handoffAwaitingPickup = true;
          } else {
            const st = await settleHandoffState(handoffConv.conversation_id, message, handoffRelayPromise);
            return respondOk({
              success: true,
              handed_off: true,
              operator_joined: true,
              response: handoffStateAck(st, handoffConv.conversation_id),
              conversation_id: handoffConv.conversation_id,
              handoff_state: handoffStateLabel(st),
            });
          }
        }
      } catch (gateErr) {
        // The lookup itself is handled fail-closed above; anything thrown
        // here is a post-lookup step. Never fall through to the AI if a
        // handed-off conversation was found.
        console.warn('[QuoxChat] handoff gate step failed:', gateErr.message);
        if (handedOffConversationId) {
          return respondOk({ success: true, handed_off: true, response: HANDOFF_LOOKUP_FAILED_ACK, conversation_id: handedOffConversationId, degraded: 'handoff_state_unavailable' });
        }
      }
    }

    // Injection detection
    const injectionPatterns = INJECTION_PATTERNS;
    let injectionScore = 0;
    const injectionFlags = [];
    // Score everything the browser controls, not only the message.
    const injectionSurface = `${message}\n${confineBrowserContext({ page_url, page_context }).injectionText}`;
    for (const p of injectionPatterns) {
      if (p.test(injectionSurface)) {
        injectionScore += 3;
        injectionFlags.push(p.source.slice(0, 30));
      }
    }
    if (injectionScore > 0) {
      console.log(`[QuoxChat] Injection detected (score=${injectionScore}): ${injectionFlags.join(', ')}`);
    }

    // QCX-2.1: SCENARIO_RUN is the parent envelope for this LLM turn. Every
    // sub-event (knowledge retrieval, tool invoke/complete, output filter,
    // terminal message) threads off it via reply_to. corr defaults to
    // visitor_id so all turns in a visitor session share a root corr.
    const scenarioEnv = buildWidgetEnvelope({
      intent: WIDGET_INTENTS.SCENARIO_RUN,
      visitor_id: visitor_id || 'anon',
      widget_id,
      payload: { message_length: message.length, injection_score: injectionScore, injection_flags: injectionFlags.slice(0, 6) },
    });
    try { _storeAuditEnvelope(scenarioEnv); } catch (e) { /* non-fatal */ }

    // QCX-2.3: start a VOLT run for this turn so the model call + tool
    // executions + terminal message land in a hash-chained evidence
    // bundle. Run id is local — completes at the end of the handler
    // whether the turn succeeded or failed.
    let voltRunId = null;
    if (_voltEmitter) {
      try {
        voltRunId = _voltEmitter.startRun(visitor_id || 'anon', {
          widget_id,
          visitor_id: visitor_id || 'anon',
          agent_id: 'quoxchat',
        });
      } catch { /* non-fatal */ }
    }
    const _voltEmit = (eventType, payload) => {
      if (!_voltEmitter || !voltRunId) return;
      try { _voltEmitter.emit(voltRunId, eventType, payload || {}); } catch { /* non-fatal */ }
    };
    const _voltComplete = (state) => {
      if (!_voltEmitter || !voltRunId) return;
      try { _voltEmitter.completeRun(voltRunId, state || 'ok'); } catch { /* non-fatal */ }
    };

    // QCX-2.2: Small helper for emitting AOCL layer checkpoints threaded
    // under SCENARIO_RUN. Swallows errors (audit must never break chat).
    const _aoclVisitorId = visitor_id || 'anon';
    const emitLayer = (layer, verdict, reason, timing_ms, extra) => {
      try {
        _storeAuditEnvelope(buildAoclLayerEnvelope({
          layer, verdict, reason,
          visitor_id: _aoclVisitorId, widget_id,
          reply_to: scenarioEnv.id,
          timing_ms, extra,
        }));
      } catch { /* non-fatal */ }
    };

    // QCX-2.2: Layer 1 — ingress. The rateLimit + domainGuard middlewares
    // have already decided to let us in; record the verdict so the trail
    // shows the check happened + what the decision was.
    emitLayer('ingress', 'ok', 'passed rate_limit + domain_guard', null, {
      origin: req.headers.origin || null,
    });

    // QCX-2.2: Layer 3 — perception. Injection score is computed above;
    // emit as warn if any pattern matched, ok otherwise.
    emitLayer(
      'perception',
      injectionScore > 0 ? 'warn' : 'ok',
      injectionScore > 0 ? `injection_score=${injectionScore}` : 'no_injection_signal',
      null,
      { score: injectionScore, flags: injectionFlags.slice(0, 6) },
    );

    // QCL-SECURITY P1-3: make the scorer actionable. Below HIGH_THRESHOLD we
    // only log (above) — a single incidental keyword match (e.g. "system
    // prompt" in a genuine question) scores 3 and must never block. At/above
    // HIGH_THRESHOLD the message has matched at least two distinct attack
    // patterns (e.g. "ignore previous instructions" + "reveal system
    // prompt") — conservative bar chosen so ordinary conversation can't
    // reach it. Short-circuits with a safe grounded refusal instead of
    // spending an LLM call, and records the block in the audit trail.
    const INJECTION_BLOCK_THRESHOLD = 6;
    if (injectionScore >= INJECTION_BLOCK_THRESHOLD) {
      console.warn(`[QuoxChat] Injection blocked (score=${injectionScore}): ${injectionFlags.join(', ')}`);
      emitLayer(
        'perception',
        'reject',
        `injection_blocked score=${injectionScore}`,
        null,
        { score: injectionScore, flags: injectionFlags.slice(0, 6), blocked: true },
      );
      try {
        _storeAuditEnvelope(buildWidgetEnvelope({
          intent: WIDGET_INTENTS.MESSAGE,
          visitor_id: visitor_id || 'anon',
          widget_id,
          reply_to: scenarioEnv.id,
          payload: {
            message_length: message.length,
            injection_score: injectionScore,
            injection_flags: injectionFlags.slice(0, 6),
            blocked: true,
          },
        }));
      } catch (e) { /* non-fatal */ }
      _voltEmit('quoxchat.message.blocked', { injection_score: injectionScore, injection_flags: injectionFlags.slice(0, 6) });
      _voltComplete('blocked');
      // Wave 5: record the blocked turn (conversation + filtered visitor
      // message) so operators can see attack attempts in Logs. Best effort and
      // bounded: the visitor reply below is unchanged either way.
      if (widget_id && widget_id !== 'demo') {
        try {
          const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
          const serviceKey = process.env.INTERNAL_SERVICE_KEY;
          if (serviceKey) {
            const pr = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/persist-message`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
              body: JSON.stringify({
                visitor_id: visitor_id || 'anon',
                conversation_id: null,
                user_message: message,
                assistant_message: "I can't help with that request.",
                injection_score: injectionScore,
                blocked: true,
                page_url: page_url || null,
                context: { blocked: true, injection_score: injectionScore, injection_flags: injectionFlags.slice(0, 6) },
              }),
              signal: AbortSignal.timeout(3000),
            });
            if (!pr.ok) console.warn(`[QuoxChat] blocked-turn persist returned ${pr.status}`);
          }
        } catch (persistErr) {
          console.warn('[QuoxChat] blocked-turn persist failed (non-fatal):', persistErr.message);
        }
      }
      return respondOk({
        success: true,
        response: "I can't help with that request.",
        sources: [],
        tokens: { input: 0, output: 0 },
        duration_ms: Date.now() - startMs,
        model: null,
        injection_score: injectionScore,
        conversation_id: null,
      });
    }

    // QCL-2: resolve the widget's org FIRST so per-widget BYOK keys (vault
    // credentials scoped to the widget's org) are found. getProviderKeys()
    // without an org resolves instance-level keys only, so an org-scoped
    // widget key (e.g. the Quox website widget's OpenAI key) is invisible and
    // the widget falls back to "no API key". Fetched once and reused for the
    // llm_provider/tool-policy block below.
    const widgetMeta = await fetchWidgetMeta(widget_id);
    const widgetOrgId = widgetMeta?.org_id || undefined;

    // W5 defect 7: a paused or archived widget must not answer. Plain JSON
    // 423 before any SSE frame (stream and non-stream alike). Older auth that
    // does not send `status` is served as before.
    if (widgetMeta && (widgetMeta.status === 'paused' || widgetMeta.status === 'archived')) {
      stopKeepalive();
      return res.status(423).json({
        success: false,
        error: 'widget_paused',
        response: 'This chat is currently unavailable. Please try again later or contact the site owner.',
        message: 'This chat is currently unavailable.',
      });
    }

    // w5h (publish gate honesty): a DRAFT widget does not serve the public.
    // The publish-readiness gate said "blocked" while a draft widget answered
    // any visitor on an allowed origin. Draft answers only (a) a valid
    // service key (simulation, MCP self-calls), (b) dev origins (localhost /
    // LAN: local embedding and the dev dashboard preview) and (c) hosts in
    // QUOXCHAT_PREVIEW_ORIGINS (the dashboard origin, for the Widget Room
    // preview on a hosted install). active and published serve the public.
    // QUOXCHAT_SERVE_DRAFT_PUBLIC=1 restores the old behaviour for an install
    // that needs a grace period before activating its existing widgets.
    if (widgetMeta && widgetMeta.status === 'draft' && !draftServingAllowed(req)) {
      stopKeepalive();
      return res.status(423).json({
        success: false,
        error: 'widget_draft',
        response: 'This chat is not live yet. Please check back soon or contact the site owner.',
        message: 'This chat is not live yet.',
      });
    }

    // Get LLM API key from vault (org-scoped when the widget's org is known)
    const providerKeys = await _getProviderKeysResilient(widgetOrgId);
    const geminiKey = providerKeys?.gemini_api_key || process.env.GEMINI_API_KEY;
    const openaiKey = providerKeys?.openai_api_key || process.env.OPENAI_API_KEY;
    const anthropicKey = providerKeys?.anthropic_api_key || (await _getClaudeKeys())?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;

    // Widget-level OpenAI-compatible endpoint (Ollama, vLLM, any compatible
    // API). Configured in embed_config.llm; the key is a vault reference.
    const compatParsed = parseCompatConfig(widgetMeta?.embed_config_json);
    let compatKey = '';
    if (compatParsed && compatParsed.ok && compatParsed.apiKeyRef) {
      compatKey = (await resolveSecret(compatParsed.apiKeyRef, widgetOrgId)) || '';
    }
    const compatConfigured = Boolean(compatParsed && compatParsed.ok);
    const compatRuntime = compatConfigured ? { parsed: compatParsed } : null;
    // A key-less endpoint (Ollama) is still "configured"; the truthy marker
    // stands in for the key in the provider-keys maps.
    const compatKeyMarker = compatConfigured ? (compatKey || 'no-key') : null;
    const compatLabelFor = (m) => `${m} (${SELF_HOSTED_LABEL})`;

    // CW-12.2: per-widget LLM provider preference (auto | anthropic | openai | gemini).
    // Falls back to auto-pick when the preferred provider has no key configured.
    let widgetLlmPref = 'auto';
    // QCX-6j — per-widget tool-policy. tool_deny_list is the only rule
    // shipped today; the evaluator's contract supports more later.
    let widgetToolPolicies = null;
    // SECURITY AUDIT FIX (finding #1, CRITICAL) — read the widget's
    // explicitly-configured hard budget cap locally, off widgetMeta (already
    // fetched above), independent of the usage/current fetch further below.
    // This is what lets the quota gate distinguish "cap configured but
    // unverifiable" (fail closed) from "no cap configured" (fail open,
    // unchanged) even when the usage fetch itself is what's failing.
    let widgetHardBudgetCap = null;
    // QC-LINKS: curated per-widget site map so the assistant can hand out
    // REAL documentation/page links. Answers summarise; the link is the way
    // deeper. The model may only link from this list, never invent URLs.
    let widgetSiteLinks = null;
    try {
      const meta = widgetMeta; // reuse the meta fetched above (org + config)
      if (meta?.embed_config_json) {
        const cfg = typeof meta.embed_config_json === 'string' ? JSON.parse(meta.embed_config_json) : meta.embed_config_json;
        if (Array.isArray(cfg?.site_links)) {
          widgetSiteLinks = cfg.site_links
            .filter((l) => l && typeof l === 'object'
              && typeof l.title === 'string' && l.title.trim()
              && typeof l.url === 'string' && /^https:\/\//i.test(l.url.trim()))
            .slice(0, 200)
            .map((l) => ({ title: l.title.trim().slice(0, 80), url: l.url.trim().slice(0, 200) }));
          if (widgetSiteLinks.length === 0) widgetSiteLinks = null;
        }
        if (cfg?.llm_provider && ['anthropic', 'openai', 'gemini'].includes(cfg.llm_provider)) {
          widgetLlmPref = cfg.llm_provider;
        }
        if (cfg?.tool_policies && typeof cfg.tool_policies === 'object') {
          widgetToolPolicies = cfg.tool_policies;
        } else if (Array.isArray(cfg?.tool_deny_list)) {
          // Allow shorthand: just the array, no wrapper object.
          widgetToolPolicies = { tool_deny_list: cfg.tool_deny_list };
        }
        if (cfg?.llm_budget && typeof cfg.llm_budget === 'object'
          && Number.isFinite(cfg.llm_budget.monthly_request_cap) && cfg.llm_budget.monthly_request_cap > 0) {
          widgetHardBudgetCap = cfg.llm_budget.monthly_request_cap;
        }
      }
    } catch (e) { /* non-fatal — fall through to auto */ }

    // CAPTCHA #127 — bot-detection action gate. OFF BY DEFAULT: this entire
    // block is a no-op (humanVerified stays undefined, zero fetch calls,
    // zero audit envelopes) unless the widget's embed_config_json
    // .bot_protection.enabled === true. When enabled, verifies the
    // per-message captcha_token server-side and threads the verdict into
    // the tool-loop context as human_verified — evaluateToolPolicy's
    // bot_protection gate (quoxchatToolPolicy.js) reads that field.
    let humanVerified; // undefined = not configured for this widget (no-op downstream)
    let bpGateDesigned = false; // true once we KNOW this widget enabled bot_protection
    try {
      const meta = widgetMeta;
      const cfgRaw = meta?.embed_config_json;
      let cfg = null;
      try {
        cfg = typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : cfgRaw;
      } catch (parseErr) {
        // Ledger critical #4 hardening (2026-07-24): an unparseable embed
        // config used to fall into the outer swallow-catch, leaving
        // humanVerified undefined ("not configured") — a widget that HAD
        // bot_protection enabled silently lost its gate. Corrupt JSON hides
        // intent, so read it as NOT verified rather than not configured.
        humanVerified = false;
        console.warn(`[QuoxChat] bot_protection gate: embed_config_json unparseable for widget=${widget_id} — failing CLOSED (human_verified=false):`, parseErr.message);
      }
      const bp = cfg?.bot_protection;
      if (bp && typeof bp === 'object' && bp.enabled === true) {
        bpGateDesigned = true;
        const bpProvider = bp.provider === 'turnstile' ? 'turnstile' : 'recaptcha_v3';
        const bpMinScore = Number.isFinite(bp.min_score) ? bp.min_score : 0.5;
        const bpGuard = bp.guard === 'all' ? 'all' : 'side_effecting';
        if (!widgetToolPolicies) widgetToolPolicies = {};
        widgetToolPolicies.bot_protection = { enabled: true, guard: bpGuard };

        // captcha_secret is server-only (never in embed_config_json) — see
        // migration 080-website-widgets-captcha-secret.sql. A widget that
        // enabled bot_protection but hasn't set a secret yet is a
        // misconfiguration, not an escape hatch: fail closed.
        const secret = meta?.captcha_secret || null;
        const verdict = secret
          ? await verifyCaptchaToken({
              provider: bpProvider,
              token: typeof req.body?.captcha_token === 'string' ? req.body.captcha_token : null,
              secret,
              remoteip: req.ip,
              min_score: bpMinScore,
              expectedAction: 'quoxchat_message',
            })
          : { ok: false, score: null, reason: 'no_secret_configured' };
        humanVerified = verdict.ok === true;

        // Witness the verdict on the evidence chain — hash the token,
        // never log it.
        try {
          _storeAuditEnvelope(buildWidgetEnvelope({
            intent: WIDGET_INTENTS.HUMAN_VERIFIED,
            visitor_id: visitor_id || 'anon',
            widget_id,
            reply_to: scenarioEnv.id,
            payload: {
              provider: bpProvider,
              guard: bpGuard,
              ok: verdict.ok,
              score: verdict.score,
              reason: verdict.reason,
              token_hash: typeof req.body?.captcha_token === 'string' ? hashInput(req.body.captcha_token) : null,
            },
          }));
        } catch { /* non-fatal — audit trail must never break chat */ }
      }
    } catch (e) {
      // Ledger critical #4 hardening (2026-07-24): this catch used to
      // swallow everything, leaving humanVerified undefined — downstream
      // that reads as "gate not configured", i.e. FAIL OPEN for a widget
      // that was designed to be bot-protected. Chat itself still never
      // breaks, but where the gate was designed (embed config or stored
      // tool policies enabled it), an error now reads as NOT verified.
      if (bpGateDesigned || widgetToolPolicies?.bot_protection?.enabled === true) {
        humanVerified = false;
        console.warn('[QuoxChat] bot_protection gate error — failing CLOSED (human_verified=false):', e?.message || e);
      } else {
        console.warn('[QuoxChat] bot_protection gate error (widget not bot-protected, gate left unset):', e?.message || e);
      }
    }

    let useGemini = false, useOpenAI = false, useAnthropic = false, useCompat = false;
    const widgetPrefersCompat = Boolean(compatParsed && compatParsed.selected);
    if (widgetPrefersCompat && !compatConfigured) {
      console.warn(`[QuoxChat] widget ${widget_id} selects openai_compatible but its config is invalid (${compatParsed.error}); using the normal provider order`);
    }
    if (widgetPrefersCompat && compatConfigured) { useCompat = true; }
    else if (widgetLlmPref === 'openai' && openaiKey) { useOpenAI = true; }
    else if (widgetLlmPref === 'anthropic' && anthropicKey) { useAnthropic = true; }
    else if (widgetLlmPref === 'gemini' && geminiKey) { useGemini = true; }
    else {
      // auto: prefer the more capable Anthropic/OpenAI over Gemini when available.
      if (openaiKey) useOpenAI = true;
      else if (anthropicKey) useAnthropic = true;
      else if (geminiKey) useGemini = true;
    }
    // QUOXCHAT-BRUTALOOP: failover policy (embed_config.llm_failover,
    // embed_config.llm_failover_order). A primary that failed in the last
    // minute is skipped up front instead of costing every visitor a timeout.
    const failoverPolicy = (() => {
      try {
        const raw = widgetMeta?.embed_config_json;
        const c = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        return { enabled: c.llm_failover !== false, order: Array.isArray(c.llm_failover_order) ? c.llm_failover_order : null };
      } catch { return { enabled: true, order: null }; }
    })();
    {
      const keysNow = { openai: openaiKey, anthropic: anthropicKey, gemini: geminiKey, [COMPAT_PROVIDER]: compatKeyMarker };
      const primaryNow = useCompat ? COMPAT_PROVIDER : useOpenAI ? 'openai' : useAnthropic ? 'anthropic' : useGemini ? 'gemini' : null;
      if (primaryNow && failoverPolicy.enabled) {
        const chosen = providerCooldowns.pickPrimary(widget_id, failoverOrder({ primary: primaryNow, keys: keysNow, enabled: true, order: failoverPolicy.order }));
        if (chosen && chosen !== primaryNow) {
          console.warn(`[QuoxChat] ${primaryNow} cooling down for widget ${widget_id}; answering on ${chosen}`);
          useOpenAI = chosen === 'openai'; useAnthropic = chosen === 'anthropic'; useGemini = chosen === 'gemini'; useCompat = chosen === COMPAT_PROVIDER;
        }
      }
    }
    const apiKey = useCompat ? compatKey : useOpenAI ? openaiKey : useAnthropic ? anthropicKey : useGemini ? geminiKey : (openaiKey || anthropicKey || geminiKey);

    // An OpenAI-compatible endpoint may legitimately need no key (Ollama).
    if (!apiKey && !useCompat) {
      console.warn('[QuoxChat] No API key available');
      // QC-BRUTALOOP-W13: a handed-off visitor must never see a configuration
      // error; the message goes to the operator exactly as the handed-off path does.
      if (handedOffConversationId) {
        const st = await settleHandoffState(handedOffConversationId, message, handoffRelayPromise);
        return respondOk({
          success: true,
          handed_off: true,
          operator_joined: false,
          response: handoffStateAck(st, handedOffConversationId, true),
          conversation_id: handedOffConversationId,
          handoff_state: handoffStateLabel(st),
          degraded: 'no_api_key',
        });
      }
      // QC-BRUTALOOP-W13: the failed turn is recorded with an error outcome so it
      // shows in Logs and the unanswered list (grounding.withheld classifies it
      // as a held-back reply). Best effort and bounded; the reply is unchanged.
      const offlineReply = "I'm currently offline due to a configuration issue. Please contact us directly for help.";
      const failedConvId = await persistFailedTurn('no_api_key', offlineReply);
      return respondOk({ success: false, response: offlineReply, error: 'no_api_key', ...(failedConvId ? { conversation_id: failedConvId } : {}) });
    }
    console.log(`[QuoxChat] Using ${useCompat ? 'OpenAI-compatible' : useGemini ? 'Gemini' : useOpenAI ? 'OpenAI' : 'Anthropic'} provider (widget_pref=${widgetLlmPref})`);

    // QUOXCHAT-BRUTALOOP ITER 1: history is rebuilt from persisted turns
    // (client assistant turns are untrusted). Fetched before retrieval so a
    // follow-up's retrieval query can carry the visitor's previous turn.
    const serverHistory = await fetchServerHistory({
      authUrl: process.env.AUTH_SERVICE_URL || 'http://auth:3101',
      serviceKey: process.env.INTERNAL_SERVICE_KEY,
      widgetId: widget_id,
      visitorId: visitor_id,
    });
    const builtHistory = buildHistory({ server: serverHistory, client: conversation_history });

    // ── RAG Retrieval ──
    let ragChunks = [];
    // CW-8.15: per-widget namespace, 'quoxchat_demo' fallback for unknown/demo widgets.
    const qdrantCollection = qdrantCollectionForWidget(widget_id);

    // Dense search for one query string (also used to re-retrieve the previous
    // turn's knowledge, wave 9). Returns [] on any failure; the failure is logged.
    // Wave 10 #5: denseSearchOnce THROWS on failure so a retrieval error is
    // never mistaken for "nothing documented"; denseSearch keeps the old
    // swallow-and-log contract for the carry-forward query.
    const denseSearchOnce = async (retrievalQuery) => {
      // No embedding key at all: RAG is not configured for this widget/org,
      // which is "no knowledge", not a retrieval outage.
      if (!(providerKeys?.openai_api_key || process.env.OPENAI_API_KEY || providerKeys?.gemini_api_key || process.env.GEMINI_API_KEY)) return [];
      const embedDiag = {};
      const embedResult = await embedText(retrievalQuery, providerKeys, { orgId: widgetOrgId, diag: embedDiag });
      const queryVector = embedResult?.vector || [];
      if (queryVector.length === 0) { const e = new Error('embedding_failed'); e.detail = embedDiag; throw e; }
      const qdrantKey = resolveQdrantKey();
      const searchResp = await fetch(`http://qdrant:6333/collections/${qdrantCollection}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
        body: JSON.stringify({ vector: queryVector, limit: 5, with_payload: true }),
        signal: AbortSignal.timeout(3000),
      });
      // 404: the widget has no collection yet (nothing ingested), which is
      // "no knowledge", not an outage.
      if (searchResp.status === 404) return [];
      if (!searchResp.ok) throw new Error(`qdrant_search_${searchResp.status}`);
      const searchData = await searchResp.json();
      // W5: chunks flagged high for prompt injection at ingest never reach the prompt or the cited sources.
      return (searchData.result || []).filter(r => r?.payload?.injection_flag !== 'high' && r?.payload?.superseded !== true).map(r => ({
        text: r.payload?.text || '',
        source: r.payload?.source || '',
        section: r.payload?.section || '',
        score: r.score || 0,
        pinned: r.payload?.pinned === true,
        answer: r.payload?.answer || null,
        source_url: typeof r.payload?.source_url === 'string' ? r.payload.source_url : null,
        injection: r.payload?.injection_flag || null,
        ...(r.payload?.suggest_superseded === true ? { suggest_superseded: true } : {}),
      }));
    };
    const denseSearch = async (retrievalQuery) => {
      try {
        return await denseSearchOnce(retrievalQuery);
      } catch (ragErr) {
        console.warn('[QuoxChat] RAG failed (non-fatal):', ragErr.message);
        return [];
      }
    };
    const denseResult = await searchWithRetry(() => denseSearchOnce(buildRetrievalQuery(message, builtHistory.messages)));
    // Set when dense retrieval failed twice; hybrid below then runs lexical-only.
    const retrievalError = denseResult.error;
    let retrievalFailedReplied = false;
    if (retrievalError) console.warn(`[QuoxChat] RAG dense retrieval failed after ${denseResult.attempts} attempts (${retrievalError}); lexical-only fallback`);
    ragChunks = denseResult.chunks;
    console.log(`[QuoxChat] RAG: ${ragChunks.length} chunks (top: ${ragChunks[0]?.score?.toFixed(3) || '-'}) at +${Date.now() - startMs}ms`);

    // Hybrid retrieval: BM25 over the widget's payloads fused (RRF) with the
    // dense top-k. Fails open to dense-only; the verdict rides on lexicalVerdict.
    let lexicalVerdict = null;
    try {
      const qdrantKeyLex = resolveQdrantKey();
      const hy = await quoxchatLexical.hybrid({
        collection: qdrantCollection,
        query: buildRetrievalQuery(message, builtHistory.messages),
        dense: ragChunks,
        loader: () => quoxchatLexical.scrollPayloads({ collection: qdrantCollection, qdrantKey: qdrantKeyLex }),
      });
      ragChunks = hy.chunks;
      lexicalVerdict = hy.verdict;
    } catch (lexErr) {
      lexicalVerdict = { lexical: false, lexical_error: String(lexErr && lexErr.message).slice(0, 120) };
    }

    // QCX-2.1: KNOWLEDGE_RETRIEVED child of SCENARIO_RUN. Fingerprints the
    // query + records chunk count, top/average scores, pinned count. No
    // chunk text — that's LLM-visible only.
    try {
      _storeAuditEnvelope(buildWidgetEnvelope({
        intent: WIDGET_INTENTS.KNOWLEDGE_RETRIEVED,
        visitor_id: visitor_id || 'anon',
        widget_id,
        reply_to: scenarioEnv.id,
        payload: {
          query_hash: hashInput(message),
          n_chunks: ragChunks.length,
          top_score: ragChunks[0]?.score ?? null,
          avg_score: ragChunks.length > 0 ? Number((ragChunks.reduce((a, c) => a + (c.score || 0), 0) / ragChunks.length).toFixed(3)) : null,
          n_pinned: ragChunks.filter(c => c.pinned).length,
          collection: qdrantCollection,
          lexical: lexicalVerdict,
        },
      }));
    } catch (e) { /* non-fatal */ }

    // QCX-2.2: Layer 4 — retrieval. Grounded answer quality correlates
    // directly with n_chunks + top_score; surface both in the waterfall.
    emitLayer(
      'retrieval',
      ragChunks.length > 0 ? 'ok' : 'warn',
      ragChunks.length > 0 ? `n=${ragChunks.length} top=${ragChunks[0]?.score?.toFixed(2) ?? '-'}` : 'no_chunks_retrieved',
      null,
      { n_chunks: ragChunks.length, top_score: ragChunks[0]?.score ?? null, collection: qdrantCollection, lexical: lexicalVerdict, retrieval_error: retrievalError },
    );

    // QUOXCHAT-BRUTALOOP ITER 1: neutral [K1] labels (source ids and file
    // names never reach the model, which used to turn them into invented
    // URLs), duplicate collapse, a junk floor and a confidence signal.
    // Thresholds are per widget (embed_config.grounding) because score
    // distributions differ between embedding models.
    const groundingCfg = (() => {
      try {
        const raw = widgetMeta?.embed_config_json;
        const cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        return (cfg && typeof cfg.grounding === 'object' && cfg.grounding) || {};
      } catch { return {}; }
    })();
    // Verified streaming is the default; only an explicit 'live' opts out, and
    // only turns the claim verifier will check are held.
    verifiedStream.hold = streaming && groundingCfg.stream_mode !== 'live' && groundingCfg.verify_claims !== false;
    // Wave 9: carry forward the previous visitor turn's knowledge (cap 3) so a
    // condition established earlier ("LS22: boiler installs only") stays in
    // view on a follow-up whose own retrieval misses it. Carried chunks are
    // capped below the 'strong' score so they never raise confidence.
    try {
      const prevUserMsg = (builtHistory.messages || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()).map((m) => m.content.trim()).pop();
      if (prevUserMsg && prevUserMsg !== String(message || '').trim()) {
        const prevChunks = (await denseSearch(prevUserMsg.slice(0, 600))).filter((c) => (c.score || 0) >= 0.4).map((c) => ({ ...c, score: Math.min(c.score, 0.5) }));
        const before = ragChunks.length;
        ragChunks = mergeCarriedChunks(ragChunks, prevChunks, { cap: 3 });
        if (ragChunks.length > before) console.log(`[QuoxChat] RAG: carried ${ragChunks.length - before} chunk(s) from the previous turn`);
      }
    } catch (carryErr) {
      console.warn('[QuoxChat] carry-forward failed (non-fatal):', carryErr.message);
    }
    const conversationContext = (builtHistory.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-5).concat([{ role: 'user', content: String(message || '') }]);
    // QC-W15b: an older dated version of the same priced items is history.
    try { ragChunks = markHistoryChunks(ragChunks, { now: new Date() }); } catch (arbErr) { console.warn('[QuoxChat] version arbitration failed (non-fatal):', arbErr.message); }
    // QC-W18: a dated price-change notice modifies the figures in sibling sources.
    let priceChangePremise = null;
    try {
      const pc = applyPriceChange(ragChunks, { visitorTexts: [message, ...((builtHistory.messages || []).filter((m) => m && m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')))], now: new Date() });
      ragChunks = pc.chunks; priceChangePremise = pc.premise;
    } catch (pcErr) { console.warn('[QuoxChat] price-change modifier failed (non-fatal):', pcErr.message); }
    const knowledge = prepareKnowledge(ragChunks, {
      floor: typeof groundingCfg.floor === 'number' ? groundingCfg.floor : undefined,
      strong: typeof groundingCfg.strong === 'number' ? groundingCfg.strong : undefined,
    });
    const ragContext = knowledge.context;
    streamGround.allowed = buildAllowedUrls({ siteLinks: widgetSiteLinks, chunks: knowledge.kept });
    streamGround.support = knowledge.kept.map((c) => c.text);
    // Figures the visitor typed (this turn or earlier ones) are theirs, not inventions.
    const visitorTexts = [message, ...((builtHistory.messages || []).filter((m) => m && m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')))];
    // Wave 11: deterministic period conversions of the visitor's money figures
    // (monthly x 12 / 52) so threshold rules are applied to the right figure.
    // Wave 13: the visitor's own words only, for the date-window guard (the
    // computed premises below restate "today" and must not be read as dates).
    const dateVisitorTexts = [...visitorTexts];
    // Wave 13: night-by-night season breakdown for a stay over a dated rate change.
    const stayPlan = planStay(dateVisitorTexts, knowledge.kept.map((c) => c.text), new Date(), widgetTimezone(widgetMeta));
    const priceFixes = priceCorrections(message, knowledge.kept.map((c) => c.text));
    const blockTariffPlan = planBlockTariff(dateVisitorTexts, knowledge.kept.map((c) => c.text));
    const openNowPlan = planOpenNow(message, knowledge.kept.map((c) => c.text), new Date(), widgetTimezone(widgetMeta));
    const bandChangePlan = planBandChange(dateVisitorTexts, knowledge.kept.map((c) => c.text), new Date(), widgetTimezone(widgetMeta));
    const validityPlan = planValidity(dateVisitorTexts, knowledge.kept.map((c) => c.text), new Date(), widgetTimezone(widgetMeta));
    // QC-W18: deterministic condition checks (grandfather booking date, room capacity).
    const eligibilityPlan = eligibilityChecks(dateVisitorTexts, knowledge.kept.map((c) => c.text));
    const deadlinePlanList = deadlinePlans(dateVisitorTexts, knowledge.kept.map((c) => c.text), new Date(), widgetTimezone(widgetMeta));
    const premiseConversions = [
      ...(priceChangePremise ? [priceChangePremise] : []),
      ...deadlinePlanList.map((p) => p.premise),
      ...bandPremises(dateVisitorTexts, knowledge.kept.map((c) => c.text), new Date(), widgetTimezone(widgetMeta)),
      ...eligibilityPlan.map((c) => c.premise),
      ...capacityPremises(dateVisitorTexts, knowledge.kept.map((c) => c.text)),
      ...(validityPlan ? [validityPlan.fact] : []),
      ...(openNowPlan ? [openNowPlan.fact] : []),
      ...(bandChangePlan ? [bandChangePlan.fact] : []),
      ...(stayPlan && stayPlan.fact ? [stayPlan.fact] : []),
      ...(blockTariffPlan ? [blockTariffPlan.fact] : []),
      ...priceFixes.map(pricePremiseFor),
      // Wave 13: day gap between a date the visitor named and each "N days
      // before" window in KNOWLEDGE, computed in code in the widget timezone.
      ...dateWindowPremises(dateVisitorTexts, knowledge.kept.map((c) => c.text), new Date(), widgetTimezone(widgetMeta)),
      ...enrichVisitorPremises(visitorTexts),
    ].slice(0, 6);
    visitorTexts.push(...premiseConversions);
    streamGround.visitor = visitorTexts;
    streamGround.tz = widgetTimezone(widgetMeta);
    streamGround.brandNames = [widgetMeta?.business_name, widgetMeta?.name].filter(Boolean);

    // QCX-3.1: pick a persona via keyword delegation. COREY is the default
    // chatbot persona when no specialist scores above threshold. Fingerprint
    // the delegation decision into the AEE chain so the admin UI can show
    // "routed to WARDEN (score=30)" alongside the conversation. widgetTools
    // is fetched further below for the smart-router + tool loop — the
    // delegator runs on capability keywords only, which is fine.
    const delegationDecision = pickAgent(message, { toolNames: [] });
    const persona = getPersona(delegationDecision.persona_id) || getPersona(DEFAULT_PERSONA_ID);
    // QCX-BRAND: a widget with a system_prompt_override speaks for the
    // customer's brand. The override replaces the persona CHARACTER layer
    // (which is Quox-scoped) while a neutral safety preamble keeps the same
    // belts. Previously the override was stored by auth but never read here,
    // so branded widgets answered as Quox (caught live on the first
    // white-label deployment, 2026-09-04).
    const overrideText = typeof widgetMeta?.system_prompt_override === 'string'
      ? widgetMeta.system_prompt_override.trim() : '';
    // W5 defect 2: no override means a NEUTRAL customer prompt, not Quox.
    // The Quox persona needs an explicit opt-in (isQuoxPersonaWidget).
    const personaSystemPrompt = (overrideText
      ? buildOverrideSystemPrompt(overrideText)
      : (isQuoxPersonaWidget(widgetMeta) ? persona.system_prompt : buildDefaultCustomerPrompt(widgetMeta)))
      + buildGuardrailsBlock(widgetMeta?.guardrails);

    // QCX-3.2: bump visitor memory — persists first_seen / last_seen /
    // conversation_count / identified_attrs. Returns a short "returning
    // visitor" preamble (empty string for first-timers) to inject into the
    // system prompt. Non-fatal — if auth is unavailable we just skip.
    let visitorSummary = '';
    // QCL-SECURITY P1-5(d) — verified + identified_email feed the tool-policy
    // gate below (unverified visitors can't trigger side-effecting tools;
    // 'self_only' recipient policy needs the visitor's own captured email).
    // Both default to the safe/conservative value (unverified, no email)
    // when we can't reach auth or the visitor is anonymous.
    let visitorVerified = false;
    let visitorIdentifiedEmail = null;
    // QUOXCHAT-EMAIL D2/D3 — provenance of that email ('identify' | 'chat' |
    // 'declared'), stamped auth-side. Feeds the transcript recipient-trust
    // matrix in quoxchatToolExecutors.emailTranscript.
    let visitorIdentifiedEmailSource = null;
    // QUOXCHAT-PRO visitor name: identified name rides beside the email so
    // handoffs can label the HITL item / Matrix room / org alert as a person.
    let visitorIdentifiedName = null;
    // QCX-ACTIONS P1 — the HMAC-verified stable id (set only via a valid
    // user_hash on /events/visitor-identified). Feeds identity_param
    // injection in the REST executor; NEVER derived from chat content.
    let visitorExternalUserId = null;
    if (widget_id && widget_id !== 'demo' && visitor_id && visitor_id !== 'anon') {
      const upsert = await upsertVisitorMemory(widget_id, { visitor_id, bump_conversation: true });
      if (upsert?.summary) visitorSummary = '\n\nVISITOR CONTEXT: ' + upsert.summary;
      visitorVerified = upsert?.visitor?.verified === true;
      if (visitorVerified && typeof upsert?.visitor?.external_user_id === 'string') {
        visitorExternalUserId = upsert.visitor.external_user_id;
      }
      const attrs = upsert?.visitor?.identified_attrs;
      if (attrs && typeof attrs.email === 'string') visitorIdentifiedEmail = attrs.email;
      if (attrs && typeof attrs.email_source === 'string') visitorIdentifiedEmailSource = attrs.email_source;
      visitorIdentifiedName = identifiedNameFromAttrs(attrs);
    }

    // QUOXCHAT-BRUTALOOP: browser-supplied page_url/page_context are confined
    // (URL-shaped only; context fenced as UNVERIFIED), never raw prompt text.
    const { pageInfo, contextInfo } = confineBrowserContext({ page_url, page_context });

    // QC-HOLES staged handoff: while a handoff is requested but no human has
    // replied yet, the AI keeps helping and must not re-escalate or claim a
    // human is present.
    const handoffHoldNote = handoffAwaitingPickup
      ? '\n\nHANDOFF PENDING: the visitor asked for a human and the team has been notified, but nobody has joined yet. Keep helping them yourself in the meantime, be upfront that a teammate will join when available, never pretend to be human, and do NOT call the human_handoff tool again.'
      : '';

    // QC-LINKS: the assistant knows WHERE things live, not just what they
    // are. Curated list only; inventing URLs is worse than no link.
    const siteLinksBlock = widgetSiteLinks
      ? '\n\nSITE LINKS (the only URLs you may share, as markdown links):\n'
        + widgetSiteLinks.map((l) => `- ${l.title}: ${l.url}`).join('\n')
        + '\nWhen the visitor asks for a guide, documentation, pricing, or where to find something, include the most relevant link (at most two) from this list as markdown links. Never invent or modify URLs; if nothing on the list fits, say the docs do not cover it yet.'
      : '';

    // The exact model is chosen by the smart router further down; the label
    // is substituted once it is known (see QC_MODEL_LABEL below).
    const groundingModelLabel = '{{QC_MODEL_LABEL}}';
    const requestCanary = makeCanary();
    const groundingRulesText = buildGroundingRules({
      confidence: knowledge.confidence,
      premises: premiseConversions,
      hasSiteLinks: !!widgetSiteLinks,
      modelLabel: groundingModelLabel,
      discloseModel: groundingCfg.disclose_model !== false,
      caveats: extractCaveats(knowledge.kept.map((c) => c.text)),
      exceptionPremises: buildExceptionPremises(matchedExceptions(extractExceptions(knowledge.kept.map((c) => c.text)), visitorTexts), visitorTexts),
      timezone: widgetTimezone(widgetMeta),
    });
    const ruleLeakSource = `${personaSystemPrompt}\n${groundingRulesText}`;
    let systemPrompt = `${canaryPreamble(requestCanary)}${personaSystemPrompt}
${pageInfo}${contextInfo}${visitorSummary}${ragContext}${handoffHoldNote}${siteLinksBlock}

${groundingRulesText}`;

    // QCX-3.1: emit delegation envelope so the trace shows which persona
    // was picked + why. Always emitted (even on COREY fallback) for
    // complete trail.
    try {
      _storeAuditEnvelope(buildWidgetEnvelope({
        intent: WIDGET_INTENTS.SCENARIO_RUN, // use existing intent with delegation payload
        visitor_id: visitor_id || 'anon',
        widget_id,
        reply_to: scenarioEnv.id,
        payload: {
          delegation: {
            persona_id: delegationDecision.persona_id,
            delegated: delegationDecision.delegated,
            score: delegationDecision.score,
            threshold: delegationDecision.threshold,
            reason: delegationDecision.reason,
            alternatives: delegationDecision.alternatives,
          },
        },
      }));
    } catch { /* non-fatal */ }

    // Build messages
    // QUOXCHAT-BRUTALOOP ITER 1: history is rebuilt from persisted turns.
    // Client-supplied assistant turns are untrusted (a forged "BRUTAL50 is
    // a 50% promotion" turn was confirmed live in wave 1); without server
    // history only the visitor's own turns are kept.
    const messages = builtHistory.messages.map((m) => ({ role: m.role, content: m.content }));

    // QCX-4.4b: resolve visitor attachments scoped to (widget_id, visitor_id).
    // Unknown or mis-scoped ids are silently skipped so we never leak another
    // visitor's file existence. Extracted text prepends the user's message
    // under a header; images are acknowledged but not yet sent to the LLM
    // (provider-specific vision wiring is a later phase).
    const ATTACH_MAX_CHARS = 8000;
    const attachmentIds = Array.isArray(req.body?.attachment_ids) ? req.body.attachment_ids.slice(0, 5) : [];
    const attachmentBlocks = [];
    for (const id of attachmentIds) {
      const rec = _visitorUploadRead(String(id || ''), { widget_id, visitor_id: visitor_id || 'anon' });
      if (!rec) continue;
      if (rec.is_image) {
        attachmentBlocks.push(`VISITOR ATTACHMENT: ${rec.name} (image/${rec.mime.split('/')[1]}, ${rec.size} bytes — image content not yet sent to LLM)`);
        continue;
      }
      const text = rec.extracted_text || '';
      const truncated = text.length > ATTACH_MAX_CHARS;
      const body = truncated ? text.slice(0, ATTACH_MAX_CHARS) + '\n[…truncated…]' : text;
      attachmentBlocks.push(`VISITOR ATTACHMENT: ${rec.name} (${rec.mime}${truncated ? ', truncated' : ''})\n${body}`);
    }
    const userContent = attachmentBlocks.length > 0
      ? `${attachmentBlocks.join('\n\n')}\n\n---\n\n${message}`
      : message;
    messages.push({ role: 'user', content: userContent });

    // Call LLM — CW-12.1 smart routing picks a tier-appropriate model.
    // Widget can override the tier→model map (stored on website_widgets when
    // admin configures it); otherwise we fall back to the provider default.
    const provider = useCompat ? COMPAT_PROVIDER : useGemini ? 'gemini' : useOpenAI ? 'openai' : 'anthropic';

    // QCX-7b — quota gate. Pre-flight read of the current month's usage
    // bucket from auth. 402 (Payment Required) when the cap is hit; the
    // widget surfaces an upgrade prompt rather than silently failing.
    // Skipped for the demo widget + when the service key isn't set.
    // P7: tier + spend facts from auth's usage/current. Defaults are the
    // permissive/legacy behaviour (demo widget, auth unreachable): smart routing
    // on, no spend action. Only a verified Standard plan switches routing off.
    let smartRoutingAllowed = true;
    let budgetDecision = decideBudget(null);
    if (widget_id && widget_id !== 'demo' && process.env.INTERNAL_SERVICE_KEY) {
      let usageVerified = false;
      try {
        const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
        const usageResp = await fetch(
          `${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/usage/current`,
          { headers: { 'x-service-key': process.env.INTERNAL_SERVICE_KEY }, signal: AbortSignal.timeout(2000) },
        );
        if (usageResp.ok) {
          usageVerified = true;
          const usage = await usageResp.json().catch(() => null);
          if (usage?.features && usage.features.smart_routing === false) smartRoutingAllowed = false;
          // QC-BRUTALOOP-W13: plan tool_calls_per_day cap, enforced in executeTool.
          // Always strip any admin-supplied value first; only the plan sets it.
          // 0 = tools disabled on that plan (gated elsewhere), -1 = unlimited.
          if (widgetToolPolicies && 'plan_tool_calls_per_day_cap' in widgetToolPolicies) {
            const { plan_tool_calls_per_day_cap: _drop, ...rest } = widgetToolPolicies;
            widgetToolPolicies = rest;
          }
          const planToolCap = usage?.caps?.tool_calls_per_day;
          if (Number.isFinite(planToolCap) && planToolCap > 0) {
            widgetToolPolicies = { ...(widgetToolPolicies || {}), plan_tool_calls_per_day_cap: planToolCap };
          }
          budgetDecision = decideBudget(usage?.budget);
          if (budgetDecision.stop) {
            console.warn(`[QuoxChat] widget ${widget_id} monthly LLM budget reached; budget_action=${budgetDecision.action}, not answering`);
            return respondErr(429, {
              success: false,
              response: budgetDecision.message,
              error: 'monthly_budget_exceeded',
              ...(budgetDecision.hide ? { hide_widget: true } : {}),
            });
          }
          if (usage?.exceeded?.conversations) {
            return respondOk({
              success: false,
              response: "This chat has reached its monthly message limit. Please come back next month or contact the site owner.",
              error: 'quota_exceeded',
              quota: {
                cap: usage?.caps?.conversations,
                used: usage?.conversations,
                plan: usage?.plan,
              },
            });
          }

          // QCL-SECURITY P1-1 — per-widget LLM budget cap. SAFE DEFAULT: OFF.
          // usage.caps.monthly_requests is only non-null when the widget has
          // an *explicit* embed_config_json.llm_budget.monthly_request_cap
          // configured (see services/auth/routes/widgets.js usage/current).
          // Every existing widget — including the live support widget — has
          // never set this, so this block is a guaranteed no-op for them.
          // Unlike the legacy conversations check above (200 + error body,
          // kept for back-compat), this returns a real HTTP 429.
          if (usage?.exceeded?.monthly_requests) {
            return respondErr(429, {
              success: false,
              response: "This chat has reached its configured monthly usage limit. Please come back next month or contact the site owner.",
              error: 'budget_exceeded',
              quota: {
                cap: usage?.caps?.monthly_requests,
                used: usage?.requests,
                plan: usage?.plan,
              },
            });
          }

          // QCL-SECURITY P1-1 — optional per-(widget, visitor, day) sub-cap.
          // Also safe-default OFF: usage.visitor_daily_request_cap is null
          // unless the widget configured it. Enforced collector-side
          // (in-process quoxchatDailyCapStore) since it needs a per-visitor
          // key the monthly auth-side bucket doesn't carry.
          const visitorDailyCap = usage?.visitor_daily_request_cap;
          if (Number.isFinite(visitorDailyCap) && visitorDailyCap > 0) {
            // Wave 14: a missing / "anon" visitor_id used to skip the cap entirely
            // (omit the id, bypass the limit). Key those on an IP hash, the same
            // address the rate limiter uses for anonymous callers.
            const anonVisitor = !visitor_id || visitor_id === 'anon';
            const capIp = req.ip || req.connection?.remoteAddress || 'unknown';
            const capKey = anonVisitor
              ? `${widget_id}:ip:${crypto.createHash('sha256').update(String(capIp)).digest('hex').slice(0, 16)}`
              : `${widget_id}:${visitor_id}`;
            const usedToday = dailyCapStore.peek(capKey);
            if (usedToday >= visitorDailyCap) {
              return respondErr(429, {
                success: false,
                response: "You've reached today's message limit for this chat. Please try again tomorrow.",
                error: 'visitor_budget_exceeded',
                quota: { cap: visitorDailyCap, used: usedToday },
              });
            }
            dailyCapStore.increment(capKey);
          }
        }
      } catch { /* handled below — usageVerified stays false */ }

      // SECURITY AUDIT FIX (finding #1, CRITICAL) — the quota check above
      // used to fail open unconditionally on any fetch error/timeout/non-2xx,
      // which is a denial-of-wallet hole for a widget that DID configure a
      // hard monthly cap. Fail closed ONLY in that specific case: a hard cap
      // is configured (widgetHardBudgetCap, read locally above, independent
      // of the fetch that just failed) AND we could not verify usage against
      // it. Widgets with no cap configured (the default for every widget
      // today, including the live support widget) see zero behaviour change
      // — this branch is a guaranteed no-op for them because
      // widgetHardBudgetCap stays null.
      if (!usageVerified && widgetHardBudgetCap) {
        return respondErr(429, {
          success: false,
          response: "This chat has reached its configured monthly usage limit. Please come back next month or contact the site owner.",
          error: 'budget_exceeded',
          quota: { cap: widgetHardBudgetCap, used: null, plan: null },
        });
      }
    }

    const allWidgetTools = (widget_id && widget_id !== 'demo' ? await fetchWidgetTools(widget_id) : []);
    const widgetTools = allWidgetTools
      .filter((t) => !(t && t.builtin_kind === 'email_transcript'
        && !transcriptDeliverable({ humanVerified, visitorVerified, emailSource: visitorIdentifiedEmailSource })));
    // email_transcript was offered by the widget but filtered out for this
    // visitor: the model must not improvise ("request it from the widget").
    const transcriptFilteredOut = allWidgetTools.length !== widgetTools.length
      && allWidgetTools.some((t) => t && t.builtin_kind === 'email_transcript');
    const { classifyIntent, pickModelForTier } = require('../lib/quoxchatSmartRouter');
    let routeDecision = classifyIntent(message, { toolNames: widgetTools.map(t => t.name) });
    // Smart LLM routing is a published Professional feature: Standard answers on
    // the provider's default (mid) tier. A spent budget with action=downgrade
    // forces the cheapest tier on any plan.
    if (budgetDecision.downgrade) routeDecision = { tier: 'simple', reason: 'budget_downgrade' };
    else if (!smartRoutingAllowed) routeDecision = { tier: 'mid', reason: 'standard_plan_default_model' };
    // widget.model_tier_map_json would be parsed here when admin configures it
    // — for now we use pure provider defaults.
    // One configured model serves every tier for a widget-level endpoint.
    const modelFor = (tier, p) => (p === COMPAT_PROVIDER && compatConfigured ? compatParsed.model : pickModelForTier(tier, null, p));
    const selectedModel = modelFor(routeDecision.tier, provider);
    const providerLabel = provider === COMPAT_PROVIDER ? SELF_HOSTED_LABEL : provider === 'openai' ? 'OpenAI' : provider === 'gemini' ? 'Google Gemini' : 'Anthropic';
    // Action ledger (trusted server record of what tools did earlier in this
    // conversation), transcript-unavailable truth and the demo tool hint go in
    // BEFORE the template is captured so provider failover sees them too.
    const actionLedger = (serverHistory && serverHistory.ok && Array.isArray(serverHistory.actions)) ? serverHistory.actions : null;
    systemPrompt += buildActionLedgerBlock(actionLedger)
      + (transcriptFilteredOut ? TRANSCRIPT_UNAVAILABLE_NOTE : '')
      + buildDemoToolHint(widgetTools);
    // W5: rule 7 ("cannot transfer to a person") is false when the handoff tool is live.
    if (widgetTools.some((t) => t && (t.builtin_kind === 'human_handoff' || t.name === 'human_handoff'))) {
      systemPrompt = applyHandoffRule(systemPrompt, true);
    }
    // Wave 9: no booking tool means no booking questions.
    const bookingToolActive = hasBookingTool(widgetTools);
    if (!bookingToolActive) systemPrompt += `\n${NO_BOOKING_RULE}`;
    const systemPromptTemplate = systemPrompt;
    systemPrompt = systemPrompt.split('{{QC_MODEL_LABEL}}').join(`${selectedModel} (${providerLabel})`);
    // The provider/model that actually answered (failover may change them).
    let activeProvider = provider;
    let activeModel = selectedModel;
    let activeApiKey = apiKey;
    console.log(`[QuoxChat] Calling ${selectedModel} — tier=${routeDecision.tier} (${routeDecision.reason}) — ${messages.length} msgs, visitor=${visitor_id || 'anon'} at +${Date.now() - startMs}ms`);

    let responseText, inputTokens, outputTokens;
    let toolCalls = null; // QCX-1.1: populated by Anthropic + OpenAI paths.

    // QCX-1.1: tool invocation is per-widget; ensure a conversation so builtin
    // executors (lead_capture/human_handoff) have a conversation_id to attach
    // side effects to. Shared across all three provider paths.
    // UX HOLES FIX: while handed off, reuse the handed-off conversation for
    // this turn's side effects and persistence: ensureConversation only
    // matches status='active' and would fork a fresh conversation.
    let ensuredConversationId = handedOffConversationId;
    // QC W17: always (not only for tool widgets): the conversation must exist
    // before the model call so a timeout/llm_error still leaves a conversation.
    if (!ensuredConversationId) {
      ensuredConversationId = await ensureConversation(widget_id, visitor_id || 'anon');
    }
    turnCtx.conversation_id = ensuredConversationId || null;
    turnCtx.injectionScore = injectionScore;

    // QCX-2.2: Layer 2 — session. Conv id attaches side-effects (leads,
    // handoffs). Warn if we have tools but failed to secure a conv id.
    emitLayer(
      'session',
      (widgetTools.length > 0 && !ensuredConversationId) ? 'warn' : 'ok',
      ensuredConversationId ? `conv=${ensuredConversationId}` : (widgetTools.length > 0 ? 'tools_present_but_no_conversation' : 'no_conversation_needed'),
      null,
      { conversation_id: ensuredConversationId, n_tools: widgetTools.length },
    );

    // QCX-2.2: Layer 6 — control. Smart router decided the tier + model
    // ahead of the LLM call. Verdict is always ok (router always picks
    // something) but reason surfaces which tier was chosen + why.
    emitLayer(
      'control',
      'ok',
      `tier=${routeDecision.tier} model=${selectedModel}`,
      null,
      { tier: routeDecision.tier, model: selectedModel, route_reason: routeDecision.reason, provider },
    );
    const toolResultTexts = [];
    streamGround.toolTexts = toolResultTexts; // tool output is support mid-stream too
    // QUOXCHAT-BRUTALOOP: tools that need a backend-verifiable identity
    // signature (HostNode actions) get a signing FUNCTION, never the secret;
    // a function cannot leak into JSON logs, envelopes or persisted context.
    const _identitySecret = typeof widgetMeta?.identity_secret === 'string' && widgetMeta.identity_secret ? widgetMeta.identity_secret : null;
    const toolLoopContext = {
      signIdentity: _identitySecret ? (v) => crypto.createHmac('sha256', _identitySecret).update(String(v)).digest('hex') : undefined,
      toolResultTexts,
      visitor_id: visitor_id || 'anon',
      // Wave 9: dry-run side effects, honoured ONLY for a valid service key.
      simulation: isSimulationRequest(req),
      page_url: page_url || null,
      conversation_id: ensuredConversationId,
      // Wave 8: the visitor's current + recent messages, so the handoff never asks for an email they already typed.
      visitorMessages: [message, ...(Array.isArray(builtHistory) ? builtHistory : []).filter((h) => h && h.role === 'user').map((h) => (typeof h.content === 'string' ? h.content : '')).slice(-4)].filter((m) => typeof m === 'string' && m),
      // Wave 6 D9: lets the handoff confirmation be honest about nobody being online.
      availability: widgetMeta ? evaluateAvailability(widgetMeta) : null,
      // QCL-SECURITY P1-5(d)/(c)
      verified: visitorVerified,
      // QCX-ACTIONS P1 — HMAC-verified id for identity_param injection.
      external_user_id: visitorExternalUserId,
      identified_email: visitorIdentifiedEmail,
      identified_email_source: visitorIdentifiedEmailSource,
      // QUOXCHAT-PRO visitor name: forwarded by the human_handoff executor
      // so auth stamps the conversation + personalises the inbox title.
      identified_name: visitorIdentifiedName,
      // CAPTCHA #127 — undefined when bot_protection isn't configured for
      // this widget (no-op); bool verdict otherwise.
      human_verified: humanVerified,
      // QUOXCHAT-BRUTALOOP wave 5: model-initiated handoff needs a visitor ask.
      handoffAllowed: modelHandoffAllowed({
        message,
        recentUserMessages: (Array.isArray(builtHistory) ? builtHistory : []).filter((h) => h && h.role === 'user').map((h) => (typeof h.content === 'string' ? h.content : '')).slice(-2),
      }),
    };

    // QUOXCHAT-PRO — HANDOFF INTENT BELT. When the LLM path fails (provider
    // outage, 429, mid-loop error) every widget tool silently vanishes for
    // this turn — including human_handoff — and the visitor gets a canned
    // apology. If the message is an EXPLICIT ask for a human (conservative
    // pattern set, lib/quoxchatHandoffIntent.js) and the widget has the
    // human_handoff builtin enabled, execute the handoff directly and let the
    // normal post-turn machinery (audit envelopes, persist, webhooks, org
    // alerts, Matrix room provisioning) run as if the LLM had called the
    // tool. Returns { responseText, toolCalls } on trigger, null otherwise.
    const runHandoffBelt = async (beltReason) => {
      try {
        const { shouldTriggerHandoffBelt } = require('../lib/quoxchatHandoffIntent');
        const belt = shouldTriggerHandoffBelt({ message, tools: widgetTools });
        if (!belt) return null;
        const beltInput = { reason: `visitor asked for a human (server-side intent belt, llm_path=${beltReason})`, priority: 'high' };
        const beltResult = await executeTool({
          widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
          tool: belt.tool,
          input: beltInput,
          context: toolLoopContext,
        });
        if (!beltResult || beltResult.ok !== true) {
          console.warn(`[QuoxChat] HANDOFF-BELT executor failed (${beltReason}): ${beltResult?.error || 'unknown'}`);
          return null;
        }
        // Distinct log line — greppable, never emitted by the LLM tool loop.
        console.log(`[QuoxChat] HANDOFF-BELT triggered — widget=${widget_id} visitor=${visitor_id || 'anon'} llm_path=${beltReason} pattern="${belt.pattern}"`);
        recordToolUsage(widget_id, belt.tool.id, true, visitor_id, toolLoopContext?.simulation);
        return {
          responseText: beltResult.result?.message || 'Handing you over to a human, one of our team will pick up shortly.',
          toolCalls: [{
            tool_id: belt.tool.id,
            name: belt.tool.name || 'human_handoff',
            input: beltInput,
            ok: true,
            error: null,
            ts: new Date().toISOString(),
            result_message: (typeof beltResult.result?.message === 'string') ? beltResult.result.message : null,
            belt: 'handoff_intent',
          }],
        };
      } catch (beltErr) {
        console.warn('[QuoxChat] HANDOFF-BELT error (non-fatal):', beltErr?.message);
        return null;
      }
    };

    // ── CHIP DETERMINISM (prod .60 walkthrough bug) ──
    // Widget quick-action chips used to insert-and-send a natural-language
    // prompt and leave tool invocation to LLM discretion; the LLM sometimes
    // executed the tool but narrated a RAG-retrieved FAQ instead of the
    // confirmation. When the send carries `action` naming an ENABLED builtin
    // for this widget, execute the tool directly (same persist/audit/alert
    // path as an LLM-invoked call, since it lands in `toolCalls`) and reply
    // with the executor's own confirmation, skipping the LLM entirely.
    // Unknown/disabled actions, and executors that decline (e.g. lead
    // builtins that still need an email collected), fall back to the normal
    // LLM flow.
    let chipActionHandled = false;
    // needs_input coverage fix — a data-collection form resubmit (action in
    // FORM_RESUBMIT_BUILTINS with form-collected action_input) takes the
    // same direct-execution path as a quick-action chip.
    const isFormResubmit = typeof action === 'string' && FORM_RESUBMIT_BUILTINS.has(action)
      && action_input && typeof action_input === 'object';
    if (typeof action === 'string' && action && (WIDGET_ACTION_CHIPS[action] || isFormResubmit)) {
      const chipTool = widgetTools.find((t) => t && t.tool_type === 'builtin' && t.builtin_kind === action);
      if (chipTool) {
        try {
          // UX HOLES FIX: while handed off there is no LLM turn available to
          // collect the lead email, so thread the visitor's identified email
          // into the chip input when we already know it. Normal-path chip
          // sends keep the empty input (the LLM flow collects details).
          // needs_input fix — action_input carries values the widget just
          // collected via its inline data-collection form (renderInlineForm);
          // it wins over the handed-off email fallback when both are present.
          const chipInput = action === 'human_handoff'
            ? { reason: 'visitor clicked the "Talk to a human" quick action', priority: 'high' }
            : {
                ...(handedOffConversationId && visitorIdentifiedEmail ? { email: visitorIdentifiedEmail } : {}),
                ...(action_input && typeof action_input === 'object' ? action_input : {}),
              };
          const chipResult = await executeTool({
            widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
            tool: chipTool,
            input: chipInput,
            context: toolLoopContext,
          });
          if (chipResult && chipResult.ok === true) {
            recordToolUsage(widget_id, chipTool.id, true, visitor_id, toolLoopContext?.simulation);
            // Distinct log line — greppable, never emitted by the LLM tool loop.
            console.log(`[QuoxChat] CHIP-ACTION executed directly — widget=${widget_id} visitor=${visitor_id || 'anon'} action=${action}`);
            if (onStream) {
              try {
                onStream({ type: 'tool_start', name: chipTool.name || action, input: chipInput });
                onStream({ type: 'tool_result', name: chipTool.name || action, ok: true, error: null });
              } catch { /* non-fatal */ }
            }
            responseText = (typeof chipResult.message === 'string' && chipResult.message)
              || (typeof chipResult.result?.message === 'string' && chipResult.result.message)
              || 'Done. Is there anything else I can help with?';
            inputTokens = 0;
            outputTokens = 0;
            toolCalls = [{
              tool_id: chipTool.id,
              name: chipTool.name || action,
              input: chipInput,
              ok: true,
              error: null,
              ts: new Date().toISOString(),
              result_message: (typeof chipResult.result?.message === 'string') ? chipResult.result.message : null,
              // needs_input fix — present when the executor still needs a
              // required field; the widget renders an inline form for it.
              needs_input: chipResult.needs_input || null,
              chip: 'action',
              ...summariseOutcome(chipResult),
            }];
            chipActionHandled = true;
          } else {
            console.warn(`[QuoxChat] CHIP-ACTION executor declined (${chipResult?.error || 'unknown'}) — falling back to LLM flow for action=${action}`);
          }
        } catch (chipErr) {
          console.warn('[QuoxChat] CHIP-ACTION error (non-fatal, falling back to LLM):', chipErr?.message);
        }
      }
    }

    // UX HOLES FIX: handed off but the chip did NOT produce a deterministic
    // reply (tool missing, executor declined, or errored): never fall
    // through to the LLM while a human owns the chat. Persist + ack exactly
    // like a normal handed-off message instead.
    if (handedOffConversationId && !chipActionHandled && !handoffAwaitingPickup) {
      const st = await settleHandoffState(handedOffConversationId, message, handoffRelayPromise);
      return respondOk({
        success: true,
        handed_off: true,
        operator_joined: true,
        response: handoffStateAck(st, handedOffConversationId, true),
        conversation_id: handedOffConversationId,
        handoff_state: handoffStateLabel(st),
      });
    }

    // QUOXCHAT-BRUTALOOP: provider failover (promised by the Standard tier,
    // absent until now). Only before any tool ran or token streamed.
    // Runner per provider; the compat runner binds the widget's endpoint.
    const loopFnFor = (p) => (p === COMPAT_PROVIDER
      ? (args) => runOpenAIToolLoop({ ...args, compat: compatRuntime })
      : p === 'openai' ? runOpenAIToolLoop : p === 'gemini' ? runGeminiToolLoop : runAnthropicToolLoop);
    const failoverKeys = { openai: openaiKey, anthropic: anthropicKey, gemini: geminiKey, [COMPAT_PROVIDER]: compatKeyMarker };
    const tryProviderFailover = async (failedErr) => {
      if (failedErr?.code === 'deadline_exceeded' || !requestDeadline.hasBudgetFor()) return null;
      if (isRetryableProviderError(failedErr)) providerCooldowns.mark(widget_id, provider);
      if (!mayFailOver(failedErr, { toolExecutions: toolLoopContext.toolExecutions || 0, streamedChars: streamedCharsTotal })) return null;
      const order = failoverOrder({ primary: provider, keys: failoverKeys, enabled: failoverPolicy.enabled, order: failoverPolicy.order });
      let lastErr = failedErr;
      for (const p of order.slice(1)) {
        const fn = loopFnFor(p);
        const model = modelFor(routeDecision.tier, p);
        const label = p === COMPAT_PROVIDER ? SELF_HOSTED_LABEL : p === 'openai' ? 'OpenAI' : p === 'gemini' ? 'Google Gemini' : 'Anthropic';
        try {
          const r = await fn({
            apiKey: p === COMPAT_PROVIDER ? compatKey : failoverKeys[p],
            model,
            systemPrompt: systemPromptTemplate.split('{{QC_MODEL_LABEL}}').join(`${model} (${label})`),
            messages,
            tools: widgetTools,
            widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
            context: toolLoopContext,
            onStream,
          });
          emitLayer('cognition', 'warn', `provider_failover ${provider}->${p}`, null, { from: provider, to: p, model, error_status: lastErr?.status || null, error: String(lastErr?.message || '').slice(0, 120) });
          activeProvider = p; activeModel = model; activeApiKey = p === COMPAT_PROVIDER ? compatKey : failoverKeys[p];
          return r;
        } catch (e2) {
          console.warn(`[QuoxChat] failover ${p} failed: ${e2.status || '-'} ${e2.message}`);
          if (isRetryableProviderError(e2)) providerCooldowns.mark(widget_id, p);
          lastErr = e2;
          if (!mayFailOver(e2, { toolExecutions: toolLoopContext.toolExecutions || 0, streamedChars: streamedCharsTotal })) break;
        }
      }
      return null;
    };

    // QUOXCHAT-BRUTALOOP: "which model are you?" is answered from the active
    // model label in code (when the widget discloses the model), never left
    // to the LLM to guess. No LLM turn, no claim verification: nothing a model
    // wrote reaches the visitor.
    let deterministicIdentity = false;
    if (!chipActionHandled && !handedOffConversationId) {
      const identityReply = modelIdentityReply({
        message,
        modelLabel: activeProvider === COMPAT_PROVIDER ? compatLabelFor(activeModel) : `${activeModel} (${providerLabel})`,
        discloseModel: groundingCfg.disclose_model !== false,
      });
      if (identityReply) {
        chipActionHandled = true;
        deterministicIdentity = true;
        responseText = identityReply;
        inputTokens = 0;
        outputTokens = 0;
      } else if (transcriptFilteredOut && asksForTranscript(message)) {
        // Wave 10 #9: emailing is withheld for this visitor; say that, do
        // not let the model decline with an unrelated sentence.
        chipActionHandled = true;
        deterministicIdentity = true;
        responseText = TRANSCRIPT_WITHHELD_REPLY;
        inputTokens = 0;
        outputTokens = 0;
      } else if (shouldReportRetrievalFailure({ retrievalError, keptCount: knowledge.kept.length, message })) {
        // Wave 10 #5: the lookup failed (dense twice, lexical empty). Say so;
        // never let the model answer "I do not have information".
        chipActionHandled = true;
        deterministicIdentity = true;
        responseText = RETRIEVAL_FAILED_REPLY;
        inputTokens = 0;
        outputTokens = 0;
        retrievalFailedReplied = true;
      }
    }

    // QC-BRUTALOOP-W14: every provider failure is persisted (visitor turn plus an
    // error-outcome assistant row) and a timeout gets a grounded "took too long".
    const failTurn = async (err) => {
      const unavailable = providerUnavailableReply(err);
      const timedOut = !unavailable && (err?.code === 'deadline_exceeded' || err?.name === 'TimeoutError' || (err?.name === 'AbortError' && err?.code !== 'client_aborted'));
      const out = unavailable
        ? { response: unavailable.response, error: unavailable.error }
        : timedOut
          ? { response: DEADLINE_FALLBACK_TEXT, error: 'timeout' }
          : { response: "The assistant hit a temporary problem answering that. Please try again in a moment.", error: 'llm_error' };
      const cid = await persistFailedTurn(out.error, out.response);
      return respondOk({ success: false, response: out.response, error: out.error, ...(cid ? { conversation_id: cid } : {}) });
    };

    if (chipActionHandled) {
      // Deterministic reply already assembled — no LLM turn for this send.
    } else if (useGemini) {
      // QCX-1.2: Gemini functionDeclarations loop (previously plain-text —
      // tools were silently dead on this provider).
      try {
        const loopResult = await runGeminiToolLoop({
          apiKey,
          model: selectedModel,
          systemPrompt,
          messages,
          tools: widgetTools,
          widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
          context: toolLoopContext,
          onStream,
        });
        responseText = loopResult.text;
        inputTokens = loopResult.inputTokens;
        outputTokens = loopResult.outputTokens;
        toolCalls = loopResult.toolCalls;
      } catch (err) {
        console.error(`[QuoxChat] Gemini error: ${err.status || '-'} — ${err.message}`);
        const fo = await tryProviderFailover(err);
        if (fo) { responseText = fo.text; inputTokens = fo.inputTokens; outputTokens = fo.outputTokens; toolCalls = fo.toolCalls; }
        const belt = fo ? null : await runHandoffBelt(`gemini_${err.status || 'error'}`);
        if (belt) {
          responseText = belt.responseText; inputTokens = 0; outputTokens = 0; toolCalls = belt.toolCalls;
        } else if (!fo) {
          return failTurn(err);
        }
      }

    } else if (useOpenAI || useCompat) {
      // QCX-1.1: OpenAI function-calling loop (previously plain-text — tools
      // were silently dead on this provider). Also serves the widget-level
      // OpenAI-compatible endpoint (useCompat), same protocol.
      try {
        const loopResult = await runOpenAIToolLoop({
          compat: useCompat ? compatRuntime : undefined,
          apiKey,
          model: selectedModel,
          systemPrompt,
          messages,
          tools: widgetTools,
          widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
          context: toolLoopContext,
          onStream,
        });
        if (loopResult.toolsUnsupported) {
          emitLayer('cognition', 'warn', 'compat_tools_unsupported', null, { model: selectedModel, note: 'endpoint rejected tools; answered without widget tools' });
        }
        responseText = loopResult.text;
        inputTokens = loopResult.inputTokens;
        outputTokens = loopResult.outputTokens;
        toolCalls = loopResult.toolCalls;
      } catch (err) {
        console.error(`[QuoxChat] ${useCompat ? 'OpenAI-compatible' : 'OpenAI'} error: ${err.status || '-'} — ${err.code || ''} ${err.message}`);
        const fo = await tryProviderFailover(err);
        if (fo) { responseText = fo.text; inputTokens = fo.inputTokens; outputTokens = fo.outputTokens; toolCalls = fo.toolCalls; }
        const belt = fo ? null : await runHandoffBelt(`${useCompat ? 'compat' : 'openai'}_${err.status || 'error'}`);
        if (belt) {
          responseText = belt.responseText; inputTokens = 0; outputTokens = 0; toolCalls = belt.toolCalls;
        } else if (!fo) {
          return failTurn(err);
        }
      }

    } else {
      try {
        const loopResult = await runAnthropicToolLoop({
          apiKey,
          model: selectedModel,
          systemPrompt,
          messages,
          tools: widgetTools,
          widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
          context: toolLoopContext,
          onStream,
        });
        responseText = loopResult.text;
        inputTokens = loopResult.inputTokens;
        outputTokens = loopResult.outputTokens;
        toolCalls = loopResult.toolCalls;
      } catch (err) {
        console.error(`[QuoxChat] Anthropic error: ${err.status || '-'} — ${err.message}`);
        const fo = await tryProviderFailover(err);
        if (fo) { responseText = fo.text; inputTokens = fo.inputTokens; outputTokens = fo.outputTokens; toolCalls = fo.toolCalls; }
        const belt = fo ? null : await runHandoffBelt(`anthropic_${err.status || 'error'}`);
        if (belt) {
          responseText = belt.responseText; inputTokens = 0; outputTokens = 0; toolCalls = belt.toolCalls;
        } else if (!fo) {
          return failTurn(err);
        }
      }
    }

    // ── HANDOFF-BELT, post-turn backstop (QCFT action-routing fix) ──
    // The catch-block belts above only cover LLM-path FAILURES. A subtler
    // failure showed up in eval: the LLM turn succeeds, the visitor's
    // message is an explicit ask for a human, and the model NARRATES a
    // handoff ("I've notified the team") without ever calling the tool, so
    // nothing actually escalates. If the conservative intent patterns match
    // and this turn produced no successful human_handoff call, execute the
    // handoff now through the same belt machinery; reply determinism below
    // then replaces the fabricated narration with the executor's real
    // confirmation. Skipped while already handed off (the gate upstream
    // owns that state) and when the chip path already handled the turn.
    if (!chipActionHandled && !handedOffConversationId) {
      const hadHandoffCall = Array.isArray(toolCalls)
        && toolCalls.some((tc) => tc && tc.ok === true && tc.name === 'human_handoff');
      if (!hadHandoffCall) {
        const postBelt = await runHandoffBelt('llm_no_tool_call');
        if (postBelt) {
          toolCalls = [...(Array.isArray(toolCalls) ? toolCalls : []), ...postBelt.toolCalls];
        }
      }
    }

    // ── REPLY DETERMINISM (prod .60 walkthrough bug) ──
    // When an action builtin (human_handoff / book_appointment /
    // schedule_demo / leave_message) executed successfully this turn, the
    // executor's confirmation IS the visitor-facing reply: override (handoff)
    // or prepend (lead actions) it over whatever the LLM narrated, so a
    // visitor who asked for a human never gets a RAG FAQ recital instead of
    // "I have flagged your request". Applies to every provider path, the
    // belt, and the chip path (the latter two are already deterministic, so
    // this is a no-op for them).
    responseText = applyActionReplyDeterminism(responseText, toolCalls);
    // Wave 7: a follow-up "did you save my details?" is answered from the ledger.
    if (!(Array.isArray(toolCalls) && toolCalls.some((tc) => tc && tc.ok === true && tc.result_message))) {
      const fromLedger = ledgerConfirmationReply(message, actionLedger);
      if (fromLedger) responseText = fromLedger;
    }

    // QCPRO voice rule: server-side em-dash scrub on the assembled reply.
    // responseText feeds every downstream consumer (final response frame,
    // persist-message, webhook fan-out, handover summaries), so one scrub
    // here covers them all; the streaming path applies the same scrub at
    // the stream redactor's emit boundary so wire and transcript agree.
    responseText = scrubEmDashes(responseText);

    // Remember a handoff made this turn (marker + time) so a later lookup
    // failure is only reported as "with our team" for a real handoff, and a
    // waiting visitor can be told how long ago they asked.
    if (Array.isArray(toolCalls) && toolCalls.some((tc) => tc && tc.ok === true && tc.name === 'human_handoff')) {
      handoffState.markHandedOff(widget_id, visitor_id, { conversationId: ensuredConversationId, at: Date.now() });
    }

    // ── ACTION HONESTY GATE (deterministic) ──
    // A reply may only claim a completed action (booked / noted / sent /
    // passed on) when this turn's tool results or the conversation's action
    // ledger show it. Otherwise the sentence becomes an honest offer.
    try {
      const honest = enforceActionHonesty({ text: responseText, toolCalls, ledger: actionLedger });
      if (honest.rewritten.length > 0) {
        console.warn(`[QuoxChat] ACTION-HONESTY rewrote unsupported action claim(s): ${honest.rewritten.join(',')} widget=${widget_id}`);
        responseText = honest.text;
      }
    } catch (honestyErr) {
      console.warn('[QuoxChat] action honesty gate error (non-fatal):', honestyErr.message);
    }

    // ── QUOXCHAT-BRUTALOOP ITER 1: post-generation grounding gate ──
    // Enforced in code, not asked for in the prompt. (1) every URL must be on
    // the widget's site_links or appear verbatim in this turn's knowledge or
    // tool output; (2) money / storage / percent / duration figures must
    // appear in that support. A figure miss gets ONE corrective regeneration
    // (no tools, never when an action ran this turn), then a sentence strip.
    // Wave 1 proved 23+ invented URLs and false-premise prices on both
    // deployments; this is the gate that makes them unable to reach a visitor.
    let reportedConfidence = knowledge.confidence;
    let groundingVerdict = { links_removed: [], unsupported_figures: [], corrected: false, stripped: false, retrieval_error: retrievalError || null, ...degradedRetrieval(retrievalError, denseResult.detail), ...(retrievalFailedReplied ? { withheld: true } : {}) };
    if (typeof responseText === 'string') responseText = stripKnowledgeLabels(responseText);
    try {
      const actionRan = Array.isArray(toolCalls) && toolCalls.some((tc) => tc && (tc.result_message || tc.needs_input));
      // Links + labels are enforced on EVERY reply, including after an action
      // ran (Codex enum: a handoff reply carried an unsupported URL). Only the
      // corrective regeneration is skipped after an action: re-running the
      // model there could repeat a side effect.
      if (_groundingFaultForTest) throw new Error('injected grounding fault');
      if (typeof responseText === 'string' && responseText && !deterministicIdentity) {
        const supportTexts = [
          ...knowledge.kept.map((c) => c.text),
          ...(toolLoopContext.toolResultTexts || []),
        ];
        const allowedUrls = buildAllowedUrls({ siteLinks: widgetSiteLinks, chunks: knowledge.kept, extraTexts: toolLoopContext.toolResultTexts });
        const gate = (text) => {
          const linked = enforceLinks(stripKnowledgeLabels(text), allowedUrls);
          // Wave 6: a negative availability claim with no support in knowledge
          // becomes a neutral abstain (deterministic; the verifier prompt alone
          // let 3 invented negatives through).
          const neg = stripUnsupportedNegatives(linked.text, supportTexts, { protectedTexts: (Array.isArray(toolCalls) ? toolCalls : []).map((tc) => tc && tc.result_message).filter((t) => typeof t === 'string' && t.trim()) });
          if (neg.replaced.length > 0) groundingVerdict.negatives_replaced = [...(groundingVerdict.negatives_replaced || []), ...neg.replaced];
          // Wave 8: a weekday stated next to a date is checked against the real
          // calendar and corrected in place (deterministic, no model call).
          const wk = correctWeekdays(neg.text, new Date(), widgetTimezone(widgetMeta));
          if (wk.corrected.length > 0) groundingVerdict.weekday_corrected = [...(groundingVerdict.weekday_corrected || []), ...wk.corrected];
          // Wave 8: on an allergy turn, safety/absence assertions are removed and
          // the business's own allergy guidance (or a fixed fallback) is given.
          let wkText = wk.text;
          if (!bookingToolActive) {
            const bk = stripBookingOffers(wkText, { bookingRoute: findBookingRoute(supportTexts), protectedTexts: (Array.isArray(toolCalls) ? toolCalls : []).map((tc) => tc && tc.result_message).filter((t) => typeof t === 'string' && t.trim()) });
            if (bk !== wkText) groundingVerdict.booking_offer_stripped = true;
            wkText = bk;
          }
          const prevAssistant = [...((builtHistory && builtHistory.messages) || [])].reverse().find((m) => m && m.role === 'assistant');
          const cf = carryForwardLimit({ answer: wkText, previousAssistant: prevAssistant && typeof prevAssistant.content === 'string' ? prevAssistant.content : '', message });
          if (cf.carried) { groundingVerdict.limit_carried = true; wkText = cf.text; }
          const tw = applyTimeWindowGuard(wkText, { question: message, knowledgeTexts: supportTexts });
          if (tw.applied) { groundingVerdict.time_window_guard = tw.qualifier; wkText = tw.text; }
          const on = openNowPlan ? { applied: false } : applyOpenNowGuard(wkText, { now: new Date(), tz: widgetTimezone(widgetMeta), knowledgeTexts: supportTexts });
          if (on.applied) { groundingVerdict.open_now_guard = true; wkText = on.text; }
          if (openNowPlan) { const onp = enforceOpenNow(wkText, openNowPlan); if (onp.changed) { groundingVerdict.open_now_subject = openNowPlan.subject; wkText = onp.text; } }
          const dw = applyDateWindowGuard(wkText, { visitorTexts: dateVisitorTexts, knowledgeTexts: supportTexts, now: new Date(), tz: widgetTimezone(widgetMeta) });
          if (dw.applied) { groundingVerdict.date_window_guard = true; groundingVerdict.date_window_contradicted = dw.contradicted; wkText = dw.text; }
          if (validityPlan) { const vg = enforceValidity(wkText, validityPlan); if (vg.changed) { groundingVerdict.date_window_guard = true; groundingVerdict.validity_enforced = validityPlan.expired ? 'expired' : 'valid'; wkText = vg.text; } }
          const al = applyAllergyGuard(wkText, { visitorTexts, knowledgeTexts: supportTexts });
          if (al.guard) groundingVerdict.allergy_guard = { removed: [...((groundingVerdict.allergy_guard || {}).removed || []), ...al.removed], source: al.source };
          const em = applyEmergencyGuard(al.text, { visitorTexts, knowledgeTexts: supportTexts });
          if (em.guard) groundingVerdict.emergency_guard = { number: em.number };
          const spanBad = spanningProducts(em.text, stayPlan);
          if (spanBad.length) groundingVerdict.season_span_product = spanBad;
          // Wave 14: a figure stated for a window ("within 10 working days") is not
          // supported "after 10 working days"; a figure with an exception clause
          // ("free for lamps, wipers and number plates") is not quoted for an excepted item.
          const win = stripOutsideWindowFigures(em.text, supportTexts);
          if (win.changed) groundingVerdict.outside_window_figures = [...(groundingVerdict.outside_window_figures || []), ...win.removed];
          const exc = enforceExceptions(win.text, matchedExceptions(extractExceptions(supportTexts), visitorTexts), visitorTexts);
          if (exc.violated) groundingVerdict.exception_enforced = true;
          const bt = enforceBlockTariff(exc.text, blockTariffPlan);
          if (bt.changed) groundingVerdict.block_tariff_enforced = true;
          const elg = enforceEligibility(bt.text, eligibilityPlan, supportTexts);
          if (elg.changed) groundingVerdict.eligibility_enforced = true;
          const ddl = enforceDeadline(elg.text, deadlinePlanList, { now: new Date(), tz: widgetTimezone(widgetMeta) });
          if (ddl.changed) groundingVerdict.deadline_enforced = true;
          const pf = enforcePriceCorrections(ddl.text, priceFixes);
          if (pf.changed) groundingVerdict.price_premise_corrected = true;
          const dfc = completeDiscountFigure(pf.text, { visitorTexts, knowledgeTexts: supportTexts });
          if (dfc.changed) groundingVerdict.discount_figure_completed = true;
          const yn = stripConditionalYesNo(dfc.text);
          if (yn.changed) groundingVerdict.conditional_yesno_stripped = true;
          em.text = yn.text;
          return { text: em.text, removed: linked.removed, figures: [...findUnsupportedFigures(em.text, supportTexts, { visitorTexts, brandNames: [widgetMeta?.business_name, widgetMeta?.name] }), ...spanBad] };
        };
        // Executor confirmations are never stripped, and are the only
        // evidence a "done" claim can rest on. Strips add no apology note;
        // a hollow result becomes a clean decline with a concrete next step.
        const protectedTexts = (Array.isArray(toolCalls) ? toolCalls : [])
          .map((tc) => tc && tc.result_message).filter((t) => typeof t === 'string' && t.trim());
        const actionTexts = [...(toolLoopContext.toolResultTexts || []), ...protectedTexts, ...ledgerActionTexts(actionLedger)];
        const stripOpts = { protectedTexts, nextStep: bestNextStep({ siteLinks: widgetSiteLinks, texts: supportTexts }), arith: { support: supportTexts, visitor: visitorTexts } };
        const draftForNonAnswerCheck = responseText;
        let claimStripped = false; // a claim-phase strip (not a figure strip) happened
        let claimVerifyFn = null; // set when the claim verifier runs; reused by the wave 10 strip regeneration
        let g = gate(responseText);
        groundingVerdict.links_removed = g.removed;
        if (g.figures.length > 0 && actionRan) {
          groundingVerdict.unsupported_figures = g.figures;
          g = { ...g, text: stripUnsupportedSentences(g.text, g.figures, stripOpts) };
          groundingVerdict.stripped = true;
        } else if (g.figures.length > 0) {
          groundingVerdict.unsupported_figures = g.figures;
          const correction = `Your draft reply stated these specifics, which do not appear in KNOWLEDGE: ${g.figures.join(', ')}. Rewrite the reply to the visitor without them.${stayPlan && stayPlan.fact ? ` Fact (computed): ${stayPlan.fact}` : ''} If the visitor asked about them, say plainly that you cannot confirm that detail and offer the next step. Reply with the rewritten answer only.`;
          const loopFn = loopFnFor(activeProvider);
          try {
            // QC-W15b: no time for a second pass -> fall straight to the strip below.
            if (!canStartSecondPass({ elapsedMs: Date.now() - startMs, hardMs: hardTurnDeadlineMs() })) { groundingVerdict.second_pass_skipped = 'figure_regen'; throw new Error('second pass skipped: turn budget'); }
            const fix = await loopFn({
              apiKey: activeApiKey,
              model: activeModel,
              systemPrompt,
              messages: [...messages, { role: 'assistant', content: g.text }, { role: 'user', content: correction }],
              tools: [],
              widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
              context: toolLoopContext,
              onStream: null,
            });
            if (fix && typeof fix.text === 'string' && fix.text.trim()) {
              const g2 = gate(scrubEmDashes(fix.text));
              groundingVerdict.corrected = true;
              groundingVerdict.links_removed = [...groundingVerdict.links_removed, ...g2.removed];
              inputTokens = (inputTokens || 0) + (fix.inputTokens || 0);
              outputTokens = (outputTokens || 0) + (fix.outputTokens || 0);
              g = g2;
            }
          } catch (fixErr) {
            console.warn('[QuoxChat] grounding correction failed (falling back to strip):', fixErr.message);
          }
          if (g.figures.length > 0) {
            g = { ...g, text: stripUnsupportedSentences(g.text, g.figures, stripOpts) };
            groundingVerdict.stripped = true;
          }
        }
        // ── Codex enum 2 #1: claim verifier (non-numeric claims) ──
        // A small model lists business claims the knowledge does not support
        // ("SOC 2 certified", "GPU servers available"). On by default; a widget
        // can switch it off (embed_config.grounding.verify_claims=false, shown
        // in the admin widget config). Unsupported -> one corrective
        // regeneration (never after an action) -> re-verify -> sentence strip.
        // A verifier outage serves the gated answer but RECORDS it.
        // Deterministic chip replies (no model wrote them) are not verified.
        const figureRegenerated = groundingVerdict.corrected === true;
        let claimsRemoved = [];
        // Wave 14: weak retrieval (below the relevance floor) and an already-plain
        // abstain: nothing to audit, so do not invoke the verifier at all.
        const weakPlainAbstain = knowledge.confidence === 'none' && actionTexts.length === 0 && isPlainAbstain(g.text);
        if (groundingCfg.verify_claims !== false && !chipActionHandled && !weakPlainAbstain) {
          const vLoop = loopFnFor(activeProvider);
          // Verifier model: complex tier, preferring a different provider
          // family from the answer model when it has a key; the verdict
          // records which model actually checked this turn.
          // Privacy: an answer produced on a self-hosted model is not sent to a
          // cloud vendor for checking unless the operator wrote an explicit
          // llm_failover_order (the same consent signal as cloud failover).
          const cloudOk = activeProvider !== COMPAT_PROVIDER || Array.isArray(failoverPolicy.order);
          const verifierKeys = {
            ...(cloudOk ? { anthropic: anthropicKey, openai: openaiKey, gemini: geminiKey } : {}),
            [COMPAT_PROVIDER]: compatKeyMarker,
            [activeProvider]: activeProvider === COMPAT_PROVIDER ? (compatKey || 'no-key') : activeApiKey,
          };
          let vPick = pickVerifierModel({ answerProvider: activeProvider, keys: verifierKeys, pickModel: (t, p) => modelFor(t, p), tier: groundingCfg.verifier_tier });
          const runVerifier = ({ system, user }) => {
            const fn = loopFnFor(vPick.provider);
            return fn({
              apiKey: vPick.provider === COMPAT_PROVIDER ? compatKey : verifierKeys[vPick.provider],
              model: vPick.model,
              systemPrompt: system,
              messages: [{ role: 'user', content: user }],
              tools: [],
              widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
              context: { toolResultTexts: [] },
              onStream: null,
              // A yes/no claim audit does not need hidden reasoning; Gemini
              // 2.5 Flash thinks by default and that cost ~4-7s per check.
              ...(vPick.provider === 'gemini' && /flash/i.test(String(vPick.model)) ? { thinkingBudget: 0 } : {}),
            }).then((res) => res && res.text);
          };
          // A cross-family verifier that errors falls back to the answer
          // provider's own model (recorded as fell_back) rather than failing open.
          const gateTimings = { verify_ms: [], regen_ms: null, gate_start_ms: Date.now() - startMs };
          const complete = async (prompt) => {
            const tv = Date.now();
            try {
              return await runVerifier(prompt);
            } catch (vErr) {
              if (!vPick.cross_family) throw vErr;
              console.warn(`[QuoxChat] cross-family verifier ${vPick.provider} failed (${vErr.message}); falling back to ${activeProvider}`);
              vPick = { ...pickVerifierModel({ answerProvider: activeProvider, keys: { [activeProvider]: activeProvider === COMPAT_PROVIDER ? (compatKey || 'no-key') : activeApiKey }, pickModel: (t, p) => modelFor(t, p), tier: groundingCfg.verifier_tier }), fell_back: true };
              return runVerifier(prompt);
            } finally {
              gateTimings.verify_ms.push(Date.now() - tv);
            }
          };
          let v = await verifyClaims({ knowledge: supportTexts, answer: g.text, actions: actionTexts, links: widgetSiteLinks || [], premises: visitorTexts, brandNames: [widgetMeta?.business_name, widgetMeta?.name], conversation: conversationContext, question: message, complete });
          groundingVerdict.claims = { checked: !v.skipped, ok: v.ok, unsupported: v.unsupported, error: v.error || null, verifier: { provider: vPick.provider, model: vPick.model, tier: vPick.tier, cross_family: vPick.cross_family, fell_back: Boolean(vPick.fell_back) } };
          const outage = verifierOutageAction(v, knowledge.confidence);
          groundingVerdict.claims.outage_action = outage;
          if (outage === 'withhold') {
            // Wave 14: with no relevant knowledge the honest answer is a plain abstain, not "couldn't double-check".
            g = { ...g, text: knowledge.confidence === 'none' ? declineText(stripOpts.nextStep) : "I'm sorry, I couldn't double-check that answer just now. Please try again in a moment, or ask to speak with the team." };
            groundingVerdict.withheld = true;
          }
          claimVerifyFn = (answer) => verifyClaims({ knowledge: supportTexts, answer, actions: actionTexts, links: widgetSiteLinks || [], premises: visitorTexts, brandNames: [widgetMeta?.business_name, widgetMeta?.name], conversation: conversationContext, question: message, complete });
          if (v.ok && v.unsupported.length > 0) {
            claimsRemoved = [...v.unsupported];
            let text = g.text;
            const claimPassOk = canStartSecondPass({ elapsedMs: Date.now() - startMs, hardMs: hardTurnDeadlineMs() });
            if (!claimPassOk) groundingVerdict.second_pass_skipped = 'claim_regen';
            if (!actionRan && claimPassOk) {
              try {
                const tr = Date.now();
                const fix = await vLoop({
                  apiKey: activeApiKey,
                  model: activeModel,
                  systemPrompt,
                  messages: [...messages, { role: 'assistant', content: text }, { role: 'user', content: `Your draft reply made these claims, which KNOWLEDGE does not support: ${v.unsupported.map((c) => `"${c}"`).join('; ')}. Rewrite the reply to remove exactly those claims and nothing else. Keep every hedge or caveat that KNOWLEDGE states for the topic. Do not claim any action was completed unless a tool result shows it. End with one concrete next step (a link from SITE LINKS or KNOWLEDGE, or the contact route). Reply with the rewritten answer only.` }],
                  tools: [],
                  widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
                  context: toolLoopContext,
                  onStream: null,
                });
                gateTimings.regen_ms = Date.now() - tr;
                if (fix && typeof fix.text === 'string' && fix.text.trim()) {
                  const g3 = gate(scrubEmDashes(fix.text));
                  text = g3.figures.length > 0 ? stripUnsupportedSentences(g3.text, g3.figures, stripOpts) : g3.text;
                  // QC-W15b: the rewrite may have dropped a date qualifier but kept the stale figure.
                  const dm = dropDatedMoneyClaims(text, v.unsupported, { isCurrent: (sn) => findUnsupportedFigures(sn, supportTexts, { visitorTexts, brandNames: [widgetMeta?.business_name, widgetMeta?.name] }).length === 0 });
                  if (dm.changed) { text = dm.text || declineText(stripOpts.nextStep); groundingVerdict.stripped = true; claimStripped = true; groundingVerdict.dated_money_dropped = true; }
                  groundingVerdict.corrected = true;
                  inputTokens = (inputTokens || 0) + (fix.inputTokens || 0);
                  outputTokens = (outputTokens || 0) + (fix.outputTokens || 0);
                  if (!canStartSecondPass({ elapsedMs: Date.now() - startMs, hardMs: hardTurnDeadlineMs() })) {
                    // No time to re-verify the rewrite: serve the verified first draft with the flagged claims removed.
                    groundingVerdict.second_pass_skipped = 'reverify';
                    text = stripClaimSentences(g.text, v.unsupported, stripOpts); groundingVerdict.stripped = true; claimStripped = true;
                  } else {
                  const v2 = await verifyClaims({ knowledge: supportTexts, answer: text, actions: actionTexts, links: widgetSiteLinks || [], premises: visitorTexts, brandNames: [widgetMeta?.business_name, widgetMeta?.name], conversation: conversationContext, question: message, complete });
                  groundingVerdict.claims.after_correction = v2.ok ? v2.unsupported : null;
                  if (v2.ok && v2.unsupported.length > 0) { text = stripClaimSentences(text, v2.unsupported, stripOpts); groundingVerdict.stripped = true; claimStripped = true; }
                  }
                } else {
                  text = stripClaimSentences(text, v.unsupported, stripOpts); groundingVerdict.stripped = true; claimStripped = true;
                }
              } catch (cErr) {
                console.warn('[QuoxChat] claim correction failed (falling back to strip):', cErr.message);
                text = stripClaimSentences(text, v.unsupported, stripOpts); groundingVerdict.stripped = true; claimStripped = true;
              }
            } else {
              text = stripClaimSentences(text, v.unsupported, stripOpts); groundingVerdict.stripped = true; claimStripped = true;
            }
            g = { ...g, text };
          }
          if (groundingVerdict.claims) groundingVerdict.claims.timings = gateTimings;
          console.log(`[QuoxChat] claim gate at +${gateTimings.gate_start_ms}ms: verifier ${vPick.provider}/${vPick.model} ${gateTimings.verify_ms.join('+')}ms${gateTimings.regen_ms != null ? `, regen ${gateTimings.regen_ms}ms` : ''}`);
        }
        // Wave 10 #3: a strip that removed the sentence which answered the
        // question must not leave an unrelated remainder as the "answer".
        const stripHollow = () => g.text === declineText(stripOpts.nextStep)
          || strippedLeavesNonAnswer({ message, before: draftForNonAnswerCheck, after: g.text })
          || isStrippedFragment({ message, before: draftForNonAnswerCheck, after: g.text });
        if (groundingVerdict.stripped && !groundingVerdict.withheld && stripHollow()
          && !actionRan && !figureRegenerated && Date.now() - startMs <= 20000) {
          // Wave 10 v: the strip left nothing usable. Regenerate ONCE with the
          // removed claims listed, run the full gate on the result, and only
          // decline if that is hollow too.
          const removedList = [...new Set([...(groundingVerdict.unsupported_figures || []), ...claimsRemoved, ...(groundingVerdict.negatives_replaced || []).map((n) => (n && n.sentence) || n)].filter((x) => typeof x === 'string' && x.trim()))];
          groundingVerdict.regenerated_after_strip = true;
          try {
            const fix = await loopFnFor(activeProvider)({
              apiKey: activeApiKey,
              model: activeModel,
              systemPrompt,
              messages: [...messages, { role: 'assistant', content: draftForNonAnswerCheck }, { role: 'user', content: `Your draft reply was removed because these statements were not supported by KNOWLEDGE and must not be repeated: ${removedList.length ? removedList.map((c) => `"${c}"`).join('; ') : '(the main claim of the draft)'}. Rewrite the reply answering using only what KNOWLEDGE states, quoting the relevant rule, and say plainly what it does not cover. Do not claim any action was completed. Reply with the rewritten answer only.` }],
              tools: [],
              widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
              context: toolLoopContext,
              onStream: null,
            });
            if (fix && typeof fix.text === 'string' && fix.text.trim()) {
              inputTokens = (inputTokens || 0) + (fix.inputTokens || 0);
              outputTokens = (outputTokens || 0) + (fix.outputTokens || 0);
              const g4 = gate(scrubEmDashes(fix.text));
              let t4 = g4.figures.length > 0 ? stripUnsupportedSentences(g4.text, g4.figures, stripOpts) : g4.text;
              if (claimVerifyFn) {
                const v4 = await claimVerifyFn(t4);
                if (v4.ok && v4.unsupported.length > 0) t4 = stripClaimSentences(t4, v4.unsupported, stripOpts);
              }
              const hollow4 = t4 === declineText(stripOpts.nextStep) || strippedLeavesNonAnswer({ message, before: draftForNonAnswerCheck, after: t4 }) || isStrippedFragment({ message, before: draftForNonAnswerCheck, after: t4 });
              if (!hollow4) { g = { ...g4, text: t4 }; groundingVerdict.regen_kept = true; }
            }
          } catch (rErr) {
            console.warn('[QuoxChat] strip regeneration failed (falling back to decline):', rErr.message);
          }
        }
        // QC-W15b: a priced claim was stripped and a CURRENT chunk carries a figure
        // for the visitor's subject: regenerate once with that chunk pinned instead
        // of serving "not confirmed". Needs >= 8s before the turn watchdog.
        if (groundingVerdict.stripped && !groundingVerdict.withheld && !groundingVerdict.regen_kept) {
          const removedPriced = [...new Set([...(groundingVerdict.unsupported_figures || []), ...claimsRemoved].filter((x) => typeof x === 'string'))];
          const pr = pickPricedRegen({ message, chunks: knowledge.kept, stripped: removedPriced, elapsedMs: Date.now() - startMs, hardMs: hardTurnDeadlineMs(), alreadyRegenerated: groundingVerdict.regenerated_after_strip === true || groundingVerdict.regenerated_priced_strip === true, actionRan });
          groundingVerdict.priced_regen_decision = pr.reason;
          if (pr.regen) {
            groundingVerdict.regenerated_priced_strip = true;
            try {
              const fix = await loopFnFor(activeProvider)({
                apiKey: activeApiKey,
                model: activeModel,
                systemPrompt,
                messages: [...messages, { role: 'assistant', content: draftForNonAnswerCheck }, { role: 'user', content: `The CURRENT entry in KNOWLEDGE for this question is:\n---\n${pr.pin.slice(0, 1500)}\n---\nThe figures in your draft were not supported. Answer the visitor's question using only this entry and state the figure it gives. Do not mention older prices. Do not claim any action was completed. Reply with the rewritten answer only.` }],
                tools: [],
                widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
                context: toolLoopContext,
                onStream: null,
              });
              if (fix && typeof fix.text === 'string' && fix.text.trim()) {
                inputTokens = (inputTokens || 0) + (fix.inputTokens || 0);
                outputTokens = (outputTokens || 0) + (fix.outputTokens || 0);
                const g6 = gate(scrubEmDashes(fix.text));
                let t6 = g6.figures.length > 0 ? stripUnsupportedSentences(g6.text, g6.figures, stripOpts) : g6.text;
                if (claimVerifyFn && canStartSecondPass({ elapsedMs: Date.now() - startMs, hardMs: hardTurnDeadlineMs() })) {
                  const v6 = await claimVerifyFn(t6);
                  if (v6.ok && v6.unsupported.length > 0) t6 = stripClaimSentences(t6, v6.unsupported, stripOpts);
                }
                if (/[£$€]\s?\d/.test(t6) && !isAbstainReply(t6) && t6 !== declineText(stripOpts.nextStep)) { g = { ...g6, text: t6 }; groundingVerdict.regen_kept = true; }
              }
            } catch (rErr) {
              console.warn('[QuoxChat] priced-strip regeneration failed (serving the corrected draft):', rErr.message);
            }
          }
        }
        if (groundingVerdict.stripped && !groundingVerdict.withheld && !groundingVerdict.regen_kept && stripHollow()) {
          g = { ...g, text: declineText(stripOpts.nextStep) };
          groundingVerdict.withheld = true;
          groundingVerdict.stripped_nonanswer = true;
        }
        // Wave 14: a wrong abstain. Retrieval was confident (top score at or above
        // the confident threshold) yet the reply says it has no information:
        // regenerate ONCE with an "answer from KNOWLEDGE" nudge, gate the result
        // like any draft, and keep it only if it is no longer an abstain.
        if (!actionRan && !groundingVerdict.withheld && !groundingVerdict.regen_kept && !groundingVerdict.regenerated_after_strip
          && !chipActionHandled && Number(knowledge.top_score) >= CONFIDENT_ABSTAIN_SCORE && isAbstainReply(g.text)
          && Date.now() - startMs <= 20000) {
          groundingVerdict.regenerated_wrong_abstain = true;
          try {
            const fix = await loopFnFor(activeProvider)({
              apiKey: activeApiKey,
              model: activeModel,
              systemPrompt,
              messages: [...messages, { role: 'assistant', content: g.text }, { role: 'user', content: 'KNOWLEDGE does cover this question: a passage matched strongly. Re-read it and answer from KNOWLEDGE if it covers the question, quoting the relevant figure or rule. Only if it truly does not cover it, say so. Do not claim any action was completed. Reply with the rewritten answer only.' }],
              tools: [],
              widget: { id: widget_id, org_id: widgetOrgId, public_key: null, tool_policies: widgetToolPolicies },
              context: toolLoopContext,
              onStream: null,
            });
            if (fix && typeof fix.text === 'string' && fix.text.trim()) {
              inputTokens = (inputTokens || 0) + (fix.inputTokens || 0);
              outputTokens = (outputTokens || 0) + (fix.outputTokens || 0);
              const g5 = gate(scrubEmDashes(fix.text));
              let t5 = g5.figures.length > 0 ? stripUnsupportedSentences(g5.text, g5.figures, stripOpts) : g5.text;
              if (claimVerifyFn) {
                const v5 = await claimVerifyFn(t5);
                if (v5.ok && v5.unsupported.length > 0) t5 = stripClaimSentences(t5, v5.unsupported, stripOpts);
              }
              if (!isAbstainReply(t5) && t5 !== declineText(stripOpts.nextStep)) { g = { ...g5, text: t5 }; groundingVerdict.regen_kept = true; }
            }
          } catch (rErr) {
            console.warn('[QuoxChat] wrong-abstain regeneration failed (keeping the abstain):', rErr.message);
          }
        }
        // QC-W16: a reply sentence that repeats a planted directive's payload (flagged
        // or not, quarantined or not) is dropped; a hollow remainder abstains.
        if (!groundingVerdict.withheld && Array.isArray(ragChunks) && ragChunks.length > 0) {
          const dd = ingestLib.dropDirectiveOverlap(g.text, ragChunks.map((c) => c && c.text).filter((t) => typeof t === 'string'));
          if (dd.removed.length > 0) {
            g = { ...g, text: dd.text.trim() ? dd.text : declineText(stripOpts.nextStep) };
            groundingVerdict.stripped = true; claimStripped = true;
            groundingVerdict.directive_overlap_removed = dd.removed.slice(0, 5).map((x) => x.slice(0, 200));
          }
        }
        // QC-W16: never serve a sentence the verifier flagged. After every
        // regeneration and re-strip, sweep the FINAL text once more against all
        // flagged claims (first pass and post-correction), and record honestly
        // whether anything flagged was still there to remove.
        if (claimsRemoved.length > 0 && !groundingVerdict.withheld) {
          const flaggedAll = [...new Set([...claimsRemoved, ...((groundingVerdict.claims && groundingVerdict.claims.after_correction) || [])])];
          const sweep = removeFlaggedSentences(g.text, flaggedAll, stripOpts);
          groundingVerdict.served_unsupported = false;
          if (sweep.removed.length > 0) {
            g = { ...g, text: stripClaimSentences(g.text, flaggedAll, stripOpts) };
            groundingVerdict.stripped = true; claimStripped = true;
            groundingVerdict.final_sweep_removed = sweep.removed.slice(0, 5).map((x) => x.slice(0, 200));
          }
        }
        // Wave 12: analytics record the FINAL served text. A figure the gate
        // removed from an intermediate draft but which the served text carries
        // (regeneration restored a supported figure) is not a removal.
        if (groundingVerdict.unsupported_figures.length > 0) {
          const stillRemoved = figuresStillRemoved(groundingVerdict.unsupported_figures, g.text);
          if (stillRemoved.length < groundingVerdict.unsupported_figures.length) {
            groundingVerdict.unsupported_figures = stillRemoved;
            if (stillRemoved.length === 0 && !claimStripped && !groundingVerdict.withheld && !groundingVerdict.regen_kept) groundingVerdict.stripped = false;
          }
        }
        responseText = g.text;
      }
    } catch (gateErr) {
      // Codex enum 2 #7: the gate fails CLOSED. An answer that could not be
      // checked is never served; the visitor gets an honest fallback and the
      // verdict records the failure.
      console.warn('[QuoxChat] grounding gate error, failing closed:', gateErr.message);
      responseText = "I'm sorry, I couldn't double-check that answer just now. Please try again in a moment, or ask to speak with the team.";
      groundingVerdict.gate_error = String(gateErr.message || gateErr).slice(0, 160);
    }
    // Wave 13: a date-window correction means the draft's own reasoning was
    // wrong, so the verdict must not read strong / claims ok.
    if (groundingVerdict.date_window_guard) {
      reportedConfidence = knowledge.confidence === 'none' ? 'none' : 'weak';
      if (groundingVerdict.claims) { groundingVerdict.claims.ok = false; groundingVerdict.claims.date_window_contradiction = true; }
    }
    emitLayer(
      'verification',
      (groundingVerdict.links_removed.length || groundingVerdict.unsupported_figures.length) ? 'warn' : 'ok',
      `grounding: confidence=${knowledge.confidence} links_removed=${groundingVerdict.links_removed.length} figures=${groundingVerdict.unsupported_figures.length}${groundingVerdict.corrected ? ' corrected' : ''}${groundingVerdict.stripped ? ' stripped' : ''}`,
      null,
      { check: 'grounding', ...groundingVerdict, confidence: reportedConfidence, top_score: knowledge.top_score, history_source: builtHistory.source, dropped_client_assistant_turns: builtHistory.dropped_assistant || 0 },
    );

    // A visitor must always get text. A tool-only turn (e.g. the model called
    // human_handoff or asked for input but narrated nothing, and the executor
    // gave no result_message) used to return response:"" (the QuoxChat go-live
    // gate saw "empty response" on tool_abuse_mass_handoff).
    if (typeof responseText !== 'string' || !responseText.trim()) {
      const handoffOk = Array.isArray(toolCalls) && toolCalls.some((tc) => tc && tc.ok === true && tc.name === 'human_handoff');
      responseText = handoffOk
        ? "I've passed your request to our team. Someone will pick this up with you shortly."
        : "Sorry, I couldn't put together a reply to that. Could you rephrase, or ask to speak with the team?";
      console.warn(`[QuoxChat] empty reply substituted widget=${widget_id} handoff_ok=${handoffOk}`);
    }

    const durationMs = Date.now() - startMs;

    // QCX-2.2: Layer 5 — cognition. The LLM returned; capture tokens +
    // total turn duration. Warn if empty response (zero chars).
    emitLayer(
      'cognition',
      responseText && responseText.length > 0 ? 'ok' : 'warn',
      responseText && responseText.length > 0 ? `tokens=${inputTokens}+${outputTokens}` : 'empty_response',
      durationMs,
      { input_tokens: inputTokens, output_tokens: outputTokens, response_length: responseText?.length || 0, model: activeModel },
    );

    // QCX-2.3: VOLT event — model responded. Tokens + duration_ms make
    // this the authoritative compliance line per turn; AEE is the audit
    // surface, VOLT is the evidence chain.
    _voltEmit('quoxchat.model.responded', {
      model: activeModel,
      provider: activeProvider,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
      response_length: responseText?.length || 0,
    });
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        _voltEmit('quoxchat.tool.executed', {
          tool_id: tc.tool_id, name: tc.name, ok: !!tc.ok, error: tc.error || null,
          input_hash: hashInput(tc.input || {}),
        });
      }
    }

    // QCX-2.1: TOOL_INVOKED / TOOL_COMPLETED per executed tool — pairs off
    // SCENARIO_RUN. Args + result are fingerprinted (not included raw) so
    // the trace is useful without leaking PII or connector secrets.
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        try {
          const invokeEnv = buildWidgetEnvelope({
            intent: WIDGET_INTENTS.TOOL_INVOKED,
            visitor_id: visitor_id || 'anon',
            widget_id,
            reply_to: scenarioEnv.id,
            payload: { tool_id: tc.tool_id, name: tc.name, input_hash: hashInput(tc.input || {}), ts: tc.ts },
          });
          _storeAuditEnvelope(invokeEnv);
          _storeAuditEnvelope(buildWidgetEnvelope({
            intent: WIDGET_INTENTS.TOOL_COMPLETED,
            visitor_id: visitor_id || 'anon',
            widget_id,
            reply_to: invokeEnv.id,
            payload: { tool_id: tc.tool_id, name: tc.name, ok: !!tc.ok, error: tc.error || null },
          }));
          // QCX-2.1: special-case handoff — emit a dedicated intent the
          // admin UI can filter on ("show me every escalation").
          if (tc.name === 'human_handoff' && tc.ok) {
            _storeAuditEnvelope(buildWidgetEnvelope({
              intent: WIDGET_INTENTS.HANDOFF_REQUESTED,
              visitor_id: visitor_id || 'anon',
              widget_id,
              reply_to: scenarioEnv.id,
              payload: { tool_id: tc.tool_id, ts: tc.ts },
            }));
          }
        } catch (e) { /* non-fatal */ }
      }
    }

    // Output filtering. Codex enum 2 #16: the FULL redaction pattern set runs
    // unconditionally (same set the stream redactor applies), and the verdict
    // comes from whether anything actually changed. responseText is a single
    // variable reused by every downstream consumer (final response,
    // persist-message, webhook fan-out), so redacting it here closes all of
    // them at once.
    // Wave 11: canary leak, bare-token obedience, rule-list leak. Any hit
    // replaces the whole reply with a refusal and is recorded in the verdict.
    const outputGuard = { canary_leak: false, bare_token: false, rule_leak: false };
    {
      const bareTok = requestedBareToken(message);
      if (canaryLeaked(responseText, requestCanary)) outputGuard.canary_leak = true;
      else if (bareTok && isBareTokenReply(responseText, bareTok)) outputGuard.bare_token = true;
      else if (leaksSystemRules(responseText, ruleLeakSource)) outputGuard.rule_leak = true;
      if (outputGuard.canary_leak || outputGuard.bare_token || outputGuard.rule_leak) {
        console.warn(`[QuoxChat] Output guard tripped: ${Object.keys(outputGuard).filter((k) => outputGuard[k]).join(',')}`);
        responseText = INJECTION_REFUSAL;
      }
    }
    const outputGuardTripped = outputGuard.canary_leak || outputGuard.bare_token || outputGuard.rule_leak;
    const publicRedaction = redactPublicText(responseText);
    const outputFiltered = publicRedaction.changed;
    const matchedCredPatterns = publicRedaction.matched;
    // Wave 6 defect 11: a sentence the redactor guts is dropped whole, never
    // served as a fragment ("Thank you! ai.").
    if (outputFiltered) responseText = redactDroppingFragments(responseText, (t) => redactPublicText(t).text).text;
    // QCX-2.1: FILTER_OUTPUT_SANITISED — only emitted when a pattern matched.
    if (outputFiltered) {
      try {
        _storeAuditEnvelope(buildWidgetEnvelope({
          intent: WIDGET_INTENTS.FILTER_OUTPUT_SANITISED,
          visitor_id: visitor_id || 'anon',
          widget_id,
          reply_to: scenarioEnv.id,
          payload: { patterns_matched: matchedCredPatterns, response_length: responseText.length },
        }));
      } catch (e) { /* non-fatal */ }
    }

    // QCX-2.2 / QCL-SECURITY P1-4: Layer 7 — verification. Output filter
    // ran regardless of hit/miss; ok when clean, warn when a credential
    // pattern surfaced AND was redacted in place before being served
    // (the response still reaches the visitor, with the secret spans
    // replaced by [REDACTED] rather than the raw value).
    emitLayer(
      'verification',
      (outputFiltered || outputGuardTripped) ? 'warn' : 'ok',
      outputGuardTripped ? `output_guard ${Object.keys(outputGuard).filter((k) => outputGuard[k]).join(',')}` : (outputFiltered ? `credential_pattern_redacted=${matchedCredPatterns.length}` : 'clean'),
      null,
      { filtered: outputFiltered, redacted: outputFiltered, patterns: matchedCredPatterns, ...outputGuard },
    );

    // QCX-2.1: existing MESSAGE envelope kept for back-compat with LogsTab
    // + analytics — they read intent='quoxchat.message' today. reply_to
    // chain updated so the envelope threads under SCENARIO_RUN.
    try {
      _storeAuditEnvelope(buildWidgetEnvelope({
        intent: WIDGET_INTENTS.MESSAGE,
        visitor_id: visitor_id || 'anon',
        widget_id,
        reply_to: scenarioEnv.id,
        payload: { message_length: message.length, response_length: responseText.length, input_tokens: inputTokens, output_tokens: outputTokens, duration_ms: durationMs, injection_score: injectionScore, output_filtered: outputFiltered, output_guard: outputGuardTripped ? outputGuard : undefined, model: activeModel, tier: routeDecision.tier, route_reason: routeDecision.reason, page_url: page_url || null, tool_call_count: Array.isArray(toolCalls) ? toolCalls.length : 0 },
      }));
    } catch (auditErr) {
      console.warn('[QuoxChat] Audit failed:', auditErr.message);
    }

    console.log(`[QuoxChat] Response: ${responseText.length} chars, ${inputTokens}+${outputTokens} tok, ${durationMs}ms`);

    // QCX-2.3 / Codex enum 2 #12: the terminal VOLT event and the seal are
    // emitted AFTER the persist stage below, so the receipt records whether
    // the message actually reached storage. Persist/notify failures after
    // that point are logged separately.

    // Return sources in response for UI attribution
    // QUOXCHAT-BRUTALOOP: the public reply carries human titles only. Internal
    // ids (corpus:<id>, corpus__<slug>__<hash>.md, "Chunk 11/14") stay in the
    // operator-side persisted context, never on this unauthenticated wire.
    // Wave 5 product: cite only the chunks that support the final reply, one per source.
    const citedChunks = selectCitedChunks(knowledge.kept, responseText);
    const sources = buildPublicSources(citedChunks, { siteLinks: widgetSiteLinks, titleFn: publicSourceTitle });

    // ── CW-8.9.2: Persist conversation + messages (non-fatal) ──
    let persistedConversationId = null;
    let persistedConversationCreated = false;
    // persistOutcome: true | false | null (null = persistence not applicable).
    let persistOutcome = null;
    if (widget_id && widget_id !== 'demo') {
      persistOutcome = false;
      try {
        const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
        const serviceKey = process.env.INTERNAL_SERVICE_KEY;
        if (serviceKey) {
          // QCX-5a: capture the full LLM input so admins can drill into
          // "what did the model actually see?" in LogsTab. Kept under a
          // sane size budget (chunk text trimmed; only the last 10 history
          // turns are included — same window the LLM received).
          const CONTEXT_CHUNK_PREVIEW = 2000;
          const contextCapture = {
            system_prompt: systemPrompt,
            messages_sent: messages.map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
            rag_chunks: ragChunks.map((c) => ({
              source: c.source || null,
              section: c.section || null,
              score: typeof c.score === 'number' ? Math.round(c.score * 1000) / 1000 : null,
              pinned: !!c.pinned,
              text: typeof c.text === 'string' && c.text.length > 0
                ? (c.text.length > CONTEXT_CHUNK_PREVIEW ? c.text.slice(0, CONTEXT_CHUNK_PREVIEW - 1) + '…' : c.text)
                : undefined,
            })),
            model: activeModel,
            provider: activeProvider,
            key_source: resolveKeySource({ provider: activeProvider, providerKeys, useCompat: activeProvider === COMPAT_PROVIDER }),
            tier: routeDecision.tier,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            injection_score: injectionScore,
            // w5h (probe 69): the email_transcript tool is active and
            // allow-listed but withheld per visitor unless the address is
            // trusted (identify-verified) or bot protection is configured, so
            // a chat-typed address cannot be used to relay mail. Say so to the
            // operator in Logs; the visitor only gets the safe sentence.
            transcript_unavailable: transcriptFilteredOut
              ? { reason: 'recipient_not_trusted', detail: 'Bot protection is not configured for this widget and the visitor is not identify()-verified, so email_transcript was not offered to the model. Configure bot protection (Settings) or identify() the visitor with a verified email.' }
              : undefined,
            // QUOXCHAT-BRUTALOOP D7: per-answer grounding verdict, so the
            // operator can see WHY this answer looks the way it does.
            grounding: {
              confidence: reportedConfidence,
              date_window_guard: groundingVerdict.date_window_guard === true,
              top_score: knowledge.top_score,
              links_removed: groundingVerdict.links_removed,
              unsupported_figures: groundingVerdict.unsupported_figures,
              corrected: groundingVerdict.corrected,
              stripped: groundingVerdict.stripped,
              // Wave 5: lets the Analytics "unanswered" feed tell a withheld
              // reply (verifier outage apology) from a normal answer.
              withheld: groundingVerdict.withheld === true,
              history_source: builtHistory.source,
              dropped_client_assistant_turns: builtHistory.dropped_assistant || 0,
              claims: groundingVerdict.claims || null,
              // Wave 8 D7: the gate verdict in plain keys for the operator drill-down.
              removed_figures: groundingVerdict.unsupported_figures,
              negative_rewrites: groundingVerdict.negatives_replaced || [],
              stripped_claims: (groundingVerdict.claims && Array.isArray(groundingVerdict.claims.unsupported) && groundingVerdict.stripped) ? groundingVerdict.claims.unsupported : [],
              regenerated: groundingVerdict.corrected === true,
              gate_error: groundingVerdict.gate_error || null,
              stripped_nonanswer: groundingVerdict.stripped_nonanswer === true,
              regenerated_after_strip: groundingVerdict.regenerated_after_strip === true,
              retrieval_error: groundingVerdict.retrieval_error || null,
              // QC-W18b: dense retrieval failed, the turn used keyword search only.
              retrieval_degraded: groundingVerdict.retrieval_degraded || null,
              retrieval_degraded_provider: groundingVerdict.retrieval_degraded_provider || null,
              retrieval_degraded_status: groundingVerdict.retrieval_degraded_status ?? null,
              // QC-BRUTALOOP-W15: a chunk behind this reply came from a superseded or suggested-superseded source.
              used_outdated_source: (Array.isArray(citedChunks) && citedChunks.some((c) => isSupersededSuggested(c))) || usedOutdatedSource(knowledge.kept, responseText),
            },
          };
          const persistResp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/persist-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
            body: JSON.stringify({
              visitor_id: visitor_id || 'anon',
              conversation_id: (typeof ensuredConversationId !== 'undefined') ? ensuredConversationId : null,
              user_message: message,
              assistant_message: responseText,
              // Operator-side record keeps the internal ids (Logs drill-down);
              // only the public reply is reduced to human titles.
              sources: citedChunks.map((c) => ({ source: c.source, section: c.section, title: publicSourceTitle(c), score: Math.round((c.score || 0) * 100) / 100, pinned: c.pinned || false })),
              confidence: ragChunks[0]?.score ?? null,
              injection_score: injectionScore,
              page_url: page_url || null,
              tool_calls: toolCalls || null,
              context: contextCapture,
              // P7: spend + which key answered, for the monthly budget and the
              // operator's "your key vs instance key" truth.
              cost_micro_usd: estimateAnswerCostMicro(activeProvider, activeModel, inputTokens, outputTokens),
              // w5h: measured turn duration, stored per answer so analytics
              // avg_response_ms / response-times have samples.
              duration_ms: durationMs,
              key_source: resolveKeySource({ provider: activeProvider, providerKeys, useCompat: activeProvider === COMPAT_PROVIDER }),
            }),
            signal: AbortSignal.timeout(3000),
          });
          if (persistResp.ok) {
            const persistData = await persistResp.json().catch(() => ({}));
            persistedConversationId = persistData.conversation_id || null;
            // QUOXCHAT-PRO P1: true exactly once per conversation — drives
            // the new_conversation org alert below.
            persistedConversationCreated = persistData.created === true;
            persistOutcome = true;
          } else {
            console.warn(`[QuoxChat] persist-message returned ${persistResp.status}`);
          }
        } else {
          console.warn('[QuoxChat] INTERNAL_SERVICE_KEY not set — skipping persist');
        }
      } catch (persistErr) {
        console.warn('[QuoxChat] persist-message failed (non-fatal):', persistErr.message);
      }
    }

    // Codex enum 2 #12: seal the VOLT run now that the persist outcome is
    // known. A failed persist is recorded and seals the run as failed, never
    // as an 'ok' receipt that precedes a missing conversation record.
    _voltEmit('quoxchat.message.created', {
      message_length: message.length,
      response_length: responseText.length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
      injection_score: injectionScore,
      output_filtered: outputFiltered,
      tool_call_count: Array.isArray(toolCalls) ? toolCalls.length : 0,
      model: activeModel,
      persisted: persistOutcome,
    });
    if (persistOutcome === false) {
      if (_voltEmitter && voltRunId) {
        try { _voltEmitter.failRun(voltRunId, new Error('persist_failed')); } catch { /* non-fatal */ }
      }
    } else {
      _voltComplete(outputFiltered ? 'filtered' : 'ok');
    }

    // QUOXCHAT-PRO P1: single post-turn meta fetch shared by the QCX-8b
    // webhook fan-out and the org alert emit below.
    let postTurnMeta = null;
    try { postTurnMeta = await fetchWidgetMeta(widget_id); } catch { /* non-fatal */ }

    // QCX-8b — outbound webhooks. Read embed_config_json.webhooks (array
    // of {url, secret, events}) and fire matching events fire-and-forget.
    // Failure never blocks the response — webhook delivery is best-effort.
    try {
      const meta = postTurnMeta;
      let cfg = meta?.embed_config_json;
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
      const hooks = Array.isArray(cfg?.webhooks) ? cfg.webhooks : [];
      if (hooks.length > 0) {
        const { matchesSubscription, buildWebhookPayload } = require('../lib/quoxchatWebhookEvents');
        const { deliverWebhook } = require('../lib/quoxchatWebhookDeliver');
        const fireEvents = [
          { name: 'message.created', data: {
            widget_id, visitor_id: visitor_id || 'anon',
            conversation_id: persistedConversationId,
            user_message: message,
            assistant_message: responseText,
            tokens: { input: inputTokens, output: outputTokens },
            model: activeModel,
          } },
        ];
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            fireEvents.push({ name: 'tool.invoked', data: {
              widget_id, visitor_id: visitor_id || 'anon',
              conversation_id: persistedConversationId,
              tool_name: tc.name, tool_id: tc.tool_id,
              ok: !!tc.ok, error: tc.error || null,
            } });
            if (tc.name === 'human_handoff' && tc.ok) {
              fireEvents.push({ name: 'handoff.requested', data: {
                widget_id, visitor_id: visitor_id || 'anon',
                conversation_id: persistedConversationId,
              } });
            }
          }
        }
        for (const evt of fireEvents) {
          for (const hook of hooks) {
            if (!matchesSubscription(evt.name, hook.events)) continue;
            const payload = buildWebhookPayload(evt.name, evt.data);
            // Fire-and-forget — never await, never throw, never block /message.
            deliverWebhook({ url: hook.url, secret: hook.secret || '', payload })
              .catch((e) => console.warn('[QuoxChat] webhook deliver error:', e?.message));
          }
        }
      }
    } catch (webhookErr) {
      console.warn('[QuoxChat] webhook fan-out failed (non-fatal):', webhookErr.message);
    }

    // QUOXCHAT-PRO P1 — org-configurable alerts via notificationService.
    // Reads website_widgets.notification_settings_json (server-side only,
    // fetched via /meta). Events: new_conversation (first persist of this
    // conversation), handoff_requested (human_handoff tool succeeded this
    // turn). Channels: email + webhook (any notificationService channel type
    // is accepted; delivery then depends on org credentials). Fire-and-forget
    // — alerting must never block or break /message.
    try {
      const handoffCall = Array.isArray(toolCalls)
        ? toolCalls.find((tc) => tc && tc.name === 'human_handoff' && tc.ok)
        : null;
      if (persistedConversationCreated) {
        notifyWidgetChannels(postTurnMeta, 'new_conversation', {
          widget_id,
          conversation_id: persistedConversationId,
          visitor_id: visitor_id || 'anon',
          visitor_name: visitorIdentifiedName,
          page_url: page_url || null,
          first_message: String(message || '').slice(0, 300),
        });
      }
      // PRO-3 — per-action org alerts. One alert per successful action call
      // this turn (book_appointment / schedule_demo / leave_message), same
      // fire-and-forget contract as handoff_requested.
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const actionEvent = tc && tc.ok ? ACTION_ALERT_EVENTS[tc.name] : null;
          if (!actionEvent) continue;
          notifyWidgetChannels(postTurnMeta, actionEvent, {
            widget_id,
            conversation_id: persistedConversationId,
            visitor_id: visitor_id || 'anon',
            visitor_name: visitorIdentifiedName,
            page_url: page_url || null,
          });
        }
      }
      if (handoffCall) {
        notifyWidgetChannels(postTurnMeta, 'handoff_requested', {
          widget_id,
          conversation_id: persistedConversationId,
          visitor_id: visitor_id || 'anon',
          visitor_name: visitorIdentifiedName,
          page_url: page_url || null,
        });
        // QUOXCHAT-PRO P2 — Option B: provision a governed Matrix room for
        // this conversation (auth provision-node, node_type 'quoxchat', the
        // same service-key call the tasks service makes for agentic_team
        // rooms) and relay the triggering visitor message into it so
        // operators see what prompted the handoff. Fire-and-forget with
        // retry: a failed/pending provision leaves matrix_room_id NULL on
        // the handed-off conversation and the handed-off gate above retries
        // on the next visitor message. The executor already flipped the
        // conversation to status='handed_off' during the tool loop, so the
        // handoff lookup resolves it (with visitor name/email for the label).
        (async () => {
          const convId = persistedConversationId;
          if (!convId || !postTurnMeta?.org_id) return;
          const conv = (await matrixRelay.lookupHandoffConversation(widget_id, visitor_id || 'anon'))
            || { conversation_id: convId, matrix_room_id: null, org_id: postTurnMeta.org_id };
          await matrixRelay.ensureRoomAndRelay({
            conversation: conv,
            orgId: postTurnMeta.org_id,
            visitorId: visitor_id || 'anon',
            text: message,
            // Agent-authored handover summary from the tool input; the relay
            // prefixes it onto the room message so operators pick up with
            // context. Null keeps prior behavior byte-identical.
            summary: (typeof handoffCall.input?.summary === 'string' && handoffCall.input.summary.trim())
              ? handoffCall.input.summary.trim().slice(0, 500)
              : null,
          });
        })().catch((e) => console.warn('[QuoxChat] handoff room provision failed (non-fatal):', e?.message));
      }
    } catch (alertErr) {
      console.warn('[QuoxChat] org alert emit failed (non-fatal):', alertErr.message);
    }

    // needs_input fix — mirror any tool call's needs_input top-level so the
    // widget can render an inline data-collection form regardless of which
    // path executed the tool (chip / belt / any LLM provider's tool loop).
    const needsInputCall = Array.isArray(toolCalls) ? toolCalls.find((tc) => tc && tc.needs_input) : null;

    respondOk({
      success: true,
      // QCL-SECURITY P1-4: responseText is already redacted in place above
      // when outputFiltered — serve it directly rather than discarding the
      // whole (now-safe) message with a generic apology.
      response: responseText,
      sources,
      tokens: { input: inputTokens, output: outputTokens },
      duration_ms: durationMs,
      model: activeModel,
      injection_score: injectionScore,
      conversation_id: persistedConversationId || handedOffConversationId,
      // UX HOLES FIX: a chip action that executed while handed off keeps
      // the widget in its handed-off state (status strip + operator-reply
      // polling) alongside the executor's confirmation text.
      // Staged handoff: handed_off:true with operator_joined:false tells the
      // widget the AI is holding; the strip copy must not claim a queue the
      // visitor never sees answered.
      ...(handedOffConversationId ? { handed_off: true, operator_joined: !handoffAwaitingPickup }
        // W15: a handoff persisted this turn (LLM tool or post-turn belt) must
        // reach the widget so it starts polling for the operator's reply.
        : (Array.isArray(toolCalls) && toolCalls.some((tc) => tc && tc.ok === true && tc.name === 'human_handoff')
          ? { handed_off: true, operator_joined: false } : {})),
      ...(needsInputCall ? { needs_input: needsInputCall.needs_input } : {}),
    });

  } catch (err) {
    // SECURITY AUDIT FIX (finding #3, MEDIUM) — this used to echo err.message
    // straight to the anonymous visitor (upstream provider error bodies,
    // internal hostnames/ports, ECONNREFUSED details). The success path
    // already sanitises before serving (see sanitiseString / outputFiltered
    // above); mirror that here with a generic code and keep the real error
    // server-side only.
    console.error('[QuoxChat] Message error:', err.message);
    const internalReply = "Something went wrong on our end and we have logged it. Please try again in a moment.";
    const internalCid = turnSettled ? null : await persistFailedTurn('internal_error', internalReply);
    respondErr(500, { success: false, response: internalReply, error: 'internal_error', ...(internalCid ? { conversation_id: internalCid } : {}) });
  }
});

// QC W17: a synchronous throw / next(err) on /message must still be JSON.
router.use('/message', (err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[QuoxChat] /message unhandled error:', err && err.message);
  if (res.headersSent) { try { res.end(); } catch { /* client gone */ } return; }
  res.status(500).json({ success: false, error: 'internal_error', response: MESSAGE_ERROR_FALLBACK_TEXT });
});

// ── QCX-4.4: Visitor file upload ──
// In-memory scratch store. Files live at most TTL_MS, capped at MAX_PER_VISITOR
// per (widget_id, visitor_id). The scope check in _visitorUploadRead is the
// only way to retrieve file content — a visitor cannot read another
// visitor's file_id. Durable storage can replace this store later without
// changing the endpoint contract.
const _visitorUploadStore = new Map();           // file_id -> record
const _visitorUploadByScope = new Map();         // `${widget}:${visitor}` -> [file_id,...]
const VISITOR_UPLOAD_TTL_MS = 10 * 60 * 1000;    // 10 min
const VISITOR_UPLOAD_MAX_PER_VISITOR = 5;
const VISITOR_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const VISITOR_UPLOAD_ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
]);

function _visitorUploadPurgeExpired(now) {
  for (const [fid, rec] of _visitorUploadStore) {
    if (rec.expires_at <= now) {
      _visitorUploadStore.delete(fid);
      const key = `${rec.widget_id}:${rec.visitor_id}`;
      const list = _visitorUploadByScope.get(key);
      if (list) {
        const i = list.indexOf(fid);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) _visitorUploadByScope.delete(key);
      }
    }
  }
}

function _visitorUploadRead(fileId, { widget_id, visitor_id } = {}) {
  const rec = _visitorUploadStore.get(fileId);
  if (!rec) return null;
  if (rec.expires_at <= Date.now()) {
    _visitorUploadStore.delete(fileId);
    return null;
  }
  if (rec.widget_id !== widget_id || rec.visitor_id !== visitor_id) return null;
  return rec;
}

const visitorUploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VISITOR_UPLOAD_MAX_BYTES, files: 1 },
});

// Ledger critical #5 (2026-07-24): upload consumes paid resources (storage,
// PDF parsing, LLM context injection) and previously skipped the entitlement
// gate. Note the ordering: multipart bodies are only parsed by multer, so
// domainGuard and licenseGuard MUST run AFTER it — before this fix
// domainGuard ran first, saw an empty req.body.widget_id, and passed every
// upload through unchecked.
router.post('/visitor/upload', rateLimit, (req, res, next) => {
  visitorUploadMulter.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 10MB)' });
      }
      return res.status(400).json({ error: 'upload_error', detail: err.message });
    }
    next();
  });
}, domainGuard, licenseGuard, async (req, res) => {
  try {
    const widget_id = String(req.body?.widget_id || '').trim();
    const visitor_id = String(req.body?.visitor_id || '').trim();
    const conversation_id = req.body?.conversation_id ? String(req.body.conversation_id).trim() : null;
    if (!widget_id) return res.status(400).json({ error: 'widget_id required' });
    if (!visitor_id) return res.status(400).json({ error: 'visitor_id required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const mime = String(req.file.mimetype || '').toLowerCase();
    if (!VISITOR_UPLOAD_ALLOWED_MIME.has(mime)) {
      return res.status(415).json({ error: `unsupported mime type: ${mime}` });
    }

    // Extract text if applicable. Images carry no text; PDFs use pdf-parse
    // (already used by /knowledge/upload); text mimes decode as UTF-8.
    let extractedText = '';
    try {
      if (mime === 'application/pdf') {
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: req.file.buffer });
        try {
          const pdfResult = await parser.getText();
          extractedText = pdfResult.text || '';
        } finally {
          try { await parser.destroy(); } catch {}
        }
      } else if (mime.startsWith('text/')) {
        extractedText = req.file.buffer.toString('utf-8');
      }
    } catch (parseErr) {
      console.warn(`[QuoxChat] visitor-upload parse failed: ${parseErr.message}`);
    }

    const now = Date.now();
    _visitorUploadPurgeExpired(now);

    // Enforce per-visitor cap: drop the oldest if over.
    const scopeKey = `${widget_id}:${visitor_id}`;
    const scopeList = _visitorUploadByScope.get(scopeKey) || [];
    while (scopeList.length >= VISITOR_UPLOAD_MAX_PER_VISITOR) {
      const oldest = scopeList.shift();
      _visitorUploadStore.delete(oldest);
    }

    const fileId = `fo_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const rec = {
      file_id: fileId,
      widget_id,
      visitor_id,
      conversation_id,
      name: req.file.originalname || 'upload',
      mime,
      size: req.file.size,
      buffer: req.file.buffer,
      is_image: mime.startsWith('image/'),
      extracted_text: extractedText,
      created_at: now,
      expires_at: now + VISITOR_UPLOAD_TTL_MS,
    };
    _visitorUploadStore.set(fileId, rec);
    scopeList.push(fileId);
    _visitorUploadByScope.set(scopeKey, scopeList);

    console.log(`[QuoxChat] visitor upload: ${rec.name} (${(rec.size / 1024).toFixed(0)}KB, ${mime}) → ${fileId}`);

    return res.json({
      ok: true,
      file_id: fileId,
      name: rec.name,
      mime,
      size: rec.size,
      is_image: rec.is_image,
      extracted_preview: extractedText.slice(0, 500),
      extracted_len: extractedText.length,
      expires_at: rec.expires_at,
    });
  } catch (err) {
    console.error('[QuoxChat] visitor upload error:', err.message);
    return res.status(500).json({ error: 'upload_failed', detail: err.message });
  }
});

// ── Config ──
// QCX-4.5: per-widget presentation used by the public widget on mount.
// Looks up widget_meta + embed_config_json from auth and returns a safe
// client-facing shape. Unknown widgets and unreachable auth fall back
// to a neutral stub so the dev page still works.
function _normalizeWidgetTheme(theme) {
  return ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
}
function _safeAvatarUrl(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (u.startsWith('//')) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}
// QCX-6e — same scheme allow-list as avatar URLs but applied to the
// admin-configured privacy/DPA links. Keeps the visitor on a known
// transport — no javascript:/data:/file: URIs surface in the widget.
function _safePolicyUrl(url) { return _safeAvatarUrl(url); }
// QCX-6e — sanitise the Art.52 disclosure text. Strip any HTML tags so
// admin-supplied markup can't inject script/iframe; cap at 500 chars
// to keep it readable in the widget header. Empty input → default.
const ART52_DEFAULT = 'ℹ️ AI assistant: automated responses may be inaccurate.';
function _sanitiseDisclosureText(input) {
  if (typeof input !== 'string') return ART52_DEFAULT;
  // Drop any HTML-like markup, then collapse whitespace.
  let s = input.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return ART52_DEFAULT;
  if (s.length > 500) s = s.slice(0, 500);
  return s;
}
const { sanitiseStyleOverrides } = require('../lib/quoxchatStyleOverrides');

// QCX-6a — Visitor-initiated GDPR Article 15 export. Visitor clicks
// "Request my data" in the widget; we proxy the request to auth's
// internal endpoint with the service key, then stream the bundle back
// as a JSON download. Rate-limited + domain-guarded same as /message.
// VOLT-witnessed so the bundle's existence is auditable independent
// of whether the response is intercepted.
router.post('/visitor/export', rateLimit, domainGuard, async (req, res) => {
  const startMs = Date.now();
  try {
    const widget_id = String(req.body?.widget_id || '').trim();
    const visitor_id = String(req.body?.visitor_id || '').trim();
    if (!widget_id) return res.status(400).json({ error: 'widget_id required' });
    if (!visitor_id) return res.status(400).json({ error: 'visitor_id required' });
    // Proof of possession (wave 7): a conversation id owned by this visitor.
    const proof_conversation_id = String(req.body?.conversation_id || '').trim();
    if (!proof_conversation_id) {
      return res.status(400).json({ error: 'conversation_id required (a conversation belonging to this visitor)' });
    }

    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) {
      return res.status(503).json({ error: 'Export service not configured' });
    }

    // Open a VOLT run keyed to the visitor so the request is on-chain
    // before we even look at the data. Closes whether the export
    // succeeds or fails (state encodes the outcome).
    let voltRunId = null;
    if (_voltEmitter) {
      try {
        voltRunId = _voltEmitter.startRun(visitor_id, {
          widget_id, visitor_id, agent_id: 'quoxchat.gdpr.export',
        });
      } catch { /* non-fatal */ }
    }
    const _voltEmit = (eventType, payload) => {
      if (!_voltEmitter || !voltRunId) return;
      try { _voltEmitter.emit(voltRunId, eventType, payload || {}); } catch { /* non-fatal */ }
    };
    const _voltComplete = (state) => {
      if (!_voltEmitter || !voltRunId) return;
      try { _voltEmitter.completeRun(voltRunId, state || 'ok'); } catch { /* non-fatal */ }
    };

    let resp;
    try {
      resp = await fetch(
        `${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/visitors/${encodeURIComponent(visitor_id)}/export?conversation_id=${encodeURIComponent(proof_conversation_id)}`,
        { headers: { 'x-service-key': serviceKey }, signal: AbortSignal.timeout(8000) },
      );
    } catch (fetchErr) {
      _voltEmit('quoxchat.gdpr.export.failed', { reason: 'fetch_error', message: fetchErr.message });
      _voltComplete('failed');
      return res.status(502).json({ error: 'Export service unavailable' });
    }

    if (resp.status === 403) {
      _voltEmit('quoxchat.gdpr.export.failed', { reason: 'proof_rejected' });
      _voltComplete('failed');
      return res.status(403).json({ error: 'conversation_id does not belong to this visitor' });
    }
    if (resp.status === 404) {
      _voltEmit('quoxchat.gdpr.export.not_found', {});
      _voltComplete('not_found');
      return res.status(404).json({ error: 'Widget not found' });
    }
    if (!resp.ok) {
      _voltEmit('quoxchat.gdpr.export.failed', { reason: 'auth_error', status: resp.status });
      _voltComplete('failed');
      return res.status(502).json({ error: `Export upstream error: ${resp.status}` });
    }

    const bundle = await resp.json().catch(() => null);
    if (!bundle) {
      _voltEmit('quoxchat.gdpr.export.failed', { reason: 'malformed_response' });
      _voltComplete('failed');
      return res.status(502).json({ error: 'Export upstream returned malformed payload' });
    }

    _voltEmit('quoxchat.gdpr.export.completed', {
      conversations: bundle?.counts?.conversations || 0,
      messages: bundle?.counts?.messages || 0,
      duration_ms: Date.now() - startMs,
    });
    _voltComplete('ok');

    const filename = `quoxchat-export-${widget_id}-${visitor_id}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    console.error('[QuoxChat] gdpr export error:', err.message);
    return res.status(500).json({ error: 'Export failed' });
  }
});

// QCX-6b — Visitor-initiated GDPR Article 17 erasure. Irreversible: the
// caller must include `confirm: true` in the body. Cascades through
// auth's internal endpoint which transactionally drops messages →
// conversations → visitor record.
router.post('/visitor/erase', rateLimit, domainGuard, async (req, res) => {
  const startMs = Date.now();
  try {
    const widget_id = String(req.body?.widget_id || '').trim();
    const visitor_id = String(req.body?.visitor_id || '').trim();
    const confirm = req.body?.confirm === true;
    const proof_conversation_id = String(req.body?.conversation_id || '').trim();
    if (!widget_id) return res.status(400).json({ error: 'widget_id required' });
    if (!visitor_id) return res.status(400).json({ error: 'visitor_id required' });
    if (!confirm) {
      return res.status(400).json({
        error: 'confirm flag required for irreversible erasure',
        legal_basis: 'GDPR Article 17 (right to erasure)',
      });
    }

    // Proof of possession (wave 7): visitor ids are client-chosen, so erasure
    // also needs a conversation id that belongs to this visitor (auth checks).
    if (!proof_conversation_id) {
      return res.status(400).json({ error: 'conversation_id required (a conversation belonging to this visitor)' });
    }

    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) return res.status(503).json({ error: 'Erase service not configured' });

    let voltRunId = null;
    if (_voltEmitter) {
      try {
        voltRunId = _voltEmitter.startRun(visitor_id, {
          widget_id, visitor_id, agent_id: 'quoxchat.gdpr.erase',
        });
      } catch { /* non-fatal */ }
    }
    const _voltEmit = (eventType, payload) => {
      if (!_voltEmitter || !voltRunId) return;
      try { _voltEmitter.emit(voltRunId, eventType, payload || {}); } catch {}
    };
    const _voltComplete = (state) => {
      if (!_voltEmitter || !voltRunId) return;
      try { _voltEmitter.completeRun(voltRunId, state || 'ok'); } catch {}
    };

    let resp;
    try {
      resp = await fetch(
        `${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/visitors/${encodeURIComponent(visitor_id)}?conversation_id=${encodeURIComponent(proof_conversation_id)}`,
        { method: 'DELETE', headers: { 'x-service-key': serviceKey }, signal: AbortSignal.timeout(8000) },
      );
    } catch (fetchErr) {
      _voltEmit('quoxchat.gdpr.erase.failed', { reason: 'fetch_error', message: fetchErr.message });
      _voltComplete('failed');
      return res.status(502).json({ error: 'Erase service unavailable' });
    }

    if (resp.status === 403) {
      _voltEmit('quoxchat.gdpr.erase.failed', { reason: 'proof_rejected' });
      _voltComplete('failed');
      return res.status(403).json({ error: 'conversation_id does not belong to this visitor' });
    }
    if (resp.status === 404) {
      _voltEmit('quoxchat.gdpr.erase.not_found', {});
      _voltComplete('not_found');
      return res.status(404).json({ error: 'Widget not found' });
    }
    if (!resp.ok) {
      _voltEmit('quoxchat.gdpr.erase.failed', { reason: 'auth_error', status: resp.status });
      _voltComplete('failed');
      return res.status(502).json({ error: `Erase upstream error: ${resp.status}` });
    }

    const body = await resp.json().catch(() => null);
    if (!body) {
      _voltEmit('quoxchat.gdpr.erase.failed', { reason: 'malformed_response' });
      _voltComplete('failed');
      return res.status(502).json({ error: 'Erase upstream returned malformed payload' });
    }

    _voltEmit('quoxchat.gdpr.erase.completed', {
      deleted: body.deleted || {},
      duration_ms: Date.now() - startMs,
    });
    _voltComplete('ok');

    return res.json(body);
  } catch (err) {
    console.error('[QuoxChat] gdpr erase error:', err.message);
    return res.status(500).json({ error: 'Erase failed' });
  }
});

// CAPTCHA #127 — hand-picks the PUBLIC-SAFE subset of embed_config_json
// .bot_protection for the widget-facing /config bootstrap. Never touches
// meta.captcha_secret (that field isn't even read here) — this function is
// the human-proof boundary the "secret never reaches the browser" rule
// depends on. Returns null when unconfigured/disabled/unusable so the
// widget script has one clean falsy check.
function _safeBotProtectionConfig(cfg) {
  const bp = cfg?.bot_protection;
  if (!bp || typeof bp !== 'object' || bp.enabled !== true) return null;
  if (typeof bp.site_key !== 'string' || !bp.site_key) return null;
  return {
    enabled: true,
    provider: bp.provider === 'turnstile' ? 'turnstile' : 'recaptcha_v3',
    site_key: bp.site_key,
    min_score: Number.isFinite(bp.min_score) ? bp.min_score : 0.5,
    guard: bp.guard === 'all' ? 'all' : 'side_effecting',
  };
}

// ── QUOXCHAT-PRO P1 — org alert fan-out ──
// Reads website_widgets.notification_settings_json off the widget meta row
// (internal /meta fetch — this JSON never reaches the browser) and
// dispatches each configured channel through notificationService.
// Settings shape per event key ('new_conversation' / 'handoff_requested'):
//   { enabled: true, channels: [
//       { type: 'email',   to: 'ops@example.com' },
//       { type: 'webhook', url: 'https://...', secret: '...' } ] }
// Any notificationService channel type is accepted (slack/telegram/etc.);
// delivery then depends on the org's stored credentials. Returns the array
// of dispatch promises so tests can await settlement; production callers
// treat it as fire-and-forget.
const ALERT_MAX_CHANNELS = 5;
const ALERT_EVENT_TITLES = {
  new_conversation: 'New QuoxChat conversation',
  handoff_requested: 'QuoxChat human handoff requested',
  // PRO-3 action catalog
  appointment_requested: 'QuoxChat appointment requested',
  demo_requested: 'QuoxChat demo requested',
  message_left: 'QuoxChat message left for the team',
};

// PRO-3 — builtin action tool name → org alert event. Keyed by tool NAME
// (seeded builtins are named after their kind), mirroring the existing
// human_handoff name check above.
const ACTION_ALERT_EVENTS = {
  book_appointment: 'appointment_requested',
  schedule_demo: 'demo_requested',
  leave_message: 'message_left',
};

// PRO-3 — builtin kinds that surface as quick-action chips above the widget
// composer (via GET /config). label renders on the chip; prompt is the guided
// message inserted+sent when clicked, which steers the LLM into the
// structured flow the matching executor expects.
const WIDGET_ACTION_CHIPS = {
  book_appointment: { label: 'Book an appointment', prompt: "I'd like to book an appointment." },
  schedule_demo: { label: 'Schedule a demo', prompt: "I'd like to schedule a demo." },
  leave_message: { label: 'Leave a message', prompt: "I'd like to leave a message for the team." },
  human_handoff: { label: 'Talk to a human', prompt: "I'd like to talk to a human." },
};

// REPLY DETERMINISM — builtin action tools whose executor confirmation must
// win over LLM narration in the visitor-facing reply. Keyed by tool NAME
// (seeded builtins are named after their kind), mirroring ACTION_ALERT_EVENTS.
// lead_capture included (needs_input coverage fix): its executor messages
// (the needs_input ask and the captured confirmation) must not be fought by
// LLM narration either.
const ACTION_REPLY_BUILTINS = new Set(['human_handoff', 'book_appointment', 'schedule_demo', 'leave_message', 'lead_capture']);

// needs_input coverage fix — data-collection builtins whose inline-form
// resubmit (widget sends action + action_input after the visitor fills the
// form) must execute directly, chip-style, even though they have no
// quick-action chip in WIDGET_ACTION_CHIPS. Without this the collected
// values fell through to the LLM flow, which never sees action_input, and
// the visitor's form submission was silently dropped.
const FORM_RESUBMIT_BUILTINS = new Set(['lead_capture', 'book_demo', 'create_ticket']);

// UX HOLES FIX: handed-off gate ack copy. The gate response must never be
// empty: old widgets render `response` directly, new widgets add the status
// strip and delivered tick on top. First message after handoff gets the
// fuller sentence, later ones the short confirmation; a repeat human_handoff
// chip gets the already-queued line instead of re-executing the tool.
const HANDOFF_ACK_FIRST = 'Your message has been passed to the team. A human will reply right here.';
const HANDOFF_ACK_REPEAT = 'Passed to the team.';
const HANDOFF_ALREADY_QUEUED_ACK = 'You are already in the queue. A human will pick up right here.';
// First-vs-repeat tracking is UX copy only (not data): in-memory by design.
// A collector restart harmlessly re-serves the fuller first sentence.
const _handoffAckSeen = new Set();
function handoffAckText(conversationId) {
  if (_handoffAckSeen.has(conversationId)) return HANDOFF_ACK_REPEAT;
  if (_handoffAckSeen.size > 5000) _handoffAckSeen.clear();
  _handoffAckSeen.add(conversationId);
  return HANDOFF_ACK_FIRST;
}

// Codex enum 2 #10/#11: honest handoff status copy.
const HANDOFF_LOOKUP_FAILED_ACK = "Your conversation is with our team, but we could not reach them just now. Please try sending your message again in a moment.";
const HANDOFF_RELAY_TIMEOUT_MS = 4000;

// Persist the visitor message and wait (bounded) for the operator relay, then
// report what is actually true: saved (durable), delivered (reached the
// operator channel). Never throws.
async function settleHandoffState(conversationId, message, relayPromise) {
  let saved = false;
  try {
    const r = await matrixRelay.persistVisitorMessage(conversationId, message);
    saved = !!(r && r.success !== false);
  } catch (e) { console.warn('[QuoxChat] handoff persist failed (non-fatal):', e?.message); }
  let delivered = false;
  if (relayPromise) {
    let timer;
    try {
      delivered = await Promise.race([
        relayPromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), HANDOFF_RELAY_TIMEOUT_MS); }),
      ]);
    } catch { delivered = false; } finally { clearTimeout(timer); }
  }
  return { saved, delivered: !!delivered };
}

function handoffStateLabel(st) {
  if (st.saved && st.delivered) return 'delivered';
  if (st.saved) return 'saved';
  return 'not_saved';
}

function handoffStateAck(st, conversationId, alreadyQueued) {
  if (st.saved && st.delivered) return alreadyQueued ? HANDOFF_ALREADY_QUEUED_ACK : handoffAckText(conversationId);
  if (st.saved) return 'Your message is saved in this conversation, but we could not alert the team just now, so a reply may take a little longer.';
  if (st.delivered) return 'Your message reached the team, but we could not save it to this conversation. If you do not hear back, please send it again.';
  return 'We could not save or deliver your message just now. It has not been saved, so please try sending it again in a moment.';
}

// When an action builtin executed successfully during the turn, return the
// reply the visitor should actually see:
//   - no successful action call (or no confirmation captured): LLM text as-is
//   - LLM text already contains the confirmation (it relayed it): as-is
//   - human_handoff: confirmation REPLACES the narration — a visitor who
//     asked for a human must not get a RAG FAQ recital about handoff features
//   - other actions: confirmation leads, LLM narration follows
function publicSourceTitle(c) {
  const t = typeof c?.text === 'string' ? c.text : '';
  const q = t.match(/^Q:\s*([^\n]{1,140})/);
  if (q) return q[1].trim();
  const src = String(c?.source || '');
  const doc = src.match(/^corpus__(.+?)__[0-9a-f]{8}(\.[A-Za-z0-9]+)?$/);
  const base = doc ? doc[1] : src.replace(/\.[A-Za-z0-9]+$/, '');
  if (!base || /^https?:/i.test(base)) {
    // Crawled pages store the page title as the section.
    const sec = String(c?.section || '').replace(/\s+/g, ' ').trim();
    if (sec && !/^(Page \d+|Chunk \d+\/\d+)$/i.test(sec) && !/^https?:/i.test(sec)) return sec.slice(0, 80);
    return 'Knowledge base';
  }
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (ch) => ch.toUpperCase()).slice(0, 80);
}

const OVERLAP_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'i', 'we', 'you', 'your', 'our', 'my', 'me', 'us', 'it', 'its', 'they', 'them', 'their', 'that', 'this', 'with', 'as', 'by', 'so', 'soon', 'shortly', 'now', 'also', 'just', 'when', 'then', 'thanks', 'thank', 'please', 'get', 'got', 'back', 'up', 'out', 'reference']);
const OVERLAP_SYN = { information: 'detail', info: 'detail', saved: 'record', stored: 'record', recorded: 'record', captured: 'record', logged: 'record', noted: 'record', contact: 'touch', reach: 'touch', respond: 'touch', reply: 'touch', see: 'view', review: 'view', read: 'view', look: 'view' };
function _overlapTokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !OVERLAP_STOP.has(w))
    .map((w) => OVERLAP_SYN[w] || (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .map((w) => OVERLAP_SYN[w] || w);
}
function receiptOverlap(sentence, confirmation) {
  const toks = _overlapTokens(sentence);
  if (!toks.length) return { n: 0, ratio: 0 };
  const conf = new Set(_overlapTokens(confirmation));
  const hit = toks.filter((t) => conf.has(t)).length;
  return { n: toks.length, ratio: hit / toks.length };
}

function applyActionReplyDeterminism(responseText, toolCalls) {
  if (!Array.isArray(toolCalls)) return responseText;
  const actionCall = toolCalls.find((tc) => tc && tc.ok === true
    && ACTION_REPLY_BUILTINS.has(tc.name)
    && typeof tc.result_message === 'string' && tc.result_message.trim());
  if (!actionCall) return responseText;
  const confirmation = actionCall.result_message.trim();
  const narrated = typeof responseText === 'string' ? responseText.trim() : '';
  if (!narrated) return confirmation;
  if (narrated.includes(confirmation)) return responseText;
  if (actionCall.name === 'human_handoff') return confirmation;
  // QUOXCHAT-BRUTALOOP: the model usually narrates the same success the
  // executor just confirmed, so visitors saw it twice (wave-1, both
  // deployments). Drop narration sentences that restate a send/booking;
  // keep any other content the model added.
  const RESTATE_RE = /\b(has|have) been (sent|passed|forwarded|booked|scheduled|recorded|received|submitted|shared|noted|requested)\b|\b(I'?ve|I have|we'?ve|we have) (sent|passed|forwarded|booked|scheduled|recorded|shared|noted|submitted|requested|got)\b|\b(is|are) (now )?with (the|our) team\b|\bwill (be in touch|get back to you|reach out|contact you|follow up)\b/i;
  // QC-BRUTALOOP-W13: "your details are saved" / "I've saved ..." restatements
  // of a data-collection tool, and any sentence that repeats the reference the
  // confirmation already printed.
  const RESTATE_SAVED_RE = /\b(has|have) been (saved|stored|captured|logged|added|taken down)\b|\b(your|the) (details|information|info|message|request|enquiry|inquiry|email|contact details|booking|reference) (is|are|was|were) (now |all )?(saved|stored|captured|recorded|logged|noted|received|safe)\b|\b(I'?ve|I have|we'?ve|we have) (saved|stored|captured|logged|added|taken|noted)\b/i;
  // QC-BRUTALOOP-W14b: when the action is asking for a missing detail, the
  // model often asks for it again in its own words ("Could you please provide
  // your email address as well?"), so the visitor got the question twice.
  const asked = actionCall.needs_input && Array.isArray(actionCall.needs_input.fields)
    ? actionCall.needs_input.fields.map((f) => String(f?.name || '').toLowerCase()).filter(Boolean) : [];
  const FIELD_WORDS = { email: 'e-?mail', phone: 'phone|number|mobile', preferred_time: 'time|when', message: 'message', subject: 'issue|subject', description: 'details' };
  const askWords = asked.map((n) => FIELD_WORDS[n] || n.replace(/_/g, ' ')).join('|');
  const REASK_RE = askWords ? new RegExp(`\\b(provide|share|give|send|let me know|tell me|what'?s|what is|could you|can you|please)\\b.*\\b(${askWords})\\b|\\b(${askWords})\\b.*\\?\\s*$`, 'i') : null;
  const refTokens = (confirmation.match(/\b[A-Z0-9]{2,}(?:-[A-Z0-9]+)+\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b/g) || []);
  // W15: emails, domains and decimals are not sentence boundaries. Mask their
  // dots before splitting so "reply to a@example.com." stays one sentence.
  const DOT = '\u0001';
  const masked = narrated.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b|\d+\.\d+/g, (m) => {
    // keep a trailing sentence-final dot out of the mask
    return m.replace(/\./g, DOT);
  });
  const kept = (masked.match(/[^.!?\n]+[.!?]*\s*/g) || [masked]).map((sn) => sn.split(DOT).join('.'))
    // A leftover fragment under 3 words that does not start with a capital is
    // debris from a mid-token split, never content.
    .filter((sn) => /^\s*[A-Z0-9]/.test(sn) || sn.trim().split(/\s+/).length >= 3)
    .filter((sn) => !RESTATE_RE.test(sn) && !RESTATE_SAVED_RE.test(sn) && !refTokens.some((t) => sn.includes(t)))
    .filter((sn) => !(REASK_RE && REASK_RE.test(sn)))
    // QC-BRUTALOOP-W17: a paraphrase of the receipt that dodges the regexes
    // ("Your details have been recorded and the team will see them soon") is
    // still the receipt twice. Drop sentences whose content tokens are mostly
    // the confirmation's own (>= 0.6, at least 3 content tokens).
    .filter((sn) => { const ov = receiptOverlap(sn, confirmation); return !(ov.n >= 3 && ov.ratio >= 0.6); })
    // A bare "Thanks!" ack duplicates the confirmation's own ("Thanks! We've got your details").
    .filter((sn) => !(/^\s*(?:thanks|thank\s+you)\b/i.test(confirmation) && /^\s*(?:thanks|thank\s+you)\b[^.!?\n]{0,40}[.!]*\s*$/i.test(sn)))
    .join('')
    .trim();
  return kept ? confirmation + '\n\n' + kept : confirmation;
}

function notifyWidgetChannels(meta, event, data) {
  if (!meta || !data) return [];
  let settings = meta.notification_settings_json;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch { return []; }
  }
  const evtCfg = settings && typeof settings === 'object' ? settings[event] : null;
  if (!evtCfg || evtCfg.enabled !== true || !Array.isArray(evtCfg.channels)) return [];

  const widgetName = meta.name || data.widget_id || 'widget';
  const title = `${ALERT_EVENT_TITLES[event] || 'QuoxChat event'}: ${widgetName}`;
  // QUOXCHAT-PRO visitor name: alert recipients see who is asking, not a
  // raw visitor id (which stays in parentheses for lookup).
  const visitorLine = data.visitor_name
    ? `${data.visitor_name} (${data.visitor_id || 'anon'})`
    : (data.visitor_id || 'anon');
  const lines = [
    `Event: ${event}`,
    `Widget: ${widgetName} (${data.widget_id || meta.id})`,
    `Conversation: ${data.conversation_id || 'unknown'}`,
    `Visitor: ${visitorLine}`,
  ];
  if (data.page_url) lines.push(`Page: ${data.page_url}`);
  if (data.first_message) lines.push('', 'First message:', data.first_message);
  const message = lines.join('\n');
  const priority = event === 'handoff_requested' ? 'high' : 'normal';

  const dispatched = [];
  for (const ch of evtCfg.channels.slice(0, ALERT_MAX_CHANNELS)) {
    if (!ch || typeof ch !== 'object' || typeof ch.type !== 'string') continue;
    const input = {
      channel: ch.type,
      recipient: ch.to || ch.recipient || ch.url || ch.chat_id || null,
      title,
      message,
      priority,
      orgId: meta.org_id || 'default',
    };
    // Per-widget webhook URLs ride as a credentials override so a globally
    // configured NOTIFICATION_WEBHOOK_URL can never hijack them (the webhook
    // driver prefers credentials.url over recipient).
    if (ch.type === 'webhook' && (ch.url || ch.recipient)) {
      input.credentials = { url: ch.url || ch.recipient, secret: ch.secret || '' };
    }
    dispatched.push(
      Promise.resolve()
        .then(() => _sendAlertNotification(input))
        .then((r) => {
          if (!r || r.success !== true) console.warn(`[QuoxChat] org alert ${event}/${ch.type} not delivered:`, (r && r.error) || 'unknown');
          return r;
        })
        .catch((e) => {
          console.warn(`[QuoxChat] org alert ${event}/${ch.type} failed:`, e?.message);
          return { success: false, error: String(e?.message || e) };
        }),
    );
  }
  return dispatched;
}

// Indirection so tests can stub the notification sink without monkeypatching
// the notificationService module cache.
let _sendAlertNotification = sendNotification;
function _setAlertNotificationSink(fn) {
  _sendAlertNotification = typeof fn === 'function' ? fn : sendNotification;
}

// Wave 6 defect 15: last good public config per widget, served when the auth meta fetch times out.
const _lastGoodWidgetConfig = new Map();

// P-V — Professional feature flags for /config. Enforcement off (pre-cutover
// install) behaves like the knowledge quota: not capped. Any lookup failure
// fails CLOSED (feature off), never open.
async function resolveProFeatures(orgId) {
  const off = { voice: false, proactive: false };
  if (!orgId) return off;
  if (!quoxchatLicenceEnforced()) return { voice: true, proactive: true };
  try {
    const pro = await isPluginLicensedForOrg(orgId, 'quoxchat-pro');
    return pro ? { voice: true, proactive: true } : off;
  } catch { return off; }
}

router.get('/config/:publicKey', async (req, res) => {
  const id = req.params.publicKey;
  const stub = {
    status: 'ok',
    widget: {
      id,
      name: 'Chat with us',
      greeting: 'Hi! How can I help?',
      greeting_variants: [],
      theme: 'auto',
      avatar_url: null,
      accent_color: null,
      style_overrides: '',
      // QCX-6e — Art.52 transparency disclosure + privacy/DPA links.
      ai_disclosure_text: ART52_DEFAULT,
      privacy_policy_url: null,
      dpa_url: null,
      // QCX-6k — pre-message consent.
      consent_required: false,
      consent_text: null,
      // CAPTCHA #127 — OFF BY DEFAULT: null unless the widget configured it.
      bot_protection: null,
      // QUOXCHAT-PRO P1 — human availability. Public-safe booleans only
      // (never the raw office_hours_json or notification settings). Only
      // affects human-handoff expectations; the AI answers regardless.
      availability: { operator_online: true, within_office_hours: true, human_available: true },
      // PRO-3 — quick-action chips: ENABLED builtin actions only (public-safe
      // kind/label/prompt triples; never tool configs or schemas).
      actions: [],
      // P-V — Professional-only, so the neutral stub carries none.
      proactive: [],
      features: { voice: false, proactive: false },
    },
  };
  if (!id || id === 'demo') return res.json(stub);
  const meta = await fetchWidgetMeta(id).catch(() => null);
  if (!meta) {
    // Wave 6 defect 15: an auth timeout used to serve operator_online:true.
    // Serve the last good config for this widget; with none cached, the stub
    // must not claim a human is available.
    const last = _lastGoodWidgetConfig.get(id);
    if (last) return res.json(last);
    stub.widget.availability = { operator_online: false, within_office_hours: false, human_available: false };
    return res.json(stub);
  }
  const _origJson = res.json.bind(res);
  res.json = (body) => {
    if (body && body.status === 'ok' && body.widget) {
      _lastGoodWidgetConfig.set(id, body);
      if (_lastGoodWidgetConfig.size > 2000) _lastGoodWidgetConfig.delete(_lastGoodWidgetConfig.keys().next().value);
    }
    return _origJson(body);
  };
  // PRO-3 — expose the widget's enabled builtin actions as composer chips.
  // fetchWidgetTools accepts the public key (CW-SEC-1) and only ever returns
  // status='active' rows, so a seeded-but-disabled action never surfaces.
  try {
    const tools = await fetchWidgetTools(id);
    stub.widget.actions = tools
      .filter((t) => t && t.tool_type === 'builtin' && WIDGET_ACTION_CHIPS[t.builtin_kind])
      .map((t) => ({ kind: t.builtin_kind, ...WIDGET_ACTION_CHIPS[t.builtin_kind] }))
      .slice(0, 4);
  } catch { /* chips are best-effort; config stays usable */ }
  // QUOXCHAT-PRO P1 — evaluated server-side (operator_online toggle AND the
  // office-hours schedule in the widget's configured timezone) so the widget
  // needs zero timezone math. Attached to the stub too so a widget with no
  // embed_config still gets a real availability verdict.
  stub.widget.availability = evaluateAvailability(meta);
  // P-V — voice + proactive engagement are `quoxchat-pro` features. The org
  // is derived from the widget server-side, never from the request.
  const proFeatures = await resolveProFeatures(meta.org_id);
  stub.widget.features = proFeatures;
  let cfg = meta.embed_config_json;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch { cfg = null; }
  }
  if (!cfg || typeof cfg !== 'object') return res.json(stub);
  const variants = Array.isArray(cfg.greeting_variants)
    ? cfg.greeting_variants.filter((v) => typeof v === 'string' && v.length > 0).slice(0, 8)
    : [];
  return res.json({
    status: 'ok',
    widget: {
      id,
      name: typeof cfg.widget_name === 'string' && cfg.widget_name ? cfg.widget_name : stub.widget.name,
      greeting: typeof cfg.greeting === 'string' && cfg.greeting ? cfg.greeting : stub.widget.greeting,
      greeting_variants: variants,
      theme: _normalizeWidgetTheme(cfg.theme),
      avatar_url: _safeAvatarUrl(cfg.avatar_url),
      accent_color: typeof cfg.accent_color === 'string' ? cfg.accent_color : null,
      // QCX-5g: arbitrary CSS overrides scrubbed of </style>/<script>/js URIs.
      style_overrides: sanitiseStyleOverrides(cfg.style_overrides),
      // QCX-6e — Art.52 + GDPR transparency.
      ai_disclosure_text: _sanitiseDisclosureText(cfg.ai_disclosure_text),
      privacy_policy_url: _safePolicyUrl(cfg.privacy_policy_url),
      dpa_url: _safePolicyUrl(cfg.dpa_url),
      // QCX-6k — pre-message consent banner. Same sanitiser as the
      // Art.52 disclosure — strips markup, caps length, defaults null
      // when the admin hasn't customised it (widget renders default copy).
      consent_required: cfg.consent_required === true,
      consent_text: typeof cfg.consent_text === 'string' && cfg.consent_text.length > 0
        ? _sanitiseDisclosureText(cfg.consent_text)
        : null,
      // CAPTCHA #127 — public-safe subset only (never meta.captcha_secret).
      bot_protection: _safeBotProtectionConfig(cfg),
      // QUOXCHAT-PRO P1 — human availability (see stub above).
      availability: stub.widget.availability,
      // PRO-3 — quick-action chips (see stub above).
      actions: stub.widget.actions,
      // P-V — Professional-only. Standard orgs get empty/false here even if
      // their stored embed_config carries rules (downgrade is honoured).
      features: proFeatures,
      proactive: proFeatures.proactive ? sanitiseProactiveRules(cfg.proactive) : [],
    },
  });
});

// ── QUOXCHAT-PRO P0 — visitor-initiated "email me this transcript" ──
// The email_transcript builtin (quoxchatToolExecutors.emailTranscript) was
// LLM-tool-only; this thin endpoint exposes the SAME executor to the widget
// footer button. Every gate the executor already enforces still applies:
// reCAPTCHA v3 verification (action "email_transcript", env-configured, OFF
// BY DEFAULT — no secret means the action always denies), recipient locked
// server-side to the visitor's own identified email (nothing in this request
// body is trusted for the recipient), one send per conversation (in-process
// belt + durable auth-side braces). The LLM tool-policy gate (executeTool's
// default-deny for side-effecting tools) is deliberately NOT applied here:
// that gate exists to stop the MODEL from triggering side effects — this
// path is a direct visitor click, guarded by captcha + self-only recipient.
router.post('/transcript/email', rateLimit, captchaFallbackTranscriptLimit, domainGuard, licenseGuard, async (req, res) => {
  try {
    const { widget_id: rawWidgetId, visitor_id, conversation_id, captcha_token } = req.body || {};
    if (!rawWidgetId || !visitor_id || !conversation_id) {
      return res.status(400).json({ success: false, error: 'widget_id, visitor_id and conversation_id are required' });
    }
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);
    const meta = await fetchWidgetMeta(widget_id);
    if (!meta) return res.status(404).json({ success: false, error: 'widget_not_found' });

    // QUOXCHAT-EMAIL P2/P3 — the button path converges on the per-widget
    // bot_protection captcha (#127), same config and secret the /message
    // gate verifies. The legacy env-keyed transcript captcha is retired.
    // undefined = widget has no bot_protection → the executor's trust
    // matrix denies untrusted (chat/declared) recipients with an
    // operator-facing reason; identify-sourced recipients still send.
    let humanVerified;
    try {
      let cfg = meta?.embed_config_json;
      try {
        cfg = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
      } catch {
        // Corrupt config hides intent — fail CLOSED, same as the /message gate.
        cfg = null;
        humanVerified = false;
      }
      const bp = cfg?.bot_protection;
      if (bp && typeof bp === 'object' && bp.enabled === true) {
        const secret = meta?.captcha_secret || null;
        const verdict = secret
          ? await verifyCaptchaToken({
              provider: bp.provider === 'turnstile' ? 'turnstile' : 'recaptcha_v3',
              token: typeof captcha_token === 'string' ? captcha_token : null,
              secret,
              remoteip: req.ip,
              min_score: Number.isFinite(bp.min_score) ? bp.min_score : 0.5,
              expectedAction: 'quoxchat_message',
            })
          : { ok: false, reason: 'no_secret_configured' };
        humanVerified = verdict.ok === true;
      }
    } catch (bpErr) {
      // An error where the gate was designed reads as NOT verified.
      humanVerified = false;
      console.warn('[QuoxChat] transcript button bot_protection gate error — failing CLOSED:', bpErr?.message || bpErr);
    }

    // Resolve the visitor's own identified email SERVER-SIDE — same source
    // as the /message tool loop (widget_visitors.identified_attrs_json).
    let identifiedEmail = null;
    let identifiedEmailSource = null;
    let visitorVerified = false;
    try {
      const upsert = await upsertVisitorMemory(widget_id, { visitor_id });
      const attrs = upsert?.visitor?.identified_attrs;
      if (attrs && typeof attrs.email === 'string') identifiedEmail = attrs.email;
      if (attrs && typeof attrs.email_source === 'string') identifiedEmailSource = attrs.email_source;
      visitorVerified = upsert?.visitor?.verified === true;
    } catch { /* stays null → executor returns visitor_email_unknown */ }

    const result = await emailTranscript({
      widget: { id: widget_id, org_id: meta.org_id },
      input: {},
      context: {
        conversation_id,
        visitor_id,
        identified_email: identifiedEmail,
        identified_email_source: identifiedEmailSource,
        verified: visitorVerified,
        human_verified: humanVerified,
      },
    });

    // Witness the attempt on the audit trail — outcome only, never the token
    // or the raw email address.
    try {
      _storeAuditEnvelope(buildWidgetEnvelope({
        intent: WIDGET_INTENTS.TOOL_COMPLETED,
        visitor_id: visitor_id || 'anon',
        widget_id,
        payload: {
          tool: 'email_transcript',
          via: 'widget_button',
          ok: result?.ok === true,
          reason: result?.ok === true ? 'sent' : (result?.reason || result?.error || 'failed'),
        },
      }));
    } catch { /* non-fatal — audit must never break the endpoint */ }

    if (result?.ok === true) {
      return res.json({ success: true, sent: true, masked_email: result.result?.masked_email || null, message: result.result?.message || 'Transcript sent.' });
    }
    // Wave 5 F6: executor messages are written for the model ("ask the
    // visitor ... call this tool again"); the button endpoint answers the
    // visitor in plain language instead.
    const VISITOR_TRANSCRIPT_MESSAGES = {
      visitor_email_unknown: 'We do not have your email address yet. Type it in the chat, then press the transcript button again.',
    };
    const errCode = result?.error || 'send_failed';
    return res.json({
      success: false,
      error: errCode,
      message: VISITOR_TRANSCRIPT_MESSAGES[errCode] || (/\btool\b|ask the visitor/i.test(result?.message || '') ? 'The transcript could not be emailed right now.' : (result?.message || 'The transcript could not be emailed right now.')),
    });
  } catch (err) {
    console.error('[QuoxChat] /transcript/email error:', err.message);
    res.status(500).json({ success: false, error: 'internal_error', message: 'The transcript could not be emailed right now. Please try again in a moment.' });
  }
});

// ── First-seen (CW-8.9.2) ──
// Called by the public widget loader once when it first mounts on a domain.
// Proxies to auth internal endpoint (public loader cannot hold the service key).
router.post('/first-seen', async (req, res) => {
  try {
    const { public_key } = req.body || {};
    if (!public_key) return res.status(400).json({ error: 'public_key required' });
    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) return res.json({ success: false, skipped: 'no_service_key' });
    const r = await fetch(`${authUrl}/api/internal/widgets/by-public-key/${encodeURIComponent(public_key)}/first-seen`, {
      method: 'POST',
      headers: { 'x-service-key': serviceKey, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    res.json({ success: r.ok });
  } catch (err) {
    console.warn('[QuoxChat] first-seen proxy failed:', err.message);
    res.json({ success: false });
  }
});

// ── Session ──
router.get('/session', (req, res) => {
  const visitorId = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  res.json({ visitor_id: visitorId, created: new Date().toISOString() });
});

// ── QC-HOLES: visitor handoff state (widget boot check) ──
// The handed-off gate binds (widget, visitor) for 24h, so a returning
// visitor with an open handoff was silently re-attached to it behind a
// fresh-looking chat. This lets the widget ASK the visitor instead:
// continue with the team, or start fresh.
router.get('/handoff-state', pollRateLimit, pollQueryShim, domainGuard, async (req, res) => {
  try {
    const { widget_id: rawWidgetId, visitor_id } = req.query;
    if (!rawWidgetId || !visitor_id) return res.status(400).json({ error: 'widget_id and visitor_id required' });
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);
    const conv = await matrixRelay.lookupHandoffConversation(widget_id, String(visitor_id));
    if (!conv) return res.json({ open: false });
    res.json({
      open: true,
      conversation_id: conv.conversation_id,
      operator_joined: !!conv.operator_joined_at,
    });
  } catch (err) {
    // Fail-closed to "no open handoff": the gate still applies on send.
    res.json({ open: false });
  }
});

// ── QC-HOLES: visitor-scoped conversation close (widget "Start new chat") ──
// The handed-off gate matches by (widget, visitor), NOT conversation id, so a
// local-only reset left the visitor hijacked back into the old handed-off
// conversation on their next message. This lets the widget end its own
// conversation; auth enforces the (widget, visitor) pair server-side, so a
// leaked conversation id alone closes nothing. Not licence-gated: escaping a
// stuck conversation must always work.
router.post('/conversation/close', pollRateLimit, domainGuard, async (req, res) => {
  try {
    const { widget_id: rawWidgetId, visitor_id, conversation_id } = req.body || {};
    if (!rawWidgetId || !visitor_id || !conversation_id) {
      return res.status(400).json({ error: 'widget_id, visitor_id and conversation_id required' });
    }
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);
    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) return res.status(503).json({ error: 'service_unavailable' });
    const resp = await fetch(`${authUrl}/api/internal/widget-conversations/${encodeURIComponent(conversation_id)}/visitor-close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify({ widget_id, visitor_id }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(resp.status === 404 ? 404 : 502).json({ error: data.error || 'close_failed' });
    res.json({ success: true, conversation_id, status: data.status || 'closed' });
  } catch (err) {
    console.warn('[QuoxChat] visitor close failed:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Feedback ──
// Wave 5 product (w5h): the visitor rating is PERSISTED on the conversation
// (auth widget_conversations.visitor_rating), which is what the Analytics
// Satisfaction stat and the Logs rating filter read. It used to write only an
// audit envelope, so Satisfaction could never populate. Ratings are +1 / -1;
// 'up'/'positive'/1..5 stars >= 4 map to +1, 'down'/'negative'/<= 2 to -1.
function normaliseFeedbackRating(raw) {
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (['up', 'positive', 'thumbs_up', 'thumbsup', 'like', 'good'].includes(t)) return 1;
    if (['down', 'negative', 'thumbs_down', 'thumbsdown', 'dislike', 'bad'].includes(t)) return -1;
    if (/^-?\d+(\.\d+)?$/.test(t)) raw = Number(t); else return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw >= 4) return 1;
  if (raw === 1) return 1; // bare 1 is a thumbs up, not a one-star rating
  if (raw < 0 || raw === 2) return -1;
  return null; // 0 and 3 are neutral: nothing to store
}

router.post('/feedback', rateLimit, domainGuard, async (req, res) => {
  const { widget_id, visitor_id, conversation_id, rating, message_id } = req.body || {};
  const norm = normaliseFeedbackRating(rating);
  if (!widget_id || !visitor_id || !conversation_id || norm === null) {
    return res.status(400).json({ success: false, error: 'invalid_feedback', message: 'widget_id, visitor_id, conversation_id and a positive or negative rating are required.' });
  }
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return res.status(503).json({ success: false, error: 'feedback_unavailable' });
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/conversations/${encodeURIComponent(conversation_id)}/rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify({ visitor_id: String(visitor_id), rating: norm }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      const status = resp.status === 404 ? 404 : 502;
      return res.status(status).json({ success: false, error: status === 404 ? 'conversation_not_found' : 'feedback_failed' });
    }
  } catch (err) {
    console.warn('[QuoxChat] feedback persist failed:', err.message);
    return res.status(502).json({ success: false, error: 'feedback_failed' });
  }
  try {
    _storeAuditEnvelope({ type: 'event', from: 'widget.visitor', to: 'agent.quoxchat', intent: 'quoxchat.feedback', payload: { conversation_id, rating: norm, message_id } });
  } catch { /* non-fatal */ }
  res.json({ success: true, rating: norm });
});

// ── CW-SEC-1: resolve public_key or internal id to canonical internal id ──
// Customer-site embed uses public_key; admin test panel uses internal id.
// Both hit the same endpoints — normalize so Qdrant collection + persist
// calls key off a single canonical id per widget.
const _widgetIdCache = new Map(); // key → { id, expires }
const WIDGET_ID_CACHE_TTL_MS = 30_000;

async function resolveCanonicalWidgetId(widgetIdOrPublicKey) {
  if (!widgetIdOrPublicKey || widgetIdOrPublicKey === 'demo') return widgetIdOrPublicKey;
  const now = Date.now();
  const cached = _widgetIdCache.get(widgetIdOrPublicKey);
  if (cached && cached.expires > now) return cached.id;

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return widgetIdOrPublicKey;

  try {
    // Reuse the allowed-domains endpoint (accepts either form since CW-SEC-1
    // and returns the canonical internal id as widget_id).
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetIdOrPublicKey)}/allowed-domains`, {
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return widgetIdOrPublicKey;
    const data = await resp.json().catch(() => ({}));
    const canonical = data.widget_id || widgetIdOrPublicKey;
    _widgetIdCache.set(widgetIdOrPublicKey, { id: canonical, expires: now + WIDGET_ID_CACHE_TTL_MS });
    if (canonical !== widgetIdOrPublicKey) {
      _widgetIdCache.set(canonical, { id: canonical, expires: now + WIDGET_ID_CACHE_TTL_MS });
    }
    return canonical;
  } catch {
    return widgetIdOrPublicKey;
  }
}

// QCL-SECURITY P2-1: resolve the Qdrant API key, refusing the hardcoded
// 'dev-qdrant-key' default in production. Mirrors the existing
// "INTERNAL_SERVICE_KEY not configured → refuse" pattern (auth
// widgets.js:1662) — a source-visible fallback key reachable in prod would
// let anyone with repo access reach every widget's vector store. Local/dev
// keeps the convenience default so `docker compose up` works out of the box.
function resolveQdrantKey() {
  const key = process.env.QDRANT_API_KEY;
  if (key) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('QDRANT_API_KEY not configured — refusing to use the dev-qdrant-key default in production');
  }
  return 'dev-qdrant-key';
}

// ── Per-widget Qdrant namespace (CW-8.15) ──
// Derived from the canonical internal widget id — no schema change.
// 'demo' or null widget_id falls back to the legacy shared collection.
function qdrantCollectionForWidget(widgetId) {
  if (!widgetId || widgetId === 'demo') return 'quoxchat_demo';
  // Qdrant collection names: alphanumeric + _ / - only. ULID is alphanumeric.
  return `qc_${String(widgetId).toLowerCase()}`;
}

// Ensure a Qdrant collection exists. Idempotent — PUT with exists is a no-op error we swallow.
// Called before every upsert so new widgets auto-provision on first use.
const QDRANT_VECTOR_SIZE = 768; // gemini-embedding-001
const _collectionEnsured = new Set();
async function ensureQdrantCollection(collection, qdrantKey) {
  if (_collectionEnsured.has(collection)) return true;
  try {
    const resp = await fetch(`http://qdrant:6333/collections/${collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify({ vectors: { size: QDRANT_VECTOR_SIZE, distance: 'Cosine' } }),
      signal: AbortSignal.timeout(5000),
    });
    // 200 = created, 409/400 with "already exists" = OK, other = log and try anyway.
    if (resp.ok) {
      console.log(`[QuoxChat] Qdrant collection created: ${collection}`);
    } else if (resp.status !== 409) {
      const txt = await resp.text().catch(() => '');
      if (!/already exists/i.test(txt)) {
        console.warn(`[QuoxChat] Qdrant collection ensure: ${collection} returned ${resp.status} ${txt.slice(0, 120)}`);
      }
    }
    _collectionEnsured.add(collection);
    return true;
  } catch (err) {
    console.warn(`[QuoxChat] Qdrant collection ensure failed (non-fatal): ${err.message}`);
    return false;
  }
}

// ── PERSIST-TRUTH — Purge a widget's Qdrant collection (CW-delete-cascade) ──
// Called by auth's widget-delete handler so orphaned embedded customer
// content doesn't survive a widget delete indefinitely. Service-key gated.
// Refuses to touch the shared 'quoxchat_demo' collection — that collection
// is used by every demo/null-widget request and must never be dropped by a
// single widget's delete. Idempotent: Qdrant 404 (already gone) is success.
router.delete('/internal/widget-knowledge/:widgetId', async (req, res) => {
  const sk = req.headers['x-service-key'];
  if (!sk || sk !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { widgetId } = req.params;
  if (!widgetId) return res.status(400).json({ error: 'missing_widget_id' });

  const collection = qdrantCollectionForWidget(widgetId);
  if (collection === 'quoxchat_demo') {
    return res.status(400).json({ success: false, error: 'refused_shared_collection', collection });
  }

  try {
    const qdrantKey = resolveQdrantKey();
    const resp = await fetch(`http://qdrant:6333/collections/${collection}`, {
      method: 'DELETE',
      headers: { 'api-key': qdrantKey },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      _collectionEnsured.delete(collection);
      return res.json({ success: true, collection, deleted: true });
    }
    if (resp.status === 404) {
      // Already gone — idempotent success, not an error.
      _collectionEnsured.delete(collection);
      return res.json({ success: true, collection, deleted: false });
    }
    const txt = await resp.text().catch(() => '');
    console.warn(`[QuoxChat] Qdrant collection delete failed: ${collection} -> ${resp.status} ${txt.slice(0, 200)}`);
    return res.status(502).json({ success: false, collection, error: 'qdrant_delete_failed', status: resp.status });
  } catch (err) {
    console.error(`[QuoxChat] Qdrant collection delete error: ${collection}: ${err.message}`);
    return res.status(502).json({ success: false, collection, error: 'qdrant_delete_error', message: err.message });
  }
});

// ── QCX-3.2 — Visitor memory upsert (auth-side persistence) ──
// Called from /events/visitor-identified (with attrs) and from /message
// (bump_conversation). Returns {visitor, summary} — summary is the short
// "returning visitor" preamble for injection into the LLM system prompt.
async function upsertVisitorMemory(widgetIdOrKey, { visitor_id, attrs, bump_conversation, verified, external_user_id, action_quota_override, limit_attrs_signed }) {
  if (!widgetIdOrKey || !visitor_id || visitor_id === 'anon') return null;
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return null;
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetIdOrKey)}/visitors/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify({
        visitor_id,
        attrs: attrs || null,
        bump_conversation: !!bump_conversation,
        // QCL-IDENTITY P1: verified/external_user_id default false/null on
        // calls that don't carry a hash (e.g. the /message bump_conversation
        // call) — auth-side upsert is monotonic and never downgrades an
        // already-verified visitor from these defaults.
        verified: !!verified,
        external_user_id: external_user_id || null,
        // QCX-ACTIONS P2 — omitted unless a verified identify carried it.
        // QCL-IDENTITY P2: auth persists the override only when this is true.
        ...(action_quota_override !== undefined ? { action_quota_override, limit_attrs_signed: limit_attrs_signed === true } : {}),
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch { return null; }
}

// ── CW-FU — Look up widget (org_id + created_by) so we can file_object ──
// QUOXCHAT-BRUTALOOP ITER6: like fetchWidgetMeta, but tells "no such widget"
// (404) apart from "auth could not answer" (network error, timeout, 5xx), so
// the licence gate never reports a transient outage as LICENSE_REQUIRED.
// A widget's org never changes, so the licence gate keeps the last good
// lookup: fresh for 60s, then served STALE for up to 10 minutes while auth is
// slow or restarting (same grace the licence cache already has). Without it,
// every auth hiccup refused real visitors ("could not verify this chat").
const _widgetOrgCache = new Map(); // widgetId -> { meta, fetchedAt }
const WIDGET_ORG_FRESH_MS = 60_000;
const WIDGET_ORG_STALE_MS = 10 * 60_000;

async function fetchWidgetMetaVerdict(widgetId) {
  if (!widgetId || widgetId === 'demo') return { meta: null, unavailable: false };
  const cached = _widgetOrgCache.get(widgetId);
  if (cached && Date.now() - cached.fetchedAt < WIDGET_ORG_FRESH_MS) return { meta: cached.meta, unavailable: false, cached: true };
  const live = await _fetchWidgetMetaVerdictLive(widgetId);
  if (live.meta?.org_id) {
    _widgetOrgCache.set(widgetId, { meta: { id: live.meta.id, org_id: live.meta.org_id }, fetchedAt: Date.now() });
    if (_widgetOrgCache.size > 5000) _widgetOrgCache.delete(_widgetOrgCache.keys().next().value);
    return live;
  }
  if (live.unavailable && cached && Date.now() - cached.fetchedAt < WIDGET_ORG_FRESH_MS + WIDGET_ORG_STALE_MS) {
    console.warn(`[QuoxChat] widget lookup unavailable for ${widgetId}; serving last known org (stale grace)`);
    return { meta: cached.meta, unavailable: false, stale: true };
  }
  if (!live.unavailable) _widgetOrgCache.delete(widgetId); // 404: the widget is gone
  return live;
}

async function _fetchWidgetMetaVerdictLive(widgetId) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return { meta: null, unavailable: true };
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/meta`, {
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.status >= 500 || resp.status === 429) return { meta: null, unavailable: true };
    if (!resp.ok) return { meta: null, unavailable: false };
    return { meta: await resp.json().catch(() => null), unavailable: false };
  } catch { return { meta: null, unavailable: true }; }
}

async function fetchWidgetMeta(widgetId) {
  if (!widgetId || widgetId === 'demo') return null;
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return null;
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/meta`, {
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch { return null; }
}

// ── CW-FU — Stash uploaded blob into file_objects ──
// Collector → auth internal upload endpoint. Returns the new file_object_id
// so persistKnowledgeSource can thread it into widget_knowledge_sources.
async function persistFileObject({ orgId, createdBy, namespace, sourcePlugin, sourceRef, filename, mime, buffer, metadata }) {
  if (!orgId || !createdBy || !namespace || !buffer) return null;
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return null;
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'file');
    form.append('org_id', orgId);
    form.append('created_by', createdBy);
    form.append('namespace', namespace);
    if (sourcePlugin) form.append('source_plugin', sourcePlugin);
    if (sourceRef) form.append('source_ref', sourceRef);
    if (metadata) form.append('metadata', JSON.stringify(metadata));
    const resp = await fetch(`${authUrl}/api/internal/files/upload`, {
      method: 'POST',
      headers: { 'x-service-key': serviceKey },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[QuoxChat] file_objects upload returned ${resp.status}`);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    return data.id || null;
  } catch (err) {
    console.warn('[QuoxChat] file_objects upload failed (non-fatal):', err.message);
    return null;
  }
}

// ── QUOXCHAT-BRUTALOOP ITER7 — knowledge storage quota ──
// Published limit (quox-website PricingPage): 1 GB on Standard, 5 GB on
// Professional (decimal GB, as published). ONE map; a tier absent from it
// (unknown, enterprise, enforcement off) is uncapped. Scope is per ORG across
// all its widgets (the licence is per org; the copy sells unlimited widgets).
// Tier mapping: org holds the `quoxchat-pro` entitlement -> professional,
// else holds `quoxchat` -> standard. (has-plugin's own `tier` field is the
// generic tier_a/b/c and does not distinguish the QuoxChat plans.)
const KNOWLEDGE_STORAGE_LIMITS_BYTES = {
  standard: 1_000_000_000,
  professional: 5_000_000_000,
};

async function resolveKnowledgeTier(orgId) {
  if (!orgId || !quoxchatLicenceEnforced()) return null;
  if (await isPluginLicensedForOrg(orgId, 'quoxchat-pro')) return 'professional';
  if (await isPluginLicensedForOrg(orgId, 'quoxchat')) return 'standard';
  return null;
}

async function fetchKnowledgeUsage(widgetId) {
  if (!widgetId || widgetId === 'demo') return null;
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return null;
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/knowledge-usage`, {
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return data && Number.isFinite(data.bytes) ? data : null;
  } catch { return null; }
}

// Returns { usage, tier, limit } (limit null = uncapped / unknown).
async function knowledgeQuotaState(widgetId) {
  const usage = await fetchKnowledgeUsage(widgetId);
  if (!usage) return { usage: null, tier: null, limit: null };
  let tier = null;
  try { tier = await resolveKnowledgeTier(usage.org_id); } catch { tier = null; }
  const limit = tier && KNOWLEDGE_STORAGE_LIMITS_BYTES[tier] ? KNOWLEDGE_STORAGE_LIMITS_BYTES[tier] : null;
  return { usage, tier, limit };
}

// Sends the 413 and returns true when used + incoming would exceed the cap.
// Quota is a plan limit, not a security gate: if usage cannot be read it
// fails OPEN with a warning (the licence gate before it already fails closed).
async function rejectIfKnowledgeQuotaExceeded(res, widgetId, incomingBytes) {
  const { usage, tier, limit } = await knowledgeQuotaState(widgetId);
  if (!usage) { console.warn(`[QuoxChat] knowledge quota: usage unavailable for widget=${widgetId} — not enforcing`); return false; }
  if (!limit) return false;
  if (usage.bytes + incomingBytes <= limit) return false;
  res.status(413).json({ error: 'knowledge_quota_exceeded', used_bytes: usage.bytes, limit_bytes: limit, tier });
  return true;
}

// ── Knowledge source persistence (CW-8.13) ──
// Writes a row into widget_knowledge_sources via the auth internal router.
// Non-fatal: Qdrant chunks exist regardless of whether this succeeds.
async function persistKnowledgeSource(widgetId, body) {
  if (!widgetId || widgetId === 'demo') return null;
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) {
    console.warn('[QuoxChat] INTERNAL_SERVICE_KEY not set — skipping knowledge source persist');
    return null;
  }
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/knowledge-sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      console.warn(`[QuoxChat] knowledge-sources persist returned ${resp.status}`);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    return data.id || null;
  } catch (err) {
    console.warn('[QuoxChat] knowledge-sources persist failed (non-fatal):', err.message);
    return null;
  }
}

// ── Knowledge Upload (CW-8.3) ──
const path = require('path');
const fs = require('fs');

const uploadDir = '/tmp/quoxchat-uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/knowledge/upload', requireServiceKey, upload.single('file'), licenseGuardAdmin, lexicalInvalidate, async (req, res) => {
  const startMs = Date.now();
  try {
    const { widget_id: rawWidgetId } = req.body;
    // CW-SEC-1: canonical id keyed from either form.
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const fileSize = req.file.size;

    console.log(`[QuoxChat] Knowledge upload: ${fileName} (${(fileSize / 1024).toFixed(0)}KB, ${mimeType})`);

    // Read the whole file into memory once. Used by both the parser AND by
    // CW-FU persistFileObject further down. Previously the finally block
    // deleted the temp file before persistFileObject could read it again.
    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(filePath);
    } catch (readErr) {
      return res.status(500).json({ error: `Failed to read upload: ${readErr.message}`, fileName });
    } finally {
      // Temp file no longer needed on disk — buffer holds the content.
      try { fs.unlinkSync(filePath); } catch {}
    }

    // Storage quota: refuse BEFORE parsing/embedding anything.
    if (await rejectIfKnowledgeQuotaExceeded(res, widget_id, fileSize)) return;

    // Extract text based on file type
    const hiddenHtml = [];
    let extractedText = '';
    try {
      if (mimeType === 'application/pdf') {
        // pdf-parse v2 API: named PDFParse class, buffer via `data`
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: fileBuffer });
        try {
          const pdfResult = await parser.getText();
          extractedText = pdfResult.text || '';
          console.log(`[QuoxChat] PDF extracted: ${extractedText.length} chars, ${pdfResult.pages?.length || 0} pages`);
        } finally {
          try { await parser.destroy(); } catch {}
        }
      } else {
        // HTML/CSV keep table structure; DOCX/XLSX are parsed; other binary throws.
        extractedText = await ingestLib.extractUploadText(fileBuffer, fileName, mimeType, { hidden: hiddenHtml });
      }
    } catch (parseErr) {
      console.error(`[QuoxChat] File parse error: ${parseErr.message}`);
      if (parseErr && parseErr.code === 'unsupported_binary') {
        return res.status(422).json({ error: 'unsupported_file_content', detail: parseErr.message, fileName });
      }
      return res.status(422).json({ error: `Failed to parse file: ${parseErr.message}`, fileName });
    }

    if (!extractedText || extractedText.trim().length < 10) {
      return res.status(422).json({ error: 'No meaningful text extracted from file', fileName });
    }

    // Chunk the text
    const CHUNK_SIZE = 1000;
    const OVERLAP = 200;
    let chunks = [];
    let pos = 0;
    let idx = 0;
    // CSV / XLSX: row-oriented. Chunk on row boundaries and prefix every chunk
    // with the column header line so no chunk is rows without headers.
    const isCsvUpload = mimeType === 'text/csv' || /\.csv$/i.test(fileName || '');
    const csvHeaderCtx = isCsvUpload ? ingestLib.csvHeaderLine(fileBuffer.toString('utf-8')) : '';
    if (isCsvUpload && csvHeaderCtx) {
      chunks = ingestLib.chunkLines(extractedText, { prefix: csvHeaderCtx, size: CHUNK_SIZE });
      pos = extractedText.length;
    }
    if (!(isCsvUpload && csvHeaderCtx)) chunks = ingestLib.chunkText(extractedText, { size: CHUNK_SIZE, overlap: OVERLAP });

    console.log(`[QuoxChat] Chunked: ${chunks.length} chunks from ${extractedText.length} chars`);

    // Wave 5 defect 4: scan every chunk for planted instructions. Flagged-high
    // chunks stay indexed (the admin can see them) but never reach the prompt.
    const injectionScan = ingestLib.scanChunks(chunks, { fullText: extractedText });
    const hiddenRep = ingestLib.hiddenHtmlReport(hiddenHtml);
    injectionScan.flagged += hiddenRep.flagged;
    injectionScan.flagged_passages = injectionScan.flagged_passages.concat(hiddenRep.flagged_passages).slice(0, 20);
    if (isCsvUpload) {
      const cellHits = ingestLib.scanCsvCells(fileBuffer.toString('utf-8'));
      if (cellHits.length) {
        // The chunk scan may already have counted the same row; take the larger.
        injectionScan.flagged = Math.max(injectionScan.flagged, cellHits.length);
        const rowsSeen = new Set(cellHits.map((h) => h.row));
        injectionScan.flagged_passages = cellHits.concat(injectionScan.flagged_passages.filter((p) => !(p.text && cellHits.some((h) => p.text.includes(h.text.slice(0, 40)))))).slice(0, 20);
        injectionScan.csv_flagged_rows = [...rowsSeen];
      }
    }
    injectionScan.chunks.forEach((c, i) => { chunks[i] = c; });
    if (injectionScan.flagged > 0) console.warn(`[QuoxChat] Ingest injection scan: ${injectionScan.flagged} chunk(s) flagged (${injectionScan.high} high) in ${fileName}`);

    // Embed and upsert to Qdrant
    // VAULT-INTEG P17: was _providerKeysForWidget() + a separate, unused
    // bare process.env.QUOXCHAT_EMBED_PROVIDER read — now one call resolves
    // both the provider keys AND the widget's org, so embedText() below can
    // consult a stored per-org embed-provider override.
    const { providerKeys, orgId: widgetOrgId } = await _providerKeysAndOrgForWidget(widget_id);
    // Embed if ANY provider key is available. embedText tries openai first and
    // falls through to gemini, so gating on a single provider wrongly skipped
    // embedding for widgets whose only BYOK key was the other provider (the
    // bug that indexed 0 chunks on prod while an OpenAI key sat unused).
    const hasEmbedKey = Boolean(providerKeys?.openai_api_key || process.env.OPENAI_API_KEY || providerKeys?.gemini_api_key || process.env.GEMINI_API_KEY);

    if (!hasEmbedKey) {
      return res.status(503).json({ error: 'Embedding API key not available', chunks: chunks.length });
    }

    const qdrantCollection = qdrantCollectionForWidget(widget_id);
    const qdrantKey = resolveQdrantKey();
    await ensureQdrantCollection(qdrantCollection, qdrantKey);
    let embedded = 0;
    let failed = 0;

    // Process in batches of 5
    for (let i = 0; i < chunks.length; i += 5) {
      const batch = chunks.slice(i, i + 5);
      const points = [];

      for (const chunk of batch) {
        try {
          const embedResult = await embedText(chunk.text, providerKeys, { timeoutMs: 10000, orgId: widgetOrgId });
          if (embedResult?.vector?.length > 0) {
            points.push({
              id: Date.now() * 1000 + chunk.index, // Unique numeric ID
              vector: embedResult.vector,
              payload: {
                text: chunk.text,
                source: fileName,
                section: `Chunk ${chunk.index + 1}/${chunks.length}`,
                widget_id: widget_id || 'demo',
                source_type: 'file',
                ...(chunk.injection ? { injection_flag: chunk.injection } : {}),
              },
            });
            embedded++;
          } else {
            console.warn(`[QuoxChat] Embed failed for chunk ${chunk.index}`);
            failed++;
          }
        } catch (embedErr) {
          console.warn(`[QuoxChat] Embed error chunk ${chunk.index}: ${embedErr.message}`);
          failed++;
        }
      }

      // Upsert batch to Qdrant
      if (points.length > 0) {
        try {
          const upsertResp = await fetch(`http://qdrant:6333/collections/${qdrantCollection}/points?wait=true`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
            body: JSON.stringify({ points }),
            // STABILITY-AUDITS #5: this call had no timeout — an unresponsive
            // Qdrant would hang the whole knowledge-index batch loop
            // indefinitely. Mirrors server.js:178's existing AbortSignal.timeout
            // pattern (and this file's own line ~1979 Qdrant search call).
            signal: AbortSignal.timeout(10000),
          });
          if (!upsertResp.ok) {
            const errText = await upsertResp.text().catch(() => '');
            console.warn(`[QuoxChat] Qdrant upsert declined: ${upsertResp.status} ${errText.slice(0, 200)}`);
            embedded -= points.length;
            failed += points.length;
          }
        } catch (qdrantErr) {
          console.warn(`[QuoxChat] Qdrant upsert error: ${qdrantErr.message}`);
          embedded -= points.length;
          failed += points.length;
        }
      }

      // Small delay between batches to respect rate limits
      if (i + 5 < chunks.length) await new Promise(r => setTimeout(r, 500));
    }

    const durationMs = Date.now() - startMs;
    console.log(`[QuoxChat] Knowledge indexed: ${embedded}/${chunks.length} chunks, ${failed} failed, ${durationMs}ms`);

    // AEE audit
    try {
      _storeAuditEnvelope({
        type: 'event',
        from: 'system.quoxchat',
        to: `agent.quoxchat.${widget_id || 'demo'}`,
        intent: 'quoxchat.knowledge.indexed',
        payload: { fileName, fileSize, mimeType, chunks: chunks.length, embedded, failed, duration_ms: durationMs },
      });
    } catch {}

    // CW-FU: preserve the raw upload in file_objects so re-indexing doesn't
    // need a re-upload. Best-effort — knowledge source persistence still
    // works even if the blob persist fails. Uses the buffer we read at entry
    // (temp file already deleted).
    let fileObjectId = null;
    if (widget_id && widget_id !== 'demo') {
      const meta = await fetchWidgetMeta(widget_id);
      if (meta?.org_id && meta?.created_by) {
        try {
          fileObjectId = await persistFileObject({
            orgId: meta.org_id,
            createdBy: meta.created_by,
            namespace: `quoxchat/${widget_id.toLowerCase()}/knowledge`,
            sourcePlugin: 'quoxchat',
            sourceRef: widget_id,
            filename: fileName,
            mime: mimeType,
            buffer: fileBuffer,
            metadata: { textLength: extractedText.length, chunks: chunks.length, embedded },
          });
        } catch (persistErr) {
          console.warn('[QuoxChat] file_object persist failed (non-fatal):', persistErr.message);
        }
      }
    }

    // CW-8.13: persist source row (now carries file_object_id when available)
    const sourceId = await persistKnowledgeSource(widget_id, {
      source_type: 'file',
      name: fileName,
      chunk_count: embedded,
      status: embedded > 0 ? 'indexed' : 'error',
      config: { fileSize, mimeType, textLength: extractedText.length, totalChunks: chunks.length, failed, file_object_id: fileObjectId, injection_flags: injectionScan.flagged, injection_high: injectionScan.high, quarantined: injectionScan.quarantined, partially_quarantined: injectionScan.partially_quarantined, quarantined_chunks: injectionScan.quarantined_chunks, flagged_passages: injectionScan.flagged_passages },
      error_message: embedded > 0 ? null : 'No chunks embedded — check LLM key or file content',
      file_object_id: fileObjectId,
      size_bytes: fileSize,
    });

    res.json({
      success: true,
      fileName,
      fileSize,
      mimeType,
      textLength: extractedText.length,
      chunks: chunks.length,
      embedded,
      failed,
      duration_ms: durationMs,
      source_id: sourceId,
      file_object_id: fileObjectId,
      injection_flags: injectionScan.flagged,
      injection_high: injectionScan.high,
      quarantined: injectionScan.quarantined,
      partially_quarantined: injectionScan.partially_quarantined,
      flagged_passages: injectionScan.flagged_passages,
    });

  } catch (err) {
    console.error('[QuoxChat] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── URL Crawl (CW-8.4) ──
router.post('/knowledge/crawl', requireServiceKey, rateLimit, licenseGuardAdmin, lexicalInvalidate, async (req, res) => {
  const startMs = Date.now();
  try {
    const { url, widget_id: rawWidgetId, depth = 1, stay_in_path: stayInPathRaw } = req.body;
    // Wave 5 defect 14: stay inside the start URL's path prefix unless explicitly turned off.
    const stayInPath = !(stayInPathRaw === false || stayInPathRaw === 'false');
    // CW-SEC-1: canonical id keyed from either form.
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);

    if (!url) return res.status(400).json({ error: 'URL is required' });

    // QCL-SECURITY P1-7 — DNS-resolving SSRF guard (replaces the old
    // literal-prefix-only check, which missed 172.16-31.x, 169.254.169.254,
    // IPv6, and any hostname that merely *resolves* to an internal address).
    // Crawl is org-admin-only (requireServiceKey, since Phase 2) but an
    // admin still shouldn't be able to point the crawler at internal
    // services or the cloud metadata endpoint.
    const initialCheck = await validateOutboundUrlResolved(url);
    if (!initialCheck.valid) {
      return res.status(400).json({ error: initialCheck.error || 'URL not allowed' });
    }

    const maxDepth = Math.min(Math.max(1, parseInt(depth) || 1), 5);
    const crawled = new Set();
    const toVisit = [{ url: url.replace(/\/+$/, ''), currentDepth: 0 }];
    const pages = [];
    const maxPages = 50;
    const fetchStats = { fetched: 0, skippedNonHtml: 0, skippedSparse: 0, fetchErrors: 0, httpErrors: 0, skippedRobots: 0 };
    const CRAWL_UA = 'QuoxChat-Crawler/1.0 (+https://quox.ai)';
    // Wave 6 (D10): fetch and respect robots.txt (our agent group, else *).
    // A robots fetch that fails or is not a 2xx text file means "no rules".
    let robots = ingestLib.parseRobots('', 'QuoxChat-Crawler');
    try {
      const rb = await fetchWithRedirectValidation(new URL('/robots.txt', url).toString(), { headers: { 'User-Agent': CRAWL_UA }, signal: AbortSignal.timeout(8000) }, { maxRedirects: 3 });
      if (rb.ok) robots = ingestLib.parseRobots((await rb.text()).slice(0, 500000), 'QuoxChat-Crawler');
    } catch (robotsErr) {
      console.warn(`[QuoxChat] robots.txt fetch failed for ${url}: ${robotsErr.message} (crawling without rules)`);
    }

    console.log(`[QuoxChat] Crawling ${url} (depth=${maxDepth}, max=${maxPages} pages)`);

    // BFS crawl
    while (toVisit.length > 0 && pages.length < maxPages) {
      const { url: pageUrl, currentDepth } = toVisit.shift();
      const normalized = pageUrl.split('#')[0].split('?')[0].replace(/\/+$/, '');

      if (crawled.has(normalized)) continue;
      crawled.add(normalized);

      try {
        const _pu = new URL(pageUrl);
        if (!robots.allowed(`${_pu.pathname}${_pu.search}`)) {
          fetchStats.skippedRobots++;
          console.log(`[QuoxChat] Crawl skip ${pageUrl}: disallowed by robots.txt`);
          continue;
        }
        // QCL-SECURITY P1-7 — re-validate on every redirect hop. Auto-follow
        // is disabled; fetchWithRedirectValidation re-checks each Location
        // header (DNS resolution + private/loopback/link-local/metadata
        // block) before following it, so a page that 302s the crawler to an
        // internal address is blocked at the hop, not just on the seed URL.
        const resp = await fetchWithRedirectValidation(pageUrl, {
          headers: { 'User-Agent': CRAWL_UA },
          signal: AbortSignal.timeout(10000),
        }, { maxRedirects: 5 });

        if (!resp.ok) {
          fetchStats.httpErrors++;
          console.log(`[QuoxChat] Crawl skip ${pageUrl}: ${resp.status}`);
          continue;
        }

        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
          fetchStats.skippedNonHtml++;
          continue;
        }

        fetchStats.fetched++;
        const html = await resp.text();

        // Extract text using cheerio
        const cheerio = require('cheerio');
        const $ = cheerio.load(html);
        $('script, style, nav, footer, header, aside, .sidebar, .menu, .navigation').remove();
        const title = $('title').text().trim() || $('h1').first().text().trim() || '';
        const text = ingestLib.htmlToText(cheerio.load($.html()), { remove: 'script, style, nav, footer, header, aside, .sidebar, .menu, .navigation' });

        if (text.length > 50) {
          pages.push({ url: normalized, title, text, textLength: text.length });
          console.log(`[QuoxChat] Crawled: ${normalized} (${text.length} chars, "${title.slice(0, 40)}")`);
        } else {
          fetchStats.skippedSparse++;
          console.log(`[QuoxChat] Crawl: ${normalized} fetched but only ${text.length} chars extracted (JS-rendered?)`);
        }

        // Discover links for deeper crawl
        if (currentDepth < maxDepth) {
          const baseDomain = new URL(pageUrl).hostname.toLowerCase();
          $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) return;
            try {
              const resolved = new URL(href, pageUrl).toString().split('#')[0].split('?')[0].replace(/\/+$/, '');
              const resolvedDomain = new URL(resolved).hostname.toLowerCase();
              if (resolvedDomain === baseDomain && !crawled.has(resolved) && ingestLib.inCrawlScope(url, resolved, stayInPath)) {
                toVisit.push({ url: resolved, currentDepth: currentDepth + 1 });
              }
            } catch {}
          });
        }

        // Rate limit: 1 req/sec
        await new Promise(r => setTimeout(r, 1000));
      } catch (fetchErr) {
        fetchStats.fetchErrors++;
        console.warn(`[QuoxChat] Crawl error ${pageUrl}: ${fetchErr.message}`);
      }
    }

    console.log(`[QuoxChat] Crawl complete: ${pages.length} pages from ${url} — stats:`, fetchStats);

    if (pages.length === 0) {
      let diagnostic;
      if (fetchStats.httpErrors > 0 && fetchStats.fetched === 0) {
        diagnostic = `Site returned HTTP errors on all ${fetchStats.httpErrors} fetches — check the URL or whether the site blocks non-browser user agents`;
      } else if (fetchStats.skippedSparse > 0) {
        diagnostic = `Fetched ${fetchStats.skippedSparse} page(s) but each had <50 chars of extractable text — likely a JavaScript-rendered SPA. Try a docs URL or direct content page instead of the landing page`;
      } else if (fetchStats.fetchErrors > 0) {
        diagnostic = `Network errors on all ${fetchStats.fetchErrors} fetches — check the URL is reachable`;
      } else if (fetchStats.skippedNonHtml > 0) {
        diagnostic = `Fetched ${fetchStats.skippedNonHtml} response(s) but none were HTML`;
      } else {
        diagnostic = 'No pages could be fetched';
      }
      // Wave 9: a crawl that fetched nothing is a failure, not a success.
      return res.status(422).json({ success: false, error: diagnostic, url, pages: 0, chunks: 0, embedded: 0, message: diagnostic, stats: fetchStats });
    }

    // Storage quota: refuse BEFORE chunking/embedding anything.
    const crawlBytes = pages.reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0);
    if (await rejectIfKnowledgeQuotaExceeded(res, widget_id, crawlBytes)) return;

    // Chunk and embed all pages
    // VAULT-INTEG P17: was _providerKeysForWidget() + a separate, unused
    // bare process.env.QUOXCHAT_EMBED_PROVIDER read — see the upload
    // endpoint's identical comment above.
    const { providerKeys, orgId: widgetOrgId } = await _providerKeysAndOrgForWidget(widget_id);
    // Embed if ANY provider key is available. embedText tries openai first and
    // falls through to gemini, so gating on a single provider wrongly skipped
    // embedding for widgets whose only BYOK key was the other provider (the
    // bug that indexed 0 chunks on prod while an OpenAI key sat unused).
    const hasEmbedKey = Boolean(providerKeys?.openai_api_key || process.env.OPENAI_API_KEY || providerKeys?.gemini_api_key || process.env.GEMINI_API_KEY);
    const qdrantKey = resolveQdrantKey();
    const qdrantCollection = qdrantCollectionForWidget(widget_id);
    await ensureQdrantCollection(qdrantCollection, qdrantKey);
    let totalChunks = 0;
    let totalEmbedded = 0;
    let totalInjectionFlags = 0;
    let totalInjectionHigh = 0;
    const quarantinedPages = [];
    const crawlFlaggedPassages = [];

    for (const page of pages) {
      // Chunk
      const chunks = ingestLib.chunkText(page.text, { size: 1000, overlap: 200, maxChunks: 101 });
      const pageScan = ingestLib.scanChunks(chunks, { fullText: page.text });
      if (pageScan.quarantined) quarantinedPages.push(page.url);
      for (const fp of pageScan.flagged_passages) if (crawlFlaggedPassages.length < 20) crawlFlaggedPassages.push({ page: page.url, ...fp });
      pageScan.chunks.forEach((c, i) => { chunks[i] = c; });
      totalInjectionFlags += pageScan.flagged;
      totalInjectionHigh += pageScan.high;
      totalChunks += chunks.length;

      // Embed + upsert
      if (hasEmbedKey) {
        for (let i = 0; i < chunks.length; i += 5) {
          const batch = chunks.slice(i, i + 5);
          const points = [];
          for (const chunk of batch) {
            try {
              const embedResult = await embedText(chunk.text, providerKeys, { timeoutMs: 10000, orgId: widgetOrgId });
              if (embedResult?.vector?.length > 0) {
                points.push({ id: Date.now() * 1000 + totalEmbedded, vector: embedResult.vector, payload: { text: chunk.text, source: page.url, section: page.title || `Page ${pages.indexOf(page) + 1}`, widget_id: widget_id || 'demo', source_type: 'url', ...(chunk.injection ? { injection_flag: chunk.injection } : {}) } });
                totalEmbedded++;
              }
            } catch {}
          }
          if (points.length > 0) {
            try {
              const upsertResp = await fetch(`http://qdrant:6333/collections/${qdrantCollection}/points?wait=true`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey }, body: JSON.stringify({ points }) });
              if (!upsertResp.ok) {
                const t = await upsertResp.text().catch(() => '');
                console.warn(`[QuoxChat] Crawl upsert declined: ${upsertResp.status} ${t.slice(0, 200)}`);
                totalEmbedded -= points.length;
              }
            } catch (e) {
              console.warn(`[QuoxChat] Crawl upsert error: ${e.message}`);
              totalEmbedded -= points.length;
            }
          }
          if (i + 5 < chunks.length) await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    const durationMs = Date.now() - startMs;
    console.log(`[QuoxChat] Crawl indexed: ${totalEmbedded}/${totalChunks} chunks from ${pages.length} pages, ${durationMs}ms`);

    try {
      _storeAuditEnvelope({ type: 'event', from: 'system.quoxchat', to: `agent.quoxchat.${widget_id || 'demo'}`, intent: 'quoxchat.knowledge.crawled', payload: { url, pages: pages.length, chunks: totalChunks, embedded: totalEmbedded, depth: maxDepth, duration_ms: durationMs } });
    } catch {}

    // CW-8.13: persist source row
    const sourceId = await persistKnowledgeSource(widget_id, {
      source_type: 'url',
      name: url,
      chunk_count: totalEmbedded,
      status: totalEmbedded > 0 ? 'indexed' : 'error',
      config: { conflicts: ingestLib.findFigureConflicts(pages.map((p) => ({ id: p.url, text: p.text }))), depth: maxDepth, pages: pages.length, totalChunks, injection_flags: totalInjectionFlags, injection_high: totalInjectionHigh, quarantined: quarantinedPages.length > 0, quarantined_pages: quarantinedPages.slice(0, 50), flagged_passages: crawlFlaggedPassages, pageList: pages.map(p => ({ url: p.url, title: p.title })) },
      error_message: totalEmbedded > 0 ? null : 'Crawl returned no indexable content',
      size_bytes: crawlBytes,
    });

    res.json({ success: true, url, pages: pages.length, chunks: totalChunks, embedded: totalEmbedded, depth: maxDepth, duration_ms: durationMs, pageList: pages.map(p => ({ url: p.url, title: p.title, textLength: p.textLength })), source_id: sourceId, injection_flags: totalInjectionFlags, injection_high: totalInjectionHigh });
  } catch (err) {
    console.error('[QuoxChat] Crawl error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── QCX-3.3 — Knowledge semantic search ──
// Standalone RAG query: embed the input, Qdrant-search the widget's
// collection, return the top chunks. No LLM hop. Public (rate-limited +
// no domain guard since MCP callers come from developer machines, not
// browsers). The collector's /message handler does the same work inline;
// this endpoint exposes it for external callers (MCP bridge, dashboard
// preview pane, etc.).
// #961: keyword-only knowledge search when the embedding provider is down. Labelled, so a
// caller (and the agent tool) can tell the visitor or admin that semantic search is unavailable.
async function lexicalOnlySearch({ collection, query, topK, qdrantKey, diag = {}, lexical = quoxchatLexical }) {
  const degraded = {
    mode: 'lexical_only',
    reason: 'embedding_failed',
    provider: diag.provider || null,
    status: diag.status || null,
    message: `Semantic search is unavailable (the ${diag.provider || 'embedding'} provider returned ${diag.status || 'an error'}${diag.status === 429 ? ', likely out of credit or rate limited' : ''}); these results come from keyword search only.`,
  };
  try {
    const hy = await lexical.hybrid({ collection, query, dense: [], limit: topK, loader: () => lexical.scrollPayloads({ collection, qdrantKey }) });
    const chunks = (hy.chunks || []).slice(0, topK).map((c) => ({
      text: c.text || '', source: c.source || '', section: c.section || '', score: c.score || 0,
      ...(c.superseded === true ? { superseded: true, label: 'superseded (reference only, not used in answers)' } : {}),
    }));
    return { chunks, degraded };
  } catch (err) {
    return { chunks: [], degraded: { ...degraded, lexical_error: String(err && err.message).slice(0, 120) } };
  }
}

router.post('/knowledge/search', requireServiceKey, rateLimit, licenseGuardAdmin, async (req, res) => {
  try {
    const { widget_id: rawWidgetId, query, limit } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);
    const { providerKeys, orgId: widgetOrgId } = await _providerKeysAndOrgForWidget(widget_id);
    const diag = {};
    const embedResult = await embedText(query, providerKeys, { orgId: widgetOrgId, diag });
    const qdrantKey = resolveQdrantKey();
    const qdrantCollection = qdrantCollectionForWidget(widget_id);
    const topK = Math.min(Math.max(Number.isFinite(limit) ? limit : 5, 1), 20);
    if (!embedResult) {
      // #961: the embedding provider failed (e.g. OpenAI 429 out of credit). Never switch to
      // another provider's vectors (the collection was indexed with this one); answer from
      // keyword search and say so, instead of a bare 502.
      const out = await lexicalOnlySearch({ collection: qdrantCollection, query, topK, qdrantKey, diag });
      return res.json({ widget_id, collection: qdrantCollection, query, ...out });
    }
    const vector = embedResult.vector;

    const searchResp = await fetch(`http://qdrant:6333/collections/${qdrantCollection}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify({ vector, limit: topK, with_payload: true }),
      signal: AbortSignal.timeout(3000),
    });
    if (!searchResp.ok) return res.status(502).json({ error: 'qdrant_unavailable', status: searchResp.status });
    const searchData = await searchResp.json();
    const chunks = (searchData.result || []).map(r => ({
      text: r.payload?.text || '',
      source: r.payload?.source || '',
      section: r.payload?.section || '',
      score: r.score || 0,
      pinned: r.payload?.pinned === true,
      // Admin search keeps superseded chunks visible, labelled; visitor retrieval drops them.
      ...(r.payload?.superseded === true ? { superseded: true, label: 'superseded (reference only, not used in answers)' } : {}),
    }));
    res.json({ widget_id, collection: qdrantCollection, query, chunks });
  } catch (err) {
    console.error('[QuoxChat] /knowledge/search error:', err?.message);
    res.status(500).json({ error: err?.message || 'search_failed' });
  }
});

// ── Q&A Pairs (CW-8.5) ──
// QCL-LEARN P1: when a caller supplies correction provenance
// (source_conversation_id/source_message_id/corrected_by — LogsTab's
// "Improve this answer" flow), the entry is forced into the 'correction'
// category and an audit envelope + VOLT event fire carrying non-PII
// provenance (a SHA-256 fingerprint of the answer, never the raw text —
// matches the visitor-identified fingerprint convention). Ingest without
// provenance is unchanged (existing manual FAQ entry path).
router.post('/knowledge/qa', requireServiceKey, rateLimit, licenseGuardAdmin, lexicalInvalidate, async (req, res) => {
  try {
    const { question, answer, widget_id: rawWidgetId, category, source_conversation_id, source_message_id, corrected_by, source_url: rawSourceUrl } = req.body;
    // Optional public citation page (corpus sync). https only, bounded.
    const sourceUrl = (typeof rawSourceUrl === 'string' && /^https:\/\/[^\s]{1,300}$/i.test(rawSourceUrl.trim())) ? rawSourceUrl.trim() : null;
    // CW-SEC-1: canonical id keyed from either form.
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);
    if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'Question and answer are required' });

    const isCorrection = !!(source_conversation_id || source_message_id || corrected_by);
    const effectiveCategory = isCorrection ? 'correction' : (category || 'General');

    console.log(`[QuoxChat] Q&A pair: "${question.slice(0, 50)}" → "${answer.slice(0, 50)}"${isCorrection ? ' (correction)' : ''}`);
    const text = `Q: ${question}\nA: ${answer}`;
    const qaBytes = Buffer.byteLength(`${question}${answer}`, 'utf8');
    // Storage quota: refuse BEFORE embedding.
    if (await rejectIfKnowledgeQuotaExceeded(res, widget_id, qaBytes)) return;

    const { providerKeys, orgId: widgetOrgId } = await _providerKeysAndOrgForWidget(widget_id);
    const embedResult = await embedText(text, providerKeys, { timeoutMs: 10000, orgId: widgetOrgId });
    if (!embedResult) return res.status(502).json({ error: 'Embedding failed' });
    const vector = embedResult.vector;

    const qdrantKey = resolveQdrantKey();
    const qdrantCollection = qdrantCollectionForWidget(widget_id);
    await ensureQdrantCollection(qdrantCollection, qdrantKey);
    const upsertResp = await fetch(`http://qdrant:6333/collections/${qdrantCollection}/points?wait=true`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify({ points: [{ id: Date.now() * 1000 + Math.floor(Math.random() * 1000), vector, payload: { text, source: 'FAQ', section: effectiveCategory, widget_id: widget_id || 'demo', source_type: 'qa', pinned: true, question, answer, ...(sourceUrl ? { source_url: sourceUrl } : {}) } }] }),
    });
    if (!upsertResp.ok) {
      const errTxt = await upsertResp.text().catch(() => '');
      console.warn(`[QuoxChat] Q&A upsert declined: ${upsertResp.status} ${errTxt.slice(0, 200)}`);
      return res.status(502).json({ error: 'Vector store rejected the Q&A', detail: errTxt.slice(0, 300) });
    }

    try { _storeAuditEnvelope({ type: 'event', from: 'system.quoxchat', to: `agent.quoxchat.${widget_id || 'demo'}`, intent: 'quoxchat.knowledge.qa_added', payload: { question: question.slice(0, 100) } }); } catch {}

    if (isCorrection) {
      const correctionPayload = {
        widget_id: widget_id || 'demo',
        conversation_id: source_conversation_id || null,
        message_id: source_message_id || null,
        corrected_by: corrected_by || null,
        answer_hash: hashInput(answer),
      };
      try {
        _storeAuditEnvelope({ type: 'event', from: 'system.quoxchat', to: `agent.quoxchat.${widget_id || 'demo'}`, intent: 'quoxchat.knowledge.correction', payload: correctionPayload });
      } catch {}
      _voltAtomicEvent(source_conversation_id || widget_id || 'demo', { widget_id, conversation_id: source_conversation_id }, 'quoxchat.knowledge.correction', correctionPayload);
    }

    // CW-8.13: persist source row
    const sourceConfig = { question, answer, category: effectiveCategory, pinned: true, ...(sourceUrl ? { source_url: sourceUrl } : {}) };
    if (isCorrection) {
      sourceConfig.correction = {
        conversation_id: source_conversation_id || null,
        message_id: source_message_id || null,
        corrected_by: corrected_by || null,
      };
    }
    const sourceId = await persistKnowledgeSource(widget_id, {
      source_type: 'qa',
      name: question.slice(0, 200),
      chunk_count: 1,
      status: 'indexed',
      config: sourceConfig,
      size_bytes: qaBytes,
    });

    res.json({ success: true, question, category: effectiveCategory, source_id: sourceId });
  } catch (err) {
    console.error('[QuoxChat] Q&A error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── QCFT #213 — Corpus sync admin surface ───────────────────────────────────
// Two small service-key routes that make the retrain ritual
// (scripts/sync-quoxchat-corpus.js) possible without a user session:
//
//   GET    /knowledge/sources?widget_id=...      list persisted source rows
//   DELETE /knowledge/sources/:sourceId          supersede primitive
//
// The DELETE is the piece the KB previously lacked: QA upserts never
// superseded, so re-teaching a fact left the old contradictory vector in
// Qdrant forever. This route deletes the source's Qdrant points by payload
// filter FIRST, then removes the widget_knowledge_sources row via auth's
// internal router. Filterable because ingestion stamps recoverable markers
// into the point payload: QA points carry payload.question (+ section =
// category), file chunks carry payload.source = original filename.

/**
 * GET /quoxchat/knowledge/sources?widget_id=<id-or-public-key>
 * Service-key proxy to auth's internal knowledge-sources list.
 */
router.get('/knowledge/sources', requireServiceKey, licenseGuardAdmin, async (req, res) => {
  try {
    const rawWidgetId = req.query.widget_id;
    if (!rawWidgetId) return res.status(400).json({ error: 'widget_id required' });
    const widget_id = await resolveCanonicalWidgetId(String(rawWidgetId));

    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    // QCX-SYNC-CAP: forward pagination so the corpus sync can walk widgets
    // with >1000 sources instead of silently diffing against a capped page.
    const page = new URLSearchParams();
    if (req.query.limit) page.set('limit', String(req.query.limit));
    if (req.query.offset) page.set('offset', String(req.query.offset));
    const qs = page.toString() ? `?${page.toString()}` : '';
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/knowledge-sources${qs}`, {
      headers: { 'x-service-key': process.env.INTERNAL_SERVICE_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 404) return res.status(404).json({ error: 'Widget not found' });
    if (!resp.ok) return res.status(502).json({ error: 'knowledge_sources_list_failed', status: resp.status });
    const data = await resp.json().catch(() => ({}));
    res.json({
      widget_id: data.widget_id || widget_id,
      total: typeof data.total === 'number' ? data.total : undefined,
      limit: data.limit,
      offset: data.offset,
      sources: Array.isArray(data.sources) ? data.sources : [],
      storage: await (async () => {
        try {
          const { usage, tier, limit } = await knowledgeQuotaState(widget_id);
          return usage ? { used_bytes: usage.bytes, limit_bytes: limit, tier, sources: usage.sources, estimated_sources: usage.estimated_sources } : null;
        } catch { return null; }
      })(),
    });
  } catch (err) {
    console.error('[QuoxChat] knowledge/sources list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Build the Qdrant payload filter that isolates one knowledge source's
// points. Returns null when the source type has no recoverable marker
// (url/connector rows predate this scheme) — callers then skip vector
// deletion and only remove the row. Exported for unit tests.
function qdrantFilterForSource(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'qa' && source.config?.question) {
    return {
      must: [
        { key: 'source_type', match: { value: 'qa' } },
        { key: 'question', match: { value: source.config.question } },
      ],
    };
  }
  if (source.type === 'file' && source.name) {
    return {
      must: [
        { key: 'source_type', match: { value: 'file' } },
        { key: 'source', match: { value: source.name } },
      ],
    };
  }
  // quox#702: crawl rows record config.pageList and each chunk's payload
  // source is its page url, so a stale crawled page (an old install guide)
  // is removable with its vectors instead of orphaning them.
  if (source.type === 'url' && Array.isArray(source.config?.pageList)) {
    const urls = [...new Set(source.config.pageList.map(p => p && p.url).filter(u => typeof u === 'string' && u))];
    if (urls.length === 0) return null;
    return {
      must: [
        { key: 'source_type', match: { value: 'url' } },
        { key: 'source', match: { any: urls } },
      ],
    };
  }
  return null;
}

/**
 * DELETE /quoxchat/knowledge/sources/:sourceId?widget_id=<id-or-public-key>
 * Supersede primitive: Qdrant points (by payload filter) then the auth row.
 * Refuses the shared demo collection, mirroring
 * DELETE /internal/widget-knowledge/:widgetId. Qdrant 404 (collection gone)
 * is idempotent success.
 */
router.delete('/knowledge/sources/:sourceId', requireServiceKey, licenseGuardAdmin, lexicalInvalidate, async (req, res) => {
  try {
    const { sourceId } = req.params;
    const rawWidgetId = req.query.widget_id;
    if (!rawWidgetId) return res.status(400).json({ error: 'widget_id required' });
    const widget_id = await resolveCanonicalWidgetId(String(rawWidgetId));

    const collection = qdrantCollectionForWidget(widget_id);
    if (collection === 'quoxchat_demo') {
      return res.status(400).json({ success: false, error: 'refused_shared_collection', collection });
    }

    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;

    // Look up the row (need name/config to build the vector filter).
    // QCX-SYNC-CAP: fetch the single row directly. The original one-page
    // list lookup 404'd past row 1000; the paginated-walk replacement then
    // tripped the internal rate limit under bulk deletes (3 list calls per
    // delete x 900 deletes -> 429). One row, one call.
    const srcResp = await fetch(
      `${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/knowledge-sources/${encodeURIComponent(sourceId)}`,
      { headers: { 'x-service-key': serviceKey }, signal: AbortSignal.timeout(5000) }
    );
    if (srcResp.status === 404) {
      const body = await srcResp.json().catch(() => ({}));
      return res.status(404).json({ error: body.error === 'Widget not found' ? 'Widget not found' : 'Source not found' });
    }
    if (!srcResp.ok) return res.status(502).json({ error: 'knowledge_source_fetch_failed', status: srcResp.status });
    const source = await srcResp.json().catch(() => null);
    if (!source || !source.id) return res.status(404).json({ error: 'Source not found' });

    // 1) Vectors. Best-effort semantics are NOT acceptable here (a failed
    // vector delete followed by a row delete would orphan contradictory
    // content invisibly), so a Qdrant failure aborts before the row delete.
    let vectorDelete = 'skipped_no_marker';
    const filter = qdrantFilterForSource(source);
    if (filter) {
      const qdrantKey = resolveQdrantKey();
      const delResp = await fetch(`http://qdrant:6333/collections/${collection}/points/delete?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
        body: JSON.stringify({ filter }),
        signal: AbortSignal.timeout(8000),
      });
      if (delResp.ok) {
        vectorDelete = 'ok';
      } else if (delResp.status === 404) {
        vectorDelete = 'collection_missing';
      } else {
        const txt = await delResp.text().catch(() => '');
        console.warn(`[QuoxChat] source vector delete failed: ${collection} -> ${delResp.status} ${txt.slice(0, 200)}`);
        return res.status(502).json({ success: false, error: 'qdrant_delete_failed', status: delResp.status });
      }
    }

    // 2) Row.
    const rowResp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/knowledge-sources/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!rowResp.ok && rowResp.status !== 404) {
      return res.status(502).json({ success: false, error: 'row_delete_failed', status: rowResp.status, vector_delete: vectorDelete });
    }

    try {
      _storeAuditEnvelope({
        type: 'event',
        from: 'system.quoxchat',
        to: `agent.quoxchat.${widget_id}`,
        intent: 'quoxchat.knowledge.source_deleted',
        payload: { source_id: sourceId, source_type: source.type, name: String(source.name || '').slice(0, 120), vector_delete: vectorDelete },
      });
    } catch { /* noop */ }

    res.json({ success: true, source_id: sourceId, vector_delete: vectorDelete, row_deleted: rowResp.ok });
  } catch (err) {
    console.error('[QuoxChat] knowledge/sources delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /quoxchat/knowledge/sources/:sourceId   body { widget_id, superseded: boolean }
 * Mark a source "reference only / superseded". The flag is written onto the
 * source's Qdrant points (payload.superseded) so both dense and lexical
 * retrieval drop them for visitors, and recorded on the auth row config so
 * the admin UI can show it. Qdrant first: a failed payload write leaves the
 * row unchanged so UI and index never disagree.
 */
router.patch('/knowledge/sources/:sourceId', requireServiceKey, licenseGuardAdmin, lexicalInvalidate, async (req, res) => {
  try {
    const { sourceId } = req.params;
    const body = req.body || {};
    if (typeof body.superseded !== 'boolean') return res.status(400).json({ error: 'superseded (boolean) required' });
    if (!body.widget_id) return res.status(400).json({ error: 'widget_id required' });
    const widget_id = await resolveCanonicalWidgetId(String(body.widget_id));
    const collection = qdrantCollectionForWidget(widget_id);
    if (collection === 'quoxchat_demo') return res.status(400).json({ success: false, error: 'refused_shared_collection', collection });

    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    const rowUrl = `${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/knowledge-sources/${encodeURIComponent(sourceId)}`;
    const srcResp = await fetch(rowUrl, { headers: { 'x-service-key': serviceKey }, signal: AbortSignal.timeout(5000) });
    if (srcResp.status === 404) return res.status(404).json({ error: 'Source not found' });
    if (!srcResp.ok) return res.status(502).json({ error: 'knowledge_source_fetch_failed', status: srcResp.status });
    const source = await srcResp.json().catch(() => null);
    if (!source || !source.id) return res.status(404).json({ error: 'Source not found' });

    const filter = qdrantFilterForSource(source);
    if (!filter) return res.status(422).json({ error: 'cannot_supersede', detail: 'this source has no recoverable index marker' });

    const qdrantKey = resolveQdrantKey();
    const qResp = await fetch(
      `http://qdrant:6333/collections/${collection}/points/payload${body.superseded ? '' : '/delete'}?wait=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
        body: JSON.stringify(body.superseded ? { payload: { superseded: true }, filter } : { keys: ['superseded'], filter }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!qResp.ok && qResp.status !== 404) {
      return res.status(502).json({ success: false, error: 'qdrant_payload_update_failed', status: qResp.status });
    }

    const rowResp = await fetch(rowUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify({ config_patch: { superseded: body.superseded } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!rowResp.ok) return res.status(502).json({ success: false, error: 'row_update_failed', status: rowResp.status });

    try {
      _storeAuditEnvelope({
        type: 'event', from: 'system.quoxchat', to: `agent.quoxchat.${widget_id}`,
        intent: 'quoxchat.knowledge.source_superseded',
        payload: { source_id: sourceId, source_type: source.type, name: String(source.name || '').slice(0, 120), superseded: body.superseded },
      });
    } catch { /* noop */ }
    res.json({ success: true, source_id: sourceId, superseded: body.superseded });
  } catch (err) {
    console.error('[QuoxChat] knowledge/sources supersede error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── QUOXCHAT-BRUTALOOP ITER2 — Qdrant/corpus reconcile ──────────────────────
// The corpus sync only manages rows carrying its markers, so legacy points
// that no source row owns (and that may contradict the curated corpus) were
// invisible to it. This route scrolls the widget's whole collection, classifies
// every point, and (apply:true only) deletes the unmanaged/orphan/duplicate
// ones by id. Teach-mode corrections (payload.section === 'correction', set
// by POST /knowledge/qa) are NEVER deleted. Dry-run by default.
const RECONCILE_DOC_MARKER_RE = /^corpus__(.+)__([0-9a-f]{8})(\.[A-Za-z0-9]+)?$/;
const RECONCILE_CLASSES = ['managed', 'correction', 'orphan', 'unmanaged', 'duplicate'];
const RECONCILE_DELETABLE = ['unmanaged', 'orphan', 'duplicate'];

function _reconcileNorm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Pure classifier. points: [{id, payload}]; rows: knowledge-source rows.
// Exported for tests.
function classifyReconcilePoints(points, rows) {
  const categories = new Set();
  const names = new Set();
  for (const r of rows || []) {
    if (r?.config?.category) categories.add(String(r.config.category));
    if (r?.name) names.add(String(r.name));
  }
  const seenManagedText = new Set();
  return points.map((p) => {
    const payload = p.payload || {};
    const section = typeof payload.section === 'string' ? payload.section : '';
    const source = typeof payload.source === 'string' ? payload.source : '';
    let cls;
    if (section === 'correction' || payload.kind === 'correction') {
      cls = 'correction';
    } else if (section.startsWith('corpus:') || RECONCILE_DOC_MARKER_RE.test(source)) {
      const qaOk = section.startsWith('corpus:') && categories.has(section);
      const docOk = RECONCILE_DOC_MARKER_RE.test(source) && names.has(source);
      if (qaOk || docOk) {
        cls = 'managed';
        const key = _reconcileNorm(payload.text);
        if (key) {
          if (seenManagedText.has(key)) cls = 'duplicate';
          else seenManagedText.add(key);
        }
      } else {
        cls = 'orphan';
      }
    } else {
      cls = 'unmanaged';
    }
    return { id: p.id, cls, source, section, source_type: payload.source_type || null, text: String(payload.text || '') };
  });
}

router.post('/knowledge/reconcile', requireServiceKey, rateLimit, licenseGuardAdmin, lexicalInvalidate, async (req, res) => {
  try {
    const { widget_id: rawWidgetId } = req.body || {};
    const apply = req.body?.apply === true;
    if (!rawWidgetId) return res.status(400).json({ error: 'widget_id required' });
    const include = Array.isArray(req.body?.include) ? req.body.include.map(String) : RECONCILE_DELETABLE;
    const badInclude = include.filter((c) => !RECONCILE_DELETABLE.includes(c));
    if (badInclude.length) {
      return res.status(400).json({ error: 'invalid_include', detail: `allowed: ${RECONCILE_DELETABLE.join(', ')}` });
    }
    const widget_id = await resolveCanonicalWidgetId(String(rawWidgetId));
    const collection = qdrantCollectionForWidget(widget_id);
    if (collection === 'quoxchat_demo') {
      return res.status(400).json({ error: 'refused_shared_collection', collection });
    }

    // 1) Source rows (paginated; fail loudly, never classify against a partial list).
    const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    const rows = [];
    for (let offset = 0; ; ) {
      const r = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widget_id)}/knowledge-sources?limit=1000&offset=${offset}`, {
        headers: { 'x-service-key': process.env.INTERNAL_SERVICE_KEY },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 404) return res.status(404).json({ error: 'Widget not found' });
      if (!r.ok) return res.status(502).json({ error: 'knowledge_sources_list_failed', status: r.status });
      const data = await r.json().catch(() => ({}));
      const page = Array.isArray(data.sources) ? data.sources : [];
      rows.push(...page);
      if (typeof data.total !== 'number') {
        if (page.length >= 1000) return res.status(502).json({ error: 'knowledge_sources_list_unpaginated' });
        break;
      }
      if (rows.length >= data.total || page.length === 0) break;
      offset += page.length;
    }

    // 2) Scroll every point (payload only).
    const qdrantKey = resolveQdrantKey();
    const points = [];
    let next = null;
    for (let i = 0; i < 2000; i++) {
      const body = { limit: 256, with_payload: true, with_vector: false };
      if (next !== null && next !== undefined) body.offset = next;
      const sr = await fetch(`http://qdrant:6333/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!sr.ok) {
        return res.status(502).json({ error: 'qdrant_scroll_failed', status: sr.status, collection });
      }
      const sd = await sr.json().catch(() => null);
      const batch = sd?.result?.points;
      if (!Array.isArray(batch)) return res.status(502).json({ error: 'qdrant_scroll_malformed', collection });
      points.push(...batch);
      next = sd.result.next_page_offset;
      if (next === null || next === undefined) break;
    }

    // 3) Classify + report.
    const classified = classifyReconcilePoints(points, rows);
    const counts = Object.fromEntries(RECONCILE_CLASSES.map((c) => [c, 0]));
    const groupMap = new Map();
    for (const c of classified) {
      counts[c.cls]++;
      const key = `${c.cls}\u0000${c.source}\u0000${c.section}\u0000${c.source_type || ''}`;
      let g = groupMap.get(key);
      if (!g) {
        g = { class: c.cls, source: c.source, section: c.section, source_type: c.source_type, count: 0, sample_text: c.text.replace(/\s+/g, ' ').slice(0, 160) };
        groupMap.set(key, g);
      }
      g.count++;
    }
    const groups = [...groupMap.values()].sort((a, b) => b.count - a.count);
    const out = { widget_id, collection, total: classified.length, counts, groups };

    // 4) Apply (deletes only the include classes; corrections/managed are unreachable).
    if (apply) {
      const ids = classified.filter((c) => include.includes(c.cls)).map((c) => c.id);
      const deleted = Object.fromEntries(include.map((c) => [c, 0]));
      const byId = new Map(classified.map((c) => [c.id, c.cls]));
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        const dr = await fetch(`http://qdrant:6333/collections/${collection}/points/delete?wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
          body: JSON.stringify({ points: batch }),
          signal: AbortSignal.timeout(15000),
        });
        if (!dr.ok) {
          out.apply_result = { error: 'qdrant_delete_failed', status: dr.status, deleted, include };
          return res.status(502).json({ error: 'qdrant_delete_failed', status: dr.status, ...out });
        }
        for (const id of batch) deleted[byId.get(id)]++;
      }
      out.apply_result = { include, deleted, deleted_total: ids.length };
    }

    try {
      _storeAuditEnvelope({
        type: 'event',
        from: 'system.quoxchat',
        to: `agent.quoxchat.${widget_id}`,
        intent: 'quoxchat.knowledge.reconciled',
        payload: { applied: apply, total: out.total, counts, deleted: out.apply_result?.deleted || null },
      });
    } catch { /* noop */ }

    res.json(out);
  } catch (err) {
    console.error('[QuoxChat] knowledge/reconcile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── QCL-TEACH P1 — Teach Mode proposal (propose-only) ───────────────────────
// The backend Test Chat (TrainingTab) lets an admin flip on "Teach mode"
// while chatting live with the assistant. When the admin corrects the
// assistant, the UI calls this endpoint with the recent turns; the widget's
// LLM is asked to distill the correction into a single FAQ-shaped proposal
// {question, answer, rationale}. This route PROPOSES ONLY — it never writes
// to the knowledge base (no Qdrant upsert, no persistKnowledgeSource call).
// Confirming a proposal is a separate frontend call to the existing
// POST /quoxchat/knowledge/qa (QCL-LEARN P1), which pins it as a
// 'correction' entry once provenance (source_conversation_id/corrected_by)
// is attached.
const TEACH_SYSTEM_PROMPT = 'You are refining a support assistant\'s knowledge base. Given this test '
  + 'conversation in which an admin corrected the assistant, extract the SINGLE most useful FAQ entry '
  + 'that would prevent the mistake next time. Reply with strict JSON: {"question":..., "answer":..., '
  + '"rationale":...} or {"none":true} if no correction is implied. Reply with ONLY the JSON object — '
  + 'no prose, no code fences.';

// Defensive JSON parse: strips ```json fences if present, then falls back to
// slicing the outermost {...} block if the model added stray prose despite
// instructions. Returns null (never throws) on total failure.
function _parseTeachProposal(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : rawText).trim();
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
  }
}

router.post('/teach/propose', requireServiceKey, rateLimit, licenseGuardAdmin, async (req, res) => {
  try {
    const { widget_id: rawWidgetId, messages } = req.body || {};
    const widget_id = await resolveCanonicalWidgetId(rawWidgetId);

    const cleanMessages = Array.isArray(messages)
      ? messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))
      : [];
    if (cleanMessages.length === 0) {
      return res.status(400).json({ error: 'messages[] is required' });
    }

    let widgetOrgId;
    try { widgetOrgId = (await fetchWidgetMeta(widget_id))?.org_id || undefined; } catch { widgetOrgId = undefined; }
    const providerKeys = await _getProviderKeys(widgetOrgId);
    const geminiKey = providerKeys?.gemini_api_key || process.env.GEMINI_API_KEY;
    const openaiKey = providerKeys?.openai_api_key || process.env.OPENAI_API_KEY;
    const anthropicKey = providerKeys?.anthropic_api_key || (await _getClaudeKeys())?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;

    // Same auto-pick order as /message: prefer the more capable providers.
    const useOpenAI = !!openaiKey;
    const useAnthropic = !useOpenAI && !!anthropicKey;
    const useGemini = !useOpenAI && !useAnthropic && !!geminiKey;
    const provider = useOpenAI ? 'openai' : useGemini ? 'gemini' : 'anthropic';
    const apiKey = useOpenAI ? openaiKey : useGemini ? geminiKey : anthropicKey;
    if (!apiKey) return res.status(502).json({ error: 'No LLM API key configured for this widget' });

    const { pickModelForTier } = require('../lib/quoxchatSmartRouter');
    const model = pickModelForTier('mid', null, provider);

    // quox#547: the proposal only exists in this response body, so a
    // disconnected caller means the turn is pure waste — cancel it.
    const clientAbort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });

    const loopArgs = {
      apiKey,
      model,
      systemPrompt: TEACH_SYSTEM_PROMPT,
      messages: cleanMessages,
      tools: [],
      widget: { id: widget_id, public_key: null, tool_policies: null },
      context: {},
      signal: clientAbort.signal,
    };

    let loopResult;
    try {
      loopResult = useOpenAI
        ? await runOpenAIToolLoop(loopArgs)
        : useGemini
          ? await runGeminiToolLoop(loopArgs)
          : await runAnthropicToolLoop(loopArgs);
    } catch (err) {
      console.error('[QuoxChat] /teach/propose LLM error:', err.message);
      return res.status(502).json({ error: 'llm_error', proposal: { none: true } });
    }

    const parsed = _parseTeachProposal(loopResult.text);
    const isValidProposal = !!(parsed && typeof parsed === 'object' && !parsed.none
      && typeof parsed.question === 'string' && parsed.question.trim()
      && typeof parsed.answer === 'string' && parsed.answer.trim());

    const proposal = isValidProposal
      ? {
        question: parsed.question.trim(),
        answer: parsed.answer.trim(),
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '',
      }
      : { none: true };

    // Lightweight audit envelope — mirrors the fingerprint-not-PII convention
    // used by quoxchat.knowledge.correction: a SHA-256 hash of the proposed
    // answer, never the raw text.
    try {
      _storeAuditEnvelope({
        type: 'event',
        from: 'system.quoxchat',
        to: `agent.quoxchat.${widget_id || 'demo'}`,
        intent: 'quoxchat.teach.proposed',
        payload: {
          widget_id: widget_id || 'demo',
          has_proposal: isValidProposal,
          answer_hash: isValidProposal ? hashInput(proposal.answer) : null,
        },
      });
    } catch { /* non-fatal */ }

    res.json({ success: true, proposal });
  } catch (err) {
    console.error('[QuoxChat] /teach/propose error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CW-10.4 / CW-10.2 — Simulation runner HTTP wrapper ─────────────────────
// Dashboard UI POSTs here with a list of scenarios. We invoke the chat
// endpoint for each (in-process, no HTTP hop), score with the simulator,
// then POST the aggregate to auth's widget_simulation_runs row plus
// per-scenario last_* columns. Runs sequentially to keep provider rate
// limits happy.

const { runScenario, computeSecurityScore, SCENARIO_TIMEOUT_MS } = require('../lib/quoxchatSimulator');

async function persistSimulationRun(widgetId, body) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return null;
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/simulation-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      console.warn(`[QuoxChat] persistSimulationRun ${resp.status}`);
      return null;
    }
    return await resp.json().catch(() => null);
  } catch (err) {
    console.warn('[QuoxChat] persistSimulationRun failed:', err.message);
    return null;
  }
}

router.post('/simulate', requireServiceKey, licenseGuardAdmin, async (req, res) => {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  try {
    const { widget_id, scenarios, scope, simulation } = req.body || {};
    if (!widget_id || !Array.isArray(scenarios) || scenarios.length === 0) {
      return res.status(400).json({ error: 'widget_id and scenarios[] required' });
    }
    if (scenarios.length > 60) {
      return res.status(400).json({ error: 'batch too large (max 60 scenarios)' });
    }

    const chatInvoker = async ({ message, widget_id: wid, visitor_id }) => {
      // Call our own /message endpoint so full pipeline (RAG, tools, guardrails) runs.
      const baseUrl = process.env.COLLECTOR_SELF_URL || 'http://127.0.0.1:9848';
      const resp = await fetch(`${baseUrl}/quoxchat/message`, {
        method: 'POST',
        // W5: /message refuses a request with no Origin; the service key is
        // the guard's one exemption for in-process callers.
        headers: { 'Content-Type': 'application/json', 'x-service-key': process.env.INTERNAL_SERVICE_KEY || '' },
        body: JSON.stringify({ message, widget_id: wid, visitor_id, conversation_history: [], ...(simulation === true ? { simulation: true } : {}) }),
        signal: AbortSignal.timeout(SCENARIO_TIMEOUT_MS),
      });
      const data = await resp.json().catch(() => ({}));
      // A non-2xx or success:false with no reply text is an infrastructure
      // error (rate limit, 5xx), not a bot answer: report it as an error.
      if ((!resp.ok || data.success === false) && !String(data.response || '').trim()) {
        return { text: '', error: data.error || `message endpoint returned HTTP ${resp.status}`, sources: [], tool_calls: [], injection_score: 0 };
      }
      return {
        text: data.response || '',
        sources: data.sources || [],
        tool_calls: data.tool_calls || [],
        injection_score: data.injection_score || 0,
      };
    };

    // QC-BRUTALOOP-W18: grader for rubric.expected_answer. Only built when a
    // scenario needs it; null (-> "not graded") when no provider key resolves.
    let completeForGrading = null;
    if (scenarios.some((sc) => typeof sc?.rubric?.expected_answer === 'string' && sc.rubric.expected_answer.trim())) {
      try {
        const { providerKeys: gKeys } = await _providerKeysAndOrgForWidget(widget_id);
        const gk = {
          anthropic: gKeys?.anthropic_api_key || (await _getClaudeKeys())?.anthropic_api_key || process.env.ANTHROPIC_API_KEY,
          openai: gKeys?.openai_api_key || process.env.OPENAI_API_KEY,
          gemini: gKeys?.gemini_api_key || process.env.GEMINI_API_KEY,
        };
        const answerProv = gk.openai ? 'openai' : gk.anthropic ? 'anthropic' : gk.gemini ? 'gemini' : null;
        if (answerProv) {
          const { pickModelForTier } = require('../lib/quoxchatSmartRouter');
          const vp = pickVerifierModel({ answerProvider: answerProv, keys: gk, pickModel: (t, p) => pickModelForTier(t, null, p), tier: 'mid' });
          const fn = vp.provider === 'openai' ? runOpenAIToolLoop : vp.provider === 'gemini' ? runGeminiToolLoop : runAnthropicToolLoop;
          completeForGrading = ({ system, user }) => fn({
            apiKey: gk[vp.provider], model: vp.model, systemPrompt: system,
            messages: [{ role: 'user', content: user }], tools: [],
            widget: { id: widget_id, public_key: null, tool_policies: null }, context: { toolResultTexts: [] }, onStream: null,
            ...(vp.provider === 'gemini' && /flash/i.test(String(vp.model)) ? { thinkingBudget: 0 } : {}),
          }).then((r) => r && r.text);
        }
      } catch (gErr) { console.warn('[QuoxChat] /simulate grader setup failed:', gErr.message); }
    }

    const results = [];
    for (const s of scenarios) {
      const out = await runScenario(s, { chatInvoker, widget: { id: widget_id }, completeForGrading });
      results.push(out);
    }

    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const timed_out = results.filter(r => r.status === 'timed_out').length;
    const failed = results.filter(r => !r.passed && r.status !== 'timed_out' && r.score < 60).length;
    const warned = total - passed - failed - timed_out;
    const security_score = computeSecurityScore(results);
    const duration_ms = Date.now() - start;

    const runBody = {
      scope: scope || 'all',
      total, passed, warned, failed, security_score,
      duration_ms,
      started_at: startedAt,
      scenario_results: results.map(r => ({
        scenario_id: r.scenario_id,
        passed: r.passed,
        status: r.status,
        score: r.score,
        notes: (r.notes || []).join(' | ').slice(0, 500),
      })),
    };
    const persistResult = await persistSimulationRun(widget_id, runBody);

    res.json({
      run_id: persistResult?.run_id || null,
      total, passed, warned, failed, timed_out, security_score,
      duration_ms,
      results,
    });
  } catch (err) {
    console.error('[QuoxChat] /simulate error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  init,
  chunkAtWordBoundaries,
  isSimulationRequest,
  publicSourceTitle,
  classifyReconcilePoints,
  embedText,
  runAnthropicToolLoop,
  runOpenAIToolLoop,
  runGeminiToolLoop,
  // QCX-4.4: visitor upload store + scoped reader — exported for tests
  // and for /message to inject attachment content into LLM context.
  _visitorUploadStore,
  _visitorUploadRead,
  // QCL-IDENTITY P1: HMAC verifier for identify() user_hash — exported
  // for unit tests.
  verifyUserHash,
  verifyAllowanceSig,
  canonicalAllowance,
  // QUOXCHAT-PRO P1: org alert fan-out — exported for unit tests, with a
  // sink setter so tests capture dispatches without real channel drivers.
  notifyWidgetChannels,
  _setAlertNotificationSink,
  _resetCaptchaFallbackRateLimit,
  _setHardTurnDeadlineMs,
  _hardTurnDeadlineMs: () => hardTurnDeadlineMs(),
  // state reset — exported for tests only.
  _resetCaptchaFallbackRateLimit,
  // REPLY DETERMINISM — exported for unit tests.
  applyActionReplyDeterminism,
  lexicalOnlySearch,
  _setGroundingFaultForTest: (v) => { _groundingFaultForTest = !!v; },
  // QCFT #213 — Qdrant payload filter for one knowledge source; exported
  // for unit tests.
  qdrantFilterForSource,
  // Widget serve-time composition (markdown + cards injection), exported
  // so tests can assert the injected implementations actually win over the
  // in-source fallback stubs (hoisting regression, night audit 2026-07-25).
  composeWidgetJs,
};
