/**
 * useScopeData — Consolidated data-fetching hook for any scope level.
 *
 * Normalises org / division / department data into a single shape
 * so ScopeDashboard renders identically at every level.
 *
 * Usage:
 *   const data = useScopeData({ entityType: 'org', entityId: orgId });
 *   const data = useScopeData({ entityType: 'division', entityId: divId });
 *   const data = useScopeData({ entityType: 'department', entityId: deptId });
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { loadUserEntities } from '../services/entityRegistry';
import { resolveScopeAssistantEntity } from '../services/scopeAssistantRouting';

// Scope-level colour mapping
const SCOPE_COLOURS = {
    org:        '#38bdf8',
    division:   '#a78bfa',
    department: '#3b82f6',
    team:       '#22c55e',
};

// Child entity labels per scope level
const CHILD_LABELS = {
    org:        { singular: 'Division',   plural: 'Divisions' },
    division:   { singular: 'Department', plural: 'Departments' },
    department: { singular: 'Team',       plural: 'Teams' },
};

export default function useScopeData({ entityType, entityId }) {
    const navigate = useNavigate();
    const { user, authFetch } = useAuth();
    const {
        orgs, currentOrg, selectOrg,
        getDivisions, createDivision, updateDivision, deleteDivision,
        getTeams, createTeam, updateOrg, deleteOrg,
        scopeTree,
    } = useWorkspace();

    // --- Core entity state ------------------------------------------------
    const [entity, setEntity] = useState(null);
    const [orgId, setOrgId] = useState(null);            // resolved parent org id
    const [parentEntity, setParentEntity] = useState(null); // parent for breadcrumb
    const [loading, setLoading] = useState(true);

    // --- Related data -----------------------------------------------------
    const [children, setChildren] = useState([]);
    const [childrenLoading, setChildrenLoading] = useState(true);
    const [teams, setTeams] = useState([]);
    const [teamsLoading, setTeamsLoading] = useState(true);
    const [members, setMembers] = useState([]);
    const [pendingInvites, setPendingInvites] = useState([]);
    const [membersLoading, setMembersLoading] = useState(true);
    const [localScopeTree, setLocalScopeTree] = useState(null);
    const [entityScopeId, setEntityScopeId] = useState(null);
    const [scopeAssistant, setScopeAssistant] = useState(null);

    // Helper: resolve the scope ID for the current entity from a scope tree
    const resolveScopeId = (tree, refId) => {
        const root = Array.isArray(tree) ? tree[0] : tree;
        if (!root) return null;
        const findScope = (node, targetRefId) => {
            if ((node.ref_id || node.refId) === targetRefId) return node;
            for (const c of (node.children || [])) {
                const found = findScope(c, targetRefId);
                if (found) return found;
            }
            return null;
        };
        return findScope(root, refId)?.id || root?.id || null;
    };

    // --- Editable fields --------------------------------------------------
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [logoUrl, setLogoUrl] = useState('');
    const [logoImgError, setLogoImgError] = useState(false);
    const [hasChanges, setHasChanges] = useState(false);
    const [saving, setSaving] = useState(false);

    // --- Modal states -----------------------------------------------------
    const [showCreateChild, setShowCreateChild] = useState(false);
    const [showCreateTeam, setShowCreateTeam] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [showLogoModal, setShowLogoModal] = useState(false);
    const [creatingChild, setCreatingChild] = useState(false);
    const [creatingTeam, setCreatingTeam] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // --- Derived ----------------------------------------------------------
    const orgRole = (() => {
        if (entityType === 'org') {
            const org = orgs.find(o => o.id === entityId);
            return org?.membership?.role || org?.role;
        }
        if (parentEntity) {
            return parentEntity.membership?.role || parentEntity.role;
        }
        return null;
    })();

    const isAdmin = ['owner', 'admin'].includes(orgRole);
    const accentColour = SCOPE_COLOURS[entityType] || SCOPE_COLOURS.org;
    const childLabel = CHILD_LABELS[entityType] || CHILD_LABELS.org;

    // Count departments in scope tree (for org-level stats)
    const departmentCount = useMemo(() => {
        const tree = localScopeTree || scopeTree;
        if (!tree) return 0;
        const root = Array.isArray(tree) ? tree[0] : tree;
        if (!root) return 0;
        let count = 0;
        const walk = (node) => {
            if ((node.scope_type || node.type) === 'department') count++;
            for (const c of (node.children || [])) walk(c);
        };
        walk(root);
        return count;
    }, [localScopeTree, scopeTree]);

    // --- Scope stats (HUD) --------------------------------------------------
    const [assetCounts, setAssetCounts] = useState({ assistants: 0, workflows: 0, tools: 0, agents: 0, files: 0, actions: 0 });

    // Fetch asset counts (assistants, workflows, tools) when entity loads
    useEffect(() => {
        if (!entity || loading) return;
        const resolvedOrgId = orgId || entity?.org_id;
        if (!resolvedOrgId) return;

        const scopeParam = entityScopeId ? `&scope_id=${entityScopeId}` : '';
        const fetchCount = async (path) => {
            try {
                const res = await authFetch(`/api/orgs/${resolvedOrgId}/${path}?count_only=true${scopeParam}`);
                if (res.ok) {
                    const data = await res.json();
                    return data.count ?? (Array.isArray(data[path]) ? data[path].length : 0);
                }
            } catch { /* endpoint may not exist yet */ }
            return 0;
        };

        Promise.all([
            fetchCount('assistants'),
            fetchCount('workflows'),
            fetchCount('tools'),
        ]).then(([assistants, workflows, tools]) => {
            setAssetCounts(prev => ({ ...prev, assistants, workflows, tools }));
        });
    }, [entity, loading, orgId, entityScopeId]);

    useEffect(() => {
        const resolvedOrgId = orgId || entity?.org_id || (entityType === 'org' ? entityId : null);
        if (!resolvedOrgId || !entityScopeId || !authFetch) {
            setScopeAssistant(null);
            return;
        }

        let cancelled = false;

        loadUserEntities(resolvedOrgId, authFetch)
            .then((assistants) => {
                if (cancelled) return;
                setScopeAssistant(resolveScopeAssistantEntity(assistants, entityScopeId));
            })
            .catch(() => {
                if (!cancelled) setScopeAssistant(null);
            });

        return () => {
            cancelled = true;
        };
    }, [orgId, entity?.org_id, entityId, entityType, entityScopeId, authFetch]);

    // Aggregated stats for the HUD
    const scopeStats = useMemo(() => {
        const stats = {
            members: members.length,
            teams: teams.length,
            assistants: assetCounts.assistants,
            agents: assetCounts.agents,
            workflows: assetCounts.workflows,
            files: assetCounts.files,
            actions: assetCounts.actions,
            tools: assetCounts.tools,
        };
        if (entityType === 'org') {
            stats.divisions = children.length;
            stats.departments = departmentCount;
        } else if (entityType === 'division') {
            stats.departments = children.length;
        }
        return stats;
    }, [entityType, members.length, teams.length, children.length, departmentCount, assetCounts]);

    // ======================================================================
    //  SCOPE TREE REFRESH HELPER
    // ======================================================================

    // Re-fetches the scope tree for an org. Called on initial load and after
    // create/delete of divisions/departments/teams so the hierarchy stays fresh.
    const refreshScopeTreeForOrg = async (oId) => {
        if (!oId) return;
        try {
            const res = await authFetch(`/api/orgs/${oId}/scopes`);
            if (res.ok) {
                const data = await res.json();
                const tree = data.tree || data.scopes || null;
                setLocalScopeTree(tree);
                if (tree) setEntityScopeId(resolveScopeId(tree, entityId));
            }
        } catch {}
    };

    // ======================================================================
    //  LOAD ENTITY
    // ======================================================================

    useEffect(() => {
        if (!entityId || orgs.length === 0) return;

        const load = async () => {
            setLoading(true);
            setChildrenLoading(true);
            setTeamsLoading(true);
            setMembersLoading(true);

            try {
                if (entityType === 'org') {
                    await loadOrg();
                } else if (entityType === 'division') {
                    await loadDivision();
                } else if (entityType === 'department') {
                    await loadDepartment();
                }
            } catch (err) {
                console.error(`[useScopeData] Failed to load ${entityType}:`, err);
            }

            setLoading(false);
        };

        load();
    }, [entityId, entityType, orgs.length]);

    // --- Org loader -------------------------------------------------------
    const loadOrg = async () => {
        const found = orgs.find(o => o.id === entityId);
        if (!found) { setLoading(false); return; }

        setEntity(found);
        setOrgId(found.id);
        setName(found.name || '');
        setDescription(found.description || '');
        setLogoUrl(found.logo_url || '');
        setLogoImgError(false);
        setParentEntity(null);

        // Set as current org
        if (currentOrg?.id !== found.id) {
            try { await selectOrg(found); } catch {}
        }

        // Load scope tree
        await refreshScopeTreeForOrg(found.id);

        // Load children (divisions), teams, members in parallel
        await Promise.all([
            loadOrgChildren(found.id),
            loadTeams(found.id),
            loadMembers(found.id),
        ]);
    };

    const loadOrgChildren = async (oId) => {
        try {
            const divs = getDivisions ? await getDivisions(oId) : [];
            setChildren(divs || []);
        } catch { setChildren([]); }
        setChildrenLoading(false);
    };

    // --- Division loader --------------------------------------------------
    const loadDivision = async () => {
        let found = null;
        let parent = null;

        for (const org of orgs) {
            try {
                const divs = getDivisions ? await getDivisions(org.id) : [];
                const div = divs?.find(d => d.id === entityId);
                if (div) {
                    found = { ...div, org_id: org.id, org_name: org.name };
                    parent = org;
                    break;
                }
            } catch {}
        }

        if (!found || !parent) { setLoading(false); setChildrenLoading(false); setTeamsLoading(false); setMembersLoading(false); return; }

        setEntity(found);
        setOrgId(parent.id);
        setParentEntity(parent);
        setName(found.name || '');
        setDescription(found.description || '');
        setLogoUrl('');

        if (currentOrg?.id !== parent.id) {
            try { await selectOrg(parent); } catch {}
        }

        // Load scope tree
        await refreshScopeTreeForOrg(parent.id);

        // Load departments (children), teams, members
        await Promise.all([
            loadDivisionDepartments(parent.id, entityId),
            loadDivisionTeams(parent.id, found),
            loadMembers(parent.id),
        ]);
    };

    const loadDivisionDepartments = async (oId, divId) => {
        try {
            const res = await authFetch(`/api/orgs/${oId}/divisions/${divId}/departments?includeStats=true`);
            if (res.ok) {
                const data = await res.json();
                setChildren(data.departments || []);
            } else { setChildren([]); }
        } catch { setChildren([]); }
        setChildrenLoading(false);
    };

    // Shared: load teams scoped to a specific entity's scope_id
    const loadScopedTeams = async (oId, entity) => {
        try {
            const scopeId = entity.scope?.id;
            if (scopeId) {
                const res = await authFetch(`/api/orgs/${oId}/teams?scope_id=${scopeId}&includeStats=true`);
                if (res.ok) {
                    const data = await res.json();
                    setTeams(data.teams || []);
                } else {
                    setTeams([]);
                }
            } else {
                setTeams([]);
            }
        } catch { setTeams([]); }
        setTeamsLoading(false);
    };

    const loadDivisionTeams = (oId, div) => loadScopedTeams(oId, div);

    // --- Department loader ------------------------------------------------
    const loadDepartment = async () => {
        // Search across all orgs → divisions → departments
        let found = null;
        let parent = null;  // parent division
        let grandparent = null;  // parent org

        for (const org of orgs) {
            try {
                const divs = getDivisions ? await getDivisions(org.id) : [];
                for (const div of (divs || [])) {
                    const res = await authFetch(
                        `/api/orgs/${org.id}/divisions/${div.id}/departments?includeStats=true`
                    );
                    if (res.ok) {
                        const data = await res.json();
                        const dept = (data.departments || []).find(d => d.id === entityId);
                        if (dept) {
                            found = { ...dept, org_id: org.id, org_name: org.name, division_id: div.id, division_name: div.name };
                            parent = { ...div, org_id: org.id, org_name: org.name };
                            grandparent = org;
                            break;
                        }
                    }
                }
                if (found) break;
            } catch {}
        }

        if (!found || !grandparent) { setLoading(false); setChildrenLoading(false); setTeamsLoading(false); setMembersLoading(false); return; }

        setEntity(found);
        setOrgId(grandparent.id);
        setParentEntity(parent);
        setName(found.name || '');
        setDescription(found.description || '');
        setLogoUrl('');

        if (currentOrg?.id !== grandparent.id) {
            try { await selectOrg(grandparent); } catch {}
        }

        // Load scope tree
        await refreshScopeTreeForOrg(grandparent.id);

        // Children = teams in this department, no sub-children
        // Teams filtered by department scope
        setChildren([]);
        setChildrenLoading(false);

        await Promise.all([
            loadDepartmentTeams(grandparent.id, found),
            loadMembers(grandparent.id),
        ]);
    };

    const loadDepartmentTeams = (oId, dept) => loadScopedTeams(oId, dept);

    // --- Members loader (shared) ------------------------------------------
    const loadMembers = async (oId) => {
        try {
            const res = await authFetch(`/api/orgs/${oId}/members`);
            if (res.ok) {
                const data = await res.json();
                const raw = data?.members || data?.data || (Array.isArray(data) ? data : []);
                setMembers((Array.isArray(raw) ? raw : []).map(m => ({
                    id: m.user_id || m.id,
                    name: m.display_name || m.user_name || m.name || 'Unknown',
                    email: m.primary_email || m.user_email || m.email || '',
                    role: m.role || 'member',
                    avatar_url: m.avatar_url || null,
                    // ET-FINISH Phase 2: keep the custom-role overlay so the
                    // members grid can badge the card and the assign dialog
                    // can pre-select the current value.
                    custom_role_id: m.custom_role_id || null,
                    custom_role_name: m.custom_role_name || null,
                })));
                // Parse pending invites if returned
                const rawInvites = data?.invites || [];
                setPendingInvites((Array.isArray(rawInvites) ? rawInvites : []).map(inv => ({
                    id: inv.id || inv.email,
                    email: inv.email || '',
                    role: inv.role || 'member',
                    invited_at: inv.invited_at || inv.created_at || null,
                    invited_by: inv.invited_by || null,
                })));
            } else {
                setMembers([]);
                setPendingInvites([]);
            }
        } catch {
            setMembers([]);
            setPendingInvites([]);
        }
        setMembersLoading(false);
    };

    // --- Load teams (shared — org level, all teams) -------------------------
    const loadTeams = async (oId) => {
        try {
            const res = await authFetch(`/api/orgs/${oId}/teams?includeStats=true`);
            if (res.ok) {
                const data = await res.json();
                setTeams(data.teams || []);
            } else {
                const list = getTeams ? await getTeams(oId) : [];
                setTeams(list || []);
            }
        } catch { setTeams([]); }
        setTeamsLoading(false);
    };

    // ======================================================================
    //  DERIVED: Team hierarchy
    // ======================================================================

    // Build a tree from flat teams using parent_team_id
    const { teamTree, scopeTeam } = useMemo(() => {
        if (!teams || teams.length === 0) return { teamTree: [], scopeTeam: null };

        // Find the auto-created team for this scope
        const scopeId = entity?.scope?.id;
        const currentScopeTeam = scopeId
            ? teams.find(t => t.attach_scope_id === scopeId)
            : null;

        // Build tree from flat list
        const byId = new Map();
        const roots = [];

        for (const t of teams) {
            byId.set(t.id, { ...t, children: [] });
        }

        for (const node of byId.values()) {
            if (node.parent_team_id && byId.has(node.parent_team_id)) {
                byId.get(node.parent_team_id).children.push(node);
            } else {
                roots.push(node);
            }
        }

        return { teamTree: roots, scopeTeam: currentScopeTeam || null };
    }, [teams, entity?.scope?.id]);

    // ======================================================================
    //  TRACK CHANGES
    // ======================================================================

    useEffect(() => {
        if (!entity) return;
        const changed = entityType === 'org'
            ? (name !== (entity.name || '') || description !== (entity.description || '') || logoUrl !== (entity.logo_url || ''))
            : (name !== (entity.name || '') || description !== (entity.description || ''));
        setHasChanges(changed);
    }, [name, description, logoUrl, entity]);

    // ======================================================================
    //  MUTATIONS
    // ======================================================================

    const handleSave = useCallback(async () => {
        if (!entity) return;
        setSaving(true);
        try {
            if (entityType === 'org') {
                const updated = await updateOrg(entityId, { name, description, logo_url: logoUrl || null });
                setEntity(prev => ({ ...prev, ...updated }));
            } else if (entityType === 'division') {
                const updated = await updateDivision(entity.org_id, entityId, { name, description });
                setEntity(prev => ({ ...prev, ...updated, name, description }));
            } else if (entityType === 'department') {
                // No dedicated updateDepartment in context yet — use authFetch
                const res = await authFetch(`/api/orgs/${entity.org_id}/divisions/${entity.division_id}/departments/${entityId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description }),
                });
                if (res.ok) {
                    const data = await res.json();
                    setEntity(prev => ({ ...prev, ...data.department, name, description }));
                }
            }
            setHasChanges(false);
        } catch (err) {
            console.error('Save failed:', err);
            alert('Failed to save changes: ' + err.message);
        } finally {
            setSaving(false);
        }
    }, [entity, entityType, entityId, name, description, logoUrl]);

    const handleDelete = useCallback(async () => {
        if (!entity) return;
        setDeleting(true);
        try {
            if (entityType === 'org') {
                await deleteOrg(entityId);
                navigate('/orgs');
            } else if (entityType === 'division') {
                await deleteDivision(entity.org_id, entityId);
                navigate('/divisions');
            } else if (entityType === 'department') {
                await authFetch(`/api/orgs/${entity.org_id}/divisions/${entity.division_id}/departments/${entityId}`, { method: 'DELETE' });
                navigate(`/divisions/${entity.division_id}`);
            }
        } catch (err) {
            console.error('Delete failed:', err);
            alert('Failed to delete: ' + err.message);
            setShowDeleteConfirm(false);
        } finally {
            setDeleting(false);
        }
    }, [entity, entityType, entityId]);

    const handleCreateChild = useCallback(async (data) => {
        if (!entity) return;
        setCreatingChild(true);
        try {
            if (entityType === 'org') {
                const newDiv = await createDivision(entityId, data);
                setChildren(prev => [...prev, newDiv]);
                await refreshScopeTreeForOrg(entityId);
            } else if (entityType === 'division') {
                // Create department — server requires { name, slug }, modal only sends { name, description }
                const slug = (data.slug || data.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const res = await authFetch(`/api/orgs/${entity.org_id}/divisions/${entityId}/departments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...data, slug }),
                });
                if (res.ok) {
                    const d = await res.json();
                    setChildren(prev => [...prev, d.department || d]);
                    await refreshScopeTreeForOrg(entity.org_id);
                } else {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || err.message || `Failed to create department (${res.status})`);
                }
            }
            setShowCreateChild(false);
        } catch (err) {
            console.error('Create child failed:', err);
            alert('Failed to create: ' + err.message);
        } finally {
            setCreatingChild(false);
        }
    }, [entity, entityType, entityId]);

    const handleCreateTeam = useCallback(async (data) => {
        setCreatingTeam(true);
        try {
            const resolvedOrgId = orgId || entity?.org_id;
            if (createTeam && resolvedOrgId) {
                const slug = data.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const scopeId = entity?.scope?.id;
                const newTeam = await createTeam(resolvedOrgId, { ...data, slug, attach_scope_id: scopeId });
                setTeams(prev => [...prev, newTeam]);
                await refreshScopeTreeForOrg(resolvedOrgId);
                setShowCreateTeam(false);
            }
        } catch (err) {
            console.error('Create team failed:', err);
            alert('Failed to create team: ' + err.message);
        } finally {
            setCreatingTeam(false);
        }
    }, [entity, orgId, createTeam]);

    const handleRemoveLogo = useCallback(async () => {
        if (!logoUrl) return;
        try {
            const res = await authFetch(`/api/uploads/org/${entityId}/logo`, { method: 'DELETE' });
            if (res.ok) {
                setLogoUrl('');
                setEntity(prev => ({ ...prev, logo_url: null }));
            }
        } catch (err) {
            alert('Failed to remove logo: ' + err.message);
        }
    }, [entityId, logoUrl]);

    const handleRoleChange = useCallback(async (memberId, newRole) => {
        const resolvedOrgId = orgId || entity?.org_id;
        try {
            const res = await authFetch(`/api/orgs/${resolvedOrgId}/members/${memberId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: newRole }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Failed to update role');
            }
            setMembers(prev => prev.map(m =>
                (m.id === memberId || m.user_id === memberId) ? { ...m, role: newRole } : m
            ));
        } catch (err) {
            alert('Failed to update role: ' + err.message);
        }
    }, [orgId, entity]);

    const handleRemoveMember = useCallback(async (memberId) => {
        const resolvedOrgId = orgId || entity?.org_id;
        try {
            const res = await authFetch(`/api/orgs/${resolvedOrgId}/members/${memberId}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Failed to remove member');
            }
            setMembers(prev => prev.filter(m => m.id !== memberId && m.user_id !== memberId));
        } catch (err) {
            alert('Failed to remove member: ' + err.message);
        }
    }, [orgId, entity]);


    const handleNavigateToParent = useCallback(() => {
        if (entityType === 'division' && entity?.org_id) {
            navigate(`/orgs/${entity.org_id}`);
        } else if (entityType === 'department' && entity?.division_id) {
            navigate(`/divisions/${entity.division_id}`);
        } else if (entityType === 'department') {
            // Fallback: division_id missing, go to divisions list
            navigate('/divisions');
        }
    }, [entityType, entity, navigate]);

    // ======================================================================
    //  RETURN
    // ======================================================================

    return {
        // Entity
        entity,
        entityType,
        entityId,
        orgId,
        parentEntity,
        loading,

        // Scope
        accentColour,
        childLabel,
        scopeTree: localScopeTree || scopeTree,
        entityScopeId,
        scopeAssistant,
        departmentCount,
        scopeStats,

        // Related data
        children,
        childrenLoading,
        teams,
        teamTree,
        scopeTeam,
        teamsLoading,
        members,
        pendingInvites,
        membersLoading,
        // ET-FINISH Phase 2: callers (e.g. CustomRoleAssignDialog) need to
        // refresh members after an overlay change without a full page reload.
        reloadMembers: () => orgId && loadMembers(orgId),

        // Editable fields
        name, setName,
        description, setDescription,
        logoUrl, setLogoUrl,
        logoImgError, setLogoImgError,
        hasChanges,
        saving,
        isAdmin,
        user,

        // Modal states
        showCreateChild, setShowCreateChild,
        showCreateTeam, setShowCreateTeam,
        showDeleteConfirm, setShowDeleteConfirm,
        showInviteModal, setShowInviteModal,
        showLogoModal, setShowLogoModal,
        creatingChild,
        creatingTeam,
        deleting,

        // Mutations
        handleSave,
        handleDelete,
        handleCreateChild,
        handleCreateTeam,
        handleRemoveLogo,
        handleRoleChange,
        handleRemoveMember,
        handleNavigateToParent,
    };
}
