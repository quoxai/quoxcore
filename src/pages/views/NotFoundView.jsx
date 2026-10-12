/**
 * NotFoundView — minimal 404 page for unregistered routes.
 *
 * CW quick-win B8: unknown routes used to fall through to the CatchAllRedirect,
 * which silently navigated to Command Center, so an undeployed or mistyped
 * route looked like a working page. This renders a small glass-styled "not
 * found" card instead, with a link back to Command Center.
 */
import { Link } from 'react-router-dom'

export default function NotFoundView() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        // Transparent so the body cinematic shows through — was '#0a0a14', a
        // full-viewport black slab that hid the cinematic and read flat.
        background: 'transparent',
      }}
    >
      <div
        style={{
          maxWidth: 420,
          width: '100%',
          textAlign: 'center',
          padding: '32px 28px',
          borderRadius: 'var(--qx-radius, 16px)',
          background: 'var(--m-bg-base, rgba(255,255,255,0.05))',
          border: '1px solid var(--m-border-default, rgba(255,255,255,0.14))',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16), inset 0 -1px 0 rgba(0,0,0,0.45)',
          backdropFilter: 'var(--qx-blur, blur(16px))',
          WebkitBackdropFilter: 'var(--qx-blur, blur(16px))',
        }}
      >
        <div
          style={{
            fontSize: 40,
            fontWeight: 800,
            color: '#38bdf8',
            marginBottom: 8,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          404
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fff', margin: '0 0 8px' }}>
          Page not found
        </h1>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', margin: '0 0 20px', lineHeight: 1.5 }}>
          This page doesn't exist or hasn't shipped yet.
        </p>
        <Link
          to="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 18px',
            fontSize: 12,
            fontWeight: 700,
            background: 'linear-gradient(135deg, rgba(168,85,247,0.18), rgba(56,189,248,0.1))',
            border: '1px solid rgba(168,85,247,0.35)',
            borderRadius: 8,
            color: '#fff',
            textDecoration: 'none',
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12l9-9 9 9M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" />
          </svg>
          Back to Command Center
        </Link>
      </div>
    </div>
  )
}
