// Stream QMH-3 — QuoxFocus stats backed by server-side WSM.
//
// The cognitive topology card was previously computed by a hardcoded formula
// in cognitiveTopologyService.js: `20 + openLoops*10 + entities*5` clamped to
// [0,100]. The data feeding the formula came from the browser-only WSM
// (workingSetMemory.js) — localStorage that vanished on every page reload AND
// was license-blocked at workingSetMemory.js:439-442 anyway. Result: the card
// said "0 open loops" forever.
//
// Real signal: working-set saturation derived from the durable wsm_* tables.
// Public API:
//   computeFocusStats(db, { orgId, userId })

const LOOP_TARGET = 8       // healthy WSM has a handful of open loops
const ENTITY_TARGET = 12    // and a handful of recent entities

/**
 * Compute QuoxFocus stats. Returns null healthScore (Collecting) when no
 * focus, no loops, and no entities exist for this user.
 */
export function computeFocusStats(db, { orgId, userId } = {}) {
  if (!orgId) throw new Error('computeFocusStats: orgId required')
  if (!userId) throw new Error('computeFocusStats: userId required')

  const focusRow = db.prepare(`
    SELECT task, project, started_at FROM wsm_focus
    WHERE org_id = ? AND user_id = ?
  `).get(orgId, userId)

  const loopRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM wsm_open_loops
    WHERE org_id = ? AND user_id = ? AND status = 'open'
  `).get(orgId, userId)

  const entityRow = db.prepare(`
    SELECT COUNT(*) AS count, MAX(last_mentioned_at) AS last_at
    FROM wsm_recent_entities
    WHERE org_id = ? AND user_id = ?
  `).get(orgId, userId)

  const hasFocus = !!(focusRow?.task || focusRow?.project)
  const openLoops = loopRow?.count || 0
  const recentEntities = entityRow?.count || 0

  const healthScore = focusHealthScore({ hasFocus, openLoops, recentEntities })

  return {
    hasFocus,
    currentTask: focusRow?.task || null,
    currentProject: focusRow?.project || null,
    focusStartedAt: focusRow?.started_at || null,
    openLoops,
    recentEntities,
    lastEntityAt: entityRow?.last_at || null,
    healthScore,
  }
}

/**
 * Score logic:
 *   - null when WSM is completely empty (Collecting).
 *   - Working-set saturation curve: full at LOOP_TARGET / ENTITY_TARGET.
 *   - Penalty when WSM is saturated WAY past target (cognitive overload).
 *   - Bonus when current focus is set (the system knows what we're doing).
 */
function focusHealthScore({ hasFocus, openLoops, recentEntities }) {
  if (!hasFocus && openLoops === 0 && recentEntities === 0) return null

  const loopFill = clamp(openLoops / LOOP_TARGET, 0, 1)
  const entityFill = clamp(recentEntities / ENTITY_TARGET, 0, 1)

  // Base saturation contribution (60% of score: 30 each).
  let score = 30 * loopFill + 30 * entityFill

  // Focus presence (30 of remaining 40).
  if (hasFocus) score += 30

  // Some baseline activity (10) once any signal exists.
  score += 10

  // Overload penalty: more than 3x target = WSM is bloated.
  if (openLoops > LOOP_TARGET * 3) score -= 20
  if (recentEntities > ENTITY_TARGET * 3) score -= 10

  return Math.max(0, Math.min(100, Math.round(score)))
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}
