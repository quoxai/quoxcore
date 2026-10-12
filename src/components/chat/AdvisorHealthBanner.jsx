/**
 * QMH-5/3 — inline advisor warning banner for the chat workspace.
 *
 * Reads /api/engine/predict/stats (QMH-2 wire — backed by execution_wisdom)
 * once per mount and surfaces a warning when QuoxPredict is signalling
 * low confidence: average wisdom confidence under 50% AND multiple
 * post-mortems in the last 24 hours. Both signals come from real data
 * (the analyser writes them after every objective outcome) — never a
 * hardcoded heuristic.
 *
 * The banner is licence-aware:
 *   - quoxmind-pro+ orgs see the full warning + recent failure count
 *   - free-tier orgs see a soft nudge ("upgrade to see predictions")
 *   - if predict stats are unreachable or null, render nothing
 */

import { useEffect, useState } from 'react'
import { fetchPredictStatsSummary } from '../../services/objectivesClient'
import { isPluginLicensed } from '../../services/licenseValidator'

const LOW_CONFIDENCE_THRESHOLD = 0.5     // 50% — wisdom confidence below this is a signal
const FAILURE_FLOOR = 2                  // need at least 2 post-mortems before we warn

export function AdvisorHealthBanner({ authFetch }) {
  const [stats, setStats] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!authFetch) return
    let cancelled = false
    fetchPredictStatsSummary(authFetch)
      .then(s => { if (!cancelled) { setStats(s); setLoaded(true) } })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [authFetch])

  if (!loaded) return null

  // Server returned LICENSE_REQUIRED — show nothing for free orgs (the
  // topology card already shows the upgrade nudge; not duplicating here).
  const license = stats?.failureReason?.code === 'LICENSE_REQUIRED'
  if (license || stats?.failureReason?.code === 'SERVICE_UNREACHABLE') return null

  const fields = stats?.fields || {}
  const avgConfidence = fields.avgConfidence
  const wisdomCount = fields.wisdomCount ?? 0
  const isPro = isPluginLicensed('quoxmind-pro')

  // Advisor mandatory directives are only emitted for Pro+ (QMH-4b). For free
  // orgs we still surface a "what you're missing" hint so the value is visible.
  if (!isPro) {
    if (wisdomCount === 0) return null
    return (
      <div style={{
        padding: '8px 12px', margin: '4px 12px 0', borderRadius: 6, fontSize: 12,
        background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
        color: 'rgba(245,158,11,0.85)', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span>🔒</span>
        <span>
          <strong>QuoxPredict has {wisdomCount} pattern{wisdomCount === 1 ? '' : 's'} on file</strong>
          {' '}— upgrade to QuoxMind Pro to receive pre-flight advisory directives on similar work.
        </span>
      </div>
    )
  }

  // Pro+ org: surface the warning when confidence is low or post-mortems pile up.
  const lowConfidence = typeof avgConfidence === 'number' && avgConfidence < LOW_CONFIDENCE_THRESHOLD
  if (!lowConfidence || wisdomCount < FAILURE_FLOOR) return null

  return (
    <div style={{
      padding: '10px 14px', margin: '4px 12px 0', borderRadius: 6, fontSize: 12,
      background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
      color: 'rgba(252,165,165,0.95)', display: 'flex', alignItems: 'flex-start', gap: 10,
    }}>
      <span style={{ marginTop: 1 }}>⚠</span>
      <span style={{ lineHeight: 1.5 }}>
        <strong>Advisor confidence is low</strong> — average wisdom confidence is {Math.round(avgConfidence * 100)}%
        across {wisdomCount} patterns. Recent post-mortems suggest this kind of work is currently failing more than succeeding.
        Review pre-flight directives carefully before running new objectives.
      </span>
    </div>
  )
}

export default AdvisorHealthBanner
