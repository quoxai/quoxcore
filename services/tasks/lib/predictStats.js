// Stream QMH (QuoxMind Honest), QMH-2 QuoxPredict commit.
//
// Predict's signal source is the execution_wisdom table — already populated
// by Stream QM's analyser/wisdomStore. The cognitive topology card was
// previously mapped to getCodebaseFabricStats() (codebase invariants), which
// has nothing to do with prediction. This module reads the real wisdom store.
//
// Public API:
//   computePredictStats(db, { orgId })

import { NOT_EVENT_LOG_SQL } from './wisdomHygiene.js'

const CORE_THRESHOLD = 0.85
const ESTABLISHED_THRESHOLD = 0.65

/**
 * Aggregate active wisdom entries for an org.
 *
 * Returns:
 *   {
 *     wisdomCount, avgConfidence,
 *     coreCount, establishedCount, tentativeCount,
 *     recentWisdom24h, lastWisdomAt,
 *     healthScore (null when no wisdom yet)
 *   }
 */
export function computePredictStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computePredictStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                            AS count,
      AVG(confidence)                     AS avg_confidence,
      MAX(last_seen_at)                   AS last_wisdom_at,
      SUM(CASE WHEN confidence >= ? THEN 1 ELSE 0 END) AS core_count,
      SUM(CASE WHEN confidence >= ? AND confidence < ? THEN 1 ELSE 0 END) AS established_count,
      SUM(CASE WHEN confidence < ? THEN 1 ELSE 0 END) AS tentative_count
    FROM execution_wisdom
    WHERE org_id = ? AND active = 1 AND ${NOT_EVENT_LOG_SQL}
  `).get(
    CORE_THRESHOLD,
    ESTABLISHED_THRESHOLD,
    CORE_THRESHOLD,
    ESTABLISHED_THRESHOLD,
    orgId
  )

  const recent = db.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_wisdom
    WHERE org_id = ? AND active = 1 AND ${NOT_EVENT_LOG_SQL}
      AND last_seen_at IS NOT NULL
      AND last_seen_at >= datetime('now', '-1 day')
  `).get(orgId)

  // #1112: plugin event logs (ContactsQ/NotesQ counters) are not patterns;
  // they are reported separately so they cannot inflate predict's health.
  const events = db.prepare(`
    SELECT COUNT(*) AS count FROM execution_wisdom
    WHERE org_id = ? AND active = 1 AND NOT (${NOT_EVENT_LOG_SQL})
  `).get(orgId)
  let injected = { used: 0, last: null }
  try {
    injected = db.prepare(`
      SELECT SUM(CASE WHEN injected_count > 0 THEN 1 ELSE 0 END) AS used, MAX(last_injected_at) AS last
      FROM execution_wisdom WHERE org_id = ? AND active = 1 AND ${NOT_EVENT_LOG_SQL}
    `).get(orgId) || injected
  } catch { /* pre-042 schema */ }

  const wisdomCount = totals?.count || 0
  const avgConfidence = wisdomCount > 0 ? (totals?.avg_confidence ?? null) : null
  const coreCount = totals?.core_count || 0
  const establishedCount = totals?.established_count || 0
  const tentativeCount = totals?.tentative_count || 0

  return {
    wisdomCount,
    avgConfidence,
    coreCount,
    establishedCount,
    tentativeCount,
    recentWisdom24h: recent?.count || 0,
    lastWisdomAt: totals?.last_wisdom_at || null,
    eventLogCount: events?.count || 0,
    injectedWisdomCount: injected.used || 0,
    lastInjectedAt: injected.last || null,
    healthScore: predictHealthScore({ wisdomCount, avgConfidence, coreCount }),
  }
}

function predictHealthScore({ wisdomCount, avgConfidence, coreCount }) {
  if (wisdomCount === 0) return null
  let score = 100
  // Low average confidence = pattern detector is producing noise.
  if (avgConfidence !== null && avgConfidence < 0.5) score -= 30
  else if (avgConfidence !== null && avgConfidence < 0.65) score -= 15
  // Lots of wisdom but none promoted to "core" = nothing has matured.
  if (wisdomCount >= 10 && coreCount === 0) score -= 20
  return Math.max(0, Math.min(100, score))
}
