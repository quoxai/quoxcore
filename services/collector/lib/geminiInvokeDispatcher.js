'use strict';

/**
 * QUOXHAT P3 — governed Gemini function-call loop.
 *
 * Before this module, the collector's Gemini path sent NO function
 * declarations (QUOXHAT_STUDY.md §9: "Gemini primary … without function
 * declarations. Implement a full governed function-call loop before
 * claiming agent parity"). This is that loop, deliberately mirroring
 * executeOpenAICompatibleToolLoop's contract: same deps injection
 * (fetchFn, executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence),
 * same toolCtx (including the QUOXHAT hatManifest membership gate), same
 * MAX_TOOL_ROUNDS bound, same named-error posture.
 *
 * Provider specifics handled here:
 *  - tool definitions convert to Gemini functionDeclarations with a schema
 *    SANITIZER: Gemini's OpenAPI-subset rejects JSON Schema keywords our
 *    Anthropic-shaped input_schema may carry ($schema, additionalProperties,
 *    title, examples, const, allOf/anyOf/oneOf…). Unsupported keys are
 *    stripped recursively; structure (type/properties/required/items/enum/
 *    description/format/nullable) is preserved. Tool IDENTITY and argument
 *    semantics are never changed (study §10: adapters may change wire
 *    representation, never identity).
 *  - functionCall parts execute through executeTool; results return as
 *    functionResponse parts on a user turn, per the Gemini API contract.
 */

const { serializeToolResultForModel, MAX_TOOL_ROUNDS } = require('./openaiInvokeDispatcher');

// Keys Gemini's function-declaration schema subset accepts. Everything else
// is dropped (never mutated in place — callers keep their original schema).
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'enum', 'items', 'properties', 'required', 'nullable',
]);

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([name, sub]) => [name, sanitizeSchemaForGemini(sub)]),
      );
    } else if (k === 'items') {
      out.items = sanitizeSchemaForGemini(v);
    } else if (k === 'required' && Array.isArray(v)) {
      out.required = v.filter(x => typeof x === 'string');
    } else {
      out[k] = v;
    }
  }
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  // Live Gemini 400 (2026-10-01, declaration 82 'framework_mapping'):
  // "parameters.properties[...].items: missing field" — Gemini REQUIRES
  // items on every array. Our Anthropic-shaped schemas may omit it (any
  // item type accepted). A permissive string item is the least-wrong wire
  // representation for an unconstrained array; tool identity and the
  // argument KEY are unchanged.
  if (out.type === 'array' && !out.items) out.items = { type: 'string' };
  return out;
}

/** Convert Anthropic-shaped tool defs to Gemini functionDeclarations. */
function toGeminiFunctionDeclarations(agentTools) {
  return (Array.isArray(agentTools) ? agentTools : [])
    .filter(t => t && typeof t.name === 'string')
    .map(t => ({
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      parameters: sanitizeSchemaForGemini(t.input_schema),
    }));
}

/**
 * Run the governed Gemini tool loop. Contract mirrors
 * executeOpenAICompatibleToolLoop: resolves { content, toolsUsed, data }.
 * Throws on non-2xx with err.status/err.body; first-round tool-shaped 400s
 * get err.code = 'tool_calling_unsupported' so failover can classify them
 * as a compatibility defect rather than a fatal turn (study §10).
 */
async function executeGeminiToolLoop(req, opts, deps) {
  const {
    apiKey,
    apiBase = 'https://generativelanguage.googleapis.com/v1beta',
    model,
    systemPrompt,
    userMessage,
    selected_agent,
    session_id,
    agentTools = [],
    timeoutMs = 120000,
    userId,
    orgId,
    userAccessToken,
    memory_context,
    quox_context,
    conversation_history,
    voltRunId,
    hatManifest,
    effectiveSessionId, // QUOXHAT P4: hat-binding conversation key
    generationConfig = { maxOutputTokens: 4096 },
    buildContents, // (userMessage, conversation_history) => contents[]
  } = opts;

  const { fetchFn, executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence } = deps || {};
  if (typeof fetchFn !== 'function') {
    throw new Error('executeGeminiToolLoop: no fetch implementation available');
  }

  const contents = typeof buildContents === 'function'
    ? buildContents(userMessage, conversation_history)
    : [{ role: 'user', parts: [{ text: userMessage }] }];
  const declarations = toGeminiFunctionDeclarations(agentTools);
  const toolsUsed = [];
  const toolCtx = {
    agentId: selected_agent,
    userId: userId || undefined,
    orgId: orgId || undefined,
    token: userAccessToken || undefined,
    _delegationDepth: req?.body?._delegation_depth || 0,
    memory_context: memory_context || undefined,
    quox_context: quox_context || undefined,
    conversation_history: conversation_history || undefined,
    session_id: session_id || undefined,
    conversationId: effectiveSessionId || session_id || undefined, // QUOXHAT P4
    voice_mode: req?.body?.voice_mode || 'hal',
    hatManifest: hatManifest || undefined, // QUOXHAT P2 membership gate context
  };

  const url = `${apiBase}/models/${model}:generateContent?key=${apiKey}`;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (voltEmitter && typeof voltEmitter.emit === 'function') {
      voltEmitter.emit(voltRunId, 'model.requested', {
        actor: { actor_type: 'system', actor_id: 'collector' },
        model, round, provider: 'Gemini',
      });
    }

    const body = {
      system_instruction: { parts: [{ text: systemPrompt || '' }] },
      contents,
      generationConfig,
    };
    if (declarations.length > 0 && round < MAX_TOOL_ROUNDS) {
      body.tools = [{ functionDeclarations: declarations }];
    }

    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs);

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`Gemini API returned ${response.status}: ${errText.substring(0, 200)}`);
      err.status = response.status;
      err.body = errText;
      if (
        declarations.length > 0 &&
        round === 0 &&
        response.status === 400 &&
        /(function|tool|declaration|schema)/i.test(errText)
      ) {
        err.code = 'tool_calling_unsupported';
      }
      throw err;
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter(p => p?.functionCall?.name);
    const text = parts.filter(p => typeof p?.text === 'string').map(p => p.text).join('');

    if (voltEmitter && typeof voltEmitter.emit === 'function') {
      voltEmitter.emit(voltRunId, 'model.responded', {
        actor: { actor_type: 'agent', actor_id: selected_agent },
        model, round, provider: 'Gemini',
        tool_call_count: functionCalls.length,
        input_tokens: data.usageMetadata?.promptTokenCount,
        output_tokens: data.usageMetadata?.candidatesTokenCount,
      });
    }

    if (functionCalls.length === 0) {
      return { content: text, toolsUsed, data };
    }
    if (round === MAX_TOOL_ROUNDS) {
      // The model still wants tools on the final round: say so honestly
      // rather than returning whatever partial text rode along.
      return {
        content: text || 'Tool execution limit reached. Please try a more specific query.',
        toolsUsed,
        data,
      };
    }

    // The model's turn must be replayed VERBATIM — all parts, all sibling
    // fields. Live Gemini 400 (2026-10-01): "Function call is missing a
    // thought_signature in functionCall parts" — modern Gemini models stamp
    // a thoughtSignature on functionCall parts and REQUIRE it echoed back;
    // rebuilding parts as bare {functionCall} dropped it. Then every call
    // gets a functionResponse part on ONE user turn — preserving valid
    // call/result pairings (study §10).
    contents.push({ role: 'model', parts });
    const responseParts = [];

    for (const part of functionCalls) {
      const toolName = part.functionCall.name;
      const args = (part.functionCall.args && typeof part.functionCall.args === 'object')
        ? part.functionCall.args
        : {};
      toolsUsed.push(toolName);

      let toolResult;
      const toolStart = Date.now();
      try {
        if (toolCtx) toolCtx._callerEmitsToolEvidence = true;
        toolResult = typeof executeTool === 'function'
          ? await executeTool(toolName, args, toolCtx)
          : { success: false, error: 'executeTool dep missing' };
      } catch (err) {
        toolResult = { success: false, error: `Tool ${toolName} failed: ${err.message}` };
      }

      if (voltEmitter && typeof voltEmitter.emit === 'function') {
        voltEmitter.emit(voltRunId, 'tool.call.executed', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          tool: toolName, success: toolResult.success !== false,
          duration_ms: Date.now() - toolStart, provider: 'Gemini',
          error: toolResult.success === false ? (toolResult.error || 'unknown') : undefined,
        });
      }

      if (typeof emitToolEvidence === 'function') {
        emitToolEvidence({
          toolName,
          input: args,
          ctx: { agentId: toolCtx.agentId || selected_agent, orgId: toolCtx.orgId, userId: toolCtx.userId },
          corrId: toolCtx.session_id || voltRunId,
          durationMs: Date.now() - toolStart,
          success: toolResult.success !== false && !toolResult.error,
          error: (toolResult.success === false || toolResult.error) ? (toolResult.error || 'unknown') : undefined,
          storeAuditEnvelope,
        });
      }

      responseParts.push({
        functionResponse: {
          name: toolName,
          response: { result: serializeToolResultForModel(toolName, toolResult) },
        },
      });
    }

    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    content: 'Tool execution limit reached. Please try a more specific query.',
    toolsUsed,
    data: null,
  };
}

module.exports = {
  executeGeminiToolLoop,
  toGeminiFunctionDeclarations,
  sanitizeSchemaForGemini,
};
