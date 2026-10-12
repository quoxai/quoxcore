/**
 * TRV-3/7: TraceDetailView — /traces/:runId page
 * Fetches a trace from the assembly API and renders the waterfall.
 * Includes action bar with Replay, Compare links.
 */

import { useState, useEffect } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { TraceWaterfall } from '../../components/traces'
import TraceExportMenu from '../../components/traces/TraceExportMenu'
import { GlassSkeleton, GlassError, GlassPill, M, F, COLORS } from '../../components/compliance/glass-primitives'

export default function TraceDetailView() {
  const { runId } = useParams()
  const [searchParams] = useSearchParams()
  const initialLayer = searchParams.get('layer')

  const [trace, setTrace] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedLayer, setSelectedLayer] = useState(initialLayer)

  useEffect(() => {
    if (!runId) return
    setLoading(true)
    setError(null)

    fetch(`/collector/traces/${encodeURIComponent(runId)}?include_raw=true`)
      .then(r => {
        if (!r.ok) throw new Error(`Trace not found (${r.status})`)
        return r.json()
      })
      .then(data => {
        setTrace(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [runId])

  return (
    <div style={{ padding: 20, maxWidth: 1200 }}>
      {/* Breadcrumb */}
      <div style={{
        fontFamily: F, fontSize: 13, color: COLORS.dimText,
        marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Link to="/traces" style={{ color: COLORS.cyan, textDecoration: 'none' }}>Traces</Link>
        <span style={{ color: COLORS.subtleText }}>/</span>
        <span style={{ fontFamily: M, fontSize: 12, color: COLORS.white }}>
          {runId?.slice(0, 30)}
        </span>
      </div>

      {/* Action bar */}
      {trace && (
        <div style={{
          display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center',
        }}>
          <Link
            to={`/traces/${encodeURIComponent(runId)}/replay`}
            style={{
              background: 'rgba(168,85,247,0.1)',
              border: '1px solid rgba(168,85,247,0.3)',
              borderRadius: 6, padding: '6px 14px', textDecoration: 'none',
              fontFamily: M, fontSize: 11, color: COLORS.purple,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20" /></svg>
            Replay
          </Link>

          <Link
            to={`/activity`}
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6, padding: '6px 14px', textDecoration: 'none',
              fontFamily: M, fontSize: 11, color: COLORS.dimText,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            Activity
          </Link>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Export */}
          <TraceExportMenu trace={trace} />

          {trace.compliance_tags?.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
              {trace.compliance_tags.map(tag => (
                <GlassPill key={tag} color={COLORS.cyan} style={{ fontSize: 8 }}>{tag}</GlassPill>
              ))}
            </div>
          )}
        </div>
      )}

      {loading && <GlassSkeleton height={400} />}
      {error && <GlassError message={error} onRetry={() => window.location.reload()} />}
      {trace && (
        <TraceWaterfall
          trace={trace}
          selectedLayerId={selectedLayer}
          onSelectLayer={setSelectedLayer}
        />
      )}
    </div>
  )
}
