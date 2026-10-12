/**
 * UpdateProgress — Step-by-step update progress with SSE streaming
 *
 * Shows each step's status (pending, running, completed, failed)
 * with a cancel button for in-progress updates.
 */

const STEP_ICONS = {
    pending: { stroke: '#6b7280', d: 'M12 2a10 10 0 100 20 10 10 0 000-20z' },
    running: { stroke: '#3b82f6', d: 'M12 2a10 10 0 100 20 10 10 0 000-20z' },
    completed: { stroke: '#10b981', d: 'M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3' },
    failed: { stroke: '#ef4444', d: 'M12 2a10 10 0 100 20 10 10 0 000-20zM15 9l-6 6M9 9l6 6' }
};

function formatDuration(ms) {
    if (!ms) return '';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    return `${mins}m ${remainSecs}s`;
}

function UpdateProgress({ progress, onCancel }) {
    const { steps, currentStep, status, error, message, durationMs, connected } = progress;

    const isTerminal = status === 'completed' || status === 'failed';

    return (
        <div className={`update-progress ${isTerminal ? `update-progress--${status}` : ''}`}>
            <div className="update-progress__header">
                <h3>
                    {status === 'completed' ? 'Update Complete' :
                     status === 'failed' ? 'Update Failed' :
                     'Updating QuoxCORE...'}
                </h3>
                {connected && !isTerminal && (
                    <span className="update-progress__live">
                        <span className="update-progress__live-dot" />
                        Live
                    </span>
                )}
            </div>

            {message && (
                <div className="update-progress__message">{message}</div>
            )}

            <div className="update-progress__steps">
                {(steps || []).map((step, i) => {
                    const iconCfg = STEP_ICONS[step.status] || STEP_ICONS.pending;
                    const isActive = step.status === 'running';

                    return (
                        <div
                            key={step.name || i}
                            className={`update-progress__step ${isActive ? 'update-progress__step--active' : ''} update-progress__step--${step.status || 'pending'}`}
                        >
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={iconCfg.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d={iconCfg.d} />
                            </svg>
                            <span className="update-progress__step-label">
                                {step.label || step.name}
                            </span>
                            {isActive && (
                                <span className="update-progress__step-spinner" />
                            )}
                        </div>
                    );
                })}
            </div>

            {error && (
                <div className="update-progress__error">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="#ef4444">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                    </svg>
                    <span>{error}</span>
                </div>
            )}

            {durationMs && isTerminal && (
                <div className="update-progress__duration">
                    Completed in {formatDuration(durationMs)}
                </div>
            )}

            {!isTerminal && onCancel && (
                <button className="update-progress__cancel" onClick={onCancel}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" />
                    </svg>
                    Cancel Update
                </button>
            )}
        </div>
    );
}

export default UpdateProgress;
