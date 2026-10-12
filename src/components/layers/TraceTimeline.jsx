/**
 * TraceTimeline - APM-style Waterfall Timeline
 *
 * Shows layer durations as horizontal bars in a waterfall view,
 * similar to Application Performance Monitoring tools like Datadog/NewRelic.
 *
 * Features:
 * - Waterfall visualization of layer timing
 * - Hover effects with detailed tooltips
 * - Grid lines for timing reference
 * - Total duration summary
 */

import { useMemo } from 'react';
import { AOCL_LAYERS, AOCL_LAYER_ORDER } from '../../lib/aee';
import './layers.css';

/**
 * TraceTimeline Component
 *
 * @param {Object} props
 * @param {Object} props.layerStates - Layer state data from LayerStack
 * @param {number} props.totalDuration - Total run duration in ms
 * @param {boolean} props.showLabels - Show layer labels (default: true)
 */
export function TraceTimeline({ layerStates = {}, totalDuration, showLabels = true }) {
    // Build timeline data
    const timelineData = useMemo(() => {
        if (!layerStates || Object.keys(layerStates).length === 0) {
            return [];
        }

        // Calculate total for percentage calculations
        // Use actual layer durations to compute positions
        let maxEndTime = 0;
        const layerTimings = [];

        for (const layerId of AOCL_LAYER_ORDER) {
            const state = layerStates[layerId];
            if (!state || state.status === 'pending') continue;

            const duration = state.duration_ms || 0;
            layerTimings.push({
                layerId,
                duration,
                status: state.status
            });

            // Track cumulative time for waterfall
            maxEndTime += duration;
        }

        // Build entries with waterfall positioning
        const total = totalDuration || maxEndTime || 1;
        let currentOffset = 0;
        const entries = [];

        for (const timing of layerTimings) {
            const { layerId, duration, status } = timing;
            const widthPercent = Math.max((duration / total) * 100, 0.5);
            const offsetPercent = (currentOffset / total) * 100;

            entries.push({
                layerId,
                label: AOCL_LAYERS[layerId]?.label || layerId,
                color: AOCL_LAYERS[layerId]?.color || '#6b7280',
                duration,
                status,
                widthPercent,
                offsetPercent
            });

            currentOffset += duration;
        }

        return entries;
    }, [layerStates, totalDuration]);

    const formatDuration = (ms) => {
        if (ms === null || ms === undefined) return '-';
        if (ms < 1) return '<1ms';
        if (ms < 1000) return `${Math.round(ms)}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
    };

    // Calculate actual total from layer durations
    const actualTotal = useMemo(() => {
        return timelineData.reduce((sum, entry) => sum + entry.duration, 0);
    }, [timelineData]);

    if (timelineData.length === 0) {
        return null;
    }

    return (
        <div className="trace-timeline">
            <div className="trace-timeline-header">
                <span className="trace-timeline-title">Execution Timeline</span>
                <span className="trace-timeline-total">
                    {formatDuration(totalDuration || actualTotal)}
                </span>
            </div>

            <div className="trace-timeline-chart">
                {timelineData.map(entry => (
                    <div key={entry.layerId} className="trace-timeline-row">
                        {showLabels && (
                            <span className="trace-timeline-label">
                                {entry.label}
                            </span>
                        )}
                        <div className="trace-timeline-bar-container">
                            <div
                                className={`trace-timeline-bar layer-${entry.layerId}`}
                                style={{
                                    left: `${entry.offsetPercent}%`,
                                    width: `${Math.max(entry.widthPercent, 0.5)}%`,
                                    background: entry.color ?
                                        `linear-gradient(90deg, ${entry.color} 0%, ${entry.color}bb 100%)` :
                                        undefined,
                                    opacity: entry.status === 'bypass' ? 0.25 : 1
                                }}
                                title={`${entry.label}: ${formatDuration(entry.duration)}`}
                            />
                        </div>
                        <span className="trace-timeline-duration">
                            {entry.status === 'bypass' ? '-' : formatDuration(entry.duration)}
                        </span>
                    </div>
                ))}
            </div>

            {/* Time scale markers */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: '8px',
                marginLeft: showLabels ? '70px' : '0',
                marginRight: '55px',
                fontSize: '0.6rem',
                color: '#5c5f70'
            }}>
                <span>0ms</span>
                <span>{formatDuration((totalDuration || actualTotal) / 2)}</span>
                <span>{formatDuration(totalDuration || actualTotal)}</span>
            </div>
        </div>
    );
}

export default TraceTimeline;
