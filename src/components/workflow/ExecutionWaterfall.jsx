/**
 * ExecutionWaterfall — Chrome-network-panel-style timeline for a workflow run.
 *
 * One row per node (keyed by payload.nodeId from quox.flow.node.* envelopes).
 * Workflow-level envelopes (started, completed, failed, AOCL gates) appear as
 * small markers on the time axis rather than full rows.
 *
 * Pure display component — all data derived from the `envelopes` prop (the raw
 * AEE envelope array from /executions/:id/envelopes).
 *
 * STUDY-REV-2 P5.B-polish
 */

import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { extractInputPreview, extractOutputPreview, isAoclEnvelope } from '../../lib/executionDetailHelpers.js';
import './ExecutionWaterfall.css';

// ─── Helper functions (pure, tested in executionWaterfall.helpers.test.js) ─

/**
 * Group a flat envelope array into:
 *  - nodeRows: Map<nodeId, { nodeId, nodeName, started, completed, failed }>
 *  - workflowEvents: Array<{ ts, intent, label, status }>
 *
 * @param {Array}  envelopes  Raw AEE envelopes
 * @returns {{ nodeRows: Map, workflowEvents: Array }}
 */
export function groupEnvelopesByNode(envelopes) {
    const nodeRows = new Map();
    const workflowEvents = [];

    for (const env of envelopes) {
        const intent = env.intent || '';
        const ts = env.ts ? new Date(env.ts).getTime() : null;

        // Node-level envelopes
        if (intent === 'quox.flow.node.started') {
            const nodeId = env.payload?.nodeId || env.payload?.nodeType || `node-${nodeRows.size}`;
            if (!nodeRows.has(nodeId)) {
                nodeRows.set(nodeId, {
                    nodeId,
                    nodeName: env.payload?.nodeName || env.payload?.nodeId || nodeId,
                    started: ts,
                    completed: null,
                    failed: null,
                    raw: [],
                });
            } else {
                nodeRows.get(nodeId).started = ts;
            }
            nodeRows.get(nodeId).raw.push(env);
            continue;
        }

        if (intent === 'quox.flow.node.completed') {
            const nodeId = env.payload?.nodeId || env.payload?.nodeType;
            if (nodeId) {
                if (!nodeRows.has(nodeId)) {
                    nodeRows.set(nodeId, {
                        nodeId,
                        nodeName: env.payload?.nodeName || nodeId,
                        started: null,
                        completed: ts,
                        failed: null,
                        raw: [],
                    });
                } else {
                    nodeRows.get(nodeId).completed = ts;
                }
                nodeRows.get(nodeId).raw.push(env);
                continue;
            }
        }

        if (intent === 'quox.flow.node.failed') {
            const nodeId = env.payload?.nodeId || env.payload?.nodeType;
            if (nodeId) {
                if (!nodeRows.has(nodeId)) {
                    nodeRows.set(nodeId, {
                        nodeId,
                        nodeName: env.payload?.nodeName || nodeId,
                        started: null,
                        completed: null,
                        failed: ts,
                        raw: [],
                    });
                } else {
                    nodeRows.get(nodeId).failed = ts;
                }
                nodeRows.get(nodeId).raw.push(env);
                continue;
            }
        }

        // Workflow-level envelopes → time-axis markers
        if (ts !== null) {
            const label = deriveEventLabel(intent, env);
            if (label) {
                workflowEvents.push({ ts, intent, label, env });
            }
        }
    }

    return { nodeRows, workflowEvents };
}

/**
 * Compute a time scale (minTs, maxTs, totalMs) from nodeRows + workflowEvents.
 * Falls back to a 1ms span if all timestamps are identical.
 *
 * @param {Map}    nodeRows
 * @param {Array}  workflowEvents
 * @param {number} [nowMs]  Current time for still-running bars; defaults to Date.now()
 * @returns {{ minTs: number, maxTs: number, totalMs: number }}
 */
export function computeTimeScale(nodeRows, workflowEvents, nowMs = Date.now()) {
    const allTs = [];

    nodeRows.forEach(row => {
        if (row.started   !== null) allTs.push(row.started);
        if (row.completed !== null) allTs.push(row.completed);
        if (row.failed    !== null) allTs.push(row.failed);
    });

    workflowEvents.forEach(ev => allTs.push(ev.ts));

    if (allTs.length === 0) return { minTs: nowMs, maxTs: nowMs + 1, totalMs: 1 };

    const minTs = Math.min(...allTs);
    const maxTs = Math.max(...allTs, nowMs);
    const totalMs = Math.max(maxTs - minTs, 1);

    return { minTs, maxTs, totalMs };
}

/** Derive a short human-readable label for a workflow-level envelope. */
function deriveEventLabel(intent, env) {
    const map = {
        'quox.flow.started':   'Start',
        'quox.flow.completed': 'Done',
        'quox.flow.failed':    'Fail',
        'quox.aocl.gate':      'Gate',
        'quox.aocl.approved':  'OK',
        'quox.aocl.rejected':  'REJ',
    };
    if (map[intent]) return map[intent];
    // Any other flow envelope gets a short token
    if (intent.startsWith('quox.flow.')) return intent.replace('quox.flow.', '');
    return null;
}

/** Format milliseconds as "+Xs" or "+Xms" relative ticks. */
export function fmtRelMs(ms) {
    if (ms === 0) return '+0';
    if (ms < 1000) return `+${Math.round(ms)}ms`;
    return `+${(ms / 1000).toFixed(1)}s`;
}

/** Determine bar status for a node row. */
export function rowStatus(row) {
    if (row.failed !== null)    return 'failed';
    if (row.completed !== null) return 'completed';
    if (row.started !== null)   return 'running';
    return 'queued';
}

// ─── Sub-components ──────────────────────────────────────────────────────────

// ─── Copy button (inline SVG, no emoji) ─────────────────────────────────────

function CopyButton({ text, label = 'Copy' }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };

    return (
        <button
            type="button"
            className="ewf-copy-btn"
            onClick={handleCopy}
            title={copied ? 'Copied!' : label}
            aria-label={label}
        >
            {copied ? (
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            ) : (
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
            )}
        </button>
    );
}

// ─── Tool I/O preview block ─────────────────────────────────────────────────

function ToolIOPreview({ raw }) {
    // Find started envelope for input, completed for output
    const startedEnv  = raw?.find(e => e.intent === 'quox.flow.node.started');
    const completedEnv = raw?.find(e => e.intent === 'quox.flow.node.completed');

    const inputPreview  = extractInputPreview(startedEnv);
    const outputPreview = extractOutputPreview(completedEnv);

    if (!inputPreview && !outputPreview) return null;

    return (
        <div className="ewf-io">
            {inputPreview && (
                <div className="ewf-io__block">
                    <div className="ewf-io__header">
                        <span className="ewf-io__label">Input</span>
                        <CopyButton text={inputPreview} label="Copy input" />
                    </div>
                    <pre className="ewf-io__pre">{inputPreview}</pre>
                </div>
            )}
            {outputPreview && (
                <div className="ewf-io__block">
                    <div className="ewf-io__header">
                        <span className="ewf-io__label">Output</span>
                        <CopyButton text={outputPreview} label="Copy output" />
                    </div>
                    <pre className="ewf-io__pre">{outputPreview}</pre>
                </div>
            )}
        </div>
    );
}

// ─── Evidence pill ───────────────────────────────────────────────────────────

function EvidencePill({ nodeId, evidenceByNode, executionId }) {
    const [open, setOpen] = useState(false);

    const rows = evidenceByNode?.get(nodeId) || [];
    if (rows.length === 0) return null;

    return (
        <div className="ewf-evidence">
            <button
                type="button"
                className="ewf-evidence__pill"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
            >
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                {rows.length} evidence ref{rows.length !== 1 ? 's' : ''}
            </button>

            {open && (
                <div className="ewf-evidence__drawer">
                    {rows.map((ev, i) => (
                        <div key={ev.id || i} className="ewf-evidence__row">
                            <code className="ewf-evidence__id">{ev.id || ev.evidence_id || `#${i + 1}`}</code>
                            {ev.type && <span className="ewf-evidence__type">{ev.type}</span>}
                        </div>
                    ))}
                    {executionId && (
                        <Link
                            to={`/compliance?fw=&ctrl=&executionId=${executionId}`}
                            className="ewf-evidence__explorer-link"
                        >
                            View in Evidence Explorer
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}>
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                        </Link>
                    )}
                </div>
            )}
        </div>
    );
}

function NodeRow({ row, minTs, totalMs, nowMs, evidenceByNode, executionId }) {
    const [expanded, setExpanded] = useState(false);
    const status = rowStatus(row);

    const startMs  = row.started   !== null ? row.started  - minTs : null;
    const endMs    = row.failed    !== null ? row.failed   - minTs
                   : row.completed !== null ? row.completed - minTs
                   : row.started   !== null ? nowMs - minTs          // still running
                   : null;

    const leftPct  = startMs  !== null ? (startMs  / totalMs) * 100 : 0;
    const widthPct = (startMs !== null && endMs !== null)
        ? Math.max(((endMs - startMs) / totalMs) * 100, 0.5)
        : 0.5;

    const durationMs = (startMs !== null && endMs !== null) ? endMs - startMs : null;
    const durationLabel = durationMs !== null ? fmtRelMs(durationMs) : '—';

    const isRunning = status === 'running';

    return (
        <div className={`ewf-row ewf-row--${status}`}>
            <div className="ewf-row__label" title={row.nodeName}>
                <span className={`ewf-status-dot ewf-status-dot--${status}`} />
                <span className="ewf-row__name">{row.nodeName}</span>
            </div>

            <div className="ewf-bar-area">
                {startMs !== null ? (
                    <div
                        className={`ewf-bar ewf-bar--${status}${isRunning ? ' ewf-bar--pulse' : ''}`}
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        title={`${row.nodeName}: ${fmtRelMs(startMs)} → ${fmtRelMs(endMs ?? 0)}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpanded(v => !v)}
                        onKeyDown={e => e.key === 'Enter' && setExpanded(v => !v)}
                        aria-expanded={expanded}
                        aria-label={`${row.nodeName} timing bar — click to expand`}
                    />
                ) : (
                    <div className="ewf-bar-area__empty">—</div>
                )}
            </div>

            <span className="ewf-row__duration">{durationLabel}</span>

            {/* Evidence pill — shown inline beneath duration when there are refs */}
            <EvidencePill
                nodeId={row.nodeId}
                evidenceByNode={evidenceByNode}
                executionId={executionId}
            />

            {expanded && (
                <div className="ewf-row__detail">
                    {/* Tool I/O preview (new P6.D) */}
                    <ToolIOPreview raw={row.raw} />
                    {/* Raw envelope JSON (existing) */}
                    {row.raw?.length > 0 && (
                        <details className="ewf-raw-details">
                            <summary className="ewf-raw-summary">Raw envelopes ({row.raw.length})</summary>
                            <pre className="ewf-row__json">
                                {JSON.stringify(row.raw.map(e => ({
                                    intent: e.intent,
                                    ts: e.ts,
                                    payload: e.payload,
                                })), null, 2)}
                            </pre>
                        </details>
                    )}
                </div>
            )}
        </div>
    );
}

function WorkflowLevelRow({ row, minTs, totalMs }) {
    const [expanded, setExpanded] = useState(false);
    const offsetMs = row.started !== null ? row.started - minTs : 0;
    const leftPct  = (offsetMs / totalMs) * 100;

    return (
        <div className="ewf-row ewf-row--wf-level">
            <div className="ewf-row__label" title="Workflow">
                <span className="ewf-status-dot ewf-status-dot--info" />
                <span className="ewf-row__name ewf-row__name--muted">Workflow</span>
            </div>

            <div className="ewf-bar-area ewf-bar-area--events">
                {row.events.map((ev, i) => {
                    const evOffsetMs  = ev.ts - minTs;
                    const evLeftPct   = (evOffsetMs / totalMs) * 100;
                    return (
                        <button
                            key={i}
                            className={`ewf-marker ewf-marker--${ev.intent.includes('fail') || ev.intent.includes('reject') ? 'error' : ev.intent.includes('done') || ev.intent.includes('complete') || ev.intent.includes('ok') || ev.intent.includes('approved') ? 'success' : 'info'}`}
                            style={{ left: `${evLeftPct}%` }}
                            title={`${ev.label} — ${ev.intent} @ ${new Date(ev.ts).toLocaleTimeString()}`}
                            onClick={() => setExpanded(v => !v)}
                        >
                            ▼
                        </button>
                    );
                })}
            </div>

            <span className="ewf-row__duration" />

            {expanded && (
                <div className="ewf-row__detail">
                    {row.events.map((ev, i) => (
                        <div key={i} className="ewf-event-detail">
                            <span className="ewf-event-detail__label">{ev.label}</span>
                            <span className="ewf-event-detail__intent">{ev.intent}</span>
                            <span className="ewf-event-detail__ts">{new Date(ev.ts).toLocaleTimeString()}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Tick ruler ──────────────────────────────────────────────────────────────

function TimeAxis({ totalMs, tickCount = 6 }) {
    const ticks = Array.from({ length: tickCount }, (_, i) => {
        const frac = i / (tickCount - 1);
        const ms   = totalMs * frac;
        return { leftPct: frac * 100, label: fmtRelMs(ms) };
    });

    return (
        <div className="ewf-axis">
            {ticks.map(t => (
                <span key={t.leftPct} className="ewf-axis__tick" style={{ left: `${t.leftPct}%` }}>
                    {t.label}
                </span>
            ))}
        </div>
    );
}

// ─── AOCL cluster row ─────────────────────────────────────────────────────────

const AOCL_LAYER_LABELS = {
    L1: 'Identity / Scope',
    L3: 'Policy Gate',
    L8: 'Response Verify',
}

function AoclClusterRow({ aoclEnvelopes }) {
    const [open, setOpen] = useState(false);

    if (!aoclEnvelopes || aoclEnvelopes.length === 0) return null;

    return (
        <div className="ewf-row ewf-row--aocl">
            <div className="ewf-row__label" title="AOCL enforcement layers">
                <span className="ewf-status-dot ewf-status-dot--info" />
                <span className="ewf-row__name ewf-row__name--muted">AOCL layers</span>
            </div>

            <div className="ewf-bar-area">
                <button
                    type="button"
                    className="ewf-aocl-toggle"
                    onClick={() => setOpen(v => !v)}
                    aria-expanded={open}
                >
                    {open ? 'Collapse' : `${aoclEnvelopes.length} envelope${aoclEnvelopes.length !== 1 ? 's' : ''} — click to expand`}
                </button>
            </div>

            <span className="ewf-row__duration" />

            {open && (
                <div className="ewf-row__detail">
                    {aoclEnvelopes.map((env, i) => {
                        const layerId = env.payload?.layer
                        const layerLabel = layerId ? (AOCL_LAYER_LABELS[layerId] || layerId) : ''
                        const intent = env.intent || ''
                        const shortStatus = intent.split('.').pop()
                        return (
                            <div key={env.id || i} className="ewf-aocl-row">
                                {layerLabel && (
                                    <span className="ewf-aocl-row__layer">{layerLabel}</span>
                                )}
                                <span className="ewf-aocl-row__intent">{intent}</span>
                                <span className={`ewf-aocl-row__status ewf-aocl-row__status--${shortStatus}`}>
                                    {shortStatus}
                                </span>
                                {env.ts && (
                                    <span className="ewf-aocl-row__ts">
                                        {new Date(env.ts).toLocaleTimeString()}
                                    </span>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * @param {object[]} envelopes       - Raw AEE envelopes
 * @param {object}   execution       - Execution metadata (from /executions/:id)
 * @param {Map}      evidenceByNode  - Map<nodeId, evidenceRow[]> from groupEvidenceByNode()
 */
export default function ExecutionWaterfall({ envelopes, execution, evidenceByNode }) {
    const nowMs = Date.now();

    // Split AOCL envelopes out before grouping so they don't pollute node rows
    const { aoclEnvelopes, otherEnvelopes } = useMemo(() => {
        const all = envelopes || []
        const aocl = []
        const other = []
        for (const e of all) {
            if (isAoclEnvelope(e)) aocl.push(e)
            else other.push(e)
        }
        return { aoclEnvelopes: aocl, otherEnvelopes: other }
    }, [envelopes]);

    const { nodeRows, workflowEvents } = useMemo(
        () => groupEnvelopesByNode(otherEnvelopes),
        [otherEnvelopes]
    );

    const { minTs, maxTs, totalMs } = useMemo(
        () => computeTimeScale(nodeRows, workflowEvents, nowMs),
        [nodeRows, workflowEvents, nowMs]
    );

    const hasData = nodeRows.size > 0 || workflowEvents.length > 0 || aoclEnvelopes.length > 0;

    const executionId = execution?.id

    if (!hasData) {
        return (
            <div className="ewf-empty">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="9" y1="21" x2="9" y2="9"/>
                </svg>
                <p>No node timing data available.<br/>Run the workflow to see a waterfall.</p>
            </div>
        );
    }

    const nodeRowsArr = Array.from(nodeRows.values());

    return (
        <div className="ewf">
            {/* Header bar with total duration */}
            <div className="ewf__header">
                <span className="ewf__title">Execution Waterfall</span>
                <span className="ewf__total-duration">
                    {fmtRelMs(totalMs)} total
                </span>
            </div>

            {/* Time axis ruler */}
            <div className="ewf__ruler">
                <div className="ewf__ruler-label" />
                <div className="ewf__ruler-track">
                    <TimeAxis totalMs={totalMs} tickCount={6} />
                </div>
                <div className="ewf__ruler-dur" />
            </div>

            {/* Workflow-level events row (only if there are markers) */}
            {workflowEvents.length > 0 && (
                <WorkflowLevelRow
                    row={{ started: null, events: workflowEvents }}
                    minTs={minTs}
                    totalMs={totalMs}
                />
            )}

            {/* AOCL cluster — collapsed by default, L1/L3/L8 sub-rows on expand */}
            <AoclClusterRow aoclEnvelopes={aoclEnvelopes} />

            {/* Node rows */}
            {nodeRowsArr.map(row => (
                <NodeRow
                    key={row.nodeId}
                    row={row}
                    minTs={minTs}
                    totalMs={totalMs}
                    nowMs={nowMs}
                    evidenceByNode={evidenceByNode}
                    executionId={executionId}
                />
            ))}
        </div>
    );
}
