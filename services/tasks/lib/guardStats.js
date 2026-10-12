// Stream QMH (QuoxMind Honest), QMH-2 QuoxGuard commit.
//
// Guard's signal source is autonomy_decisions — Stream QM's autonomyDecision
// module writes one row every time the system decides allow/deny/escalate on
// an agent action. The cognitive topology card was previously mapped to
// getReliabilityStats() (page-load uptime ratio), which has nothing to do
// with policy enforcement.
//
// Public API:
//   computeGuardStats(db, { orgId })

/**
 * Aggregate autonomy decisions for an org. Counts by outcome, agents
 * covered, recent (24h), healthScore.
 */
export function computeGuardStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeGuardStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                                                   AS count,
      COUNT(DISTINCT agent_id)                                   AS agents_covered,
      MAX(created_at)                                            AS last_decision_at,
      SUM(CASE WHEN decision = 'allow'    THEN 1 ELSE 0 END)     AS allow_count,
      SUM(CASE WHEN decision = 'deny'     THEN 1 ELSE 0 END)     AS deny_count,
      SUM(CASE WHEN decision = 'escalate' THEN 1 ELSE 0 END)     AS escalate_count
    FROM autonomy_decisions
    WHERE org_id = ?
  `).get(orgId)

  const window24h = db.prepare(`
    SELECT COUNT(*) AS count
    FROM autonomy_decisions
    WHERE org_id = ?
      AND created_at >= datetime('now', '-1 day')
  `).get(orgId)

  const decisionCount = totals?.count || 0

  return {
    decisionCount,
    allowCount: totals?.allow_count || 0,
    denyCount: totals?.deny_count || 0,
    escalateCount: totals?.escalate_count || 0,
    agentsCovered: totals?.agents_covered || 0,
    decisions24h: window24h?.count || 0,
    lastDecisionAt: totals?.last_decision_at || null,
    healthScore: guardHealthScore({
      decisionCount,
      denyCount: totals?.deny_count || 0,
      allowCount: totals?.allow_count || 0,
    }),
  }
}

function guardHealthScore({ decisionCount, denyCount, allowCount }) {
  if (decisionCount === 0) return null
  let score = 100
  // Heavy deny ratio = many actions blocked, system is fighting itself.
  if (decisionCount > 0) {
    const denyRate = denyCount / decisionCount
    if (denyRate > 0.5) score -= 25
    else if (denyRate > 0.25) score -= 10
  }
  // No allows ever despite many decisions = enforcement may be misconfigured.
  if (decisionCount >= 10 && allowCount === 0) score -= 15
  return Math.max(0, Math.min(100, score))
}
