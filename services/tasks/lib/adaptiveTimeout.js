/**
 * QM-7: Adaptive Timeouts
 *
 * Computes task deadlines based on historical execution durations per agent.
 * If historical data exists, uses 2.5x the observed max duration (capped by hard_max).
 * Falls back to the provided default timeout when no history is available.
 */

import { getDatabase } from '../db/index.js'

const HARD_MAX_TIMEOUT_MS = 1800000  // 30 minutes absolute cap

/**
 * Get an adaptive timeout for a given agent based on recent task durations.
 *
 * @param {string} agentId - The agent to look up history for
 * @param {number} defaultTimeout - Fallback timeout in ms if no history exists
 * @returns {{ timeout: number, based_on: number, max_dur: number|null }}
 */
export function getAdaptiveTimeout(agentId, defaultTimeout) {
  if (!agentId) {
    return { timeout: defaultTimeout, based_on: 0, max_dur: null }
  }

  try {
    const db = getDatabase()

    const row = db.prepare(`
      SELECT AVG(duration_ms) AS avg_dur, MAX(duration_ms) AS max_dur, COUNT(*) AS cnt
      FROM (
        SELECT duration_ms FROM tasks
        WHERE agent_id = ? AND status = 'completed' AND duration_ms > 0
        ORDER BY completed_at DESC
        LIMIT 20
      )
    `).get(agentId)

    if (!row || !row.cnt || row.cnt === 0 || !row.max_dur) {
      return { timeout: defaultTimeout, based_on: 0, max_dur: null }
    }

    const adaptiveTimeout = Math.min(Math.round(row.max_dur * 2.5), HARD_MAX_TIMEOUT_MS)
    // Don't go below the default if adaptive is smaller (agent might be fast but task could vary)
    const finalTimeout = Math.max(adaptiveTimeout, Math.min(defaultTimeout, HARD_MAX_TIMEOUT_MS))

    console.log(`[QuoxMind] Adaptive timeout for agent ${agentId}: ${finalTimeout}ms (based on ${row.cnt} historical tasks, max ${Math.round(row.max_dur)}ms)`)

    return { timeout: finalTimeout, based_on: row.cnt, max_dur: Math.round(row.max_dur) }
  } catch (err) {
    // Non-fatal — fall back to default
    console.warn(`[QuoxMind] Adaptive timeout query failed for ${agentId}: ${err.message}`)
    return { timeout: defaultTimeout, based_on: 0, max_dur: null }
  }
}
