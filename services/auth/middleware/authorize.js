/**
 * Authorization middleware for Quox Auth Service
 */

import { can, hasRoleLevel, OrgRoles, Capabilities } from '../utils/policy.js';
import { logAudit, AuditActions } from '../utils/audit.js';

/**
 * Require a specific capability
 *
 * @param {string} capability - Required capability from Capabilities
 * @param {Object} options
 * @param {Function} options.getResource - Function to extract resource from request
 */
export function requireCapability(capability, options = {}) {
    const { getResource } = options;

    return async (req, res, next) => {
        if (!req.user && !req.serviceAccount) {
            return res.status(401).json({
                error: 'authentication_required',
                message: 'Must be authenticated'
            });
        }

        // Build principal object
        const principal = req.serviceAccount ? {
            type: 'service_account',
            id: req.serviceAccount.id,
            orgRole: req.serviceAccount.role,
            mfaEnabled: false
        } : {
            type: 'user',
            id: req.user.id,
            orgRole: req.user.orgRole,
            mfaEnabled: req.user.mfaEnabled
        };

        // Build resource object
        const resource = getResource ? await getResource(req) : {
            orgId: req.org?.id
        };

        // Build context
        const context = {
            mfaVerified: req.user?.mfaVerified || false,
            ip: req.ip,
            runId: req.body?.runId || req.query?.runId
        };

        // Check authorization
        const result = can(principal, capability, resource, context);

        if (!result.allowed) {
            // Log denial
            logAudit({
                action: `${capability}.denied`,
                actor: principal,
                orgId: req.org?.id,
                target: resource.type ? { type: resource.type, id: resource.id } : null,
                status: 'denied',
                request: req,
                metadata: { reason: result.reason }
            });

            return res.status(403).json({
                error: 'forbidden',
                message: 'You do not have permission to perform this action',
                reason: result.reason
            });
        }

        // Store authorization result for downstream use
        req.authResult = result;
        next();
    };
}

/**
 * Require minimum role level
 */
export function requireRole(minRole) {
    return (req, res, next) => {
        if (!req.user && !req.serviceAccount) {
            return res.status(401).json({
                error: 'authentication_required',
                message: 'Must be authenticated'
            });
        }

        const currentRole = req.user?.orgRole || req.serviceAccount?.role;

        if (!currentRole) {
            return res.status(403).json({
                error: 'no_org_membership',
                message: 'Must be a member of an organization'
            });
        }

        if (!hasRoleLevel(currentRole, minRole)) {
            return res.status(403).json({
                error: 'insufficient_role',
                message: `Requires ${minRole} role or higher`
            });
        }

        next();
    };
}

/**
 * Require org owner role
 */
export function requireOwner() {
    return requireRole(OrgRoles.OWNER);
}

/**
 * Require org admin role
 */
export function requireAdmin() {
    return requireRole(OrgRoles.ADMIN);
}

/**
 * Require org builder role
 */
export function requireBuilder() {
    return requireRole(OrgRoles.BUILDER);
}

/**
 * Ensure request is for the authenticated user's own resources
 */
export function requireSelf(idParam = 'userId') {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'authentication_required',
                message: 'Must be authenticated'
            });
        }

        const targetId = req.params[idParam] || req.body[idParam];

        // Allow 'me' as shorthand for current user
        if (targetId === 'me') {
            req.params[idParam] = req.user.id;
            return next();
        }

        if (targetId !== req.user.id) {
            // Admins can access other users' resources
            if (req.user.orgRole && hasRoleLevel(req.user.orgRole, OrgRoles.ADMIN)) {
                return next();
            }

            return res.status(403).json({
                error: 'forbidden',
                message: 'Can only access your own resources'
            });
        }

        next();
    };
}

/**
 * Ensure request is for resources within the current org
 */
export function requireOrgScope() {
    return (req, res, next) => {
        if (!req.org) {
            return res.status(400).json({
                error: 'org_required',
                message: 'Organization context required'
            });
        }

        // Check if resource org_id matches current org
        const resourceOrgId = req.params.orgId || req.body?.org_id || req.query?.org_id;

        if (resourceOrgId && resourceOrgId !== req.org.id) {
            return res.status(403).json({
                error: 'cross_org_access',
                message: 'Cannot access resources from another organization'
            });
        }

        next();
    };
}

// Export convenience functions
export const require_ = {
    owner: requireOwner,
    admin: requireAdmin,
    builder: requireBuilder,
    role: requireRole,
    capability: requireCapability,
    self: requireSelf,
    orgScope: requireOrgScope
};

export default {
    requireCapability,
    requireRole,
    requireOwner,
    requireAdmin,
    requireBuilder,
    requireSelf,
    requireOrgScope,
    OrgRoles,
    Capabilities
};
