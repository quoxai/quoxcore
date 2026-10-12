/**
 * AgentToolMatrix — STUDY-REV-2 / P4.C
 *
 * 2-D assignment matrix: rows = agents, columns = installed tools.
 * Each cell is a checkbox — checked means tool is assigned to that agent.
 *
 * Reads:
 *   GET /api/orgs/:orgId/agents?includeTools=true
 *   GET /api/orgs/:orgId/agents/:agentId/tools         (per-agent assignments)
 *   Installed tools already loaded by parent (scopeInstalled prop)
 *
 * Writes:
 *   POST /api/orgs/:orgId/agents/:agentId/tools/bulk-assign
 *
 * Soft-limit chip: warn threshold = 8 (from TOOL_LIMITS in agents.js).
 * TODO: expose threshold from /api/orgs/:orgId/tool-config to avoid hardcode.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

// Soft-limit warn threshold — matches TOOL_LIMITS.SOFT_LIMIT in agents.js
// TODO: fetch from /api/orgs/:orgId/tool-config when that endpoint is added
const WARN_THRESHOLD = 8;

// ── helper: fetch all agents for org ─────────────────────────────────────────
async function fetchAgents(authFetch, orgId) {
    const resp = await authFetch(`/api/orgs/${orgId}/agents?includeTools=true`);
    if (!resp.ok) throw new Error(`Failed to fetch agents: HTTP ${resp.status}`);
    const data = await resp.json();
    return data.agents || [];
}

// ── helper: fetch assignments for one agent ───────────────────────────────────
async function fetchAgentAssignments(authFetch, orgId, agentDbId) {
    const resp = await authFetch(`/api/orgs/${orgId}/agents/${agentDbId}/tools`);
    if (!resp.ok) return [];
    const data = await resp.json();
    // assignments each have tool_installation_id
    return data.assignments || [];
}

// ── helper: bulk-assign for one agent ────────────────────────────────────────
async function bulkAssign(authFetch, orgId, agentDbId, toolInstallationIds) {
    const resp = await authFetch(`/api/orgs/${orgId}/agents/${agentDbId}/tools/bulk-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_installation_ids: toolInstallationIds }),
    });
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Bulk assign failed: HTTP ${resp.status}`);
    }
    return resp.json();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ messages, onDismiss }) {
    if (!messages.length) return null;
    return (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.map((m, i) => (
                <div
                    key={i}
                    className={`qx-pill ${m.type === 'error' ? 'qx-pill--high' : 'qx-pill--success'}`}
                    style={{ padding: '8px 16px', fontSize: 13, cursor: 'pointer', maxWidth: 360 }}
                    onClick={() => onDismiss(i)}
                >
                    {m.text}
                </div>
            ))}
        </div>
    );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function AgentToolMatrix({ scopeInstalled = [] }) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const orgId = currentOrg?.id;

    // ── data state ────────────────────────────────────────────────────────────
    const [agents, setAgents] = useState([]);
    const [agentsLoading, setAgentsLoading] = useState(true);
    const [agentsError, setAgentsError] = useState(null);

    // assignmentsByAgentDbId: Map<agentDbId, Set<tool_installation_id>>
    const [assignmentsByAgent, setAssignmentsByAgent] = useState(new Map());
    const [assignmentsLoading, setAssignmentsLoading] = useState(false);

    // ── dirty cells: Map<agentDbId, Set<instId>> — the *desired* set after edits ──
    const [dirtyAgents, setDirtyAgents] = useState(new Map());

    // ── save state ────────────────────────────────────────────────────────────
    const [saving, setSaving] = useState(false);
    const [toasts, setToasts] = useState([]);

    // ── load agents ───────────────────────────────────────────────────────────
    useEffect(() => {
        if (!orgId) return;
        setAgentsLoading(true);
        fetchAgents(authFetch, orgId)
            .then(setAgents)
            .catch(err => setAgentsError(err.message))
            .finally(() => setAgentsLoading(false));
    }, [authFetch, orgId]);

    // ── load assignments for all agents ───────────────────────────────────────
    useEffect(() => {
        if (!orgId || agents.length === 0) return;
        setAssignmentsLoading(true);
        Promise.all(
            agents.map(a => fetchAgentAssignments(authFetch, orgId, a.id)
                .then(assignments => [a.id, new Set(assignments.map(x => x.tool_installation_id))])
            )
        ).then(pairs => {
            setAssignmentsByAgent(new Map(pairs));
        }).finally(() => {
            setAssignmentsLoading(false);
        });
    }, [authFetch, orgId, agents]);

    // ── installed tools from scope (passed from ToolsView) ────────────────────
    // Each item: { id (installation_id), tool_id, name, category, ... }
    const tools = useMemo(() => scopeInstalled.map(t => ({
        instId: t.id,
        toolId: t.tool_id,
        name: t.name || t.tool_id,
        category: t.category,
    })), [scopeInstalled]);

    // ── effective assignments: merge DB state with dirty overrides ────────────
    const effectiveAssignments = useMemo(() => {
        const result = new Map();
        for (const [agentDbId, dbSet] of assignmentsByAgent) {
            if (dirtyAgents.has(agentDbId)) {
                result.set(agentDbId, new Set(dirtyAgents.get(agentDbId)));
            } else {
                result.set(agentDbId, new Set(dbSet));
            }
        }
        return result;
    }, [assignmentsByAgent, dirtyAgents]);

    // ── checkbox toggle ───────────────────────────────────────────────────────
    const handleToggle = useCallback((agentDbId, instId) => {
        setDirtyAgents(prev => {
            const next = new Map(prev);
            // Get current effective set for this agent
            const base = effectiveAssignments.get(agentDbId) || new Set();
            const current = next.has(agentDbId) ? new Set(next.get(agentDbId)) : new Set(base);

            if (current.has(instId)) {
                current.delete(instId);
            } else {
                current.add(instId);
            }
            next.set(agentDbId, current);
            return next;
        });
    }, [effectiveAssignments]);

    // ── save ──────────────────────────────────────────────────────────────────
    const handleSave = useCallback(async () => {
        if (!orgId || dirtyAgents.size === 0) return;
        setSaving(true);
        const newToasts = [];

        for (const [agentDbId, instIdSet] of dirtyAgents) {
            const agent = agents.find(a => a.id === agentDbId);
            const agentName = agent?.name || agentDbId;
            try {
                await bulkAssign(authFetch, orgId, agentDbId, [...instIdSet]);
                // Update DB state with the saved set
                setAssignmentsByAgent(prev => {
                    const next = new Map(prev);
                    next.set(agentDbId, new Set(instIdSet));
                    return next;
                });
                newToasts.push({ type: 'success', text: `${agentName}: saved ${instIdSet.size} tool assignment${instIdSet.size !== 1 ? 's' : ''}` });
            } catch (err) {
                newToasts.push({ type: 'error', text: `${agentName}: ${err.message}` });
            }
        }

        // Clear dirty state for successfully saved agents
        setDirtyAgents(new Map());
        setSaving(false);
        setToasts(prev => [...prev, ...newToasts]);

        // Auto-dismiss toasts after 4s
        setTimeout(() => setToasts(prev => prev.filter(t => !newToasts.includes(t))), 4000);
    }, [authFetch, orgId, dirtyAgents, agents]);

    const dismissToast = useCallback((idx) => {
        setToasts(prev => prev.filter((_, i) => i !== idx));
    }, []);

    const isDirty = dirtyAgents.size > 0;

    // ── loading / error states ────────────────────────────────────────────────
    if (agentsLoading || assignmentsLoading) {
        return (
            <div className="qx-card" style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                <div className="qx-empty">
                    <div className="qx-spinner" />
                    <div className="qx-empty__body">Loading assignment matrix...</div>
                </div>
            </div>
        );
    }

    if (agentsError) {
        return (
            <div className="qx-card" style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                <div className="qx-empty">
                    <div className="qx-empty__title">Failed to load agents</div>
                    <div className="qx-empty__body">{agentsError}</div>
                </div>
            </div>
        );
    }

    if (agents.length === 0) {
        return (
            <div className="qx-card" style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                <div className="qx-empty">
                    <div className="qx-empty__title">No agents found</div>
                    <div className="qx-empty__body">Create an agent first, then assign tools to it here.</div>
                </div>
            </div>
        );
    }

    if (tools.length === 0) {
        return (
            <div className="qx-card" style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                <div className="qx-empty">
                    <div className="qx-empty__title">No tools installed</div>
                    <div className="qx-empty__body">Switch to the Installed tab and install tools to this org scope first.</div>
                </div>
            </div>
        );
    }

    return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Toast messages={toasts} onDismiss={dismissToast} />

            {/* Header row */}
            <div className="qx-row qx-row--apart" style={{ flex: '0 0 auto', alignItems: 'center' }}>
                <div>
                    <span className="qx-section-title">Agent × Tool Assignments</span>
                    <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.5 }}>
                        {agents.length} agent{agents.length !== 1 ? 's' : ''} &times; {tools.length} installed tool{tools.length !== 1 ? 's' : ''}
                    </span>
                </div>
                {isDirty && (
                    <span className="qx-pill qx-pill--info qx-pill--sm">Unsaved changes</span>
                )}
            </div>

            {/* Matrix scroll container */}
            <div className="qx-card" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 0 }}>
                <table className="qx-table agent-tool-matrix-table" style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            {/* Sticky agent-name column header */}
                            <th style={{
                                position: 'sticky',
                                left: 0,
                                top: 0,
                                zIndex: 3,
                                minWidth: 180,
                                textAlign: 'left',
                                padding: '10px 16px',
                                background: 'var(--bg-card, #1a1a2e)',
                                borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                                whiteSpace: 'nowrap',
                            }}>
                                Agent
                            </th>
                            {/* Sticky tool-name column headers */}
                            {tools.map(tool => (
                                <th
                                    key={tool.instId}
                                    title={tool.toolId}
                                    style={{
                                        position: 'sticky',
                                        top: 0,
                                        zIndex: 2,
                                        minWidth: 100,
                                        maxWidth: 130,
                                        textAlign: 'center',
                                        padding: '10px 8px',
                                        fontSize: 11,
                                        background: 'var(--bg-card, #1a1a2e)',
                                        borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        cursor: 'default',
                                    }}
                                >
                                    {tool.name}
                                </th>
                            ))}
                            {/* Count column */}
                            <th style={{
                                position: 'sticky',
                                top: 0,
                                zIndex: 2,
                                minWidth: 80,
                                textAlign: 'center',
                                padding: '10px 8px',
                                background: 'var(--bg-card, #1a1a2e)',
                                borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                                whiteSpace: 'nowrap',
                            }}>
                                Total
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {agents.map(agent => {
                            const agentAssigned = effectiveAssignments.get(agent.id) || new Set();
                            const count = agentAssigned.size;
                            const isAgentDirty = dirtyAgents.has(agent.id);
                            return (
                                <tr key={agent.id} className={isAgentDirty ? 'qx-table__row--active' : ''}>
                                    {/* Sticky agent name cell */}
                                    <td style={{
                                        position: 'sticky',
                                        left: 0,
                                        zIndex: 1,
                                        background: 'var(--bg-card, #1a1a2e)',
                                        padding: '8px 16px',
                                        whiteSpace: 'nowrap',
                                        borderRight: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
                                    }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ fontSize: 13, fontWeight: 500 }}>{agent.name}</span>
                                            {isAgentDirty && (
                                                <span className="qx-pill qx-pill--info qx-pill--xs">edited</span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 11, opacity: 0.45, marginTop: 2 }}>{agent.agent_id}</div>
                                    </td>

                                    {/* Checkbox cells */}
                                    {tools.map(tool => {
                                        const checked = agentAssigned.has(tool.instId);
                                        return (
                                            <td key={tool.instId} style={{ textAlign: 'center', padding: '6px 4px' }}>
                                                <label className="qx-checkbox" style={{ justifyContent: 'center', cursor: 'pointer' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() => handleToggle(agent.id, tool.instId)}
                                                        style={{ display: 'none' }}
                                                    />
                                                    <span
                                                        className={`qx-checkbox__box${checked ? ' is-checked' : ''}`}
                                                        style={{
                                                            width: 16,
                                                            height: 16,
                                                            borderRadius: 3,
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            border: '1.5px solid var(--border-subtle, rgba(255,255,255,0.2))',
                                                            background: checked ? 'var(--color-accent, #6366f1)' : 'transparent',
                                                            transition: 'background 0.15s, border-color 0.15s',
                                                            borderColor: checked ? 'var(--color-accent, #6366f1)' : undefined,
                                                        }}
                                                    >
                                                        {checked && (
                                                            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                                                <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                                            </svg>
                                                        )}
                                                    </span>
                                                </label>
                                            </td>
                                        );
                                    })}

                                    {/* Count + limit chip */}
                                    <td style={{ textAlign: 'center', padding: '8px 8px' }}>
                                        <span
                                            className={`qx-pill qx-pill--sm ${count >= WARN_THRESHOLD ? 'qx-pill--medium' : 'qx-pill--ghost'}`}
                                            title={count >= WARN_THRESHOLD ? `Approaching soft limit (${WARN_THRESHOLD})` : `${count} tool${count !== 1 ? 's' : ''} assigned`}
                                        >
                                            {count}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Sticky save footer */}
            {isDirty && (
                <div className="qx-sticky-actions" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
                    <button
                        className="qx-btn qx-btn--primary"
                        onClick={handleSave}
                        disabled={saving}
                    >
                        {saving ? (
                            <>
                                <div className="qx-spinner" style={{ width: 14, height: 14, marginRight: 6 }} />
                                Saving...
                            </>
                        ) : (
                            <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                                    <polyline points="17 21 17 13 7 13 7 21" />
                                    <polyline points="7 3 7 8 15 8" />
                                </svg>
                                Save changes ({dirtyAgents.size} agent{dirtyAgents.size !== 1 ? 's' : ''})
                            </>
                        )}
                    </button>
                    <button
                        className="qx-btn qx-btn--ghost"
                        onClick={() => setDirtyAgents(new Map())}
                        disabled={saving}
                    >
                        Discard
                    </button>
                    <span style={{ fontSize: 12, opacity: 0.5 }}>
                        {[...dirtyAgents.keys()].map(id => agents.find(a => a.id === id)?.name || id).join(', ')} modified
                    </span>
                </div>
            )}
        </div>
    );
}
