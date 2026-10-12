'use strict';

const { detectPromise } = require('./promiseDetector');
const { detectFulfillmentClaim } = require('./fulfillmentDetector');
const { detectCrossAgentClaim } = require('./crossAgentClaimDetector');
const { detectCrossOrgClaim } = require('./crossOrgClaimDetector');

/**
 * skillToTools map — defensive multi-alias mapping of inferred_skill → known tool names
 */
const SKILL_TO_TOOL_NAMES = {
  email: ['gmail.send', 'gmail_send', 'mail.send', 'mail_send', 'outlook.send', 'email.send', 'sendmail'],
  task: ['task.create', 'create_task', 'todo.add', 'task_create', 'tasks.create'],
  calendar: ['calendar.create', 'calendar_create', 'schedule.book', 'meeting.create'],
  workflow: ['workflow.start', 'workflow_start', 'workflow.run', 'run_workflow', 'flow.start'],
  hitl: ['hitl.route', 'create_inbox_item', 'inbox.add', 'hitl_route', 'inbox.create'],
  crystal: ['skill_manage', 'skill.create', 'skill.save', 'crystal.save', 'crystal_save'],
};

const HONEST_FALLBACK = {
  en: "I want to correct something I said earlier: I cannot find evidence in the chain that I actually completed what I promised. ",
  es: "Quiero corregir algo que dije antes: no encuentro evidencia en la cadena de que haya completado lo que prometí. ",
};

/**
 * detectAndPersistPromise(text, ctx, deps)
 *
 * Calls detectPromise; if detected, persists via deps.promiseStore.
 * Requires ctx.conversationId (or ctx.corr / ctx.C0.corr) and ctx.orgId (or ctx.C1.orgId).
 *
 * Returns:
 *   { applied: false }
 *   { applied: false, reason: 'missing_context' }
 *   { applied: true, promise_id, language, inferred_action }
 */
function detectAndPersistPromise(text, ctx, deps) {
  const result = detectPromise(text, ctx);

  if (!result.detected) {
    return { applied: false };
  }

  // Resolve conversation ID from multiple possible ctx shapes
  const conversationId =
    (ctx && ctx.conversationId) ||
    (ctx && ctx.corr) ||
    (ctx && ctx.C0 && ctx.C0.corr) ||
    null;

  // Resolve org ID from multiple possible ctx shapes
  const orgId =
    (ctx && ctx.orgId) ||
    (ctx && ctx.C1 && ctx.C1.orgId) ||
    null;

  if (!conversationId || !orgId || !deps || !deps.promiseStore) {
    return { applied: false, reason: 'missing_context' };
  }

  const envelope = {
    conversation_id: conversationId,
    org_id: orgId,
    user_id: (ctx && ctx.userId) || null,
    agent_id: (ctx && ctx.agentId) || null,
    turn_id: (ctx && ctx.turnId) || null,
    promise_text: result.promise_text,
    inferred_action: result.inferred_action,
    language: result.language,
  };

  const promise_id = deps.promiseStore.persist(envelope);

  return {
    applied: true,
    promise_id,
    language: result.language,
    inferred_action: result.inferred_action,
  };
}

/**
 * verifyPromiseKept(text, ctx, deps)
 *
 * Detects past-reference fulfillment claims and verifies them against the chain.
 * If a claim is detected but no matching tool execution found, rewrites the text
 * with an honest fallback prefix.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {object} [deps]
 * @param {object} [deps.promiseStore]
 * @param {object} [deps.voltSkillReader]
 * @returns {{ text: string, trace: object }}
 */
function verifyPromiseKept(text, ctx, deps) {
  // Step 1: detect fulfillment claim
  const detection = detectFulfillmentClaim(text);
  if (!detection.detected) {
    return { text, trace: { applied: false } };
  }

  const claim_language = detection.language;
  const claim_kind = detection.claim_kind;

  // Step 2: resolve conversationId + orgId
  const conversationId =
    (ctx && ctx.conversationId) ||
    (ctx && ctx.corr) ||
    (ctx && ctx.C0 && ctx.C0.corr) ||
    null;

  const orgId =
    (ctx && ctx.orgId) ||
    (ctx && ctx.C1 && ctx.C1.orgId) ||
    null;

  if (!conversationId || !orgId || !deps || !deps.promiseStore) {
    return { text, trace: { applied: false, reason: 'missing_context' } };
  }

  // Step 3: get open promises for this conversation
  const openPromises = deps.promiseStore.getRecentForConversation(conversationId, {
    limit: 50,
    windowMs: 7 * 24 * 3600 * 1000,
    onlyOpen: true,
  });

  if (!openPromises || openPromises.length === 0) {
    return { text, trace: { applied: false, reason: 'no_open_promises' } };
  }

  // Step 4: check each open promise against volt tool executions
  if (!deps.voltSkillReader) {
    return { text, trace: { applied: false, reason: 'missing_context' } };
  }

  let verifiedPromiseId = null;
  let verifiedMatchedTool = null;

  for (const promise of openPromises) {
    const skill = promise.inferred_skill;
    const toolNames = skill ? SKILL_TO_TOOL_NAMES[skill] : null;

    if (!toolNames) {
      continue;
    }

    // Convert created_at (integer ms) to ISO string for the volt query
    const sinceIsoTs = new Date(promise.created_at).toISOString();

    const executions = deps.voltSkillReader.findToolExecutionsSince(
      conversationId,
      sinceIsoTs,
      { limit: 200 }
    );

    const matchingExec = executions.find(e => toolNames.includes(e.tool));
    if (matchingExec) {
      verifiedPromiseId = promise.promise_id;
      verifiedMatchedTool = matchingExec.tool;

      // Mark the promise as fulfilled
      deps.promiseStore.markFulfilled(
        promise.promise_id,
        matchingExec.event_id,
        Date.now()
      );
      break;
    }
  }

  // Step 5a: at least one promise has a matching execution — claim is honest
  if (verifiedPromiseId !== null) {
    return {
      text,
      trace: {
        applied: false,
        reason: 'verified',
        promise_id: verifiedPromiseId,
        matched_tool: verifiedMatchedTool,
      },
    };
  }

  // Step 5b: no matching execution found — rewrite with honest fallback
  const fallback = HONEST_FALLBACK[claim_language] || HONEST_FALLBACK.en;
  const rewrittenText = fallback + text;
  const unfulfilledPromise = openPromises[0]; // use first open promise for trace

  return {
    text: rewrittenText,
    trace: {
      applied: true,
      promise_id: unfulfilledPromise ? unfulfilledPromise.promise_id : null,
      claim_kind,
      reason: 'no_matching_execution',
    },
  };
}

/**
 * verifyCrossAgentClaim(text, ctx, deps)
 *
 * AGH-CHAIN-2: Detects claims about another agent's action and verifies them
 * against the AEE envelopes table. If a named known agent is claimed to have
 * acted but no envelope is found in the 2h corr window, rewrites the text
 * with an honest fallback prefix (bilingual EN/ES).
 *
 * @param {string} text
 * @param {object} ctx
 * @param {object} [deps]
 * @param {object} [deps.aeeChainWalker] — aeeChainWalker instance from createAeeChainWalker
 * @returns {{ text: string, trace: object }}
 */
function verifyCrossAgentClaim(text, ctx, deps) {
  const result = detectCrossAgentClaim(text);
  if (!result.detected) return { text, trace: { applied: false } };

  const conversationId =
    (ctx && ctx.conversationId) ||
    (ctx && ctx.corr) ||
    (ctx && ctx.C0 && ctx.C0.corr) ||
    null;

  const orgId =
    (ctx && ctx.orgId) ||
    (ctx && ctx.C1 && ctx.C1.orgId) ||
    null;

  if (!conversationId || !orgId || !deps || !deps.aeeChainWalker) {
    return { text, trace: { applied: false, reason: 'missing_context' } };
  }

  // Window: lookback for the searched envelopes (2h cap enforced in walker)
  const windowMs = 2 * 3600 * 1000;
  const sinceTs = new Date(Date.now() - windowMs).toISOString();
  const envelopes = deps.aeeChainWalker.findAgentEnvelopesInWindow(
    conversationId,
    result.agent_id,
    sinceTs,
    { limit: 50, windowMs }
  );

  if (envelopes.length > 0) {
    // Verified — chain shows the named agent in window
    return {
      text,
      trace: {
        applied: false,
        reason: 'verified',
        agent_name: result.agent_name,
        agent_id: result.agent_id,
        envelopes_found: envelopes.length,
      },
    };
  }

  // No envelope match → rewrite to honest fallback
  const isEs = result.language === 'es';
  const fallback = isEs
    ? `Quiero corregir algo que dije: no encuentro evidencia en la cadena de que ${result.agent_name} ${result.claim_action} en las últimas 2 horas. `
    : `I want to correct something I said: I cannot find evidence in the chain that ${result.agent_name} ${result.claim_action} anything in the last 2 hours. `;

  return {
    text: fallback + text,
    trace: {
      applied: true,
      reason: 'no_matching_envelope',
      agent_name: result.agent_name,
      agent_id: result.agent_id,
      claim_action: result.claim_action,
      window_hours: 2,
    },
  };
}

/**
 * verifyCrossOrgClaim(text, ctx, deps)
 *
 * AGH-CHAIN-3: Detects claims that an external organisation approved/confirmed
 * something and verifies them via deps.crossOrgVerifier (single call site).
 *
 * deps.crossOrgVerifier is the CONTRACT SWAP POINT for future WARD-CRYPTO.
 * Never call nameOnlyVerifier directly here — always go through the interface.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {object} [deps]
 * @param {object} [deps.crossOrgVerifier] — CrossOrgVerifier instance (nameOnlyVerifier or wardSignedVerifier)
 * @returns {{ text: string, trace: object }}
 */
function verifyCrossOrgClaim(text, ctx, deps) {
  const result = detectCrossOrgClaim(text);
  if (!result.detected) return { text, trace: { applied: false } };

  const conversationId =
    (ctx && ctx.conversationId) ||
    (ctx && ctx.corr) ||
    (ctx && ctx.C0 && ctx.C0.corr) ||
    null;

  const orgId =
    (ctx && ctx.orgId) ||
    (ctx && ctx.C1 && ctx.C1.orgId) ||
    null;

  if (!conversationId || !orgId || !deps || !deps.crossOrgVerifier) {
    return { text, trace: { applied: false, reason: 'missing_context' } };
  }

  // Single call site — swap crossOrgVerifier here for WARD-CRYPTO when available
  const v = deps.crossOrgVerifier.verify({
    orgName: result.org_name,
    requestingOrgId: orgId,
    conversationId,
    claim: result.claim_text,
    claimAction: result.claim_action,
  });

  if (v.verified) {
    return {
      text,
      trace: {
        applied: false,
        reason: 'verified',
        org_name: result.org_name,
        ...v.evidence,
        signatureValid: v.signatureValid,
      },
    };
  }

  // Failed verification → rewrite to honest fallback
  const isEs = result.language === 'es';
  let fallback;
  if (v.reason === 'unknown_counterparty') {
    fallback = isEs
      ? `Quiero corregir algo que dije: no tenemos relación de confianza con ${result.org_name}. No puedo verificar su autorización. `
      : `I want to correct something I said: we have no inbound trust relationship with ${result.org_name}. I cannot verify their authorization. `;
  } else if (v.reason === 'no_chain_match') {
    fallback = isEs
      ? `Quiero corregir algo que dije: no hay envelope firmado de ${result.org_name} en esta conversación. No puedo verificar su autorización. `
      : `I want to correct something I said: there is no inbound envelope from ${result.org_name} in this conversation. I cannot verify their authorization. `;
  } else if (v.reason === 'signature_invalid') {
    // Reserved for future signed verifier; nameOnlyVerifier never returns this
    fallback = isEs
      ? `Quiero corregir algo que dije: la firma de ${result.org_name} no es válida. No puedo verificar su autorización. `
      : `I want to correct something I said: the signature from ${result.org_name} is not valid. I cannot verify their authorization. `;
  } else {
    // missing_deps or other — fail closed conservatively
    fallback = isEs
      ? `Quiero corregir algo que dije: no puedo verificar la autorización de ${result.org_name} en este momento. `
      : `I want to correct something I said: I cannot verify ${result.org_name}'s authorization at this time. `;
  }

  return {
    text: fallback + text,
    trace: {
      applied: true,
      reason: v.reason,
      org_name: result.org_name,
      claim_action: result.claim_action,
      window_hours: 2,
      severity: 'high',  // Cross-org lateral lies are highest severity (plan §3.3)
      signatureValid: v.signatureValid,
    },
  };
}

/**
 * enforceChainGuards(text, ctx, deps) → { text, traceMap }
 *
 * Slice 1.A: detect and persist promises (text unchanged).
 * Slice 1.B: verify past-reference fulfillment claims against the chain.
 * Slice 2:   verify cross-agent claims against AEE envelopes.
 * Slice 3:   verify cross-org claims via crossOrgVerifier (contract+stub-adapter).
 *
 * Mirrors the enforceResponseContract(text, ctx) → { text, traceMap } shape.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {object} [deps]
 * @param {object} [deps.promiseStore]      — promiseStore instance from createPromiseStore
 * @param {object} [deps.voltSkillReader]   — voltSkillReader instance from createVoltSkillReader
 * @param {object} [deps.aeeChainWalker]    — aeeChainWalker instance from createAeeChainWalker
 * @param {object} [deps.crossOrgVerifier]  — CrossOrgVerifier instance from createNameOnlyVerifier (or wardSignedVerifier)
 * @returns {{ text: string, traceMap: { detect_promise: object, verify_promise_kept: object, verify_cross_agent_claim: object, verify_cross_org_claim: object } }}
 */
function enforceChainGuards(text, ctx, deps = {}) {
  const traceMap = {};

  // Step 1: detect future-tense commitments and persist promises (Slice 1.A)
  const trace1 = detectAndPersistPromise(text, ctx, deps);
  traceMap.detect_promise = trace1;

  // Step 2: verify past-reference fulfillment claims against the chain (Slice 1.B)
  const result2 = verifyPromiseKept(text, ctx, deps);
  text = result2.text;
  traceMap.verify_promise_kept = result2.trace;

  // Step 3: verify cross-agent claims against AEE envelopes (Slice 2)
  const result3 = verifyCrossAgentClaim(text, ctx, deps);
  text = result3.text;
  traceMap.verify_cross_agent_claim = result3.trace;

  // Step 4: verify cross-org claims via crossOrgVerifier (Slice 3)
  const result4 = verifyCrossOrgClaim(text, ctx, deps);
  text = result4.text;
  traceMap.verify_cross_org_claim = result4.trace;

  return { text, traceMap };
}

module.exports = { enforceChainGuards, detectAndPersistPromise, verifyPromiseKept, verifyCrossAgentClaim, verifyCrossOrgClaim };
