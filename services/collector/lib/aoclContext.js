/**
 * AOCL Context Bundle — per-request context carried through the pipeline.
 *
 * GOV-E-1: Every chat request builds one of these at the top of handleCollectorChat
 * and carries it through all AOCL layers. Each layer accumulates results on
 * aoclCtx.layerResults. Final state is emitted as aocl.run.complete / aocl.run.reject.
 *
 * The compliance trace viewer at server.js ~line 7600 queries for `aocl.run.start`
 * envelopes to build conversation traces. Without these emissions, chat is invisible
 * to compliance.
 *
 * See: docs/STREAM_GOV_E_PLAN.md
 */

const { randomUUID } = require('crypto');

/**
 * Build an AOCL context bundle for a chat request.
 *
 * @param {object} params
 * @param {string} params.jwtOrgId - Org ID from JWT (or '' for anonymous)
 * @param {string} params.jwtUserId - User ID from JWT (or '' for anonymous)
 * @param {boolean} params.serviceAuth - True if caller authenticated via service key
 * @param {string} params.sessionId - Session / conversation ID (used as corr)
 * @param {string} params.selectedAgent - Agent ID (e.g. 'quox', 'sentinel')
 * @param {string} params.prompt - Raw user prompt
 * @param {string} [params.provider] - Requested LLM provider (filled later by routing)
 * @param {string} [params.model] - Requested LLM model (filled later by routing)
 * @param {boolean} [params.approvalGranted] - QLUSTER-LOOP-B: a prior L3 HITL
 *   approval has been GRANTED for this exact request (resumed delegation). When
 *   true, the L3 gate's requiresApproval branch is satisfied and falls through
 *   to the passed path. SECURITY: the caller (server.js) must only ever set this
 *   from an INTERNAL-SERVICE-authed request — never from a JWT/browser request.
 * @param {string} [params.approvalInboxItemId] - the inbox item that carried the
 *   human approval, for the approval_satisfied audit envelope.
 * @returns {object} aoclCtx
 */
function buildAoclContext({
  jwtOrgId,
  jwtUserId,
  serviceAuth = false,
  sessionId,
  selectedAgent,
  prompt,
  provider = null,
  model = null,
  approvalGranted = false,
  approvalInboxItemId = null,
}) {
  const now = new Date().toISOString();
  // AEE-CORE-1 hard fix: NEVER mint a parallel corr here. The caller must
  // provide a sessionId; if they somehow don't, we log loudly and use a
  // format that's easy to grep for so the offending call-site shows up in
  // audit queries. Previously this silently minted CHAT_<ts>_<hex> which
  // diverged from every other emit in the same request, producing two
  // disjoint corrs per chat — the exact bug AEE-CORE-1 was supposed to kill.
  let corr;
  if (sessionId) {
    corr = sessionId;
  } else {
    corr = `AOCL_ORPHAN_${Date.now()}_${randomUUID().slice(0, 8)}`;
    console.error('[AOCL] buildAoclContext called without sessionId — emitting orphan corr', corr);
  }

  // AOCL-FULL-1: C0-C6 partitions per AOCL spec §3. Each phase populates its
  // assigned partition (L0 sets C0, L1 sets C1, L3 sets C4, L5 sets C3,
  // L6 sets C5, L8/L10 set C6). Legacy flat fields kept as aliases so the
  // 40+ existing call sites don't break.
  const resolvedOrgId = jwtOrgId || '__default__';
  const resolvedUserId = jwtUserId || '';

  return {
    // ─── C0 Event ──────────────────────────────────────────────
    C0: {
      source: 'chat',          // chat | sse | widget | webhook.telegram | webhook.slack | webhook.discord | cli
      channel: null,           // for webhook sources — e.g. telegram bot id
      corr,
      startedAt: now,
      hasAttachments: false,
      rawInputHash: null,
    },
    // ─── C1 Identity & Scope ───────────────────────────────────
    C1: {
      orgId: resolvedOrgId,
      userId: resolvedUserId,
      serviceAuth,
      roles: [],
      permissions: [],
      redactionRules: [],
    },
    // ─── C2 Task ────────────────────────────────────────────────
    C2: {
      agentId: selectedAgent,
      rawUserPrompt: prompt || '',
      finalPrompt: null,       // filled by L6 shape.rewrite after context injection
      objectiveId: null,       // filled by L4 plan.decompose if complex
      priority: 'normal',
      constraints: [],
    },
    // ─── C3 Memory / Knowledge (L5 fills) ──────────────────────
    C3: {
      memoryItems: [],
      ragChunks: [],
      workingSetTokens: 0,
      sources: [],
    },
    // ─── C4 Policy (L3 fills) ──────────────────────────────────
    C4: {
      matchedPolicies: [],
      allowedTools: [],
      modelRestrictions: [],
      hitlRequired: false,
    },
    // ─── C5 Execution (L6/L7 fill) ─────────────────────────────
    C5: {
      provider,
      model,
      budgetTokens: null,
      timeoutMs: null,
      concurrency: 1,
      toolRegistry: [],
    },
    // ─── C6 Audit (L10 fills) ──────────────────────────────────
    C6: {
      logLevel: 'info',
      requiredEvidence: [],
      checkpoints: [],
      totalEnvelopesEmitted: 0,
    },

    // ─── Legacy flat fields — kept as aliases for back-compat ──
    // These MUST stay as long as existing code reads them directly.
    // Remove only after every consumer migrates to aoclCtx.C{0-6}.
    orgId: resolvedOrgId,
    userId: resolvedUserId,
    serviceAuth,
    corr,
    agentId: selectedAgent,
    query: prompt,
    queryLength: prompt ? prompt.length : 0,
    provider,
    model,
    layerResults: {},
    warnings: [],
    piiDetected: false,
    piiTypes: [],
    startTime: Date.now(),
    startedAt: now,
    deniedAtLayer: null,
    firstDenialReason: null,
    status: 'running', // 'running' | 'completed' | 'denied' | 'error'

    // ─── QLUSTER-LOOP-B — resumed-delegation approval grant ────────────────
    // Default false. Only the internal-service resume path sets these (via a
    // request that is service-authed AND carries x-qluster-approval-granted).
    // A true value satisfies the L3 requiresApproval gate; it does NOT bypass a
    // hard policy-deny (L3 denied) or an identity failure (L1).
    approvalGranted: approvalGranted === true,
    approvalInboxItemId: approvalInboxItemId || null,
  };
}

/**
 * Record a layer result on the context bundle.
 *
 * @param {object} aoclCtx
 * @param {string} layer - 'L0', 'L1', 'L3', 'L8', 'L10'
 * @param {object} result - { proceed, reason?, warnings, meta }
 */
function recordLayerResult(aoclCtx, layer, result) {
  aoclCtx.layerResults[layer] = {
    ...result,
    duration_ms: result.duration_ms || (Date.now() - aoclCtx.startTime),
  };
  if (result.warnings && result.warnings.length) {
    aoclCtx.warnings.push(...result.warnings);
  }
  if (result.piiTypes && result.piiTypes.length) {
    aoclCtx.piiDetected = true;
    aoclCtx.piiTypes.push(...result.piiTypes);
  }
}

/**
 * Mark the context as denied at a specific layer.
 */
function markDenied(aoclCtx, layer, reason) {
  aoclCtx.deniedAtLayer = layer;
  aoclCtx.firstDenialReason = reason;
  aoclCtx.status = 'denied';
}

/**
 * Build the aocl.run.start envelope payload.
 */
function buildRunStartPayload(aoclCtx) {
  // AEE-CORE fix: include a truncated query preview so the Activity Centre
  // can show a meaningful conversation title ("what did I ask?") without
  // storing the full unbounded prompt body.
  const q = aoclCtx.query || '';
  return {
    corr: aoclCtx.corr,
    orgId: aoclCtx.orgId,
    userId: aoclCtx.userId,
    serviceAuth: aoclCtx.serviceAuth,
    agentId: aoclCtx.agentId,
    queryLength: aoclCtx.queryLength,
    // 240 chars is enough for a recognisable preview; longer prompts are
    // still fully stored on the quox.chat.query envelope itself.
    queryPreview: q.length > 240 ? q.slice(0, 237) + '…' : q,
    text: q.length > 240 ? q.slice(0, 237) + '…' : q, // alias — getEnvelopeSummary looks for payload.text
    provider: aoclCtx.provider,
    model: aoclCtx.model,
    startedAt: aoclCtx.startedAt,
  };
}

/**
 * Build the aocl.run.complete envelope payload.
 */
function buildRunCompletePayload(aoclCtx, { responseLength = 0, toolsUsed = [] } = {}) {
  return {
    corr: aoclCtx.corr,
    orgId: aoclCtx.orgId,
    userId: aoclCtx.userId,
    agentId: aoclCtx.agentId,
    provider: aoclCtx.provider,
    model: aoclCtx.model,
    status: aoclCtx.status,
    layerResults: aoclCtx.layerResults,
    warnings: aoclCtx.warnings,
    piiDetected: aoclCtx.piiDetected,
    piiTypes: aoclCtx.piiTypes,
    deniedAtLayer: aoclCtx.deniedAtLayer,
    firstDenialReason: aoclCtx.firstDenialReason,
    responseLength,
    toolsUsed,
    totalDurationMs: Date.now() - aoclCtx.startTime,
    completedAt: new Date().toISOString(),
  };
}

/**
 * QLUSTER-LOOP-B — resolve whether a chat request carries a GRANTED L3 HITL
 * approval (a resumed delegation). THE security guard: the grant is honored
 * ONLY when the request is INTERNAL-SERVICE-authed. A JWT/user/browser request
 * that sets x-qluster-approval-granted is IGNORED — we gate on serviceAuth, not
 * header presence, so the signal cannot be forged from the browser. Keep this a
 * pure function so the forge-rejection is unit-testable against the real code.
 *
 * @param {object} params
 * @param {boolean} params.serviceAuth - true iff the request passed the
 *   INTERNAL_SERVICE_KEY check (the trust boundary).
 * @param {object} params.headers - request headers.
 * @returns {{ approvalGranted: boolean, approvalInboxItemId: string|null }}
 */
function resolveApprovalGrant({ serviceAuth = false, headers = {} } = {}) {
  const h = headers || {};
  if (serviceAuth !== true) {
    // Non-service (JWT/user/browser) request: the header is meaningless here.
    return { approvalGranted: false, approvalInboxItemId: null };
  }
  return {
    approvalGranted: h['x-qluster-approval-granted'] === '1',
    approvalInboxItemId: h['x-qluster-approval-inbox-item'] || null,
  };
}

module.exports = {
  buildAoclContext,
  recordLayerResult,
  markDenied,
  buildRunStartPayload,
  buildRunCompletePayload,
  resolveApprovalGrant,
};
