/**
 * ComplianceMonitorPanel — Real-time compliance posture dashboard
 *
 * Three layers:
 *  1. KPI bar (overall score, open gaps, drift alerts, evidence count)
 *  2. Framework cards (per-framework coverage)
 *  3. Gap heatmap (domains × frameworks)
 */

import { useState, useEffect } from 'react'
import {
  GlassPanel,
  GlassPill,
  SectionHeader,
  ProgressRing,
  COLORS,
  M,
  F,
} from './glass-primitives'

const FRAMEWORK_LABELS = {
  soc2: 'SOC 2',
  gdpr: 'GDPR',
  hipaa: 'HIPAA',
  iso27001: 'ISO 27001',
  euAiAct: 'EU AI Act',
  iso42001: 'ISO 42001',
  nistAiRmf: 'NIST AI RMF',
}

const CELL_COLORS = {
  green: 'rgba(48,255,144,0.25)',
  amber: 'rgba(245,158,11,0.3)',
  red: 'rgba(239,68,68,0.3)',
  not_applicable: 'rgba(255,255,255,0.04)',
}

// Number of controls that have actually been assessed (evidence exists, good or bad).
// A control with zero recorded evidence is "not assessed" — it must never render as a
// 0%/red failure; that treatment is reserved for controls where evidence EXISTS but is
// deficient (gap / non-compliant).
function assessed(p) {
  return (p?.compliant || 0) + (p?.partial || 0) + (p?.gap || 0)
}

function KpiCard({ label, value, color, sub }) {
  return (
    <GlassPanel style={{ padding: 14, textAlign: 'center' }}>
      <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: M, fontSize: 24, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, marginTop: 4 }}>{sub}</div>}
    </GlassPanel>
  )
}

export default function ComplianceMonitorPanel() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/collector/api/v1/compliance/monitor/posture', { credentials: 'include' })
        if (!res.ok) throw new Error(`Posture fetch failed: ${res.status}`)
        const json = await res.json()
        if (!cancelled) { setData(json); setError(null) }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return <GlassPanel style={{ textAlign: 'center', padding: 40 }}>
      <div style={{ fontFamily: M, fontSize: 11, color: COLORS.subtleText }}>Loading posture…</div>
    </GlassPanel>
  }

  if (error) {
    return <GlassPanel highlight={COLORS.red} style={{ padding: 20 }}>
      <div style={{ fontFamily: M, fontSize: 11, color: COLORS.red }}>Monitor error: {error}</div>
    </GlassPanel>
  }

  const posture = data?.posture || {}
  const driftCount = data?.drift_count || 0
  const evidenceCount = data?.evidence_count || 0
  const frameworks = data?.frameworks || []
  const heatmap = data?.gap_heatmap || []
  const alerts = data?.drift_alerts || []

  const overallAssessed = assessed(posture)
  const scoreColor = overallAssessed === 0 ? COLORS.subtleText : (posture.score >= 80 ? COLORS.green : posture.score >= 60 ? COLORS.amber : COLORS.red)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <GlassPanel>
        <SectionHeader
          title="Compliance Monitor"
          subtitle={`Real-time posture across 7 frameworks · Computed ${data?.computed_at ? new Date(data.computed_at).toLocaleString() : 'now'}`}
        />
      </GlassPanel>

      {/* KPI bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <KpiCard
          label="OVERALL SCORE"
          value={overallAssessed === 0 ? '—' : `${posture.score || 0}%`}
          color={scoreColor}
          sub={overallAssessed === 0 ? 'No activity yet' : `${posture.compliant || 0}/${posture.total || 0} compliant`}
        />
        <KpiCard
          label="OPEN GAPS"
          value={overallAssessed === 0 ? '—' : (posture.gap || 0)}
          color={overallAssessed === 0 ? COLORS.subtleText : (posture.gap > 0 ? COLORS.red : COLORS.green)}
          sub={overallAssessed === 0 ? 'No activity yet' : `${posture.partial || 0} partial`}
        />
        <KpiCard label="DRIFT ALERTS" value={driftCount} color={driftCount > 0 ? COLORS.amber : COLORS.green} sub={`${data?.threshold_days || 90}-day threshold`} />
        <KpiCard label="EVIDENCE EVENTS" value={evidenceCount.toLocaleString()} color={COLORS.cyan} sub="period-scoped" />
      </div>

      {/* Framework cards */}
      <GlassPanel>
        <SectionHeader title="Framework Coverage" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {frameworks.map(fw => {
            const p = fw.posture || {}
            const fwAssessed = assessed(p)
            const color = p.score >= 80 ? COLORS.green : p.score >= 60 ? COLORS.amber : COLORS.red
            return (
              <GlassPanel key={fw.framework} style={{ padding: 12, textAlign: 'center' }}>
                <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 0.5, marginBottom: 6 }}>
                  {FRAMEWORK_LABELS[fw.framework] || fw.framework}
                </div>
                {fwAssessed === 0 ? (
                  <div style={{
                    width: 48, height: 48, margin: '0 auto', borderRadius: '50%',
                    border: `2px dashed ${COLORS.subtleText}`, display: 'flex', alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <span style={{ fontFamily: M, fontSize: 14, fontWeight: 800, color: COLORS.subtleText }}>—</span>
                  </div>
                ) : (
                  <ProgressRing value={p.score || 0} size={48} color={color} />
                )}
                <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 6 }}>
                  {fwAssessed === 0 ? 'No activity yet' : `${p.compliant || 0}/${p.total || 0}`}
                </div>
              </GlassPanel>
            )
          })}
        </div>
      </GlassPanel>

      {/* Gap heatmap */}
      <GlassPanel>
        <SectionHeader title="Cross-Framework Gap Heatmap" subtitle="Rows = control domains · Columns = frameworks · Click a cell to drill down (future)" />
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 3, width: '100%', fontFamily: M, fontSize: 9 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6, color: COLORS.subtleText, fontWeight: 600 }}>DOMAIN</th>
                {Object.keys(FRAMEWORK_LABELS).map(fw => (
                  <th key={fw} style={{ padding: 6, color: COLORS.subtleText, fontWeight: 600, minWidth: 80 }}>{FRAMEWORK_LABELS[fw]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {heatmap.map(row => (
                <tr key={row.domain}>
                  <td style={{ padding: 6, color: '#fff', fontFamily: F, fontSize: 10 }}>{row.label}</td>
                  {Object.keys(FRAMEWORK_LABELS).map(fw => {
                    const cell = row.cells[fw]
                    if (!cell) return <td key={fw} style={{ padding: 6, textAlign: 'center', color: COLORS.subtleText, background: CELL_COLORS.not_applicable, borderRadius: 4 }}>—</td>
                    const bg = CELL_COLORS[cell.status] || CELL_COLORS.not_applicable
                    const textColor = cell.status === 'green' ? COLORS.green : cell.status === 'amber' ? COLORS.amber : cell.status === 'red' ? COLORS.red : COLORS.subtleText
                    return (
                      <td key={fw} style={{ padding: 6, textAlign: 'center', background: bg, borderRadius: 4, color: textColor, fontWeight: 700 }}>
                        {cell.score !== null ? `${cell.score}%` : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassPanel>

      {/* Drift alerts */}
      {alerts.length > 0 && (
        <GlassPanel highlight={COLORS.amber}>
          <SectionHeader title="Drift Alerts" subtitle={`${driftCount} controls exceed evidence-age threshold`} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {alerts.slice(0, 10).map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 6, background: 'rgba(245,158,11,0.04)' }}>
                <GlassPill color={a.type === 'no_evidence' ? COLORS.red : COLORS.amber} style={{ fontSize: 8 }}>
                  {a.type.toUpperCase().replace('_', ' ')}
                </GlassPill>
                <span style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>{a.controlId}</span>
                <span style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, flex: 1 }}>{a.message}</span>
              </div>
            ))}
          </div>
        </GlassPanel>
      )}
    </div>
  )
}
