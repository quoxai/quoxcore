/**
 * VAULT-P5.G — Lease enforcement gate, wired into every LIVE credential
 * release path (STREAM_VAULT_AUDIT_PLAN_v2.md §4, STREAM_VAULT_AUDIT_PLAN.md
 * §4.4, F4).
 *
 * `checkLeaseAccess` is the single fail-closed lease check: if a credential
 * doesn't require a lease (`lease_required` falsy), access is always allowed.
 * If it does, the caller's agent must hold an active lease with uses
 * remaining — checking consumes one use atomically (incrementLeaseUse).
 *
 * `evaluateLeaseGate` wraps that check with the org's 3-state
 * `vault.lease_enforcement` flag (utils/leaseEnforcement.js):
 *   off      — checkLeaseAccess result is ignored entirely; always allow,
 *              no audit noise (full bypass, matches pre-P5 dead-code
 *              behavior for orgs that explicitly opt out).
 *   advisory — a missing/expired/exhausted lease still allows the release
 *              (`allow: true`) but is flagged `advisory: true` so the
 *              caller can emit a `secret.access.lease_missing` audit event.
 *   enforced — a missing/expired/exhausted lease is refused (`allow: false`)
 *              so the caller can 403 and emit `secret.access.lease_denied`.
 *
 * Moved here (out of services/credentialResolver.js, which now imports it)
 * so route-level callers (routes/integrations.js, routes/totp.js,
 * routes/session-state.js, routes/setup.js) can gate lease-required
 * credentials on THEIR release paths too, not only inside resolveForAgent's
 * own internal branches — this is the concrete fix for F4 "lease
 * enforcement is dead code": the checks now run on the endpoints that
 * actually release plaintext.
 */

import { getDb } from '../db/index.js';
import { getActiveLease, incrementLeaseUse } from '../db/integrations.js';
import { getLeaseEnforcementMode } from '../utils/leaseEnforcement.js';

/**
 * @param {string} orgId
 * @param {string|null} agentId
 * @param {string} credentialId
 * @returns {{ allowed: boolean, reason?: string, leaseId?: string, leaseRequired: boolean }}
 */
export function checkLeaseAccess(orgId, agentId, credentialId) {
    try {
        const db = getDb();
        const cred = db.prepare(
            'SELECT lease_required FROM integration_credentials WHERE id = ?'
        ).get(credentialId);

        if (!cred || !cred.lease_required) {
            return { allowed: true, leaseRequired: false };
        }

        if (!agentId) {
            // No agent identity supplied by the caller — there is no lease
            // to look up. Fail closed exactly like "no active lease".
            return { allowed: false, reason: 'lease_required', leaseRequired: true };
        }

        const lease = getActiveLease(orgId, agentId, credentialId);
        if (!lease) {
            return { allowed: false, reason: 'lease_required', leaseRequired: true };
        }

        // Increment use count (atomic — returns false if max_uses exceeded)
        const incremented = incrementLeaseUse(lease.id);
        if (!incremented) {
            return { allowed: false, reason: 'lease_exhausted', leaseRequired: true };
        }

        return { allowed: true, leaseId: lease.id, leaseRequired: true };
    } catch (err) {
        console.error(`[LeaseGate] Lease check failed for ${credentialId}:`, err.message);
        // Fail closed: if the lease check errors, deny access.
        return { allowed: false, reason: 'lease_check_error', leaseRequired: true };
    }
}

/**
 * @param {object} params
 * @param {string} params.orgId
 * @param {string|null} [params.agentId]
 * @param {string} params.credentialId
 * @returns {{ allow: boolean, mode: string, advisory?: boolean, leaseId?: string, leaseRequired: boolean, reason?: string }}
 */
export function evaluateLeaseGate({ orgId, agentId = null, credentialId }) {
    const leaseCheck = checkLeaseAccess(orgId, agentId, credentialId);
    if (leaseCheck.allowed) {
        return { allow: true, mode: null, leaseId: leaseCheck.leaseId, leaseRequired: leaseCheck.leaseRequired };
    }

    const mode = getLeaseEnforcementMode(orgId);
    if (mode === 'enforced') {
        return { allow: false, mode, leaseRequired: leaseCheck.leaseRequired, reason: leaseCheck.reason };
    }

    // 'off' (full bypass) or 'advisory' (allow + flag for audit)
    return {
        allow: true,
        mode,
        advisory: mode === 'advisory',
        leaseRequired: leaseCheck.leaseRequired,
        reason: leaseCheck.reason,
    };
}

export default { checkLeaseAccess, evaluateLeaseGate };
