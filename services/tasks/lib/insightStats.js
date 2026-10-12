// Stream QMH (QuoxMind Honest), QMH-2 QuoxInsight commit.
//
// Insight's signal source is implant_signals — clusters detected when
// multiple implants report in the same time window suggest a system-wide
// pattern. The cognitive topology card was previously mapped to
// getIntegrationSpineStats() (workflow counts + Uptime Kuma monitors), which
// is unrelated to cross-implant correlation.
//
// QMH-2 introduces a synchronous read-time correlator. QMH-3 will move it to
// a 5-minute scheduled job that persists clusters. For now: scan recent
// signals (last hour by default) and report clusters of 3+ distinct implants
// reporting within a 60-second sliding window.
//
// Public API:
//   computeInsightStats(db, { orgId, lookbackMinutes?, windowSec?, minImplants? })

const DEFAULT_LOOKBACK_MIN = 60
const DEFAULT_WINDOW_SEC = 60
const DEFAULT_MIN_IMPLANTS = 3

export function computeInsightStats(db, {
  orgId,
  lookbackMinutes = DEFAULT_LOOKBACK_MIN,
  windowSec = DEFAULT_WINDOW_SEC,
  minImplants = DEFAULT_MIN_IMPLANTS,
} = {}) {
  if (!orgId) throw new Error('computeInsightStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                                      AS count,
      MAX(created_at)                               AS last_signal_at
    FROM implant_signals
    WHERE org_id = ?
  `).get(orgId)

  const signalCount = totals?.count || 0
  if (signalCount === 0) {
    return {
      signalCount: 0,
      signalsRecentWindow: 0,
      clustersDetected: 0,
      lastClusterAt: null,
      lastSignalAt: null,
      healthScore: null,
    }
  }

  // Pull recent signals only — bounded by lookbackMinutes.
  const rows = db.prepare(`
    SELECT implant_id, created_at
    FROM implant_signals
    WHERE org_id = ?
      AND created_at >= datetime('now', '-' || ? || ' minutes')
    ORDER BY created_at ASC
  `).all(orgId, lookbackMinutes)

  const signalsRecentWindow = rows.length

  // Sliding window over time-ordered signals: any windowSec span containing
  // signals from minImplants distinct implants is a cluster. Each cluster is
  // counted once per non-overlapping window (greedy advance).
  const clusters = []
  const windowMs = windowSec * 1000
  const times = rows.map(r => Date.parse(r.created_at + 'Z'))

  let i = 0
  while (i < rows.length) {
    const start = times[i]
    const end = start + windowMs
    const distinct = new Set()
    let j = i
    while (j < rows.length && times[j] <= end) {
      distinct.add(rows[j].implant_id)
      j++
    }
    if (distinct.size >= minImplants) {
      clusters.push({ at: rows[i].created_at, implants: distinct.size })
      i = j  // Advance past this cluster (non-overlapping count)
    } else {
      i++
    }
  }

  const clustersDetected = clusters.length
  const lastClusterAt = clustersDetected > 0 ? clusters[clusters.length - 1].at : null

  return {
    signalCount,
    signalsRecentWindow,
    clustersDetected,
    lastClusterAt,
    lastSignalAt: totals?.last_signal_at || null,
    healthScore: insightHealthScore({ signalCount, signalsRecentWindow, clustersDetected }),
  }
}

function insightHealthScore({ signalCount, signalsRecentWindow, clustersDetected }) {
  if (signalCount === 0) return null
  let score = 100
  // Many recent signals + clusters detected = active correlation; slightly
  // healthier than just a quiet period (correlator working as intended).
  // Many clusters relative to signal volume could mean noise — penalise.
  if (signalsRecentWindow > 0 && clustersDetected > signalsRecentWindow / 5) score -= 15
  return Math.max(0, Math.min(100, score))
}
