/**
 * QuoxSEOLocked — the unentitled state for /quoxseo.
 *
 * Mirrors QuoxSignalLocked.jsx (same qx-* classes, same "steps then CTA"
 * shape) so paid-plugin locked states stay visually consistent across the
 * dashboard. Accent is QuoxSEO's own (#34d399) rather than QuoxSignal's cyan.
 */
import { useNavigate } from 'react-router-dom'

function CompassIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
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
    title: 'Crawl',
    body: 'QuoxSEO crawls this site on a schedule, reading every page: status, title, canonical, meta, structured data, and the full link graph.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
      </svg>
    ),
  },
  {
    title: 'Correlate',
    body: 'Google Search Console impressions, clicks and position land on every URL row, next to inlinks, orphan status and sitemap membership.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 3v18h18" /><path d="M7 15l4-6 3 3 5-8" />
      </svg>
    ),
  },
  {
    title: 'Witness',
    body: 'Every crawl is hashed and signed into the WARD chain. A change log and a verify button prove the history rather than assert it.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-4z" /><path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
]

const FEATURE_CHIPS = ['Overview', 'URL Warehouse', 'Change log', 'Evidence']

export default function QuoxSEOLocked({ priceDisplay = '$39' }) {
  const navigate = useNavigate()

  return (
    <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <section
        className="qx-card"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px 24px' }}
      >
        <div style={{ width: '100%', maxWidth: 780, textAlign: 'center' }}>
          <div className="seo-lock-hero" aria-hidden="true">
            <span className="seo-lock-hero__glow" />
            <span className="seo-lock-hero__icon"><CompassIcon size={38} /></span>
          </div>

          <div className="qx-badge" style={{ marginTop: 6 }}>QuoxSEO &middot; not yet activated</div>

          <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em', margin: '14px 0 10px', textWrap: 'balance' }}>
            SEO intelligence with a witnessed history no other tool can offer.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)', maxWidth: 600, margin: '0 auto 18px' }}>
            QuoxSEO crawls this site, joins the result to real Search Console data, and keeps
            every crawl as a hashed, Ed25519-signed row in the WARD chain. Nothing here is a
            snapshot you have to trust: the Evidence tab recomputes the chain on demand and
            shows you the check marks, not just the claim.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
            {FEATURE_CHIPS.map((f) => (
              <span key={f} style={{
                padding: '4px 10px', borderRadius: 12, fontSize: 12,
                background: 'rgba(52,211,153,0.10)', color: 'rgba(255,255,255,0.7)',
                border: '1px solid rgba(52,211,153,0.22)'
              }}>{f}</span>
            ))}
          </div>

          <div className="qx-grid-3" style={{ textAlign: 'left', marginBottom: 26 }}>
            {STEPS.map((s) => (
              <div key={s.title} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <span
                  style={{
                    display: 'inline-flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
                    borderRadius: 9, color: '#34d399', background: 'rgba(52,211,153,0.10)', border: '1px solid rgba(52,211,153,0.28)',
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
            Activate QuoxSEO for {priceDisplay}
          </button>
          <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
            One-time purchase, unlimited crawled URLs. Manage it any time in Settings, Plugins.
          </p>
        </div>
      </section>

      <style>{`
        .seo-lock-hero { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 92px; height: 92px; }
        .seo-lock-hero__glow { position: absolute; inset: -6px; border-radius: 50%; background: radial-gradient(circle, rgba(52,211,153,0.5), rgba(52,211,153,0.16) 55%, transparent 72%); filter: blur(7px); animation: seoLockPulse 3.4s ease-in-out infinite; }
        .seo-lock-hero__icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 70px; height: 70px; border-radius: 50%; color: #34d399; background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.38); box-shadow: inset 0 1px 0 rgba(255,255,255,0.16); }
        @keyframes seoLockPulse { 0%, 100% { transform: scale(1); opacity: 0.82; } 50% { transform: scale(1.09); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .seo-lock-hero__glow { animation: none; } }
      `}</style>
    </div>
  )
}
