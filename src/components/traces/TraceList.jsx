/**
 * TRV-4: TraceList — paginated list of trace summaries
 */

import { GlassPanel, GlassPill, GlassSkeleton, M, F, COLORS } from '../compliance/glass-primitives'

const OUTCOME_COLORS = {
  complete: COLORS.green,
  policy_deny: COLORS.red,
  hitl_pending: COLORS.amber,
  halt: COLORS.red,
  error: COLORS.red,
}

export default function TraceList({
  traces, total, offset, limit, loading,
  onSelectTrace, onPageChange,
}) {
  if (loading) return <GlassSkeleton height={300} />

  if (!traces || traces.length === 0) {
    return (
      <GlassPanel style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontFamily: F, fontSize: 13, color: COLORS.dimText }}>
          No traces match your filters.
        </div>
      </GlassPanel>
    )
  }

  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.ceil(total / limit)

  return (
    <div>
      {traces.map(t => (
        <GlassPanel
          key={t.run_id || t.corr}
          hoverable
          onClick={() => onSelectTrace(t.corr || t.run_id)}
          style={{ marginBottom: 6, padding: '10px 14px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Outcome chip */}
            <GlassPill
              color={OUTCOME_COLORS[t.outcome] || COLORS.cyan}
              style={{ fontSize: 8, minWidth: 55, justifyContent: 'center' }}
            >
              {t.outcome?.toUpperCase()}
            </GlassPill>

            {/* Timestamp */}
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, minWidth: 65 }}>
              {formatTimestamp(t.started_at)}
            </span>

            {/* Query preview */}
            <span style={{
              fontFamily: F, fontSize: 12, color: COLORS.white,
              flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {t.query_preview || '(no query)'}
            </span>

            {/* Layer count */}
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
              {t.layer_count}L
            </span>

            {/* Duration */}
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.cyan, minWidth: 50, textAlign: 'right' }}>
              {formatDuration(t.duration_ms)}
            </span>

            {/* Actor */}
            <span style={{
              fontFamily: M, fontSize: 10, color: COLORS.dimText,
              minWidth: 50, textAlign: 'right',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {t.actor?.display_name || '—'}
            </span>

            {/* VOLT indicator */}
            {t.volt_verified && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={COLORS.green} strokeWidth="2.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            )}
          </div>
        </GlassPanel>
      ))}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 12, marginTop: 16,
        }}>
          <button
            onClick={() => onPageChange(Math.max(0, offset - limit))}
            disabled={offset === 0}
            style={pageBtnStyle(offset === 0)}
          >
            Prev
          </button>
          <span style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>
            {page} / {totalPages}
          </span>
          <button
            onClick={() => onPageChange(offset + limit)}
            disabled={offset + limit >= total}
            style={pageBtnStyle(offset + limit >= total)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

function pageBtnStyle(disabled) {
  return {
    background: disabled ? 'transparent' : 'rgba(255,255,255,0.04)',
    border: `1px solid ${disabled ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 6, padding: '5px 14px',
    fontFamily: M, fontSize: 10,
    color: disabled ? COLORS.subtleText : COLORS.white,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  }
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatTimestamp(ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    const now = new Date()
    const diffMs = now - d
    if (diffMs < 60000) return 'just now'
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  } catch {
    return ts.slice(0, 10)
  }
}
