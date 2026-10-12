/** Shared LUCID presentation atoms. Global classes and tokens only. */

export const REFRESH_MS = 45000

export const sub = { fontSize: 12, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4, overflowWrap: 'anywhere' }

export const URGENCY_PILL = {
  now: ['NOW', 'qx-pill--critical'],
  today: ['TODAY', 'qx-pill--warn'],
  'this week': ['THIS WEEK', 'qx-pill--info'],
  whenever: ['WHENEVER', ''],
  fyi: ['FYI', ''],
}

export const STATE_GLYPH = {
  ok: { g: '✔', c: 'var(--status-green)', t: 'OK' },
  attention: { g: '⚠', c: 'var(--status-amber)', t: 'Needs attention' },
  unknown: { g: '?', c: 'rgba(255,255,255,0.7)', t: 'Not connected' },
  blind: { g: '✖', c: 'var(--status-error)', t: 'Not reporting' },
}

export function Svg({ children, size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export function Btn({ label, onClick, disabled, children, withText = true, active }) {
  return (
    <button type="button" className="glass-btn" aria-label={label} title={label}
      onClick={onClick} disabled={disabled} aria-pressed={active}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: withText ? '4px 8px' : 4, fontSize: 11 }}>
      <Svg>{children}</Svg>
      {withText ? <span>{label}</span> : null}
    </button>
  )
}

export function Note({ children }) {
  return <div style={sub}>{children}</div>
}

export function Section({ title, count, action, children }) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 className="qx-section-title" style={{ flex: 1, minWidth: 0, margin: 0 }}>
          {title}{count != null ? ` (${count})` : ''}
        </h2>
        {action}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </section>
  )
}

export function UrgencyPill({ urgency }) {
  const [txt, cls] = URGENCY_PILL[urgency] || [String(urgency || '').toUpperCase(), '']
  if (!txt) return null
  return <span className={`qx-pill qx-pill--xs ${cls}`} style={{ flex: 'none' }}>{txt}</span>
}
