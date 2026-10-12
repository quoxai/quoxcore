/**
 * QuoxSignalLocked — the unentitled state for /quoxsignal.
 *
 * SIGNAL-GATING: an unlicensed user landing on /quoxsignal must see a sales
 * surface, not a 404 or a blank shell. Mirrors QuoxbrainView's own locked
 * state (same qx-* classes, same "steps then CTA" shape) so paid-plugin
 * locked states stay visually consistent across the dashboard.
 */
import { useNavigate } from 'react-router-dom'

function RadioIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-8.49a6 6 0 0 0 0 8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
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
    title: 'Follow',
    body: 'Point QuoxSignal at TikTok, Instagram, YouTube, or an RSS/podcast feed. It polls and discovers new posts on its own.',
    icon: <RadioIcon size={18} />,
  },
  {
    title: 'Transcribe',
    body: 'Every new post is transcribed automatically, hosted or local, so there is a real transcript behind every claim.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
  {
    title: 'Verify',
    body: 'A finding without a verbatim transcript quote is dropped, never invented. SCOUT explains and challenges every verdict.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
]

const FEATURE_CHIPS = ['Feed', 'Sources', 'Proposals', 'SCOUT triage', 'Evidence Trail']

export default function QuoxSignalLocked({ priceDisplay = '$39' }) {
  const navigate = useNavigate()

  return (
    <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <section
        className="qx-card"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px 24px' }}
      >
        <div style={{ width: '100%', maxWidth: 780, textAlign: 'center' }}>
          <div className="signal-lock-hero" aria-hidden="true">
            <span className="signal-lock-hero__glow" />
            <span className="signal-lock-hero__icon"><RadioIcon size={38} /></span>
          </div>

          <div className="qx-badge" style={{ marginTop: 6 }}>QuoxSignal &middot; not yet activated</div>

          <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em', margin: '14px 0 10px', textWrap: 'balance' }}>
            Watch your sources. Verify before you trust it.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)', maxWidth: 600, margin: '0 auto 18px' }}>
            QuoxSignal follows creators and feeds across TikTok, Instagram, YouTube, and RSS/podcasts,
            transcribes what they post, and runs an evidence-gated lens over the transcript before a
            single claim reaches you. SCOUT, the triage specialist, explains every verdict and drafts
            approved findings straight into a QuoxPlan stream entry.
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
            Activate QuoxSignal for {priceDisplay}
          </button>
          <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
            One-time purchase, unlimited followed sources. Manage it any time in Settings, Plugins.
          </p>
        </div>
      </section>

      <style>{`
        .signal-lock-hero { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 92px; height: 92px; }
        .signal-lock-hero__glow { position: absolute; inset: -6px; border-radius: 50%; background: radial-gradient(circle, rgba(56,189,248,0.5), rgba(56,189,248,0.16) 55%, transparent 72%); filter: blur(7px); animation: signalLockPulse 3.4s ease-in-out infinite; }
        .signal-lock-hero__icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 70px; height: 70px; border-radius: 50%; color: #8fd6ff; background: rgba(56,189,248,0.12); border: 1px solid rgba(56,189,248,0.38); box-shadow: inset 0 1px 0 rgba(255,255,255,0.16); }
        @keyframes signalLockPulse { 0%, 100% { transform: scale(1); opacity: 0.82; } 50% { transform: scale(1.09); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .signal-lock-hero__glow { animation: none; } }
      `}</style>
    </div>
  )
}
