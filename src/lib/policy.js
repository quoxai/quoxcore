/**
 * Frontend RBAC Policy Module
 *
 * ES module mirroring the core structures from services/auth/utils/policy.js.
 * Used by sidebar filtering, route guards, and UI permission checks.
 *
 * Keep in sync with: services/auth/utils/policy.js
 */

// ============================================================================
// Role Definitions
// ============================================================================

export const OrgRoles = {
    OWNER: 'owner',
    ADMIN: 'admin',
    BUILDER: 'builder',
    RUNNER: 'runner',
    VIEWER: 'viewer'
};

// Role hierarchy (higher can do everything lower can)
export const roleHierarchy = {
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
    SERVICE_ACCOUNTS_MANAGE: 'service_accounts.manage'
};

// Role to capabilities mapping
export const roleCapabilities = {
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
    ]
};

// ============================================================================
// Permission Checks
// ============================================================================

/**
 * Check if a user has at least a certain role level.
 * Fail-closed: returns false if either role is unknown/null/undefined.
 */
export function hasRoleLevel(userRole, requiredRole) {
    if (!(userRole in roleHierarchy) || !(requiredRole in roleHierarchy)) return false;
    return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
}

/**
 * Check if a role has a specific capability.
 * Fail-closed: returns false if role is null/undefined/unknown.
 */
export function hasCapability(role, capability) {
    if (!role || !(role in roleCapabilities)) return false;
    return roleCapabilities[role].includes(capability);
}

/**
 * Get all capabilities for a role
 * Returns empty array if role is null/undefined
 */
export function getCapabilities(role) {
    return roleCapabilities[role] || [];
}
