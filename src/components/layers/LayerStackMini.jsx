/**
 * LayerStackMini - Compact AOCL Layer Indicator
 *
 * Shows processing progress with:
 * - 11 dot indicators (light up as layers complete)
 * - Active layer text label (e.g., "Thinking...")
 * - Thin progress bar showing completion
 * - Click to expand full LayerStack modal
 *
 * Design: Inspired by HAL-9000's status indicators
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AOCL_LAYERS, AOCL_LAYER_ORDER, queryEnvelopes } from '../../lib/aee';
import './layers.css';

/**
 * Human-readable layer descriptions for the progress label
 */
const LAYER_LABELS = {
    L0: 'Normalizing...',
    L1: 'Scoping...',
    L2: 'Classifying...',
    L3: 'Policy check...',
    L4: 'Planning...',
    L5: 'Loading context...',
    L6: 'Shaping prompt...',
    L7: 'Thinking...',
    L8: 'Verifying...',
    L9: 'Assembling...',
    L10: 'Logging...'
};

/**
 * LayerStackMini Component
 *
 * @param {Object} props
 * @param {string} props.corr - Correlation ID to track
 * @param {boolean} props.isProcessing - Whether currently processing
 * @param {Function} props.onClick - Click handler to expand details
 * @param {string} props.size - 'sm' | 'md' | 'lg' (default: 'md')
 */
export function LayerStackMini({ corr, isProcessing, onClick, size = 'md' }) {
    const [layerStates, setLayerStates] = useState({});
    const [hoveredLayer, setHoveredLayer] = useState(null);
    const [completedCount, setCompletedCount] = useState(0);
    const [hasError, setHasError] = useState(false);
    const [activeLayer, setActiveLayer] = useState(null);

    // Poll for layer events during processing
    useEffect(() => {
        if (!corr) return;

        const fetchLayerStates = async () => {
            try {
                const events = await queryEnvelopes({
                    corr,
                    intentPrefix: 'aocl.',
                    limit: 200
                });

                // Find the latest run start — only consider layer events after it
                let latestRunStart = '';
                for (const event of events) {
                    if (event.intent === 'aocl.run.start' && event.ts > latestRunStart) {
                        latestRunStart = event.ts;
                    }
                }

                // Build layer states from events in the current run only
                const states = {};
                let completed = 0;
                let error = false;
                let currentActive = null;

                for (const event of events) {
                    // Skip events from previous runs
                    if (latestRunStart && event.ts < latestRunStart) continue;
                    // Skip non-layer events (run events)
                    if (!event.intent?.startsWith('aocl.layer')) continue;

                    const layer = event.payload?.layer;
                    const status = event.payload?.status;
                    if (layer && status) {
                        // Use latest status for each layer
                        if (!states[layer] || event.ts > (states[layer].ts || '')) {
                            states[layer] = {
                                status,
                                ts: event.ts,
                                duration_ms: event.payload?.duration_ms
                            };
                        }
                        if (status === 'complete') completed++;
                        if (status === 'reject') error = true;
                        // Track the most recent 'start' event as the active layer
                        if (status === 'start') {
                            if (!currentActive || event.ts > currentActive.ts) {
                                currentActive = { layer, ts: event.ts };
                            }
                        }
                    }
                }

                // Active layer is one that started but hasn't completed
                if (currentActive && states[currentActive.layer]?.status === 'start') {
                    setActiveLayer(currentActive.layer);
                } else {
                    // If no layer is actively "start", show the last completed one
                    setActiveLayer(null);
                }

                setLayerStates(states);
                setCompletedCount(completed);
                setHasError(error);
            } catch (err) {
                console.warn('[LayerStackMini] Poll error:', err);
            }
        };

        fetchLayerStates();

        // Poll during processing
        if (isProcessing) {
            const interval = setInterval(fetchLayerStates, 400);
            return () => clearInterval(interval);
        }
    }, [corr, isProcessing]);

    // Clear states after processing completes (with delay for visual feedback)
    useEffect(() => {
        if (!isProcessing && Object.keys(layerStates).length > 0) {
            const timer = setTimeout(() => {
                setLayerStates({});
                setCompletedCount(0);
                setHasError(false);
                setActiveLayer(null);
            }, 3000);
            return () => clearTimeout(timer);
        }
    }, [isProcessing]);

    const getStatusClass = useCallback((layerId) => {
        const state = layerStates[layerId];
        if (!state) return 'pending';

        switch (state.status) {
            case 'start':
                return 'active';
            case 'complete':
                return 'complete';
            case 'bypass':
                return 'bypass';
            case 'reject':
                return 'reject';
            default:
                return 'pending';
        }
    }, [layerStates]);

    // Calculate progress percentage
    const totalLayers = 6; // Active layers: L0, L2, L5, L7, L9, L10 (skip disabled)
    const progressPercent = useMemo(() => {
        return Math.min(100, Math.round((completedCount / totalLayers) * 100));
    }, [completedCount]);

    // Current status text
    const statusText = useMemo(() => {
        if (hasError) return 'Error';
        if (!isProcessing && completedCount > 0) return `Done (${progressPercent}%)`;
        if (activeLayer) return LAYER_LABELS[activeLayer] || AOCL_LAYERS[activeLayer]?.label || activeLayer;
        // If processing with progress but between layers, show "Processing..." not "Starting..."
        if (isProcessing && completedCount > 0) return 'Processing...';
        if (isProcessing) return 'Starting...';
        return '';
    }, [hasError, isProcessing, activeLayer, completedCount, progressPercent]);

    // Don't render if no correlation ID and not processing
    if (!corr && !isProcessing) {
        return null;
    }

    const sizeClasses = {
        sm: 'layer-stack-mini--sm',
        md: '',
        lg: 'layer-stack-mini--lg'
    };

    return (
        <div
            className={`layer-stack-mini ${sizeClasses[size] || ''} ${hasError ? 'has-error' : ''} ${isProcessing ? 'is-processing' : ''}`}
            onClick={onClick}
            role="button"
            tabIndex={0}
            aria-label={`AOCL Layer Status: ${statusText} ${progressPercent}% complete. Click for details.`}
            onKeyDown={(e) => e.key === 'Enter' && onClick?.()}
        >
            <div className="layer-dots-row">
                {AOCL_LAYER_ORDER.map(layerId => {
                    const state = layerStates[layerId];
                    const statusClass = getStatusClass(layerId);
                    const isHovered = hoveredLayer === layerId;

                    return (
                        <div
                            key={layerId}
                            className={`layer-dot ${statusClass}`}
                            onMouseEnter={() => setHoveredLayer(layerId)}
                            onMouseLeave={() => setHoveredLayer(null)}
                            title={`${layerId}: ${AOCL_LAYERS[layerId]?.label || layerId}`}
                        />
                    );
                })}
            </div>

            {/* Active layer label + progress */}
            {(isProcessing || completedCount > 0) && (
                <div className="layer-status-row">
                    <span className={`layer-status-text ${hasError ? 'layer-status-text--error' : ''}`}>
                        {statusText}
                    </span>
                    {activeLayer && (
                        <span className="layer-status-id">{activeLayer}</span>
                    )}
                </div>
            )}

            {/* Thin progress bar */}
            {(isProcessing || completedCount > 0) && (
                <div className="layer-progress-bar">
                    <div
                        className={`layer-progress-fill ${hasError ? 'layer-progress-fill--error' : ''}`}
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
            )}

            {/* Tooltip for hovered layer */}
            {hoveredLayer && (
                <div className="layer-stack-mini-tooltip">
                    <div style={{ fontWeight: 600, color: '#38bdf8' }}>
                        {hoveredLayer}
                    </div>
                    <div style={{ color: '#e8eaed' }}>
                        {AOCL_LAYERS[hoveredLayer]?.label}
                    </div>
                    <div style={{ color: '#8b8fa3', fontSize: '0.65rem' }}>
                        {layerStates[hoveredLayer]?.status || 'pending'}
                        {layerStates[hoveredLayer]?.duration_ms &&
                            ` - ${layerStates[hoveredLayer].duration_ms}ms`
                        }
                    </div>
                </div>
            )}
        </div>
    );
}

export default LayerStackMini;
