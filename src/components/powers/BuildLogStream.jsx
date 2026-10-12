/**
 * BuildLogStream — renders a scrolling build log terminal + state pill.
 *
 * Props:
 *   logs        - array of { line_no, ts, stream, content } objects
 *   buildState  - 'pending' | 'building' | 'built' | 'failed'
 *   elapsedSec  - number: seconds elapsed since build start
 *   maxLines    - cap rendered lines to avoid DOM bloat (default 200)
 */

import { useEffect, useRef } from 'react';
import './BuildLogStream.css';

const STATE_LABELS = {
    pending: 'Pending',
    building: 'Building',
    built: 'Built',
    failed: 'Failed',
};

const STATE_CLASSES = {
    pending: 'bls-pill--pending',
    building: 'bls-pill--building',
    built: 'bls-pill--built',
    failed: 'bls-pill--failed',
};

function formatElapsed(sec) {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
}

export default function BuildLogStream({ logs = [], buildState = 'pending', elapsedSec = 0, maxLines = 200 }) {
    const preRef = useRef(null);

    // Auto-scroll to bottom when logs change
    useEffect(() => {
        if (preRef.current) {
            preRef.current.scrollTop = preRef.current.scrollHeight;
        }
    }, [logs]);

    const visibleLogs = logs.length > maxLines ? logs.slice(logs.length - maxLines) : logs;
    const stateLabel = STATE_LABELS[buildState] || buildState;
    const stateClass = STATE_CLASSES[buildState] || 'bls-pill--pending';

    return (
        <div className="bls-root">
            <div className="bls-header">
                <span className={`bls-pill ${stateClass}`}>
                    {buildState === 'building' && <span className="bls-spinner" />}
                    {stateLabel}
                </span>
                <span className="bls-elapsed">
                    {formatElapsed(elapsedSec)}
                </span>
                <span className="bls-log-count">
                    {logs.length} line{logs.length !== 1 ? 's' : ''}
                </span>
            </div>
            <pre className="bls-pre" ref={preRef}>
                {visibleLogs.length === 0 && buildState === 'pending' && (
                    <span className="bls-placeholder">Waiting for build to start&hellip;</span>
                )}
                {visibleLogs.map((line, i) => (
                    <span
                        key={line.line_no != null ? line.line_no : i}
                        className={`bls-line${line.stream === 'stderr' ? ' bls-line--stderr' : ''}`}
                    >
                        {line.content}
                        {'\n'}
                    </span>
                ))}
            </pre>
        </div>
    );
}
