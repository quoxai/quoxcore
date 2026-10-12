/**
 * RBAC Policy Engine for Quox Auth Service
 *
 * Central authorization: can(principal, action, resource, context) → { allowed, reason }
 */

// ============================================================================
// Role Definitions
// ============================================================================

export const OrgRoles = {
    OWNER: 'owner',
    ADMIN: 'admin',
    BUILDER: 'builder',
    RUNNER: 'runner',
    VIEWER: 'viewer',
    // AUD-WS-1: cross-cutting read-only role for external auditors.
    // NOT part of the numeric hierarchy — granted a specific capability set.
    AUDITOR: 'auditor'
};

export const TeamRoles = {
    ADMIN: 'admin',
    MEMBER: 'member',
    VIEWER: 'viewer'
};

// Role hierarchy (higher can do everything lower can)
const roleHierarchy = {
    [OrgRoles.OWNER]: 5,
    [OrgRoles.ADMIN]: 4,
    [OrgRoles.BUILDER]: 3,
    [OrgRoles.RUNNER]: 2,
    [OrgRoles.VIEWER]: 1
};

// ============================================================================
// Capabilities
// ============================================================================

export const Capabilities = {
    // Organization management
    ORG_MANAGE_MEMBERS: 'org.manage_members',
    ORG_MANAGE_ROLES: 'org.manage_roles',
    ORG_MANAGE_SSO: 'org.manage_sso',
    ORG_VIEW_AUDIT: 'org.view_audit',
    ORG_MANAGE_BILLING: 'org.manage_billing',
    ORG_MANAGE_SETTINGS: 'org.manage_settings',
    ORG_DELETE: 'org.delete',

    // Organizational hierarchy (Phase B)
    ORG_MANAGE_DIVISIONS: 'org.manage_divisions',
    ORG_MANAGE_DEPARTMENTS: 'org.manage_departments',

    // Team management
    TEAM_CREATE: 'team.create',
    TEAM_MANAGE: 'team.manage',
    TEAM_DELETE: 'team.delete',

    // Directory (Phase B)
    DIRECTORY_VIEW: 'directory.view',
    DIRECTORY_SEARCH: 'directory.search',

    // Directory assets
    DIRECTORY_CREATE_ASSISTANT: 'directory.create_assistant',
    DIRECTORY_DEPLOY_ASSISTANT: 'directory.deploy_assistant',
    DIRECTORY_CREATE_AGENT: 'directory.create_agent',
    DIRECTORY_CREATE_TOOL: 'directory.create_tool',
    DIRECTORY_CREATE_WORKFLOW: 'directory.create_workflow',
    DIRECTORY_PUBLISH: 'directory.publish',
    DIRECTORY_SHARE: 'directory.share',

    // Agent & Tool Management (Enterprise Entity Model)
    AGENTS_MANAGE: 'agents.manage',
    AGENTS_VIEW: 'agents.view',
    TOOLS_ASSIGN: 'tools.assign',
    TOOLS_MANAGE: 'tools.manage',

    // Share policies (Phase B)
    SHARE_POLICIES_MANAGE: 'share_policies.manage',
    SHARE_POLICIES_VIEW: 'share_policies.view',

    // Tags (Phase B)
    TAGS_MANAGE: 'tags.manage',
    TAGS_VIEW: 'tags.view',

    // Runtime
    RUNTIME_RUN_WORKFLOW: 'runtime.run_workflow',
    RUNTIME_CANCEL_RUN: 'runtime.cancel_run',
    RUNTIME_VIEW_RUNS: 'runtime.view_runs',

    // HITL
    HITL_APPROVE: 'hitl.approve',

    // Secrets & Integrations
    SECRETS_MANAGE: 'secrets.manage',
    SECRETS_WRITE: 'secrets.write',
    SECRETS_VIEW: 'secrets.view',
    INTEGRATIONS_MANAGE: 'integrations.manage',

    // Service accounts
    SERVICE_ACCOUNTS_MANAGE: 'service_accounts.manage',

    // AUD-WS-1: Governance/compliance viewing (granted to auditor role)
    COMPLIANCE_VIEW_EVIDENCE: 'compliance.view_evidence',
    COMPLIANCE_EXPORT_PACK: 'compliance.export_pack',
    WARD_VIEW_CHAIN: 'ward.view_chain',
};

// Role to capabilities mapping
const roleCapabilities = {
    [OrgRoles.OWNER]: Object.values(Capabilities),  // All capabilities

    [OrgRoles.ADMIN]: [
        Capabilities.ORG_MANAGE_MEMBERS,
        Capabilities.ORG_MANAGE_ROLES,
        Capabilities.ORG_MANAGE_SSO,
        Capabilities.ORG_VIEW_AUDIT,
        Capabilities.ORG_MANAGE_SETTINGS,
        Capabilities.ORG_MANAGE_DIVISIONS,
        Capabilities.ORG_MANAGE_DEPARTMENTS,
        Capabilities.TEAM_CREATE,
        Capabilities.TEAM_MANAGE,
        Capabilities.TEAM_DELETE,
        Capabilities.DIRECTORY_VIEW,
        Capabilities.DIRECTORY_SEARCH,
        Capabilities.DIRECTORY_CREATE_ASSISTANT,
        Capabilities.DIRECTORY_DEPLOY_ASSISTANT,
        Capabilities.DIRECTORY_CREATE_AGENT,
        Capabilities.DIRECTORY_CREATE_TOOL,
        Capabilities.DIRECTORY_CREATE_WORKFLOW,
        Capabilities.DIRECTORY_PUBLISH,
        Capabilities.DIRECTORY_SHARE,
        Capabilities.SHARE_POLICIES_MANAGE,
        Capabilities.SHARE_POLICIES_VIEW,
        Capabilities.TAGS_MANAGE,
        Capabilities.TAGS_VIEW,
        Capabilities.RUNTIME_RUN_WORKFLOW,
        Capabilities.RUNTIME_CANCEL_RUN,
        Capabilities.RUNTIME_VIEW_RUNS,
        Capabilities.HITL_APPROVE,
        Capabilities.SECRETS_MANAGE,
        Capabilities.SECRETS_WRITE,
        Capabilities.SECRETS_VIEW,
        Capabilities.INTEGRATIONS_MANAGE,
        Capabilities.SERVICE_ACCOUNTS_MANAGE,
        // Agent & Tool Management
        Capabilities.AGENTS_MANAGE,
        Capabilities.AGENTS_VIEW,
        Capabilities.TOOLS_ASSIGN,
        Capabilities.TOOLS_MANAGE
    ],

    [OrgRoles.BUILDER]: [
        Capabilities.TEAM_CREATE,
        Capabilities.DIRECTORY_VIEW,
        Capabilities.DIRECTORY_SEARCH,
        Capabilities.DIRECTORY_CREATE_ASSISTANT,
        Capabilities.DIRECTORY_CREATE_AGENT,
        Capabilities.DIRECTORY_CREATE_TOOL,
        Capabilities.DIRECTORY_CREATE_WORKFLOW,
        Capabilities.DIRECTORY_SHARE,
        Capabilities.SHARE_POLICIES_VIEW,
        Capabilities.TAGS_VIEW,
        Capabilities.RUNTIME_RUN_WORKFLOW,
        Capabilities.RUNTIME_CANCEL_RUN,
        Capabilities.RUNTIME_VIEW_RUNS,
        Capabilities.SECRETS_VIEW,
        // Agent & Tool Management (Builder can manage agents and assign tools)
        Capabilities.AGENTS_MANAGE,
        Capabilities.AGENTS_VIEW,
        Capabilities.TOOLS_ASSIGN
    ],

    [OrgRoles.RUNNER]: [
        Capabilities.DIRECTORY_VIEW,
        Capabilities.DIRECTORY_SEARCH,
        Capabilities.TAGS_VIEW,
        Capabilities.RUNTIME_RUN_WORKFLOW,
        Capabilities.RUNTIME_VIEW_RUNS,
        Capabilities.AGENTS_VIEW
    ],

    [OrgRoles.VIEWER]: [
        Capabilities.DIRECTORY_VIEW,
        Capabilities.DIRECTORY_SEARCH,
        Capabilities.TAGS_VIEW,
        Capabilities.RUNTIME_VIEW_RUNS,
        Capabilities.AGENTS_VIEW
    ],

    // AUD-WS-1: Auditor — cross-cutting read-only role for external audit access.
    // Gets specific governance capabilities; NONE of the write capabilities.
    [OrgRoles.AUDITOR]: [
        Capabilities.DIRECTORY_VIEW,
        Capabilities.DIRECTORY_SEARCH,
        Capabilities.TAGS_VIEW,
        Capabilities.AGENTS_VIEW,
        Capabilities.RUNTIME_VIEW_RUNS,
        Capabilities.ORG_VIEW_AUDIT,
        Capabilities.COMPLIANCE_VIEW_EVIDENCE,
        Capabilities.COMPLIANCE_EXPORT_PACK,
        Capabilities.WARD_VIEW_CHAIN,
    ]
};

// ============================================================================
// Policy Engine
// ============================================================================

/**
 * Check if a principal can perform an action on a resource
 *
 * @param {Object} principal - { type: 'user'|'service_account', id, orgRole, teamRoles }
 * @param {string} action - Capability string (e.g., 'org.manage_members')
 * @param {Object} resource - { type, id, orgId, scopeId, ownerId }
 * @param {Object} context - { mfaVerified, ip, runId }
 * @returns {{ allowed: boolean, reason: string }}
 */
export function can(principal, action, resource = {}, context = {}) {
    // System actions always allowed
    if (principal.type === 'system') {
        return { allowed: true, reason: 'system_action' };
    }

    // Must have a role
    if (!principal.orgRole) {
        return { allowed: false, reason: 'no_org_membership' };
    }

    // Check if role has capability
    const capabilities = roleCapabilities[principal.orgRole] || [];
    const hasCapability = capabilities.includes(action);

    if (!hasCapability) {
        return {
            allowed: false,
            reason: `role_${principal.orgRole}_lacks_capability_${action}`
        };
    }

    // Additional checks based on action type
    const checks = getAdditionalChecks(action);
    for (const check of checks) {
        const result = check(principal, action, resource, context);
        if (!result.allowed) {
            return result;
        }
    }

    return { allowed: true, reason: 'allowed' };
}

/**
 * Check if a user has at least a certain role level
 */
export function hasRoleLevel(userRole, requiredRole) {
    return (roleHierarchy[userRole] || 0) >= (roleHierarchy[requiredRole] || 0);
}

/**
 * Get all capabilities for a role
 */
export function getCapabilities(role) {
    return roleCapabilities[role] || [];
}

/**
 * Check if principal has a specific capability.
 * Accepts either a principal object { orgRole, customRoleId? } or a bare
 * role string.
 *
 * ET-ENFORCE B: when `opts.db` + `opts.orgId` are supplied AND principal
 * carries `customRoleId`, the check also unions capabilities granted by
 * that custom role (from `custom_role_capabilities`). `opts.scopeId` may
 * be passed to honour scope-bound grants — org-wide grants (NULL scope)
 * always apply; scope-bound grants only apply when opts.scopeId matches.
 */
export function hasCapability(principal, capability, opts = {}) {
    const p = typeof principal === 'string'
        ? { type: 'user', id: 'role-check', orgRole: principal }
        : principal;
    const result = can(p, capability);
    if (result.allowed) return true;

    // Custom role resolution is opt-in via opts.db. Callers that don't
    // pass a db keep the pre-existing built-in-role-only semantics.
    const customRoleId = p?.customRoleId;
    if (!opts || !opts.db || !opts.orgId || !customRoleId) return false;

    try {
        const role = opts.db.prepare(
            `SELECT id FROM custom_roles
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        ).get(customRoleId, opts.orgId);
        if (!role) return false;

        const rows = opts.db.prepare(
            `SELECT capability, scope_id
             FROM custom_role_capabilities
             WHERE role_id = ? AND capability = ?`,
        ).all(customRoleId, capability);

        for (const row of rows) {
            // Empty-string sentinel + NULL both mean org-wide (see customRoles.js).
            const scopeId = row.scope_id === '' ? null : row.scope_id;
            if (scopeId == null) return true;
            if (opts.scopeId && scopeId === opts.scopeId) return true;
        }
    } catch {
        // Missing tables in a test harness → treat as no custom grant.
        return false;
    }
    return false;
}

/**
 * AUD-WS-1: Check whether a membership has expired.
 * Accepts { expires_at: ISO string | null | undefined }. Null/undefined
 * means no expiry. Invalid date strings are treated as no expiry (safe
 * default) rather than throwing.
 */
export function isMembershipExpired(membership) {
    if (!membership || !membership.expires_at) return false;
    const t = Date.parse(membership.expires_at);
    if (Number.isNaN(t)) return false;
    return t <= Date.now();
}

// ============================================================================
// Additional Checks
// ============================================================================

function getAdditionalChecks(action) {
    const checks = [];

    // MFA required for sensitive actions
    const mfaRequired = [
        Capabilities.ORG_MANAGE_SSO,
        Capabilities.ORG_DELETE,
        Capabilities.SECRETS_MANAGE,
        Capabilities.SECRETS_WRITE,
        Capabilities.SERVICE_ACCOUNTS_MANAGE
    ];

    if (mfaRequired.includes(action)) {
        checks.push(requireMfa);
    }

    // Self-modification checks
    if (action === Capabilities.ORG_MANAGE_MEMBERS) {
        checks.push(preventSelfDemotion);
    }

    return checks;
}

function requireMfa(principal, action, resource, context) {
    // Skip MFA check if principal is a service account
    if (principal.type === 'service_account') {
        return { allowed: true, reason: 'service_account_exempt' };
    }

    if (!context.mfaVerified && principal.mfaEnabled) {
        return {
            allowed: false,
            reason: 'mfa_required'
        };
    }
    return { allowed: true, reason: 'mfa_ok' };
}

function preventSelfDemotion(principal, action, resource, context) {
    // Can't demote yourself
    if (resource.type === 'membership' && resource.targetUserId === principal.id) {
        if (context.action === 'demote' || context.action === 'remove') {
            return {
                allowed: false,
                reason: 'cannot_modify_own_membership'
            };
        }
    }
    return { allowed: true, reason: 'not_self_modification' };
}

// ============================================================================
// Scope Checks
// ============================================================================

/**
 * Check if principal can access a resource in a specific scope
 */
export function canAccessScope(principal, scopeId, resource = {}) {
    // Org-level roles can access all scopes in the org
    if (hasRoleLevel(principal.orgRole, OrgRoles.VIEWER)) {
        return { allowed: true, reason: 'org_member' };
    }

    // Check team membership for team-scoped resources
    if (scopeId && principal.teamRoles) {
        const teamRole = principal.teamRoles[scopeId];
        if (teamRole) {
            return { allowed: true, reason: 'team_member' };
        }
    }

    // Check share policy if resource has one
    if (resource.sharePolicy) {
        return evaluateSharePolicy(principal, resource.sharePolicy, resource);
    }

    return { allowed: false, reason: 'no_scope_access' };
}

// ============================================================================
// Share Policy Evaluation (Phase B)
// ============================================================================

/**
 * Evaluate if principal can access an asset based on its share policy
 *
 * Share policy modes:
 * - private: Only the creator
 * - team: Members of the asset's home team
 * - department: Members of the asset's department
 * - division: Members of the asset's division
 * - org: All org members
 * - explicit: Specific users/teams listed in rules
 *
 * @param {Object} principal - { id, orgRole, teamMemberships, scopeAccess }
 * @param {Object} sharePolicy - { mode, rules_json }
 * @param {Object} asset - { created_by, home_scope_id, home_scope_path }
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateSharePolicy(principal, sharePolicy, asset = {}) {
    const mode = sharePolicy.mode || 'private';
    const rules = typeof sharePolicy.rules_json === 'string'
        ? JSON.parse(sharePolicy.rules_json || '{}')
        : (sharePolicy.rules_json || {});

    // Private: only creator
    if (mode === 'private') {
        if (asset.created_by === principal.id) {
            return { allowed: true, reason: 'creator_access' };
        }
        return { allowed: false, reason: 'private_asset' };
    }

    // Org-wide: any org member can access
    if (mode === 'org') {
        if (principal.orgRole) {
            return { allowed: true, reason: 'org_wide_access' };
        }
        return { allowed: false, reason: 'not_org_member' };
    }

    // Team/Department/Division: check scope hierarchy
    if (['team', 'department', 'division'].includes(mode)) {
        // Admin/Owner always have access
        if (hasRoleLevel(principal.orgRole, OrgRoles.ADMIN)) {
            return { allowed: true, reason: 'admin_override' };
        }

        // Check if user has access to the home scope or any ancestor
        if (principal.scopeAccess && asset.home_scope_id) {
            if (principal.scopeAccess.includes(asset.home_scope_id)) {
                return { allowed: true, reason: `${mode}_member` };
            }
        }

        // Check path-based access for hierarchy
        if (principal.scopePaths && asset.home_scope_path) {
            for (const userPath of principal.scopePaths) {
                // User's scope is ancestor of asset's scope
                if (asset.home_scope_path.startsWith(userPath)) {
                    return { allowed: true, reason: 'ancestor_scope_access' };
                }
                // Asset's scope is ancestor of user's scope (user is in deeper scope)
                if (userPath.startsWith(asset.home_scope_path)) {
                    return { allowed: true, reason: 'descendant_scope_access' };
                }
            }
        }

        return { allowed: false, reason: `not_${mode}_member` };
    }

    // Explicit: check rules for specific users/teams
    if (mode === 'explicit') {
        // Check explicit user list
        if (rules.users && rules.users.includes(principal.id)) {
            return { allowed: true, reason: 'explicit_user_access' };
        }

        // Check explicit team list
        if (rules.teams && principal.teamMemberships) {
            const overlap = rules.teams.some(teamId =>
                principal.teamMemberships.includes(teamId)
            );
            if (overlap) {
                return { allowed: true, reason: 'explicit_team_access' };
            }
        }

        // Check explicit scope list
        if (rules.scopes && principal.scopeAccess) {
            const overlap = rules.scopes.some(scopeId =>
                principal.scopeAccess.includes(scopeId)
            );
            if (overlap) {
                return { allowed: true, reason: 'explicit_scope_access' };
            }
        }

        return { allowed: false, reason: 'not_in_explicit_list' };
    }

    return { allowed: false, reason: 'unknown_share_mode' };
}

/**
 * Check if principal can access a specific asset
 * Combines role checks with share policy evaluation
 */
export function canAccessAsset(principal, asset, sharePolicy) {
    // Must have directory view capability
    if (!hasCapability(principal, Capabilities.DIRECTORY_VIEW)) {
        return { allowed: false, reason: 'no_directory_view_capability' };
    }

    // Creator always has access
    if (asset.created_by === principal.id) {
        return { allowed: true, reason: 'asset_creator' };
    }

    // Admin/Owner have access to all assets in org
    if (hasRoleLevel(principal.orgRole, OrgRoles.ADMIN)) {
        return { allowed: true, reason: 'admin_access' };
    }

    // Check share policy
    if (sharePolicy) {
        return evaluateSharePolicy(principal, sharePolicy, asset);
    }

    // Default to org-wide access if no policy specified
    return { allowed: true, reason: 'default_org_access' };
}

// ============================================================================
// Permission Matrix (for UI display)
// ============================================================================

export function getPermissionMatrix() {
    const matrix = {};
    for (const [role, caps] of Object.entries(roleCapabilities)) {
        matrix[role] = {};
        for (const cap of Object.values(Capabilities)) {
            matrix[role][cap] = caps.includes(cap);
        }
    }
    return matrix;
}

export default {
    can,
    hasRoleLevel,
    hasCapability,
    getCapabilities,
    canAccessScope,
    evaluateSharePolicy,
    canAccessAsset,
    getPermissionMatrix,
    OrgRoles,
    TeamRoles,
    Capabilities
};
