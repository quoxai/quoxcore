/**
 * powersTrustGate.js — LIFECYCLE-P4-D1
 *
 * Evaluates a tool's trust_tier and decides what the platform is allowed
 * to do with it. Returns a structured gate result — callers decide how
 * to act on the outcome.
 *
 * Tiers:
 *   'untrusted'  — no public internet egress (NET-HARDEN P2 will wire the
 *                  container-level enforcement; this phase marks the intent
 *                  and logs the event so operators can trace).
 *   'community'  — current default behaviour; no additional restrictions.
 *   'verified'   — admin-set, signed by Quox catalog; same runtime as
 *                  community in this phase. Differentiator is UX (badge,
 *                  marketplace eligibility — follow-up streams).
 *
 * The actual network blocking is deferred to NET-HARDEN Phase 2.
 * In this phase we:
 *   1. Return the gate result so the tool-serve path can attach
 *      _trust_tier to the tool descriptor.
 *   2. Log a structured event for any 'untrusted' invocation so the
 *      operator has a trail before enforcement lands.
 *
 * Future admin-set route will call logTrustTierChanged() below.
 */

import { randomBytes } from 'crypto';

/** @typedef {'untrusted'|'community'|'verified'} TrustTier */

/**
 * Valid trust tiers.
 */
export const TRUST_TIERS = ['untrusted', 'community', 'verified'];

/**
 * Validate that a tier string is one of the accepted values.
 *
 * @param {string} tier
 * @returns {boolean}
 */
export function isValidTrustTier(tier) {
    return TRUST_TIERS.includes(tier);
}

/**
 * Evaluate the gate for a given tool descriptor + action.
 *
 * @param {{ trust_tier?: string, tool_id?: string, id?: string }} toolDef
 *   - Partial tool_definitions row (or serialised equivalent).
 * @param {string} action
 *   - Symbolic action name, e.g. 'invoke', 'egress.outbound', 'install'.
 * @returns {{
 *   tier: TrustTier,
 *   allowed: boolean,
 *   reason: string,
 *   deferredEnforcement?: boolean
 * }}
 */
export function enforceTrustTier(toolDef, action) {
    const tier = (toolDef?.trust_tier || 'community');

    // Normalise in case a bad value slips through (treat unknown as community)
    const normTier = TRUST_TIERS.includes(tier) ? tier : 'community';

    if (normTier === 'untrusted') {
        // Mark egress-blocking intent. NET-HARDEN Phase 2 will wire the
        // iptables / network-mode restriction at spawn time.
        // For now: log the gate event and return allowed=true with
        // deferredEnforcement=true so callers know the restriction is pending.
        const toolRef = toolDef?.tool_id || toolDef?.id || 'unknown';
        console.warn(
            '[trust-gate] UNTRUSTED tool invoked — egress block deferred to NET-HARDEN-P2 ' +
            'tier=untrusted tool=%s action=%s event=power.invoke.untrusted_denied_egress',
            toolRef,
            action
        );
        return {
            tier: 'untrusted',
            allowed: true, // deferred — enforcement not yet wired
            reason: 'untrusted tier: egress block pending NET-HARDEN Phase 2',
            deferredEnforcement: true,
        };
    }

    // 'community' and 'verified' — no additional restriction in this phase
    return {
        tier: normTier,
        allowed: true,
        reason: 'allowed',
    };
}

/**
 * Stub audit helper for when an admin changes a tool's trust_tier.
 * The admin route is a follow-up stream; this helper is pre-wired so
 * the route can call it without needing to import audit utilities itself.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.toolDefId
 * @param {TrustTier} opts.fromTier
 * @param {TrustTier} opts.toTier
 * @param {string} opts.actorId
 */
export function logTrustTierChanged(db, { orgId, toolDefId, fromTier, toTier, actorId }) {
    try {
        const id = randomBytes(10).toString('hex').toUpperCase();
        db.prepare(`
            INSERT INTO audit_events (
                id, org_id, actor_type, actor_id,
                action, target_type, target_id,
                status, metadata_json, created_at
            ) VALUES (?, ?, 'user', ?, ?, 'tool_definition', ?, 'success', ?, ?)
        `).run(
            id, orgId, actorId,
            'directory.power.trust_tier_changed', toolDefId,
            JSON.stringify({ from_tier: fromTier, to_tier: toTier }),
            new Date().toISOString()
        );
    } catch (err) {
        // Audit failure is non-fatal
        console.warn('[trust-gate] audit event write failed (non-fatal):', err.message);
    }
}
