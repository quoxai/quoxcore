/**
 * ReceiptChip: one action's proof in a compact pill.
 * Dot, protocol glyph, short envelope id, chain seq, verify state.
 * Styling lives in qx-components.css (.qx-receipt). Clicking opens the
 * (future) Receipt Inspector, so the parent supplies onClick.
 */
const STATES = {
  intact:  { hue: 'cyan',  dot: 'online',  label: 'intact' },
  pending: { hue: 'amber', dot: 'loading', label: 'pending' },
  broken:  { hue: 'red',   dot: 'offline', label: 'chain broken' },
}

/** First 6 and last 4 characters, middle elided. Short ids pass through. */
export function truncateEnvelopeId(id) {
  const s = String(id ?? '')
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}

function VerifyIcon({ state }) {
  const common = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (state === 'broken') return <svg {...common}><path d="M4 4l8 8M12 4l-8 8" /></svg>
  if (state === 'pending') return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>
  return <svg {...common}><path d="M3 8.5l3.2 3L13 4.5" /></svg>
}

export default function ReceiptChip({ protocol = 'ward', seq, envelopeId, state = 'intact', ts, onClick, className = '' }) {
  const st = STATES[state] || STATES.intact
  const proto = String(protocol || 'ward').toLowerCase()
  const tip = [envelopeId, ts].filter(Boolean).join(' · ')
  const hasSeq = seq !== undefined && seq !== null && seq !== ''
  const cls = `qx-receipt qx-chip qx-chip--xs qx-chip--hue-${st.hue} ${className}`.trim()

  return (
    <button type="button" className={cls} onClick={onClick} title={tip || undefined} data-state={state}>
      <span className={`qx-dot qx-dot--sm qx-dot--static qx-dot--${st.dot}`} aria-hidden="true" />
      <span className="qx-receipt__proto">{proto.toUpperCase()}</span>
      {hasSeq && <code className="qx-code">#{seq}</code>}
      {envelopeId && <span className="qx-receipt__id">{truncateEnvelopeId(envelopeId)}</span>}
      <span className="qx-receipt__state"><VerifyIcon state={state} />{st.label}</span>
    </button>
  )
}
