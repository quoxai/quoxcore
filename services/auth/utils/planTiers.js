/**
 * Plan tiers — signed-licence-driven.
 *
 * Self-hosted Quox is the current deployment model. The instance licence is
 * the single source of truth for what this installation can do. Per-org
 * billing (orgs.plan) is vestigial — the column exists in the schema for a
 * future SaaS-hosted model but is NOT consulted today.
 *
 * LICENSE-LAUNCH LL-2e-ii put plan tiers into the v2 licensing world (signed
 * Ed25519 leases, lib/licenseClient.js + lib/entitlements.js) as `plan.<tier>`
 * pseudo-entitlements inside the signed entitlements[] array, with the legacy
 * `instance_config.licensing.license` blob kept as a fallback.
 *
 * LICENSE-LAUNCH LL-2e (the cutover unit): that fallback is GONE. The plan now
 * comes ONLY from a `plan.<tier>` grant in a lease that verifies against the
 * quox.ai public key, is bound to this instance and has not expired. An install
 * with no `plan.*` grant resolves to the free plan, whatever the legacy blob
 * says — an unsigned, unverified row in instance_config is not evidence of a
 * purchase, which is the whole reason it was retired.
 *
 * ORDERING (docs/CUTOVER_RUNBOOK_LL2E.md, step 1): a box must be holding a key
 * carrying `plan.<tier>` BEFORE this code runs on it, or it drops to free and
 * the box you would use to fix it is the box that just lost its plan.
 *
 * Nothing else here reads the blob. routes/setup.js still exposes GET/DELETE
 * /setup/licensing so an admin can read and clear that legacy row; its write
 * path (PUT) has been 410 Gone since LICENSE-ENFORCE LE-3d, so the row is inert
 * history, not a live input.
 *
 * License tier → plan name mapping (picks the highest tier present):
 *   tier_c → enterprise
 *   tier_b → team
 *   tier_a → starter
 *   (no license / expired / malformed) → free
 *
 * Pricing source of truth: funding-strategy/29-pricing-strategy.md
 */

import { getPlanTiers } from '../lib/entitlements.js';

export const PLAN_ORDER = ['free', 'starter', 'team', 'enterprise'];
const RANK = PLAN_ORDER.reduce((acc, p, i) => { acc[p] = i; return acc; }, {});

// Highest tier wins (enterprise beats team beats starter).
const TIER_TO_PLAN = [
    ['tier_c', 'enterprise'],
    ['tier_b', 'team'],
    ['tier_a', 'starter'],
];

// Same mapping, keyed for lookup (used by the v2 `plan.<tier>` path below).
const TIER_KEY_TO_PLAN = Object.fromEntries(TIER_TO_PLAN);

export function getPlanRank(plan) {
    if (!plan || typeof plan !== 'string') return -1;
    const key = plan.toLowerCase();
    return Object.prototype.hasOwnProperty.call(RANK, key) ? RANK[key] : -1;
}

/**
 * True when `orgPlan` satisfies `minTier` or higher. Unknown plans
 * always return false (safer default).
 */
export function meetsPlan(orgPlan, minTier) {
    const a = getPlanRank(orgPlan);
    const b = getPlanRank(minTier);
    if (a < 0 || b < 0) return false;
    return a >= b;
}

/**
 * LICENSE-LAUNCH LL-2e-ii — the plan granted by the v2 licensing world.
 *
 * Plan tiers ride a v2 lease as `plan.<tier>` pseudo-entitlements inside the
 * signed entitlements[] array. lib/entitlements.js splits those out of the
 * plugin entitlement set and exposes them via getPlanTiers(), so this reads
 * the SAME trust path as every plugin gate: only a lease that verifies
 * against the quox.ai public key, is bound to this instance and has not
 * expired contributes anything. No lease reading or verification happens
 * here.
 *
 * `<tier>` may be a plan name (`plan.enterprise`) or the legacy tier key
 * (`plan.tier_c`) — the same two vocabularies already in this file, nothing
 * new. Anything else is ignored.
 *
 * @returns {string|null} the highest plan granted, or null when no valid
 *   lease grants one (the caller then resolves 'free').
 */
function resolvePlanFromLeases(db) {
    let tiers;
    try {
        tiers = getPlanTiers(db);
    } catch {
        // Missing table, unmigrated db, anything at all — resolve no plan
        // rather than throwing up the stack. The caller fails safe to 'free'.
        return null;
    }
    if (!tiers || tiers.size === 0) return null;

    let best = null;
    for (const tier of tiers) {
        const named = TIER_KEY_TO_PLAN[tier] || (getPlanRank(tier) >= 0 ? tier : null);
        if (!named) continue; // unrecognised tier grants nothing
        if (best === null || getPlanRank(named) > getPlanRank(best)) best = named;
    }
    return best;
}

/**
 * The instance's plan, from its signed licence.
 *
 * LL-2e (cutover): a `plan.<tier>` grant in a valid, instance-bound, unexpired
 * lease is the ONLY source. No grant — including on a box whose legacy
 * `licensing.license` blob still claims a tier — is the free plan. Fails SAFE
 * to 'free' on anything unexpected (missing table, unmigrated db, invalid or
 * expired lease, unrecognised tier name).
 */
export function resolveInstanceLicensePlan(db) {
    if (!db) return 'free';
    return resolvePlanFromLeases(db) || 'free';
}

/**
 * Effective plan for any org. Today this ignores orgRow entirely and
 * returns the instance license plan; the orgRow arg is preserved so
 * call sites don't need refactoring when future SaaS billing adds a
 * per-org override that layers on top of the instance plan.
 */
export function resolveEffectivePlan(_orgRow, { db } = {}) {
    const plan = resolveInstanceLicensePlan(db);
    return {
        plan,
        is_trial:   false,
        expired:    false,
        expires_at: null,
    };
}

// ──────────────────────────────────────────────────────────────────────
// Caps + features (unchanged — keyed by plan name, not by tier)
// ──────────────────────────────────────────────────────────────────────

const CAPS = {
    free:       { users: 3,     hosts: 5,     retention_days: 7,    sso_providers: 0,  custom_roles: 0  },
    starter:    { users: 10,    hosts: 20,    retention_days: 30,   sso_providers: 0,  custom_roles: 0  },
    team:       { users: 25,    hosts: 50,    retention_days: 90,   sso_providers: 1,  custom_roles: 0  },
    enterprise: { users: 10000, hosts: 10000, retention_days: 3650, sso_providers: 10, custom_roles: 25 },
};

export function getPlanCaps(plan) {
    const key = (plan || '').toLowerCase();
    return { ...(CAPS[key] || CAPS.free) };
}

const FEATURES = {
    free: [
        'core', 'mfa_totp', 'audit_log_view',
    ],
    starter: [
        'core', 'mfa_totp', 'audit_log_view',
        'invites_email',
    ],
    team: [
        'core', 'mfa_totp', 'audit_log_view',
        'invites_email',
        'sso', 'domain_verification', 'bulk_invite',
        'team_scoped_secrets', 'admin_portal',
    ],
    enterprise: [
        'core', 'mfa_totp', 'audit_log_view',
        'invites_email',
        'sso', 'saml', 'scim',
        'domain_verification', 'bulk_invite',
        'team_scoped_secrets', 'admin_portal',
        'custom_roles', 'ip_allowlist', 'session_policy',
        'audit_export_signed',
        'agent_aware_rbac', 'assistant_scoped_guests',
        'air_gapped_deployment', 'white_label',
    ],
};

export function getPlanFeatures(plan) {
    const key = (plan || '').toLowerCase();
    return [...(FEATURES[key] || FEATURES.free)];
}
