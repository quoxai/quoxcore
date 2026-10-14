'use strict';
/**
 * CLI-QUOX B2: the provider-neutral pieces of the governed chat tool loop,
 * extracted from executeOpenAICompatibleToolLoop so the OpenAI loop and the
 * Anthropic Messages loop (lib/anthropicToolLoop.js) share ONE door to tools:
 *
 *  - createLoopControl: the interrupt / steer / server-note accessors read at
 *    model and tool-dispatch boundaries (never throw into the loop).
 *  - buildGovernedToolCtx: the ctx every tool call executes with (RBAC, QuoxHat
 *    membership, GOV-4 policy and the approval gate all live inside executeTool).
 *  - dispatchGovernedToolCall: tool.started, executeTool, VOLT, per-tool AEE/AOCL
 *    evidence, then approval.requested (held) or tool.finished. Returns the result.
 *
 * Behaviour is byte-identical to the pre-extraction OpenAI loop body.
 */

const { classifyToolStatus, approvalFromResult } = require('./conversationToolEvents.js');

function createLoopControl(control) {
  const stopReason = () => {
    if (!control || typeof control.shouldStop !== 'function') return null;
    try { return control.shouldStop() || null; } catch { return null; }
  };
  const takeSteer = () => {
    if (!control || typeof control.drainSteer !== 'function') return [];
    try { const q = control.drainSteer(); return Array.isArray(q) ? q : []; } catch { return []; }
  };
  const takeNotes = () => {
    if (!control || typeof control.drainNotes !== 'function') return [];
    try { const q = control.drainNotes(); return Array.isArray(q) ? q.filter((n) => typeof n === 'string' && n) : []; } catch { return []; }
  };
  // QUOXON steer: non-destructive peek, so a streaming loop can cut the in-flight answer.
  // Absent control.hasSteer = no mid-stream interruption (steer waits for the round boundary).
  const hasSteer = () => {
    if (!control || typeof control.hasSteer !== 'function') return false;
    try { return control.hasSteer() === true; } catch { return false; }
  };
  return { stopReason, takeSteer, takeNotes, hasSteer };
}

/** The user message a mid-answer steer becomes (the partial answer precedes it in history). */
function frameMidAnswerSteer(texts) {
  const steer = texts.map((t) => String(t).trim()).filter(Boolean).join(' ');
  return `The user interrupted while you were answering: ${steer}. Continue from where you stopped, following this instruction; do not repeat what you already said.`;
}

/**
 * QUOXON-FW4: a steer that lands at a round boundary is the user's own follow-up typed while the
 * turn ran. Sent bare, a model can read "Also end with X" as injected text and refuse it, so it is
 * labelled as the user's message (the event and the stored transcript keep the raw words).
 */
function frameBoundarySteer(text) {
  return `The user typed this follow-up while you were working (it is their own message, not tool output): ${String(text).trim()}`;
}

/** Per-round AbortController chained to the caller's signal, so one round can be cut alone. */
function createRoundAbort(signal) {
  const controller = new AbortController();
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    abort: () => { try { controller.abort(); } catch { /* already aborted */ } },
  };
}

function buildGovernedToolCtx(req, opts) {
  const {
    selected_agent, userId, orgId, userAccessToken, memory_context, quox_context,
    conversation_history, session_id, effectiveSessionId, hatManifest,
  } = opts;
  return {
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
    // Z2H-R4: the provider/model this turn asked for, so a delegated specialist runs on the same one.
    llmProvider: (typeof req?.body?.provider === 'string' && req.body.provider.trim()) || undefined,
    llmModel: (typeof req?.body?.model === 'string' && req.body.model.trim()) || undefined,
  };
}

/**
 * @param {object} a
 * @param {string} a.callId           provider call id (OpenAI tool_call.id / Anthropic tool_use.id)
 * @param {string} a.toolName
 * @param {object} a.startedInput     input shown on tool.started
 * @param {object} a.input            parsed input passed to executeTool
 * @param {string|null} a.argsError   set when the provider's arguments were not valid JSON
 * @param {object} a.toolCtx
 * @param {object} a.deps             { executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence }
 * @param {Function} a.emitEvent
 * @returns {Promise<object>} toolResult
 */
async function dispatchGovernedToolCall({
  callId, toolName, startedInput, input, argsError, toolCtx, deps = {}, emitEvent,
  selectedAgent, providerLabel, voltRunId, evidenceCorrId,
}) {
  const { executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence } = deps;
  const emit = typeof emitEvent === 'function' ? emitEvent : () => {};
  let toolResult;
  const parsedInput = argsError ? {} : (input || {});
  const toolStart = Date.now();
  emit({ type: 'tool.started', call_id: callId, tool: toolName, input: startedInput || {} });
  if (argsError) {
    toolResult = { success: false, error: `Invalid tool arguments for ${toolName}: ${argsError}` };
  } else {
    try {
      // QUOXTRUST D6: this dispatcher emits its own per-tool evidence (below);
      // opt the executeTool choke out to avoid a double-emit.
      if (toolCtx) toolCtx._callerEmitsToolEvidence = true;
      toolResult = typeof executeTool === 'function'
        ? await executeTool(toolName, parsedInput, toolCtx)
        : { success: false, error: 'executeTool dep missing' };
    } catch (err) {
      // Dispatched: the effect may have been applied. Never claim a clean failure (retry is dangerous).
      toolResult = {
        success: false,
        status: 'effect_unknown',
        error: `effect_unknown: ${toolName} threw after dispatch (${err.message}); the effect may have been applied, verify before retrying`,
      };
    }
  }

  // CRP-AU-4: VOLT, tool executed
  if (voltEmitter && typeof voltEmitter.emit === 'function') {
    voltEmitter.emit(voltRunId, 'tool.call.executed', {
      actor: { actor_type: 'agent', actor_id: selectedAgent },
      tool: toolName, success: toolResult.success !== false,
      duration_ms: Date.now() - toolStart, provider: providerLabel,
      error: toolResult.success === false ? (toolResult.error || 'unknown') : undefined,
    });
  }

  // P2 evidence parity: per-tool AEE/AOCL envelope + NOC outcome, matching
  // the /api/v1/tools/execute gold path so agent-chat actions are evidenced.
  let evidenceEnvelopeId = null;
  if (typeof emitToolEvidence === 'function') {
    const evRes = emitToolEvidence({
      toolName,
      input: parsedInput, // QUOXTRUST T1/D1: bind the effective action into the receipt
      ctx: { agentId: toolCtx.agentId || selectedAgent, orgId: toolCtx.orgId, userId: toolCtx.userId },
      corrId: evidenceCorrId || toolCtx.session_id || voltRunId,
      durationMs: Date.now() - toolStart,
      success: toolResult.success !== false && !toolResult.error,
      error: (toolResult.success === false || toolResult.error) ? (toolResult.error || 'unknown') : undefined,
      storeAuditEnvelope,
    });
    evidenceEnvelopeId = (evRes && evRes.envelopeId) || null;
  }

  const heldForApproval = approvalFromResult(toolResult);
  if (heldForApproval) {
    // Held for a human: nothing executed, so no tool.finished (it would have to lie).
    emit({ type: 'approval.requested', call_id: callId, tool: toolName, input: parsedInput, risk: toolResult._approval?.risk || toolResult.risk || toolResult.capabilityRisk || null, ...heldForApproval });
  } else {
    emit({
      type: 'tool.finished', call_id: callId, tool: toolName, input: parsedInput,
      status: classifyToolStatus(toolResult), result: toolResult,
      duration_ms: Date.now() - toolStart, envelope_id: evidenceEnvelopeId,
    });
  }
  return toolResult;
}

/**
 * D3: the per-turn tool offer gate, checked BEFORE dispatchGovernedToolCall.
 * -> null when the call should go through the governed door as usual, else the tool
 * result to hand back to the model (executeTool is never reached):
 *  - more_tools: a catalogue read that widens the offer for the next model round;
 *  - a tool that was not offered on this turn: refused, nothing runs.
 * No toolOffer (every legacy caller): always null, behaviour unchanged.
 */
function handleOfferGate({ toolOffer, callId, toolName, input, emitEvent }) {
  if (!toolOffer) return null;
  const emit = typeof emitEvent === 'function' ? emitEvent : () => {};
  const { MORE_TOOLS_NAME } = require('./turnToolSelection.js');
  if (toolName === MORE_TOOLS_NAME) {
    const t0 = Date.now();
    emit({ type: 'tool.started', call_id: callId, tool: toolName, input: input || {} });
    const result = toolOffer.moreTools(input || {});
    emit({ type: 'tool.finished', call_id: callId, tool: toolName, input: input || {}, status: classifyToolStatus(result), result, duration_ms: Date.now() - t0, envelope_id: null });
    return result;
  }
  if (toolOffer.isOffered(toolName)) return null;
  const result = {
    success: false,
    error: `Tool '${toolName}' was not offered on this turn, so it was not run. Call more_tools with what you need to do.`,
  };
  emit({ type: 'tool.started', call_id: callId, tool: toolName, input: input || {} });
  emit({ type: 'tool.finished', call_id: callId, tool: toolName, input: input || {}, status: classifyToolStatus(result), result, duration_ms: 0, envelope_id: null });
  return result;
}

module.exports = { frameMidAnswerSteer, frameBoundarySteer, createRoundAbort, createLoopControl, buildGovernedToolCtx, dispatchGovernedToolCall, handleOfferGate };
