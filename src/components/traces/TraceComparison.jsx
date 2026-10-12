/**
 * TRV-6: TraceComparison — side-by-side normalised waterfall with layer-aligned diffs
 *
 * Two traces stacked vertically with shared Y-axis (layers aligned).
 * Colour coding: identical=grey, timing drift=amber, decision change=blue/orange,
 * bypass=striped, missing=dashed.
 */

import { GlassPanel, GlassPill, M, F, COLORS } from '../compliance/glass-primitives'

const DIFF_COLORS = {
  identical: 'rgba(255,255,255,0.06)',
  timing_drift: `${COLORS.amber}25`,
  decision_change_a: `${COLORS.cyan}30`,
  decision_change_b: `${COLORS.amber}30`,
  missing: 'rgba(255,255,255,0.03)',
}

export default function TraceComparison({ traceA, traceB, diffs = [], summary = '', mode = 'compliance' }) {
  if (!traceA || !traceB) return null

  // Build unified layer list (all layers from both traces)
  const allLayerIds = new Set()
  for (const l of traceA.layers) allLayerIds.add(l.layer_id)
  for (const l of traceB.layers) allLayerIds.add(l.layer_id)
  const sortedLayerIds = Array.from(allLayerIds).sort((a, b) => {
    const numA = parseInt(a.replace('L', ''))
    const numB = parseInt(b.replace('L', ''))
    return numA - numB
  })

  // Index diffs by layer_id
  const diffMap = {}
  for (const d of diffs) diffMap[d.layer_id] = d

  return (
    <GlassPanel style={{ padding: 16 }}>
      {/* Diff summary banner */}
      {summary && (
        <div style={{
          padding: '8px 12px', marginBottom: 14, borderRadius: 8,
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          fontFamily: F, fontSize: 12, color: COLORS.dimText,
        }}>
          {summary}
        </div>
      )}

      {/* Header row */}
      <div style={{
        display: 'grid', gridTemplateColumns: '80px 1fr 1fr',
        gap: 8, marginBottom: 8, padding: '0 8px',
      }}>
        <div />
        <TraceLabel trace={traceA} label="Trace A" color={COLORS.cyan} />
        <TraceLabel trace={traceB} label="Trace B" color={COLORS.amber} />
      </div>

      {/* Layer rows — aligned */}
      {sortedLayerIds.map(layerId => {
        const layerA = traceA.layers.find(l => l.layer_id === layerId)
        const layerB = traceB.layers.find(l => l.layer_id === layerId)
        const diff = diffMap[layerId]
        const diffType = diff?.diff_type || (layerA && layerB ? 'identical' : 'missing')

        return (
          <ComparisonRow
            key={layerId}
            layerId={layerId}
            layerA={layerA}
            layerB={layerB}
            traceADuration={traceA.duration_ms}
            traceBDuration={traceB.duration_ms}
            diffType={diffType}
            diff={diff}
            mode={mode}
          />
        )
      })}

      {/* Diff legend */}
      <div style={{
        display: 'flex', gap: 12, marginTop: 12, padding: '8px 0',
        borderTop: '1px solid rgba(255,255,255,0.04)',
      }}>
        <Legend color="rgba(255,255,255,0.15)" label="Identical" />
        <Legend color={COLORS.amber} label="Timing drift" />
        <Legend color={COLORS.cyan} label="Decision change" />
        <Legend color="rgba(255,255,255,0.08)" label="Missing" dashed />
      </div>
    </GlassPanel>
  )
}

function TraceLabel({ trace, label, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      <span style={{ fontFamily: M, fontSize: 10, color }}>
        {label}
      </span>
      <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
        {formatDuration(trace.duration_ms)}
      </span>
      <GlassPill
        color={trace.outcome === 'complete' ? COLORS.green : COLORS.red}
        style={{ fontSize: 8 }}
      >
        {trace.outcome?.toUpperCase()}
      </GlassPill>
    </div>
  )
}

function ComparisonRow({ layerId, layerA, layerB, traceADuration, traceBDuration, diffType, diff, mode }) {
  const label = layerA?.layer_label || layerB?.layer_label || layerId
  const name = layerA?.layer_name || layerB?.layer_name || layerId

  const bgColor = diffType === 'timing_drift' ? DIFF_COLORS.timing_drift
    : diffType === 'decision_change' ? 'rgba(255,255,255,0.03)'
    : diffType === 'missing' ? DIFF_COLORS.missing
    : 'transparent'

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '80px 1fr 1fr',
      gap: 8, padding: '4px 8px', borderRadius: 4,
      background: bgColor,
      marginBottom: 2,
    }}>
      {/* Layer label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontFamily: M, fontSize: 9, color: COLORS.purple, fontWeight: 700 }}>
          {layerId}
        </span>
        <span style={{
          fontFamily: mode === 'compliance' ? F : M,
          fontSize: 10, color: COLORS.dimText,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {mode === 'compliance' ? label : name}
        </span>
      </div>

      {/* Trace A bar */}
      <LayerBar layer={layerA} traceDuration={traceADuration} color={COLORS.cyan} />

      {/* Trace B bar */}
      <LayerBar layer={layerB} traceDuration={traceBDuration} color={COLORS.amber} />
    </div>
  )
}

function LayerBar({ layer, traceDuration, color }) {
  if (!layer) {
    return (
      <div style={{
        height: 20, borderRadius: 3,
        border: '1px dashed rgba(255,255,255,0.1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>—</span>
      </div>
    )
  }

  const leftPct = traceDuration > 0 ? (layer.started_ms / traceDuration * 100) : 0
  const widthPct = traceDuration > 0 ? Math.max(layer.duration_ms / traceDuration * 100, 1) : 100

  return (
    <div style={{ position: 'relative', height: 20, borderRadius: 3, background: 'rgba(255,255,255,0.02)' }}>
      <div style={{
        position: 'absolute',
        left: `${leftPct}%`, width: `${widthPct}%`,
        top: 2, bottom: 2, borderRadius: 2,
        background: `${color}30`,
        border: `1px solid ${color}50`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {layer.decisions?.length > 0 && (
          <span style={{
            fontFamily: M, fontSize: 7, fontWeight: 700,
            color: layer.outcome === 'allow' ? COLORS.green : layer.outcome === 'deny' ? COLORS.red : color,
          }}>
            {layer.outcome === 'allow' ? 'ALLOW' : layer.outcome === 'deny' ? 'DENY' : ''}
          </span>
        )}
      </div>
      <span style={{
        position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
        fontFamily: M, fontSize: 8, color: COLORS.subtleText,
      }}>
        {formatDuration(layer.duration_ms)}
      </span>
    </div>
  )
}

function Legend({ color, label, dashed = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{
        width: 12, height: 4, borderRadius: 2,
        background: dashed ? 'transparent' : color,
        border: dashed ? `1px dashed ${color}` : 'none',
      }} />
      <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>{label}</span>
    </div>
  )
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
