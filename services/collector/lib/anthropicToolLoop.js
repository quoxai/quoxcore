'use strict';
/**
 * CLI-QUOX B2: the governed Anthropic Messages API tool loop for opt-in
 * /chat/stream turns (explicit turn_id), with the SAME contract as the B1
 * OpenAI loop (lib/openaiInvokeDispatcher.js executeOpenAICompatibleToolLoop):
 *
 *  - every model round streams (`stream: true`); each text_delta is handed to
 *    onTextDelta as it arrives; rounds are separated by a blank line and
 *    fullText is exactly the concatenation of the deltas (R1 #36).
 *  - tool_use blocks are assembled from input_json_delta fragments and every
 *    call goes through the SAME governed door as the OpenAI loop
 *    (lib/governedToolDispatch.js -> executeTool: RBAC, QuoxHat membership,
 *    GOV-4 policy, approval gate; VOLT; per-tool AEE/AOCL evidence).
 *  - a call held for approval is reported as approval.requested and answered
 *    to the model as pending, never as a failure; server notes (an approval
 *    resolved mid-turn) and steer text enter at model boundaries.
 *  - interrupt and client disconnect are checked before every model call and
 *    every tool dispatch; the AbortSignal cancels the in-flight provider call.
 *  - a provider error event, a non-2xx status, or a stream that ends before
 *    message_stop fails the turn (throws).
 *  - a tool_use the model did not finish (stop_reason other than tool_use, e.g.
 *    max_tokens) is never dispatched.
 *  - usage: provider token counts summed over the rounds (null when never reported).
 *
 * Pure: deps injected (fetchFn, executeTool, voltEmitter, storeAuditEnvelope,
 * emitToolEvidence), the same deps object as the OpenAI loop.
 */

const { readAnthropicMessagesStream } = require('./anthropicMessagesStream.js');
const { toAnthropicTool } = require('./anthropicTools.js');
const { serializeToolResultForModel, MAX_TOOL_ROUNDS } = require('./openaiInvokeDispatcher.js');
const { createLoopControl, createRoundAbort, frameMidAnswerSteer, frameBoundarySteer, buildGovernedToolCtx, dispatchGovernedToolCall, handleOfferGate } = require('./governedToolDispatch.js');
const { approvalFromResult, classifyToolStatus } = require('./conversationToolEvents.js');

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ROUND_SEPARATOR = '\n\n';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Prior turns (hydrated history, assistant text may carry a bounded
 * `[Tool activity]` prefix) plus the new prompt as valid Messages API turns:
 * user/assistant only, consecutive same-role turns merged, empty turns dropped,
 * never starting with an assistant turn.
 */
function buildAnthropicMessages(userMessage, history) {
  const out = [];
  const push = (role, text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += ROUND_SEPARATOR + text;
    else out.push({ role, content: text });
  };
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (out.length === 0 && m.role === 'assistant') continue;
    push(m.role, textOf(m.content));
  }
  push('user', typeof userMessage === 'string' ? userMessage : textOf(userMessage));
  return out;
}

/** Add content blocks to the trailing user turn (tool_result blocks stay first), or open one. */
function appendUserBlocks(messages, blocks) {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') last.content = last.content ? [{ type: 'text', text: last.content }] : [];
    last.content.push(...blocks);
  } else {
    messages.push({ role: 'user', content: blocks });
  }
}

/** The assistant turn as the API needs it echoed: no private fields, no empty text blocks. */
function echoAssistantBlocks(content, dispatchable) {
  const keep = new Set(dispatchable.map((b) => b.id));
  const out = [];
  for (const b of content) {
    if (b.type === 'text') { if (b.text) out.push({ type: 'text', text: b.text }); continue; }
    if (b.type === 'tool_use') { if (keep.has(b.id)) out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} }); continue; }
    if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const { _closed, _json, ...rest } = b;
      out.push(rest);
    }
  }
  return out;
}

function addUsage(total, u) {
  if (!u) return;
  for (const k of Object.keys(total)) {
    if (typeof u[k] === 'number') total[k] = (total[k] || 0) + u[k];
  }
}

/**
 * executeAnthropicToolLoop(req, opts, deps)
 *
 * opts: apiUrl (default the Messages API), headers (auth + anthropic-version +
 * content-type, built by the caller), model, systemPrompt, userMessage,
 * conversation_history, agentTools, selected_agent, session_id,
 * effectiveSessionId, userId, orgId, userAccessToken, memory_context,
 * quox_context, voltRunId, hatManifest, evidenceCorrId, onEvent, control,
 * signal, onTextDelta, timeoutMs, maxTokens, providerLabel.
 *
 * @returns {Promise<{content, toolsUsed, data, fullText, usage, stopped?}>}
 */
async function executeAnthropicToolLoop(req, opts, deps) {
  const {
    apiUrl = ANTHROPIC_MESSAGES_URL,
    headers,
    model,
    systemPrompt,
    userMessage,
    selected_agent,
    agentTools = [],
    timeoutMs = 120000,
    maxTokens = 4096,
    providerLabel = 'Anthropic',
    conversation_history,
    voltRunId,
    evidenceCorrId,
    session_id,
    effectiveSessionId,
    onEvent,
    control,
    signal,
    onTextDelta,
    toolOffer, // D3: per-turn offer (see openaiInvokeDispatcher); absent = unchanged
  } = opts;
  const { fetchFn, executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence } = deps || {};
  if (typeof fetchFn !== 'function') {
    throw new Error('executeAnthropicToolLoop: no fetch implementation available');
  }

  const { stopReason, takeSteer, takeNotes, hasSteer } = createLoopControl(control);
  const emitEvent = (ev) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(ev); } catch { /* a client-facing event must never break the governed loop */ }
  };
  let fullText = '';
  const appendText = (t) => {
    if (!t) return;
    fullText += t;
    if (typeof onTextDelta === 'function') { try { onTextDelta(t); } catch { /* a client write must never break the governed loop */ } }
  };
  const usage = { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null };
  const toolsUsed = [];
  const toolOutcomes = []; // #889: {tool,status} so a delegated specialist's calls surface in the parent turn
  const stoppedResult = (reason, lastContent) => ({ content: lastContent || '', toolsUsed, toolOutcomes, data: null, stopped: reason, fullText, usage });
  const applySteer = (texts) => {
    appendUserBlocks(messages, texts.map((text) => ({ type: 'text', text: frameBoundarySteer(text) })));
    for (const text of texts) emitEvent({ type: 'steer.applied', text });
  };

  const messages = buildAnthropicMessages(userMessage, conversation_history);
  const anthropicTools = agentTools.length > 0 ? agentTools.map(toAnthropicTool) : [];
  // QUOXON-ADV: provider-safe names out, registered names back (history keeps the provider's own blocks)
  const decodeToolName = require('./providerToolNames.js').toolNameDecoder(() => (toolOffer ? [...agentTools, ...toolOffer.tools()] : agentTools));
  const toolCtx = buildGovernedToolCtx(req, opts);
  const toolDeps = { executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence };

  let lastContent = '';
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const stopBeforeModel = stopReason();
    if (stopBeforeModel) return stoppedResult(stopBeforeModel, lastContent);
    // Server facts first, then the user's steer, so the user's words are the last thing read.
    appendUserBlocks(messages, takeNotes().map((n) => ({ type: 'text', text: `[Server note] ${n}` })));
    const steer = takeSteer();
    if (steer.length > 0) applySteer(steer);

    if (voltEmitter && typeof voltEmitter.emit === 'function') {
      voltEmitter.emit(voltRunId, 'model.requested', {
        actor: { actor_type: 'system', actor_id: 'collector' },
        model, round, provider: providerLabel,
      });
    }

    const body = { model, max_tokens: maxTokens, system: systemPrompt, messages, stream: true };
    // D3: the offer only grows within a turn, so every tool_use in history stays defined.
    const roundTools = toolOffer && anthropicTools.length > 0 ? toolOffer.tools().map(toAnthropicTool) : anthropicTools;
    if (roundTools.length > 0) {
      // History holds tool_use blocks, so the definitions stay; the last round may not call one.
      body.tools = roundTools;
      if (round === MAX_TOOL_ROUNDS) body.tool_choice = { type: 'none' };
    }
    const roundAbort = typeof control?.hasSteer === 'function' ? createRoundAbort(signal) : null;
    const roundSignal = roundAbort ? roundAbort.signal : signal;
    const response = await fetchFn(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(roundSignal ? { signal: roundSignal } : {}),
    }, timeoutMs);

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`${providerLabel} API returned ${response.status}: ${errText.substring(0, 200)}`);
      err.status = response.status;
      err.body = errText;
      throw err;
    }

    let roundStarted = false;
    const msg = await readAnthropicMessagesStream(response, {
      providerLabel,
      idleTimeoutMs: timeoutMs,
      // A steer that arrives while the answer streams cuts it here (never once a tool_use began).
      ...(roundAbort ? { interruptWhen: () => !stopReason() && hasSteer() } : {}),
      onTextDelta: (d) => {
        if (!roundStarted && fullText) appendText(ROUND_SEPARATOR);
        roundStarted = true;
        appendText(d);
      },
    });
    if (msg.steerInterrupted && roundAbort) roundAbort.abort();
    addUsage(usage, msg.usage);

    const content = msg.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    const toolUses = msg.content.filter((b) => b.type === 'tool_use' && b.name);
    // Only a finished tool_use round is acted on: a call cut off by max_tokens is never run.
    const dispatchable = msg.stop_reason === 'tool_use' && round < MAX_TOOL_ROUNDS
      ? toolUses.filter((b) => !b._incomplete && b.id)
      : [];

    if (voltEmitter && typeof voltEmitter.emit === 'function') {
      voltEmitter.emit(voltRunId, 'model.responded', {
        actor: { actor_type: 'agent', actor_id: selected_agent },
        model, round, provider: providerLabel,
        tool_call_count: dispatchable.length,
        input_tokens: msg.usage?.input_tokens ?? undefined,
        output_tokens: msg.usage?.output_tokens ?? undefined,
      });
    }

    lastContent = content || lastContent;
    if (msg.steerInterrupted) {
      // The partial text already reached the client: keep it as the assistant turn and
      // continue from it with the steer, so nothing is streamed twice.
      const early = takeSteer();
      if (early.length > 0) {
        if (content) messages.push({ role: 'assistant', content: [{ type: 'text', text: content }] });
        appendUserBlocks(messages, [{ type: 'text', text: frameMidAnswerSteer(early) }]);
        for (const text of early) emitEvent({ type: 'steer.applied', text, applied_at: 'mid_answer' });
        continue;
      }
    }
    if (dispatchable.length === 0 && round < MAX_TOOL_ROUNDS && !stopReason()) {
      // A steer that arrived while the final model call was in flight is not
      // dropped: answer-then-steer becomes one more round carrying it.
      const late = takeSteer();
      if (late.length > 0) {
        const echoed = echoAssistantBlocks(msg.content, []);
        if (echoed.length > 0) messages.push({ role: 'assistant', content: echoed });
        applySteer(late);
        continue;
      }
    }
    if (dispatchable.length === 0 || round === MAX_TOOL_ROUNDS) {
      const lateStop = stopReason();
      if (lateStop === 'interrupted') {
        return { content, toolsUsed, toolOutcomes, data: msg, stopped: lateStop, fullText, usage };
      }
      // BRAIN2-V2-1 parity with the OpenAI loop: retrieval -> answer, not awaited.
      try {
        const { finalizeAnswer } = require('./brainCitationTrace.js');
        Promise.resolve(finalizeAnswer(effectiveSessionId || session_id, content)).catch(() => {});
      } catch { /* non-fatal: evidence must never affect the chat path */ }
      return { content, toolsUsed, toolOutcomes, data: msg, fullText, usage };
    }

    messages.push({ role: 'assistant', content: echoAssistantBlocks(msg.content, dispatchable) });
    const results = [];
    for (const raw of dispatchable) {
      const call = { ...raw, name: decodeToolName(raw.name) };
      const stopBeforeTool = stopReason();
      if (stopBeforeTool) return stoppedResult(stopBeforeTool, lastContent);
      const gated = handleOfferGate({ toolOffer, callId: call.id, toolName: call.name, input: call.input || {}, emitEvent });
      if (gated) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(gated), ...(gated.success === false ? { is_error: true } : {}) });
        continue;
      }
      toolsUsed.push(call.name);
      const toolResult = await dispatchGovernedToolCall({
        callId: call.id, toolName: call.name, startedInput: call.input || {},
        input: call.input || {}, argsError: call._inputError || null, toolCtx, emitEvent,
        selectedAgent: selected_agent, providerLabel, voltRunId, evidenceCorrId, deps: toolDeps,
      });
      const isError = !approvalFromResult(toolResult) && toolResult && toolResult.success === false;
      try { toolOutcomes.push({ tool: call.name, status: approvalFromResult(toolResult) ? 'denied' : classifyToolStatus(toolResult) }); } catch { toolOutcomes.push({ tool: call.name, status: isError ? 'failed' : 'ok' }); }
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: serializeToolResultForModel(call.name, toolResult),
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  const limitText = 'Tool execution limit reached. Please try a more specific query.';
  appendText(fullText ? ROUND_SEPARATOR + limitText : limitText);
  return { content: limitText, toolsUsed, data: null, fullText, usage };
}

module.exports = { executeAnthropicToolLoop, buildAnthropicMessages, ANTHROPIC_MESSAGES_URL };
