/**
 * useResolvedCapabilities — SET-IA Phase 1.
 *
 * Returns the *Set* of capabilities the current user has within the
 * active org, plus their org role and instance role. Used by the
 * settings sidebar + section guards to decide visibility.
 *
 * Resolution order:
 *   1. Built-in role capabilities (from lib/policy.roleCapabilities)
 *   2. Auditor base set (if role === 'auditor')
 *   3. Custom role grants (TODO Phase 3 — not yet wired; currently
 *      relies on what the backend already unioned into membership.role
 *      via custom_role_capabilities at login time)
 *
 * Output shape matches the principal contract in settingsSections.js
 * isSectionVisible / canEditSection.
 */

import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useWorkspace } from '../contexts/WorkspaceContext.jsx';
import { roleCapabilities, OrgRoles } from '../lib/policy.js';
import { useInstanceAdmin } from './useInstanceAdmin.js';

// Auditor capability set mirrors services/auth/utils/policy.js AUDITOR.
// Frontend lib/policy.js does not include AUDITOR in roleCapabilities yet;
// this set is the authoritative frontend mirror until that's added.
const AUDITOR_CAPABILITIES = Object.freeze([
    'directory.view',
    'directory.search',
    'tags.view',
    'agents.view',
    'runtime.view_runs',
    'org.view_audit',
    'compliance.view_evidence',
    'compliance.export_pack',
    'ward.view_chain',
]);

export function useResolvedCapabilities() {
    const { user, isAuthenticated } = useAuth();
    const { currentOrg } = useWorkspace();
    const { role: instanceRole, loading: instanceLoading } = useInstanceAdmin();

    const role = currentOrg?.membership?.role || null;
    const plan = currentOrg?.plan || null;

    const capabilities = useMemo(() => {
        const set = new Set();
        if (!role) return set;
        if (role === OrgRoles.AUDITOR || role === 'auditor') {
            AUDITOR_CAPABILITIES.forEach(c => set.add(c));
            return set;
        }
        const caps = roleCapabilities[role] || [];
        caps.forEach(c => set.add(c));
        return set;
    }, [role]);

    return {
        ready:        isAuthenticated && !instanceLoading,
        principal: {
            userId:       user?.id || null,
            role,
            plan,
            capabilities,
            instanceRole,
        },
    };
}
