/**
 * TRV-3/UX: TraceHeader — outcome chip, metadata, narrative summary
 */

import { GlassPill, M, F, COLORS, PROTOCOL_COLORS } from '../compliance/glass-primitives'

const OUTCOME_CONFIG = {
  complete:     { label: 'COMPLETE',     color: COLORS.green },
  policy_deny:  { label: 'DENIED',       color: COLORS.red },
  hitl_pending: { label: 'HITL PENDING', color: COLORS.amber },
  halt:         { label: 'HALTED',       color: COLORS.red },
  error:        { label: 'ERROR',        color: COLORS.red },
}

export default function TraceHeader({ trace, mode, onModeToggle }) {
  if (!trace) return null

  const outcome = OUTCOME_CONFIG[trace.outcome] || OUTCOME_CONFIG.complete

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Top row: outcome + metadata */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '0 0 8px',
      }}>
        {/* Outcome chip */}
        <GlassPill color={outcome.color} style={{ fontSize: 10, padding: '3px 12px' }}>
          {outcome.label}
        </GlassPill>

        {/* Run ID */}
        <span style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>
          {trace.run_id?.slice(0, 25) || trace.corr?.slice(0, 25)}
        </span>

        {/* Actor */}
        <span style={{ fontFamily: F, fontSize: 12, color: COLORS.white }}>
          {trace.actor?.display_name || trace.actor?.id || 'unknown'}
        </span>

        {/* Duration */}
        <span style={{ fontFamily: M, fontSize: 11, color: COLORS.cyan }}>
          {formatDuration(trace.duration_ms)}
        </span>

        {/* Counts */}
        <span style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
          {trace.layer_count} layers
        </span>
        {trace.decision_count > 0 && (
          <span style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
            {trace.decision_count} decisions
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Mode toggle */}
        {onModeToggle && (
          <button
            onClick={onModeToggle}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6, padding: '4px 10px',
              fontFamily: M, fontSize: 10, color: COLORS.dimText,
              cursor: 'pointer',
            }}
          >
            {mode === 'compliance' ? '{ } Engineer' : 'Compliance'}
          </button>
        )}
      </div>

      {/* Narrative summary — the human-readable story */}
      {trace.narrative && (
        <div style={{
          padding: '8px 12px',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.015)',
          border: '1px solid rgba(255,255,255,0.04)',
          fontFamily: F, fontSize: 12, lineHeight: 1.5,
          color: COLORS.dimText,
        }}>
          {trace.narrative}
        </div>
      )}

      {/* Query preview */}
      {trace.query && (
        <div style={{
          marginTop: 8,
          fontFamily: F, fontSize: 12, color: COLORS.white,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          padding: '0 2px',
        }}>
          <span style={{ color: COLORS.subtleText, fontFamily: M, fontSize: 10 }}>Query: </span>
          {trace.query.slice(0, 200)}
        </div>
      )}
    </div>
  )
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
