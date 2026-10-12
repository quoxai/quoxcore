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

const MAX_TOOL_ROUNDS = 5;

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
  } = opts;

  const { fetchFn, executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence } = deps || {};
  if (typeof fetchFn !== 'function') {
    throw new Error('executeOpenAICompatibleToolLoop: no fetch implementation available');
  }

  const messages = buildOpenAIStyleConversationMessages(systemPrompt, userMessage, conversation_history);
  const openAITools = agentTools.length > 0 ? toOpenAIChatTools(agentTools) : [];
  const toolsUsed = [];
  const maxToolRounds = MAX_TOOL_ROUNDS;
  const toolCtx = {
    agentId: selected_agent,
    userId: userId || undefined,
    orgId: orgId || undefined,
    token: userAccessToken || undefined,
    _delegationDepth: req?.body?._delegation_depth || 0,
    memory_context: memory_context || undefined,
    quox_context: quox_context || undefined,
    conversation_history: conversation_history || undefined,
    session_id: effectiveSessionId || session_id || undefined,
    conversationId: effectiveSessionId || session_id || undefined, // QUOXHAT P4
    voice_mode: req?.body?.voice_mode || 'hal',
    hatManifest: hatManifest || undefined, // QUOXHAT P2 membership gate context
  };

  for (let round = 0; round <= maxToolRounds; round++) {
    // CRP-AU-4: VOLT — model request
    if (voltEmitter && typeof voltEmitter.emit === 'function') {
      voltEmitter.emit(voltRunId, 'model.requested', {
        actor: { actor_type: 'system', actor_id: 'collector' },
        model, round, provider: providerLabel,
      });
    }

    const response = await fetchFn(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOpenAIChatCompletionBody({
        model,
        messages,
        maxTokens: 4096,
        tools: openAITools.length > 0 && round < maxToolRounds ? openAITools : undefined,
        toolChoice: 'auto',
      })),
    }, timeoutMs);

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`${providerLabel} API returned ${response.status}: ${errText.substring(0, 200)}`);
      err.status = response.status;
      err.body = errText;
      if (
        openAITools.length > 0 &&
        round === 0 &&
        response.status === 400 &&
        /(tool|function|tool_choice|tool_calls)/i.test(errText)
      ) {
        err.code = 'tool_calling_unsupported';
      }
      throw err;
    }

    const data = await response.json();
    const assistantMessage = data.choices?.[0]?.message || {};
    const content = flattenOpenAIMessageContent(assistantMessage.content);
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

    if (toolCalls.length === 0 || round === maxToolRounds) {
      // BRAIN2-V2-1: retrieval → answer. Same key this path puts on the tool
      // ctx above (toolCtx.session_id = `session_id || undefined`), so the
      // register and finalize ends cannot disagree. No-op unless this turn
      // called quoxbrain_search. Not awaited — never adds answer latency.
      try {
        const { finalizeAnswer } = require('./brainCitationTrace.js');
        Promise.resolve(finalizeAnswer(effectiveSessionId || session_id, content)).catch(() => {});
      } catch { /* non-fatal — evidence must never affect the chat path */ }
      return { content, toolsUsed, data };
    }

    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    for (const call of toolCalls) {
      const toolName = call.function.name;
      toolsUsed.push(toolName);

      let toolResult;
      let parsedInput = {}; // hoisted so the T1/D1 evidence emit below can bind it
      const toolStart = Date.now();
      try {
        parsedInput = call.function.arguments
          ? JSON.parse(call.function.arguments)
          : {};
        // QUOXTRUST D6: this dispatcher emits its own per-tool evidence (below);
        // opt the executeTool choke out to avoid a double-emit.
        if (toolCtx) toolCtx._callerEmitsToolEvidence = true;
        toolResult = typeof executeTool === 'function'
          ? await executeTool(toolName, parsedInput, toolCtx)
          : { success: false, error: 'executeTool dep missing' };
      } catch (err) {
        toolResult = {
          success: false,
          error: `Invalid tool arguments for ${toolName}: ${err.message}`,
        };
      }

      // CRP-AU-4: VOLT — tool executed
      if (voltEmitter && typeof voltEmitter.emit === 'function') {
        voltEmitter.emit(voltRunId, 'tool.call.executed', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          tool: toolName, success: toolResult.success !== false,
          duration_ms: Date.now() - toolStart, provider: providerLabel,
          error: toolResult.success === false ? (toolResult.error || 'unknown') : undefined,
        });
      }

      // P2 evidence parity: per-tool AEE/AOCL envelope + NOC outcome, matching
      // the /api/v1/tools/execute gold path so agent-chat actions are evidenced.
      if (typeof emitToolEvidence === 'function') {
        emitToolEvidence({
          toolName,
          input: parsedInput, // QUOXTRUST T1/D1: bind the effective action into the receipt
          ctx: { agentId: toolCtx.agentId || selected_agent, orgId: toolCtx.orgId, userId: toolCtx.userId },
          corrId: toolCtx.session_id || voltRunId,
          durationMs: Date.now() - toolStart,
          success: toolResult.success !== false && !toolResult.error,
          error: (toolResult.success === false || toolResult.error) ? (toolResult.error || 'unknown') : undefined,
          storeAuditEnvelope,
        });
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResultForModel(toolName, toolResult),
      });
    }
  }

  return {
    content: 'Tool execution limit reached. Please try a more specific query.',
    toolsUsed,
    data: null,
  };
}

module.exports = { executeOpenAICompatibleToolLoop, serializeToolResultForModel, MAX_TOOL_ROUNDS };
