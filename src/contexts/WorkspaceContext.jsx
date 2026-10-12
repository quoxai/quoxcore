/**
 * Workspace Context for Quox Dashboard
 * Manages current org, scope, and workspace navigation state
 *
 * Features:
 * - Organization management
 * - Scope/lens navigation
 * - Dev mode support with mock data
 * - Timeout handling to prevent stuck loading states
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { setHostAuthContext, clearHostAuthContext } from '../services/hostAuthContext';
import { setStorageContext } from '../services/orgScopedStorage';
import { setOrgSyncContext } from '../services/serverSyncQueue';
import { clearEntitlements, fetchEntitlements } from '../services/licenseValidator';
import { DEV_FALLBACK_ORG, DEV_FALLBACK_SCOPE } from '../utils/devMode';

// Timeout for org loading (prevent infinite loading)
const ORG_LOAD_TIMEOUT = 5000; // 5 seconds

/**
 * One-time migration: copies global localStorage keys to org-scoped namespace.
 * Only runs once per org (flagged by quox_migrated_${orgId}).
 */
function migrateGlobalToOrgScoped(orgId, userId) {
    const flag = `quox_migrated_${orgId}`;
    if (localStorage.getItem(flag)) return;

    const orgMigrations = [
        ['quox-files', 'files'], ['quox-files-metadata', 'files-meta'],
        ['quox-files-folders', 'files-folders'], ['quox-files-settings', 'files-settings'],
        ['quox-plugin-configs', 'plugin-configs'], ['quox_custom_tools', 'custom-tools'],
        ['quox_alert_rules', 'alert-rules'], ['quox_alert_state', 'alert-state'],
        ['quox_custom_services', 'custom-services'], ['quox_datapoints_cache', 'datapoints'],
    ];
    const personalMigrations = [
        ['quox_working_set', 'wsm'], ['quox_open_loops', 'open-loops'],
        ['quox_style_profile', 'style'], ['quox_behavior_patterns', 'behavior'],
        // VOLT-FIX B: 'quox-ui-settings' removed from the migration list.
        // uiSettings.js was reverted to raw user-level localStorage; if we
        // still migrated to the org-scoped key on first switch, we'd silently
        // move the working value into the dead slot.
        ['quox-voice-settings', 'voice'],
        ['quox_failure_memory', 'failure-mem'], ['quox_pending_writes', 'mem-pending'],
        ['quox_assistant_overrides', 'assistant-overrides'],
        ['quox_sync_status', 'assistant-sync'],
    ];

    for (const [oldKey, baseKey] of orgMigrations) {
        const val = localStorage.getItem(oldKey);
        const newKey = `quox_${orgId}_${baseKey}`;
        if (val && !localStorage.getItem(newKey)) localStorage.setItem(newKey, val);
    }
    if (userId) {
        for (const [oldKey, baseKey] of personalMigrations) {
            const val = localStorage.getItem(oldKey);
            const newKey = `quox_${orgId}_${userId}_${baseKey}`;
            if (val && !localStorage.getItem(newKey)) localStorage.setItem(newKey, val);
        }
    }

    localStorage.setItem(flag, new Date().toISOString());
}

const WorkspaceContext = createContext(null);

export function WorkspaceProvider({ children }) {
    const { authFetch, isAuthenticated, user, isDevMode } = useAuth();

    // Current org
    const [currentOrg, setCurrentOrg] = useState(null);

    // #770: publish the host-resolved identity for the plugin frame RPC mediator
    // (non-React caller). Ids/role/tier only, never a token.
    useEffect(() => {
        if (!isAuthenticated || !user?.id || !currentOrg?.id) { clearHostAuthContext(); return; }
        setHostAuthContext({
            userId: user.id,
            orgId: currentOrg.id,
            role: currentOrg.membership?.role || currentOrg.role,
            tier: currentOrg.tier || user.tier,
        });
    }, [isAuthenticated, user?.id, user?.tier, currentOrg?.id, currentOrg?.role, currentOrg?.tier, currentOrg?.membership?.role]);
    const [orgs, setOrgs] = useState([]);

    // Current scope (lens for viewing assets)
    const [currentScope, setCurrentScope] = useState(null);
    const [scopeTree, setScopeTree] = useState(null);
    const [scopePath, setScopePath] = useState([]);

    // User's team memberships
    const [myTeams, setMyTeams] = useState([]);
    const [myScopes, setMyScopes] = useState([]);

    // Loading states
    const [loading, setLoading] = useState(true);

    // Publish the active org context for plugins (api.getOrg()) so a plugin can
    // show WHICH org the user is acting in — e.g. "Creating this waypoint for
    // ExamplePools". Keeps the plugin surface honest about org context, which the
    // spatial data-scatter incident showed was invisible.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.__quoxOrgContext = currentOrg
            ? { id: currentOrg.id, name: currentOrg.name || null, slug: currentOrg.slug || null }
            : null;
    }, [currentOrg]);

    // Load orgs when authenticated
    useEffect(() => {
        if (isAuthenticated || isDevMode) {
            // If user has org info attached (from dev-login), use it as initial state
            if (user?.org) {
                const userOrg = {
                    id: user.org.id,
                    name: user.org.name,
                    slug: user.org.slug,
                    role: user.org.role || 'viewer',
                    member_count: user.org.member_count || 0,
                    team_count: user.org.team_count || 0,
                    division_count: user.org.division_count || 0,
                    membership: { role: user.org.role || 'viewer' }
                };
                console.log('[Workspace] Using org from user context:', userOrg.name);
                // Must be written BEFORE setStorageContext fires quox-org-switch:
                // the plugin host's rehydration listener reads current_org_id, and
                // boot paths previously never set it — fresh single-org users got
                // no third-party plugins until they manually switched orgs.
                localStorage.setItem('current_org_id', userOrg.id);
                setStorageContext(userOrg.id, user?.id);
                setOrgSyncContext(userOrg.id);
                migrateGlobalToOrgScoped(userOrg.id, user?.id);
                setOrgs([userOrg]);
                setCurrentOrg(userOrg);
                // Create a scope from the org
                setCurrentScope({
                    id: userOrg.id,
                    name: userOrg.name,
                    type: 'organization',
                    org_id: userOrg.id
                });
                setLoading(false);
                if (!isDevMode) {
                    // Still try to load full org list in background for real sessions
                    loadOrgs();
                }
                return;
            }
            if (isDevMode) {
                setStorageContext(DEV_FALLBACK_ORG.id, user?.id);
                setOrgSyncContext(DEV_FALLBACK_ORG.id);
                migrateGlobalToOrgScoped(DEV_FALLBACK_ORG.id, user?.id);
                setOrgs([DEV_FALLBACK_ORG]);
                setCurrentOrg(DEV_FALLBACK_ORG);
                setCurrentScope(DEV_FALLBACK_SCOPE);
                setLoading(false);
                return;
            }
            // Otherwise load orgs normally
            loadOrgs();
        } else {
            setOrgs([]);
            setCurrentOrg(null);
            setCurrentScope(null);
            setLoading(false);
        }
    }, [isAuthenticated, isDevMode, user?.org?.id]);

    // Load org details when org changes
    useEffect(() => {
        if (currentOrg) {
            loadOrgDetails();
        }
    }, [currentOrg?.id]);

    const loadOrgs = async () => {
        // Set up a timeout to prevent stuck loading
        const timeoutId = setTimeout(() => {
            console.warn('[Workspace] Org loading timed out');
            if (isDevMode) {
                setStorageContext(DEV_FALLBACK_ORG.id, user?.id);
                setOrgSyncContext(DEV_FALLBACK_ORG.id);
                setOrgs([DEV_FALLBACK_ORG]);
                setCurrentOrg(DEV_FALLBACK_ORG);
                setCurrentScope(DEV_FALLBACK_SCOPE);
            }
            setLoading(false);
        }, ORG_LOAD_TIMEOUT);

        try {
            const response = await authFetch('/api/orgs');
            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                // Backend returns organizations, not orgs
                const orgList = data.organizations || data.orgs || [];

                // Map role to membership for UI consistency
                const mappedOrgs = orgList.map(o => ({
                    ...o,
                    membership: { role: o.role }
                }));

                setOrgs(mappedOrgs);

                // #363 — reconcile localStorage.current_org_id against the
                // memberships we just fetched, EVERY time the list loads.
                // Incident: a stale/foreign current_org_id (an org this session's
                // user is not a member of — left behind by a previous login, an
                // org deletion, or a membership revocation) is read RAW by ~a dozen
                // service clients, so every one of them 401s. Product-wide, that
                // surfaced as RepoBrain "ENGINE OFFLINE" rather than as an auth
                // error. Two leak paths existed here: a zero-org user never got the
                // key cleared, and a stale saved id was never rewritten once
                // currentOrg had already been set. Note hydrateCurrentOrgPrefs in
                // AuthContext.jsx computes the corrected org but never persists it,
                // so this load path is the only place the key actually gets fixed.
                if (mappedOrgs.length === 0) {
                    // An org-less user must look like a fresh boot to plugin hosts:
                    // plain remove, no setStorageContext / quox-org-switch event.
                    localStorage.removeItem('current_org_id');
                } else {
                    const savedOrgId = localStorage.getItem('current_org_id');
                    if (!mappedOrgs.some(o => o.id === savedOrgId)) {
                        // Correct ONLY the localStorage value that raw readers
                        // consume. Do not re-run setCurrentOrg / migrate /
                        // setStorageContext here — when currentOrg is already set,
                        // the in-memory context is fine and re-firing the org-switch
                        // machinery would churn plugin hosts for no reason.
                        const validOrg = currentOrg && mappedOrgs.some(o => o.id === currentOrg.id)
                            ? currentOrg
                            : mappedOrgs[0];
                        localStorage.setItem('current_org_id', validOrg.id);
                    }
                }

                // Auto-select first org if none selected
                if (mappedOrgs.length > 0 && !currentOrg) {
                    const savedOrgId = localStorage.getItem('current_org_id');
                    const selectedOrg = mappedOrgs.find(o => o.id === savedOrgId) || mappedOrgs[0];
                    // Before setStorageContext — its quox-org-switch listener
                    // (plugin host rehydration) reads current_org_id.
                    localStorage.setItem('current_org_id', selectedOrg.id);
                    setStorageContext(selectedOrg.id, user?.id);
                    setOrgSyncContext(selectedOrg.id);
                    migrateGlobalToOrgScoped(selectedOrg.id, user?.id);
                    setCurrentOrg(selectedOrg);
                }
            } else {
                console.warn('[Workspace] Org API returned error');
                if (isDevMode) {
                    setOrgs([DEV_FALLBACK_ORG]);
                    setCurrentOrg(DEV_FALLBACK_ORG);
                }
            }
        } catch (err) {
            clearTimeout(timeoutId);
            console.error('Failed to load orgs:', err);
            if (isDevMode) {
                setOrgs([DEV_FALLBACK_ORG]);
                setCurrentOrg(DEV_FALLBACK_ORG);
            }
        } finally {
            setLoading(false);
        }
    };

    const loadOrgDetails = async () => {
        if (!currentOrg?.id) return;

        if (isDevMode) {
            setScopeTree(DEV_FALLBACK_SCOPE);
            setMyTeams([]);
            setMyScopes([DEV_FALLBACK_SCOPE]);
            if (!currentScope) {
                setCurrentScope(DEV_FALLBACK_SCOPE);
            }
            return;
        }

        try {
            // Load scope tree, teams, and user scopes in parallel
            const [treeRes, teamsRes, scopesRes] = await Promise.all([
                authFetch(`/api/orgs/${currentOrg.id}/scopes`),
                authFetch(`/api/orgs/${currentOrg.id}/my-teams`),
                authFetch(`/api/orgs/${currentOrg.id}/my-scopes`)
            ]);

            if (treeRes.ok) {
                const data = await treeRes.json();
                setScopeTree(data.tree);

                // Set default scope to org root if none selected, OR replace the
                // temporary org-UUID-as-scope-ID placeholder that WorkspaceContext sets
                // when user.org is available before the scope tree has loaded.
                // Scopes use ULID primary keys — passing the org UUID as scopeId to
                // /api/orgs/:orgId/scopes/:scopeId/path returns 404 because the scopes
                // table has no row with id = orgId. Once the tree is fetched we swap in
                // the real scope object so loadScopePath uses the correct ULID.
                // (CLARITY-CONSOLE-2 fix)
                if (data.tree && (!currentScope || currentScope.id === currentOrg?.id)) {
                    setCurrentScope(data.tree);
                }
            }

            if (teamsRes.ok) {
                const data = await teamsRes.json();
                setMyTeams(data.teams || []);
            }

            if (scopesRes.ok) {
                const data = await scopesRes.json();
                setMyScopes(data.scopes || []);
            }

        } catch (err) {
            console.error('Failed to load org details:', err);
        }
    };

    // Load scope path when scope changes.
    // Guard: skip when currentScope.id equals currentOrg.id — this happens
    // transiently before the scope tree loads (WorkspaceContext bootstraps a
    // synthetic scope from user.org using the org UUID as the scope ID, but
    // scopes use ULID PKs so the backend returns 404 for that combination).
    // Once loadOrgDetails resolves and replaces the placeholder with the real
    // scope tree root the effect re-fires with the correct ULID.
    // (CLARITY-CONSOLE-2 fix)
    useEffect(() => {
        if (currentScope?.id && currentOrg?.id && currentScope.id !== currentOrg.id) {
            loadScopePath(currentScope.id);
        } else {
            setScopePath([]);
        }
    }, [currentScope?.id]);

    const loadScopePath = async (scopeId) => {
        if (isDevMode) {
            setScopePath([{ ...(currentScope || DEV_FALLBACK_SCOPE), id: scopeId }]);
            return;
        }
        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/scopes/${scopeId}/path`);
            if (response.ok) {
                const data = await response.json();
                setScopePath(data.path || []);
            }
        } catch (err) {
            console.error('Failed to load scope path:', err);
        }
    };

    const selectOrg = useCallback(async (org) => {
        if (!org?.id) return;

        if (isDevMode) {
            // LL-7 C1: current_org_id MUST be written before setStorageContext()
            // dispatches 'quox-org-switch' — listeners (thirdPartyPluginHost's
            // getActiveOrgId) read it synchronously and would see the OLD org.
            localStorage.setItem('current_org_id', org.id);
            setStorageContext(org.id, user?.id);
            setOrgSyncContext(org.id);
            migrateGlobalToOrgScoped(org.id, user?.id);
            setCurrentOrg(org);
            setCurrentScope({ id: org.id, name: org.name, type: 'organization', org_id: org.id });
            setScopePath([]);
            return;
        }

        // Security fix: Call backend to switch org and update JWT token
        // This ensures the server-side session has the correct org_id
        try {
            const response = await authFetch('/api/auth/switch-org', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ org_id: org.id })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('[Workspace] Failed to switch org on backend:', errorData.message || 'Unknown error');
                // Don't update local state if backend switch failed
                // This prevents a stale JWT mismatch
                throw new Error(errorData.message || 'Failed to switch organization');
            }

            // Backend switch successful - set storage context BEFORE state update
            // LL-7 C1: current_org_id MUST be written before setStorageContext()
            // dispatches 'quox-org-switch' — listeners (thirdPartyPluginHost's
            // getActiveOrgId) read it synchronously and would see the OLD org.
            localStorage.setItem('current_org_id', org.id);
            setStorageContext(org.id, user?.id);
            setOrgSyncContext(org.id);
            migrateGlobalToOrgScoped(org.id, user?.id);

            setCurrentOrg(org);
            setCurrentScope(null);
            setScopePath([]);

            // LL-7 C2: the entitlement cache still holds the PREVIOUS org's
            // grants (fail-open — a non-entitled org would see the previous
            // org's plugins). Clear it (fail-closed) and refetch for the new
            // org, same call shape as AuthContext's login-time fetch.
            clearEntitlements();
            try {
                await fetchEntitlements(fetch);
            } catch (e) {
                console.warn('[Workspace] Entitlements refetch after org switch failed:', e.message);
                // Cache stays cleared (fail-closed). setEntitlements was never
                // reached, so broadcast the change ourselves so subscribers
                // (usePluginLicensed, the plugin host) re-check and lock.
                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                    window.dispatchEvent(new Event('quox-entitlements-changed'));
                }
            }

            console.log('[Workspace] Org switched successfully:', org.name);
        } catch (err) {
            console.error('[Workspace] Org switch error:', err);
            // Re-throw so callers can handle the error
            throw err;
        }
    }, [authFetch, isDevMode, user?.id]);

    // Update an org in the local state (without API call)
    // Useful for updating after logo upload or other local changes
    const updateOrgLocal = useCallback((orgId, updates) => {
        setOrgs(prev => prev.map(o =>
            o.id === orgId ? { ...o, ...updates } : o
        ));
        if (currentOrg?.id === orgId) {
            setCurrentOrg(prev => ({ ...prev, ...updates }));
        }
    }, [currentOrg]);

    const selectScope = useCallback((scope) => {
        setCurrentScope(scope);
    }, []);

    const navigateToScope = useCallback(async (scopeId) => {
        if (!currentOrg?.id) return;

        if (isDevMode) {
            setCurrentScope(prev => ({ ...(prev || DEV_FALLBACK_SCOPE), id: scopeId }));
            return;
        }

        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/scopes/${scopeId}`);
            if (response.ok) {
                const data = await response.json();
                setCurrentScope(data.scope);
            }
        } catch (err) {
            console.error('Failed to navigate to scope:', err);
        }
    }, [currentOrg, authFetch, isDevMode]);

    const refreshOrgData = useCallback(() => {
        loadOrgDetails();
    }, [currentOrg]);

    // Reload org list (used after creating new org)
    const reloadOrgs = useCallback(async () => {
        await loadOrgs();
    }, [authFetch]);

    // Create a new organization
    const createOrg = useCallback(async ({ name, description }) => {
        try {
            const response = await authFetch('/api/orgs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description })
            });

            if (response.ok) {
                const data = await response.json();
                const org = data.organization || data;
                const newOrg = {
                    id: org.id,
                    name: org.name,
                    description: org.description || description || '',
                    slug: org.slug,
                    plan: org.plan || 'free',
                    logo_url: org.logo_url || null,
                    member_count: org.member_count || 1,
                    division_count: org.division_count || 0,
                    team_count: org.team_count || 0,
                    role: org.role || 'viewer',
                    membership: { role: org.role || 'viewer' }
                };

                // Add to orgs list and select it
                setOrgs(prev => [...prev, newOrg]);
                setCurrentOrg(newOrg);
                localStorage.setItem('current_org_id', newOrg.id);

                return newOrg;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to create organization');
            }
        } catch (err) {
            console.error('Failed to create org:', err);
            throw err;
        }
    }, [authFetch]);

    // Delete an organization
    const deleteOrg = useCallback(async (orgId) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                // Remove from orgs list
                setOrgs(prev => prev.filter(o => o.id !== orgId));
                // Clear currentOrg if it was the deleted one
                if (currentOrg?.id === orgId) {
                    setCurrentOrg(null);
                    localStorage.removeItem('current_org_id');
                }
                return true;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete organization');
            }
        } catch (err) {
            console.error('Failed to delete org:', err);
            throw err;
        }
    }, [authFetch, currentOrg]);

    // Update an organization
    const updateOrg = useCallback(async (orgId, updates) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });

            if (response.ok) {
                const data = await response.json();
                // Update in orgs list
                setOrgs(prev => prev.map(o =>
                    o.id === orgId ? { ...o, ...data.organization } : o
                ));
                // Update currentOrg if it's the one being updated
                if (currentOrg?.id === orgId) {
                    setCurrentOrg(prev => ({ ...prev, ...data.organization }));
                }
                return data.organization;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to update organization');
            }
        } catch (err) {
            console.error('Failed to update org:', err);
            throw err;
        }
    }, [authFetch, currentOrg]);

    // Get divisions for an org (with department_count stats)
    const getDivisions = useCallback(async (orgId) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/divisions?includeStats=true`);
            if (response.ok) {
                const data = await response.json();
                return data.divisions || [];
            }
            return [];
        } catch (err) {
            console.error('Failed to get divisions:', err);
            return [];
        }
    }, [authFetch]);

    // Create a division
    const createDivision = useCallback(async (orgId, { name, description, slug }) => {
        try {
            const finalSlug = slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const response = await authFetch(`/api/orgs/${orgId}/divisions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, slug: finalSlug, description })
            });

            if (response.ok) {
                const data = await response.json();
                return data.division;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to create division');
            }
        } catch (err) {
            console.error('Failed to create division:', err);
            throw err;
        }
    }, [authFetch]);

    // Update a division
    const updateDivision = useCallback(async (orgId, divisionId, updates) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/divisions/${divisionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });

            if (response.ok) {
                const data = await response.json();
                return data.division;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to update division');
            }
        } catch (err) {
            console.error('Failed to update division:', err);
            throw err;
        }
    }, [authFetch]);

    // Delete a division
    const deleteDivision = useCallback(async (orgId, divisionId) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/divisions/${divisionId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete division');
            }
            return true;
        } catch (err) {
            console.error('Failed to delete division:', err);
            throw err;
        }
    }, [authFetch]);

    // Get departments (optionally filtered by division)
    const getDepartments = useCallback(async (orgId, divisionId) => {
        try {
            const url = divisionId
                ? `/api/orgs/${orgId}/divisions/${divisionId}/departments?includeStats=true`
                : `/api/orgs/${orgId}/departments?includeStats=true`;
            const response = await authFetch(url);
            if (response.ok) {
                const data = await response.json();
                return data.departments || [];
            }
            return [];
        } catch (err) {
            console.error('Failed to get departments:', err);
            return [];
        }
    }, [authFetch]);

    // Get teams for an org
    const getTeams = useCallback(async (orgId) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/teams?includeStats=true`);
            if (response.ok) {
                const data = await response.json();
                return data.teams || [];
            }
            return [];
        } catch (err) {
            console.error('Failed to get teams:', err);
            return [];
        }
    }, [authFetch]);

    // Create a team
    const createTeam = useCallback(async (orgId, { name, slug, description, attach_scope_id }) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/teams`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, slug, description, attach_scope_id })
            });

            if (response.ok) {
                const data = await response.json();
                return data.team;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to create team');
            }
        } catch (err) {
            console.error('Failed to create team:', err);
            throw err;
        }
    }, [authFetch]);

    // Update a team
    const updateTeam = useCallback(async (orgId, teamId, updates) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/teams/${teamId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });

            if (response.ok) {
                const data = await response.json();
                return data.team;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Failed to update team');
            }
        } catch (err) {
            console.error('Failed to update team:', err);
            throw err;
        }
    }, [authFetch]);

    // Delete a team
    const deleteTeam = useCallback(async (orgId, teamId) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/teams/${teamId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete team');
            }
        } catch (err) {
            console.error('Failed to delete team:', err);
            throw err;
        }
    }, [authFetch]);

    // Add member to team
    const addTeamMember = useCallback(async (orgId, teamId, userId, role = 'member') => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/teams/${teamId}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, role })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to add team member');
            }
        } catch (err) {
            console.error('Failed to add team member:', err);
            throw err;
        }
    }, [authFetch]);

    // Update team member role
    const updateTeamMemberRole = useCallback(async (orgId, teamId, userId, role) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/teams/${teamId}/members/${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to update member role');
            }
        } catch (err) {
            console.error('Failed to update team member role:', err);
            throw err;
        }
    }, [authFetch]);

    // Remove member from team
    const removeTeamMember = useCallback(async (orgId, teamId, userId) => {
        try {
            const response = await authFetch(`/api/orgs/${orgId}/teams/${teamId}/members/${userId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to remove team member');
            }
        } catch (err) {
            console.error('Failed to remove team member:', err);
            throw err;
        }
    }, [authFetch]);

    const value = {
        // Orgs
        orgs,
        currentOrg,
        selectOrg,

        // Scopes
        currentScope,
        scopeTree,
        scopePath,
        myScopes,
        selectScope,
        navigateToScope,

        // Teams
        myTeams,

        // User info from membership
        membership: currentOrg ? orgs.find(o => o.id === currentOrg.id)?.membership : null,

        // Utilities
        loading,
        refreshOrgData,
        reloadOrgs,

        // Org management
        createOrg,
        updateOrg,
        updateOrgLocal,
        deleteOrg,

        // Divisions
        getDivisions,
        createDivision,
        updateDivision,
        deleteDivision,

        // Departments
        getDepartments,

        // Teams
        getTeams,
        createTeam,
        updateTeam,
        deleteTeam,
        addTeamMember,
        updateTeamMemberRole,
        removeTeamMember,

        // Convenience getters
        isOrgOwner: currentOrg?.membership?.role === 'owner',
        isOrgAdmin: ['owner', 'admin'].includes(currentOrg?.membership?.role),
        canManageOrg: ['owner', 'admin'].includes(currentOrg?.membership?.role)
    };

    return (
        <WorkspaceContext.Provider value={value}>
            {children}
        </WorkspaceContext.Provider>
    );
}

export function useWorkspace() {
    const context = useContext(WorkspaceContext);
    if (!context) {
        throw new Error('useWorkspace must be used within a WorkspaceProvider');
    }
    return context;
}

export default WorkspaceContext;
