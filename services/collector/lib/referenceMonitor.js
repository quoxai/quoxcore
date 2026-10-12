'use strict';
/**
 * QUOXTRUST T9 / D4 (complete mediation) — the reference monitor.
 *
 * codex proved that consequential effects reached execution through THREE
 * separate chokes with different coverage, so an org governance/safety policy that
 * denied a tool never fired for connector tools (the executeTool connector branch
 * returned BEFORE the GOV-4 store-policy check) and a direct connector HTTP route
 * skipped RBAC entirely. "One boundary every effect passes" was not true.
 *
 * This module is the single, shared governance-and-approval DECISION used by every
 * agent-tool path — the native executeTool path AND the connector-dispatch path —
 * so the same org policy, the same fail-closed-under-outage rule, and the same HITL
 * mint apply no matter how the effect is reached. Tool-specific concerns
 * (entitlement, RBAC, credential resolution, durable intent, execution) stay in the
 * adapters that call this; the monitor owns only the policy/approval decision, with
 * typed outcomes so callers cannot mis-handle it.
 *
 * Dependencies are INJECTED (checkStorePolicies / isSafeUnderPolicyOutage /
 * createApprovalRequest live in approvalGate, which agentTools already imports) to
 * avoid a circular require. The decision logic is lifted verbatim from the native
 * GOV-4 block it replaces, so the native path is behavior-preserving; routing the
 * connector path through it is the additive fix that closes the bypass.
 */

// Typed outcomes (the plan's vocabulary). ALLOW means the adapter proceeds to its
// own entitlement/RBAC/durable-intent/execute steps; DENIED / PENDING_APPROVAL
// carry the exact response object the caller must return unchanged.
const OUTCOME = Object.freeze({
  ALLOW: 'allow',
  DENIED: 'denied',
  PENDING_APPROVAL: 'pending_approval',
});

// The ONE canonical action identity (canonicalAction.js). The approval binding
// joins on the same effect_id the execution ledger and the WARD receipt use —
// approval is the fourth surface canonicalAction.js's header promises, not a
// parallel reimplementation.
const { buildCanonicalAction } = require('./canonicalAction');

/**
 * QUOXTRUST T-AUTH (C1, docs/trust/C1-AUTHORIZATION-CONSUMPTION.md) — does the
 * server-set claimed-approval handoff authorize THIS exact action?
 *
 * Prior authorization reaches the monitor ONLY via `ctx._claimedApproval`, set by
 * toolResume (the single consumption owner) AFTER claimForResume(). Tool INPUT is
 * model-writable and can never confer authorization — the old `!inp._approvalId`
 * short-circuits let ANY truthy string bypass require_approval and the store-outage
 * fail-closed (codex plan-challenge B1, 2026-09-28). `input._approvalId` is now a
 * correlation hint only.
 *
 * Binding (C1 rules 3-5): same tool name, same org, and the stored approved input
 * equals the current effective input (non-underscore fields; the stored input_json is
 * underscore-stripped at putPending, and resume adds _approvalId/_resumeToken control
 * fields — C3's drift case — so both sides are stripped before comparison). Which
 * card triggered the approval is recorded by the caller, not re-litigated here: an
 * org human approved this exact action (C1 rule 6b as revised for the
 * double-card livelock).
 */
function claimedApprovalBinds(toolName, inp, context) {
  const ca = context && context._claimedApproval;
  if (!ca || typeof ca !== 'object') return false;
  if (ca.tool_name !== toolName) return false;
  const org = (context && context.orgId) || null;
  if ((ca.org_id || null) !== org) return false;
  let stored;
  try {
    stored = ca.input_json ? JSON.parse(ca.input_json) : {};
  } catch {
    return false;
  }
  // Single-shape binding (C3): the approved action and THIS action must share the
  // SAME canonical effect_id. buildCanonicalAction strips underscore control
  // fields (the C3 proposal→resume drift case) AND wraps non-object inputs as
  // {value: input}, so a scalar/null/boolean input binds faithfully — the old
  // bespoke effective() did Object.keys() on a scalar (empty for a number/null),
  // so it compared {} == {} and authorized ANY scalar against an approval for a
  // different one. effect_id excludes actor identity by design (the approving
  // human vs the resuming caller differ legitimately). tool+org are also checked
  // above, so the comparison cannot be weaker than the prior binding.
  try {
    const approvedId = buildCanonicalAction(toolName, stored, { orgId: ca.org_id || null }).effect_id;
    const currentId = buildCanonicalAction(toolName, inp, { orgId: org }).effect_id;
    return approvedId === currentId;
  } catch {
    return false;
  }
}

/**
 * The single GOV-4 governance + approval decision for a named tool.
 * @returns {Promise<{outcome: string, response?: object}>}
 *   outcome ALLOW  → response undefined; the adapter continues.
 *   outcome DENIED / PENDING_APPROVAL → return `response` to the caller verbatim.
 */
async function mediateGovernancePolicy(toolName, input, ctx, deps, toolMeta) {
  const { checkStorePolicies, isSafeUnderPolicyOutage, createApprovalRequest } = deps || {};
  const inp = input || {};
  const context = ctx || {};
  const meta = toolMeta || {};

  const storeCheck = await checkStorePolicies(toolName, inp, context);

  // QUOXTRUST T2 — the governance policy store could not be consulted
  // (unavailable), which is NOT "no matching rule". Fail CLOSED for consequential
  // tools; a positive allowlist (isSafeUnderPolicyOutage) keeps unambiguous reads
  // flowing, and an unrecognised/new tool defaults to fail-closed.
  if (storeCheck.unavailable && !isSafeUnderPolicyOutage(toolName) && !claimedApprovalBinds(toolName, inp, context)) {
    console.warn(`[RefMonitor] POLICY STORE UNAVAILABLE: ${toolName} failing closed (require approval)`);
    try {
      const approval = await createApprovalRequest(toolName, inp, {
        trigger: {
          policyId: 'store-unavailable',
          ruleId: 'quoxtrust-t2-store-unavailable-fail-closed',
          condition: `governance policy store unavailable while gating ${toolName}`,
        },
        approvers: ['admin', 'group:infrastructure'],
        timeout_ms: 3600000,
      }, context.orgId, context);
      return {
        outcome: OUTCOME.PENDING_APPROVAL,
        response: {
          success: false,
          pending: true,
          approvalId: approval?.id || null,
          message: `Governance policy store unavailable; ${toolName} requires human approval (fail-closed).`,
          instructions: `The governance policy store could not be consulted, so this action is held for human approval. Approve with a 👍 reaction in the room, or from the Inbox.`,
          _policy: { id: 'store-unavailable', effect: 'require_approval' },
        },
      };
    } catch (mintErr) {
      console.warn(`[RefMonitor] store-unavailable approval mint failed for ${toolName} (blocking closed): ${mintErr.message}`);
      return {
        outcome: OUTCOME.DENIED,
        response: {
          success: false,
          error: `Governance policy store unavailable and approval could not be surfaced; ${toolName} blocked (fail-closed).`,
        },
      };
    }
  }

  if (storeCheck.policy) {
    if (storeCheck.effect === 'deny') {
      console.warn(`[RefMonitor] POLICY DENY: ${toolName} blocked by policy ${storeCheck.policy.name}`);
      return {
        outcome: OUTCOME.DENIED,
        response: {
          success: false,
          error: storeCheck.policy.reason || `Denied by policy: ${storeCheck.policy.name}`,
          _policy: { id: storeCheck.policy.id, name: storeCheck.policy.name, effect: 'deny' },
        },
      };
    }
    if (storeCheck.effect === 'require_approval' && !claimedApprovalBinds(toolName, inp, context)) {
      console.log(`[RefMonitor] POLICY APPROVAL: ${toolName} requires approval per policy ${storeCheck.policy.name}`);
      try {
        const approval = await createApprovalRequest(toolName, inp, {
          trigger: {
            policyId: storeCheck.policy.id,
            ruleId: storeCheck.policy.id,
            condition: `${storeCheck.policy.name} matched ${toolName}`,
          },
          approvers: ['admin', 'group:infrastructure'],
          timeout_ms: 3600000,
        }, context.orgId, context);
        return {
          outcome: OUTCOME.PENDING_APPROVAL,
          response: {
            success: false,
            pending: true,
            approvalId: approval?.id || null,
            message: storeCheck.policy.reason || `Requires approval per policy: ${storeCheck.policy.name}`,
            instructions: `Posted for human approval (approval ${approval?.id || 'pending'}). Approve with a 👍 reaction in the room, or from the Inbox.`,
            _policy: { id: storeCheck.policy.id, name: storeCheck.policy.name, effect: 'require_approval' },
          },
        };
      } catch (mintErr) {
        // QUOXTRUST T2 (C1 rule 7) — mint failure is FAIL-CLOSED. The old branch
        // returned PENDING_APPROVAL with no approvalId and no inbox item (the human
        // surfacing silently lost) and instructed an honor-system "re-invoke with
        // _approvalId" — which nothing verified. Mirror approvalGate's
        // approval_surfacing_failed hard-fail instead.
        console.warn(`[RefMonitor] POLICY APPROVAL mint failed for ${toolName} (blocking closed): ${mintErr.message}`);
        return {
          outcome: OUTCOME.DENIED,
          response: {
            success: false,
            error: `Approval required by policy '${storeCheck.policy.name}' but could not be surfaced (approval_surfacing_failed: ${mintErr.message}); ${toolName} blocked (fail-closed).`,
            _policy: { id: storeCheck.policy.id, name: storeCheck.policy.name, effect: 'require_approval' },
          },
        };
      }
    }
  }

  // QUOXTRUST F5 (FND_01M3R1TYXZW516YN6TNGW516YN) — the plugin-effect DEFAULT gate.
  // A third-party plugin tool classified as an EFFECT (see classifyPluginToolEffect:
  // effect-verb name OR declared effect OR undeclared-fail-safe) reaches here only
  // when NO explicit org deny/require_approval policy matched (those returned above)
  // and NO prior human approval binds this exact action. Absent this block it would
  // ALLOW — the finding's gap: plugin backends' effect tools executing with no
  // default approval gate. Default it to require_approval. READ plugin tools
  // (meta.isPluginEffect false) fall straight through to ALLOW — no first-party read
  // UX regression. This is the SAME choke (one boundary), driven by a server-side
  // classification the plugin cannot weaken, mint fail-closed like the policy path.
  if (meta.isPluginEffect === true && !claimedApprovalBinds(toolName, inp, context)) {
    console.log(`[RefMonitor] PLUGIN-EFFECT DEFAULT GATE: ${toolName} requires approval (no explicit policy; effect-classified)`);
    try {
      const approval = await createApprovalRequest(toolName, inp, {
        trigger: {
          policyId: 'plugin-effect-default',
          ruleId: 'quoxtrust-f5-plugin-effect-default-approval',
          condition: `plugin effect tool ${toolName} has no explicit org policy; default require_approval`,
        },
        approvers: ['admin', 'group:infrastructure'],
        timeout_ms: 3600000,
      }, context.orgId, context);
      return {
        outcome: OUTCOME.PENDING_APPROVAL,
        response: {
          success: false,
          pending: true,
          approvalId: approval?.id || null,
          message: `Plugin effect tool ${toolName} requires human approval by default.`,
          instructions: `This plugin tool performs an effect and has no explicit org policy, so it is held for human approval by default. Approve with a 👍 reaction in the room, or from the Inbox. (An org admin can set an explicit policy to change this.)`,
          _policy: { id: 'plugin-effect-default', effect: 'require_approval' },
        },
      };
    } catch (mintErr) {
      // Mint failure is FAIL-CLOSED, mirroring the policy-approval and store-outage
      // branches — the human surfacing must never be silently lost.
      console.warn(`[RefMonitor] plugin-effect default-gate mint failed for ${toolName} (blocking closed): ${mintErr.message}`);
      return {
        outcome: OUTCOME.DENIED,
        response: {
          success: false,
          error: `Plugin effect tool ${toolName} requires approval by default but it could not be surfaced (approval_surfacing_failed: ${mintErr.message}); blocked (fail-closed).`,
          _policy: { id: 'plugin-effect-default', effect: 'require_approval' },
        },
      };
    }
  }

  return { outcome: OUTCOME.ALLOW };
}

module.exports = { OUTCOME, mediateGovernancePolicy };
