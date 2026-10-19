/**
 * InboxItemDetailView — Full-page inbox item detail with embedded chat
 *
 * Layout: header banner + metadata ribbon + 2-column grid
 * (main content left, ChatEngine chat panel right) + sticky quick action bar.
 *
 * Replaces the old ItemDetailModal with a full-page experience.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useOutletContext, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useStepUp } from '../../hooks/useStepUp.jsx';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import Badge from '../../components/ui/Badge';
import InboxChatSidebar from '../../components/inbox/InboxChatSidebar';
import { getDecision } from '../../components/inbox/inboxFolders';
import { PayloadRenderer, AttachmentList, ResponseForm, CustomActions, PayloadSections, ApprovalContextBlock, getApprovalContext, stripContextMarkdown } from '../../components/inbox';
import MarkdownContent from '../../components/ui/MarkdownContent';
import { fetchUpstreamEnvelopes, resumeExecution } from '../../lib/inboxPausedHelpers.js';
import './views.css';

// Item kind configs (mirrors InboxView)
const ITEM_KINDS = {
    approval: { label: 'Approval', color: 'blue' },
    question: { label: 'Question', color: 'purple' },
    task: { label: 'Task', color: 'green' },
    incident: { label: 'Incident', color: 'red' },
    info: { label: 'Info', color: 'gray' },
    override_required: { label: 'Override', color: 'amber' }
};

const PRIORITIES = {
    urgent: { label: 'Urgent', color: 'red' },
    high: { label: 'High', color: 'amber' },
    normal: { label: 'Normal', color: 'blue' },
    low: { label: 'Low', color: 'gray' }
};

const STATUSES = {
    open: { label: 'Open', color: 'blue' },
    in_progress: { label: 'In Progress', color: 'amber' },
    waiting: { label: 'Waiting', color: 'purple' },
    resolved: { label: 'Resolved', color: 'green' },
    cancelled: { label: 'Cancelled', color: 'gray' },
    expired: { label: 'Expired', color: 'red' }
};

// Inline SVG icons
const Icons = {
    back: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>,
    check: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
    x: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
    send: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
    shield: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    alertTriangle: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    minusCircle: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>,
    chat: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    clock: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
    user: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    workflow: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    scope: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
    play: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
    externalLink: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
    gitBranch: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>,
    copy: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
};

// Normalises a raw payload.custom_actions entry into { action, label, style, value }.
// Defence-in-depth: tolerate bare-string actions even though the executor now
// normalises them. WEAVER + hand-edits can still produce ["Approve","Dismiss"]
// for legacy workflows that haven't been re-saved post-normalisation.
function normalizeCustomActions(customActions) {
    if (!Array.isArray(customActions)) return [];
    return customActions.map((action) => {
        if (typeof action === 'string') {
            return { action: action.toLowerCase().replace(/\s+/g, '_'), label: action, style: 'secondary' };
        }
        const a = action || {};
        const label = a.label || a.action || 'Action';
        return {
            action: a.action || label.toLowerCase().replace(/\s+/g, '_'),
            label,
            style: a.style || 'secondary',
            value: a.value,
        };
    });
}

function relativeTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
}

// =============================================================================
// WorkflowPausedPanel — renders for items with payload.source === 'human_task'
// =============================================================================

/**
 * Formats an envelope's output_preview payload for display.
 * Returns a truncated, readable string.
 */
function formatEnvelopeOutput(env) {
    const payload = env?.payload || {};
    // output or output_preview are the common keys
    const out = payload.output ?? payload.output_preview ?? payload;
    if (out === undefined || out === null) return '(no output)';
    try {
        const str = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return str.length > 600 ? str.slice(0, 600) + '\n…(truncated)' : str;
    } catch {
        return String(out).slice(0, 600);
    }
}

function WorkflowPausedPanel({ item, authFetch, navigate }) {
    const executionId = item.payload?.execution_id;
    const workflowId = item.payload?.workflow_id;
    const workflowName = item.payload?.workflow_name || item.workflow_name;
    const nodeId = item.payload?.node_id;
    const nodeName = item.payload?.node_name || nodeId;
    const customActions = item.payload?.custom_actions;
    const pipelineInput = item.payload?.pipeline_input;

    // Upstream envelopes
    const [upstreamEnvelopes, setUpstreamEnvelopes] = useState(null); // null = loading
    const [envelopeError, setEnvelopeError] = useState(null);

    // Resume state
    const [resumeLoading, setResumeLoading] = useState(null); // action string while loading
    const [resumeError, setResumeError] = useState(null);
    const [resumeSuccess, setResumeSuccess] = useState(false);
    const [pendingResumeAction, setPendingResumeAction] = useState(null);
    const [resumeFields, setResumeFields] = useState({});
    const [resumeComment, setResumeComment] = useState('');

    // Copy feedback
    const [copiedIdx, setCopiedIdx] = useState(null);

    const { user } = useAuth?.() || {};

    useEffect(() => {
        if (!executionId) {
            setUpstreamEnvelopes([]);
            return;
        }
        let cancelled = false;
        fetchUpstreamEnvelopes(executionId, nodeId).then(({ envelopes, error }) => {
            if (cancelled) return;
            setUpstreamEnvelopes(envelopes);
            if (error) setEnvelopeError(error);
        });
        return () => { cancelled = true; };
    }, [executionId, nodeId]);

    const handleCopy = (text, idx) => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 1500);
    };

    const handleResumeAction = async (actionValue) => {
        if (!authFetch || !executionId) return;

        // Check if this custom action has perAction fields from responseSchema
        const responseSchema = item.payload?.response_schema;
        const perActionFields = responseSchema?.perAction?.[actionValue]?.fields;
        if (perActionFields?.length > 0 && !pendingResumeAction) {
            // Show inline form first
            setPendingResumeAction(actionValue);
            setResumeFields({});
            return;
        }

        setResumeLoading(actionValue);
        setResumeError(null);
        const result = await resumeExecution({
            authFetch,
            executionId,
            action: actionValue,
            approver: user?.email || user?.id || 'user',
            fields: Object.keys(resumeFields).length > 0 ? resumeFields : undefined,
            comment: resumeComment || undefined,
        });
        setResumeLoading(null);

        if (result.success) {
            setResumeSuccess(true);
            setPendingResumeAction(null);
            // Navigate to execution detail after short delay so user sees success
            setTimeout(() => {
                if (executionId) navigate(`/executions/${executionId}`);
            }, 900);
        } else {
            setResumeError(result.error || 'Resume failed');
        }
    };

    // Determine action buttons: use custom_actions if defined, else generic approve/reject
    const actionButtons = Array.isArray(customActions) && customActions.length > 0
        ? normalizeCustomActions(customActions)
        : [
            { action: 'approve', label: 'Approve', style: 'primary' },
            { action: 'reject', label: 'Reject', style: 'danger' },
        ];

    if (resumeSuccess) {
        return (
            <div className="inbox-item-detail__section">
                <div className="inbox-paused-panel__success">
                    {Icons.play} Workflow resumed — navigating to execution…
                </div>
            </div>
        );
    }

    return (
        <>
            {/* Workflow header with links */}
            <div className="inbox-item-detail__section">
                <h3 className="inbox-item-detail__section-title">
                    {Icons.gitBranch} Paused Workflow Run
                </h3>
                <div className="inbox-item-detail__workflow-info">
                    {workflowName && (
                        <div>
                            Workflow: <strong>{workflowName}</strong>
                            {workflowId && executionId && (
                                <>
                                    {' '}
                                    <a
                                        className="inbox-item-detail__exec-link"
                                        href={`/workflows-hub?tab=build&id=${workflowId}&executionId=${executionId}`}
                                        onClick={e => { e.preventDefault(); navigate(`/workflows-hub?tab=build&id=${workflowId}&executionId=${executionId}`); }}
                                    >
                                        Open in Builder {Icons.externalLink}
                                    </a>
                                </>
                            )}
                        </div>
                    )}
                    {nodeName && <div>Paused at node: <code>{nodeName}</code></div>}
                    {executionId && (
                        <div>
                            Run: <code>{executionId.slice(0, 16)}…</code>
                            {' '}
                            <a
                                className="inbox-item-detail__exec-link"
                                href={`/executions/${executionId}`}
                                onClick={e => { e.preventDefault(); navigate(`/executions/${executionId}`); }}
                            >
                                View Execution {Icons.externalLink}
                            </a>
                        </div>
                    )}
                </div>
            </div>

            {/* Upstream node outputs */}
            <div className="inbox-item-detail__section">
                <h3 className="inbox-item-detail__section-title">Upstream Node Outputs</h3>
                {upstreamEnvelopes === null && (
                    <div className="inbox-paused-panel__loading">Loading upstream outputs…</div>
                )}
                {envelopeError && (
                    <div className="inbox-paused-panel__error">{envelopeError}</div>
                )}
                {upstreamEnvelopes !== null && upstreamEnvelopes.length === 0 && !envelopeError && (
                    pipelineInput !== undefined && pipelineInput !== null ? (
                        <div className="inbox-paused-panel__env-card">
                            <div className="inbox-paused-panel__env-header">
                                <span className="inbox-paused-panel__env-label">Pipeline input (passed to this node)</span>
                            </div>
                            <pre className="inbox-paused-panel__env-output">{
                                (() => {
                                    try {
                                        const s = typeof pipelineInput === 'string' ? pipelineInput : JSON.stringify(pipelineInput, null, 2);
                                        return s.length > 600 ? s.slice(0, 600) + '\n…(truncated)' : s;
                                    } catch { return String(pipelineInput); }
                                })()
                            }</pre>
                        </div>
                    ) : (
                        <div className="inbox-paused-panel__empty">No upstream node outputs found.</div>
                    )
                )}
                {upstreamEnvelopes !== null && upstreamEnvelopes.map((env, idx) => {
                    const output = formatEnvelopeOutput(env);
                    const nodeLabel = env?.payload?.nodeId || env?.payload?.node_id || `node-${idx}`;
                    return (
                        <div key={idx} className="inbox-paused-panel__env-card">
                            <div className="inbox-paused-panel__env-header">
                                <span className="inbox-paused-panel__env-label">{nodeLabel}</span>
                                <span className="inbox-paused-panel__env-ts">{relativeTime(env.ts)}</span>
                                <button
                                    className="inbox-paused-panel__copy-btn"
                                    onClick={() => handleCopy(output, idx)}
                                    title="Copy output"
                                >
                                    {copiedIdx === idx ? Icons.check : Icons.copy}
                                </button>
                            </div>
                            <pre className="inbox-paused-panel__env-output">{output}</pre>
                        </div>
                    );
                })}
            </div>

            {/* Response action panel */}
            <div className="inbox-item-detail__section">
                <h3 className="inbox-item-detail__section-title">Respond to Workflow</h3>
                <div className="inbox-paused-panel__comment-row">
                    <textarea
                        className="response-dock__textarea"
                        placeholder="Add context or notes (optional)…"
                        value={resumeComment}
                        onChange={e => setResumeComment(e.target.value)}
                        rows={2}
                        style={{ marginBottom: 8 }}
                        disabled={!!resumeLoading}
                    />
                </div>

                {/* Pending action form (perAction fields) */}
                {pendingResumeAction && (() => {
                    const responseSchema = item.payload?.response_schema;
                    const fields = responseSchema?.perAction?.[pendingResumeAction]?.fields || [];
                    return (
                        <div className="response-dock__action-form">
                            <div className="response-dock__action-form-header">
                                {pendingResumeAction}
                                <button
                                    className="response-dock__action-form-cancel"
                                    onClick={() => { setPendingResumeAction(null); setResumeFields({}); }}
                                >
                                    Cancel
                                </button>
                            </div>
                            {fields.map(field => (
                                <div key={field.name} className="response-dock__action-field">
                                    <label className="response-dock__action-label">
                                        {field.label || field.name}
                                        {field.required && <span className="response-dock__required-mark"> *</span>}
                                    </label>
                                    {field.type === 'textarea' ? (
                                        <textarea
                                            className="response-dock__action-input"
                                            value={resumeFields[field.name] || ''}
                                            onChange={e => setResumeFields(f => ({ ...f, [field.name]: e.target.value }))}
                                            rows={3}
                                        />
                                    ) : field.type === 'select' ? (
                                        <select
                                            className="response-dock__action-input"
                                            value={resumeFields[field.name] || ''}
                                            onChange={e => setResumeFields(f => ({ ...f, [field.name]: e.target.value }))}
                                        >
                                            <option value="">Select…</option>
                                            {(field.options || []).map(opt => (
                                                <option key={opt} value={opt}>{opt}</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            className="response-dock__action-input"
                                            type={field.type || 'text'}
                                            value={resumeFields[field.name] || ''}
                                            onChange={e => setResumeFields(f => ({ ...f, [field.name]: e.target.value }))}
                                            placeholder={field.placeholder || ''}
                                        />
                                    )}
                                </div>
                            ))}
                            <button
                                className="response-dock__btn response-dock__btn--approve"
                                onClick={() => handleResumeAction(pendingResumeAction)}
                                disabled={!!resumeLoading}
                            >
                                {resumeLoading === pendingResumeAction ? 'Resuming…' : 'Submit & Resume'}
                            </button>
                        </div>
                    );
                })()}

                {/* Action buttons */}
                {!pendingResumeAction && (
                    <div className="response-dock__actions" style={{ marginTop: 8 }}>
                        <CustomActions
                            actions={actionButtons}
                            onAction={(actionValue) => handleResumeAction(actionValue)}
                            disabled={!!resumeLoading}
                            loadingAction={resumeLoading}
                            loadingLabel="Resuming…"
                            variant="btn"
                        />
                    </div>
                )}

                {resumeError && (
                    <div className="response-dock__error" style={{ marginTop: 8 }}>
                        {Icons.alertTriangle} {resumeError}
                    </div>
                )}
            </div>
        </>
    );
}

function InboxItemDetailView() {
    const { itemId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { halState } = useOutletContext() || {};
    const { authFetch } = useAuth();
    const { stepUpFetch, stepUpModal } = useStepUp(authFetch); // QUOXON-STEPUP
    const { currentOrg } = useWorkspace();

    // org_id passed from the list view when clicking through; lets us scope
    // the lookup correctly when the workspace currentOrg differs from the
    // item's org (multi-org inbox).
    const navStateOrgId = location.state?.orgId || null;

    const [item, setItem] = useState(null);
    const [assignees, setAssignees] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [actionLoading, setActionLoading] = useState(null);
    const [responseFormData, setResponseFormData] = useState(null);
    const [commentText, setCommentText] = useState('');
    const [actionError, setActionError] = useState(null);
    const [pendingAction, setPendingAction] = useState(null); // action awaiting form completion
    const [actionFormData, setActionFormData] = useState({});
    const [actionFormErrors, setActionFormErrors] = useState({});
    // Locked to the item's actual org once loaded — drives all action calls.
    const [effectiveOrgId, setEffectiveOrgId] = useState(navStateOrgId || currentOrg?.id || null);

    // Fetch item
    useEffect(() => {
        const fetchItem = async () => {
            if (!itemId) {
                setLoading(false);
                return;
            }
            setLoading(true);
            setError(null);
            try {
                const targetOrgId = navStateOrgId || currentOrg?.id || null;
                let response = targetOrgId
                    ? await authFetch(`/api/orgs/${targetOrgId}/inbox/${itemId}`)
                    : await authFetch(`/api/inbox/items/${itemId}`);
                // Direct URL with stale workspace context — fall back to the
                // cross-org lookup so pasted links always resolve.
                if (response.status === 404 && targetOrgId) {
                    response = await authFetch(`/api/inbox/items/${itemId}`);
                }
                if (!response.ok) {
                    if (response.status === 404) {
                        setError('not_found');
                    } else {
                        throw new Error('Failed to load item');
                    }
                    return;
                }
                const data = await response.json();
                setItem(data.item);
                setAssignees(data.assignees || []);
                if (data.item?.org_id) {
                    setEffectiveOrgId(data.item.org_id);
                }
            } catch (err) {
                console.error('Failed to load inbox item:', err);
                setError('Failed to load inbox item. Please try again.');
            } finally {
                setLoading(false);
            }
        };
        fetchItem();
    }, [itemId, currentOrg, navStateOrgId, authFetch]);

    // Get per-action fields from response schema
    const getActionFields = (actionValue) => {
        if (!responseSchema?.perAction) return null;
        const actionConfig = responseSchema.perAction[actionValue];
        if (!actionConfig?.fields?.length) return null;
        return actionConfig.fields;
    };

    // Handle quick action (with optional form data or direct value)
    const handleAction = async (actionValue, directData) => {
        if (!effectiveOrgId || !item) return;
        // Double-click guard: a decision is already in flight for this item.
        if (actionLoading) return;

        // Check if this action has required form fields
        const fields = getActionFields(actionValue);
        if (fields && !pendingAction) {
            // Show the form fields first — don't submit yet
            setPendingAction(actionValue);
            setActionFormData({});
            setActionFormErrors({});
            return;
        }

        // Validate form fields if pending
        if (pendingAction && fields) {
            const errors = {};
            for (const f of fields) {
                if (f.required && !actionFormData[f.name]) {
                    errors[f.name] = `${f.label || f.name} is required`;
                }
            }
            if (Object.keys(errors).length > 0) {
                setActionFormErrors(errors);
                return;
            }
        }

        setPendingAction(null);
        setActionLoading(actionValue);
        const body = { action: actionValue, comment: commentText || '' };
        const formData = pendingAction ? actionFormData : null;
        if (directData) {
            body.data = directData;
        } else if (formData && Object.keys(formData).length > 0) {
            body.data = { ...responseFormData, ...formData };
        } else if (responseFormData) {
            body.data = responseFormData;
        }

        // Optimistic UI: flip the item locally so the user sees instant
        // resolution. The respond POST runs in the background — backend work
        // (notifications, AOCL audit, workflow resume) shouldn't block the
        // user from moving on. Roll back if the request errors.
        const previousItem = item;
        const previousComment = commentText;
        const nowIso = new Date().toISOString();
        setItem({
            ...item,
            status: 'resolved',
            response: { action: actionValue, comment: commentText || '', responded_at: nowIso },
            resolved_at: nowIso
        });
        setCommentText('');

        // Guarantee this can't hang forever: abort after 12s so a dropped
        // response always triggers the rollback below instead of leaving the
        // optimistic "resolved" state stuck with no error surfaced.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        try {
            const response = await stepUpFetch(`/api/orgs/${effectiveOrgId}/inbox/${itemId}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            }, { subject: { line1: item?.title ? `approve: ${item.title}` : 'approve this item' } });
            if (!response.ok) {
                // Rollback optimistic state
                setItem(previousItem);
                setCommentText(previousComment);
                const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                setActionError(err.error || err.message || 'Action failed');
                setTimeout(() => setActionError(null), 5000);
            } else {
                // A stale approval is refused server-side: show expired, not approved.
                const out = await response.json().catch(() => ({}));
                if (out?.item?.status === 'expired') {
                    setItem((it) => (it ? { ...it, status: 'expired' } : it));
                    setActionError(out.message || 'This approval had expired, so nothing ran.');
                }
            }
        } catch (err) {
            setItem(previousItem);
            setCommentText(previousComment);
            const isTimeout = err?.name === 'AbortError';
            setActionError(isTimeout ? 'Request timed out, please retry' : (err.message || 'Failed to perform action'));
            setTimeout(() => setActionError(null), 5000);
        } finally {
            clearTimeout(timeoutId);
            setActionLoading(null);
        }
    };

    // Loading skeleton
    if (loading) {
        return (
            <div className="inbox-item-detail view-page" style={{ flexDirection: 'row' }}>
                <div className="inbox-item-detail__main">
                    <div className="inbox-item-detail__scroll">
                        <div className="inbox-item-detail__header-row">
                            <button className="inbox-item-detail__back" onClick={() => navigate('/inbox')}>
                                {Icons.back} Back
                            </button>
                            <div className="inbox-item-detail__skeleton-header" />
                        </div>
                        <div className="inbox-item-detail__skeleton-ribbon" />
                        <div className="inbox-item-detail__skeleton-block" />
                        <div className="inbox-item-detail__skeleton-block" style={{ height: 400 }} />
                    </div>
                </div>
            </div>
        );
    }

    // Error / not found
    if (error) {
        return (
            <div className="inbox-item-detail view-page" style={{ flexDirection: 'row' }}>
                <div className="inbox-item-detail__main">
                    <div className="inbox-item-detail__scroll">
                        <div className="inbox-item-detail__header-row">
                            <button className="inbox-item-detail__back" onClick={() => navigate('/inbox')}>
                                {Icons.back} Back to Inbox
                            </button>
                        </div>
                        <div className="entity-empty-state">
                            <div className="entity-empty-state__icon" style={{ color: error === 'not_found' ? 'var(--ui-text-secondary)' : 'var(--color-danger)' }}>
                                {error === 'not_found' ? Icons.minusCircle : Icons.alertTriangle}
                            </div>
                            <div className="entity-empty-state__title">
                                {error === 'not_found' ? 'Item Not Found' : 'Error Loading Item'}
                            </div>
                            <div className="entity-empty-state__description">
                                {error === 'not_found'
                                    ? 'This inbox item may have been deleted or you don\'t have access.'
                                    : error}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (!item) return null;

    const kindConfig = ITEM_KINDS[item.kind] || ITEM_KINDS.info;
    const priorityConfig = PRIORITIES[item.priority] || PRIORITIES.normal;
    const statusConfig = STATUSES[item.status] || STATUSES.open;
    const isResolvable = ['open', 'in_progress', 'waiting'].includes(item.status);

    // Check for custom actions and response schema in payload
    const customActions = item.payload?.custom_actions;
    const responseSchema = item.payload?.response_schema;
    const hasCustomActions = Array.isArray(customActions) && customActions.length > 0;
    const normalizedCustomActions = normalizeCustomActions(customActions);

    // Shared onAction handler for every CustomActions render site on this page —
    // preserves the selected_value merge behaviour the response dock always had.
    const handleCustomAction = (actionId, value) => {
        const data = value !== undefined
            ? { ...responseFormData, selected_value: value }
            : responseFormData || undefined;
        handleAction(actionId, data);
    };

    // Determine which action buttons are applicable for this kind
    const actionButtons = getActionButtons(item.kind, isResolvable);

    return (
        <div className="inbox-item-detail view-page" style={{ flexDirection: 'row' }}>
            {stepUpModal}
            {/* LEFT: Main content column */}
            <div className="inbox-item-detail__main">
              <div className="inbox-item-detail__scroll">
                    {/* Back + Title + Meta — inside scroll area */}
                    <div className="inbox-item-detail__header-row">
                        <button className="inbox-item-detail__back" onClick={() => navigate('/inbox')}>
                            {Icons.back} Back
                        </button>
                        <div className="inbox-item-detail__kind-icon" style={{ color: `var(--ui-${kindConfig.color}, #a855f7)` }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                {item.kind === 'approval' && <polyline points="20 6 9 17 4 12"/>}
                                {item.kind === 'question' && <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>}
                                {item.kind === 'task' && <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></>}
                                {item.kind === 'incident' && <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>}
                                {item.kind === 'override_required' && <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>}
                                {(item.kind === 'info' || !ITEM_KINDS[item.kind]) && <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>}
                            </svg>
                        </div>
                        <h1 className="inbox-item-detail__title">{item.title}</h1>
                        <div className="inbox-item-detail__badges">
                            <Badge variant={kindConfig.color} size="sm">{kindConfig.label}</Badge>
                            <Badge variant={priorityConfig.color} size="sm">{priorityConfig.label}</Badge>
                            <Badge variant={statusConfig.color} size="sm">{statusConfig.label}</Badge>
                            {/* P8.C: Policy-injected approval badge */}
                            {item.payload?.policy_injected && (
                                <span
                                    className="qx-pill qx-pill--warn qx-pill--sm"
                                    title={`Governance-injected by policy: ${item.payload?.policy_id || ''}`}
                                    style={{ fontFamily: 'var(--qx-font-mono)', letterSpacing: 0.5 }}
                                >
                                    policy: {item.payload?.policy_name || item.payload?.policy_id || 'governance'}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="inbox-item-detail__meta-ribbon">
                        {item.created_by_name && <span className="inbox-item-detail__meta-item">{Icons.user} {item.created_by_name}</span>}
                        <span className="inbox-item-detail__meta-item">{Icons.clock} {relativeTime(item.created_at)}</span>
                        {item.workflow_name && <span className="inbox-item-detail__meta-item">{Icons.workflow} {item.workflow_name}</span>}
                        {assignees.length > 0 && <span className="inbox-item-detail__meta-item">{Icons.user} {assignees.map(a => a.user_name || a.user_email || a.assignee_id).join(', ')}</span>}
                        {(item.scope_name || item.inbox_name) && <span className="inbox-item-detail__meta-item">{Icons.scope} {item.scope_name || item.inbox_name}</span>}
                    </div>

                    {/* Quick action bar — always visible at top for actionable items.
                        Custom actions (from payload.custom_actions) take over here so an
                        item like an X post shows Post/Discard, never the generic
                        Approve/Deny/Dismiss underneath them. */}
                    {isResolvable && (
                        <div className="inbox-item-detail__quick-actions">
                            {hasCustomActions ? (
                                <CustomActions
                                    actions={normalizedCustomActions}
                                    onAction={handleCustomAction}
                                    disabled={actionLoading !== null}
                                    loadingAction={actionLoading}
                                    variant="quick"
                                />
                            ) : (
                                actionButtons.filter(b => b.enabled).map(btn => (
                                    <button
                                        key={btn.value}
                                        className={`inbox-item-detail__quick-btn inbox-item-detail__quick-btn--${btn.variant}`}
                                        disabled={actionLoading !== null}
                                        onClick={() => handleAction(btn.value)}
                                    >
                                        {btn.icon}
                                        {actionLoading === btn.value ? 'Processing...' : btn.label}
                                    </button>
                                ))
                            )}
                        </div>
                    )}

                    {/* Post-approval: Watch button for BrowserQ objectives */}
                    {!isResolvable && item?.response?.action === 'approved' && item?.payload?.source === 'browser-q' && (
                        <div className="inbox-item-detail__quick-actions">
                            <button
                                className="inbox-item-detail__quick-btn inbox-item-detail__quick-btn--approve"
                                onClick={() => navigate('/browser-q')}
                            >
                                {Icons.eye || '\u25B6'} Watch Live
                            </button>
                        </div>
                    )}

                    {/* HITL-CONTEXT: who asked, on whose behalf, why, how, what stopped it */}
                    {getApprovalContext(item) && (
                        <div className="inbox-item-detail__section">
                            <ApprovalContextBlock context={getApprovalContext(item)} />
                        </div>
                    )}

                    {/* Description */}
                    {item.body_md && (
                        <div className="inbox-item-detail__section">
                            <h3 className="inbox-item-detail__section-title">Description</h3>
                            <MarkdownContent>{getApprovalContext(item) ? stripContextMarkdown(item.body_md) : item.body_md}</MarkdownContent>
                        </div>
                    )}

                    {/* Paused workflow panel — replaces generic payload/workflow sections for human_task items */}
                    {item.payload?.source === 'human_task' && isResolvable && (
                        <WorkflowPausedPanel
                            item={item}
                            authFetch={authFetch}
                            navigate={navigate}
                        />
                    )}

                    {/* Payload — suppressed for human_task (WorkflowPausedPanel renders the rich view) */}
                    {item.payload && Object.keys(item.payload).length > 0 && item.payload?.source !== 'human_task' && (
                        <div className="inbox-item-detail__section">
                            <h3 className="inbox-item-detail__section-title">Request Details</h3>
                            <PayloadRenderer payload={item.payload} />
                        </div>
                    )}

                    {/* Collapsible Sections */}
                    {Array.isArray(item.payload?.sections) && item.payload.sections.length > 0 && (
                        <div className="inbox-item-detail__section">
                            <h3 className="inbox-item-detail__section-title">Details</h3>
                            <PayloadSections sections={item.payload.sections} />
                        </div>
                    )}

                    {/* Attachments */}
                    {Array.isArray(item.payload?.attachments) && item.payload.attachments.length > 0 && (
                        <div className="inbox-item-detail__section">
                            <AttachmentList attachments={item.payload.attachments} />
                        </div>
                    )}

                    {/* Workflow info — suppressed for human_task (WorkflowPausedPanel renders it) */}
                    {(item.workflow_name || item.run_id) && item.payload?.source !== 'human_task' && (
                        <div className="inbox-item-detail__section">
                            <h3 className="inbox-item-detail__section-title">Workflow Info</h3>
                            <div className="inbox-item-detail__workflow-info">
                                {item.workflow_name && <div>Workflow: <strong>{item.workflow_name}</strong></div>}
                                {item.run_id && (
                                    <div>
                                        Run: <code>{item.run_id}</code>
                                        {' '}
                                        <a
                                            className="inbox-item-detail__exec-link"
                                            href={`/executions/${item.run_id}`}
                                            onClick={(e) => { e.preventDefault(); navigate(`/executions/${item.run_id}`); }}
                                        >
                                            View Execution
                                        </a>
                                    </div>
                                )}
                                {item.run_status && <div>Run Status: <strong>{item.run_status}</strong></div>}
                            </div>
                        </div>
                    )}

                    {/* Response history (for resolved items) */}
                    {item.response && (
                        <div className="inbox-item-detail__section">
                            <h3 className="inbox-item-detail__section-title">Resolution</h3>
                            <div className="inbox-item-detail__response-history">
                                <div className="inbox-item-detail__response-action">
                                    {getDecision(item)?.label || item.response.action || 'Resolved'}
                                </div>
                                {item.response.comment && (
                                    <div className="inbox-item-detail__response-comment">
                                        {item.response.comment}
                                    </div>
                                )}
                                <div className="inbox-item-detail__response-meta">
                                    {(item.resolved_by_name || item.response.responded_by) && `by ${item.resolved_by_name || item.response.responded_by}`}
                                    {(item.resolved_at || item.response.responded_at) && ` — ${relativeTime(item.resolved_at || item.response.responded_at)}`}
                                </div>
                            </div>
                        </div>
                    )}
                    {/* Response Form */}
                    {isResolvable && responseSchema && !responseSchema.perAction && responseSchema.fields?.length > 0 && (
                        <ResponseForm
                            schema={responseSchema}
                            onSubmit={(data) => setResponseFormData(data)}
                            disabled={actionLoading !== null}
                        />
                    )}

                    {/* Resolved indicator */}
                    {!isResolvable && item?.response && (
                        <div className="response-dock response-dock--resolved">
                            <div className="response-dock__resolved">
                                {Icons.check}
                                <span>
                                    <strong>{item.response.action || 'Resolved'}</strong>
                                    {item.resolved_by_name && ` by ${item.resolved_by_name}`}
                                    {item.response.comment && ` — "${item.response.comment}"`}
                                </span>
                            </div>
                        </div>
                    )}

              </div>{/* end scroll area */}

                    {/* Response Dock — outside scroll area, always visible at bottom */}
                    {isResolvable && (
                        <div className="response-dock">
                    <div className="response-dock__input">
                        <textarea
                            className="response-dock__textarea"
                            placeholder={hasCustomActions
                                ? "Select an option below, or type your response..."
                                : "Add context to your decision (optional)..."}
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
                            disabled={actionLoading !== null}
                            rows={1}
                            onInput={(e) => {
                                e.target.style.height = 'auto';
                                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    // Custom actions take priority: never submit the generic
                                    // "approve" action for an item that defines its own options.
                                    if (hasCustomActions) {
                                        const firstCustom = normalizedCustomActions[0];
                                        if (firstCustom) handleCustomAction(firstCustom.action, firstCustom.value);
                                        return;
                                    }
                                    const firstBtn = actionButtons.find(b => b.enabled);
                                    if (firstBtn) handleAction(firstBtn.value);
                                }
                            }}
                        />
                        {commentText && (
                            <span className="response-dock__hint">
                                {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to submit
                            </span>
                        )}
                    </div>

                    {/* Custom options row */}
                    {hasCustomActions && (
                        <CustomActions
                            actions={normalizedCustomActions}
                            onAction={handleCustomAction}
                            disabled={actionLoading !== null}
                            loadingAction={actionLoading}
                            variant="chip"
                        />
                    )}

                    {/* Error feedback */}
                    {actionError && (
                        <div className="response-dock__error">
                            {actionError}
                        </div>
                    )}

                    {/* Conditional form fields for pending action */}
                    {pendingAction && (() => {
                        const fields = getActionFields(pendingAction);
                        if (!fields) return null;
                        return (
                            <div className="response-dock__action-form">
                                <div className="response-dock__action-form-header">
                                    {pendingAction}
                                    <button
                                        className="response-dock__action-form-cancel"
                                        onClick={() => { setPendingAction(null); setActionFormData({}); setActionFormErrors({}); }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                                {fields.map(field => {
                                    const FieldComponent = field.type === 'textarea' ? 'textarea' : 'input';
                                    return (
                                        <div key={field.name} className="response-dock__action-field">
                                            <label className="response-dock__action-label">
                                                {field.label || field.name}
                                                {field.required && <span className="response-dock__required-mark"> *</span>}
                                            </label>
                                            {field.type === 'select' ? (
                                                <select
                                                    className="response-dock__action-input"
                                                    value={actionFormData[field.name] || ''}
                                                    onChange={e => setActionFormData(d => ({ ...d, [field.name]: e.target.value }))}
                                                >
                                                    <option value="">Select...</option>
                                                    {(field.options || []).map(opt => (
                                                        <option key={opt} value={opt}>{opt}</option>
                                                    ))}
                                                </select>
                                            ) : (
                                                <FieldComponent
                                                    className="response-dock__action-input"
                                                    type={field.type === 'textarea' ? undefined : (field.type || 'text')}
                                                    value={actionFormData[field.name] || ''}
                                                    onChange={e => setActionFormData(d => ({ ...d, [field.name]: e.target.value }))}
                                                    placeholder={field.placeholder || ''}
                                                    rows={field.type === 'textarea' ? 3 : undefined}
                                                />
                                            )}
                                            {actionFormErrors[field.name] && (
                                                <div className="response-dock__field-error">{actionFormErrors[field.name]}</div>
                                            )}
                                        </div>
                                    );
                                })}
                                <button
                                    className="response-dock__btn response-dock__btn--approve"
                                    onClick={() => handleAction(pendingAction)}
                                    disabled={actionLoading !== null}
                                >
                                    {actionLoading === pendingAction ? 'Processing...' : 'Submit'}
                                </button>
                            </div>
                        );
                    })()}

                    {/* Action buttons */}
                    <div className="response-dock__actions">
                        {!hasCustomActions && actionButtons.map(btn => (
                            <button
                                key={btn.value}
                                className={`response-dock__btn response-dock__btn--${btn.variant}`}
                                disabled={!btn.enabled || actionLoading !== null}
                                onClick={() => handleAction(btn.value)}
                                title={btn.enabled ? btn.label : `Not applicable for ${kindConfig.label} items`}
                            >
                                {btn.icon}
                                {actionLoading === btn.value ? 'Processing...' : btn.label}
                            </button>
                        ))}
                        {item?.kind === 'approval' && (
                            <>
                                <div className="response-dock__spacer" />
                                <button
                                    className="response-dock__btn response-dock__btn--warning"
                                    disabled={actionLoading !== null}
                                    onClick={() => handleAction('request_changes')}
                                >
                                    {Icons.alertTriangle}
                                    {actionLoading === 'request_changes' ? 'Processing...' : 'Request Changes'}
                                </button>
                                {/* Only show explicit Approve when custom actions hide the default buttons */}
                                {hasCustomActions && (
                                    <button
                                        className="response-dock__btn response-dock__btn--approve"
                                        disabled={actionLoading !== null}
                                        onClick={() => handleAction('approved')}
                                    >
                                        {Icons.check}
                                        {actionLoading === 'approved' ? 'Processing...' : 'Approve'}
                                    </button>
                                )}
                            </>
                        )}
                        {/* Dismiss for custom-actions-only items (no default buttons rendered) */}
                        {hasCustomActions && item?.kind !== 'approval' && (
                            <button
                                className="response-dock__btn response-dock__btn--deny"
                                disabled={actionLoading !== null}
                                onClick={() => handleAction('dismissed')}
                            >
                                {Icons.minusCircle}
                                Dismiss
                            </button>
                        )}
                    </div>
                    </div>
                    )}
                </div>

            {/* RIGHT: TRIAGE-Q agent chat sidebar — full page height */}
            <div className="inbox-item-detail__sidebar">
                <InboxChatSidebar
                    selectedItem={item}
                    items={[item]}
                />
            </div>
        </div>
    );
}

/**
 * Build action buttons matching what the original modal supported per kind.
 * Only real backend actions — no fantasy features.
 *
 * approval:          Approve / Deny
 * question:          Submit Answer
 * task:              Mark Complete
 * incident:          Resolve Incident
 * override_required: Grant Override / Reject Override
 * info:              Dismiss (resolve with no action)
 */
function getActionButtons(kind, isResolvable) {
    const buttons = [];

    if (kind === 'approval') {
        buttons.push(
            { value: 'approved', label: 'Approve', variant: 'approve', icon: Icons.check, enabled: isResolvable },
            { value: 'denied', label: 'Deny', variant: 'deny', icon: Icons.x, enabled: isResolvable },
        );
    } else if (kind === 'question') {
        buttons.push(
            { value: 'answered', label: 'Submit Answer', variant: 'resolve', icon: Icons.send, enabled: isResolvable },
        );
    } else if (kind === 'task') {
        buttons.push(
            { value: 'completed', label: 'Mark Complete', variant: 'approve', icon: Icons.check, enabled: isResolvable },
        );
    } else if (kind === 'incident') {
        buttons.push(
            { value: 'resolved', label: 'Resolve Incident', variant: 'resolve', icon: Icons.shield, enabled: isResolvable },
        );
    } else if (kind === 'override_required') {
        buttons.push(
            { value: 'rejected', label: 'Reject Override', variant: 'deny', icon: Icons.x, enabled: isResolvable },
            { value: 'override_granted', label: 'Grant Override', variant: 'override', icon: Icons.alertTriangle, enabled: isResolvable },
        );
    }

    // Dismiss is always available — just resolves with no specific action
    buttons.push(
        { value: 'dismissed', label: 'Dismiss', variant: 'deny', icon: Icons.minusCircle, enabled: isResolvable },
    );

    return buttons;
}

export default InboxItemDetailView;
