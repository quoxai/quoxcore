/**
 * AOCL-DISPATCH Phase 1 — Anthropic Messages API dispatcher.
 *
 * Pure extraction of server.js handleMessagesApi (570 lines). No req/res;
 * returns a structured outcome so the caller (legacy wrapper + the future
 * AOCL L7 delegate) can write the appropriate response.
 *
 * Contract:
 *   dispatchClaudeMessages(opts, deps) → {
 *     outcome: 'success' | 'auth_failed' | 'tool_limit',
 *     text, tokensUsed, toolsUsed, toolRounds, model,
 *     path: 'api', voiceSummary, images, richContent, decisionEvidence,
 *     authHint?, stopReason?, responseLength?,
 *   }
 *
 * Behavioural invariants preserved from the legacy handler:
 *   - Max 5 tool rounds (round 0..5 inclusive = 6 iterations; matches legacy).
 *   - OAuth tokens (sk-ant-oat01-) → Bearer auth; others → x-api-key.
 *   - activity.message / activity.tool_call / activity.tool_result stream.
 *   - VOLT run start/emit/complete/fail around the model + tool calls.
 *   - chat.success / chat.api_error envelopes via storeAuditEnvelope.
 *   - Decision evidence extraction + tag stripping.
 *   - Image tool interception via imageStore.saveImage (base64 stripped).
 *   - Rich content for orchestrate_objective / save_as_workflow / browser_*.
 *   - 120s fetch timeout, 5s fleet-inventory timeout.
 *   - Non-2xx non-{401,403} statuses throw (legacy wrapper converts to 500).
 */

const { emitToolEvidence } = require('./toolEvidence.js');
const { captureOverride, wantsCaptureOverride } = require('./claudeCliDispatcher.js');
const { applyLenses } = require('./lensComposer.js');
const { emitDelegationEvent, DELEGATION_KIND } = require('./delegationEvents.js');

// QUOXLENS P0: no lens has ever been part of this path's prompt (verified —
// "Execution Integrity" text only ever lived in directProviderPrompt.js), so
// the default here is [], a true no-op through applyLenses.
const DEFAULT_LENSES = [];

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const FLEET_URL = 'http://localhost:9848/api/v1/agents';
const MAX_TOOL_ROUNDS = 5;
const API_TIMEOUT_MS = 120000;
const FLEET_TIMEOUT_MS = 5000;

const { toAnthropicTool } = require('./anthropicTools.js');

const { ANTHROPIC_WEB_SEARCH_TOOL, appendSearchSources } = require('./nativeWebSearch.js');

async function dispatchClaudeMessages(opts, deps) {
  const {
    anthropicApiKey,
    finalSystemPrompt,
    persona,
    userMessage,
    prompt,
    session_id,
    effectiveSessionId,
    selected_agent,
    agentTools,
    requestedProvider,
    requestedModel,
    userAccessToken,
    jwtOrgId,
    jwtUserId,
    conversation_history,
    memory_context,
    quox_context,
    decisionEvidenceLevel,
    userId,
    orgId,
    delegationDepth,
    voiceMode,
    aoclCtx,
    hatManifest, // QUOXHAT P2: arms the executeTool membership gate when enforced
    nativeWebSearch, // research turns: Anthropic server-side web search tool
  } = opts;

  const {
    fetchFn = (typeof fetch === 'function' ? fetch : null),
    executeTool,
    voltEmitter,
    voltDb,
    voltStatements,
    persistVoltContent,
    storeAuditEnvelope,
    emitAgentSession,
    emitAgentEvent,
    imageStore,
    getCollectorMirrorCompact,
    memorySystemPrompt,
    actionSystemPrompt,
    buildDecisionEvidenceInstructions,
    extractVoiceSummary,
    extractDecisionEvidence,
    generateEnvelopeId,
    bastionHost,
    abortTimeoutMs = API_TIMEOUT_MS,
    fleetTimeoutMs = FLEET_TIMEOUT_MS,
  } = deps || {};

  if (typeof fetchFn !== 'function') {
    throw new Error('dispatchClaudeMessages: no fetch implementation available');
  }

  const hasTools = Array.isArray(agentTools) && agentTools.length > 0;
  const rawPrompt = typeof prompt === 'string' ? prompt : '';

  // Enhance system prompt with tool instructions
  let sysPrompt = finalSystemPrompt + `\n\n## Voice Personality\n${persona}`;

  // MR-2 + MR-7: Inject Mirror cognitive index into system prompt
  // Priority: frontend Mirror (richer) > collector Mirror (fallback)
  if (quox_context && typeof quox_context === 'string' && quox_context.includes('## QuoxMind Mirror')) {
    const mirrorStart = quox_context.indexOf('## QuoxMind Mirror');
    const mirrorEnd = quox_context.indexOf('\n\n', mirrorStart + 20);
    const mirrorSection = mirrorEnd > mirrorStart
      ? quox_context.substring(mirrorStart, mirrorEnd)
      : quox_context.substring(mirrorStart);
    sysPrompt += `\n\n${mirrorSection}`;
  } else {
    const collectorMirror = typeof getCollectorMirrorCompact === 'function'
      ? getCollectorMirrorCompact()
      : '';
    if (collectorMirror) {
      sysPrompt += `\n\n## System Status\n${collectorMirror}`;
    }
  }

  if (hasTools) {
    sysPrompt += `\n\n## Rules
- You are ${selected_agent.toUpperCase()}, an AI infrastructure agent for QuoxCORE.
- You have real infrastructure tools available. Use them to answer questions.
- When asked about hosts, fleet, containers, security, disk, memory, CPU — call the relevant tool.
- Present findings with clear markdown tables and actionable analysis.
- Never say "I can't access" or "I don't have tools" — call the tool.
- Never ask the user to run SSH commands — use ssh_exec to run them yourself.
- Never claim you are in a "sandbox" or that infrastructure is "not accessible" — you ARE connected.
- After getting tool results, analyse them and provide recommendations.
- If a tool call fails or times out, that IS diagnostic data — explain what the failure means.
- Your tool calls run one after another, never at the same time: never say they run in parallel or simultaneously.
- DO the work. Do NOT write assessment reports or escalation plans. Execute commands and show results.
- All hosts are accessible via ssh_exec through the SSH bastion${bastionHost ? ` (${bastionHost})` : ''}.`;
    // Add delegation instructions for QUOX
    if (selected_agent === 'quox' && agentTools.some((t) => t.name === 'delegate_to_agent')) {
      sysPrompt += `\n\n## Agent Delegation
You can delegate sub-tasks to specialist agents using delegate_to_agent. Use this when:
- The query spans multiple domains (e.g., "check security then deploy a fix")
- A specialist would give better results (WARDEN for security, DAEDALUS for Docker, HYPERION for Proxmox)
- You need to combine results from multiple agents

Delegation guidelines:
- Give the specialist a clear, specific task — not the user's full query
- You can delegate multiple times in sequence
- After receiving delegation results, synthesize them into a coherent answer for the user
- If delegation fails, fall back to your own tools`;
    }
    if (memorySystemPrompt) sysPrompt += memorySystemPrompt;
    // Same note-capture rule as the CLI paths, after the memory guidance (failover leg, 2026-10-08).
    if (wantsCaptureOverride(false, agentTools)) sysPrompt += captureOverride(false);
    if (actionSystemPrompt) sysPrompt += actionSystemPrompt;
  }

  // Add host inventory so the agent knows what's available
  try {
    const fleetResp = await fetchFn(FLEET_URL, { signal: AbortSignal.timeout(fleetTimeoutMs) });
    if (fleetResp && fleetResp.ok) {
      const fleetData = await fleetResp.json();
      const hostIds = (fleetData.agents || []).map((a) => a.host_id);
      if (hostIds.length > 0) {
        sysPrompt += `\n\n## Managed Infrastructure\n${hostIds.length} hosts: ${hostIds.join(', ')}\nAll accessible via ssh_exec through the bastion${bastionHost ? ` (${bastionHost})` : ''}.`;
      }
    }
  } catch (_) { /* fleet unavailable, skip host list */ }

  // Decision Evidence injection
  if (decisionEvidenceLevel && decisionEvidenceLevel !== 'none' && typeof buildDecisionEvidenceInstructions === 'function') {
    sysPrompt += buildDecisionEvidenceInstructions(decisionEvidenceLevel);
  }

  sysPrompt += `\n\n## Response Format
Provide a clear, well-formatted response using markdown. Start with a brief summary, then details.
Agent: ${selected_agent}`;

  // QUOXLENS P0 seam. DEFAULT_LENSES is [] here, so this is a no-op today —
  // see the comment on DEFAULT_LENSES above for why.
  sysPrompt = applyLenses(sysPrompt, DEFAULT_LENSES);

  console.log(`[Claude] Messages API (${selected_agent}, ${hasTools ? agentTools.length : 0} tools, ${(conversation_history || []).length} history turns) (api-key)`);

  // Emit session start to Agent Stream
  // AEE-CORE-1.2: use the dispatcher-resolved session id so every envelope in
  // this request shares one corr (chat.success + aocl.* + agent stream).
  const chatSessionId = effectiveSessionId || session_id
    || `SESSION_${typeof generateEnvelopeId === 'function' ? generateEnvelopeId() : Date.now().toString(36)}`;
  const chatStartTime = Date.now();
  if (typeof emitAgentSession === 'function') {
    emitAgentSession({
      id: chatSessionId,
      org_id: jwtOrgId,
      host_id: 'collector',
      agent_type: 'chat_assistant',
      agent_name: selected_agent,
      provider: requestedProvider || 'anthropic',
      model: requestedModel || 'claude-sonnet-4-6',
      status: 'running',
      user: jwtUserId || 'anonymous',
      project: 'quox-dashboard',
    });
  }

  // Emit user message event — summary MUST be the raw user prompt, not the
  // context-injected `userMessage` (which prepends memory/quox_context blocks).
  if (typeof emitAgentEvent === 'function') {
    emitAgentEvent({
      session_id: chatSessionId,
      org_id: jwtOrgId,
      agent_name: selected_agent,
      type: 'activity.message',
      data: { role: 'user', length: rawPrompt.length, agent: selected_agent },
      summary: `User: ${rawPrompt.length > 80 ? rawPrompt.substring(0, 80) + '...' : rawPrompt}`,
    });
  }

  // Build messages with conversation history for multi-turn context
  const messages = [];
  if (Array.isArray(conversation_history) && conversation_history.length > 0) {
    for (const turn of conversation_history) {
      if (turn.role && turn.content) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
  }
  messages.push({ role: 'user', content: userMessage });

  const toolsUsed = [];
  const toolExecutions = [];
  const collectedImages = [];
  let richContent = null; // Stream R: structured data for inline chat cards
  let totalTokensUsed = 0;

  // CRP-BE-3: Start VOLT run for this chat interaction
  const voltRunId = voltEmitter && typeof voltEmitter.startRun === 'function'
    ? voltEmitter.startRun(session_id || `CHAT_${Date.now()}`, {
        org_id: jwtOrgId || undefined,
        user_id: jwtUserId || undefined,
        agent_id: selected_agent,
      })
    : null;
  if (aoclCtx && voltRunId) aoclCtx.voltRunId = voltRunId;

  const voltEmit = (runId, eventType, payload) => {
    if (voltEmitter && typeof voltEmitter.emit === 'function' && runId) {
      return voltEmitter.emit(runId, eventType, payload);
    }
    return null;
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const apiBody = {
      model: requestedModel || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: sysPrompt,
      messages,
      ...(round < MAX_TOOL_ROUNDS && (hasTools || nativeWebSearch)
        ? {
            tools: [
              ...(hasTools ? agentTools.map(toAnthropicTool) : []),
              ...(nativeWebSearch ? [{ ...ANTHROPIC_WEB_SEARCH_TOOL }] : []),
            ],
          }
        : {}),
    };

    // Emit thinking event
    if (typeof emitAgentEvent === 'function') {
      emitAgentEvent({
        session_id: chatSessionId,
        org_id: jwtOrgId,
        agent_name: selected_agent,
        type: 'activity.thinking',
        data: { round, model: requestedModel || 'claude-sonnet-4-6', tools_available: hasTools ? agentTools.length : 0 },
        summary: round === 0 ? `${selected_agent} processing...` : `${selected_agent} tool round ${round + 1}...`,
      });
    }

    // OAuth tokens (sk-ant-oat01-) use Bearer auth; regular API keys use x-api-key
    const isOAuthToken = typeof anthropicApiKey === 'string' && anthropicApiKey.startsWith('sk-ant-oat01-');
    const authHeaders = isOAuthToken
      ? { Authorization: `Bearer ${anthropicApiKey}` }
      : { 'x-api-key': anthropicApiKey };

    // CRP-BE-3: VOLT — model request
    const modelReqEvent = voltEmit(voltRunId, 'model.requested', {
      actor: { actor_type: 'system', actor_id: 'collector' },
      model: apiBody.model,
      round,
      tools_available: hasTools ? agentTools.length : 0,
    });
    // EVD-3: persist prompt + user message (hash-only by default)
    if (modelReqEvent?.event_id && typeof persistVoltContent === 'function') {
      const userMessageText = Array.isArray(apiBody.messages) && apiBody.messages.length > 0
        ? (typeof apiBody.messages[apiBody.messages.length - 1].content === 'string'
            ? apiBody.messages[apiBody.messages.length - 1].content
            : JSON.stringify(apiBody.messages[apiBody.messages.length - 1].content))
        : '';
      persistVoltContent(voltRunId, modelReqEvent.event_id, 'model.requested', {
        system_prompt: apiBody.system || sysPrompt || '',
        user_message: userMessageText,
        model: apiBody.model,
        round,
        message_count: Array.isArray(apiBody.messages) ? apiBody.messages.length : 0,
        provider: 'anthropic',
      });
    }

    const apiResp = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(apiBody),
      signal: AbortSignal.timeout(abortTimeoutMs),
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error(`[Claude] API error ${apiResp.status}:`, errText);
      if (typeof storeAuditEnvelope === 'function') {
        storeAuditEnvelope({
          type: 'error',
          from: `agent.${selected_agent}`,
          to: 'audit.system',
          intent: 'quox.chat.api_error',
          corr: effectiveSessionId || session_id || `ERR_${Date.now()}`,
          payload: { error: `API ${apiResp.status}`, status_code: apiResp.status, agent: selected_agent },
        });
      }
      if (apiResp.status === 401 || apiResp.status === 403) {
        if (voltEmitter && typeof voltEmitter.failRun === 'function' && voltRunId) {
          voltEmitter.failRun(voltRunId, new Error(`API ${apiResp.status}`));
        }
        const authHint = 'API key authentication failed. Check your Anthropic API Key in Settings → Core Integrations.';
        return {
          outcome: 'auth_failed',
          path: 'api',
          text: authHint,
          voiceSummary: 'Authentication failed.',
          authHint,
          tokensUsed: totalTokensUsed,
          toolsUsed,
          toolExecutions,
          toolRounds: round,
          model: requestedModel || 'claude-sonnet-4-6',
          images: collectedImages,
          richContent,
          decisionEvidence: null,
        };
      }
      if (voltEmitter && typeof voltEmitter.failRun === 'function' && voltRunId) {
        voltEmitter.failRun(voltRunId, new Error(`API ${apiResp.status}`));
      }
      throw new Error(`Anthropic API returned ${apiResp.status}: ${errText.substring(0, 200)}`);
    }

    const apiResult = await apiResp.json();
    // Only client tool_use blocks reach our executor. server_tool_use and
    // web_search_tool_result blocks are Anthropic-executed and never dispatched.
    const toolUseBlocks = (apiResult.content || []).filter((b) => b.type === 'tool_use');
    const serverSearchCount = (apiResult.content || []).filter((b) => b.type === 'server_tool_use' && b.name === 'web_search').length;
    if (serverSearchCount > 0 && !toolsUsed.includes('web_search')) toolsUsed.push('web_search');

    // pause_turn: the server tool loop hit its iteration cap; resend to continue.
    if (apiResult.stop_reason === 'pause_turn' && toolUseBlocks.length === 0 && round < MAX_TOOL_ROUNDS) {
      messages.push({ role: 'assistant', content: apiResult.content });
      continue;
    }
    if (apiResult.usage) {
      totalTokensUsed += (apiResult.usage.input_tokens || 0) + (apiResult.usage.output_tokens || 0);
    }

    // CRP-BE-3: VOLT — model responded
    voltEmit(voltRunId, 'model.responded', {
      actor: { actor_type: 'agent', actor_id: selected_agent },
      model: apiResult.model || apiBody.model,
      stop_reason: apiResult.stop_reason,
      input_tokens: apiResult.usage?.input_tokens,
      output_tokens: apiResult.usage?.output_tokens,
      tool_use_count: toolUseBlocks.length,
      round,
    });

    if (toolUseBlocks.length === 0 || apiResult.stop_reason !== 'tool_use') {
      const textBlocks = (apiResult.content || []).filter((b) => b.type === 'text');
      let content = textBlocks.map((b) => b.text).join('\n\n');
      if (nativeWebSearch) content = appendSearchSources(content, apiResult.content);
      const voiceSummary = typeof extractVoiceSummary === 'function' ? extractVoiceSummary(content) : '';
      const toolSuffix = toolsUsed.length > 0 ? `\n\n---\n*Tools used: ${toolsUsed.join(', ')}*` : '';

      // Extract decision evidence from response (if present)
      const decisionEvidence = typeof extractDecisionEvidence === 'function'
        ? extractDecisionEvidence(content)
        : null;
      if (decisionEvidence) {
        console.log(`[Claude] Decision evidence captured (level: ${decisionEvidenceLevel})`);
      }

      console.log(`[Claude] Success — ${round} tool rounds, ${toolsUsed.length} tools, API path`);

      // Emit response event
      if (typeof emitAgentEvent === 'function') {
        emitAgentEvent({
          session_id: chatSessionId,
          org_id: jwtOrgId,
          agent_name: selected_agent,
          type: 'activity.message',
          data: { role: 'assistant', length: content.length, agent: selected_agent, tools_used: toolsUsed.length },
          summary: `${selected_agent}: ${content.length > 80 ? content.substring(0, 80) + '...' : content}`,
        });
        emitAgentEvent({
          session_id: chatSessionId,
          org_id: jwtOrgId,
          agent_name: selected_agent,
          type: 'session.end',
          data: { status: 'finished', tool_rounds: round, tools_used: toolsUsed, duration_ms: Date.now() - chatStartTime },
          summary: `Completed (${toolsUsed.length} tools, ${Math.round((Date.now() - chatStartTime) / 1000)}s)`,
        });
      }

      // AEE-CORE-3.1: LLM response metadata — model/tokens/duration/cost
      const envelopePayload = {
        agent: selected_agent,
        path: 'messages_api',
        tool_rounds: round,
        tools_used: toolsUsed,
        response_length: content.length,
        // CRITICAL: use raw `prompt`, NOT `userMessage` (context-injected)
        query_preview: rawPrompt.length > 240 ? rawPrompt.slice(0, 237) + '…' : rawPrompt,
        response_preview: content.length > 240 ? content.slice(0, 237) + '…' : content,
        text: content.length > 240 ? content.slice(0, 237) + '…' : content,
        model: apiResult.model || apiBody.model,
        provider: requestedProvider || 'anthropic',
        input_tokens: apiResult.usage?.input_tokens,
        output_tokens: apiResult.usage?.output_tokens,
        cache_read_input_tokens: apiResult.usage?.cache_read_input_tokens,
        cache_creation_input_tokens: apiResult.usage?.cache_creation_input_tokens,
        duration_ms: Date.now() - chatStartTime,
        stop_reason: apiResult.stop_reason,
        org_id: jwtOrgId || undefined,
        user_id: jwtUserId || undefined,
      };
      if (decisionEvidence) {
        envelopePayload.decision_evidence = decisionEvidence;
      }

      // AUDIT-REAL-4b: the success envelope can DECLARE requires.decision_evidence
      // without anything actually being present — a declared-but-unenforced
      // requirement. This block makes that gap VISIBLE (not fatal). It does NOT
      // block/fail the chat response — that's a policy decision for later; this
      // item only ensures the gap is recorded for certification/audit tooling.
      const decisionEvidenceRequested = !!(decisionEvidenceLevel && decisionEvidenceLevel !== 'none');
      const decisionEvidenceMissing = decisionEvidenceRequested && !decisionEvidence;
      const evidenceCorr = effectiveSessionId || session_id || `CHAT_${Date.now()}`;
      if (decisionEvidenceMissing) {
        envelopePayload.decision_evidence_missing = true;
      }

      if (typeof storeAuditEnvelope === 'function') {
        storeAuditEnvelope({
          type: 'event',
          from: `agent.${selected_agent}`,
          to: 'audit.system',
          intent: 'quox.chat.success',
          org_id: jwtOrgId || undefined,
          corr: evidenceCorr,
          requires: decisionEvidenceRequested
            ? { decision_evidence: decisionEvidenceLevel }
            : undefined,
          payload: envelopePayload,
        });

        if (decisionEvidenceMissing) {
          storeAuditEnvelope({
            type: 'event',
            from: `agent.${selected_agent}`,
            to: 'audit.system',
            intent: 'quox.evidence.missing',
            corr: evidenceCorr,
            payload: {
              agent: selected_agent,
              level_required: decisionEvidenceLevel,
              corr: evidenceCorr,
            },
          });
        }
      }

      if (decisionEvidenceMissing && voltEmitter && typeof voltEmitter.isAvailable === 'function' && voltEmitter.isAvailable() && voltRunId) {
        voltEmit(voltRunId, 'agent.decision.missing', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          level_required: decisionEvidenceLevel,
        });
      }

      // Record decision evidence to VOLT run (CRP-BE-3: use voltEmitter when available)
      if (decisionEvidence) {
        if (voltEmitter && typeof voltEmitter.isAvailable === 'function' && voltEmitter.isAvailable() && voltRunId) {
          voltEmit(voltRunId, 'agent.decision.recorded', {
            actor: { actor_type: 'agent', actor_id: selected_agent },
            evidence_level: decisionEvidenceLevel,
            decision: decisionEvidence.decision,
            confidence: decisionEvidence.confidence,
          });
        } else if (voltDb && voltStatements) {
          // Legacy fallback: standalone unchained event (only when voltEmitter unavailable)
          try {
            const voltEventId = `EVT_DE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
            const voltTs = new Date().toISOString();
            const voltData = JSON.stringify(require('./voltEmitter.js').boundRecord({
              volt_version: '0.1',
              event_id: voltEventId,
              event_type: 'agent.decision.recorded',
              ts: voltTs,
              actor: { actor_type: 'agent', actor_id: selected_agent },
              context: { correlation_id: session_id || `CHAT_${Date.now()}` },
              payload: decisionEvidence,
            }));
            voltStatements.insertEvent.run(voltEventId, session_id || `CHAT_${Date.now()}`, 'agent.decision.recorded', voltTs, 0, voltData);
          } catch (voltErr) {
            console.warn('[VOLT] Failed to record decision evidence:', voltErr.message);
          }
        }
      }

      // Strip <decision_evidence> tags from visible response
      const cleanContent = decisionEvidence
        ? content.replace(/<decision_evidence>[\s\S]*?<\/decision_evidence>/g, '').trim()
        : content;

      // CRP-BE-3: VOLT — run completed
      if (voltEmitter && typeof voltEmitter.completeRun === 'function' && voltRunId) {
        voltEmitter.completeRun(voltRunId);
      }

      // QM-LTM Phase 1: dark-flagged (QM_LTM_ENABLED), fire-and-forget capture
      // of this conversation for semantic recall. Covers both the legacy
      // handleMessagesApi path and the AOCL stack-mode invokeMessagesApi path,
      // since both call dispatchClaudeMessages. Never awaited; a require or
      // capture failure can never break the chat response.
      try {
        const { isLtmEnabled, captureConversation } = require('./conversationRecall.js');
        if (isLtmEnabled()) {
          captureConversation({
            orgId: orgId || jwtOrgId || '',
            userId: userId || jwtUserId || '',
            agentId: selected_agent,
            conversationId: effectiveSessionId || session_id || '',
            prompt: typeof prompt === 'string' ? prompt : '',
            responseText: cleanContent,
            historyTurns: Array.isArray(conversation_history) ? conversation_history : [],
          }).catch(() => {});
        }
      } catch { /* non-fatal, QM-LTM must never affect the chat path */ }

      // BRAIN2-V2-1: retrieval → answer. If this turn called quoxbrain_search,
      // measure which retrieved notes the final answer actually cited and emit
      // quox.brain.cited + the citation POST. The key MUST be the same value
      // this path puts on the tool ctx: toolCtx.session_id below is
      // `session_id || undefined`, so this is the identical expression — a
      // turn with no session_id registers nothing and finalizes nothing, which
      // stays consistent rather than silently mismatching. Not awaited; a
      // citation measurement must never add latency to the answer.
      try {
        const { finalizeAnswer } = require('./brainCitationTrace.js');
        Promise.resolve(finalizeAnswer(effectiveSessionId || session_id, cleanContent)).catch(() => {});
      } catch { /* non-fatal — evidence must never affect the chat path */ }

      return {
        outcome: 'success',
        path: 'api',
        text: cleanContent + toolSuffix,
        voiceSummary,
        tokensUsed: totalTokensUsed,
        toolsUsed,
        toolExecutions,
        toolRounds: round,
        model: apiResult.model || apiBody.model || requestedModel || 'claude-sonnet-4-6',
        stopReason: apiResult.stop_reason,
        responseLength: content.length,
        images: collectedImages,
        richContent,
        decisionEvidence: decisionEvidence || null,
        inputTokens: apiResult.usage?.input_tokens,
        outputTokens: apiResult.usage?.output_tokens,
        cacheReadInputTokens: apiResult.usage?.cache_read_input_tokens,
        cacheCreationInputTokens: apiResult.usage?.cache_creation_input_tokens,
      };
    }

    // Tool execution
    console.log(`[Claude] Tool round ${round + 1}: ${toolUseBlocks.map((b) => b.name).join(', ')}`);
    messages.push({ role: 'assistant', content: apiResult.content });

    const toolResults = [];
    const toolCtx = {
      agentId: selected_agent,
      userId: userId || jwtUserId || undefined,
      orgId: orgId || jwtOrgId || undefined,
      token: userAccessToken || undefined,
      _delegationDepth: delegationDepth || 0,
      memory_context: memory_context || undefined,
      quox_context: quox_context || undefined,
      conversation_history: conversation_history || undefined,
      session_id: effectiveSessionId || session_id || undefined,
      // QUOXHAT P4: the conversation key hat bindings use (the chat handler
      // resolves hats on effectiveSessionId; session_id may be empty on the
      // stack path). hat_load_bundle must write the SAME key.
      conversationId: effectiveSessionId || session_id || undefined,
      voice_mode: voiceMode || 'hal',
      hatManifest: hatManifest || undefined, // QUOXHAT P2 membership gate context
    };
    for (const toolBlock of toolUseBlocks) {
      toolsUsed.push(toolBlock.name);
      const toolExec = { name: toolBlock.name, args: toolBlock.input ?? {}, success: true, result: null };
      if (typeof emitAgentEvent === 'function') {
        emitAgentEvent({
          session_id: chatSessionId,
          org_id: jwtOrgId,
          agent_name: selected_agent,
          type: 'activity.tool_call',
          data: { tool: toolBlock.name, input_keys: Object.keys(toolBlock.input || {}) },
          summary: `Tool: ${toolBlock.name}`,
        });
      }
      // GW-P1: visible delegation. When the orchestrator hands a sub-task to a
      // specialist, fire the canonical delegation.accepted event from this REAL
      // runtime moment (before the specialist runs) so "delegating to X" is a
      // fact on the wire, not a sentence the model chose to write.
      if (toolBlock.name === 'delegate_to_agent') {
        emitDelegationEvent(
          { emitAgentEvent, storeAuditEnvelope },
          DELEGATION_KIND.ACCEPTED,
          {
            parent: selected_agent,
            target: toolBlock.input?.agent_id,
            task: toolBlock.input?.task,
            depth: (delegationDepth || 0) + 1,
            corr: chatSessionId || voltRunId,
            sessionId: chatSessionId,
            orgId: jwtOrgId,
          },
        );
      }

      const toolCallStart = Date.now();
      // QUOXTRUST D6: this dispatcher emits its own per-tool evidence (below); opt
      // the executeTool choke out to avoid a double-emit.
      if (toolCtx) toolCtx._callerEmitsToolEvidence = true;
      const toolResult = typeof executeTool === 'function'
        ? await executeTool(toolBlock.name, toolBlock.input, toolCtx)
        : { success: false, error: 'executeTool dep missing' };
      toolExec.success = toolResult.success !== false && !toolResult.error;
      toolExec.result = toolResult;
      toolExecutions.push(toolExec);

      // GW-P1: visible delegation — the specialist returned. Fire the canonical
      // delegation.completed event carrying authorship (target), outcome and the
      // specialist's own tools_used, so the result is attributed, not absorbed
      // silently into the orchestrator's reply.
      if (toolBlock.name === 'delegate_to_agent') {
        emitDelegationEvent(
          { emitAgentEvent, storeAuditEnvelope },
          DELEGATION_KIND.COMPLETED,
          {
            parent: selected_agent,
            target: toolBlock.input?.agent_id || toolResult.agent,
            task: toolBlock.input?.task,
            depth: (delegationDepth || 0) + 1,
            corr: chatSessionId || voltRunId,
            sessionId: chatSessionId,
            orgId: jwtOrgId,
            success: toolResult.success !== false && !toolResult.error,
            tools_used: toolResult.tools_used || [],
            error: (toolResult.success === false || toolResult.error) ? (toolResult.error || 'delegation failed') : undefined,
          },
        );
      }

      // CRP-BE-3: VOLT — tool executed
      const toolCallEvent = voltEmit(voltRunId, 'tool.call.executed', {
        actor: { actor_type: 'agent', actor_id: selected_agent },
        tool: toolBlock.name,
        success: toolResult.success !== false,
        duration_ms: Date.now() - toolCallStart,
        error: toolResult.success === false ? (toolResult.error || 'unknown') : undefined,
      });
      if (toolCallEvent?.event_id && typeof persistVoltContent === 'function') {
        persistVoltContent(voltRunId, toolCallEvent.event_id, 'tool.call.executed', {
          tool_name: toolBlock.name,
          agent_id: selected_agent,
          tool_input: toolBlock.input,
          tool_output: toolResult,
        });
      }

      // P2 evidence parity: per-tool AEE/AOCL envelope + NOC outcome, matching
      // the /api/v1/tools/execute gold path so NOC/SOC agent actions are evidenced.
      emitToolEvidence({
        toolName: toolBlock.name,
        input: toolBlock.input, // QUOXTRUST T1/D1: bind the effective action into the receipt
        ctx: { agentId: toolCtx?.agentId || selected_agent, orgId: toolCtx?.orgId, userId: toolCtx?.userId },
        corrId: chatSessionId || voltRunId,
        durationMs: Date.now() - toolCallStart,
        success: toolResult.success !== false && !toolResult.error,
        error: (toolResult.success === false || toolResult.error) ? (toolResult.error || 'unknown') : undefined,
        storeAuditEnvelope,
      });

      // CRP-BE-3: VOLT — HITL approval events
      if (toolResult._approval) {
        const approvalStatus = toolResult._approval.status;
        if (approvalStatus === 'pending') {
          voltEmit(voltRunId, 'hitl.requested', {
            actor: { actor_type: 'agent', actor_id: selected_agent },
            tool: toolBlock.name, approval_id: toolResult._approval.id || toolResult.approvalId,
          });
        } else if (approvalStatus === 'approved') {
          voltEmit(voltRunId, 'hitl.approved', {
            actor: { actor_type: 'human', actor_id: toolResult._approval.approvedBy || 'unknown' },
            tool: toolBlock.name, approval_id: toolResult._approval.id,
          });
        } else if (approvalStatus === 'denied') {
          voltEmit(voltRunId, 'hitl.denied', {
            actor: { actor_type: 'human', actor_id: 'unknown' },
            tool: toolBlock.name, approval_id: toolResult._approval.id,
          });
        }
      }

      // Emit tool result event
      if (typeof emitAgentEvent === 'function') {
        emitAgentEvent({
          session_id: chatSessionId,
          org_id: jwtOrgId,
          agent_name: selected_agent,
          type: 'activity.tool_result',
          data: { tool: toolBlock.name, success: toolResult.success !== false, has_images: !!(toolResult.images?.length) },
          summary: `${toolBlock.name} ${toolResult.success !== false ? '✓' : '✗'} ${toolResult.error ? toolResult.error.substring(0, 60) : ''}`.trim(),
        });
      }

      // Stream R: Capture rich content from objective/workflow tools
      if (toolBlock.name === 'orchestrate_objective' && toolResult.success) {
        richContent = {
          type: toolResult.status === 'running' ? 'objective_progress'
            : toolResult.status === 'completed' ? 'objective_complete'
            : 'objective_created',
          objectiveId: toolResult.objective_id,
          title: toolResult.title,
          status: toolResult.status,
          taskCount: toolResult.task_count || 0,
          teamId: toolResult.team_id,
          links: toolResult.links || {},
          tasks: toolResult.tasks || [],
        };
      } else if (toolBlock.name === 'save_as_workflow' && toolResult.success) {
        richContent = {
          type: 'workflow_saved',
          templateId: toolResult.template_id,
          title: toolResult.name,
          scheduled: toolResult.scheduled,
          cronHuman: toolResult.cron_human,
          links: toolResult.links || {},
        };
      } else if (toolBlock.name.startsWith('browser_') && toolResult.success !== false) {
        if (toolBlock.name === 'browser_screenshot' && toolResult.screenshot_id) {
          const screenshotOrgId = toolBlock.input?.org_id || jwtOrgId || '';
          richContent = {
            type: 'browser_automation',
            intent: `Screenshot: ${toolResult.url || 'page'}`,
            url: toolResult.url || '',
            status: 'completed',
            steps_total: 1, steps_completed: 1,
            screenshots: [toolResult.screenshot_id],
            org_id: screenshotOrgId,
          };
        } else if (toolBlock.name.startsWith('browser_extract') && toolResult.success !== false) {
          const extData = toolResult.tables || toolResult.links || toolResult.data || toolResult.metadata || toolResult.items || null;
          if (extData) {
            richContent = {
              type: 'browser_extraction',
              extraction_type: toolResult.format || toolBlock.name.replace('browser_extract_', '') || 'generic',
              url: toolResult.url || toolBlock.input?.url || '',
              data: extData,
              row_count: Array.isArray(extData) ? extData.length : (toolResult.count || 0),
              extraction_id: toolResult._extraction_id || null,
              org_id: toolBlock.input?.org_id || jwtOrgId || '',
            };
          }
        } else if (toolBlock.name === 'browser_objective_execute' && toolResult.objective_id) {
          richContent = {
            type: 'browser_automation',
            intent: toolResult.intent || 'Browser automation',
            url: toolResult.url || '',
            status: toolResult.status || 'running',
            objective_id: toolResult.objective_id,
            steps_total: toolResult.steps_total || 0,
            steps_completed: toolResult.steps_completed || 0,
            links: { detail: `/browser-q/run/${toolResult.objective_id}` },
          };
        }
      }

      // Intercept image results from Gemini tools — save to disk, strip base64
      if (toolResult.success && Array.isArray(toolResult.images) && toolResult.images.length > 0 && imageStore) {
        for (const img of toolResult.images) {
          try {
            const saved = imageStore.saveImage(img.base64, img.mime_type, {
              prompt: toolResult.prompt_used || toolBlock.input?.prompt || null,
              model: toolResult.model_used || null,
              agent: selected_agent,
              org_id: toolCtx.orgId || null,
              user_id: toolCtx.userId || null,
              aspect_ratio: toolBlock.input?.aspect_ratio || null,
            });
            collectedImages.push({
              id: saved.id,
              url: saved.url,
              mime_type: img.mime_type,
              prompt: saved.sidecar.prompt,
              model: saved.sidecar.model,
              agent: selected_agent,
              created_at: saved.sidecar.created_at,
            });
          } catch (err) {
            console.error(`[ImageStore] Failed to save image: ${err.message}`);
          }
        }
      }

      // Include error details so Claude can explain failures to the user
      let resultContent;
      if (toolResult.pending === true || toolResult._approval?.status === 'pending') {
        // Held for a human: not a failure (same shape as openaiInvokeDispatcher).
        resultContent = JSON.stringify({
          status: 'pending_approval',
          approval_id: toolResult._approval?.id || toolResult.approvalId || null,
          message: toolResult.message || toolResult.error || 'Waiting for a human to approve this action.',
          tool: toolBlock.name,
        });
      } else if (toolResult.success === false) {
        resultContent = JSON.stringify({
          error: true,
          error_type: toolResult.error?.includes('not authorized') ? 'auth_error' :
                      toolResult.error?.includes('timeout') || toolResult.error?.includes('aborted') ? 'timeout_error' :
                      toolResult.error?.includes('Unknown tool') ? 'config_error' : 'tool_error',
          message: toolResult.error || toolResult.message,
          tool: toolBlock.name,
        });
      } else if (collectedImages.length > 0 && Array.isArray(toolResult.images)) {
        resultContent = JSON.stringify({
          success: true,
          count: toolResult.images.length,
          model_used: toolResult.model_used || null,
          prompt_used: toolResult.prompt_used || null,
          note: 'Images generated successfully and displayed inline for the user.',
        });
      } else {
        resultContent = JSON.stringify(toolResult, null, 2).substring(0, 10000);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: resultContent,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Tool round budget exhausted
  if (voltEmitter && typeof voltEmitter.completeRun === 'function' && voltRunId) {
    voltEmitter.completeRun(voltRunId);
  }
  return {
    outcome: 'tool_limit',
    path: 'api',
    text: 'Tool execution limit reached. Please try a more specific query.',
    voiceSummary: 'I ran into a tool execution limit.',
    tokensUsed: totalTokensUsed,
    toolsUsed,
    toolExecutions,
    toolRounds: MAX_TOOL_ROUNDS + 1,
    model: requestedModel || 'claude-sonnet-4-6',
    images: collectedImages,
    richContent,
    decisionEvidence: null,
  };
}

module.exports = { dispatchClaudeMessages, MAX_TOOL_ROUNDS, toAnthropicTool };
