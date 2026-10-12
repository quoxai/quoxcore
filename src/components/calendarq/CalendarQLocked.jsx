/**
 * CalendarQLocked — the unentitled state for /calendarq.
 *
 * Mirrors InboxQLocked.jsx (same qx-* classes, same "steps then CTA" shape)
 * so paid-plugin locked states stay visually consistent across the
 * dashboard. See src/components/inboxq/InboxQLocked.jsx.
 */
import { useNavigate } from 'react-router-dom'
import MANIFEST from '../../config/plugins/calendar-q.json'  // price from the manifest, never a hard-coded string (drifted to 'bundle'/'Included' while the store charged)

function CalendarIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function PlusIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

const STEPS = [
  {
    title: 'Connect',
    body: 'Connect a provider calendar via OAuth (Google today), or let Calendar-Q see your internal events, team schedules, and workflow cron automatically.',
    icon: <CalendarIcon size={18} />,
  },
  {
    title: 'Overlay',
    body: 'Every connected layer merges into one agenda, each with its own honest coverage state — complete, stale, partial, or disconnected.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    title: 'Spot clashes',
    body: 'Overlapping human commitments are flagged and cited against the exact window checked. Event creation arrives with approvals in the next phase.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
]

const FEATURE_CHIPS = ['Agenda', 'Layered overlay', 'Clash detection', 'Read-first']

export default function CalendarQLocked({ priceDisplay = MANIFEST.priceDisplay }) {
  const navigate = useNavigate()

  return (
    <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <section
        className="qx-card"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px 24px' }}
      >
        <div style={{ width: '100%', maxWidth: 780, textAlign: 'center' }}>
          <div className="calq-lock-hero" aria-hidden="true">
            <span className="calq-lock-hero__glow" />
            <span className="calq-lock-hero__icon"><CalendarIcon size={38} /></span>
          </div>

          <div className="qx-badge" style={{ marginTop: 6 }}>Calendar-Q &middot; not yet activated</div>

          <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em', margin: '14px 0 10px', textWrap: 'balance' }}>
            Talk to your calendar, with receipts.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)', maxWidth: 600, margin: '0 auto 18px' }}>
            Calendar-Q merges a connected provider calendar with your internal events, team
            schedules, and workflow cron into one layered agenda, quoting the coverage it actually
            checked rather than claiming a clean calendar beyond what it saw.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
            {FEATURE_CHIPS.map((f) => (
              <span key={f} style={{
                padding: '4px 10px', borderRadius: 12, fontSize: 12,
                background: 'rgba(168,85,247,0.10)', color: 'rgba(255,255,255,0.7)',
                border: '1px solid rgba(168,85,247,0.22)'
              }}>{f}</span>
            ))}
          </div>

          <div className="qx-grid-3" style={{ textAlign: 'left', marginBottom: 26 }}>
            {STEPS.map((s) => (
              <div key={s.title} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <span
                  style={{
                    display: 'inline-flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
                    borderRadius: 9, color: '#c9a3ff', background: 'rgba(168,85,247,0.10)', border: '1px solid rgba(168,85,247,0.28)',
                  }}
                >{s.icon}</span>
                <strong style={{ fontSize: 14 }}>{s.title}</strong>
                <span style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(255,255,255,0.6)' }}>{s.body}</span>
              </div>
            ))}
          </div>

          <button
            className="qx-btn qx-btn--primary qx-btn--lg"
            onClick={() => navigate('/settings#plugins')}
            style={{ marginBottom: 12 }}
          >
            <PlusIcon />
            Activate Calendar-Q{priceDisplay ? ` — ${priceDisplay}` : ''}
          </button>
          <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
            Part of the AssistantQ family. Manage connected calendars any time in Settings, Plugins.
          </p>
        </div>
      </section>

      <style>{`
        .calq-lock-hero { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 92px; height: 92px; }
        .calq-lock-hero__glow { position: absolute; inset: -6px; border-radius: 50%; background: radial-gradient(circle, rgba(168,85,247,0.5), rgba(168,85,247,0.16) 55%, transparent 72%); filter: blur(7px); animation: calqLockPulse 3.4s ease-in-out infinite; }
        .calq-lock-hero__icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 70px; height: 70px; border-radius: 50%; color: #c9a3ff; background: rgba(168,85,247,0.12); border: 1px solid rgba(168,85,247,0.38); box-shadow: inset 0 1px 0 rgba(255,255,255,0.16); }
        @keyframes calqLockPulse { 0%, 100% { transform: scale(1); opacity: 0.82; } 50% { transform: scale(1.09); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .calq-lock-hero__glow { animation: none; } }
      `}</style>
    </div>
  )
}
