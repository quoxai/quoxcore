/**
 * OrgAgentMatrixPanel — ET-6D.
 *
 * Enterprise. Per custom role, admin can set per-agent and per-tool
 * allow/deny rules. Agent rules may additionally be scoped to a
 * specific scope_id (team/dept/etc). Rules are sparse — no rule =
 * default-permissive, most-specific scope wins per role+agent.
 */

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import { fetchCustomRoles } from '../../services/customRolesClient';
import {
    SCOPE_ORG_WIDE,
    fetchAgentPermissions,
    setAgentPermission,
    clearAgentPermission,
    fetchToolPermissions,
    setToolPermission,
    clearToolPermission,
} from '../../services/agentRbacClient';

// Known agents — should eventually pull from agentRegistry. Hardcoded
// list mirrors the flat specialist roster.
const AGENTS = [
    'QUOX', 'WARDEN', 'DAEDALUS', 'CIPHER', 'GEMINI',
    'HYPERION', 'METRICS', 'INSIGHT', 'ORACLE', 'VIGIL',
    'CODEX', 'ARCHIVIST', 'COREY', 'VULCAN',
];

// Known tools — same caveat. Placeholder pending a real tools registry.
const TOOLS = [
    'slack.send', 'github.issue', 'http.fetch', 'secrets.read',
    'files.read', 'files.write', 'shell.exec',
];

const MatrixIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
);

function PermCycle({ rule, onSet, onClear, disabled }) {
    // Tri-state: default (null) → allow → deny → default.
    const state = !rule ? 'default' : (rule.allowed ? 'allow' : 'deny');
    const label = state === 'default' ? 'Default' : state === 'allow' ? 'Allow' : 'Deny';
    const handleClick = () => {
        if (disabled) return;
        if (state === 'default') onSet(true);
        else if (state === 'allow') onSet(false);
        else onClear();
    };
    return (
        <button
            type="button"
            className={`org-matrix-panel__cycle is-${state}`}
            onClick={handleClick}
            disabled={disabled}
            title={disabled ? 'Read-only' : 'Click to cycle: default → allow → deny → default'}
        >
            {label}
        </button>
    );
}

function RoleRow({ orgId, role, isAdmin }) {
    const { authFetch } = useAuth();
    const [expanded, setExpanded] = useState(false);
    const [agentPerms, setAgentPerms] = useState([]);
    const [toolPerms, setToolPerms]   = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [scopeFilter, setScopeFilter] = useState(SCOPE_ORG_WIDE);
    const [newScope, setNewScope] = useState('');

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            setAgentPerms(await fetchAgentPermissions(orgId, role.id, authFetch));
            setToolPerms(await fetchToolPermissions(orgId, role.id, authFetch));
        } catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, [orgId, role.id, authFetch]);

    useEffect(() => {
        if (expanded) load();
    }, [expanded, load]);

    const visibleScope = scopeFilter === SCOPE_ORG_WIDE ? null : scopeFilter;

    const ruleFor = (agentId) => agentPerms.find(p =>
        p.agent_id === agentId && (p.scope_id || null) === visibleScope,
    );
    const toolRule = (toolId) => toolPerms.find(p => p.tool_id === toolId);

    const handleSetAgent = async (agentId, allowed) => {
        setError(null);
        try {
            await setAgentPermission(orgId, role.id, {
                agentId, allowed, scopeId: scopeFilter,
            }, authFetch);
            await load();
        } catch (err) { setError(err.message); }
    };
    const handleClearAgent = async (agentId) => {
        try {
            await clearAgentPermission(orgId, role.id, {
                agentId, scopeId: scopeFilter,
            }, authFetch);
            await load();
        } catch (err) { setError(err.message); }
    };
    const handleSetTool = async (toolId, allowed) => {
        try {
            await setToolPermission(orgId, role.id, { toolId, allowed }, authFetch);
            await load();
        } catch (err) { setError(err.message); }
    };
    const handleClearTool = async (toolId) => {
        try {
            await clearToolPermission(orgId, role.id, toolId, authFetch);
            await load();
        } catch (err) { setError(err.message); }
    };

    // Collect scopes the role already has agent rules in, plus org-wide
    // sentinel, plus anything the admin types.
    const knownScopes = [SCOPE_ORG_WIDE];
    for (const p of agentPerms) {
        if (p.scope_id && !knownScopes.includes(p.scope_id)) knownScopes.push(p.scope_id);
    }

    return (
        <li className={`org-matrix-panel__role${expanded ? ' is-expanded' : ''}`}>
            <div className="org-matrix-panel__role-head" onClick={() => setExpanded(v => !v)}>
                <div className="org-matrix-panel__role-info">
                    <div className="org-matrix-panel__role-name">{role.name}</div>
                    <div className="org-matrix-panel__role-slug">{role.slug}</div>
                </div>
                <div className="org-matrix-panel__role-counts">
                    <span>{agentPerms.length} agent rule{agentPerms.length === 1 ? '' : 's'}</span>
                    <span>{toolPerms.length} tool rule{toolPerms.length === 1 ? '' : 's'}</span>
                </div>
            </div>

            {expanded && (
                <div className="org-matrix-panel__role-body">
                    {error && <div className="org-matrix-panel__error">{error}</div>}
                    {loading ? (
                        <div className="org-matrix-panel__loading">Loading…</div>
                    ) : (
                        <>
                            <div className="org-matrix-panel__section-title">Agents</div>
                            <div className="org-matrix-panel__scope-row">
                                <span className="org-matrix-panel__scope-label">Scope</span>
                                {knownScopes.map(s => (
                                    <button
                                        key={s}
                                        type="button"
                                        className={`org-matrix-panel__scope-pill${scopeFilter === s ? ' is-active' : ''}`}
                                        onClick={() => setScopeFilter(s)}
                                    >
                                        {s === SCOPE_ORG_WIDE ? 'Org-wide' : s}
                                    </button>
                                ))}
                                {isAdmin && (
                                    <form
                                        className="org-matrix-panel__scope-add"
                                        onSubmit={e => { e.preventDefault(); if (newScope) { setScopeFilter(newScope); setNewScope(''); } }}
                                    >
                                        <input
                                            value={newScope}
                                            onChange={e => setNewScope(e.target.value)}
                                            placeholder="+ scope id"
                                        />
                                    </form>
                                )}
                            </div>
                            <div className="org-matrix-panel__grid">
                                {AGENTS.map(a => (
                                    <div key={a} className="org-matrix-panel__cell">
                                        <div className="org-matrix-panel__cell-name">{a}</div>
                                        <PermCycle
                                            rule={ruleFor(a)}
                                            onSet={(allow) => handleSetAgent(a, allow)}
                                            onClear={() => handleClearAgent(a)}
                                            disabled={!isAdmin}
                                        />
                                    </div>
                                ))}
                            </div>

                            <div className="org-matrix-panel__section-title org-matrix-panel__section-title--tools">Tools</div>
                            <div className="org-matrix-panel__grid">
                                {TOOLS.map(t => (
                                    <div key={t} className="org-matrix-panel__cell">
                                        <div className="org-matrix-panel__cell-name">{t}</div>
                                        <PermCycle
                                            rule={toolRule(t)}
                                            onSet={(allow) => handleSetTool(t, allow)}
                                            onClear={() => handleClearTool(t)}
                                            disabled={!isAdmin}
                                        />
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            )}
        </li>
    );
}

export default function OrgAgentMatrixPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [roles, setRoles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try { setRoles(await fetchCustomRoles(orgId, authFetch)); }
        catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, [orgId, authFetch]);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="qx-card org-matrix-panel">
            <div className="org-matrix-panel__head">
                <span className="org-matrix-panel__icon"><MatrixIcon /></span>
                <div className="org-matrix-panel__title-group">
                    <h3 className="org-matrix-panel__title">Agent &amp; Tool Access</h3>
                    <p className="org-matrix-panel__sub">
                        Per custom role: allow or deny agents (scope-aware) and tools. No rule = default allow.
                    </p>
                </div>
            </div>

            {error && <div className="org-matrix-panel__error">{error}</div>}

            {loading ? (
                <div className="org-matrix-panel__loading">Loading…</div>
            ) : roles.length === 0 ? (
                <div className="org-matrix-panel__loading">
                    No custom roles yet. Create one in the Custom Roles panel first.
                </div>
            ) : (
                <ul className="org-matrix-panel__roles">
                    {roles.map(role => (
                        <RoleRow key={role.id} orgId={orgId} role={role} isAdmin={isAdmin} />
                    ))}
                </ul>
            )}
        </div>
    );
}
