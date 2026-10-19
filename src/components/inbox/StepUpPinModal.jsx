/**
 * StepUpPinModal (QUOXON-STEPUP): the "a person must confirm this" card. Same look as the terminal card:
 * gold frame/title/filled dots, ink for empty dots, green AUTHORISED, red DENIED/LOCKED. Glass design
 * system, no grey text, buttons are .glass-btn. The digits are held in local state only and shown as dots.
 */
import { useEffect, useRef, useState } from 'react';

const GOLD = 'var(--qx-gold, #d4af37)';
const GREEN = 'var(--ui-green, #4ade80)';
const RED = 'var(--ui-red-light, #f87171)';
const INK = 'var(--text-primary, #f1f5f9)';
const PIN_LEN = 6;

export default function StepUpPinModal({ card, onSubmit, onCancel }) {
    const [pin, setPin] = useState('');
    const ref = useRef(null);
    const phase = card.phase;
    useEffect(() => { setPin(''); if (phase === 'input' || phase === 'denied') ref.current?.focus(); }, [card.key, phase]);

    const type = (v) => {
        const d = v.replace(/\D/g, '').slice(0, PIN_LEN);
        setPin(d);
        if (d.length === PIN_LEN) { onSubmit(d); setPin(''); }
    };
    const entering = phase === 'input' || phase === 'denied';
    const subject = card.subject || {};
    const status = {
        verifying: { text: '▰▰▰▰ verifying', color: GOLD },
        ok: { text: '✔ AUTHORISED · human present for 10:00', color: GREEN },
        denied: { text: `✖ DENIED${Number.isFinite(card.triesLeft) ? ` · ${card.triesLeft} ${card.triesLeft === 1 ? 'try' : 'tries'} left` : ''}`, color: RED },
        locked: { text: '⛔ LOCKED · use your phone or a human session', color: RED },
        agent: { text: 'needs a person: approve from your phone or a human session', color: RED },
    }[phase];

    return (
        <div role="dialog" aria-modal="true" aria-label="Authorisation required"
            onMouseDown={() => entering && onCancel()}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
            <div className="glass-card" onMouseDown={(e) => e.stopPropagation()}
                style={{ width: 'min(440px, 92vw)', border: `1px solid ${GOLD}`, display: 'flex', flexDirection: 'column', gap: 12, color: INK }}>
                <div style={{ color: GOLD, fontWeight: 700, letterSpacing: 0.5, fontSize: 13 }}>🔐 AUTHORISATION REQUIRED</div>
                {subject.line1 && <div style={{ fontSize: 13 }}>{subject.line1}</div>}
                {(subject.raisedBy || subject.risk) && (
                    <div style={{ fontSize: 12 }}>
                        {subject.raisedBy && <>raised by {subject.raisedBy}</>}
                        {subject.risk && <> · risk <span style={{ color: /high|urgent/.test(subject.risk) ? RED : INK, fontWeight: 600 }}>{subject.risk}</span></>}
                    </div>
                )}

                {phase === 'no_pin' ? (
                    <div style={{ fontSize: 13 }}>
                        Set a PIN in Settings &gt; Account first. <a href="/settings#account/profile" style={{ color: GOLD, fontWeight: 600 }}>Open Settings</a>
                    </div>
                ) : (
                    <>
                        {(entering || phase === 'verifying' || phase === 'ok') && (
                            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 18, letterSpacing: 4 }} aria-hidden="true">
                                PIN&nbsp;&nbsp;
                                {Array.from({ length: PIN_LEN }, (_, i) => (
                                    <span key={i} style={{ color: i < pin.length ? GOLD : INK }}>{i < pin.length ? '●' : '○'}{i < PIN_LEN - 1 ? ' ' : ''}</span>
                                ))}
                            </div>
                        )}
                        {entering && (
                            <input ref={ref} className="glass-input" type="password" inputMode="numeric" autoComplete="off" maxLength={PIN_LEN}
                                aria-label="PIN" value={pin} onChange={(e) => type(e.target.value)} placeholder="6-digit PIN"
                                style={{ padding: '8px 10px' }} />
                        )}
                        {status && <div role="status" aria-live="polite" style={{ color: status.color, fontWeight: 600, fontSize: 13 }}>{status.text}</div>}
                    </>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                    <span>a person must confirm this · Esc cancels</span>
                    {phase !== 'verifying' && phase !== 'ok' && <button type="button" className="glass-btn" onClick={onCancel}>{entering ? 'Cancel' : 'Close'}</button>}
                </div>
            </div>
        </div>
    );
}
