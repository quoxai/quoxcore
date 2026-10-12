/**
 * React hooks for role-based access control
 *
 * Uses WorkspaceContext's currentOrg.membership.role (per-org role)
 * to evaluate permissions. When a user switches orgs, currentOrg updates
 * and these hooks re-evaluate automatically.
 */

import { useWorkspace } from '../contexts/WorkspaceContext';
import { hasRoleLevel, hasCapability, getCapabilities } from '../lib/policy';

/**
 * Check if the current user has a specific capability
 * Returns false if no org is selected or role is null
 */
export function useCanAccess(capability) {
    const { currentOrg } = useWorkspace();
    const role = currentOrg?.membership?.role;
    if (!role) return false;
    return hasCapability(role, capability);
}

/**
 * Check if the current user meets a minimum role level
 * Returns false if no org is selected or role is null
 */
export function useMinRole(requiredRole) {
    const { currentOrg } = useWorkspace();
    const role = currentOrg?.membership?.role;
    if (!role) return false;
    return hasRoleLevel(role, requiredRole);
}

/**
 * Get the current user's org role
 * Returns null if no org is selected
 */
export function useUserRole() {
    const { currentOrg } = useWorkspace();
    return currentOrg?.membership?.role || null;
}

/**
 * Get all capabilities for the current user's role
 * Returns empty array if no org is selected
 */
export function useUserCapabilities() {
    const { currentOrg } = useWorkspace();
    return getCapabilities(currentOrg?.membership?.role);
}
