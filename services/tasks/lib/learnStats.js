// Stream QMH (QuoxMind Honest), QMH-2 QuoxLearn commit.
//
// Learn's signal source is agent_performance — populated by Stream AT-3
// agentScorer.recordPerformance() every time a task completes. The cognitive
// topology card was previously mapped to getDataFabricStats() (file/folder
// counts), which has nothing to do with learning. This module aggregates
// per-agent learning signals from the real performance log.
//
// Public API:
//   computeLearnStats(db, { orgId })

/**
 * Aggregate agent_performance for an org. Observation count, unique agents,
 * avg quality, success rate, recent (24h) signal, healthScore.
 */
export function computeLearnStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeLearnStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                               AS count,
      COUNT(DISTINCT agent_id)               AS agents_tracked,
      AVG(quality_score)                     AS avg_quality,
      AVG(latency_ms)                        AS avg_latency,
      AVG(success)                           AS success_rate,
      MAX(created_at)                        AS last_observation_at
    FROM agent_performance
    WHERE org_id = ?
  `).get(orgId)

  const window24h = db.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_performance
    WHERE org_id = ?
      AND created_at >= datetime('now', '-1 day')
  `).get(orgId)

  const observationCount = totals?.count || 0
  const agentsTracked = totals?.agents_tracked || 0
  const avgQuality = observationCount > 0 ? (totals?.avg_quality ?? null) : null
  const avgLatencyMs = observationCount > 0 ? (totals?.avg_latency ?? null) : null
  const successRate = observationCount > 0 ? (totals?.success_rate ?? null) : null

  return {
    observationCount,
    agentsTracked,
    avgQuality,
    avgLatencyMs,
    successRate,
    observations24h: window24h?.count || 0,
    lastObservationAt: totals?.last_observation_at || null,
    healthScore: learnHealthScore({ observationCount, avgQuality, successRate }),
  }
}

function learnHealthScore({ observationCount, avgQuality, successRate }) {
  if (observationCount === 0) return null
  let score = 100
  // Low average quality.
  if (avgQuality !== null && avgQuality < 40) score -= 30
  else if (avgQuality !== null && avgQuality < 60) score -= 15
  // Low success rate.
  if (successRate !== null && successRate < 0.5) score -= 25
  else if (successRate !== null && successRate < 0.75) score -= 10
  return Math.max(0, Math.min(100, score))
}
