'use strict';
/**
 * outboundEffectGovernance — QUOXTRUST (FND_01M3S8Q874M0DSZK) — bring the CommanderQ
 * tripwire's outbound telephony + notification under the org GOV-4 governance boundary.
 *
 * The tripwire fires real outbound calls (callProviders.placeOutboundCall) and telegram
 * notifications on an incident. Those were gated only by opt-in consent + cooldown +
 * deny-by-default, never by the org policy store — so an org could not centrally DENY or
 * egress-bound outbound telephony (T6 egress bounds / T9 complete mediation gap).
 *
 * This adds that lever, tuned for an AUTONOMOUS ALERT path (unlike an on-demand tool):
 *   - an explicit org GOV-4 **deny** policy BLOCKS the effect (the missing lever);
 *   - **require_approval** does NOT hold an incident alert (holding an alert for human
 *     approval is self-defeating) — it proceeds but is RECORDED, so an org that needs
 *     approval-gated calling uses `deny` + a separate approved-calling flow;
 *   - a **policy-store outage** does NOT suppress the alert (suppressing incident
 *     delivery is its own failure) — it proceeds and is RECORDED.
 * Consent + cooldown + deny-by-default remain the PRIMARY authorization; this is an
 * additive restriction layer routed through the SAME policy store the reference monitor
 * uses (checkStorePolicies), so there is no second policy source to drift.
 *
 * @param {Function} checkStorePolicies  approvalGate.checkStorePolicies (injected/testable)
 * @param {string} toolName  synthetic governed name, e.g. 'commanderq_outbound_call'
 * @param {object} input     the effective action (channel, recipient)
 * @param {string} orgId
 * @returns {Promise<{allowed:boolean, reason:string|null, governance:string|null}>}
 */
async function evaluateOutboundEffectPolicy(checkStorePolicies, toolName, input, orgId) {
    try {
        const sc = await checkStorePolicies(toolName, input || {}, { orgId });
        if (sc && sc.policy && sc.effect === 'deny') {
            return { allowed: false, reason: `policy_deny:${sc.policy.name || sc.policy.id}`, governance: 'deny' };
        }
        if (sc && sc.policy && sc.effect === 'require_approval') {
            // Alert path: do not hold; record that an approval policy matched.
            return { allowed: true, reason: null, governance: `require_approval_recorded:${sc.policy.name || sc.policy.id}` };
        }
        if (sc && sc.unavailable) {
            return { allowed: true, reason: null, governance: 'policy_store_unavailable_alert_proceeded' };
        }
        return { allowed: true, reason: null, governance: null };
    } catch (e) {
        // Never let a governance-eval error suppress an incident alert; record it.
        return { allowed: true, reason: null, governance: `policy_check_error:${e && e.message ? e.message : 'unknown'}` };
    }
}

module.exports = { evaluateOutboundEffectPolicy };
