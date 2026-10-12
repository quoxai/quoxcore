/**
 * TRV-3: IntegrityBanner — VOLT/WARD integrity status at bottom of waterfall
 */

import { GlassPanel, M, F, COLORS, PROTOCOL_COLORS } from '../compliance/glass-primitives'

export default function IntegrityBanner({ trace }) {
  if (!trace) return null

  const hasVolt = !!trace.volt
  const voltVerified = trace.volt?.verified
  const hasWard = !!trace.ward?.witnessed

  let icon, message, borderColor

  if (voltVerified && hasWard) {
    icon = (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.green} strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    )
    message = `Cryptographically verified. ${trace.volt.event_count} events in VOLT hash chain. WARD witness confirmed.`
    borderColor = COLORS.green
  } else if (voltVerified) {
    icon = (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.cyan} strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    )
    message = `VOLT integrity verified (${trace.volt.event_count} events). WARD witnessing not available.`
    borderColor = COLORS.cyan
  } else if (hasVolt) {
    icon = (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.amber} strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    )
    message = `VOLT data present but not verified. ${trace.volt.event_count} events recorded.`
    borderColor = COLORS.amber
  } else {
    icon = (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    )
    message = 'No cryptographic verification available for this trace.'
    borderColor = 'rgba(255,255,255,0.1)'
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px',
      marginTop: 12,
      borderRadius: 8,
      borderLeft: `3px solid ${borderColor}`,
      background: 'rgba(255,255,255,0.015)',
    }}>
      {icon}
      <span style={{
        fontFamily: F, fontSize: 11,
        color: COLORS.dimText,
      }}>
        {message}
      </span>
    </div>
  )
}
