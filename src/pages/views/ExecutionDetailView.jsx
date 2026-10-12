/**
 * ExecutionDetailView - Execution Detail Page
 *
 * Shows detailed information about a single QuoxFlow workflow execution.
 * Routed at /executions/:id
 *
 * Features:
 * - Execution metadata header (workflow name, status, timing, ID)
 * - Node-by-node timeline from AEE envelope data
 * - Collapsible input/output data per node step
 * - Loading, error, and empty states
 */

import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getExecution, getExecutionEnvelopes, getWorkflow, packageCrystalFromExecution } from '../../services/quoxflowClient';
import { listObservations, listQuoxflowEvidence } from '../../services/observationsClient';
import { groupEvidenceByNode, formatObservation } from '../../lib/executionDetailHelpers.js';
import { useAuth } from '../../contexts/AuthContext';
import EvolutionStagePill from '../../components/automation/EvolutionStagePill';
import { hasTier } from '../../services/licenseValidator';
import { executeWorkflow } from '../../services/workflowEngine';
import { createEvent } from '../../lib/aee/envelope';
import { QUOXFLOW_INTENTS } from '../../lib/aee/intents';
import { storeEnvelope, storeEnvelopes } from '../../lib/aee/store';
import { prefixedUlid } from '../../lib/aee/ulid';
import Modal from '../../components/ui/Modal';
import Button from '../../components/ui/Button';
// AEE-FULL Gap 4: status config (incl. 'cancelled') extracted to a shared lib
// so WorkflowsView and any future surface use the same source of truth.
import { EXECUTION_STATUS_CONFIG as STATUS_CONFIG } from '../../lib/aee/executionStatus.js';
import { cancelExecution, CANCEL_RESULT_CODES } from '../../services/executionCancelService.js';
import ExecutionWaterfall from '../../components/workflow/ExecutionWaterfall';
import './views.css';

// SVG Icons
const BackIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
    </svg>
);

const ChevronDownIcon = ({ open }) => (
    <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease'
        }}
    >
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

const PlayIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
);

const ClockIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
    </svg>
);


/**
 * Calculate human-readable duration between two ISO timestamps.
 */
function formatDuration(startedAt, completedAt) {
    if (!startedAt) return '--';
    const start = new Date(startedAt);
    const end = completedAt ? new Date(completedAt) : new Date();
    const diffMs = end - start;

    if (diffMs < 1000) return `${diffMs}ms`;
    if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);
    return `${mins}m ${secs}s`;
}

/**
 * Format an ISO timestamp for display.
 */
function formatTimestamp(ts) {
    if (!ts) return '--';
    const date = new Date(ts);
    return date.toLocaleString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * Derive a status for an envelope step based on its type/payload.
 */
function getEnvelopeStatus(envelope) {
    const type = (envelope.type || '').toLowerCase();
    if (type === 'error') return 'error';
    if (type === 'result') return 'success';
    if (type === 'event') return 'success';
    if (type === 'stream') return 'pending';
    return 'pending';
}

const ENVELOPE_STATUS_LABELS = {
    success: 'OK',
    error: 'ERR',
    pending: '...'
};

/**
 * Collapsible JSON data viewer.
 */
function DataBlock({ label, data }) {
    const [open, setOpen] = useState(false);

    if (data === undefined || data === null) return null;

    let displayValue;
    if (typeof data === 'string') {
        displayValue = data;
    } else {
        try {
            displayValue = JSON.stringify(data, null, 2);
        } catch {
            displayValue = String(data);
        }
    }

    return (
        <div className="execution-detail__data-block">
            <button
                className="execution-detail__data-toggle"
                onClick={() => setOpen(!open)}
                type="button"
            >
                <ChevronDownIcon open={open} />
                <span>{label}</span>
            </button>
            {open && (
                <pre className="execution-detail__data-content">{displayValue}</pre>
            )}
        </div>
    );
}

/**
 * Single node step in the execution timeline.
 */
function TimelineStep({ envelope, index }) {
    const status = getEnvelopeStatus(envelope);
    const statusLabel = ENVELOPE_STATUS_LABELS[status] || '...';
    const nodeName = envelope.to || envelope.from || `Step ${index + 1}`;
    const intentLabel = envelope.intent || envelope.type || '';

    return (
        <div className={`execution-detail__step execution-detail__step--${status}`}>
            <div className="execution-detail__step-connector">
                <div className={`execution-detail__step-dot execution-detail__step-dot--${status}`} />
                {/* Vertical connector line is handled by CSS */}
            </div>
            <div className="execution-detail__step-body">
                <div className="execution-detail__step-header">
                    <span className="execution-detail__step-name">{nodeName}</span>
                    <span className={`execution-detail__step-status execution-detail__step-status--${status}`}>
                        {statusLabel}
                    </span>
                </div>
                <div className="execution-detail__step-meta">
                    {intentLabel && (
                        <span className="execution-detail__step-intent">{intentLabel}</span>
                    )}
                    {envelope.ts && (
                        <span className="execution-detail__step-time">
                            <ClockIcon />
                            {formatTimestamp(envelope.ts)}
                        </span>
                    )}
                    {envelope.from && envelope.to && (
                        <span className="execution-detail__step-route">
                            {envelope.from} &rarr; {envelope.to}
                        </span>
                    )}
                </div>
                {envelope.payload && (
                    <DataBlock label="Payload" data={envelope.payload} />
                )}
            </div>
        </div>
    );
}

/**
 * APM-style waterfall showing envelope timing as horizontal bars.
 */
function EnvelopeWaterfall({ envelopes }) {
    if (!envelopes || envelopes.length < 2) return null;

    // Parse timestamps and compute span
    const parsed = envelopes
        .filter(e => e.ts)
        .map(e => ({ ...e, _time: new Date(e.ts).getTime() }))
        .sort((a, b) => a._time - b._time);

    if (parsed.length === 0) return null;

    const minTime = parsed[0]._time;
    const maxTime = parsed[parsed.length - 1]._time;
    const totalSpan = Math.max(maxTime - minTime, 1);

    const fmtMs = (ms) => {
        if (ms < 1000) return `${Math.round(ms)}ms`;
        return `${(ms / 1000).toFixed(1)}s`;
    };

    return (
        <div className="execution-detail__waterfall-section">
            <h2 className="execution-detail__waterfall-title">
                Waterfall Timeline
            </h2>
            <div className="execution-detail__waterfall">
                {parsed.map((env, i) => {
                    const offset = ((env._time - minTime) / totalSpan) * 100;
                    // Each bar gets a minimum width; if next envelope exists, use gap as width
                    const nextTime = parsed[i + 1]?._time;
                    const barDuration = nextTime ? nextTime - env._time : Math.max(totalSpan * 0.02, 10);
                    const width = Math.max((barDuration / totalSpan) * 100, 1);
                    const barType = env.type || 'event';
                    const label = env.to || env.from || `Step ${i + 1}`;

                    return (
                        <div key={env.id || i} className="execution-detail__wf-row">
                            <span className="execution-detail__wf-label" title={label}>
                                {label}
                            </span>
                            <div className="execution-detail__wf-bar-area">
                                <div
                                    className={`execution-detail__wf-bar execution-detail__wf-bar--${barType}`}
                                    style={{ left: `${offset}%`, width: `${width}%` }}
                                    title={`${env.type}: ${env.intent || ''} (${fmtMs(barDuration)})`}
                                />
                            </div>
                            <span className="execution-detail__wf-duration">
                                {fmtMs(barDuration)}
                            </span>
                        </div>
                    );
                })}
                <div className="execution-detail__wf-scale">
                    <span>0ms</span>
                    <span>{fmtMs(totalSpan / 2)}</span>
                    <span>{fmtMs(totalSpan)}</span>
                </div>
            </div>
        </div>
    );
}

// ─── Skill Loop Panel — ACAT-5 ──────────────────────────────────────────────

const SKILL_INTENTS = new Set([
    'agentic.skill.retrieved',
    'agentic.skill.drafted',
    'agentic.skill.promoted',
    'quox.agentic.skill.draft_rejected_incomplete_pattern',
    'quox.agentic.engine_nudge',
    'quox.agentic.engine_terminated_after_propose',
]);

function isSkillEnvelope(env) {
    const intent = env?.intent || '';
    return (
        intent.startsWith('agentic.skill.') ||
        intent.startsWith('quox.agentic.skill.') ||
        intent.startsWith('quox.agentic.engine_')
    );
}

function getPayload(env) {
    if (!env) return {};
    if (env.payload && typeof env.payload === 'object') return env.payload;
    try { return JSON.parse(env.payload); } catch { return {}; }
}

/**
 * SkillLoopPanel — surfaces the agentic Crystal self-learning narrative for a
 * single execution. Only rendered when at least one agentic.skill.* envelope
 * is present in the envelope list.
 *
 * Receives the full envelopes array already fetched by ExecutionDetailView —
 * no additional API call required.
 */
function SkillLoopPanel({ envelopes }) {
    const skillEnvs = useMemo(
        () => (envelopes || []).filter(isSkillEnvelope),
        [envelopes]
    );

    // Phase presence
    const retrieved = useMemo(
        () => skillEnvs.find(e => e.intent === 'agentic.skill.retrieved') || null,
        [skillEnvs]
    );
    const draftedAll = useMemo(
        () => skillEnvs.filter(e => e.intent === 'agentic.skill.drafted'),
        [skillEnvs]
    );
    const drafted = draftedAll.length > 0 ? draftedAll[draftedAll.length - 1] : null;

    const promoted = useMemo(
        () => skillEnvs.find(e => e.intent === 'agentic.skill.promoted') || null,
        [skillEnvs]
    );
    const rejected = useMemo(
        () => skillEnvs.find(e => e.intent === 'quox.agentic.skill.draft_rejected_incomplete_pattern') || null,
        [skillEnvs]
    );
    const terminated = useMemo(
        () => skillEnvs.find(e => e.intent === 'quox.agentic.engine_terminated_after_propose') || null,
        [skillEnvs]
    );

    // Node-level iteration steps for the Iterations card
    const iterSteps = useMemo(() => {
        return (envelopes || []).filter(e => {
            const intent = e?.intent || '';
            return (
                intent === 'quox.flow.node.completed' ||
                intent === 'quox.flow.node.started' ||
                intent === 'quox.flow.node.failed'
            );
        });
    }, [envelopes]);

    // Don't render at all if no skill envelopes
    if (skillEnvs.length === 0) return null;

    const promotedPayload = promoted ? getPayload(promoted) : null;
    const retrievedPayload = retrieved ? getPayload(retrieved) : null;
    const draftedPayload = drafted ? getPayload(drafted) : null;
    const rejectedPayload = rejected ? getPayload(rejected) : null;

    const candidates = retrievedPayload?.candidates || [];
    const candidateCount = retrievedPayload?.count ?? candidates.length;

    const MAX_ITER = 6;
    const shownIters = iterSteps.slice(0, MAX_ITER);
    const extraIters = Math.max(0, iterSteps.length - MAX_ITER);

    const MAX_CANDIDATES = 3;
    const shownCandidates = candidates.slice(0, MAX_CANDIDATES);
    const extraCandidates = Math.max(0, candidates.length - MAX_CANDIDATES);

    return (
        <section className="execution-detail__skill-loop" aria-label="Skill Loop">
            <div className="execution-detail__skill-loop-header">
                <h2 className="execution-detail__skill-loop-title">Skill Loop</h2>
                <p className="execution-detail__skill-loop-subtitle">
                    How this run interacted with the Crystal library.
                </p>
            </div>

            {/* Promoted banner — celebration treatment */}
            {promoted && promotedPayload && (
                <div className="execution-detail__skill-loop-promoted-banner">
                    <span>✓</span>
                    <span>
                        Crystal promoted to canonical:{' '}
                        <strong>{promotedPayload.crystalName || promotedPayload.crystal_name || 'Unknown'}</strong>
                    </span>
                    <Link to="/crystals">View Crystals →</Link>
                </div>
            )}

            <div className="execution-detail__skill-loop-phases">
                {/* Retrieved card */}
                {retrieved && (
                    <div className="execution-detail__skill-loop-card">
                        <span className="execution-detail__skill-loop-icon" aria-hidden="true">🔍</span>
                        <div className="execution-detail__skill-loop-card-body">
                            <div className="execution-detail__skill-loop-card-title">Retrieved</div>
                            <div className="execution-detail__skill-loop-card-detail">
                                {candidateCount === 0
                                    ? 'No candidates retrieved, this is a fresh-pattern run.'
                                    : (
                                        <>
                                            {candidateCount} candidate{candidateCount !== 1 ? 's' : ''}
                                            {shownCandidates.length > 0 && (
                                                <>
                                                    {': '}
                                                    {shownCandidates.map((c, i) => (
                                                        <span key={i}>
                                                            {typeof c === 'string' ? c : (c?.name || JSON.stringify(c))}
                                                            {i < shownCandidates.length - 1 ? ', ' : ''}
                                                        </span>
                                                    ))}
                                                    {extraCandidates > 0 && ` +${extraCandidates} more`}
                                                </>
                                            )}
                                        </>
                                    )
                                }
                            </div>
                        </div>
                    </div>
                )}

                {/* Iterations card */}
                {iterSteps.length > 0 && (
                    <div className="execution-detail__skill-loop-card">
                        <span className="execution-detail__skill-loop-icon" aria-hidden="true">🔧</span>
                        <div className="execution-detail__skill-loop-card-body">
                            <div className="execution-detail__skill-loop-card-title">Iterations</div>
                            <div className="execution-detail__skill-loop-card-detail">
                                {shownIters.map((step, i) => {
                                    const sp = getPayload(step);
                                    const failed = step.intent === 'quox.flow.node.failed';
                                    const nodeName = sp.node_name || sp.nodeName || step.to || `Step ${i + 1}`;
                                    const dur = sp.duration != null ? ` (${sp.duration}ms)` : '';
                                    const result = sp.status || (failed ? 'failed' : step.intent === 'quox.flow.node.completed' ? 'ok' : '');
                                    return (
                                        <div
                                            key={step.id || i}
                                            className={`execution-detail__skill-loop-iter-row${failed ? ' execution-detail__skill-loop-iter-row--failed' : ''}`}
                                        >
                                            {failed ? '✗' : '·'} Iter {i + 1}: {nodeName}{result ? `, ${result}` : ''}{dur}
                                        </div>
                                    );
                                })}
                                {extraIters > 0 && (
                                    <div className="execution-detail__skill-loop-more">
                                        +{extraIters} more iteration{extraIters !== 1 ? 's' : ''}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Drafted card */}
                {drafted && draftedPayload && (
                    <div className="execution-detail__skill-loop-card">
                        <span className="execution-detail__skill-loop-icon" aria-hidden="true">💡</span>
                        <div className="execution-detail__skill-loop-card-body">
                            <div className="execution-detail__skill-loop-card-title">Drafted</div>
                            <div className="execution-detail__skill-loop-card-detail">
                                <strong>{draftedPayload.crystalName || draftedPayload.crystal_name || 'Crystal'}</strong>
                                {draftedPayload.confidence != null && `, confidence ${draftedPayload.confidence}`}
                                {(draftedPayload.consecutiveSuccess != null && draftedPayload.consecutiveSuccessTarget != null) && (
                                    <>, {draftedPayload.consecutiveSuccess}/{draftedPayload.consecutiveSuccessTarget} toward canonical</>
                                )}
                                {draftedAll.length > 1 && (
                                    <div className="execution-detail__skill-loop-more">
                                        +{draftedAll.length - 1} earlier proposal{draftedAll.length - 1 !== 1 ? 's' : ''}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Rejected card */}
                {rejected && (
                    <div className="execution-detail__skill-loop-card execution-detail__skill-loop-card--amber">
                        <span className="execution-detail__skill-loop-icon" aria-hidden="true">⚠</span>
                        <div className="execution-detail__skill-loop-card-body">
                            <div className="execution-detail__skill-loop-card-title">Rejected</div>
                            <div className="execution-detail__skill-loop-card-detail execution-detail__skill-loop-card-detail--amber">
                                {rejectedPayload?.reason || 'Draft rejected (incomplete pattern).'}
                                {rejectedPayload?.actionsCompleted != null && (
                                    <>, {rejectedPayload.actionsCompleted} action{rejectedPayload.actionsCompleted !== 1 ? 's' : ''} completed</>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Promoted card */}
                {promoted && promotedPayload && (
                    <div className="execution-detail__skill-loop-card execution-detail__skill-loop-card--promoted">
                        <span className="execution-detail__skill-loop-icon" aria-hidden="true">🟣</span>
                        <div className="execution-detail__skill-loop-card-body">
                            <div className="execution-detail__skill-loop-card-title">Promoted</div>
                            <div className="execution-detail__skill-loop-card-detail execution-detail__skill-loop-card-detail--promoted">
                                <strong>{promotedPayload.crystalName || promotedPayload.crystal_name || 'Crystal'}</strong>
                                {promotedPayload.crystalId && (
                                    <>, id: <code style={{ fontSize: '11px' }}>{promotedPayload.crystalId}</code></>
                                )}
                                {promotedPayload.executionCount != null
                                    ? `, execution count: ${promotedPayload.executionCount}`
                                    : ', first canonical for this pattern'
                                }
                            </div>
                        </div>
                    </div>
                )}

                {/* Terminated early card */}
                {terminated && (
                    <div className="execution-detail__skill-loop-card execution-detail__skill-loop-card--terminated">
                        <span className="execution-detail__skill-loop-icon" aria-hidden="true">🛑</span>
                        <div className="execution-detail__skill-loop-card-body">
                            <div className="execution-detail__skill-loop-card-title">Terminated Early</div>
                            <div className="execution-detail__skill-loop-card-detail">
                                Engine ended after propose iteration.
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}

function ExecutionDetailView() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { authFetch } = useAuth();

    const [execution, setExecution] = useState(null);
    const [envelopes, setEnvelopes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [rerunning, setRerunning] = useState(false);
    // AEE-FULL Gap 4: cancel UI state
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [cancelReason, setCancelReason] = useState('');
    const [cancelError, setCancelError] = useState(null);
    const [confirmRerun, setConfirmRerun] = useState(false);
    const [packaging, setPackaging] = useState(false);
    const [packageMessage, setPackageMessage] = useState(null); // { type: 'success'|'error'|'not-ready', text, skillId? }

    // P6.D: observations + evidence
    const [observations, setObservations] = useState([]);
    const [evidenceByNode, setEvidenceByNode] = useState(new Map());
    // ACAT-X: agent attribution (cross-link to /agents/:id) sourced from
    // the workflow's metadata.agent. Loaded best-effort after the run loads.
    const [workflowAgent, setWorkflowAgent] = useState(null);

    useEffect(() => {
        if (!id) return;

        let cancelled = false;

        async function loadData() {
            setLoading(true);
            setError(null);

            try {
                const [execResult, envelopesResult] = await Promise.all([
                    getExecution(id),
                    getExecutionEnvelopes(id)
                ]);

                if (cancelled) return;

                const execData = execResult?.data || execResult || null;
                setExecution(execData);

                // ACAT-X: best-effort fetch of the workflow row to surface
                // the owning agent (`metadata.agent`) on the meta-card. Fire
                // and forget — never block the page on this.
                if (execData?.workflowId) {
                    getWorkflow(execData.workflowId)
                        .then(wf => {
                            if (cancelled) return;
                            const agent = wf?.workflow?.definition?.metadata?.agent
                                || wf?.definition?.metadata?.agent
                                || wf?.metadata?.agent
                                || null;
                            if (agent) setWorkflowAgent(agent);
                        })
                        .catch(() => { /* non-fatal */ });
                }

                // /executions/:id/envelopes returns { success, data: { executionId,
                // correlationId, envelopes: [...], count }, meta }. Earlier code
                // only unwrapped one level, so envelopes always landed as [] and
                // the page showed "No envelope data available" even though the
                // envelopes were present in quoxflow + collector AEE store.
                setEnvelopes(
                    Array.isArray(envelopesResult?.data?.envelopes)
                        ? envelopesResult.data.envelopes
                        : Array.isArray(envelopesResult?.data)
                            ? envelopesResult.data
                            : Array.isArray(envelopesResult)
                                ? envelopesResult
                                : []
                );

                // P6.D: fetch observations + evidence using correlationId when available
                const correlationId = envelopesResult?.data?.correlationId || execData?.correlationId;
                if (correlationId && authFetch) {
                    // Fire and forget — don't block the main load
                    Promise.allSettled([
                        listObservations({ authFetch, correlationId }),
                        listQuoxflowEvidence({ authFetch, correlationId, executionId: id }),
                    ]).then(([obsResult, evResult]) => {
                        if (cancelled) return;
                        if (obsResult.status === 'fulfilled') {
                            const raw = obsResult.value?.observations || []
                            setObservations(raw.map(formatObservation).filter(Boolean))
                        }
                        if (evResult.status === 'fulfilled') {
                            const rows = evResult.value?.data || []
                            setEvidenceByNode(groupEvidenceByNode(rows))
                        }
                    });
                }
            } catch (err) {
                if (cancelled) return;
                console.error('Failed to load execution:', err);
                setError(err.message || 'Failed to load execution details.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        loadData();

        return () => {
            cancelled = true;
        };
    }, [id, authFetch]);

    // AEE-FULL Gap 4: cancel a running execution. Per SD-2, the engine
    // hardcodes cancelled_by='user'; client only sends optional reason.
    const handleCancel = async () => {
        if (!execution?.id || cancelling) return;
        setCancelling(true);
        setCancelError(null);
        const result = await cancelExecution(execution.id, { reason: cancelReason, authFetch });
        setCancelling(false);

        if (result.code === CANCEL_RESULT_CODES.OK) {
            setExecution(prev => prev ? { ...prev, ...result.execution } : prev);
            setConfirmCancel(false);
            setCancelReason('');
        } else if (result.code === CANCEL_RESULT_CODES.ALREADY_TERMINAL) {
            // Use the current_status from response to refresh without a second GET (SD-1 refinement)
            setExecution(prev => prev ? { ...prev, status: result.currentStatus || prev.status } : prev);
            setCancelError(`Already ${result.currentStatus || 'terminal'}, nothing to cancel`);
        } else if (result.code === CANCEL_RESULT_CODES.NOT_FOUND) {
            setCancelError('Execution not found');
        } else if (result.code === CANCEL_RESULT_CODES.NETWORK_ERROR) {
            setCancelError('Network error, try again');
        } else {
            setCancelError('Unexpected error');
        }
    };

    const handleRerun = async () => {
        if (!execution?.workflowId || rerunning) return;
        setRerunning(true);
        setConfirmRerun(false);

        const corrId = prefixedUlid('WFRUN');
        const wfName = execution.workflowName || execution.workflowId;

        // AEE start envelope
        try {
            await storeEnvelope(createEvent('human.user', QUOXFLOW_INTENTS.FLOW_STARTED, {
                workflowId: execution.workflowId, workflowName: wfName,
                triggerMode: 'manual', initiator: 'ui.execution-rerun',
                requestedAt: new Date().toISOString()
            }, corrId));
        } catch {}

        try {
            const result = await executeWorkflow(execution.workflowId);
            const data = result?.data || result;
            const newExecId = data?.executionId || data?.stored?.id || data?.id;

            // Store server envelopes
            try {
                const serverEnvelopes = data?.envelopes || [];
                if (serverEnvelopes.length > 0) await storeEnvelopes(serverEnvelopes);
            } catch {}

            // AEE completion envelope
            const execStatus = data?.success === false ? 'failed' : (data?.stored?.status || 'completed');
            try {
                await storeEnvelope(createEvent('agent.quoxflow',
                    execStatus === 'failed' ? QUOXFLOW_INTENTS.FLOW_FAILED : QUOXFLOW_INTENTS.FLOW_COMPLETED,
                    { workflowId: execution.workflowId, workflowName: wfName,
                      executionId: newExecId, status: execStatus,
                      duration: data?.duration || data?.stored?.duration,
                      completedAt: new Date().toISOString() },
                    corrId));
            } catch {}

            if (newExecId) navigate(`/executions/${newExecId}`);
        } catch (err) {
            try {
                await storeEnvelope(createEvent('agent.quoxflow', QUOXFLOW_INTENTS.FLOW_FAILED, {
                    workflowId: execution.workflowId, workflowName: wfName,
                    error: { message: err.message || 'Unknown error' },
                    failedAt: new Date().toISOString()
                }, corrId));
            } catch {}
            setError(`Failed to re-run workflow: ${err.message || 'Unknown error'}`);
        } finally {
            setRerunning(false);
        }
    };

    const canCrystallise = hasTier('tier_b');

    const handlePackageAsSkill = async () => {
        if (!execution?.workflowId || packaging) return;
        if (!canCrystallise) {
            setPackageMessage({
                type: 'error',
                text: 'Package as Crystal is a Pro feature, upgrade to unlock.',
            });
            return;
        }
        setPackaging(true);
        setPackageMessage(null);
        try {
            const result = await packageCrystalFromExecution({
                workflowId: execution.workflowId,
                workflowName: execution.workflowName,
            });
            const verb = result.created ? 'packaged' : 'already in library';
            setPackageMessage({
                type: 'success',
                text: `Crystal ${verb}: "${result.skill?.name || execution.workflowId}" (v${result.skill?.version}).`,
                skillId: result.skill?.id,
            });
        } catch (err) {
            if (err?.code === 'NOT_READY') {
                setPackageMessage({
                    type: 'not-ready',
                    text: err.message || 'Workflow not ready, needs 3+ successful runs with consistent action structure.',
                });
            } else {
                setPackageMessage({
                    type: 'error',
                    text: err?.message || 'Failed to package Crystal.',
                });
            }
        } finally {
            setPackaging(false);
        }
    };

    // Derive display values from execution data
    const statusConfig = execution ? (STATUS_CONFIG[execution.status] || STATUS_CONFIG.running) : null;
    const duration = execution ? formatDuration(execution.startedAt, execution.completedAt) : null;

    return (
        <div className="execution-detail view-page">
            {/* Loading State */}
            {loading && (
                <div className="execution-detail__loading">
                    <div className="execution-detail__loading-spinner" />
                    <span>Loading execution details...</span>
                </div>
            )}

            {/* Error State */}
            {!loading && error && (
                <div className="execution-detail__error">
                    <div className="execution-detail__error-icon">!</div>
                    <div className="execution-detail__error-text">
                        <strong>Error loading execution</strong>
                        <p>{error}</p>
                    </div>
                    <button
                        className="execution-detail__retry-btn"
                        onClick={() => window.location.reload()}
                        type="button"
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        Retry
                    </button>
                </div>
            )}

            {/* Execution Content */}
            {!loading && !error && execution && (
                <>
                    <EvolutionStagePill currentStage="workflow" style={{ marginBottom: 16 }} />
                    {/* Actions toolbar (W4 — Package as Skill + Run Again; AEE-FULL Gap 4 — Cancel) */}
                    <div className="qx-row" style={{ justifyContent: 'flex-end', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                        {/* AEE-FULL Gap 4 — Cancel button: hidden (not just disabled) when not running per SD-12 */}
                        {execution.status === 'running' && (
                            <button
                                type="button"
                                className="qx-btn qx-btn--sm"
                                onClick={() => { setCancelReason(''); setCancelError(null); setConfirmCancel(true); }}
                                disabled={cancelling}
                                title="Cancel this running execution"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-warning, #f59e0b)' }}
                            >
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                    <rect x="6" y="6" width="12" height="12" rx="1.5" />
                                </svg>
                                {cancelling ? 'Cancelling…' : 'Cancel'}
                            </button>
                        )}
                        <button
                            type="button"
                            className="qx-btn qx-btn--sm"
                            onClick={() => setConfirmRerun(true)}
                            disabled={rerunning || !execution.workflowId}
                        >
                            {rerunning ? 'Running…' : 'Run Again'}
                        </button>
                        <button
                            type="button"
                            className="qx-btn qx-btn--primary qx-btn--sm"
                            onClick={handlePackageAsSkill}
                            disabled={packaging || !execution.workflowId || (!canCrystallise ? false : execution.status !== 'completed')}
                            title={
                                !canCrystallise
                                    ? 'Package as Crystal is a Pro feature, upgrade to unlock'
                                    : execution.status !== 'completed'
                                        ? 'Only completed executions can be packaged'
                                        : 'Crystallise this workflow into a reusable Crystal'
                            }
                        >
                            {packaging ? 'Crystallising…' : 'Package as Crystal'}
                        </button>
                    </div>

                    {packageMessage && (
                        <div
                            className={`qx-banner${packageMessage.type === 'error' ? ' qx-banner--danger' : packageMessage.type === 'not-ready' ? ' qx-banner--warning' : ' qx-banner--success'}`}
                            style={{ marginBottom: 16 }}
                        >
                            <span>{packageMessage.text}</span>
                            {packageMessage.skillId && (
                                <button
                                    type="button"
                                    className="qx-btn qx-btn--sm"
                                    onClick={() => navigate('/crystals')}
                                    style={{ marginLeft: 12 }}
                                >
                                    View library
                                </button>
                            )}
                        </div>
                    )}

                    {/* Metadata Card */}
                    <div className="execution-detail__meta-card">
                        <div className="execution-detail__meta-grid">
                            <div className="execution-detail__meta-item">
                                <span className="execution-detail__meta-label">Status</span>
                                <span className={`execution-detail__status-badge ${statusConfig.bgClass}`}>
                                    {statusConfig.label}
                                </span>
                            </div>
                            <div className="execution-detail__meta-item">
                                <span className="execution-detail__meta-label">Started</span>
                                <span className="execution-detail__meta-value">
                                    {formatTimestamp(execution.startedAt)}
                                </span>
                            </div>
                            <div className="execution-detail__meta-item">
                                <span className="execution-detail__meta-label">Duration</span>
                                <span className="execution-detail__meta-value">{duration}</span>
                            </div>
                            <div className="execution-detail__meta-item">
                                <span className="execution-detail__meta-label">Execution ID</span>
                                <code className="execution-detail__meta-code">{execution.id}</code>
                            </div>
                            {execution.workflowId && (
                                <div className="execution-detail__meta-item">
                                    <span className="execution-detail__meta-label">Workflow ID</span>
                                    <code className="execution-detail__meta-code">{execution.workflowId}</code>
                                </div>
                            )}
                            {workflowAgent && (
                                <div className="execution-detail__meta-item">
                                    <span className="execution-detail__meta-label">Run by</span>
                                    <Link
                                        to={`/agents/${encodeURIComponent(workflowAgent)}`}
                                        className="execution-detail__meta-value"
                                        style={{ color: 'var(--m-accent-cyan, #4ecdc4)' }}
                                    >
                                        {workflowAgent}
                                    </Link>
                                </div>
                            )}
                        </div>

                        {/* Execution error display */}
                        {execution.error && (
                            <div className="execution-detail__exec-error">
                                <strong>Error:</strong> {typeof execution.error === 'string' ? execution.error : JSON.stringify(execution.error)}
                            </div>
                        )}

                        {/* Execution-level input/output */}
                        {execution.input && (
                            <DataBlock label="Execution Input" data={execution.input} />
                        )}
                        {execution.output && (
                            <DataBlock label="Execution Output" data={execution.output} />
                        )}
                    </div>

                    {/* Skill Loop Panel — ACAT-5 */}
                    <SkillLoopPanel envelopes={envelopes} />

                    {/* Waterfall Visualization — P6.D: now passes evidenceByNode */}
                    <div className="qx-card" style={{ marginBottom: 20 }}>
                        <ExecutionWaterfall
                            envelopes={envelopes}
                            execution={execution}
                            evidenceByNode={evidenceByNode}
                        />
                    </div>

                    {/* Observations Panel — P6.D */}
                    <div className="execution-detail__obs-section">
                        <h2 className="execution-detail__timeline-title">
                            Observations
                            {observations.length > 0 && (
                                <span className="execution-detail__timeline-count">
                                    {observations.length}
                                </span>
                            )}
                        </h2>
                        {observations.length === 0 ? (
                            <div className="execution-detail__empty-timeline">
                                No observations recorded for this run.
                            </div>
                        ) : (
                            <div className="execution-detail__obs-list">
                                {observations.map((obs, i) => (
                                    <div key={obs.id || i} className="execution-detail__obs-row">
                                        <div className="execution-detail__obs-meta">
                                            {obs.ts && (
                                                <span className="execution-detail__obs-ts">
                                                    {formatTimestamp(obs.ts)}
                                                </span>
                                            )}
                                            {obs.nodeId && (
                                                <code className="execution-detail__obs-node">{obs.nodeId}</code>
                                            )}
                                            <span className="execution-detail__obs-type">{obs.type}</span>
                                        </div>
                                        <p className="execution-detail__obs-summary">{obs.summary || '—'}</p>
                                        {obs.contentRef && (
                                            <code className="execution-detail__obs-ref">ref: {obs.contentRef}</code>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Node Timeline */}
                    <div className="execution-detail__timeline-section">
                        <h2 className="execution-detail__timeline-title">
                            Execution Timeline
                            <span className="execution-detail__timeline-count">
                                {envelopes.length} step{envelopes.length !== 1 ? 's' : ''}
                            </span>
                        </h2>

                        {envelopes.length === 0 ? (
                            <div className="execution-detail__empty-timeline">
                                No envelope data available for this execution.
                            </div>
                        ) : (
                            <div className="execution-detail__timeline">
                                {envelopes.map((envelope, index) => (
                                    <TimelineStep
                                        key={envelope.id || index}
                                        envelope={envelope}
                                        index={index}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* Empty State - no execution found */}
            {!loading && !error && !execution && (
                <div className="execution-detail__empty">
                    <div className="execution-detail__empty-icon">
                        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    </div>
                    <h3>Execution Not Found</h3>
                    <p>No execution found with ID: <code>{id}</code></p>
                    <button
                        className="execution-detail__back-btn"
                        onClick={() => navigate('/workflows')}
                        type="button"
                    >
                        <BackIcon />
                        <span>Back to Workflows</span>
                    </button>
                </div>
            )}

            {/* AEE-FULL Gap 4 — Cancel Execution Confirmation Modal (detail view: rich UX with reason textarea) */}
            <Modal
                isOpen={confirmCancel}
                onClose={() => !cancelling && setConfirmCancel(false)}
                severity="warning"
                size="sm"
                closeOnOverlay={!cancelling}
                closeOnEscape={!cancelling}
            >
                <Modal.Header
                    title="Cancel Execution"
                    description="Stop this running workflow"
                    onClose={!cancelling ? () => setConfirmCancel(false) : undefined}
                />
                <Modal.Body>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div style={{ padding: '0.875rem 1rem', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ui-text-muted, #666)', marginBottom: '0.375rem' }}>Workflow</div>
                            <div style={{ fontSize: '0.95rem', color: 'var(--ui-text-primary, white)', fontWeight: 600 }}>
                                {execution?.workflowName || execution?.workflowId || 'Unknown'}
                            </div>
                        </div>
                        <div style={{ padding: '0.75rem 1rem', background: 'rgba(245, 158, 11, 0.08)', borderRadius: '8px', borderLeft: '3px solid var(--color-warning, #f59e0b)', fontSize: '0.8rem', color: 'var(--ui-text-secondary, #ccc)', lineHeight: 1.5 }}>
                            Cancelling will stop all in-progress nodes immediately. Audit trail captures who cancelled and when.
                        </div>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.8rem', color: 'var(--ui-text-secondary, #ccc)' }}>
                            <span>Reason (optional)</span>
                            <textarea
                                rows={2}
                                value={cancelReason}
                                onChange={e => setCancelReason(e.target.value)}
                                placeholder="stuck, killing manually"
                                disabled={cancelling}
                                style={{ resize: 'vertical', padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.2)', color: 'var(--ui-text-primary, white)', fontFamily: 'inherit', fontSize: '0.85rem' }}
                            />
                        </label>
                        {cancelError && (
                            <div style={{ fontSize: '0.8rem', color: 'var(--color-warning, #f59e0b)' }}>{cancelError}</div>
                        )}
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={() => setConfirmCancel(false)} disabled={cancelling}>Keep Running</Button>
                    <Button variant="primary" onClick={handleCancel} loading={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel Execution'}</Button>
                </Modal.Footer>
            </Modal>

            {/* Run Again Confirmation Modal */}
            <Modal
                isOpen={confirmRerun}
                onClose={() => !rerunning && setConfirmRerun(false)}
                severity="warning"
                size="sm"
                closeOnOverlay={!rerunning}
                closeOnEscape={!rerunning}
            >
                <Modal.Header
                    title="Run Again"
                    description="Re-execute this workflow"
                    icon={<PlayIcon />}
                    onClose={!rerunning ? () => setConfirmRerun(false) : undefined}
                />
                <Modal.Body>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div style={{
                            padding: '0.875rem 1rem',
                            background: 'rgba(255, 255, 255, 0.03)',
                            borderRadius: '8px',
                            border: '1px solid rgba(255, 255, 255, 0.06)'
                        }}>
                            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ui-text-muted, #666)', marginBottom: '0.375rem' }}>Workflow</div>
                            <div style={{ fontSize: '0.95rem', color: 'var(--ui-text-primary, white)', fontWeight: 600 }}>
                                {execution?.workflowName || execution?.workflowId || 'Unknown'}
                            </div>
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
                            This will re-execute the workflow. All nodes will be triggered and actions will be performed.
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--ui-text-muted, #666)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            Execution will be recorded in the audit trail
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={() => setConfirmRerun(false)} disabled={rerunning}>Cancel</Button>
                    <Button variant="primary" onClick={handleRerun} loading={rerunning}>{rerunning ? 'Executing...' : 'Run Now'}</Button>
                </Modal.Footer>
            </Modal>
        </div>
    );
}

export default ExecutionDetailView;
