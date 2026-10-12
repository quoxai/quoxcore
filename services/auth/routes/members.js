/**
 * ET-ENFORCE B — org membership management, custom-role overlay only.
 *
 * Base member CRUD (list / invite / role change / remove) lives in routes/orgs.js.
 * This router adds the endpoint that assigns or clears the custom role
 * overlay on a membership:
 *
 *   PUT /orgs/:orgId/members/:userId/custom-role
 *       Body: { custom_role_id: ULID | null }
 *
 * Gated: requireAuth + requireOrgMembership + ORG_MANAGE_ROLES. The custom
 * role must belong to the same org (no cross-org assignment).
 *
 * Tests inject req.user / req.org / req.orgMembership / req.db directly.
 * Production requests go through the real middleware chain below.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ulid } from '../utils/helpers.js';
import { getCustomRole, getCustomRoleCapabilities } from '../utils/customRoles.js';
import { Capabilities, getCapabilities, hasCapability, hasRoleLevel } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { humanGrantorOnly } from '../utils/principal.js';

const router = Router();

function db(req) { return req.db || getDb(); }

function ensureAuthedOrg(req, res, next) {
    if (req.user && req.org && req.orgMembership) return next();
    return requireAuth(req, res, (err) => {
        if (err) return next(err);
        return requireOrgMembership(req, res, next);
    });
}

function requireAuthedOrg(req, res, next) {
    if (!req.user || !req.org) return res.status(401).json({ error: 'unauthenticated' });
    next();
}

function requireManageRoles(req, res, next) {
    if (!resolveCap(req, Capabilities.ORG_MANAGE_ROLES)) {
        return res.status(403).json({ error: 'forbidden', required: Capabilities.ORG_MANAGE_ROLES });
    }
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'membership', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[members] audit insert failed:', err.message);
    }
}

const chain = [ensureAuthedOrg, requireAuthedOrg, humanGrantorOnly, requireManageRoles];

router.put('/orgs/:orgId/members/:userId/custom-role', ...chain, (req, res) => {
    const { userId } = req.params;
    const customRoleId = req.body?.custom_role_id ?? null;
    if (customRoleId !== null && typeof customRoleId !== 'string') {
        return res.status(400).json({ error: 'invalid_custom_role_id' });
    }

    // ET-ENFORCE round-3 — refuse self-target. An admin clearing or assigning
    // their own overlay is a self-policy primitive that should go through a
    // separate, audited "role-management" path, not this user-management one.
    if (userId === req.user.id) {
        return res.status(403).json({ error: 'cannot_modify_own_membership' });
    }

    const target = db(req).prepare(
        `SELECT id, custom_role_id, role FROM org_memberships
         WHERE org_id = ? AND user_id = ?`,
    ).get(req.org.id, userId);
    if (!target) return res.status(404).json({ error: 'membership_not_found' });

    // ET-ENFORCE round-3 + round-4 — refuse target with role >= assigner's.
    // Round-3 used hasRoleLevel (>= comparison) which allowed admin-A to
    // modify admin-B's overlay (peer-tier lateral move). Round-4 tightens
    // to STRICTLY greater: only a higher-tier role can modify a lower-tier
    // membership. Plus, reject when either role is missing from the
    // hierarchy enum (custom labels coercing to 0 collapsed to allow-all).
    {
        const ranks = { owner: 5, admin: 4, builder: 3, runner: 2, viewer: 1 };
        const assignerRank = ranks[req.orgMembership?.role];
        const targetRank   = ranks[target.role];
        if (!assignerRank || !targetRank || assignerRank <= targetRank) {
            return res.status(403).json({ error: 'cannot_modify_higher_role' });
        }
    }

    if (customRoleId != null) {
        const role = getCustomRole(db(req), req.org.id, customRoleId);
        if (!role) {
            // Either role does not exist or belongs to a different org — both
            // are treated as 400 so callers don't learn about other orgs' IDs.
            return res.status(400).json({ error: 'invalid_custom_role_id' });
        }

        // ET-ENFORCE audit-2 — privilege-escalation guard. The assigner must
        // not be able to confer capabilities they themselves do not hold.
        // Without this check an org-admin (who lacks ORG_DELETE) could mint
        // a custom role granting ORG_DELETE and assign it to themselves or
        // any user — promoting themselves to effective-owner.
        // Only enum capabilities are gated; free-form custom strings are
        // org-defined extensions without a built-in hierarchy.
        const capRows = getCustomRoleCapabilities(db(req), customRoleId);
        const assignerPrincipal = {
            orgRole:      req.orgMembership?.role,
            customRoleId: req.orgMembership?.custom_role_id || null,
        };
        const capOpts = { db: db(req), orgId: req.org.id };
        const knownCaps = new Set(Object.values(Capabilities));
        for (const { capability, scope_id } of capRows) {
            if (!knownCaps.has(capability)) continue;
            const ok = hasCapability(assignerPrincipal, capability, { ...capOpts, scopeId: scope_id || undefined });
            if (!ok) {
                // ET-ENFORCE round-3: audit the blocked attempt. Compliance
                // evidence should show every escalation try, not just success.
                emitAudit(req, 'org.membership.custom_role_assign_blocked', userId, {
                    custom_role_id: customRoleId,
                    capability,
                    reason: 'forbidden_escalation',
                });
                return res.status(403).json({
                    error:   'forbidden_escalation',
                    message: `Cannot grant capability "${capability}" — you do not hold it yourself.`,
                });
            }
        }
    }

    db(req).prepare(
        `UPDATE org_memberships SET custom_role_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
    ).run(customRoleId, target.id);

    emitAudit(
        req,
        customRoleId ? 'org.membership.custom_role_assigned' : 'org.membership.custom_role_cleared',
        userId,
        { custom_role_id: customRoleId, previous_custom_role_id: target.custom_role_id },
    );

    res.json({ ok: true, custom_role_id: customRoleId });
});

export default router;
