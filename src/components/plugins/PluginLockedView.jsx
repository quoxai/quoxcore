/**
 * PluginLockedView — the generic unentitled state for a premium route
 * (LICENSE-LAUNCH LL-7).
 *
 * Generalises the per-plugin locked views (QuoxSignalLocked, QuoxLensLocked,
 * DiscordProLocked) into one metadata-driven surface, so stripping a view out
 * of the free build does not mean hand-writing another bespoke lock screen for
 * every plugin. Everything it renders comes from a row in
 * src/config/premiumRouteStubs.js.
 *
 * Deliberately built from the existing page vocabulary — qx-view, qx-card,
 * qx-badge, qx-grid-3, qx-btn — with inline SVG icons on the button, per the
 * repo UI rules. No bespoke stylesheet.
 */

import { useNavigate } from 'react-router-dom'

// ── Icons ─────────────────────────────────────────────────────────────────

function LockIcon({ size = 34 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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

const POINT_ICONS = {
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    check: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
    activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
    server: <><rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /><path d="M6 7h.01M6 17h.01" /></>,
}

function PointIcon({ name, size = 18 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {POINT_ICONS[name] || POINT_ICONS.shield}
        </svg>
    )
}

// ── Locked view ───────────────────────────────────────────────────────────

/**
 * @param {{
 *   name: string, tagline?: string, blurb?: string, chips?: string[],
 *   points?: Array<{title: string, body: string, icon?: string}>,
 *   priceDisplay?: string, accentColor?: string,
 * }} props — a row from PREMIUM_ROUTE_STUBS
 */
export default function PluginLockedView({
    name,
    tagline,
    blurb,
    chips = [],
    points = [],
    priceDisplay,
    accentColor = '#38bdf8',
}) {
    const navigate = useNavigate()
    const tint = (alpha) => {
        const hex = accentColor.replace('#', '')
        const int = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16)
        return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
    }

    return (
        <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
            <section
                className="qx-card"
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px 24px' }}
            >
                <div style={{ width: '100%', maxWidth: 780, textAlign: 'center' }}>
                    <span
                        aria-hidden="true"
                        style={{
                            display: 'inline-flex', width: 70, height: 70, alignItems: 'center', justifyContent: 'center',
                            borderRadius: '50%', color: accentColor, background: tint(0.12),
                            border: `1px solid ${tint(0.38)}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16)',
                        }}
                    >
                        <LockIcon size={34} />
                    </span>

                    <div className="qx-badge" style={{ marginTop: 12 }}>{name} &middot; not yet activated</div>

                    {tagline && (
                        <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em', margin: '14px 0 10px', textWrap: 'balance' }}>
                            {tagline}
                        </h1>
                    )}

                    {blurb && (
                        <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)', maxWidth: 620, margin: '0 auto 18px' }}>
                            {blurb}
                        </p>
                    )}

                    {chips.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
                            {chips.map((chip) => (
                                <span key={chip} style={{
                                    padding: '4px 10px', borderRadius: 12, fontSize: 12,
                                    background: tint(0.10), color: 'rgba(255,255,255,0.7)',
                                    border: `1px solid ${tint(0.22)}`,
                                }}>{chip}</span>
                            ))}
                        </div>
                    )}

                    {points.length > 0 && (
                        <div className="qx-grid-3" style={{ textAlign: 'left', marginBottom: 26 }}>
                            {points.map((point) => (
                                <div key={point.title} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                                    <span style={{
                                        display: 'inline-flex', width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
                                        borderRadius: 9, color: accentColor, background: tint(0.10), border: `1px solid ${tint(0.28)}`,
                                    }}>
                                        <PointIcon name={point.icon} />
                                    </span>
                                    <strong style={{ fontSize: 14 }}>{point.title}</strong>
                                    <span style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(255,255,255,0.6)' }}>{point.body}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    <button
                        className="qx-btn qx-btn--primary qx-btn--lg"
                        onClick={() => navigate('/settings#plugins')}
                        style={{ marginBottom: 12 }}
                    >
                        <PlusIcon />
                        {priceDisplay ? `Activate ${name} (${priceDisplay})` : `Activate ${name}`}
                    </button>
                    <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
                        Manage plugins any time in Settings, Plugins.
                    </p>
                    <a
                        href="https://quox.ai/docs/concepts/plugin-licensing"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.55)', textDecoration: 'underline', marginTop: 10, display: 'inline-block' }}
                    >
                        How licensing works
                    </a>
                </div>
            </section>
        </div>
    )
}

// ── Boot-time guard ───────────────────────────────────────────────────────

/**
 * PremiumRouteStub — what a stubbed premium path actually mounts.
 *
 * LL-7 review note 4: a premium deep link during boot must show the locked
 * view OR a loading state, never the 404 catch-all and never a FLASH of locked
 * before the real view hydrates. Third-party routes register asynchronously
 * after React's first render, so until hydration settles we genuinely do not
 * know whether this org holds the entitlement — and rendering an upsell to
 * someone who paid is a worse lie than a spinner. Hold the loading state until
 * `pluginsHydrated`; App.jsx then drops this stub entirely the moment the real
 * route claims the path.
 *
 * @param {{stub: object, pluginsHydrated: boolean}} props
 */
export function PremiumRouteStub({ stub, pluginsHydrated }) {
    if (!pluginsHydrated) {
        return (
            <div
                role="status"
                aria-live="polite"
                className="qx-view"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: 'rgba(255,255,255,0.55)' }}
            >
                Loading {stub?.name || 'plugin'}…
            </div>
        )
    }
    return <PluginLockedView {...stub} />
}
