/**
 * ThinkingDisplay — Glass Waterfall Thinking Visualization
 *
 * APM-style waterfall showing real-time pipeline stages as they execute.
 * Each step renders as a horizontal bar proportional to its duration.
 * Active step bar grows live. Completed steps lock in place.
 *
 * Glass Design System compliant:
 * - No grey text (min opacity 0.6 on white)
 * - Purple-cyan active states
 * - Shimmer overlay
 * - Glass morphism container
 */

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import './ThinkingDisplay.css';

// AOCL-inspired stage colors
const STAGE_COLORS = {
    routing:        '#38bdf8', // cyan
    processing:     '#a855f7', // purple
    generating:     '#22c55e', // green
    api_call:       '#f59e0b', // amber
    streaming:      '#38bdf8', // cyan
    routing_detail: '#8b5cf6', // light purple
};

const STAGE_ICONS = {
    routing: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7',
    processing: 'M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
    generating: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
    api_call: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3',
    streaming: 'M5 3l14 9-14 9V3z',
    routing_detail: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 16v-4M12 8h.01',
};

function formatMs(ms) {
    if (ms == null || Number.isNaN(ms)) return '—';
    if (ms < 1) return '<1ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compute durations for each step.
 *
 * Status-aware (AOCL-DISPATCH-B15):
 *   - status='complete'/'bypass'/'reject' → use envelope's elapsed
 *   - status='active' → live-tick from this step's ts to `now`
 *   - status='pending' → null (rendered as '—', no bar)
 *   - legacy (no status) → fall back to elapsed > ts-diff
 */
function computeStepDurations(steps, isActive, now) {
    if (steps.length === 0) return [];

    return steps.map((step, i) => {
        if (step.status === 'pending') {
            return { ...step, computedDuration: null };
        }
        if (step.status === 'active') {
            const startTs = step.ts || now;
            return { ...step, computedDuration: Math.max(0, now - startTs) };
        }
        if (typeof step.elapsed === 'number' && step.elapsed >= 0) {
            return { ...step, computedDuration: step.elapsed };
        }
        // Legacy / fallback
        const startTs = step.ts;
        let duration;
        if (i < steps.length - 1) duration = steps[i + 1].ts - startTs;
        else if (isActive) duration = now - startTs;
        else duration = step.elapsed || 0;
        return { ...step, computedDuration: Math.max(0, duration) };
    });
}

/**
 * Single waterfall row
 */
const WaterfallRow = memo(function WaterfallRow({
    step, isLatest, barWidthPct, barOffsetPct, color
}) {
    const iconPath = STAGE_ICONS[step.stage] || STAGE_ICONS.processing;

    // AOCL-DISPATCH-B15: status drives row appearance.
    //   - 'pending' → dimmed (opacity 0.4), no bar, "—" duration
    //   - 'active'  → highlighted, growing bar via computedDuration
    //   - 'complete'/'bypass'/'reject' → normal full-color
    const layerColor = step.agentColor || color
    const isPending = step.status === 'pending'
    const isStatusActive = step.status === 'active' || isLatest
    const rowOpacity = isPending ? 0.45 : 1
    const rowClass = `tw-row ${isStatusActive ? 'tw-row--active' : ''} ${isPending ? 'tw-row--pending' : ''}`
    return (
        <div className={rowClass} style={{ opacity: rowOpacity }}>
            {/* Agent badge */}
            <div className="tw-row__agent" style={{ '--agent-color': layerColor }}>
                {step.layer ? (
                    <span
                        className={`layer-badge layer-${step.layer} tw-row__layer-pill`}
                        style={{
                            background: isPending ? 'rgba(255,255,255,0.08)' : layerColor,
                            color: isPending ? 'rgba(255,255,255,0.5)' : '#fff',
                        }}
                        title={step.layer}
                    >
                        {step.layer}
                    </span>
                ) : (
                    <svg className="tw-row__icon" viewBox="0 0 24 24" width="12" height="12"
                        fill="none" stroke={layerColor} strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round">
                        <path d={iconPath} />
                    </svg>
                )}
                <span className="tw-row__agent-label" style={{ color: 'rgba(255,255,255,0.85)' }}>{step.agent}</span>
            </div>

            {/* Message */}
            <span className="tw-row__message">{step.message}</span>

            {/* Waterfall bar track */}
            <div className="tw-row__track">
                <div
                    className={`tw-row__bar ${isLatest ? 'tw-row__bar--live' : ''}`}
                    style={{
                        left: `${barOffsetPct}%`,
                        width: `${Math.max(barWidthPct, 1)}%`,
                        '--bar-color': color,
                    }}
                >
                    {isLatest && <div className="tw-row__bar-glow" />}
                </div>
            </div>

            {/* Duration */}
            <span className="tw-row__duration" style={{ color }}>
                {formatMs(step.computedDuration)}
            </span>
        </div>
    );
});

/**
 * ThinkingDisplay — Main waterfall component
 */
export function ThinkingDisplay({
    steps = [],
    isActive = false,
    collapsed = false,
    className = ''
}) {
    // Honor `collapsed` as the initial state so MessageTrace can render
    // per-message traces collapsed-by-default. The user can still toggle.
    const [isCollapsed, setIsCollapsed] = useState(collapsed);
    const [now, setNow] = useState(Date.now());
    const [debouncedActive, setDebouncedActive] = useState(isActive);
    const containerRef = useRef(null);
    const hideTimerRef = useRef(null);

    // Expand when new processing starts
    useEffect(() => {
        if (isActive) setIsCollapsed(false);
    }, [isActive]);

    // Debounce isActive: show immediately, delay hide by 200ms
    useEffect(() => {
        if (isActive) {
            if (hideTimerRef.current) {
                clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
            setDebouncedActive(true);
        } else {
            hideTimerRef.current = setTimeout(() => setDebouncedActive(false), 200);
        }
        return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
    }, [isActive]);

    // Tick for live duration updates
    useEffect(() => {
        if (!debouncedActive) return;
        const id = setInterval(() => setNow(Date.now()), 50);
        return () => clearInterval(id);
    }, [debouncedActive]);

    // Auto-scroll: when a new row arrives during processing, scroll the
    // latest row into view (within both the body container and any outer
    // chat scroller). scrollIntoView with block:'nearest' avoids fighting
    // the chat list's own scroll position when the trace is at the bottom.
    useEffect(() => {
        if (isCollapsed || !containerRef.current || steps.length === 0) return;
        const lastRow = containerRef.current.querySelector('.tw-row:last-child');
        if (lastRow && typeof lastRow.scrollIntoView === 'function') {
            lastRow.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        } else {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [steps.length, isCollapsed]);

    // Compute durations and waterfall positions
    const waterfallData = useMemo(() => {
        const enriched = computeStepDurations(steps, debouncedActive, now);
        if (enriched.length === 0) return { rows: [], totalDuration: 0, startTs: 0 };

        const startTs = enriched[0].ts;
        const totalDuration = Math.max(now - startTs, 1);

        const rows = enriched.map((step) => {
            const offset = step.ts - startTs;
            const barOffsetPct = (offset / totalDuration) * 100;
            const barWidthPct = (step.computedDuration / totalDuration) * 100;
            const color = STAGE_COLORS[step.stage] || '#8b5cf6';

            return { step, barOffsetPct, barWidthPct, color };
        });

        return { rows, totalDuration, startTs };
    }, [steps, debouncedActive, now]);

    if (steps.length === 0 && !debouncedActive) return null;

    const showBody = !isCollapsed;

    const { rows, totalDuration } = waterfallData;
    const totalElapsed = debouncedActive && steps.length > 0
        ? now - steps[0].ts
        : (steps.length > 0 ? (steps[steps.length - 1].ts - steps[0].ts + (steps[steps.length - 1].computedDuration || 0)) : 0);

    return (
        <div className={`tw ${debouncedActive ? 'tw--active' : ''} ${isCollapsed ? 'tw--collapsed' : ''} ${className}`} data-steps={steps.length} data-rows={rows.length}>
            <div className="tw__shimmer" />

            {/* Header */}
            <button
                className="tw__header"
                onClick={() => setIsCollapsed(!isCollapsed)}
                aria-expanded={!isCollapsed}
            >
                <span className="tw__indicator">
                    {debouncedActive
                        ? <span className="tw__pulse" />
                        : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                    }
                </span>
                <span className="tw__title">
                    {debouncedActive ? 'Processing' : 'Trace Complete'}
                </span>

                {/* Mini layer dots */}
                {debouncedActive && (
                    <span className="tw__dots">
                        {steps.map((s, i) => (
                            <span
                                key={s.id}
                                className={`tw__dot ${i === steps.length - 1 ? 'tw__dot--active' : 'tw__dot--done'}`}
                                style={{ background: STAGE_COLORS[s.stage] || '#8b5cf6' }}
                            />
                        ))}
                    </span>
                )}

                <span className="tw__meta">
                    {totalElapsed > 0 && (
                        <span className="tw__elapsed">{formatMs(totalElapsed)}</span>
                    )}
                    <span className="tw__count">{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
                </span>

                <span className="tw__chevron">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d={isCollapsed ? "M6 9l6 6 6-6" : "M18 15l-6-6-6 6"} />
                    </svg>
                </span>
            </button>

            {/* Waterfall body */}
            {showBody && (
                <div className="tw__body" ref={containerRef}>
                    {rows.length > 0 ? (
                        <>
                            <div className="tw__waterfall">
                                {rows.map(({ step, barOffsetPct, barWidthPct, color }, i) => (
                                    <WaterfallRow
                                        key={step.id || i}
                                        step={step}
                                        // AOCL-DISPATCH-B15: pick the row marked status='active'
                                        // over "last in array". Falls back to last-in-array for
                                        // legacy steps without status.
                                        isLatest={step.status === 'active'
                                            || (debouncedActive && !rows.some(r => r.step.status === 'active') && i === rows.length - 1)}
                                        barWidthPct={barWidthPct}
                                        barOffsetPct={barOffsetPct}
                                        color={color}
                                    />
                                ))}
                            </div>

                            {/* Time scale */}
                            <div className="tw__scale">
                                <span>0ms</span>
                                <span>{formatMs(totalDuration / 2)}</span>
                                <span>{formatMs(totalDuration)}</span>
                            </div>
                        </>
                    ) : (
                        <div className="tw__waiting">
                            <span className="tw__waiting-dots"><span /><span /><span /></span>
                            Initializing pipeline...
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * ThinkingBadge — Compact inline badge showing thinking status
 */
export function ThinkingBadge({ isActive, stepCount = 0, onClick }) {
    if (!isActive && stepCount === 0) return null;

    return (
        <button
            className={`tw-badge ${isActive ? 'tw-badge--active' : ''}`}
            onClick={onClick}
            title={isActive ? 'View thinking process' : `${stepCount} thinking steps`}
        >
            {isActive
                ? <span className="tw-badge__pulse" />
                : <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            }
            {stepCount > 0 && <span className="tw-badge__count">{stepCount}</span>}
        </button>
    );
}

export default ThinkingDisplay;
