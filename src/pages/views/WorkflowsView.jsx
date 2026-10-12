/**
 * WorkflowsView - Workflow Management
 *
 * Full-featured workflow management with:
 * - Card grid with scope badges, descriptions, relative timestamps
 * - Search, sort, scope/status filter tabs with active filter pills
 * - Full-page workflow detail view at /workflows/:id with WireMap diagram + sidebar
 * - Running now indicators with live elapsed time
 * - Execution history (collapsible)
 * - Audit tab
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext, useNavigate, useParams } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import EvolutionStagePill from '../../components/automation/EvolutionStagePill';
import { useHubActions } from './WorkflowsHubView';
import { PageSection } from '../../components/layout';
import { WireMap, WorkflowMiniMap, WorkflowEditModal, N8nImportDialog } from '../../components/workflow';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
// AEE-FULL Gap 4 — listing-surface cancel (simpler Yes/No modal per SD-10)
import { cancelExecution, CANCEL_RESULT_CODES } from '../../services/executionCancelService.js';
import {
    listWorkflows,
    listExecutions,
    executeWorkflow,
    activateWorkflow,
    deactivateWorkflow,
    deleteWorkflow,
    updateWorkflow,
    createWorkflow,
    summarizeWorkflow,
    getWorkflow as getEngineWorkflow
} from '../../services/workflowEngine';
import { listExecutions as listQFExecutions } from '../../services/quoxflowClient';
import { storeEnvelopes } from '../../lib/aee/store';
import { evaluateBudgetForExecution } from '../../lib/budgetGuard';
import HardStopDialog from '../../components/HardStopDialog';
import { AuditPanel } from '../../components/audit/AuditPanel';
import { ScopeBadge, ScopeFilterCascade } from '../../components/scope';
import { CORE_WORKFLOWS, isCoreWorkflow, getCoreMetadata, CATEGORY_COLORS, isOrgWorkflow, getOrgWorkflowMeta } from '../../config/coreWorkflows';
import './views.css';
import './workflows-view.css';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'

// Status badge colors
const STATUS_COLORS = {
    active: 'var(--color-success)',
    inactive: 'var(--color-muted)',
    running: 'var(--color-warning)',
    error: 'var(--color-danger)',
    success: 'var(--color-success)',
    waiting: 'var(--color-info)'
};

// Scope badge colors (keyed by backend scope_type: 'org', 'division', 'department', 'team')
const SCOPE_COLORS = {
    core: 'var(--hal-red)',
    org: 'var(--color-info)',
    division: 'var(--color-success)',
    department: 'var(--color-warning)',
    team: 'var(--text-secondary)',
    // Legacy alias
    organization: 'var(--color-info)'
};

// Extract org/division/team name from tags or naming conventions
function getOrgContext(workflow) {
    const tags = workflow.tags || [];
    for (const tag of tags) {
        const t = typeof tag === 'string' ? tag : tag?.name || '';
        if (t.startsWith('org:')) return { type: 'Organization', name: t.replace('org:', '') };
        if (t.startsWith('div:')) return { type: 'Division', name: t.replace('div:', '') };
        if (t.startsWith('team:')) return { type: 'Team', name: t.replace('team:', '') };
    }
    const name = workflow.name || '';
    const orgMatch = name.match(/\[org:([^\]]+)\]/);
    if (orgMatch) return { type: 'Organization', name: orgMatch[1] };
    const divMatch = name.match(/\[div:([^\]]+)\]/);
    if (divMatch) return { type: 'Division', name: divMatch[1] };
    return null;
}

// Format relative time (e.g., "2m ago", "3h ago")
function formatRelativeTime(dateStr) {
    if (!dateStr) return null;
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 0) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}

// Extract trigger info from engine workflow nodes
function extractTrigger(engineWf) {
    if (!engineWf?.nodes?.length) return null;
    const triggerNode = engineWf.nodes.find(n =>
        (n.type || '').toLowerCase().includes('trigger') ||
        (n.type || '').toLowerCase().includes('webhook') ||
        (n.type || '').toLowerCase().includes('cron') ||
        (n.type || '').toLowerCase().includes('schedule')
    );
    if (!triggerNode) return null;
    return { type: triggerNode.type };
}

// Determine workflow scope — uses explicit metadata/tags only, never keyword heuristics.
// Scope is primarily set during data loading from backend (scope_name field).
// This function is a fallback for engine-only workflows without backend data.
function getWorkflowScope(workflow) {
    // Already set by loadWorkflows from backend data
    if (workflow.scope && workflow.scope !== 'unknown') {
        return workflow.scope;
    }

    const tags = workflow.tags || [];
    const meta = workflow.metadata || {};

    // Check explicit metadata.scope
    if (meta.scope && ['core', 'org', 'division', 'department', 'team'].includes(meta.scope)) {
        return meta.scope;
    }

    // Check explicit tags only — no keyword guessing
    if (tags.includes('core') || (workflow.name || '').includes('[core]')) {
        return 'core';
    }
    if (tags.some(t => t.startsWith('org:'))) return 'org';
    if (tags.some(t => t.startsWith('div:'))) return 'division';
    if (tags.some(t => t.startsWith('dept:'))) return 'department';
    if (tags.some(t => t.startsWith('team:'))) return 'team';

    // Default: user-created workflows belong to their organization
    return 'org';
}

// ===========================================================================
// WorkflowCard — single-column row for list view
// ===========================================================================
function WorkflowCard({ workflow, orgName, orgLogoUrl, allScopes, onRun, onToggle, onNavigate, onDelete, onEdit, onDuplicate, viewMode }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const isActive = workflow.active;
    const lastExecution = workflow.lastExecution;
    const scope = workflow.scope || getWorkflowScope(workflow);
    const lastRunTime = formatRelativeTime(lastExecution?.startedAt || lastExecution?.stoppedAt);
    const triggerLabel = workflow.trigger?.type
        ? workflow.trigger.type.replace('trigger:', '')
        : null;

    // Close menu on outside click
    useEffect(() => {
        if (!menuOpen) return;
        const handler = () => setMenuOpen(false);
        document.addEventListener('click', handler);
        return () => document.removeEventListener('click', handler);
    }, [menuOpen]);

    const menuAction = (action) => {
        setMenuOpen(false);
        action();
    };

    const isCore = workflow._isCore && viewMode === 'core';
    const coreMeta = workflow._coreMetadata;

    return (
        <div
            className={`workflow-row workflow-row--${isActive ? 'active' : 'inactive'}${isCore ? ' workflow-row--core' : ''}`}
            onClick={() => onNavigate(workflow.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onNavigate(workflow.id)}
        >
            {/* Status dot */}
            <span
                className="workflow-row__status-dot"
                style={{ background: isActive ? 'var(--color-success, #22c55e)' : 'var(--text-muted, #666)' }}
                title={isActive ? 'Active' : 'Inactive'}
            />

            {/* Mini topology diagram */}
            <div className="workflow-row__minimap">
                {workflow._diagramJson ? (
                    <WorkflowMiniMap workflow={workflow._diagramJson} height={52} />
                ) : (
                    <span className="workflow-row__muted" style={{ fontSize: '0.7rem' }}>{workflow.nodeCount || 0}n</span>
                )}
            </div>

            {/* Org logo — for auth or org-mapped workflows; gear icon for engine-only */}
            {!isCore && (() => {
                const isOrgWf = workflow._source === 'auth' || workflow._source === 'org';
                const displayOrgName = workflow._orgName || orgName || '';
                const initials = displayOrgName.split(' ').filter(w => w).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
                return (
                    <div className="workflow-row__org-logo" title={isOrgWf ? displayOrgName : 'Engine workflow'}>
                        {isOrgWf && orgLogoUrl ? (
                            <img src={orgLogoUrl} alt={displayOrgName} />
                        ) : isOrgWf ? (
                            <span className="workflow-row__org-initials">{initials}</span>
                        ) : (
                            <span className="workflow-row__engine-icon" title="Engine workflow — not registered in org">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                            </span>
                        )}
                    </div>
                );
            })()}

            {/* Name + description */}
            <div className="workflow-row__main">
                <div className="workflow-row__name">
                    {workflow.name}
                </div>
                {!isCore && workflow.description && (
                    <div className="workflow-row__desc">{workflow.description}</div>
                )}
            </div>

            {isCore ? (
                <>
                    {/* Category badge */}
                    <div className="workflow-row__category">
                        <span
                            className="workflow-category-badge"
                            style={{ '--badge-color': CATEGORY_COLORS[coreMeta?.category] || 'var(--text-muted)' }}
                        >
                            {coreMeta?.category || '--'}
                        </span>
                    </div>

                    {/* Description */}
                    <div className="workflow-row__core-desc">
                        {coreMeta?.description || '--'}
                    </div>

                    {/* Plugin badge */}
                    <div className="workflow-row__plugin">
                        <span className="workflow-plugin-badge">{coreMeta?.plugin || '--'}</span>
                    </div>
                </>
            ) : (
                <>
                    {/* Node count */}
                    <div className="workflow-row__nodes">{workflow.nodeCount || 0} nodes</div>

                    {/* Last run */}
                    <div className="workflow-row__lastrun">
                        {lastExecution ? (
                            <span>
                                <span
                                    className="status-dot"
                                    style={{ background: STATUS_COLORS[lastExecution.status] || 'var(--text-muted)' }}
                                />
                                {' '}{lastRunTime || lastExecution.status}
                            </span>
                        ) : (
                            <span className="workflow-row__muted">--</span>
                        )}
                    </div>

                    {/* Trigger type */}
                    <div className="workflow-row__trigger">
                        {triggerLabel || <span className="workflow-row__muted">--</span>}
                    </div>

                    {/* Scope — org badge for auth/org workflows, "Engine" for unregistered */}
                    <div className="workflow-row__scope">
                        {(workflow._source === 'auth' || workflow._source === 'org') ? (
                            <ScopeBadge
                                scopePath={workflow.scopePath}
                                scopeName={workflow._orgName || workflow.scopeName || orgName}
                                scopeType={scope}
                                allScopes={allScopes}
                                orgName={workflow._orgName || orgName}
                                orgLogoUrl={orgLogoUrl}
                                variant="compact"
                                showLogo={false}
                            />
                        ) : (
                            <span className="workflow-row__unscoped-label">Engine</span>
                        )}
                    </div>
                </>
            )}

            {/* Kebab menu */}
            <div className="workflow-row__actions" onClick={e => e.stopPropagation()}>
                <button
                    className="workflow-row__kebab"
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
                    title="More actions"
                >
                    <svg viewBox="0 0 24 24" width="16" height="16" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2 }}><circle cx="12" cy="5" r="1" style={{ fill: 'rgba(255,255,255,0.7)' }}/><circle cx="12" cy="12" r="1" style={{ fill: 'rgba(255,255,255,0.7)' }}/><circle cx="12" cy="19" r="1" style={{ fill: 'rgba(255,255,255,0.7)' }}/></svg>
                </button>
                {menuOpen && (
                    <div className="workflow-card__menu">
                        <button onClick={() => menuAction(() => onNavigate(workflow.id))}>
                            <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                            View Details
                        </button>
                        <button onClick={() => menuAction(() => onEdit?.(workflow))}>
                            <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            Edit
                        </button>
                        <button onClick={() => menuAction(() => onRun?.(workflow))} disabled={!isActive}>
                            <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            Run Now
                        </button>
                        <button onClick={() => menuAction(() => onDuplicate?.(workflow))}>
                            <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            Duplicate
                        </button>
                        <div className="workflow-card__menu-divider" />
                        <button onClick={() => menuAction(() => onToggle?.(workflow))}>
                            <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                            {isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button className="workflow-card__menu-item--danger" onClick={() => menuAction(() => onDelete?.(workflow))}>
                            <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            Delete
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

// ===========================================================================
// WorkflowDetailPage — full-page view with WireMap + sidebar
// ===========================================================================
function WorkflowDetailPage({ workflowId, workflows, onRun, onToggle, onDelete, onEdit, allScopes, orgName, orgLogoUrl }) {
    const navigate = useNavigate();
    const [fullWorkflow, setFullWorkflow] = useState(null);
    const [loadingWf, setLoadingWf] = useState(true);
    const [execs, setExecs] = useState([]);
    const [loadingExecs, setLoadingExecs] = useState(true);
    const [copiedId, setCopiedId] = useState(false);

    // Find summary info from loaded workflows
    const summary = useMemo(() => workflows.find(w => w.id === workflowId), [workflows, workflowId]);

    useEffect(() => {
        if (!workflowId) return;
        setLoadingWf(true);
        setFullWorkflow(null);
        getEngineWorkflow(workflowId)
            .then(data => {
                if (data) setFullWorkflow(data);
            })
            .catch(() => {})
            .finally(() => setLoadingWf(false));

        setLoadingExecs(true);
        setExecs([]);
        listQFExecutions({ workflowId, limit: 15 })
            .then(result => {
                const items = Array.isArray(result) ? result
                    : Array.isArray(result?.data) ? result.data
                    : Array.isArray(result?.executions) ? result.executions
                    : [];
                setExecs(items);
            })
            .catch(() => setExecs([]))
            .finally(() => setLoadingExecs(false));
    }, [workflowId]);

    const wf = fullWorkflow || summary || { id: workflowId, name: 'Loading...' };
    const scope = wf.scope || getWorkflowScope(wf);
    const isActive = wf.active !== false;
    const triggerLabel = wf.trigger?.type
        ? wf.trigger.type.replace('trigger:', '')
        : null;
    const hasWireMap = fullWorkflow?.nodes?.length > 0;

    const handleCopyId = () => {
        navigator.clipboard.writeText(workflowId).catch(() => {});
        setCopiedId(true);
        setTimeout(() => setCopiedId(false), 2000);
    };

    return (
        <div className="workflow-detail">
            {/* Header */}
            <div className="workflow-detail__header">
                <button className="workflow-detail__back" onClick={() => navigate('/workflows')}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div className="workflow-detail__title">
                    <h2>{wf.name}</h2>
                    <div className="workflow-detail__title-meta">
                        <ScopeBadge
                            scopePath={wf.scopePath || summary?.scopePath}
                            scopeName={wf.scopeName || summary?.scopeName}
                            scopeType={scope}
                            allScopes={allScopes}
                            orgName={orgName}
                            orgLogoUrl={orgLogoUrl}
                            variant="full"
                        />
                        {triggerLabel && <span>{triggerLabel} trigger</span>}
                    </div>
                </div>
                <span className={`workflow-detail__badge workflow-detail__badge--${isActive ? 'active' : 'inactive'}`}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: isActive ? 'var(--color-success)' : 'var(--text-muted)' }} />
                    {isActive ? 'Active' : 'Inactive'}
                </span>
                <div className="workflow-detail__header-actions">
                    <button
                        className="btn btn--primary"
                        onClick={() => onRun?.(wf)}
                        disabled={!isActive}
                        title={!isActive ? 'Activate workflow first' : 'Run now'}
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        Run Now
                    </button>
                    <button
                        className="btn btn--secondary"
                        onClick={() => onEdit?.(wf)}
                        title="Edit workflow"
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        Edit
                    </button>
                    <button
                        className={`btn ${isActive ? 'btn--warning' : 'btn--success'}`}
                        onClick={() => onToggle?.(wf)}
                    >
                        {isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                        className="btn btn--danger-outline"
                        onClick={() => onDelete?.(wf)}
                        title="Delete workflow"
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        Delete
                    </button>
                </div>
            </div>

            {/* Main content: WireMap + Sidebar */}
            <div className="workflow-detail__content">
                {/* WireMap diagram */}
                <div className="workflow-detail__wiremap">
                    {loadingWf ? (
                        <div className="workflow-detail__wiremap-loading">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                            </svg>
                            Loading workflow diagram...
                        </div>
                    ) : hasWireMap ? (
                        <WireMap workflowJson={fullWorkflow} />
                    ) : (
                        <div className="workflow-detail__wiremap-empty">
                            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                            </svg>
                            <span>No diagram available</span>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                {wf.nodeCount ? `${wf.nodeCount} nodes detected but no visualization data` : 'This workflow has no nodes'}
                            </span>
                        </div>
                    )}
                </div>

                {/* Sidebar */}
                <div className="workflow-detail__sidebar">
                    {/* Details section */}
                    <div className="workflow-detail__sidebar-section">
                        <div className="workflow-detail__sidebar-title">Details</div>
                        {wf.description && (
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
                                {wf.description}
                            </div>
                        )}
                        {wf.notes && (
                            <div style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                                marginBottom: 12,
                                lineHeight: 1.6,
                                padding: '8px 10px',
                                background: 'rgba(255,255,255,0.03)',
                                borderLeft: '2px solid rgba(255,255,255,0.08)',
                                borderRadius: '0 4px 4px 0',
                                maxHeight: 160,
                                overflowY: 'auto',
                                whiteSpace: 'pre-wrap'
                            }}>
                                {wf.notes}
                            </div>
                        )}
                        <div className="workflow-detail__info-row">
                            <span className="workflow-detail__info-label">Scope</span>
                            <span className="workflow-detail__info-value">
                                <ScopeBadge
                                    scopePath={wf.scopePath || summary?.scopePath}
                                    scopeName={wf.scopeName || summary?.scopeName}
                                    scopeType={scope}
                                    allScopes={allScopes}
                                    orgName={orgName}
                                    variant="inline"
                                    showLogo={false}
                                />
                            </span>
                        </div>
                        <div className="workflow-detail__info-row">
                            <span className="workflow-detail__info-label">Trigger</span>
                            <span className="workflow-detail__info-value">{triggerLabel || 'Manual'}</span>
                        </div>
                        <div className="workflow-detail__info-row">
                            <span className="workflow-detail__info-label">Nodes</span>
                            <span className="workflow-detail__info-value">{wf.nodeCount || fullWorkflow?.nodes?.length || '--'}</span>
                        </div>
                        {wf.created_by_name && (
                            <div className="workflow-detail__info-row">
                                <span className="workflow-detail__info-label">Author</span>
                                <span className="workflow-detail__info-value">{wf.created_by_name}</span>
                            </div>
                        )}
                        {wf.createdAt && (
                            <div className="workflow-detail__info-row">
                                <span className="workflow-detail__info-label">Created</span>
                                <span className="workflow-detail__info-value">{new Date(wf.createdAt).toLocaleDateString()}</span>
                            </div>
                        )}
                        {wf.updatedAt && (
                            <div className="workflow-detail__info-row">
                                <span className="workflow-detail__info-label">Updated</span>
                                <span className="workflow-detail__info-value">{new Date(wf.updatedAt).toLocaleDateString()}</span>
                            </div>
                        )}
                        <div className="workflow-detail__info-row">
                            <span className="workflow-detail__info-label">ID</span>
                            <span className="workflow-detail__info-value" style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                {workflowId}
                            </span>
                        </div>
                        <button className="btn" onClick={handleCopyId} style={{ marginTop: 8, width: '100%' }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            {copiedId ? 'Copied!' : 'Copy Workflow ID'}
                        </button>
                    </div>

                    {/* Executions section */}
                    <div className="workflow-detail__sidebar-section" style={{ flex: 1, overflow: 'auto' }}>
                        <div className="workflow-detail__sidebar-title">
                            Recent Executions {!loadingExecs && execs.length > 0 && `(${execs.length})`}
                        </div>
                        {loadingExecs && (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '8px 0' }}>Loading...</div>
                        )}
                        {!loadingExecs && execs.length === 0 && (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '8px 0' }}>No executions found</div>
                        )}
                        {!loadingExecs && execs.map(exec => {
                            const statusColor = STATUS_COLORS[exec.status] || 'var(--text-muted)';
                            const started = exec.startedAt ? new Date(exec.startedAt) : null;
                            const ended = exec.completedAt ? new Date(exec.completedAt) : null;
                            let duration = '--';
                            if (started && ended) {
                                const diffMs = ended - started;
                                duration = diffMs < 1000 ? `${diffMs}ms` : `${(diffMs / 1000).toFixed(1)}s`;
                            } else if (started) {
                                duration = 'running';
                            }
                            return (
                                <div
                                    key={exec.id}
                                    className="workflow-detail__exec-item"
                                    onClick={() => navigate(`/executions/${exec.id}`)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/executions/${exec.id}`); }}
                                >
                                    <span style={{
                                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                        background: statusColor
                                    }} />
                                    <span style={{ color: statusColor, fontWeight: 500, minWidth: 55, fontSize: '0.8rem' }}>{exec.status}</span>
                                    <span style={{ color: 'var(--text-secondary)', flex: 1, fontSize: '0.8rem' }}>
                                        {started ? started.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '--'}
                                    </span>
                                    <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: '0.75rem' }}>{duration}</span>
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="var(--text-muted)" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ===========================================================================
// WorkflowsView — main component (list mode + detail mode)
// ===========================================================================
function WorkflowsView({ embedded = false }) {
    const { id: detailId } = useParams();
    const navigate = useNavigate();
    const outletCtx = useOutletContext() || {};
    const { halState } = outletCtx;
    const setHubActions = useHubActions();
    // When embedded inside WorkflowsHubView, route actions to the tab-row slot
    // instead of the breadcrumb (where they were cramped).
    const setPageActions = embedded ? setHubActions : outletCtx.setPageActions;
    const { orgs, currentOrg, divisions, myScopes, currentScope, selectScope, selectOrg } = useWorkspace();
    const { authFetch } = useAuth();

    const [activeTab, setActiveTab] = useState('workflows');
    const [workflows, setWorkflows] = useState([]);
    const [executions, setExecutions] = useState([]);
    const [statusFilter, setStatusFilter] = useState('all');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [runningNow, setRunningNow] = useState([]);
    // AEE-FULL Gap 4 — listing-surface cancel: simpler modal (Yes/No, no reason textarea per SD-10)
    const [confirmCancelExec, setConfirmCancelExec] = useState(null);
    const [listingCancelling, setListingCancelling] = useState(false);
    const [runFeedback, setRunFeedback] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [sortBy, setSortBy] = useState('name');
    const [viewMode, setViewMode] = useState('user'); // 'user' | 'core'
    const [confirmRun, setConfirmRun] = useState(null); // workflow to confirm before run
    const [runLoading, setRunLoading] = useState(false);
    // P8.B.3 — budget hard-stop guard
    const [hardStopGuard, setHardStopGuard] = useState(null); // { workflow, guard }
    const [confirmDelete, setConfirmDelete] = useState(null); // workflow to confirm before delete
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [editWorkflow, setEditWorkflow] = useState(null); // workflow to edit (opens edit modal)
    const [editLoading, setEditLoading] = useState(false);
    // N8N-ERADICATE: the one surviving n8n capability — import a legacy n8n
    // export as a QuoxFlow workflow (converts via QuoxFlow's /import-n8n route)
    const [n8nImportOpen, setN8nImportOpen] = useState(false);

    // Bulk select mode
    const [bulkMode, setBulkMode] = useState(false);
    const [bulkSelected, setBulkSelected] = useState(new Set());
    const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
    const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);

    // Poll for running executions every 5s
    useEffect(() => {
        let timer;
        async function pollRunning() {
            try {
                const result = await listQFExecutions({ status: 'running', limit: 20 });
                const items = Array.isArray(result) ? result : result?.data || result?.executions || [];
                setRunningNow(items);
            } catch {
                // Silently ignore
            }
        }
        pollRunning();
        timer = setInterval(pollRunning, 5000);
        return () => clearInterval(timer);
    }, []);

    // Load workflows
    const loadWorkflows = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            let summarized = [];
            let recentExecs = [];

            // If org is available, load org-scoped workflows from backend API
            if (currentOrg?.id) {
                const wfParams = new URLSearchParams({ limit: '100' });
                if (currentScope?.id && currentScope.scope_type !== 'org') {
                    wfParams.set('scope_id', currentScope.id);
                }
                const response = await authFetch(`/api/orgs/${currentOrg.id}/workflows?${wfParams}`);
                if (response.ok) {
                    const data = await response.json();
                    const orgWorkflows = data.items || [];
                    summarized = orgWorkflows.map(w => ({
                        id: w.id,
                        name: w.name,
                        active: w.status === 'active',
                        nodeCount: w.step_count || 0,
                        trigger: null,
                        tags: (w.tags || []).map(t => t.name || t),
                        scope: w.home_scope_id ? (w.scope_type || 'org') : 'org',
                        scopeName: w.home_scope_id ? (w.scope_name || null) : null,
                        scopePath: w.home_scope_id ? (w.scope_path || null) : null,
                        home_scope_id: w.home_scope_id,
                        share_policy_id: w.share_policy_id,
                        createdAt: w.created_at,
                        updatedAt: w.updated_at,
                        description: w.description,
                        created_by_name: w.created_by_name,
                        _source: 'auth'
                    }));
                }
            }

            // Load engine workflows + executions to enrich and merge
            try {
                const authIds = new Set(summarized.map(w => w.id));
                const authNames = new Map(summarized.map(w => [(w.name || '').toLowerCase(), w]));

                // Fetch engine workflows — enrich auth-registered workflows with engine
                // data (diagrams, trigger info, node counts). Engine-only workflows
                // (not registered in auth) are only shown at org level, since they
                // have no scope ownership.
                const isScopeFiltered = currentScope?.id && currentScope.scope_type !== 'org';
                try {
                    const { workflows: engineWfs } = await listWorkflows();
                    for (const ew of (engineWfs || [])) {
                        if (authIds.has(ew.id)) continue; // Exact ID match — already present

                        // Name-based dedup: if an auth workflow has the same name, merge engine data into it
                        const nameKey = (ew.name || '').toLowerCase();
                        const authMatch = nameKey && authNames.get(nameKey);
                        if (authMatch) {
                            // Enrich auth workflow with engine data (nodeCount, active status, diagram data, trigger)
                            if (!authMatch.nodeCount && ew.nodes?.length) authMatch.nodeCount = ew.nodes.length;
                            if (ew.active !== undefined && authMatch.active === undefined) authMatch.active = ew.active !== false;
                            if (ew.nodes?.length) authMatch._diagramJson = { nodes: ew.nodes, connections: ew.connections || {} };
                            if (!authMatch.trigger) authMatch.trigger = extractTrigger(ew);
                            continue;
                        }

                        // Check if this is a core (system) workflow
                        const coreMeta = getCoreMetadata(ew.name);
                        // Check if this engine workflow belongs to a known org
                        const orgMeta = !coreMeta ? getOrgWorkflowMeta(ew.name) : null;

                        // Engine-only workflow — only show at org level (no scope ownership)
                        // Core workflows always load (they are system-wide)
                        // Org-mapped workflows show at org level only
                        if (isScopeFiltered && !coreMeta) continue;

                        summarized.push({
                            id: ew.id,
                            name: ew.name || ew.id,
                            active: ew.active !== false,
                            nodeCount: ew.nodes?.length || 0,
                            trigger: extractTrigger(ew),
                            tags: [],
                            scope: coreMeta ? 'core' : 'org',
                            scopeName: orgMeta ? orgMeta.orgName : null,
                            scopePath: null,
                            home_scope_id: null,
                            createdAt: ew.createdAt || ew.created_at,
                            updatedAt: ew.updatedAt || ew.updated_at,
                            description: coreMeta ? coreMeta.description : (orgMeta?.description || ew.description),
                            _source: orgMeta ? 'org' : 'engine',
                            _orgName: orgMeta?.orgName || null,
                            _isCore: !!coreMeta,
                            _coreMetadata: coreMeta,
                            _diagramJson: ew.nodes?.length ? { nodes: ew.nodes, connections: ew.connections || {} } : null
                        });
                    }
                } catch {
                    // Engine list may fail
                }

                // Backfill core workflows from static registry that weren't
                // found via the engine. This ensures core view is always populated.
                const loadedNames = new Set(summarized.map(w => w.name));
                for (const [name, meta] of Object.entries(CORE_WORKFLOWS)) {
                    if (loadedNames.has(name)) continue;
                    summarized.push({
                        id: `core-${name.replace(/\s+/g, '-').toLowerCase()}`,
                        name,
                        active: true,
                        nodeCount: 0,
                        trigger: null,
                        tags: [],
                        scope: 'core',
                        scopeName: null,
                        scopePath: null,
                        home_scope_id: null,
                        createdAt: null,
                        updatedAt: null,
                        description: meta.description,
                        _source: 'registry',
                        _isCore: true,
                        _coreMetadata: meta,
                        _diagramJson: null
                    });
                }

                const { executions: execs } = await listExecutions({ limit: 50 });
                recentExecs = execs;

                const execMap = {};
                for (const exec of recentExecs) {
                    if (!execMap[exec.workflowId]) {
                        execMap[exec.workflowId] = exec;
                    }
                }

                // Enrich workflows with execution data from engine
                for (const w of summarized) {
                    const exec = execMap[w.id];
                    if (exec) {
                        w.lastExecution = {
                            id: exec.id,
                            status: exec.status,
                            startedAt: exec.startedAt,
                            stoppedAt: exec.stoppedAt
                        };
                    }
                }
            } catch {
                // Engine may not be running
            }

            setWorkflows(summarized);
            setExecutions(recentExecs);
        } catch (err) {
            console.warn('Could not load workflows:', err.message);
            setWorkflows([]);
            setExecutions([]);
        } finally {
            setLoading(false);
        }
    }, [currentOrg?.id, currentScope?.id, authFetch]);

    useEffect(() => {
        loadWorkflows();
    }, [loadWorkflows]);

    useEffect(() => {
        setPageActions?.(
            <div className="header-actions">
                <button
                    className={`qx-btn qx-btn--sm${bulkMode ? ' qx-btn--ghost' : ''}`}
                    onClick={() => { setBulkMode(!bulkMode); setBulkSelected(new Set()); }}
                    title={bulkMode ? 'Exit select mode' : 'Select workflows for bulk actions'}
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                    {bulkMode ? 'Cancel' : 'Select'}
                </button>
                <button className="qx-btn qx-btn--sm" onClick={loadWorkflows}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    Refresh
                </button>
                <button className="qx-btn qx-btn--sm" onClick={() => navigate('/workflow-library')}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    Library
                </button>
                <button className="qx-btn qx-btn--sm" onClick={() => setN8nImportOpen(true)} title="Import a legacy n8n workflow export">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Import n8n
                </button>
                <button className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => navigate('/workflow-builder')}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    New Workflow
                </button>
            </div>
        );
        return () => setPageActions?.(null);
    }, [setPageActions]);

    // Error helper
    const getErrorMsg = (err) => {
        if (typeof err === 'string') return err;
        if (err?.message) return err.message;
        if (err?.error) return typeof err.error === 'string' ? err.error : JSON.stringify(err.error);
        return 'Unknown error';
    };

    // Auto-dismiss run feedback
    useEffect(() => {
        if (!runFeedback) return;
        const timer = setTimeout(() => setRunFeedback(null), 8000);
        return () => clearTimeout(timer);
    }, [runFeedback]);

    // Request to run a workflow (shows confirmation modal)
    const requestRunWorkflow = (workflow) => {
        setConfirmRun(workflow);
    };

    // Actually run workflow after user confirms (or after override from HardStopDialog)
    const doRunWorkflow = async (workflow) => {
        setRunLoading(true);
        try {
            const result = await executeWorkflow(workflow.id, { workflowName: workflow.name });

            // Extract execution info from response
            const data = result?.data || result;
            const rawId = data?.executionId || data?.stored?.id || data?.id;
            const execId = rawId && typeof rawId === 'string' ? rawId : rawId ? String(rawId) : null;
            const execStatus = data?.success === false ? 'failed' : (data?.stored?.status || 'completed');

            // Store server-returned envelopes in AEE (QuoxFlow provides full audit trail)
            try {
                const serverEnvelopes = data?.envelopes || [];
                if (serverEnvelopes.length > 0) {
                    await storeEnvelopes(serverEnvelopes);
                }
            } catch (e) {
                console.warn('[AEE] Failed to store server envelopes:', e);
            }

            setRunFeedback({
                name: workflow.name,
                executionId: execId,
                status: execStatus,
            });
            setConfirmRun(null);
            setHardStopGuard(null);
            setTimeout(loadWorkflows, 1000);
        } catch (err) {
            setError(`Failed to run workflow: ${getErrorMsg(err)}`);
            setConfirmRun(null);
            setHardStopGuard(null);
        } finally {
            setRunLoading(false);
        }
    };

    // Actually run workflow after user confirms
    const confirmAndRunWorkflow = async () => {
        const workflow = confirmRun;
        if (!workflow) return;

        // P8.B.3 — check budget before firing
        try {
            const guard = await evaluateBudgetForExecution({
                authFetch,
                workflowId: workflow.id,
            });
            if (guard.willHardStop) {
                setHardStopGuard({ workflow, guard });
                return;
            }
        } catch {
            // Guard failure must not block execution — let server enforce
        }

        await doRunWorkflow(workflow);
    };

    // Toggle workflow active status
    const toggleWorkflow = async (workflow) => {
        try {
            if (workflow.active) {
                if (!window.confirm(`Deactivate "${workflow.name}"? This will stop all scheduled triggers.`)) return;
                const result = await deactivateWorkflow(workflow.id);
                if (result?.message?.includes('not supported')) {
                    setError(result.message);
                    return;
                }
            } else {
                await activateWorkflow(workflow.id);
            }
            loadWorkflows();
        } catch (err) {
            setError(`Failed to toggle workflow: ${getErrorMsg(err)}`);
        }
    };

    // Request delete confirmation
    const requestDeleteWorkflow = (workflow) => {
        setConfirmDelete(workflow);
    };

    // Confirm and delete workflow
    const confirmAndDeleteWorkflow = async () => {
        const workflow = confirmDelete;
        if (!workflow) return;
        setDeleteLoading(true);

        try {
            // Delete from auth backend if org is available
            if (currentOrg?.id) {
                try {
                    await authFetch(`/api/orgs/${currentOrg.id}/workflows/${workflow.id}`, { method: 'DELETE' });
                } catch {
                    // May not exist in auth backend
                }
            }

            // Delete from workflow engine
            await deleteWorkflow(workflow.id);

            setConfirmDelete(null);
            setRunFeedback({ name: workflow.name, status: 'deleted', message: 'Workflow deleted' });

            // If viewing the deleted workflow's detail page, navigate back to list
            if (detailId === workflow.id) {
                navigate('/workflows');
            }
            loadWorkflows();
        } catch (err) {
            setError(`Failed to delete workflow: ${getErrorMsg(err)}`);
            setConfirmDelete(null);
        } finally {
            setDeleteLoading(false);
        }
    };

    // Open edit modal for a workflow
    const requestEditWorkflow = (workflow) => {
        setEditWorkflow(workflow);
    };

    // Load scopes for a given org (used by WorkflowEditModal when org changes)
    const loadScopesForOrg = async (orgId) => {
        try {
            const res = await authFetch(`/api/orgs/${orgId}/my-scopes`);
            if (res.ok) {
                const data = await res.json();
                return data.scopes || [];
            }
        } catch (err) {
            console.error('[WorkflowsView] Failed to load scopes for org:', err);
        }
        return [];
    };

    // Submit edit changes
    const submitEditWorkflow = async (updates) => {
        if (!editWorkflow) return;
        setEditLoading(true);

        try {
            // Update auth backend if org is available
            if (currentOrg?.id) {
                try {
                    await authFetch(`/api/orgs/${currentOrg.id}/workflows/${editWorkflow.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: updates.name,
                            description: updates.description,
                            tags: updates.tags,
                            metadata: { scope: updates.scope },
                            home_scope_id: updates.home_scope_id,
                        })
                    });
                } catch {
                    // May not exist in auth backend
                }
            }

            // Update engine workflow
            await updateWorkflow(editWorkflow.id, {
                name: updates.name,
                description: updates.description,
                tags: updates.tags,
                metadata: { scope: updates.scope },
            });

            setEditWorkflow(null);
            setRunFeedback({ name: updates.name, status: 'updated', message: 'Workflow updated' });
            loadWorkflows();
        } catch (err) {
            throw new Error(getErrorMsg(err));
        } finally {
            setEditLoading(false);
        }
    };

    // Duplicate a workflow
    const duplicateWorkflow = async (workflow) => {
        try {
            // Fetch full workflow definition from engine
            const fullWf = await getEngineWorkflow(workflow.id);
            if (!fullWf) {
                setError('Could not fetch workflow definition for duplication');
                return;
            }

            const newName = `${workflow.name} (Copy)`;
            const newWorkflow = {
                ...fullWf,
                id: undefined,  // Let the backend generate a new ID
                name: newName,
                metadata: {
                    ...(fullWf.metadata || {}),
                    duplicated_from: workflow.id,
                },
            };
            delete newWorkflow.id;
            delete newWorkflow.createdAt;
            delete newWorkflow.updatedAt;

            await createWorkflow(newWorkflow);

            setRunFeedback({ name: newName, status: 'duplicated', message: 'Workflow duplicated' });
            loadWorkflows();
        } catch (err) {
            setError(`Failed to duplicate workflow: ${getErrorMsg(err)}`);
        }
    };

    // Toggle bulk selection for a workflow
    const toggleBulkSelect = (workflowId) => {
        setBulkSelected(prev => {
            const next = new Set(prev);
            if (next.has(workflowId)) next.delete(workflowId);
            else next.add(workflowId);
            return next;
        });
    };

    // Bulk delete all selected workflows
    const confirmAndBulkDelete = async () => {
        setBulkDeleteLoading(true);
        const ids = [...bulkSelected];
        let failed = 0;
        for (const id of ids) {
            try {
                if (currentOrg?.id) {
                    try { await authFetch(`/api/orgs/${currentOrg.id}/workflows/${id}`, { method: 'DELETE' }); } catch {}
                }
                await deleteWorkflow(id);
            } catch {
                failed++;
            }
        }
        setBulkDeleteLoading(false);
        setConfirmBulkDelete(false);
        setBulkSelected(new Set());
        setBulkMode(false);
        setRunFeedback({
            name: `${ids.length - failed} workflow${ids.length - failed !== 1 ? 's' : ''}`,
            status: 'deleted',
            message: failed > 0 ? `Deleted ${ids.length - failed}, ${failed} failed` : 'Workflows deleted'
        });
        loadWorkflows();
    };

    // Navigate to workflow detail
    const navigateToWorkflow = (workflowId) => {
        navigate(`/workflows/${workflowId}`);
    };

    // Enrich workflows with scope + core metadata
    const enrichedWorkflows = useMemo(() => workflows.map(w => {
        // Check if this workflow is core (by name) even if loaded from auth backend
        const coreMeta = w._isCore ? w._coreMetadata : getCoreMetadata(w.name);
        return {
            ...w,
            scope: coreMeta ? 'core' : getWorkflowScope(w),
            _isCore: !!coreMeta,
            _coreMetadata: coreMeta || null,
        };
    }), [workflows]);

    // Filter + sort workflows (respects viewMode: 'user' hides core, 'core' shows only core)
    const filteredWorkflows = useMemo(() => {
        return enrichedWorkflows.filter(w => {
            // View mode split
            if (viewMode === 'user' && w._isCore) return false;
            if (viewMode === 'core' && !w._isCore) return false;

            if (searchTerm.trim()) {
                const q = searchTerm.toLowerCase();
                const nameMatch = w.name?.toLowerCase().includes(q);
                const descMatch = w.description?.toLowerCase().includes(q);
                const tagMatch = w.tags?.some(t => (typeof t === 'string' ? t : t.name || '').toLowerCase().includes(q));
                // In core view, also search category and plugin
                const coreMatch = w._isCore && (
                    w._coreMetadata?.category?.toLowerCase().includes(q) ||
                    w._coreMetadata?.plugin?.toLowerCase().includes(q)
                );
                if (!nameMatch && !descMatch && !tagMatch && !coreMatch) return false;
            }
            if (statusFilter === 'active' && !w.active) return false;
            if (statusFilter === 'inactive' && w.active) return false;
            return true;
        }).sort((a, b) => {
            // In core view, group by category first, then sort within groups
            if (viewMode === 'core') {
                const catCmp = (a._coreMetadata?.category || '').localeCompare(b._coreMetadata?.category || '');
                if (catCmp !== 0) return catCmp;
            }
            switch (sortBy) {
                case 'name': return (a.name || '').localeCompare(b.name || '');
                case 'lastRun': {
                    const aTime = a.lastExecution?.startedAt ? new Date(a.lastExecution.startedAt).getTime() : 0;
                    const bTime = b.lastExecution?.startedAt ? new Date(b.lastExecution.startedAt).getTime() : 0;
                    return bTime - aTime;
                }
                case 'created': return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
                case 'nodeCount': return (b.nodeCount || 0) - (a.nodeCount || 0);
                case 'status': return (a.active === b.active) ? 0 : a.active ? -1 : 1;
                default: return 0;
            }
        });
    }, [enrichedWorkflows, searchTerm, statusFilter, sortBy, viewMode]);

    // Active filters check
    const hasActiveFilters = statusFilter !== 'all' || searchTerm.trim();
    const clearAllFilters = () => {
        setStatusFilter('all');
        setSearchTerm('');
    };

    // =========================================================================
    // DETAIL MODE — render full-page view when URL has :id
    // =========================================================================
    if (detailId) {
        return (
            <>
                <WorkflowDetailPage
                    workflowId={detailId}
                    workflows={workflows}
                    onRun={requestRunWorkflow}
                    onToggle={toggleWorkflow}
                    onDelete={requestDeleteWorkflow}
                    onEdit={requestEditWorkflow}
                    allScopes={myScopes || []}
                    orgName={currentOrg?.name}
                    orgLogoUrl={currentOrg?.logo_url}
                />

                {/* Modals must render here too — they're outside the list-mode JSX */}
                <WorkflowEditModal
                    isOpen={!!editWorkflow}
                    onClose={() => !editLoading && setEditWorkflow(null)}
                    onSubmit={submitEditWorkflow}
                    workflow={editWorkflow}
                    scopes={myScopes || []}
                    orgs={orgs || []}
                    currentOrg={currentOrg}
                    onLoadScopes={loadScopesForOrg}
                    loading={editLoading}
                />

                {/* Delete Confirmation Modal */}
                <Modal
                    isOpen={!!confirmDelete}
                    onClose={() => !deleteLoading && setConfirmDelete(null)}
                    severity="danger"
                    size="sm"
                    closeOnOverlay={!deleteLoading}
                    closeOnEscape={!deleteLoading}
                >
                    <Modal.Header
                        title="Delete Workflow"
                        description="This action cannot be undone"
                        icon={
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        }
                        onClose={!deleteLoading ? () => setConfirmDelete(null) : undefined}
                    />
                    <Modal.Body>
                        <p style={{ color: 'var(--ui-text-secondary, #ccc)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                            This will permanently delete <strong>{confirmDelete?.name}</strong> and all its execution history.
                        </p>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" onClick={() => setConfirmDelete(null)} disabled={deleteLoading}>Cancel</Button>
                        <Button variant="danger" onClick={confirmAndDeleteWorkflow} loading={deleteLoading}>
                            {deleteLoading ? 'Deleting...' : 'Delete Workflow'}
                        </Button>
                    </Modal.Footer>
                </Modal>

                {/* Run Confirmation Modal */}
                <Modal
                    isOpen={!!confirmRun}
                    onClose={() => !runLoading && setConfirmRun(null)}
                    severity="warning"
                    size="sm"
                    closeOnOverlay={!runLoading}
                    closeOnEscape={!runLoading}
                >
                    <Modal.Header
                        title="Run Workflow"
                        description="Confirm execution"
                        icon={
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        }
                        onClose={!runLoading ? () => setConfirmRun(null) : undefined}
                    />
                    <Modal.Body>
                        <p style={{ color: 'var(--ui-text-secondary, #ccc)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                            Execute <strong>{confirmRun?.name}</strong> now? All nodes will be triggered.
                        </p>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" onClick={() => setConfirmRun(null)} disabled={runLoading}>Cancel</Button>
                        <Button variant="primary" onClick={confirmAndRunWorkflow} loading={runLoading}>
                            {runLoading ? 'Executing...' : 'Run Now'}
                        </Button>
                    </Modal.Footer>
                </Modal>
            </>
        );
    }

    // =========================================================================
    // LIST MODE — grid view
    // =========================================================================
    return (
        <div className="workflows-view view-page">
            <LLMAuthBanner />
            {!embedded && <EvolutionStagePill currentStage="workflow" style={{ marginBottom: 12 }} />}

            {/* Tab Switcher */}
            <div className="view-tabs-row" style={{ marginBottom: 10 }}>
                <div className="view-tabs">
                    <button className={`tab-btn ${activeTab === 'workflows' ? 'active' : ''}`} onClick={() => setActiveTab('workflows')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                        {' '}Workflows
                    </button>
                    <button className={`tab-btn ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        {' '}Audit
                    </button>
                </div>
            </div>

            {/* Audit Tab */}
            {activeTab === 'audit' && <AuditPanel />}

            {/* Workflows Tab */}
            {activeTab === 'workflows' && error && (
                <div className="error-banner">
                    {error}
                    <button onClick={() => setError(null)}>Dismiss</button>
                </div>
            )}

            {activeTab === 'workflows' && <>
                {/* Running Now */}
                {runningNow.length > 0 && (
                    <div className="running-now">
                        <div className="running-now__header">
                            <span className="running-now__pulse" />
                            <strong>Running Now</strong>
                            <span className="running-now__count">{runningNow.length}</span>
                        </div>
                        <div className="running-now__list">
                            {runningNow.map(exec => (
                                <div
                                    key={exec.id}
                                    className="running-now__item"
                                    onClick={() => navigate(`/executions/${exec.id}`)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/executions/${exec.id}`)}
                                >
                                    <span className="running-now__name">
                                        {exec.workflowName || `Workflow ${exec.workflowId || exec.id}`}
                                    </span>
                                    <span className="running-now__elapsed">
                                        {exec.startedAt ? `${Math.round((Date.now() - new Date(exec.startedAt)) / 1000)}s` : '...'}
                                    </span>
                                    <div className="running-now__bar"><div className="running-now__bar-fill" /></div>
                                    {/* AEE-FULL Gap 4 — inline Cancel icon (SD-8 secondary surface) */}
                                    <button
                                        type="button"
                                        className="running-now__cancel"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setConfirmCancelExec({ id: exec.id, name: exec.workflowName || exec.workflowId || exec.id });
                                        }}
                                        title="Cancel this execution"
                                        style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--color-warning, #f59e0b)', display: 'inline-flex', alignItems: 'center' }}
                                    >
                                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                            <rect x="6" y="6" width="12" height="12" rx="1.5" />
                                        </svg>
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Feedback Toast */}
                {runFeedback && (
                    <div className={`run-feedback-toast ${runFeedback.status === 'failed' ? 'run-feedback-toast--failed' : ''} ${runFeedback.status === 'deleted' ? 'run-feedback-toast--deleted' : ''}`}>
                        {runFeedback.status === 'failed' ? (
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                        ) : runFeedback.status === 'deleted' ? (
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        ) : (
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                        )}
                        <span>
                            {runFeedback.status === 'failed' && <>Executed <strong>{runFeedback.name}</strong> &mdash; <em style={{ color: 'var(--color-danger, #ef4444)' }}>workflow failed</em></>}
                            {runFeedback.status === 'deleted' && <>Deleted <strong>{runFeedback.name}</strong></>}
                            {runFeedback.status === 'updated' && <>Updated <strong>{runFeedback.name}</strong></>}
                            {runFeedback.status === 'duplicated' && <>Duplicated <strong>{runFeedback.name}</strong></>}
                            {!['failed', 'deleted', 'updated', 'duplicated'].includes(runFeedback.status) && <>Started <strong>{runFeedback.name}</strong></>}
                            {runFeedback.executionId && <> &mdash; <code>{String(runFeedback.executionId).slice(0, 12)}...</code></>}
                        </span>
                        {runFeedback.executionId && (
                            <button className="run-feedback-toast__view" onClick={() => navigate(`/executions/${runFeedback.executionId}`)}>
                                View <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                            </button>
                        )}
                        <button className="run-feedback-toast__dismiss" onClick={() => setRunFeedback(null)} title="Dismiss">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                    </div>
                )}

                {/* Unified Toolbar: search + status + scope + sort — single row */}
                <div className="workflows-toolbar">
                    <div className="library-search">
                        <span className="search-icon">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        </span>
                        <input
                            type="text"
                            placeholder="Search workflows..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                        {searchTerm && (
                            <button className="clear-search" onClick={() => setSearchTerm('')}>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        )}
                    </div>

                    <div className="workflows-toolbar__filters">
                        {/* User / Core segmented toggle */}
                        <div className="workflow-toggle">
                            <button
                                className={`workflow-toggle__btn ${viewMode === 'user' ? 'workflow-toggle__btn--active' : ''}`}
                                onClick={() => setViewMode('user')}
                            >
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                User
                            </button>
                            <button
                                className={`workflow-toggle__btn ${viewMode === 'core' ? 'workflow-toggle__btn--active' : ''}`}
                                onClick={() => setViewMode('core')}
                            >
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                                Core
                                <span className="workflow-toggle__count">{enrichedWorkflows.filter(w => w._isCore).length}</span>
                            </button>
                        </div>

                        {/* Status tabs */}
                        <div className="filter-tabs">
                            {(() => {
                                const viewWfs = enrichedWorkflows.filter(w => viewMode === 'core' ? w._isCore : !w._isCore);
                                return [
                                    { key: 'all', label: 'All', count: viewWfs.length },
                                    { key: 'active', label: 'Active', count: viewWfs.filter(w => w.active).length },
                                    { key: 'inactive', label: 'Inactive', count: viewWfs.filter(w => !w.active).length },
                                ];
                            })().map(({ key, label, count }) => (
                                <button
                                    key={key}
                                    type="button"
                                    className={`qx-chip ${statusFilter === key ? 'qx-chip--active' : ''}`}
                                    onClick={() => setStatusFilter(key)}
                                >
                                    {label} ({count})
                                </button>
                            ))}
                        </div>

                        {/* Scope cascade — hidden in core view (irrelevant) */}
                        {viewMode !== 'core' && (
                            <ScopeFilterCascade
                                orgs={orgs}
                                currentOrg={currentOrg}
                                onOrgChange={selectOrg}
                                scopes={myScopes || []}
                                currentScope={currentScope}
                                onScopeChange={selectScope}
                                mode="filter"
                                showOrgLogos={true}
                            />
                        )}

                        <select className="filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="Sort workflows">
                            <option value="name">Sort: Name</option>
                            <option value="lastRun">Sort: Last Run</option>
                            <option value="created">Sort: Created</option>
                            <option value="nodeCount">Sort: Nodes</option>
                            <option value="status">Sort: Status</option>
                        </select>
                    </div>
                </div>

                {/* Active filter pills + result count */}
                {hasActiveFilters && (
                    <div className="active-filters">
                        {statusFilter !== 'all' && (
                            <span className="filter-tag">
                                {statusFilter}
                                <button className="filter-tag__remove" onClick={() => setStatusFilter('all')} title="Remove filter">&times;</button>
                            </span>
                        )}
                        {searchTerm.trim() && (
                            <span className="filter-tag">
                                "{searchTerm}"
                                <button className="filter-tag__remove" onClick={() => setSearchTerm('')} title="Remove filter">&times;</button>
                            </span>
                        )}
                        <span className="active-filters__count">{filteredWorkflows.length} of {enrichedWorkflows.length}</span>
                        <button className="active-filters__clear" onClick={clearAllFilters}>Clear all</button>
                    </div>
                )}

                {/* Loading State */}
                {loading && <div className="loading-state">Loading workflows...</div>}

                {/* Bulk action floating bar */}
                {bulkMode && bulkSelected.size > 0 && (
                    <div className="bulk-action-bar">
                        <span className="bulk-action-bar__count">
                            {bulkSelected.size} selected
                        </span>
                        <button
                            className="btn btn--danger btn--sm"
                            onClick={() => setConfirmBulkDelete(true)}
                        >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            Delete Selected
                        </button>
                        <button
                            className="btn btn--sm"
                            onClick={() => setBulkSelected(new Set())}
                        >
                            Clear
                        </button>
                    </div>
                )}

                {/* Workflows List */}
                {!loading && filteredWorkflows.length > 0 && (
                    <div className={`workflow-list${viewMode === 'core' ? ' workflow-list--core' : ''}`}>
                        <div className="workflow-list__header">
                            <span className="workflow-list__col--status" />
                            <span className="workflow-list__col--minimap">Map</span>
                            {viewMode !== 'core' && <span className="workflow-list__col--logo" />}
                            <span className="workflow-list__col--name">Workflow</span>
                            {viewMode === 'core' ? (
                                <>
                                    <span className="workflow-list__col--category">Category</span>
                                    <span className="workflow-list__col--description">Description</span>
                                    <span className="workflow-list__col--plugin">Plugin</span>
                                </>
                            ) : (
                                <>
                                    <span className="workflow-list__col--nodes">Nodes</span>
                                    <span className="workflow-list__col--lastrun">Last Run</span>
                                    <span className="workflow-list__col--trigger">Trigger</span>
                                    <span className="workflow-list__col--scope">Scope</span>
                                </>
                            )}
                            <span className="workflow-list__col--actions" />
                        </div>
                        {filteredWorkflows.map(workflow => (
                            <div key={workflow.id} style={{ position: 'relative' }}>
                                {bulkMode && (
                                    <label
                                        className="bulk-checkbox"
                                        onClick={e => e.stopPropagation()}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={bulkSelected.has(workflow.id)}
                                            onChange={() => toggleBulkSelect(workflow.id)}
                                        />
                                    </label>
                                )}
                                <WorkflowCard
                                    workflow={workflow}
                                    orgName={currentOrg?.name}
                                    orgLogoUrl={currentOrg?.logo_url}
                                    allScopes={myScopes || []}
                                    onRun={requestRunWorkflow}
                                    onToggle={toggleWorkflow}
                                    onNavigate={bulkMode ? () => toggleBulkSelect(workflow.id) : navigateToWorkflow}
                                    onDelete={requestDeleteWorkflow}
                                    onEdit={requestEditWorkflow}
                                    onDuplicate={duplicateWorkflow}
                                    viewMode={viewMode}
                                />
                            </div>
                        ))}
                    </div>
                )}

                {/* Empty State */}
                {!loading && filteredWorkflows.length === 0 && (
                    <div className="empty-state">
                        <div className="empty-state__icon" aria-hidden="true">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="4" width="6" height="6" rx="1.5" />
                                <rect x="15" y="14" width="6" height="6" rx="1.5" />
                                <path d="M9 7h4a2 2 0 0 1 2 2v8" />
                            </svg>
                        </div>
                        <div className="empty-state__title">
                            {hasActiveFilters ? 'No matching workflows' : viewMode === 'core' ? 'No core workflows detected' : 'No workflows yet'}
                        </div>
                        <div className="empty-state__description">
                            {hasActiveFilters
                                ? 'Try different filters or clear all to see all workflows.'
                                : viewMode === 'core'
                                    ? 'Core system workflows will appear here when the workflow engine is running.'
                                    : 'Create your first workflow or browse templates.'}
                        </div>
                        <div className="empty-state__actions">
                            {hasActiveFilters && (
                                <button className="btn" onClick={clearAllFilters}>
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                    Clear Filters
                                </button>
                            )}
                            <button className="btn" onClick={() => navigate('/workflow-library')}>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                                Browse Library
                            </button>
                            <button className="btn btn--primary" onClick={() => navigate('/workflow-builder')}>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                New Workflow
                            </button>
                        </div>
                    </div>
                )}

                {/* Recent Executions */}
                {executions.length > 0 && (
                    <PageSection title="Recent Executions" collapsible defaultCollapsed>
                        <div className="executions-list">
                            {executions.slice(0, 10).map(exec => {
                                const workflow = workflows.find(w => w.id === exec.workflowId);
                                return (
                                    <div
                                        key={exec.id}
                                        className="execution-item execution-item--clickable"
                                        onClick={() => navigate(`/executions/${exec.id}`)}
                                        role="button"
                                        tabIndex={0}
                                        onKeyDown={(e) => e.key === 'Enter' && navigate(`/executions/${exec.id}`)}
                                    >
                                        <span className="execution-workflow">{workflow?.name || `Workflow ${exec.workflowId}`}</span>
                                        <span className="execution-status" style={{ color: STATUS_COLORS[exec.status] }}>{exec.status}</span>
                                        <span className="execution-time">{new Date(exec.startedAt).toLocaleString()}</span>
                                        <span className="execution-arrow">
                                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </PageSection>
                )}
            </>}

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!confirmDelete}
                onClose={() => !deleteLoading && setConfirmDelete(null)}
                severity="danger"
                size="sm"
                closeOnOverlay={!deleteLoading}
                closeOnEscape={!deleteLoading}
            >
                <Modal.Header
                    title="Delete Workflow"
                    description="This action cannot be undone"
                    icon={
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    }
                    onClose={!deleteLoading ? () => setConfirmDelete(null) : undefined}
                />
                <Modal.Body>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div style={{
                            padding: '0.875rem 1rem',
                            background: 'rgba(255, 255, 255, 0.03)',
                            borderRadius: '8px',
                            border: '1px solid rgba(255, 255, 255, 0.06)'
                        }}>
                            <div style={{
                                fontSize: '0.7rem',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px',
                                color: 'var(--ui-text-muted, #666)',
                                marginBottom: '0.375rem'
                            }}>
                                Workflow
                            </div>
                            <div style={{
                                fontSize: '0.95rem',
                                color: 'var(--ui-text-primary, white)',
                                fontWeight: 600
                            }}>
                                {confirmDelete?.name}
                            </div>
                            {confirmDelete?.description && (
                                <div style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--ui-text-secondary, #ccc)',
                                    marginTop: '0.5rem',
                                    lineHeight: 1.4
                                }}>
                                    {confirmDelete.description}
                                </div>
                            )}
                        </div>
                        <div style={{
                            padding: '0.75rem 1rem',
                            background: 'rgba(239, 68, 68, 0.08)',
                            borderRadius: '8px',
                            borderLeft: '3px solid var(--color-danger, #ef4444)',
                            fontSize: '0.8rem',
                            color: 'var(--ui-text-secondary, #ccc)',
                            lineHeight: 1.5
                        }}>
                            This will permanently delete this workflow and all its execution history. Any active schedules will be removed.
                            {confirmDelete?.nodeCount ? ` This workflow has ${confirmDelete.nodeCount} nodes.` : ''}
                        </div>
                        <div style={{
                            fontSize: '0.75rem',
                            color: 'var(--ui-text-muted, #666)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem'
                        }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            Deletion will be recorded in the audit trail
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button
                        variant="secondary"
                        onClick={() => setConfirmDelete(null)}
                        disabled={deleteLoading}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="danger"
                        onClick={confirmAndDeleteWorkflow}
                        loading={deleteLoading}
                    >
                        {deleteLoading ? 'Deleting...' : 'Delete Workflow'}
                    </Button>
                </Modal.Footer>
            </Modal>

            {/* Run Confirmation Modal */}
            <Modal
                isOpen={!!confirmRun}
                onClose={() => !runLoading && setConfirmRun(null)}
                severity="warning"
                size="sm"
                closeOnOverlay={!runLoading}
                closeOnEscape={!runLoading}
            >
                <Modal.Header
                    title="Run Workflow"
                    description="Confirm execution"
                    icon={
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    }
                    onClose={!runLoading ? () => setConfirmRun(null) : undefined}
                />
                <Modal.Body>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div style={{
                            padding: '0.875rem 1rem',
                            background: 'rgba(255, 255, 255, 0.03)',
                            borderRadius: '8px',
                            border: '1px solid rgba(255, 255, 255, 0.06)'
                        }}>
                            <div style={{
                                fontSize: '0.7rem',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px',
                                color: 'var(--ui-text-muted, #666)',
                                marginBottom: '0.375rem'
                            }}>
                                Workflow
                            </div>
                            <div style={{
                                fontSize: '0.95rem',
                                color: 'var(--ui-text-primary, white)',
                                fontWeight: 600
                            }}>
                                {confirmRun?.name}
                            </div>
                            {confirmRun?.description && (
                                <div style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--ui-text-secondary, #ccc)',
                                    marginTop: '0.5rem',
                                    lineHeight: 1.4
                                }}>
                                    {confirmRun.description}
                                </div>
                            )}
                        </div>
                        <div style={{
                            padding: '0.75rem 1rem',
                            background: 'rgba(255, 176, 48, 0.08)',
                            borderRadius: '8px',
                            borderLeft: '3px solid var(--ui-amber, #ffb030)',
                            fontSize: '0.8rem',
                            color: 'var(--ui-text-secondary, #ccc)',
                            lineHeight: 1.5
                        }}>
                            This will execute the workflow immediately. All nodes will be triggered and actions will be performed.
                            {confirmRun?.nodeCount ? ` This workflow has ${confirmRun.nodeCount} nodes.` : ''}
                        </div>
                        <div style={{
                            fontSize: '0.75rem',
                            color: 'var(--ui-text-muted, #666)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem'
                        }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            Execution will be recorded in the audit trail
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button
                        variant="secondary"
                        onClick={() => setConfirmRun(null)}
                        disabled={runLoading}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        onClick={confirmAndRunWorkflow}
                        loading={runLoading}
                    >
                        {runLoading ? 'Executing...' : 'Run Now'}
                    </Button>
                </Modal.Footer>
            </Modal>

            {/* Bulk Delete Confirmation Modal */}
            <Modal
                isOpen={confirmBulkDelete}
                onClose={() => !bulkDeleteLoading && setConfirmBulkDelete(false)}
                severity="danger"
                size="sm"
                closeOnOverlay={!bulkDeleteLoading}
                closeOnEscape={!bulkDeleteLoading}
            >
                <Modal.Header
                    title="Delete Selected Workflows"
                    description="This action cannot be undone"
                    icon={
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    }
                    onClose={!bulkDeleteLoading ? () => setConfirmBulkDelete(false) : undefined}
                />
                <Modal.Body>
                    <p style={{ color: 'var(--ui-text-secondary, #ccc)', fontSize: '0.85rem', lineHeight: 1.6, margin: 0 }}>
                        Permanently delete <strong>{bulkSelected.size} workflow{bulkSelected.size !== 1 ? 's' : ''}</strong> and all their execution history?
                    </p>
                    <div style={{
                        marginTop: 12,
                        padding: '0.75rem 1rem',
                        background: 'rgba(239, 68, 68, 0.08)',
                        borderRadius: '8px',
                        borderLeft: '3px solid var(--color-danger, #ef4444)',
                        fontSize: '0.8rem',
                        color: 'var(--ui-text-secondary, #ccc)',
                        lineHeight: 1.5
                    }}>
                        {workflows.filter(w => bulkSelected.has(w.id)).map(w => w.name).join(', ')}
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={() => setConfirmBulkDelete(false)} disabled={bulkDeleteLoading}>Cancel</Button>
                    <Button variant="danger" onClick={confirmAndBulkDelete} loading={bulkDeleteLoading}>
                        {bulkDeleteLoading ? 'Deleting...' : `Delete ${bulkSelected.size} Workflow${bulkSelected.size !== 1 ? 's' : ''}`}
                    </Button>
                </Modal.Footer>
            </Modal>

            {/* AEE-FULL Gap 4 — Listing-surface Cancel confirmation (Yes/No, no reason per SD-10) */}
            <Modal
                isOpen={!!confirmCancelExec}
                onClose={() => !listingCancelling && setConfirmCancelExec(null)}
                severity="warning"
                size="sm"
                closeOnOverlay={!listingCancelling}
                closeOnEscape={!listingCancelling}
            >
                <Modal.Header
                    title="Cancel Execution"
                    description={confirmCancelExec?.name ? `Stop ${confirmCancelExec.name}?` : 'Stop this execution?'}
                    onClose={!listingCancelling ? () => setConfirmCancelExec(null) : undefined}
                />
                <Modal.Body>
                    <div style={{ padding: '0.75rem 1rem', background: 'rgba(245, 158, 11, 0.08)', borderRadius: '8px', borderLeft: '3px solid var(--color-warning, #f59e0b)', fontSize: '0.8rem', color: 'var(--ui-text-secondary, #ccc)', lineHeight: 1.5 }}>
                        Cancelling will stop all in-progress nodes immediately.
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={() => setConfirmCancelExec(null)} disabled={listingCancelling}>Keep Running</Button>
                    <Button
                        variant="primary"
                        onClick={async () => {
                            if (!confirmCancelExec?.id) return;
                            setListingCancelling(true);
                            // SD-10 listing-surface: no reason — server stores reason: undefined
                            const result = await cancelExecution(confirmCancelExec.id, { authFetch });
                            setListingCancelling(false);
                            if (result.code === CANCEL_RESULT_CODES.OK || result.code === CANCEL_RESULT_CODES.ALREADY_TERMINAL) {
                                // Optimistically remove the row from runningNow; next poll will reconcile
                                setRunningNow(prev => prev.filter(e => e.id !== confirmCancelExec.id));
                            }
                            setConfirmCancelExec(null);
                        }}
                        loading={listingCancelling}
                    >
                        {listingCancelling ? 'Cancelling…' : 'Cancel Execution'}
                    </Button>
                </Modal.Footer>
            </Modal>

            {/* Edit Workflow Modal */}
            <WorkflowEditModal
                isOpen={!!editWorkflow}
                onClose={() => !editLoading && setEditWorkflow(null)}
                onSubmit={submitEditWorkflow}
                workflow={editWorkflow}
                scopes={myScopes || []}
                loading={editLoading}
            />

            {/* N8N-ERADICATE: Import from n8n — the one surviving n8n capability */}
            <N8nImportDialog
                isOpen={n8nImportOpen}
                onClose={() => setN8nImportOpen(false)}
                onOpenWorkflow={(workflowId) => {
                    loadWorkflows();
                    navigate(`/workflow-builder?id=${encodeURIComponent(workflowId)}`);
                }}
            />

            {/* P8.B.3 — Budget hard-stop dialog
                R3.med: Override button removed (Option A) — the button called
                doRunWorkflow directly with no override header, so the engine still
                rejected the request. Removing it avoids governance theatre.
                TODO(Option B): add X-Budget-Override header support on the engine
                execute route (admin role only, emits quox.budget.overridden envelope). */}
            <HardStopDialog
                open={!!hardStopGuard}
                onClose={() => setHardStopGuard(null)}
                scope={hardStopGuard?.guard?.exceeded?.length > 0 ? 'org' : ''}
                current={hardStopGuard?.guard?.current || {}}
                projected={hardStopGuard?.guard?.projected || {}}
                exceeded={hardStopGuard?.guard?.exceeded || []}
            />
        </div>
    );
}

export default WorkflowsView;
