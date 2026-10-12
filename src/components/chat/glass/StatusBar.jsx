/**
 * StatusBar — AOCL layer progress + thinking state indicator
 *
 * Full variant: Multi-line with layer dots, thinking stage, elapsed time, collapsible
 * Compact variant: Single-line dot + label
 */

import { useState, useEffect, useRef, memo } from 'react';

const AOCL_LAYERS = [
    { id: 'L0', label: 'Normalize' },
    { id: 'L1', label: 'Scope' },
    { id: 'L2', label: 'Route' },
    { id: 'L3', label: 'Policy' },
    { id: 'L4', label: 'Plan' },
    { id: 'L5', label: 'Context' },
    { id: 'L6', label: 'Shape' },
    { id: 'L7', label: 'Execute' },
    { id: 'L8', label: 'Verify' },
    { id: 'L9', label: 'Respond' },
    { id: 'L10', label: 'Audit' },
];

function formatElapsed(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export const StatusBar = memo(function StatusBar({
    variant = 'full',
    isProcessing = false,
    thinkingSteps = [],
    currentLayer = null,
    elapsedTime = 0,
}) {
    const [isExpanded, setIsExpanded] = useState(false);

    const latestStep = thinkingSteps.length > 0 ? thinkingSteps[thinkingSteps.length - 1] : null;
    const stageLabel = latestStep?.message || (isProcessing ? 'Initializing...' : 'Ready');

    if (!isProcessing && thinkingSteps.length === 0) {
        return null;
    }

    // Compact variant: single line
    if (variant === 'compact') {
        return (
            <div className="gcp-status gcp-status--compact">
                <span className={`gcp-status__dot ${isProcessing ? 'gcp-status__dot--active' : ''}`} />
                <span className="gcp-status__label">{stageLabel}</span>
                {isProcessing && elapsedTime > 0 && (
                    <span className="gcp-status__elapsed">{formatElapsed(elapsedTime)}</span>
                )}
            </div>
        );
    }

    // Full variant: layer dots + details
    return (
        <div className="gcp-status gcp-status--full">
            <button
                className="gcp-status__header"
                onClick={() => setIsExpanded(!isExpanded)}
                aria-expanded={isExpanded}
            >
                <span className={`gcp-status__dot ${isProcessing ? 'gcp-status__dot--active' : ''}`} />
                <span className="gcp-status__label">{stageLabel}</span>

                {/* AOCL layer dots */}
                <span className="gcp-status__layers">
                    {AOCL_LAYERS.map((layer) => (
                        <span
                            key={layer.id}
                            className={`gcp-status__layer-dot ${currentLayer === layer.id ? 'gcp-status__layer-dot--current' : ''}`}
                            title={`${layer.id}: ${layer.label}`}
                        />
                    ))}
                </span>

                {isProcessing && elapsedTime > 0 && (
                    <span className="gcp-status__elapsed">{formatElapsed(elapsedTime)}</span>
                )}

                <span className="gcp-status__count">
                    {thinkingSteps.length} step{thinkingSteps.length !== 1 ? 's' : ''}
                </span>

                <span className="gcp-status__chevron">
                    <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <path d={isExpanded ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
                    </svg>
                </span>
            </button>

            {isExpanded && thinkingSteps.length > 0 && (
                <div className="gcp-status__detail">
                    {thinkingSteps.map((step, idx) => (
                        <div
                            key={step.id || idx}
                            className={`gcp-status__step ${idx === thinkingSteps.length - 1 && isProcessing ? 'gcp-status__step--latest' : ''}`}
                        >
                            <span className="gcp-status__step-agent">{step.agent}</span>
                            <span className="gcp-status__step-msg">{step.message}</span>
                            {step.elapsed && (
                                <span className="gcp-status__step-time">{step.elapsed}ms</span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
});

export default StatusBar;
