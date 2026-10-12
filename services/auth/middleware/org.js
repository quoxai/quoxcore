/**
 * Organization middleware for Quox Auth Service
 *
 * Provides org membership, role verification, and row-level security for routes
 *
 * Phase 2: Added validateOrgResponse for cross-org data leak prevention
 */

import { queries, getDb } from '../db/index.js';
import { hasRoleLevel, OrgRoles, hasCapability } from '../utils/policy.js';
import { validateOrgResponse } from '../utils/orgScope.js';

/**
 * Require organization membership
 *
 * Loads the org from :orgId param and verifies user is a member.
 * Populates req.org and req.orgMembership.
 *
 * Usage: router.get('/orgs/:orgId/...', requireAuth, requireOrgMembership, handler)
 */
export function requireOrgMembership(req, res, next) {
    const orgId = req.params.orgId;

    if (!orgId) {
        return res.status(400).json({
            error: 'org_id_required',
            message: 'Organization ID is required'
        });
    }

    if (!req.user) {
        return res.status(401).json({
            error: 'authentication_required',
            message: 'Must be authenticated'
        });
    }

    // Load org
    const org = queries.getOrgById(orgId);
    if (!org) {
        return res.status(404).json({
            error: 'org_not_found',
            message: 'Organization not found'
        });
    }

    if (org.deleted_at) {
        return res.status(404).json({
            error: 'org_deleted',
            message: 'Organization has been deleted'
        });
    }

    // Check membership
    const membership = queries.getOrgMembership(orgId, req.user.id);

    if (!membership || membership.status !== 'active') {
        return res.status(403).json({
            error: 'not_org_member',
            message: 'You are not a member of this organization'
        });
    }

    // AUD-WS-1: time-bounded auditor access. Reject if expires_at is past.
    if (membership.expires_at) {
        const expiresMs = Date.parse(membership.expires_at);
        if (!Number.isNaN(expiresMs) && expiresMs <= Date.now()) {
            return res.status(403).json({
                error: 'membership_expired',
                message: `Your ${membership.role} access to this organization expired on ${membership.expires_at}`,
                expired_at: membership.expires_at,
            });
        }
    }

    // Populate request
    req.org = org;
    req.orgMembership = membership;
    req.user.orgRole = membership.role;

    // ET-ENFORCE B: req.hasCap(cap [, { scopeId }]) resolves built-in role
    // caps unioned with any custom role overlay on the membership. Routes
    // should prefer this over calling hasCapability() directly so custom
    // role grants are picked up uniformly.
    req.hasCap = (capability, { scopeId } = {}) => hasCapability(
        {
            type: 'user',
            id: req.user?.id,
            orgRole: membership.role,
            customRoleId: membership.custom_role_id || null,
        },
        capability,
        { db: req.db || getDb(), orgId: org.id, scopeId },
    );

    next();
}

/**
 * Require minimum organization role
 *
 * Must be used after requireOrgMembership.
 *
 * @param {string} minRole - Minimum required role (owner, admin, builder, operator, viewer)
 *
 * Usage: router.post('/orgs/:orgId/...', requireAuth, requireOrgMembership, requireOrgRole('admin'), handler)
 */
export function requireOrgRole(minRole) {
    return (req, res, next) => {
        if (!req.orgMembership) {
            return res.status(500).json({
                error: 'middleware_order',
                message: 'requireOrgMembership must be called before requireOrgRole'
            });
        }

        const currentRole = req.orgMembership.role;

        if (!hasRoleLevel(currentRole, minRole)) {
            return res.status(403).json({
                error: 'insufficient_role',
                message: `Requires ${minRole} role or higher, you have ${currentRole}`
            });
        }

        next();
    };
}

/**
 * Require owner role
 */
export const requireOwner = requireOrgRole(OrgRoles.OWNER);

/**
 * Require admin role
 */
export const requireAdmin = requireOrgRole(OrgRoles.ADMIN);

/**
 * Require builder role
 */
export const requireBuilder = requireOrgRole(OrgRoles.BUILDER);

/**
 * Require operator role
 */
export const requireOperator = requireOrgRole(OrgRoles.OPERATOR);

/**
 * Secure org middleware with response validation (Phase 2)
 *
 * Combines requireOrgMembership with validateOrgResponse for defense-in-depth.
 * Intercepts res.json() to prevent cross-org data leaks even if query filtering fails.
 *
 * Usage: router.get('/orgs/:orgId/...', requireAuth, requireOrgMembershipSecure, handler)
 */
export function requireOrgMembershipSecure(req, res, next) {
    requireOrgMembership(req, res, (err) => {
        if (err) return next(err);
        // Chain to validateOrgResponse
        validateOrgResponse(req, res, next);
    });
}

/**
 * Re-export validateOrgResponse for direct use
 */
export { validateOrgResponse };

export default {
    requireOrgMembership,
    requireOrgMembershipSecure,
    requireOrgRole,
    requireOwner,
    requireAdmin,
    requireBuilder,
    requireOperator,
    validateOrgResponse
};
