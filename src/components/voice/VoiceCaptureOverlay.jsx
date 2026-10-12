import { useEffect, useRef } from 'react';
import './voice-capture-overlay.css';

/**
 * VoiceCaptureOverlay — floating glass panel that shows live waveform + state
 * while the user holds Space to talk. Dismisses when `phase` settles back to idle.
 *
 * Visible phases: requesting-mic, listening, transcribing, done, cancelled, error.
 * Hidden when phase === 'idle'.
 */
export function VoiceCaptureOverlay({
    phase,
    durationMs = 0,
    level = 0,
    transcript = '',
    errorMessage = null,
    getAnalyserData,
    onCancel,
    assistantName = 'Quox',
}) {
    const canvasRef = useRef(null);
    const rafRef = useRef(null);
    const barHistoryRef = useRef([]);

    useEffect(() => {
        if (phase !== 'listening') {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            return;
        }
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        const BAR_COUNT = 64;
        const BAR_GAP = 3;
        const MIN_BAR = 4;

        const draw = () => {
            const data = getAnalyserData?.();
            const { width, height } = canvas;
            ctx.clearRect(0, 0, width, height);

            const hist = barHistoryRef.current;
            if (hist.length !== BAR_COUNT) {
                barHistoryRef.current = new Array(BAR_COUNT).fill(0);
            }

            // downsample freq bins → bars and push to history
            if (data?.freq) {
                const freq = data.freq;
                const step = Math.floor(freq.length / BAR_COUNT);
                for (let i = 0; i < BAR_COUNT; i++) {
                    let sum = 0;
                    for (let j = 0; j < step; j++) sum += freq[i * step + j];
                    const avg = sum / step / 255; // 0..1
                    // exponential smoothing vs previous frame
                    barHistoryRef.current[i] = barHistoryRef.current[i] * 0.55 + avg * 0.45;
                }
            }

            const totalGap = BAR_GAP * dpr * (BAR_COUNT - 1);
            const barWidth = Math.max(2 * dpr, (width - totalGap) / BAR_COUNT);
            const mid = height / 2;

            for (let i = 0; i < BAR_COUNT; i++) {
                const v = barHistoryRef.current[i];
                const h = Math.max(MIN_BAR * dpr, v * (height - 12 * dpr));
                const x = i * (barWidth + BAR_GAP * dpr);
                const y = mid - h / 2;
                // cyan → violet gradient weighted by amplitude
                const grad = ctx.createLinearGradient(0, y, 0, y + h);
                grad.addColorStop(0, `rgba(56, 189, 248, ${0.55 + v * 0.45})`);
                grad.addColorStop(0.5, `rgba(129, 140, 248, ${0.7 + v * 0.3})`);
                grad.addColorStop(1, `rgba(56, 189, 248, ${0.55 + v * 0.45})`);
                ctx.fillStyle = grad;
                const r = Math.min(barWidth / 2, h / 2);
                roundRect(ctx, x, y, barWidth, h, r);
                ctx.fill();
            }

            rafRef.current = requestAnimationFrame(draw);
        };
        rafRef.current = requestAnimationFrame(draw);

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            ro.disconnect();
        };
    }, [phase, getAnalyserData]);

    // Cancel on Escape
    useEffect(() => {
        if (phase === 'idle') return;
        const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [phase, onCancel]);

    if (phase === 'idle') return null;

    const seconds = Math.floor(durationMs / 1000);
    const millis = Math.floor((durationMs % 1000) / 100);
    const timer = `${seconds}.${millis}s`;

    const phaseLabel = {
        'requesting-mic': 'Listening for permission…',
        'listening': 'Listening: release Space to send',
        'transcribing': 'Transcribing…',
        'done': 'Got it',
        'cancelled': 'Cancelled',
        'error': errorMessage || 'Something went wrong',
    }[phase] || '';

    const variant = phase === 'error' ? 'error'
        : phase === 'done' ? 'done'
        : phase === 'cancelled' ? 'cancelled'
        : 'active';

    return (
        <div className={`vco vco--${variant}`} role="dialog" aria-live="polite" aria-label="Voice capture">
            <div className="vco__backdrop" onClick={onCancel} />
            <div className="vco__panel">
                <div className="vco__header">
                    <div className="vco__status-dot" />
                    <span className="vco__status-text">{phaseLabel}</span>
                    <span className="vco__timer">{phase === 'listening' ? timer : ''}</span>
                </div>

                <div className="vco__wave">
                    {phase === 'listening' || phase === 'requesting-mic' ? (
                        <canvas ref={canvasRef} className="vco__canvas" />
                    ) : phase === 'transcribing' ? (
                        <div className="vco__spinner">
                            <svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                <circle cx="20" cy="20" r="16" opacity="0.18" />
                                <path d="M36 20a16 16 0 0 1-16 16" />
                            </svg>
                        </div>
                    ) : phase === 'done' ? (
                        <div className="vco__checkmark">
                            <svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="20" cy="20" r="17" opacity="0.25" />
                                <path d="M12 20l6 6 12-12" />
                            </svg>
                        </div>
                    ) : (
                        <div className="vco__errmark">
                            <svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                <circle cx="20" cy="20" r="17" opacity="0.25" />
                                <line x1="14" y1="14" x2="26" y2="26" />
                                <line x1="26" y1="14" x2="14" y2="26" />
                            </svg>
                        </div>
                    )}
                </div>

                {phase === 'listening' && (
                    <div className="vco__level">
                        <div className="vco__level-bar" style={{ width: `${Math.min(100, Math.round(level * 100))}%` }} />
                    </div>
                )}

                {(phase === 'done' && transcript) && (
                    <div className="vco__transcript">&ldquo;{transcript}&rdquo;</div>
                )}

                <div className="vco__footer">
                    <span className="vco__hint">
                        {phase === 'listening' ? (
                            <>
                                <kbd>Space</kbd> release to send · <kbd>Esc</kbd> cancel
                            </>
                        ) : phase === 'error' ? (
                            <>Say something and try again.</>
                        ) : phase === 'done' ? (
                            <>Sending to {assistantName}…</>
                        ) : null}
                    </span>
                </div>
            </div>
        </div>
    );
}

function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

export default VoiceCaptureOverlay;
