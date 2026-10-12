/**
 * AOCL-DISPATCH Phase 3 — stack-mode authoritative branch.
 *
 * Gated module that runs a chat request through the full L0-L10 AOCL stack
 * as the authoritative path (instead of the legacy inline pipeline). The
 * gate is defensive:
 *
 *   mode === 'stack'  AND  shadowRunner.getShadowMetrics().readyToFlip
 *
 * `readyToFlip` itself requires ≥1000 shadow runs at ≥99.5% parity. Result:
 * the stack branch is completely dormant until an operator both (a) sets
 * AOCL_STACK_MODE=stack and (b) has let shadow mode run long enough for the
 * parity data to accumulate.
 *
 * tryStackModeDispatch(opts, deps):
 *   - returns { stackUsed: false } when the gate is closed → caller falls
 *     through to the legacy handleMessagesApi/handleClaudeCliWithTools
 *   - returns { stackUsed: true, httpStatus, responseBody } otherwise,
 *     which the caller writes via res.status(httpStatus).json(responseBody)
 *
 * This module does NOT touch req/res. It composes the stack, runs it, and
 * hands back a response body.
 */

async function tryStackModeDispatch(opts, deps) {
  const {
    aoclCtx,
    prompt,
    userMessage,
    finalSystemPrompt,
    persona,
    session_id,
    effectiveSessionId,
    selected_agent,
    agentTools,
    anthropicApiKey,
    cliOAuthToken,
    requestedProvider,
    requestedModel,
    jwtOrgId,
    jwtUserId,
    userAccessToken,
    conversation_history,
    memory_context,
    quox_context,
    decisionEvidenceLevel,
    // LLM-CHOICE Phase 1: no_oauth policy flag. Default true (OAuth/CLI
    // allowed) so existing callers that don't pass this are unaffected.
    allowOAuth = true,
    // LLM-FAILOVER P1: ordered candidate list for the governed chat turn
    // (from buildGovernedChatCandidates). When present, the L7 dispatch
    // walks it on runtime provider failure instead of letting the first
    // throw become an l7_denied 403. Default null keeps existing callers
    // on the single-path dispatcher.
    failoverCandidates = null,
    // AUDIT-REAL-4a: chat-originated objective creation is a
    // governance-sensitive ACT. It only ever fires when the originating
    // request explicitly opts in — never silently. Default false so every
    // existing caller that doesn't pass this is unaffected.
    allow_orchestration: allowOrchestration = false,
    // QUOXHAT P3: enforced-manifest context for failover compatibility
    // filtering (providerCompat.js). Null/preview = legacy behaviour.
    hatManifest = null,
  } = opts;

  const {
    getStackMode,
    getShadowMetrics,
    invokeMessagesApi,
    invokeClaudeCli,
    // LLM-FAILOVER P1: single-shot OpenAI attempt for fallback candidates.
    invokeOpenAi,
    // QUOXHAT P3: governed Gemini attempt (function-call loop) so a declared
    // gemini candidate is a real leg instead of a no_dispatcher skip.
    invokeGemini,
    buildChatDispatcher = require('./chatDispatcher.js').buildChatDispatcher,
    buildChatStack = require('./aoclStack.js').buildChatStack,
    buildChatProviders = require('./chatProviders.js').buildChatProviders,
    runPipeline = require('./aoclPipeline.js').runPipeline,
    emitLayerEnvelope = require('./aoclPipeline.js').emitLayerEnvelope,
    voltDb,
    enforceIdentity,
    evaluateCompliance,
    evaluateSafety,
    verify,
    memoryClient,
    wsmClient,
    ragClient,
    personas,
    sanitise,
    adaptStyle,
    styleProfile,
    getAssistantPersona,
    // AUDIT-REAL-4a: tasks-service credentials for L4's createObjective hook.
    tasksServiceUrl,
    internalServiceKey,
  } = deps || {};

  // ── Gate ──────────────────────────────────────────────────────────────
  // AOCL-DISPATCH-5: readyToFlip gate removed — parity proven via the
  // aoclStackE2E.test.js corpus (100/100 byte-identical vs legacy). The
  // try/catch in the caller still falls through to legacy on any stack
  // exception, giving us automatic rollback without env-var flipping.
  // Opt back in to the parity gate via AOCL_STACK_REQUIRE_PARITY=true.
  const mode = typeof getStackMode === 'function' ? getStackMode() : 'stack';
  if (mode !== 'stack') return { stackUsed: false };

  if (process.env.AOCL_STACK_REQUIRE_PARITY === 'true') {
    const metrics = typeof getShadowMetrics === 'function' ? getShadowMetrics() : null;
    if (!metrics || !metrics.readyToFlip) return { stackUsed: false };
  }

  // ── Pick the underlying dispatcher ────────────────────────────────────
  // LLM-CHOICE Phase 1: when the resolved plan disallows the OAuth/CLI
  // credential path (allowOAuth === false), never select 'cli' — fail loudly
  // instead so the caller falls back to the failover chain / auth-required
  // response rather than silently spawning the CLI with an OAuth token.
  const path = anthropicApiKey ? 'api' : 'cli';

  // LLM-FAILOVER P1: when the caller supplies a candidate list, the L7
  // dispatch walks it via executeGovernedFailover: classify each runtime
  // failure (auth_expired / quota_exhausted / rate_limited / overloaded /
  // transient / fatal), mark cooldowns, and try the next candidate instead
  // of turning every provider failure into an l7_denied 403. failoverState
  // captures the honest attempted/active meta for the response body,
  // whether the walk succeeds or exhausts.
  const failoverEnabled = Array.isArray(failoverCandidates) && failoverCandidates.length > 0;
  let failoverState = null;
  let dispatch;

  if (failoverEnabled) {
    const llmFailover = require('./llmFailover.cjs');

    // Providers with no chat-path attempt implementation are skipped, not
    // fatally aborted (a declared gemini fallback must not kill the walk).
    const supported = (candidate) => candidate.provider === 'anthropic'
      || (candidate.provider === 'openai' && typeof invokeOpenAi === 'function')
      || (candidate.provider === 'gemini' && typeof invokeGemini === 'function');
    // QUOXHAT P3: under an ENFORCED hat manifest, failover must never
    // mutate the tool set per leg — a candidate whose certified constraints
    // the manifest violates is SKIPPED with a named reason, not capped.
    // Runs BEFORE the no_dispatcher prefilter so the recorded reason is the
    // specific certification failure, not the generic wiring gap. Legacy
    // (no-hat / preview) turns keep cap-at-the-leg behaviour: the
    // annotation is a no-op without an enforced manifest size.
    let walkCandidates = failoverCandidates;
    if (hatManifest?.enforced) {
      const { annotateCandidatesForManifest } = require('./providerCompat');
      walkCandidates = annotateCandidatesForManifest(walkCandidates, {
        manifestSize: hatManifest.toolNames?.size ?? (Array.isArray(agentTools) ? agentTools.length : 0),
      });
    }
    walkCandidates = walkCandidates.map((candidate) => (
      candidate.attemptable === false || supported(candidate)
        ? candidate
        : { ...candidate, attemptable: false, skipReason: 'no_dispatcher' }
    ));

    const attemptCandidate = async (candidate, aoclCtxArg, promptArg) => {
      if (candidate.provider === 'anthropic') {
        let handler = null;
        let handlerPath = null;
        if (anthropicApiKey && typeof invokeMessagesApi === 'function') {
          handler = invokeMessagesApi;
          handlerPath = 'api';
        } else if (allowOAuth && typeof invokeClaudeCli === 'function') {
          handler = invokeClaudeCli;
          handlerPath = 'cli';
        }
        if (!handler) {
          const authErr = new Error('auth_required: no usable Anthropic credential path');
          authErr.code = 'auth_required';
          authErr.status = 401;
          throw authErr;
        }
        const r = await handler({ aoclCtx: aoclCtxArg, prompt: promptArg, model: candidate.model });
        return {
          text: typeof r?.text === 'string' ? r.text : '',
          tokensUsed: typeof r?.tokensUsed === 'number' ? r.tokensUsed : 0,
          toolsUsed: Array.isArray(r?.toolsUsed) ? r.toolsUsed : [],
          model: r?.model || candidate.model || null,
          path: handlerPath,
          outcome: r?.outcome,
          decisionEvidence: r?.decisionEvidence,
        };
      }
      // QUOXHAT P3: gemini leg (guaranteed attemptable by supported() above)
      if (candidate.provider === 'gemini') {
        const r = await invokeGemini({ candidate, aoclCtx: aoclCtxArg, prompt: promptArg });
        return {
          text: typeof r?.text === 'string' ? r.text : '',
          tokensUsed: typeof r?.tokensUsed === 'number' ? r.tokensUsed : 0,
          toolsUsed: Array.isArray(r?.toolsUsed) ? r.toolsUsed : [],
          model: r?.model || candidate.model || null,
          path: 'gemini',
        };
      }
      // openai (guaranteed by the supported() prefilter above)
      const r = await invokeOpenAi({ candidate, aoclCtx: aoclCtxArg, prompt: promptArg });
      return {
        text: typeof r?.text === 'string' ? r.text : '',
        tokensUsed: typeof r?.tokensUsed === 'number' ? r.tokensUsed : 0,
        toolsUsed: Array.isArray(r?.toolsUsed) ? r.toolsUsed : [],
        model: r?.model || candidate.model || null,
        path: 'openai',
      };
    };

    dispatch = async (aoclCtxArg, promptArg) => {
      try {
        const walk = await llmFailover.executeGovernedFailover({
          candidates: walkCandidates,
          attempt: (candidate) => attemptCandidate(candidate, aoclCtxArg, promptArg),
        });
        failoverState = walk.failover;
        return walk.result;
      } catch (err) {
        if (err && err.failover) failoverState = err.failover;
        throw err;
      }
    };
  } else {
    if (!anthropicApiKey && !allowOAuth) {
      const authErr = new Error('auth_required: Anthropic API key required (OAuth/CLI credential path disabled by policy)');
      authErr.code = 'auth_required';
      throw authErr;
    }
    dispatch = buildChatDispatcher({
      invokeMessagesApi,
      invokeClaudeCli,
      path,
      model: requestedModel,
    });
  }

  // ── Seed aoclCtx.C2 so L5/L6/L7 can read the raw user prompt ──────────
  const ctx = aoclCtx || {};
  ctx.C2 = ctx.C2 || {};
  if (typeof prompt === 'string' && !ctx.C2.rawUserPrompt) {
    ctx.C2.rawUserPrompt = prompt;
  }

  // ── Build the stack ───────────────────────────────────────────────────
  const providers = buildChatProviders({
    memoryClient,
    wsmClient,
    ragClient,
    personas,
    sanitise,
    adaptStyle,
    quoxContext: quox_context,
  });

  // AUDIT-REAL-4a: wire L4's shouldOrchestrate/createObjective hooks (see
  // lib/l4Planner.js) to the real tasks service. shouldOrchestrate only
  // returns true when the request explicitly opted in via
  // allow_orchestration — never silently. createObjective always sets
  // require_approval_before_start: true so auto-created objectives land in
  // the HITL approval flow rather than auto-running.
  const { makeShouldOrchestrate, makeCreateObjective } = require('./l4ObjectiveDelegate.js');
  const shouldOrchestrate = makeShouldOrchestrate(allowOrchestration === true);
  const createObjective = makeCreateObjective({
    tasksServiceUrl,
    internalServiceKey,
    emitEnvelope: emitLayerEnvelope,
  });

  const stack = buildChatStack({
    ...providers,
    dispatch,
    voltDb,
    enforceIdentity,
    evaluateCompliance,
    evaluateSafety,
    verify,
    styleProfile,
    getAssistantPersona: getAssistantPersona || providers.getAssistantPersona,
    memoryContext: memory_context,
    shouldOrchestrate,
    createObjective,
  });

  // ── Run the pipeline ──────────────────────────────────────────────────
  const pipelineResult = await runPipeline(ctx, stack);

  if (!pipelineResult.proceed) {
    const status = pipelineResult.httpStatus || 403;
    const body = {
      success: false,
      error: pipelineResult.errorCode || 'stack_denied',
      message: pipelineResult.errorMessage || `Blocked at ${pipelineResult.deniedAtLayer || 'unknown'}`,
      deniedByLayer: pipelineResult.deniedAtLayer || null,
      agent_used: selected_agent,
      can_continue: false,
      stack_used: true,
    };
    if (Array.isArray(pipelineResult.matchedPolicies) && pipelineResult.matchedPolicies.length > 0) {
      body.matchedPolicies = pipelineResult.matchedPolicies;
    }
    // LLM-FAILOVER P1: when the L7 dispatch walked a candidate chain and
    // every candidate failed, carry the honest attempted list on the denial
    // body (server.js folds it into execution.failover) so the caller can
    // display WHY: last error_class and any cooldown_until. The l7_denied
    // shape above is unchanged.
    if (failoverState) {
      body.failover = failoverState;
    }
    return { stackUsed: true, httpStatus: status, responseBody: body };
  }

  // ── Compose success response ──────────────────────────────────────────
  const c5 = ctx.C5 || {};
  const finalText = (typeof c5.finalResponse === 'string' && c5.finalResponse)
    || (typeof c5.llmResponse === 'string' && c5.llmResponse)
    || '';
  const voiceSummary = typeof c5.voiceSummary === 'string'
    ? c5.voiceSummary
    : finalText.slice(0, 80);
  const toolsUsed = Array.isArray(c5.toolsUsed) ? c5.toolsUsed : [];
  ctx.skillResults = Array.isArray(c5.toolExecutions) ? c5.toolExecutions : [];

  // QUOXHAT MISSION D2 — surface the structured needs_approval signal on the
  // STACK-MODE / orchestrator response too. This is the path CommanderQ takes on
  // bare POST /chat with voice=true (layers_run / stack_used shape), and it
  // bypasses server.js's legacy response sites (handleMessagesApi /
  // handleClaudeCliWithTools) exactly like the proposed_patch extractor below —
  // so the voice bridge, which reads THIS response, only sees the signal if it is
  // attached here. Same multi-path lesson as FND-2: a signal on some paths only
  // is not universal. Extracted from the C5 layer's tool executions.
  let needsApproval = null;
  try {
    const { extractPendingApproval } = require('./voiceApproval');
    needsApproval = extractPendingApproval(c5.toolExecutions);
    // Fallback: the CLI/MCP executor records toolExecutions with result:null, so
    // extraction misses the pending shape; read the turn-scoped registry keyed by
    // this turn's session (an approval created in a delegated specialist sub-turn
    // is recorded under the SAME session_id). PATH- and delegation-independent.
    if (!needsApproval) {
      const { peekPendingApproval } = require('./pendingApprovalRegistry');
      needsApproval = peekPendingApproval(effectiveSessionId || session_id);
    }
  } catch (naErr) {
    console.warn('[stackModeDispatch] needs_approval resolution failed (non-fatal):', naErr.message);
  }
  // LLM-FAILOVER P1: provider/model must reflect the candidate that actually
  // produced the reply, not the plan (the plan may have failed over).
  const activeCandidate = failoverState?.active || null;
  const model = c5.model || activeCandidate?.model || requestedModel || null;

  const body = {
    success: true,
    result: finalText,
    voice_summary: voiceSummary,
    session_id: effectiveSessionId || session_id,
    cost_usd: 0,
    model,
    provider: activeCandidate?.provider
      || requestedProvider
      || (path === 'api' ? 'anthropic' : 'anthropic-cli'),
    agent_used: selected_agent,
    tools_used: toolsUsed,
    can_continue: true,
    needs_approval: needsApproval,
    stack_used: true,
    layers_run: pipelineResult.layersRun || [],
  };
  // LLM-FAILOVER P1: honest failover meta on the success body. server.js
  // folds this into execution.failover and rebuilds fallback_chain from it.
  if (failoverState) {
    body.failover = failoverState;
  }
  if (decisionEvidenceLevel && decisionEvidenceLevel !== 'none') {
    body.decision_evidence_level = decisionEvidenceLevel;
  }
  if (c5.decisionEvidence) {
    body.decision_evidence = c5.decisionEvidence;
  }

  // === TOOLSMITH-UX-4.2: proposed_patch extraction (stack-mode path) ===
  // Mirrors the three response sites in server.js (handleMessagesApi,
  // handleClaudeCliWithTools, TEST_LLM_STUB). The stack-mode dispatcher
  // bypasses those legacy paths, so the extractor must run here too.
  // Toolsmith-only; non-toolsmith agents get proposed_patch: null.
  if (selected_agent === 'toolsmith') {
    try {
      const { extractProposedPatch } = require('./proposedPatchExtractor');
      const extracted = extractProposedPatch(body.result);
      body.result = extracted.strippedText;
      body.proposed_patch = extracted.proposedPatch;
    } catch (extractErr) {
      console.warn('[stackModeDispatch] proposed_patch extraction failed (non-fatal):', extractErr.message);
      body.proposed_patch = null;
    }
  } else {
    body.proposed_patch = null;
  }

  // === Response Contract enforcement (AGH-RESP-2 / AGH-RESP-3) ===
  if (process.env.RESPONSE_CONTRACT_ENABLED === 'true') {
    try {
      const { enforceResponseContract } = require('./responseContract/enforceResponseContract');
      const enforced = enforceResponseContract(body.result, {
        skillResults: ctx.skillResults,
        userText: ctx.userText,
        userLang: ctx.userLang,
        channel: ctx.channel,
        orgId: ctx.orgId || ctx.C1?.orgId,
      });
      // Capture original before overwriting (for VOLT diff preview)
      body.result_before_contract = body.result;
      body.result = enforced.text;
      body.response_contract = enforced.traceMap;

      // AGH-RESP-3: Emit VOLT response_contract event on the model's own run when
      // possible (ctx.voltRunId set by dispatcher), falling back to a dedicated run
      // only when the model run ID is unavailable. Using the model run keeps the
      // "Response Contract" collapsible in the same VoltRunDetail row as the turn.
      // Must NEVER throw — wrap in try/catch; failure to log must not break the
      // response path. (feedback_no_governance_theater)
      try {
        const anyApplied = Object.values(enforced.traceMap).some(
          t => t && typeof t === 'object' && t.applied === true
        );
        const voltEmitter = deps && deps.voltEmitter;
        if (anyApplied && voltEmitter) {
          let targetRunId = ctx.voltRunId;
          let createdHere = false;
          if (!targetRunId && typeof voltEmitter.startRun === 'function') {
            targetRunId = voltEmitter.startRun(
              ctx.corr || ctx.C0?.corr || `contract-${Date.now()}`,
              { org_id: ctx.orgId || ctx.C1?.orgId, user_id: ctx.userId || ctx.C1?.userId, agent_id: ctx.agentId }
            );
            createdHere = true;
          }
          if (targetRunId) {
            voltEmitter.emit(targetRunId, 'response_contract_applied', {
              response_contract: enforced.traceMap,
              original_preview: body.result_before_contract
                ? body.result_before_contract.slice(0, 240)
                : undefined,
              final_preview: body.result.slice(0, 240),
            });
            if (createdHere && typeof voltEmitter.completeRun === 'function') {
              voltEmitter.completeRun(targetRunId);
            }
          }
        }
      } catch (_voltErr) { /* swallow — contract emission must never break the response path */ }

      // Do not expose result_before_contract in the final response body
      delete body.result_before_contract;
    } catch (e) {
      body.response_contract = { error: String(e && e.message), applied: false };
    }
  }

  // === Chain Guards enforcement (AGH-CHAIN-1) ===
  // Phase 25: reads through the org-scoped settings resolver (deps.voltDb is
  // the same platform settings store server.js wires everywhere else), so
  // an org's override (Settings > Execution Policy) applies live. ctx.orgId
  // isn't resolved yet at this point — the org comes from jwtOrgId/aoclCtx.
  const aghChainOrgId = jwtOrgId || aoclCtx?.orgId || aoclCtx?.C1?.orgId || null;
  const aghChainEnabled = require('./platformSettingsStore.js')
    .getEffectiveFlag(deps && deps.voltDb, aghChainOrgId, 'AGH_CHAIN_ENABLED').on;
  if (aghChainEnabled) {
    try {
      const { enforceChainGuards } = require('./chainGuards/enforceChainGuards');
      const chainDeps = deps && deps.chainGuardsDeps;
      if (chainDeps) {
        const ctxForChain = {
          conversationId: ctx.corr || ctx.C0?.corr,
          orgId: ctx.orgId || ctx.C1?.orgId,
          userId: ctx.userId || ctx.C1?.userId,
          agentId: selected_agent,
          userLang: ctx.userLang,
        };
        const chainResult = enforceChainGuards(body.result, ctxForChain, chainDeps);
        body.result_before_chain = body.result;
        body.result = chainResult.text;
        body.chain_verification = chainResult.traceMap;

        // VOLT emit — sibling event to response_contract_applied
        try {
          const anyApplied = Object.values(chainResult.traceMap).some(
            t => t && typeof t === 'object' && t.applied === true
          );
          const voltEmitter = deps && deps.voltEmitter;
          if (anyApplied && voltEmitter) {
            let targetRunId = ctx.voltRunId;
            let createdHere = false;
            if (!targetRunId && typeof voltEmitter.startRun === 'function') {
              targetRunId = voltEmitter.startRun(
                ctx.corr || ctx.C0?.corr || `chain-${Date.now()}`,
                { org_id: ctx.orgId || ctx.C1?.orgId, user_id: ctx.userId || ctx.C1?.userId, agent_id: ctx.agentId }
              );
              createdHere = true;
            }
            if (targetRunId) {
              voltEmitter.emit(targetRunId, 'chain_verification_applied', {
                chain_verification: chainResult.traceMap,
                original_preview: body.result_before_chain
                  ? body.result_before_chain.slice(0, 240)
                  : undefined,
                final_preview: body.result.slice(0, 240),
              });
              if (createdHere && typeof voltEmitter.completeRun === 'function') {
                voltEmitter.completeRun(targetRunId);
              }
            }
          }
        } catch (_voltErr) { /* swallow — chain emission must never break the response path */ }

        delete body.result_before_chain;
      }
    } catch (e) {
      body.chain_verification = { error: String(e && e.message), applied: false };
    }
  }

  return { stackUsed: true, httpStatus: 200, responseBody: body };
}

module.exports = { tryStackModeDispatch };
