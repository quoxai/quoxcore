/**
 * DiscordProLocked: the unentitled state for /discord-pro.
 *
 * DISCORD-PRO-GATING: an unlicensed user landing on /discord-pro must see a
 * sales surface, not a 404 or a blank shell. Mirrors QuoxSignalLocked's own
 * locked state (same qx-* classes, same "steps then CTA" shape) so
 * paid-plugin locked states stay visually consistent across the dashboard.
 */
import { useNavigate } from 'react-router-dom'

function DiscordIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <path d="M7.5 7.2C9 6.4 10.5 6 12 6s3 0.4 4.5 1.2M6 9c-1 3-1 6 0 9 1.7 1.2 3.6 1.9 6 1.9s4.3-0.7 6-1.9c1-3 1-6 0-9-1.5-1-3.2-1.6-5-1.8" />
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
    title: 'Run',
    body: 'A dedicated daemon runs your Discord server: build and GitHub feeds land in the channels you choose, the moment they happen.',
    icon: <DiscordIcon size={18} />,
  },
  {
    title: 'Moderate',
    body: 'AutoMod baseline handles the routine moderation load automatically, so the community server does not need a human on shift for it.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2 4 6v6c0 5 3.5 8.7 8 10 4.5-1.3 8-5 8-10V6z" />
      </svg>
    ),
  },
  {
    title: 'Answer',
    body: 'Support answers are grounded in the same corpus Quox uses everywhere else. A reply beyond that is governed and approval-gated, never sent unsupervised.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
]

const FEATURE_CHIPS = ['Status', 'Channel Bindings', 'Support Gaps']

export default function DiscordProLocked({ priceDisplay = '$49' }) {
  const navigate = useNavigate()

  return (
    <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <section
        className="qx-card"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px 24px' }}
      >
        <div style={{ width: '100%', maxWidth: 780, textAlign: 'center' }}>
          <div className="discord-pro-lock-hero" aria-hidden="true">
            <span className="discord-pro-lock-hero__glow" />
            <span className="discord-pro-lock-hero__icon"><DiscordIcon size={38} /></span>
          </div>

          <div className="qx-badge" style={{ marginTop: 6 }}>Quox Discord Pro &middot; not yet activated</div>

          <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em', margin: '14px 0 10px', textWrap: 'balance' }}>
            The community server, run by the product.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)', maxWidth: 600, margin: '0 auto 18px' }}>
            Quox Discord Pro runs your Discord server as a dedicated daemon: build and GitHub feeds
            posted into channels, an AutoMod baseline covering routine moderation, and support answers
            grounded in the same corpus Quox uses everywhere else. Replies beyond a grounded answer are
            governed and approval-gated, human decided every time.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
            {FEATURE_CHIPS.map((f) => (
              <span key={f} style={{
                padding: '4px 10px', borderRadius: 12, fontSize: 12,
                background: 'rgba(88,101,242,0.10)', color: 'rgba(255,255,255,0.7)',
                border: '1px solid rgba(88,101,242,0.22)'
              }}>{f}</span>
            ))}
          </div>

          <div className="qx-grid-3" style={{ textAlign: 'left', marginBottom: 26 }}>
            {STEPS.map((s) => (
              <div key={s.title} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <span
                  style={{
                    display: 'inline-flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
                    borderRadius: 9, color: '#a3b3ff', background: 'rgba(88,101,242,0.10)', border: '1px solid rgba(88,101,242,0.28)',
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
            Activate Discord Pro for {priceDisplay}
          </button>
          <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
            One-time purchase. Manage it any time in Settings, Plugins.
          </p>
        </div>
      </section>

      <style>{`
        .discord-pro-lock-hero { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 92px; height: 92px; }
        .discord-pro-lock-hero__glow { position: absolute; inset: -6px; border-radius: 50%; background: radial-gradient(circle, rgba(88,101,242,0.5), rgba(88,101,242,0.16) 55%, transparent 72%); filter: blur(7px); animation: discordProLockPulse 3.4s ease-in-out infinite; }
        .discord-pro-lock-hero__icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 70px; height: 70px; border-radius: 50%; color: #a3b3ff; background: rgba(88,101,242,0.12); border: 1px solid rgba(88,101,242,0.38); box-shadow: inset 0 1px 0 rgba(255,255,255,0.16); }
        @keyframes discordProLockPulse { 0%, 100% { transform: scale(1); opacity: 0.82; } 50% { transform: scale(1.09); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .discord-pro-lock-hero__glow { animation: none; } }
      `}</style>
    </div>
  )
}
