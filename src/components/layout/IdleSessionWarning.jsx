/**
 * TRUST-GATE-1.14c — inactivity warning banner.
 *
 * Renders only while AuthContext's idle countdown is inside its warning
 * window (see AuthContext.jsx). Purely advisory: dismissing it (or letting
 * it expire) never itself logs the user out — the server-authoritative
 * 401 → logout path is untouched. When an org/instance disables idle
 * logout (idleTimeoutSec === 0) AuthContext never arms the countdown, so
 * this component simply never renders.
 */

import { useAuth } from '../../contexts/AuthContext';

export default function IdleSessionWarning() {
    const { idleWarning, staySignedIn } = useAuth();

    if (!idleWarning?.visible) return null;

    return (
        <div
            role="alertdialog"
            aria-live="assertive"
            aria-label="Session about to expire"
            style={{
                background: 'linear-gradient(180deg, rgba(245,158,11,0.14) 0%, rgba(245,158,11,0.05) 100%)',
                borderBottom: '1px solid rgba(245,158,11,0.4)',
                padding: '12px 24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                fontFamily: "'Inter',system-ui,sans-serif",
                backdropFilter: 'blur(20px) saturate(1.8)',
                WebkitBackdropFilter: 'blur(20px) saturate(1.8)',
                flexWrap: 'wrap',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div
                    aria-hidden
                    style={{
                        width: 34, height: 34, borderRadius: 8,
                        background: 'rgba(245,158,11,0.2)',
                        border: '1px solid rgba(245,158,11,0.5)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 16, color: '#fcd34d', fontWeight: 700,
                        fontFamily: "'JetBrains Mono',monospace",
                        flexShrink: 0,
                    }}
                >!</div>
                <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', letterSpacing: 0.2 }}>
                        You'll be signed out in {idleWarning.secondsRemaining}s due to inactivity
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>
                        Your organisation's session policy signs out idle members automatically.
                    </div>
                </div>
            </div>

            <button
                type="button"
                onClick={staySignedIn}
                style={{
                    padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: 'rgba(245,158,11,0.2)', border: '1px solid rgba(245,158,11,0.5)',
                    color: '#fcd34d', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
            >
                Stay signed in
            </button>
        </div>
    );
}
