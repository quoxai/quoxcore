/**
 * QuoxLensLocked: the unentitled state for /quoxlens.
 *
 * QUOXLENS-GATING: an unlicensed user landing on /quoxlens must see a
 * surface that explains what QuoxLens is, not a 404 or a blank shell.
 * Mirrors QuoxSignalLocked's own layout (same qx-* classes, same
 * "steps then CTA" shape) so gated-plugin locked states stay visually
 * consistent across the dashboard.
 */
import { useNavigate } from 'react-router-dom'

function EyeIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
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
    title: 'Declare a stance',
    body: 'A Lens is a reusable, versioned evaluative stance. It judges an artifact, it does not act on it or converse.',
    icon: <EyeIcon size={18} />,
  },
  {
    title: 'Enforce the contract',
    body: 'A finding needs a cited basis or it is dropped, never invented. Every finding gets a stable fingerprint so repeat runs dedupe instead of re-reporting.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    title: 'Prove it, or say so',
    body: 'An eval harness scores every Lens against a no-Lens baseline. Anything unevaluated or losing is stamped unproven, everywhere it appears.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
]

const FEATURE_CHIPS = ['Lenses', 'Findings', 'Evidence Trail']

export default function QuoxLensLocked({ priceDisplay = 'TBD' }) {
  const navigate = useNavigate()

  return (
    <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <section
        className="qx-card"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px 24px' }}
      >
        <div style={{ width: '100%', maxWidth: 780, textAlign: 'center' }}>
          <div className="lens-lock-hero" aria-hidden="true">
            <span className="lens-lock-hero__glow" />
            <span className="lens-lock-hero__icon"><EyeIcon size={38} /></span>
          </div>

          <div className="qx-badge" style={{ marginTop: 6 }}>QuoxLens &middot; not yet activated</div>

          <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em', margin: '14px 0 10px', textWrap: 'balance' }}>
            A verdict you can replay, not just read.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)', maxWidth: 600, margin: '0 auto 18px' }}>
            QuoxLens applies a reusable, versioned Lens to an artifact and returns a typed,
            evidence-gated verdict: a finding without a cited basis is dropped, not invented.
            Every live application is recorded as an AEE envelope plus a VOLT evidence bundle,
            so a verdict is replayable evidence, not just a chat response.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
            {FEATURE_CHIPS.map((f) => (
              <span key={f} style={{
                padding: '4px 10px', borderRadius: 12, fontSize: 12,
                background: 'rgba(234,179,8,0.10)', color: 'rgba(255,255,255,0.7)',
                border: '1px solid rgba(234,179,8,0.22)'
              }}>{f}</span>
            ))}
          </div>

          <div className="qx-grid-3" style={{ textAlign: 'left', marginBottom: 26 }}>
            {STEPS.map((s) => (
              <div key={s.title} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <span
                  style={{
                    display: 'inline-flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
                    borderRadius: 9, color: '#f4d35e', background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.28)',
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
            Activate QuoxLens ({priceDisplay})
          </button>
          <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
            Pricing not yet set. Manage plugins any time in Settings, Plugins.
          </p>
        </div>
      </section>

      <style>{`
        .lens-lock-hero { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 92px; height: 92px; }
        .lens-lock-hero__glow { position: absolute; inset: -6px; border-radius: 50%; background: radial-gradient(circle, rgba(234,179,8,0.5), rgba(234,179,8,0.16) 55%, transparent 72%); filter: blur(7px); animation: lensLockPulse 3.4s ease-in-out infinite; }
        .lens-lock-hero__icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 70px; height: 70px; border-radius: 50%; color: #f4d35e; background: rgba(234,179,8,0.12); border: 1px solid rgba(234,179,8,0.38); box-shadow: inset 0 1px 0 rgba(255,255,255,0.16); }
        @keyframes lensLockPulse { 0%, 100% { transform: scale(1); opacity: 0.82; } 50% { transform: scale(1.09); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .lens-lock-hero__glow { animation: none; } }
      `}</style>
    </div>
  )
}
