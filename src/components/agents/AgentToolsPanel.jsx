/**
 * AgentToolsPanel - Tool Assignment Management
 *
 * Panel for managing tool assignments to an agent:
 * - Shows assigned tools with access mode
 * - Tool limit visualization (5 warn, 8 soft, 15 hard)
 * - Assign new tools from org's tool library
 * - Change access mode or revoke assignments
 *
 * Tool Access Modes:
 * - full: Complete access to tool
 * - read_only: Can only read/query, not modify
 * - with_approval: Requires HITL approval for each use
 */

import { useState, useEffect, useCallback } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { TOOL_LIMITS } from '../../contexts/AgentContext';
import './agent-config.css';

// Icons
const ToolIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
);

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
);

// Lightweight inline toast — mirrors the pattern already used in
// AgentToolMatrix.jsx for the same agent/tool assignment domain.
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

// Access mode options
const ACCESS_MODES = [
    { value: 'full', label: 'Full Access', description: 'Complete access to all tool operations' },
    { value: 'read_only', label: 'Read Only', description: 'Can only read/query, not modify' },
    { value: 'with_approval', label: 'With Approval', description: 'Requires human approval for each use' }
];

// Get tool limit status
function getToolLimitStatus(count) {
    if (count >= TOOL_LIMITS.HARD) return 'hard';
    if (count >= TOOL_LIMITS.SOFT) return 'soft';
    if (count >= TOOL_LIMITS.WARN) return 'warn';
    return 'ok';
}

// Get limit message
function getLimitMessage(status) {
    switch (status) {
        case 'hard':
            return 'Hard limit reached - cannot add more tools';
        case 'soft':
            return 'Soft limit reached - consider splitting into multiple agents';
        case 'warn':
            return 'Approaching tool limit';
        default:
            return null;
    }
}

export default function AgentToolsPanel({
    agentId,
    agentName,
    assignments = [],
    toolStatus = null,
    onAssign,
    onUpdateMode,
    onRevoke,
    disabled = false,
    baseTools = undefined,
}) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    const [availableTools, setAvailableTools] = useState([]);
    const [loadingTools, setLoadingTools] = useState(false);
    const [showAvailable, setShowAvailable] = useState(false);
    const [assigningTool, setAssigningTool] = useState(null);
    const [revokingTool, setRevokingTool] = useState(null);
    const [toasts, setToasts] = useState([]);

    const pushToast = useCallback((type, text) => {
        const toast = { type, text };
        setToasts(prev => [...prev, toast]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t !== toast));
        }, 4000);
    }, []);

    const dismissToast = useCallback((idx) => {
        setToasts(prev => prev.filter((_, i) => i !== idx));
    }, []);

    // Calculate current status (base + assigned counts toward limit)
    const baseToolCount = Array.isArray(baseTools) ? baseTools.length : 0;
    const assignedCount = assignments.length;
    const toolCount = baseToolCount + assignedCount;
    const status = toolStatus?.status || getToolLimitStatus(toolCount);
    const limitMessage = getLimitMessage(status);
    const canAddMore = status !== 'hard';
    const fillPercent = Math.min((toolCount / TOOL_LIMITS.HARD) * 100, 100);

    // Load available tools when showing the panel
    const loadAvailableTools = useCallback(async () => {
        if (!currentOrg?.id) return;

        setLoadingTools(true);
        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/tool-library`);
            if (response.ok) {
                const data = await response.json();
                // Filter out already assigned tools
                const assignedToolIds = new Set(assignments.map(a => a.tool_installation_id));
                const available = (data.items || data.installations || []).filter(t => !assignedToolIds.has(t.id));
                setAvailableTools(available);
            }
        } catch (err) {
            console.error('Failed to load available tools:', err);
        } finally {
            setLoadingTools(false);
        }
    }, [currentOrg?.id, authFetch, assignments]);

    useEffect(() => {
        if (showAvailable) {
            loadAvailableTools();
        }
    }, [showAvailable, loadAvailableTools]);

    const handleAssign = async (toolInstallation) => {
        if (!canAddMore) return;

        setAssigningTool(toolInstallation.id);
        try {
            await onAssign(toolInstallation.id, { accessMode: 'full' });
            setShowAvailable(false);
        } catch (err) {
            console.error('Failed to assign tool:', err);
            pushToast('error', 'Failed to assign tool: ' + err.message);
        } finally {
            setAssigningTool(null);
        }
    };

    const handleModeChange = async (assignmentId, newMode) => {
        try {
            await onUpdateMode(assignmentId, { access_mode: newMode });
        } catch (err) {
            console.error('Failed to update access mode:', err);
            pushToast('error', 'Failed to update: ' + err.message);
        }
    };

    const handleRevoke = async (assignmentId) => {
        if (!confirm('Remove this tool from the agent?')) return;

        setRevokingTool(assignmentId);
        try {
            await onRevoke(assignmentId);
        } catch (err) {
            console.error('Failed to revoke tool:', err);
            pushToast('error', 'Failed to remove tool: ' + err.message);
        } finally {
            setRevokingTool(null);
        }
    };

    return (
        <div className="agent-tools-panel">
            {/* Tool limit indicator */}
            <div className={`agent-tools-limit agent-tools-limit--${status}`}>
                <div className="agent-tools-limit__count">
                    <ToolIcon /> {toolCount} / {TOOL_LIMITS.HARD} tools
                </div>
                <div className="agent-tools-limit__bar">
                    <div
                        className="agent-tools-limit__bar-fill"
                        style={{ width: `${fillPercent}%` }}
                    />
                </div>
                {limitMessage && (
                    <span className="agent-tools-limit__message">
                        {limitMessage}
                    </span>
                )}
            </div>

            {/* Base tools (read-only, from registry) */}
            {baseTools && baseTools.length > 0 && (
                <div className="agent-tools-base" style={{ marginBottom: '16px' }}>
                    <h4 style={{
                        margin: '0 0 8px 0',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--ui-text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}>
                        Base Tools
                        <span style={{ marginLeft: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                            ({baseToolCount} built-in)
                        </span>
                    </h4>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {baseTools.map((tool, i) => (
                            <span key={i} style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontSize: '12px',
                                padding: '4px 10px',
                                borderRadius: '6px',
                                background: 'rgba(255, 255, 255, 0.06)',
                                color: 'var(--ui-text-secondary, #999)',
                                border: '1px solid rgba(255, 255, 255, 0.08)',
                            }}>
                                <ToolIcon /> {tool}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Assigned tools list */}
            <div className="agent-tools-list">
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '12px'
                }}>
                    <h4 style={{
                        margin: 0,
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--ui-text-primary)'
                    }}>
                        Assigned Tools
                    </h4>
                    {!disabled && canAddMore && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setShowAvailable(!showAvailable)}
                        >
                            <PlusIcon />
                            <span style={{ marginLeft: '6px' }}>
                                {showAvailable ? 'Cancel' : 'Add Tool'}
                            </span>
                        </Button>
                    )}
                </div>

                {assignments.length === 0 ? (
                    <div className="agent-tools-list__empty">
                        No tools assigned yet. Add tools to enable agent capabilities.
                    </div>
                ) : (
                    assignments.map(assignment => (
                        <div key={assignment.assignment_id} className="agent-tool-card">
                            <div className="agent-tool-card__icon">
                                {assignment.icon || <ToolIcon />}
                            </div>
                            <div className="agent-tool-card__info">
                                <div className="agent-tool-card__name">
                                    {assignment.tool_name}
                                </div>
                                <div className="agent-tool-card__meta">
                                    <span className="agent-tool-card__category">
                                        {assignment.category}
                                    </span>
                                    <span className={`agent-tool-card__mode agent-tool-card__mode--${assignment.access_mode}`}>
                                        {assignment.access_mode?.replace('_', ' ')}
                                    </span>
                                </div>
                            </div>
                            {!disabled && (
                                <div className="agent-tool-card__actions">
                                    <select
                                        value={assignment.access_mode}
                                        onChange={(e) => handleModeChange(assignment.assignment_id, e.target.value)}
                                        style={{
                                            padding: '4px 8px',
                                            background: 'var(--ui-bg-secondary)',
                                            border: '1px solid var(--ui-border)',
                                            borderRadius: '4px',
                                            color: 'var(--ui-text-secondary)',
                                            fontSize: '12px'
                                        }}
                                    >
                                        {ACCESS_MODES.map(mode => (
                                            <option key={mode.value} value={mode.value}>
                                                {mode.label}
                                            </option>
                                        ))}
                                    </select>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => handleRevoke(assignment.assignment_id)}
                                        loading={revokingTool === assignment.assignment_id}
                                        title="Remove tool"
                                    >
                                        <TrashIcon />
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            {/* Available tools to assign */}
            {showAvailable && (
                <div className="agent-tools-available">
                    <h5 className="agent-tools-available__title">
                        Available Tools
                        {loadingTools && ' (loading...)'}
                    </h5>

                    {!loadingTools && availableTools.length === 0 ? (
                        <div style={{
                            padding: '24px',
                            textAlign: 'center',
                            color: 'var(--ui-text-muted)',
                            fontSize: '13px'
                        }}>
                            No additional tools available. Install tools from the catalog first.
                        </div>
                    ) : (
                        <div className="agent-tools-available__grid">
                            {availableTools.map(tool => (
                                <button
                                    key={tool.id}
                                    className="agent-tools-available__item"
                                    onClick={() => handleAssign(tool)}
                                    disabled={assigningTool === tool.id || !canAddMore}
                                >
                                    <span className="agent-tools-available__item-icon">
                                        {tool.icon || <ToolIcon />}
                                    </span>
                                    <span className="agent-tools-available__item-name">
                                        {tool.name}
                                    </span>
                                    <span className="agent-tools-available__item-add">
                                        {assigningTool === tool.id ? '...' : '+'}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <Toast messages={toasts} onDismiss={dismissToast} />
        </div>
    );
}
