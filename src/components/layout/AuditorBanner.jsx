/**
 * AUD-WS-2: Auditor mode banner.
 *
 * Renders at the top of the main content area when the current user's
 * role is 'auditor'. Makes the read-only external-auditor context
 * unmistakable — both for the auditor (no confusion about permissions)
 * and for any screen-sharing demo with buyers / prospects.
 *
 * Design intent:
 *   - Persistent, non-dismissable — the role IS the session context
 *   - Glass aesthetic matching the compliance command center
 *   - Countdown to expiry if set
 *   - Lists the capabilities in scope in plain language
 *   - "Independent audit access" framing, not a warning
 */

import { useMemo } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';

function formatExpiry(expiresAt) {
    if (!expiresAt) return { display: 'no expiry', urgent: false };
    const ms = Date.parse(expiresAt);
    if (Number.isNaN(ms)) return { display: 'unknown', urgent: false };
    const diffDays = Math.ceil((ms - Date.now()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return { display: 'expired', urgent: true };
    if (diffDays === 0) return { display: 'expires today', urgent: true };
    if (diffDays === 1) return { display: 'expires tomorrow', urgent: true };
    if (diffDays <= 7) return { display: `expires in ${diffDays} days`, urgent: true };
    const d = new Date(ms);
    const month = d.toLocaleDateString(undefined, { month: 'short' });
    return { display: `expires ${d.getDate()} ${month} (${diffDays} days)`, urgent: false };
}

export default function AuditorBanner() {
    const { currentOrg } = useWorkspace();
    const role = currentOrg?.membership?.role;
    const expiresAt = currentOrg?.membership?.expires_at;

    const expiry = useMemo(() => formatExpiry(expiresAt), [expiresAt]);

    if (role !== 'auditor') return null;

    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                // Glass panel matched to the compliance aesthetic
                background: 'linear-gradient(180deg, rgba(168,85,247,0.12) 0%, rgba(168,85,247,0.04) 100%)',
                borderBottom: '1px solid rgba(168,85,247,0.35)',
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
            {/* Left — role label */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div
                    aria-hidden
                    style={{
                        width: 34, height: 34, borderRadius: 8,
                        background: 'rgba(168,85,247,0.2)',
                        border: '1px solid rgba(168,85,247,0.5)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 16, color: '#d8b4fe', fontWeight: 700,
                        fontFamily: "'JetBrains Mono',monospace",
                        flexShrink: 0,
                    }}
                >○</div>
                <div style={{ minWidth: 0 }}>
                    <div style={{
                        fontSize: 13, fontWeight: 700, color: '#fff',
                        letterSpacing: 0.2, display: 'flex', gap: 8, alignItems: 'center',
                    }}>
                        Independent Audit Access
                        <span style={{
                            padding: '1px 7px', borderRadius: 4,
                            background: 'rgba(168,85,247,0.25)',
                            border: '1px solid rgba(168,85,247,0.4)',
                            fontSize: 10, fontWeight: 600, color: '#d8b4fe',
                            fontFamily: "'JetBrains Mono',monospace",
                            textTransform: 'uppercase', letterSpacing: 0.5,
                        }}>READ-ONLY</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>
                        Compliance evidence, AOCL audit trail, VOLT chain, WARD witnesses, and assurance packs.
                        Write actions are disabled.
                    </div>
                </div>
            </div>

            {/* Right — expiry countdown */}
            <div
                style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 12px', borderRadius: 6,
                    background: expiry.urgent ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${expiry.urgent ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.1)'}`,
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 11,
                    color: expiry.urgent ? '#fcd34d' : 'rgba(255,255,255,0.75)',
                    whiteSpace: 'nowrap',
                }}
            >
                <span style={{ opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>Access</span>
                <span style={{ fontWeight: 600 }}>{expiry.display}</span>
            </div>
        </div>
    );
}
