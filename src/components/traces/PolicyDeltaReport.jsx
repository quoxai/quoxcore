/**
 * TRV-6: PolicyDeltaReport — exportable report showing policy evaluation differences
 * SOC2 CC6.1 and ISO 27001 A.12.1.2 evidence.
 */

import { useState } from 'react'
import { GlassPanel, GlassPill, M, F, COLORS } from '../compliance/glass-primitives'

export default function PolicyDeltaReport({ traceA, traceB, diffs = [], onExport }) {
  const [exporting, setExporting] = useState(false)

  // Find policy-related diffs
  const policyDiffs = diffs.filter(d =>
    d.diff_type === 'decision_change' || d.decision_a || d.decision_b
  )

  const layerDiffs = diffs.filter(d => d.diff_type && d.diff_type !== 'identical')

  if (!traceA || !traceB) return null

  const handleExport = async (format) => {
    if (!onExport) return
    setExporting(true)
    try {
      await onExport(format)
    } finally {
      setExporting(false)
    }
  }

  return (
    <GlassPanel style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ fontFamily: F, fontSize: 14, fontWeight: 600, color: COLORS.white }}>
          Policy Delta Report
        </span>
        <div style={{ flex: 1 }} />
        {/* Export buttons */}
        {onExport && (
          <div style={{ display: 'flex', gap: 4 }}>
            {['json', 'csv'].map(fmt => (
              <button
                key={fmt}
                onClick={() => handleExport(fmt)}
                disabled={exporting}
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4, padding: '3px 10px',
                  fontFamily: M, fontSize: 9, color: COLORS.dimText,
                  cursor: exporting ? 'default' : 'pointer',
                  opacity: exporting ? 0.5 : 1,
                }}
              >
                {fmt.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Executive summary */}
      <Section title="Summary">
        <div style={{ fontFamily: F, fontSize: 12, color: COLORS.dimText, lineHeight: 1.5 }}>
          {layerDiffs.length === 0 ? (
            'No differences detected between these traces. All layers evaluated identically.'
          ) : (
            <>
              <strong style={{ color: COLORS.white }}>{layerDiffs.length} layer{layerDiffs.length > 1 ? 's' : ''}</strong>
              {' evaluated differently across these traces. '}
              {policyDiffs.length > 0 && (
                <><strong style={{ color: COLORS.white }}>{policyDiffs.length} policy decision{policyDiffs.length > 1 ? 's' : ''}</strong> changed.</>
              )}
            </>
          )}
        </div>
      </Section>

      {/* Per-layer breakdown */}
      {layerDiffs.length > 0 && (
        <Section title="Layer Differences">
          {layerDiffs.map((diff, i) => {
            const layerA = traceA.layers.find(l => l.layer_id === diff.layer_id)
            const layerB = traceB.layers.find(l => l.layer_id === diff.layer_id)

            return (
              <div key={i} style={{
                padding: '8px 12px', borderRadius: 6, marginBottom: 6,
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.05)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <GlassPill color={COLORS.purple} style={{ fontSize: 8 }}>{diff.layer_id}</GlassPill>
                  <span style={{ fontFamily: F, fontSize: 11, color: COLORS.white }}>
                    {layerA?.layer_label || layerB?.layer_label || diff.layer_id}
                  </span>
                  <GlassPill color={COLORS.amber} style={{ fontSize: 8 }}>
                    {diff.diff_type?.replace('_', ' ')}
                  </GlassPill>
                </div>

                {/* Trace A outcome */}
                <DiffRow
                  label="Trace A"
                  color={COLORS.cyan}
                  outcome={layerA?.outcome || diff.decision_a?.code || 'missing'}
                  reason={layerA?.decisions?.[0]?.reason || diff.decision_a?.reason || ''}
                  duration={layerA?.duration_ms}
                />

                {/* Trace B outcome */}
                <DiffRow
                  label="Trace B"
                  color={COLORS.amber}
                  outcome={layerB?.outcome || diff.decision_b?.code || 'missing'}
                  reason={layerB?.decisions?.[0]?.reason || diff.decision_b?.reason || ''}
                  duration={layerB?.duration_ms}
                />

                {/* Timing delta */}
                {diff.timing_delta_pct != null && Math.abs(diff.timing_delta_pct) > 5 && (
                  <div style={{ fontFamily: M, fontSize: 9, color: COLORS.amber, marginTop: 4 }}>
                    Timing delta: {diff.timing_delta_pct > 0 ? '+' : ''}{diff.timing_delta_pct.toFixed(0)}%
                  </div>
                )}
              </div>
            )
          })}
        </Section>
      )}

      {/* Compliance framework mapping */}
      <Section title="Compliance Framework Mapping">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {policyDiffs.length > 0 && (
            <>
              <GlassPill color={COLORS.cyan} style={{ fontSize: 9 }}>SOC2 CC6.1</GlassPill>
              <GlassPill color={COLORS.cyan} style={{ fontSize: 9 }}>ISO 27001 A.12.1.2</GlassPill>
            </>
          )}
          {layerDiffs.some(d => d.layer_id === 'L8') && (
            <GlassPill color={COLORS.cyan} style={{ fontSize: 9 }}>SOC2 CC7.2</GlassPill>
          )}
          {layerDiffs.length === 0 && (
            <span style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText }}>
              No policy differences, no compliance impact.
            </span>
          )}
        </div>
      </Section>
    </GlassPanel>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontFamily: F, fontSize: 10, fontWeight: 600,
        color: COLORS.subtleText, textTransform: 'uppercase',
        letterSpacing: '0.05em', marginBottom: 6,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function DiffRow({ label, color, outcome, reason, duration }) {
  const outcomeColor = outcome === 'allow' || outcome === 'complete' ? COLORS.green
    : outcome === 'deny' ? COLORS.red
    : outcome === 'missing' ? COLORS.subtleText
    : COLORS.dimText

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '3px 0', fontFamily: M, fontSize: 10,
    }}>
      <span style={{ color, minWidth: 50 }}>{label}</span>
      <span style={{ color: outcomeColor, fontWeight: 600, minWidth: 55 }}>
        {outcome?.toUpperCase()}
      </span>
      {reason && (
        <span style={{ color: COLORS.subtleText, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {reason}
        </span>
      )}
      {duration != null && (
        <span style={{ color: COLORS.subtleText }}>{formatDuration(duration)}</span>
      )}
    </div>
  )
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
