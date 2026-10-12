/**
 * HeaderInboxBadge — top-header inbox indicator.
 *
 * Surfaces AWAITING APPROVALS distinctly from total unread: an approval is a
 * call to action (something is blocked on the human), not just an unread
 * notification. When approvals are pending it shows an amber, gently-pulsing
 * "N to approve" pill that deep-links straight to the Approvals folder; the
 * neutral inbox icon + unread count sits alongside (or alone when there are no
 * approvals). Polls via useInboxStats (60s).
 */

import { useNavigate } from 'react-router-dom'
import { useInboxStats } from '../../hooks/useInboxStats'

const ICON_COLOR = 'rgba(255,255,255,0.85)'
// Amber = "needs your action", deliberately distinct from the cyan/purple
// chrome so a waiting approval is unmissable in the top bar.
const APPROVAL_ACCENT = '#fbbf24'

function InboxIcon({ size = 16, color = ICON_COLOR }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ display: 'block', flexShrink: 0 }}>
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
    )
}

// Shield with a check — "awaiting approval / governed decision".
function ApprovalIcon({ size = 15, color = APPROVAL_ACCENT }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ display: 'block', flexShrink: 0 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <polyline points="9 12 11 14 15 10" />
        </svg>
    )
}

export default function HeaderInboxBadge() {
    const navigate = useNavigate()
    const { stats } = useInboxStats({ pollInterval: 60000 })

    const unread = stats?.unread ?? 0
    const approvals = stats?.pending_approvals ?? 0
    const unreadDisplay = unread > 99 ? '99+' : unread
    const approvalsDisplay = approvals > 99 ? '99+' : approvals

    return (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {/* Pulse keyframe — self-contained, scoped by the unique class below. */}
            <style>{`@keyframes qx-approval-pulse {
                0%,100% { box-shadow: 0 0 0 0 rgba(251,191,36,0.30); }
                50%     { box-shadow: 0 0 0 4px rgba(251,191,36,0.00); }
            }`}</style>

            {approvals > 0 && (
                <button
                    type="button"
                    onClick={() => navigate('/inbox?folder=approvals')}
                    title={`${approvals} awaiting your approval`}
                    aria-label={`${approvals} awaiting your approval`}
                    className="header-approval-badge"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '5px 10px',
                        background: 'rgba(251,191,36,0.14)',
                        border: '1px solid rgba(251,191,36,0.45)',
                        borderRadius: 999,
                        cursor: 'pointer',
                        color: APPROVAL_ACCENT,
                        font: 'inherit',
                        lineHeight: 1,
                        animation: 'qx-approval-pulse 2.4s ease-in-out infinite',
                    }}
                >
                    <ApprovalIcon />
                    <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, fontWeight: 700, color: APPROVAL_ACCENT }}>
                        {approvalsDisplay}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: APPROVAL_ACCENT, letterSpacing: 0.2 }}>
                        to approve
                    </span>
                </button>
            )}

            <button
                type="button"
                onClick={() => navigate('/inbox')}
                title={unread > 0 ? `${unread} unread` : 'Inbox'}
                aria-label={unread > 0 ? `Inbox — ${unread} unread` : 'Inbox'}
                className="header-inbox-badge"
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: ICON_COLOR,
                    font: 'inherit',
                    lineHeight: 1,
                }}
            >
                <InboxIcon />
                {unread > 0 && (
                    <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, fontWeight: 600, color: ICON_COLOR }}>
                        {unreadDisplay}
                    </span>
                )}
            </button>
        </div>
    )
}
