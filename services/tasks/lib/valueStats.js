// Stream QMH (QuoxMind Honest), QMH-2 QuoxValue commit.
//
// Value's signal source is agent_performance — the same per-task scorer log
// that QuoxLearn reads from, but interpreted as "quality delivered per unit
// of cost". The cognitive topology card was previously mapped to
// getToolingCortexStats() (entity counts in the entity store), which is
// completely unrelated to capability value. Real "value" is what the agents
// actually produced, weighted against what they spent.
//
// Public API:
//   computeValueStats(db, { orgId })

/**
 * Aggregate quality vs. cost for an org. Quality-per-1k-tokens is the
 * primary signal; per-domain breakdown shows where capability is most
 * efficient.
 */
export function computeValueStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeValueStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                                AS count,
      COALESCE(SUM(tokens_used), 0)            AS total_tokens,
      COALESCE(SUM(quality_score), 0)          AS total_quality,
      AVG(quality_score)                       AS avg_quality,
      MAX(created_at)                          AS last_observation_at
    FROM agent_performance
    WHERE org_id = ?
  `).get(orgId)

  // QMH-3 part 2: pending-work priority pressure from priorityScorer-written
  // task.priority values. Honest "valuation in flight" signal — what the
  // system currently considers most important among queued work.
  const pendingPriority = db.prepare(`
    SELECT
      COUNT(*)                                AS pending_count,
      AVG(priority)                            AS avg_priority,
      MAX(priority)                            AS max_priority,
      SUM(CASE WHEN priority >= 80 THEN 1 ELSE 0 END) AS high_priority_count
    FROM tasks
    WHERE org_id = ? AND status IN ('pending', 'queued', 'running', 'in_progress')
  `).get(orgId)

  const domainRows = db.prepare(`
    SELECT
      COALESCE(domain, 'general')              AS domain,
      COUNT(*)                                  AS observations,
      COALESCE(SUM(tokens_used), 0)             AS tokens,
      COALESCE(SUM(quality_score), 0)           AS quality,
      AVG(quality_score)                        AS avg_quality
    FROM agent_performance
    WHERE org_id = ?
    GROUP BY COALESCE(domain, 'general')
  `).all(orgId)

  const observationCount = totals?.count || 0
  const totalTokens = totals?.total_tokens || 0
  const totalQuality = totals?.total_quality || 0
  const avgQuality = observationCount > 0 ? (totals?.avg_quality ?? null) : null

  // Quality per 1000 tokens. If no tokens recorded yet, leave null.
  const qualityPerKToken = totalTokens > 0
    ? totalQuality / (totalTokens / 1000)
    : null

  const byDomain = {}
  for (const row of domainRows) {
    const qpk = row.tokens > 0 ? row.quality / (row.tokens / 1000) : null
    byDomain[row.domain] = {
      observations: row.observations,
      tokens: row.tokens,
      quality: row.quality,
      avgQuality: row.avg_quality,
      qualityPerKToken: qpk,
    }
  }

  return {
    observationCount,
    totalTokens,
    totalQuality,
    avgQuality,
    qualityPerKToken,
    byDomain,
    lastObservationAt: totals?.last_observation_at || null,
    pendingPriority: {
      pendingCount: pendingPriority?.pending_count || 0,
      avgPriority: (pendingPriority?.pending_count || 0) > 0 ? (pendingPriority?.avg_priority ?? null) : null,
      maxPriority: (pendingPriority?.pending_count || 0) > 0 ? (pendingPriority?.max_priority ?? null) : null,
      highPriorityCount: pendingPriority?.high_priority_count || 0,
    },
    healthScore: valueHealthScore({ observationCount, qualityPerKToken, avgQuality }),
  }
}

function valueHealthScore({ observationCount, qualityPerKToken, avgQuality }) {
  if (observationCount === 0) return null
  let score = 100
  // Low average quality regardless of cost = capability not delivering.
  if (avgQuality !== null && avgQuality < 40) score -= 30
  else if (avgQuality !== null && avgQuality < 60) score -= 15
  // Very low quality-per-1k-tokens (lots of cost, little quality).
  // 50 quality per 1k tokens is roughly "average quality at 1k tokens/task";
  // below 20 means tasks are burning cost without delivering. Above is fine.
  if (qualityPerKToken !== null && qualityPerKToken < 20) score -= 15
  return Math.max(0, Math.min(100, score))
}
