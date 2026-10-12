/**
 * LayerStack - Full AOCL Layer Visualization
 *
 * OSI-model style visualization of all processing layers.
 * Shows real-time status, duration, and progress for each layer.
 * Features sophisticated animations and detailed layer information.
 *
 * Design: Network OSI model meets sci-fi dashboard
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { AOCL_LAYERS, AOCL_LAYER_ORDER, queryEnvelopes, getConversation } from '../../lib/aee';
import { TraceTimeline } from './TraceTimeline';
import './layers.css';

/**
 * LayerStack Component
 *
 * @param {Object} props
 * @param {string} props.corr - Correlation ID to display
 * @param {boolean} props.isProcessing - Whether currently processing
 * @param {Object[]} props.events - Optional pre-fetched layer events
 * @param {Function} props.onClose - Close handler for modal mode
 * @param {boolean} props.showTimeline - Show trace timeline (default: true)
 * @param {boolean} props.showDetails - Show expandable details (default: true)
 * @param {boolean} props.compact - Compact mode (default: false)
 */
export function LayerStack({
    corr,
    isProcessing,
    events: initialEvents,
    onClose,
    showTimeline = true,
    showDetails = true,
    compact = false
}) {
    const [layerEvents, setLayerEvents] = useState(initialEvents || []);
    const [expandedLayer, setExpandedLayer] = useState(null);
    const [totalDuration, setTotalDuration] = useState(null);
    const [runStatus, setRunStatus] = useState(null);

    // Fetch layer events if not provided
    useEffect(() => {
        if (!corr) return;

        const fetchEvents = async () => {
            try {
                const events = await queryEnvelopes({
                    corr,
                    intentPrefix: 'aocl.',
                    limit: 150
                });
                setLayerEvents(events);

                // Get run status
                const runComplete = events.find(e => e.intent === 'aocl.run.complete');
                const runError = events.find(e => e.intent === 'aocl.run.error');

                if (runComplete) {
                    setRunStatus('complete');
                    setTotalDuration(runComplete.payload?.totalDuration_ms);
                } else if (runError) {
                    setRunStatus('error');
                    setTotalDuration(runError.payload?.totalDuration_ms);
                } else if (events.some(e => e.intent === 'aocl.run.start')) {
                    setRunStatus('processing');
                }
            } catch (err) {
                console.warn('[LayerStack] Fetch error:', err);
            }
        };

        fetchEvents();

        // Poll during processing
        if (isProcessing) {
            const interval = setInterval(fetchEvents, 500);
            return () => clearInterval(interval);
        }
    }, [corr, isProcessing]);

    // Build layer states from events
    const layerStates = useMemo(() => {
        const states = {};

        for (const event of layerEvents) {
            if (!event.intent?.startsWith('aocl.layer.')) continue;

            const layer = event.payload?.layer;
            const status = event.payload?.status;

            if (!layer) continue;

            if (!states[layer]) {
                states[layer] = {
                    events: [],
                    status: 'pending',
                    startTime: null,
                    endTime: null,
                    duration_ms: null,
                    payload: {}
                };
            }

            states[layer].events.push(event);

            // Track status progression
            if (status === 'start') {
                states[layer].status = 'active';
                states[layer].startTime = event.ts;
            } else if (status === 'complete') {
                states[layer].status = 'complete';
                states[layer].endTime = event.ts;
                states[layer].duration_ms = event.payload?.duration_ms;
                states[layer].payload = { ...states[layer].payload, ...event.payload };
            } else if (status === 'bypass') {
                states[layer].status = 'bypass';
                states[layer].payload = { ...states[layer].payload, ...event.payload };
            } else if (status === 'reject') {
                states[layer].status = 'reject';
                states[layer].payload = { ...states[layer].payload, ...event.payload };
            }
        }

        return states;
    }, [layerEvents]);

    const formatDuration = useCallback((ms) => {
        if (ms === null || ms === undefined) return '-';
        if (ms < 1) return '<1ms';
        if (ms < 1000) return `${Math.round(ms)}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
    }, []);

    const getStatusClass = useCallback((layerId) => {
        const state = layerStates[layerId];
        if (!state) return 'status-pending';
        return `status-${state.status}`;
    }, [layerStates]);

    const getProgressWidth = useCallback((layerId) => {
        const state = layerStates[layerId];
        if (!state) return 0;

        if (state.status === 'active') return 60; // Animated progress
        if (state.status === 'complete') return 100;
        if (state.status === 'bypass') return 100;
        if (state.status === 'reject') return 100;
        return 0;
    }, [layerStates]);

    const handleLayerClick = useCallback((layerId) => {
        if (!showDetails) return;
        setExpandedLayer(prev => prev === layerId ? null : layerId);
    }, [showDetails]);

    // Calculate stats
    const stats = useMemo(() => {
        let completed = 0;
        let bypassed = 0;
        let failed = 0;

        for (const state of Object.values(layerStates)) {
            if (state.status === 'complete') completed++;
            else if (state.status === 'bypass') bypassed++;
            else if (state.status === 'reject') failed++;
        }

        return { completed, bypassed, failed };
    }, [layerStates]);

    // Determine stack class based on state
    const stackClass = useMemo(() => {
        let cls = 'layer-stack';
        if (isProcessing || runStatus === 'processing') cls += ' is-processing';
        if (runStatus === 'complete') cls += ' is-complete';
        if (runStatus === 'error' || stats.failed > 0) cls += ' has-error';
        if (compact) cls += ' layer-stack--compact';
        return cls;
    }, [isProcessing, runStatus, stats.failed, compact]);

    return (
        <div className={stackClass}>
            <div className="layer-stack-header">
                <span className="layer-stack-title">
                    Processing Layers
                </span>
                <span className="layer-stack-time">
                    {totalDuration ? formatDuration(totalDuration) :
                     isProcessing ? 'Processing...' :
                     runStatus === 'error' ? 'Failed' : '-'}
                </span>
                {onClose && (
                    <button className="layer-details-close" onClick={onClose}>
                        &times;
                    </button>
                )}
            </div>

            <div className="layer-stack-list">
                {AOCL_LAYER_ORDER.map(layerId => {
                    const layer = AOCL_LAYERS[layerId];
                    const state = layerStates[layerId];
                    const isExpanded = expandedLayer === layerId;

                    return (
                        <div key={layerId}>
                            <div
                                className={`layer-row layer-${layerId} ${getStatusClass(layerId)} ${isExpanded ? 'layer-active' : ''}`}
                                onClick={() => handleLayerClick(layerId)}
                                style={{ cursor: showDetails ? 'pointer' : 'default' }}
                                role={showDetails ? 'button' : undefined}
                                tabIndex={showDetails ? 0 : undefined}
                                onKeyDown={(e) => e.key === 'Enter' && handleLayerClick(layerId)}
                            >
                                <span
                                    className="layer-id"
                                    style={{
                                        background: layer?.color ?
                                            `linear-gradient(135deg, ${layer.color} 0%, ${layer.color}dd 100%)` :
                                            undefined
                                    }}
                                >
                                    {layerId}
                                </span>
                                <span className="layer-label">
                                    {layer?.label || layerId}
                                </span>
                                <div className="layer-progress">
                                    <div
                                        className="layer-progress-bar"
                                        style={{
                                            width: `${getProgressWidth(layerId)}%`,
                                            background: layer?.color ?
                                                `linear-gradient(90deg, ${layer.color} 0%, ${layer.color}cc 100%)` :
                                                undefined
                                        }}
                                    />
                                </div>
                                <span className="layer-duration">
                                    {state?.status === 'bypass' ? 'skip' :
                                     state?.status === 'reject' ? 'fail' :
                                     state?.status === 'active' ? '...' :
                                     formatDuration(state?.duration_ms)}
                                </span>
                            </div>

                            {/* Expanded details */}
                            {isExpanded && state && (
                                <div className="layer-details-section" style={{
                                    padding: '12px 12px 12px 54px',
                                    animation: 'fade-in 0.2s ease-out'
                                }}>
                                    <div className="layer-details-section-title">
                                        {layer?.description || `${layerId} Details`}
                                    </div>
                                    <div className="layer-details-payload">
                                        <div><strong>Status:</strong> {state.status}</div>
                                        {state.duration_ms !== null && (
                                            <div><strong>Duration:</strong> {state.duration_ms}ms</div>
                                        )}
                                        {state.startTime && (
                                            <div><strong>Started:</strong> {new Date(state.startTime).toLocaleTimeString()}</div>
                                        )}
                                        {state.payload && Object.keys(state.payload).length > 0 && (
                                            <div style={{ marginTop: '8px' }}>
                                                <strong>Payload:</strong>
                                                <pre style={{
                                                    margin: '4px 0 0 0',
                                                    fontSize: '0.7rem',
                                                    color: '#8b8fa3'
                                                }}>
                                                    {JSON.stringify(state.payload, (k, v) => {
                                                        // Truncate long strings
                                                        if (typeof v === 'string' && v.length > 100) {
                                                            return v.slice(0, 100) + '...';
                                                        }
                                                        return v;
                                                    }, 2)}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Trace Timeline */}
            {showTimeline && Object.keys(layerStates).length > 0 && (
                <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <TraceTimeline
                        layerStates={layerStates}
                        totalDuration={totalDuration}
                    />
                </div>
            )}

            {/* Quick Stats */}
            {!compact && (stats.completed > 0 || stats.bypassed > 0 || stats.failed > 0) && (
                <div style={{
                    display: 'flex',
                    gap: '1rem',
                    marginTop: '1rem',
                    paddingTop: '0.75rem',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    fontSize: '0.7rem'
                }}>
                    {stats.completed > 0 && (
                        <span style={{ color: '#22c55e' }}>
                            {stats.completed} completed
                        </span>
                    )}
                    {stats.bypassed > 0 && (
                        <span style={{ color: '#8b8fa3' }}>
                            {stats.bypassed} skipped
                        </span>
                    )}
                    {stats.failed > 0 && (
                        <span style={{ color: '#ef4444' }}>
                            {stats.failed} failed
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * LayerStackModal - Full screen modal wrapper
 */
export function LayerStackModal({ corr, isProcessing, onClose }) {
    return (
        <>
            <div className="layer-details-backdrop" onClick={onClose} />
            <div className="layer-details-modal">
                <LayerStack
                    corr={corr}
                    isProcessing={isProcessing}
                    onClose={onClose}
                    showTimeline={true}
                    showDetails={true}
                />
            </div>
        </>
    );
}

export default LayerStack;
