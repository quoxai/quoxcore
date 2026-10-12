// Stream QMH (QuoxMind Honest), QMH-2 QuoxDream commit.
//
// Persistent cycle history for QuoxDream. dreamCycle.js previously kept
// cycleCount/lastCycleAt/themesExtracted in module-level variables that
// reset on every server restart, and the frontend was reading from a
// completely different source (assistantStorage sync state). The result was
// "0 sessions" forever — a lie. This module is the durable signal.
//
// Schema lives in services/tasks/db/schema.sql (CREATE TABLE dream_cycles).
//
// Public API:
//   persistDreamCycle(db, { orgId, journalsProcessed, patternsFound,
//                            wisdomCreated, durationMs, skipped, error })
//   computeDreamStats(db, { orgId })

import { ulid } from 'ulid'

/**
 * Persist one dream-cycle outcome. cycle_number is the next per-org integer.
 */
export function persistDreamCycle(db, {
  orgId,
  journalsProcessed = 0,
  patternsFound = 0,
  wisdomCreated = 0,
  durationMs = 0,
  skipped = false,
  error = null,
  startedAt = null,
}) {
  if (!orgId) throw new Error('persistDreamCycle: orgId required')

  const row = db.prepare(`
    SELECT MAX(cycle_number) AS max_n FROM dream_cycles WHERE org_id = ?
  `).get(orgId)
  const next = (row?.max_n || 0) + 1

  const id = ulid()
  const start = startedAt || new Date().toISOString()
  const end = new Date().toISOString()
  db.prepare(`
    INSERT INTO dream_cycles
      (id, org_id, cycle_number, journals_processed, patterns_found,
       wisdom_created, duration_ms, skipped, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orgId,
    next,
    journalsProcessed,
    patternsFound,
    wisdomCreated,
    durationMs,
    skipped ? 1 : 0,
    error,
    start,
    end
  )
  return { id, cycleNumber: next }
}

/**
 * Read dream cycle history for an org and produce QuoxMind-shaped stats.
 *
 * Returns:
 *   {
 *     cycleCount, lastCycleAt, themesExtracted,
 *     journalsProcessed24h, wisdomCreated24h,
 *     skippedRatio, healthScore (null when no cycles yet)
 *   }
 */
export function computeDreamStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeDreamStats: orgId required')

  const totals = db.prepare(`
    SELECT
      COUNT(*)                            AS cycle_count,
      COALESCE(SUM(wisdom_created), 0)   AS themes_extracted,
      COALESCE(SUM(skipped), 0)          AS skipped_count,
      MAX(completed_at)                  AS last_cycle_at
    FROM dream_cycles
    WHERE org_id = ?
  `).get(orgId)

  const window24h = db.prepare(`
    SELECT
      COALESCE(SUM(journals_processed), 0) AS journals_24h,
      COALESCE(SUM(wisdom_created), 0)     AS wisdom_24h,
      COUNT(*)                             AS cycles_24h
    FROM dream_cycles
    WHERE org_id = ?
      AND completed_at IS NOT NULL
      AND completed_at >= datetime('now', '-1 day')
  `).get(orgId)

  const cycleCount = totals?.cycle_count || 0
  const themesExtracted = totals?.themes_extracted || 0
  const lastCycleAt = totals?.last_cycle_at || null
  const skipped = totals?.skipped_count || 0
  const skippedRatio = cycleCount > 0 ? skipped / cycleCount : 0

  return {
    cycleCount,
    lastCycleAt,
    themesExtracted,
    journalsProcessed24h: window24h?.journals_24h || 0,
    wisdomCreated24h: window24h?.wisdom_24h || 0,
    cycles24h: window24h?.cycles_24h || 0,
    skippedRatio,
    healthScore: dreamHealthScore({ cycleCount, themesExtracted, skippedRatio }),
  }
}

function dreamHealthScore({ cycleCount, themesExtracted, skippedRatio }) {
  if (cycleCount === 0) return null
  let score = 100
  // Heavy skipping = no journals to consolidate. Not an outage but visible.
  if (skippedRatio > 0.9) score -= 30
  else if (skippedRatio > 0.5) score -= 15
  // No themes ever extracted across many cycles = pattern detector starved.
  if (cycleCount >= 4 && themesExtracted === 0) score -= 30
  return Math.max(0, Math.min(100, score))
}
