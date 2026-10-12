/**
 * TRV-6: TraceCompareView — /traces/:runId/compare/:otherRunId
 * Side-by-side trace comparison with policy delta report.
 */

import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import TraceComparison from '../../components/traces/TraceComparison'
import PolicyDeltaReport from '../../components/traces/PolicyDeltaReport'
import { GlassSkeleton, GlassError, M, F, COLORS } from '../../components/compliance/glass-primitives'

export default function TraceCompareView() {
  const { runId, otherRunId } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!runId || !otherRunId) return
    setLoading(true)
    setError(null)

    fetch('/collector/traces/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trace_a: decodeURIComponent(runId), trace_b: decodeURIComponent(otherRunId) }),
    })
      .then(r => {
        if (!r.ok) throw new Error(`Comparison failed (${r.status})`)
        return r.json()
      })
      .then(d => { setData(d); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [runId, otherRunId])

  const handleExport = async (format) => {
    if (!data) return
    const exportData = {
      format,
      generated_at: new Date().toISOString(),
      trace_a: { corr: data.trace_a.corr, run_id: data.trace_a.run_id, outcome: data.trace_a.outcome },
      trace_b: { corr: data.trace_b.corr, run_id: data.trace_b.run_id, outcome: data.trace_b.outcome },
      summary: data.summary,
      layer_diffs: data.layer_diffs,
    }

    if (format === 'json') {
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      downloadBlob(blob, `policy-delta-${data.trace_a.run_id}-vs-${data.trace_b.run_id}.json`)
    } else if (format === 'csv') {
      const lines = ['layer_id,diff_type,timing_delta_pct,outcome_a,outcome_b']
      for (const d of data.layer_diffs) {
        lines.push(`${d.layer_id},${d.diff_type},${d.timing_delta_pct?.toFixed(1) || ''},${d.decision_a?.code || ''},${d.decision_b?.code || ''}`)
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
      downloadBlob(blob, `policy-delta-${data.trace_a.run_id}-vs-${data.trace_b.run_id}.csv`)
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 1200 }}>
      {/* Breadcrumb */}
      <div style={{
        fontFamily: F, fontSize: 13, color: COLORS.dimText,
        marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Link to="/traces" style={{ color: COLORS.cyan, textDecoration: 'none' }}>Traces</Link>
        <span style={{ color: COLORS.subtleText }}>/</span>
        <span style={{ color: COLORS.white }}>Compare</span>
      </div>

      {loading && <GlassSkeleton height={400} />}
      {error && <GlassError message={error} onRetry={() => window.location.reload()} />}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Side-by-side waterfall */}
          <TraceComparison
            traceA={data.trace_a}
            traceB={data.trace_b}
            diffs={data.layer_diffs}
            summary={data.summary}
          />

          {/* Policy delta report */}
          <PolicyDeltaReport
            traceA={data.trace_a}
            traceB={data.trace_b}
            diffs={data.layer_diffs}
            onExport={handleExport}
          />
        </div>
      )}
    </div>
  )
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
