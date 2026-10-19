// Stream QMH (QuoxMind Honest), QMH-2 QuoxReflect commit.
//
// Reflect's signal source is objective_outcomes — populated by Stream QM's
// analyser when an objective finishes (post-mortem, wisdom extraction, quality
// score). The cognitive topology card was previously mapped to
// getGovernanceStats() (policy registry counts), which has nothing to do with
// reflection on completed work. This module reads the real outcomes.
//
// Public API:
//   computeReflectStats(db, { orgId })

/**
 * Aggregate objective_outcomes for an org. Quality score, success/failure
 * split, post-mortem coverage, wisdom-link rate.
 */
export function computeReflectStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeReflectStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                                          AS count,
      AVG(quality_score)                                AS avg_quality,
      MAX(created_at)                                   AS last_outcome_at,
      SUM(CASE WHEN status IN ('success', 'completed') THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failure_count,
      SUM(CASE WHEN post_mortem IS NOT NULL AND post_mortem != '' THEN 1 ELSE 0 END) AS post_mortem_count,
      SUM(CASE WHEN wisdom_ids IS NOT NULL AND wisdom_ids != '[]' AND wisdom_ids != '' THEN 1 ELSE 0 END) AS wisdom_linked_count
    FROM objective_outcomes
    WHERE org_id = ?
  `).get(orgId)

  const window24h = db.prepare(`
    SELECT COUNT(*) AS count
    FROM objective_outcomes
    WHERE org_id = ?
      AND created_at >= datetime('now', '-1 day')
  `).get(orgId)

  const outcomeCount = totals?.count || 0
  const avgQuality = outcomeCount > 0 ? (totals?.avg_quality ?? null) : null
  const successCount = totals?.success_count || 0
  const failureCount = totals?.failure_count || 0
  const postMortemCount = totals?.post_mortem_count || 0
  const wisdomLinkedCount = totals?.wisdom_linked_count || 0

  return {
    outcomeCount,
    avgQuality,
    successCount,
    failureCount,
    postMortemCount,
    wisdomLinkedCount,
    outcomes24h: window24h?.count || 0,
    lastOutcomeAt: totals?.last_outcome_at || null,
    healthScore: reflectHealthScore({ outcomeCount, avgQuality, successCount, failureCount, postMortemCount }),
  }
}

function reflectHealthScore({ outcomeCount, avgQuality, successCount, failureCount, postMortemCount }) {
  if (outcomeCount === 0) return null
  let score = 100
  // Low average quality = the analyser keeps grading work poorly.
  if (avgQuality !== null && avgQuality < 0.4) score -= 30
  else if (avgQuality !== null && avgQuality < 0.6) score -= 15
  // High failure rate.
  const failureRate = outcomeCount > 0 ? failureCount / outcomeCount : 0
  if (failureRate > 0.5) score -= 20
  else if (failureRate > 0.25) score -= 10
  // No post-mortems written despite many outcomes = analyser silent.
  if (outcomeCount >= 5 && postMortemCount === 0) score -= 15
  return Math.max(0, Math.min(100, score))
}
