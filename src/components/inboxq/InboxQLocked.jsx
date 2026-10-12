/**
 * InboxQLocked — the unentitled state for /inboxq.
 *
 * Mirrors QuoxSignalLocked.jsx (same qx-* classes, same "steps then CTA"
 * shape) so paid-plugin locked states stay visually consistent across the
 * dashboard. See src/components/quoxsignal/QuoxSignalLocked.jsx.
 */
import { useNavigate } from 'react-router-dom'
import MANIFEST from '../../config/plugins/inboxq.json'  // price from the manifest, never a hard-coded string (drifted to 'bundle'/'Included' while the store charged)

function MailIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 6l10 7 10-7" />
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
    body: 'Point InboxQ at a mailbox already resolvable as a vaulted credential. It polls over IMAP, read-only.',
    icon: <MailIcon size={18} />,
  },
  {
    title: 'Triage',
    body: 'Every new message is sorted into Focus, FYI, Auto, or Screened, with the reason it landed there.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h16M7 12h10M10 18h4" />
      </svg>
    ),
  },
  {
    title: 'Decide',
    body: 'Filing and blocking are proposals a human approves. Nothing moves or sends on its own in v1.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
]

const FEATURE_CHIPS = ['Zones', 'Daily report', 'Proposals', 'Evidence Trail']

export default function InboxQLocked({ priceDisplay = MANIFEST.priceDisplay }) {
  const navigate = useNavigate()

  return (
    <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <section
        className="qx-card"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px 24px' }}
      >
        <div style={{ width: '100%', maxWidth: 780, textAlign: 'center' }}>
          <div className="inboxq-lock-hero" aria-hidden="true">
            <span className="inboxq-lock-hero__glow" />
            <span className="inboxq-lock-hero__icon"><MailIcon size={38} /></span>
          </div>

          <div className="qx-badge" style={{ marginTop: 6 }}>InboxQ &middot; not yet activated</div>

          <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em', margin: '14px 0 10px', textWrap: 'balance' }}>
            Read-first inbox triage. Nothing moves without you.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)', maxWidth: 600, margin: '0 auto 18px' }}>
            InboxQ polls a connected mailbox over IMAP, sorts new mail into Focus, FYI, Auto, and
            Screened, and writes a daily report you can actually read. Filing and blocking a
            sender are proposals recorded for your decision, never executed on their own.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
            {FEATURE_CHIPS.map((f) => (
              <span key={f} style={{
                padding: '4px 10px', borderRadius: 12, fontSize: 12,
                background: 'rgba(56,189,248,0.10)', color: 'rgba(255,255,255,0.7)',
                border: '1px solid rgba(56,189,248,0.22)'
              }}>{f}</span>
            ))}
          </div>

          <div className="qx-grid-3" style={{ textAlign: 'left', marginBottom: 26 }}>
            {STEPS.map((s) => (
              <div key={s.title} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <span
                  style={{
                    display: 'inline-flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
                    borderRadius: 9, color: '#8fd6ff', background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.28)',
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
            Activate InboxQ {priceDisplay !== 'Included' ? `for ${priceDisplay}` : ''}
          </button>
          <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
            One mailbox to start. Manage connected accounts any time in Settings, Plugins.
          </p>
        </div>
      </section>

      <style>{`
        .inboxq-lock-hero { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 92px; height: 92px; }
        .inboxq-lock-hero__glow { position: absolute; inset: -6px; border-radius: 50%; background: radial-gradient(circle, rgba(56,189,248,0.5), rgba(56,189,248,0.16) 55%, transparent 72%); filter: blur(7px); animation: inboxqLockPulse 3.4s ease-in-out infinite; }
        .inboxq-lock-hero__icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 70px; height: 70px; border-radius: 50%; color: #8fd6ff; background: rgba(56,189,248,0.12); border: 1px solid rgba(56,189,248,0.38); box-shadow: inset 0 1px 0 rgba(255,255,255,0.16); }
        @keyframes inboxqLockPulse { 0%, 100% { transform: scale(1); opacity: 0.82; } 50% { transform: scale(1.09); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .inboxq-lock-hero__glow { animation: none; } }
      `}</style>
    </div>
  )
}
