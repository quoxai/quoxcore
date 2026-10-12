/**
 * OrgRolesPanel — ET-4 Phase D.
 *
 * Lists custom roles and (when admin) supports create/delete. A single
 * expanded-row lets the admin grant/revoke individual capabilities for
 * that role. Only renders on Enterprise plan; callers are expected to
 * gate on plan before mounting this, but we also soft-degrade on 402.
 */

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    fetchCustomRoles,
    fetchCustomRole,
    createCustomRole,
    deleteCustomRole,
    grantRoleCapability,
    revokeRoleCapability,
    isValidRoleSlug,
    groupCapabilitiesByResource,
} from '../../services/customRolesClient';

const BUILT_IN_CAPS = [
    { key: 'org.manage_members',     label: 'Manage members' },
    { key: 'org.manage_roles',       label: 'Manage roles' },
    { key: 'org.manage_sso',         label: 'Manage SSO' },
    { key: 'org.manage_billing',     label: 'Manage billing' },
    { key: 'org.manage_settings',    label: 'Manage settings' },
    { key: 'org.manage_divisions',   label: 'Manage divisions' },
    { key: 'org.manage_departments', label: 'Manage departments' },
    { key: 'team.manage',            label: 'Manage teams' },
    { key: 'agent.execute',          label: 'Execute agents' },
    { key: 'audit.read',             label: 'Read audit log' },
];

const ShieldIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
    </svg>
);

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

export default function OrgRolesPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [roles, setRoles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(null);       // roleId
    const [roleCaps, setRoleCaps] = useState({});         // { roleId → Set<cap> }
    const [showCreate, setShowCreate] = useState(false);
    const [newSlug, setNewSlug] = useState('');
    const [newName, setNewName] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [creating, setCreating] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await fetchCustomRoles(orgId, authFetch);
            setRoles(list);
        } catch (err) {
            setError(err.message || String(err));
        } finally {
            setLoading(false);
        }
    }, [orgId, authFetch]);

    useEffect(() => { load(); }, [load]);

    const loadCaps = useCallback(async (roleId) => {
        const data = await fetchCustomRole(orgId, roleId, authFetch);
        const set = new Set((data?.capabilities || []).map(c => c.capability));
        setRoleCaps(prev => ({ ...prev, [roleId]: set }));
    }, [orgId, authFetch]);

    const handleExpand = (roleId) => {
        if (expanded === roleId) {
            setExpanded(null);
            return;
        }
        setExpanded(roleId);
        if (!roleCaps[roleId]) loadCaps(roleId);
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!isValidRoleSlug(newSlug)) {
            setError('Slug must be lowercase letters, digits, _ or -');
            return;
        }
        if (!newName.trim()) {
            setError('Name is required');
            return;
        }
        setCreating(true);
        setError(null);
        try {
            await createCustomRole(orgId, {
                slug:        newSlug,
                name:        newName.trim(),
                description: newDesc.trim() || null,
            }, authFetch);
            setNewSlug(''); setNewName(''); setNewDesc('');
            setShowCreate(false);
            await load();
        } catch (err) {
            setError(err.message || String(err));
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (roleId) => {
        if (!window.confirm('Delete this custom role? Members with this role will lose its extra capabilities.')) return;
        setError(null);
        try {
            await deleteCustomRole(orgId, roleId, authFetch);
            await load();
        } catch (err) {
            setError(err.message || String(err));
        }
    };

    const handleToggleCap = async (roleId, capability) => {
        const current = roleCaps[roleId] || new Set();
        const has = current.has(capability);
        try {
            if (has) {
                await revokeRoleCapability(orgId, roleId, { capability }, authFetch);
            } else {
                await grantRoleCapability(orgId, roleId, { capability }, authFetch);
            }
            await loadCaps(roleId);
        } catch (err) {
            setError(err.message || String(err));
        }
    };

    return (
        <div className="qx-card org-roles-panel">
            <div className="org-roles-panel__head">
                <div className="org-roles-panel__title-group">
                    <span className="org-roles-panel__icon"><ShieldIcon /></span>
                    <div>
                        <h3 className="org-roles-panel__title">Custom Roles</h3>
                        <p className="org-roles-panel__sub">Extend built-in RBAC with org-specific capability bundles.</p>
                    </div>
                </div>
                {isAdmin && (
                    <Button size="sm" variant="primary" onClick={() => setShowCreate(v => !v)}>
                        <PlusIcon />
                        <span>New Role</span>
                    </Button>
                )}
            </div>

            {error && <div className="org-roles-panel__error">{error}</div>}

            {showCreate && isAdmin && (
                <form className="org-roles-panel__create" onSubmit={handleCreate}>
                    <div className="org-roles-panel__field">
                        <label>Slug</label>
                        <input value={newSlug} onChange={e => setNewSlug(e.target.value)}
                            placeholder="division-lead" autoFocus />
                    </div>
                    <div className="org-roles-panel__field">
                        <label>Name</label>
                        <input value={newName} onChange={e => setNewName(e.target.value)}
                            placeholder="Division Lead" />
                    </div>
                    <div className="org-roles-panel__field org-roles-panel__field--wide">
                        <label>Description</label>
                        <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
                            placeholder="Optional" />
                    </div>
                    <div className="org-roles-panel__create-actions">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
                        <Button type="submit" size="sm" variant="primary" loading={creating}>Create</Button>
                    </div>
                </form>
            )}

            {loading ? (
                <div className="org-roles-panel__empty">Loading…</div>
            ) : roles.length === 0 ? (
                <div className="org-roles-panel__empty">
                    No custom roles yet. {isAdmin && 'Create one to grant members capabilities beyond the built-in roles.'}
                </div>
            ) : (
                <ul className="org-roles-panel__list">
                    {roles.map(role => (
                        <li key={role.id} className={`org-roles-panel__row${expanded === role.id ? ' is-expanded' : ''}`}>
                            <div className="org-roles-panel__row-head" onClick={() => handleExpand(role.id)}>
                                <div className="org-roles-panel__row-info">
                                    <div className="org-roles-panel__row-name">{role.name}</div>
                                    <div className="org-roles-panel__row-slug">{role.slug}</div>
                                </div>
                                {role.description && (
                                    <div className="org-roles-panel__row-desc">{role.description}</div>
                                )}
                                {isAdmin && (
                                    <button
                                        type="button"
                                        className="org-roles-panel__row-del"
                                        onClick={(e) => { e.stopPropagation(); handleDelete(role.id); }}
                                        aria-label={`Delete ${role.name}`}
                                    >
                                        <TrashIcon />
                                    </button>
                                )}
                            </div>
                            {expanded === role.id && (
                                <div className="org-roles-panel__caps">
                                    {Object.entries(
                                        groupCapabilitiesByResource(BUILT_IN_CAPS.map(c => ({ capability: c.key }))),
                                    ).map(([group, caps]) => (
                                        <div key={group} className="org-roles-panel__cap-group">
                                            <div className="org-roles-panel__cap-group-label">{group}</div>
                                            <div className="org-roles-panel__cap-grid">
                                                {caps.map(c => {
                                                    const meta = BUILT_IN_CAPS.find(b => b.key === c.capability);
                                                    const granted = roleCaps[role.id]?.has(c.capability);
                                                    return (
                                                        <label key={c.capability} className={`org-roles-panel__cap${granted ? ' is-granted' : ''}`}>
                                                            <input
                                                                type="checkbox"
                                                                checked={!!granted}
                                                                disabled={!isAdmin}
                                                                onChange={() => handleToggleCap(role.id, c.capability)}
                                                            />
                                                            <span>{meta?.label || c.capability}</span>
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
