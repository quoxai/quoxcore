/**
 * LLM-CHOICE OpenAI tool parity — pure extraction of server.js's
 * executeOpenAICompatibleToolLoop (+ serializeToolResultForModel).
 *
 * This is the SAME loop that already powers handleOpenAIChat (explicit
 * provider=openai chat requests) and handleLocalInferenceChat — proven in
 * production (org_directory tool calls succeed on that path today). The
 * governed stack-mode failover leg (attemptOpenAiInvoke / invokeOpenAi in
 * server.js) previously did NOT go through this loop at all: it built a
 * bare single-shot completion with no tools array and hardcoded
 * toolsUsed: []. This extraction lets both legs call the identical loop
 * instead of maintaining two implementations of OpenAI tool calling.
 *
 * Mirrors lib/claudeMessagesDispatcher.js's shape on purpose: pure
 * function, deps injected (fetchFn/executeTool/voltEmitter/
 * storeAuditEnvelope/emitToolEvidence), no server.js globals reached into
 * directly. Behavioural contract is byte-identical to the pre-extraction
 * server.js function — every line below is the original body with global
 * references replaced by their deps.* equivalent.
 *
 *   - Max 5 tool rounds (round 0..5 inclusive = 6 iterations; matches
 *     claudeMessagesDispatcher's MAX_TOOL_ROUNDS).
 *   - Every tool call executes through deps.executeTool with the same
 *     ctx shape (agentId/userId/orgId/token/session_id/...) the Anthropic
 *     leg's toolCtx uses. RBAC, GOV-4 policy, and the approval gate all
 *     live INSIDE executeTool (agentTools.js) — this module does not
 *     re-implement or bypass any of that, it only calls the same door.
 *   - Malformed tool_call JSON arguments degrade to an error tool-result
 *     instead of killing the turn.
 */

const {
  toOpenAIChatTools,
  buildOpenAIChatCompletionBody,
  buildOpenAIStyleConversationMessages,
  flattenOpenAIMessageContent,
} = require('./openaiRequest.js');

const { createLoopControl, buildGovernedToolCtx, dispatchGovernedToolCall, handleOfferGate } = require('./governedToolDispatch.js');

const { readOpenAIChatStream } = require('./openaiChatStream.js');

const MAX_TOOL_ROUNDS = 5;
const ROUND_SEPARATOR = '\n\n';

function safeParseArgs(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const { classifyToolStatus: _classifyToolStatus, approvalFromResult: _approvalFromResult } = require('./conversationToolEvents.js'); // #889
function serializeToolResultForModel(toolName, toolResult) {
  // A gated tool held for a human is not a failure: say so, with the id, so the model
  // reports "pending approval" instead of an empty tool_error (seen live 2026-10-08).
  if (toolResult?.pending === true || toolResult?._approval?.status === 'pending') {
    return JSON.stringify({
      status: 'pending_approval',
      approval_id: toolResult._approval?.id || toolResult.approvalId || null,
      message: toolResult.message || toolResult.error || 'Waiting for a human to approve this action.',
      tool: toolName,
    });
  }
  if (toolResult?.success === false) {
    return JSON.stringify({
      error: true,
      error_type: toolResult.error?.includes('not authorized') ? 'auth_error'
        : toolResult.error?.includes('timeout') || toolResult.error?.includes('aborted') ? 'timeout_error'
          : toolResult.error?.includes('Unknown tool') ? 'config_error'
            : 'tool_error',
      message: toolResult.error || toolResult.message,
      tool: toolName,
    });
  }

  if (Array.isArray(toolResult?.images) && toolResult.images.length > 0) {
    return JSON.stringify({
      success: true,
      count: toolResult.images.length,
      note: 'Images generated successfully and are available to the user.',
    });
  }

  return JSON.stringify(toolResult || {}, null, 2).substring(0, 10000);
}

/**
 * executeOpenAICompatibleToolLoop(req, opts, deps)
 *
 * @param {object} req - Express request (only req.body._delegation_depth
 *   and req.body.voice_mode are read; may be `{ body: {} }` for callers
 *   with no live request, e.g. the stack-mode failover leg).
 * @param {object} opts - apiUrl, headers, model, systemPrompt, userMessage,
 *   selected_agent, session_id, agentTools, timeoutMs, providerLabel,
 *   userId, orgId, userAccessToken, memory_context, quox_context,
 *   conversation_history, voltRunId.
 * @param {object} deps - fetchFn(url, options, timeoutMs), executeTool,
 *   voltEmitter, storeAuditEnvelope, emitToolEvidence.
 */
async function executeOpenAICompatibleToolLoop(req, opts, deps) {
  const {
    apiUrl,
    headers,
    model,
    systemPrompt,
    userMessage,
    selected_agent,
    session_id,
    agentTools = [],
    timeoutMs = 120000,
    providerLabel = 'openai-compatible',
    userId,
    orgId,
    userAccessToken,
    memory_context,
    quox_context,
    conversation_history,
    voltRunId, // CRP-AU-4: optional VOLT run for evidence tracking
    hatManifest, // QUOXHAT P2: arms the executeTool membership gate when enforced
    effectiveSessionId, // QUOXHAT P4: hat-binding conversation key
    // CLI-QUOXON Q2 (all optional; absent = byte-identical legacy behaviour):
    evidenceCorrId, // turn_id: corr for the per-tool AEE/AOCL envelopes
    onEvent, // conversation events: tool.started/finished, approval.requested
    // control: { shouldStop(): string|null, drainSteer(): string[], drainNotes?(): string[] }.
    // shouldStop is checked before every model call and before every tool dispatch (an
    // already dispatched tool always completes); drainSteer and drainNotes are read at
    // each model boundary (notes: server facts such as an approval resolved mid-turn).
    control,
    signal, // AbortSignal: cancels the in-flight provider call (quox#547)
    // CLI-QUOX B1: when a function, every model call streams (`stream: true`) and each
    // text fragment is handed over as it arrives. Absent = the JSON path, unchanged.
    onTextDelta,
    // CLI-QUOX B5: vendor request extras (OpenRouter usage accounting). Keys the loop already
    // sets (model, messages, tools, stream, ...) are never overridden. Absent = unchanged.
    extraBody,
    // D3: per-turn tool offer (lib/turnToolSelection.js createToolOffer). When set, each
    // round sends toolOffer.tools() instead of agentTools, and a call to a tool that was
    // not offered is refused before executeTool. Absent = unchanged.
    toolOffer,
    // QUOXON: called once per model round with that round's reasoning text (when the model
    // returned any). It is never part of content or fullText. Absent = unchanged.
    onReasoning,
  } = opts;
  // B2: the control accessors, toolCtx and per-call dispatch are shared with the
  // Anthropic loop (lib/governedToolDispatch.js); behaviour unchanged.
  const { stopReason, takeSteer, takeNotes, hasSteer } = createLoopControl(control);
  // B1 / R1 #36: every round's text (intermediate answers included) in order, separated
  // by a blank line. In streaming mode it is exactly the concatenation of the deltas.
  const streaming = typeof onTextDelta === 'function';
  let fullText = '';
  const appendText = (t) => {
    if (!t) return;
    fullText += t;
    if (streaming) { try { onTextDelta(t); } catch { /* a client write must never break the governed loop */ } }
  };
  // QUOX-MODEL: provider usage summed across every model round (stream_options.include_usage).
  const { addRoundUsage, newUsageAccumulator } = require('./openaiTurnUsage.js');
  const usage = newUsageAccumulator();
  const stoppedResult = (reason, lastContent) => ({ content: lastContent || '', toolsUsed, toolOutcomes, data: null, stopped: reason, fullText, usage });
  const emitEvent = (ev) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(ev); } catch { /* a client-facing event must never break the governed loop */ }
  };

  const { fetchFn, executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence } = deps || {};
  if (typeof fetchFn !== 'function') {
    throw new Error('executeOpenAICompatibleToolLoop: no fetch implementation available');
  }

  const messages = buildOpenAIStyleConversationMessages(systemPrompt, userMessage, conversation_history);
  const openAITools = agentTools.length > 0 ? toOpenAIChatTools(agentTools) : [];
  const roundToolsFor = () => (toolOffer && agentTools.length > 0 ? toOpenAIChatTools(toolOffer.tools()) : openAITools);
  // QUOXON-ADV: provider-safe names out, registered names back (toolsmith.runScript <-> toolsmith__runScript)
  const decodeToolName = require('./providerToolNames.js').toolNameDecoder(() => (toolOffer ? [...agentTools, ...toolOffer.tools()] : agentTools));
  const toolsUsed = [];
  const toolOutcomes = []; // #889
  const maxToolRounds = MAX_TOOL_ROUNDS;
  const toolCtx = buildGovernedToolCtx(req, {
    selected_agent, userId, orgId, userAccessToken, memory_context, quox_context,
    conversation_history, session_id, effectiveSessionId, hatManifest,
  });

  let lastContent = '';
  for (let round = 0; round <= maxToolRounds; round++) {
    const stopBeforeModel = stopReason();
    if (stopBeforeModel) return stoppedResult(stopBeforeModel, lastContent);
    // Steer: queued user text enters at this model boundary.
    for (const text of takeSteer()) {
      messages.push({ role: 'user', content: require('./governedToolDispatch.js').frameBoundarySteer(text) });
      emitEvent({ type: 'steer.applied', text });
    }
    for (const note of takeNotes()) messages.push({ role: 'system', content: note });
    // CRP-AU-4: VOLT — model request
    if (voltEmitter && typeof voltEmitter.emit === 'function') {
      voltEmitter.emit(voltRunId, 'model.requested', {
        actor: { actor_type: 'system', actor_id: 'collector' },
        model, round, provider: providerLabel,
      });
    }

    const roundTools = roundToolsFor();
    const requestBody = buildOpenAIChatCompletionBody({
      model,
      messages,
      maxTokens: 4096,
      tools: roundTools.length > 0 && round < maxToolRounds ? roundTools : undefined,
      toolChoice: 'auto',
    });
    if (streaming) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }
    if (extraBody && typeof extraBody === 'object') {
      for (const [k, v] of Object.entries(extraBody)) {
        if (!['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options'].includes(k) && !(k in requestBody)) requestBody[k] = v;
      }
    }
    const roundAbort = streaming && typeof control?.hasSteer === 'function' ? require('./governedToolDispatch.js').createRoundAbort(signal) : null;
    const roundSignal = roundAbort ? roundAbort.signal : signal;
    const response = await fetchFn(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      ...(roundSignal ? { signal: roundSignal } : {}),
    }, timeoutMs);

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`${providerLabel} API returned ${response.status}: ${errText.substring(0, 200)}`);
      err.status = response.status;
      err.body = errText;
      if (
        roundTools.length > 0 &&
        round === 0 &&
        response.status === 400 &&
        /(tool|function|tool_choice|tool_calls)/i.test(errText)
      ) {
        err.code = 'tool_calling_unsupported';
      }
      throw err;
    }

    let data;
    if (streaming) {
      let roundStarted = false;
      data = await readOpenAIChatStream(response, {
        providerLabel,
        idleTimeoutMs: timeoutMs,
        // A steer that arrives while the answer streams cuts it here (never mid tool call).
        ...(roundAbort ? { interruptWhen: () => !stopReason() && hasSteer() } : {}),
        onTextDelta: (d) => {
          if (!roundStarted && fullText) appendText(ROUND_SEPARATOR);
          roundStarted = true;
          appendText(d);
        },
      });
      if (data.steerInterrupted && roundAbort) roundAbort.abort();
    } else {
      data = await response.json();
    }
    addRoundUsage(usage, data && data.usage);
    const assistantMessage = data.choices?.[0]?.message || {};
    const content = flattenOpenAIMessageContent(assistantMessage.content);
    const roundReasoning = typeof assistantMessage.reasoning === 'string' ? assistantMessage.reasoning
      : (typeof assistantMessage.reasoning_content === 'string' ? assistantMessage.reasoning_content : '');
    if (roundReasoning && typeof onReasoning === 'function') {
      try { onReasoning(roundReasoning, { round }); } catch { /* a stage event must never break the governed loop */ }
    }
    const toolCalls = Array.isArray(assistantMessage.tool_calls)
      ? assistantMessage.tool_calls.filter((call) => call?.type === 'function' && call.function?.name)
      : [];

    // CRP-AU-4: VOLT — model responded
    if (voltEmitter && typeof voltEmitter.emit === 'function') {
      voltEmitter.emit(voltRunId, 'model.responded', {
        actor: { actor_type: 'agent', actor_id: selected_agent },
        model, round, provider: providerLabel,
        tool_call_count: toolCalls.length,
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
      });
    }

    lastContent = content || lastContent;
    if (data.steerInterrupted) {
      // The partial answer already reached the client: keep it as the assistant turn and
      // continue from it with the steer, so nothing is streamed twice.
      const early = takeSteer();
      if (early.length > 0) {
        if (content) messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: require('./governedToolDispatch.js').frameMidAnswerSteer(early) });
        for (const text of early) emitEvent({ type: 'steer.applied', text, applied_at: 'mid_answer' });
        continue;
      }
    }
    if (!streaming && content) appendText(fullText ? ROUND_SEPARATOR + content : content);
    if (toolCalls.length === 0 && round < maxToolRounds && !stopReason()) {
      // A steer that arrived while the final model call was in flight is not
      // dropped: answer-then-steer becomes one more round carrying it.
      const late = takeSteer();
      if (late.length > 0) {
        messages.push({ role: 'assistant', content: content || '' });
        for (const text of late) {
          messages.push({ role: 'user', content: require('./governedToolDispatch.js').frameBoundarySteer(text) });
          emitEvent({ type: 'steer.applied', text });
        }
        continue;
      }
    }
    if (toolCalls.length === 0 || round === maxToolRounds) {
      // An interrupt that landed during this final model call: the answer is complete,
      // but say so honestly (stopped) rather than reporting an uninterrupted turn.
      const lateStop = stopReason();
      if (lateStop === 'interrupted') {
        return { content, toolsUsed, toolOutcomes, data, stopped: lateStop, fullText, usage };
      }
      // BRAIN2-V2-1: retrieval → answer. Same key this path puts on the tool
      // ctx above (toolCtx.session_id = `session_id || undefined`), so the
      // register and finalize ends cannot disagree. No-op unless this turn
      // called quoxbrain_search. Not awaited — never adds answer latency.
      try {
        const { finalizeAnswer } = require('./brainCitationTrace.js');
        Promise.resolve(finalizeAnswer(effectiveSessionId || session_id, content)).catch(() => {});
      } catch { /* non-fatal — evidence must never affect the chat path */ }
      return { content, toolsUsed, toolOutcomes, data, fullText, usage };
    }

    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    for (const call of toolCalls) {
      const stopBeforeTool = stopReason();
      if (stopBeforeTool) return stoppedResult(stopBeforeTool, lastContent);
      const toolName = decodeToolName(call.function.name);
      const gated = handleOfferGate({ toolOffer, callId: call.id, toolName, input: safeParseArgs(call.function.arguments), emitEvent });
      if (gated) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(gated).substring(0, 10000) });
        continue;
      }
      toolsUsed.push(toolName);

      let parsedInput = {};
      let argsError = null;
      try {
        parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        argsError = err.message;
      }
      const toolResult = await dispatchGovernedToolCall({
        callId: call.id, toolName, startedInput: safeParseArgs(call.function.arguments),
        input: parsedInput, argsError, toolCtx, emitEvent, selectedAgent: selected_agent,
        providerLabel, voltRunId, evidenceCorrId,
        deps: { executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence },
      });

      try { toolOutcomes.push({ tool: toolName, status: _approvalFromResult(toolResult) ? 'denied' : _classifyToolStatus(toolResult) }); } catch { toolOutcomes.push({ tool: toolName, status: (toolResult && toolResult.success === false) ? 'failed' : 'ok' }); }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResultForModel(toolName, toolResult),
      });
    }
  }

  const limitText = 'Tool execution limit reached. Please try a more specific query.';
  appendText(fullText ? ROUND_SEPARATOR + limitText : limitText);
  return {
    content: limitText,
    toolsUsed,
    data: null,
    fullText,
    usage,
  };
}

module.exports = { executeOpenAICompatibleToolLoop, serializeToolResultForModel, MAX_TOOL_ROUNDS };
