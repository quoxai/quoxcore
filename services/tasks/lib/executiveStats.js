// Stream QMH (QuoxMind Honest), QMH-2 QuoxExecutive commit.
//
// Executive's signal source is objectives + tasks — operational coordination,
// not the static assistants registry. The previous mapping read
// getAgentMeshStats() which counted entries in the assistants config (numbers
// that change only when the config file changes — pure UI placeholder).
// Real "executive" health is what the orchestrator is actually doing:
// objectives in flight, delegations spread across agents, success rate.
//
// Public API:
//   computeExecutiveStats(db, { orgId })

const IN_FLIGHT_STATUSES = ['pending', 'running', 'in_progress', 'queued']

/**
 * Aggregate objectives + tasks for an org.
 *
 * Returns:
 *   {
 *     objectivesTotal, objectivesInFlight, objectivesCompleted24h,
 *     tasksTotal, tasksInFlight, agentsAssigned,
 *     avgTasksPerObjective, healthScore (null when no objectives yet)
 *   }
 */
export function computeExecutiveStats(db, { orgId } = {}) {
  if (!orgId) throw new Error('computeExecutiveStats: orgId required')

  const placeholders = IN_FLIGHT_STATUSES.map(() => '?').join(',')

  const objStats = db.prepare(`
    SELECT
      COUNT(*)                                                                 AS total,
      SUM(CASE WHEN status IN (${placeholders}) THEN 1 ELSE 0 END)              AS in_flight,
      SUM(CASE WHEN status IN ('success', 'completed') AND completed_at IS NOT NULL
                AND completed_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS completed_24h,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)                        AS failed_total,
      AVG(task_count)                                                            AS avg_tasks_per_objective,
      MAX(created_at)                                                            AS last_objective_at
    FROM objectives
    WHERE org_id = ?
  `).get(...IN_FLIGHT_STATUSES, orgId)

  const taskStats = db.prepare(`
    SELECT
      COUNT(*)                                                       AS total,
      SUM(CASE WHEN status IN (${placeholders}) THEN 1 ELSE 0 END)    AS in_flight,
      COUNT(DISTINCT agent_id)                                       AS agents_assigned
    FROM tasks
    WHERE org_id = ?
  `).get(...IN_FLIGHT_STATUSES, orgId)

  const objectivesTotal = objStats?.total || 0
  const objectivesInFlight = objStats?.in_flight || 0
  const objectivesCompleted24h = objStats?.completed_24h || 0
  const objectivesFailed = objStats?.failed_total || 0
  const tasksTotal = taskStats?.total || 0
  const tasksInFlight = taskStats?.in_flight || 0
  const agentsAssigned = taskStats?.agents_assigned || 0
  const avgTasksPerObjective = objectivesTotal > 0 ? (objStats?.avg_tasks_per_objective ?? null) : null

  return {
    objectivesTotal,
    objectivesInFlight,
    objectivesCompleted24h,
    objectivesFailed,
    tasksTotal,
    tasksInFlight,
    agentsAssigned,
    avgTasksPerObjective,
    lastObjectiveAt: objStats?.last_objective_at || null,
    healthScore: executiveHealthScore({
      objectivesTotal,
      objectivesFailed,
      tasksTotal,
      agentsAssigned,
    }),
  }
}

function executiveHealthScore({ objectivesTotal, objectivesFailed, tasksTotal, agentsAssigned }) {
  if (objectivesTotal === 0 && tasksTotal === 0) return null
  let score = 100
  // High failure rate.
  if (objectivesTotal > 0) {
    const failRate = objectivesFailed / objectivesTotal
    if (failRate > 0.5) score -= 30
    else if (failRate > 0.25) score -= 15
  }
  // Many tasks but only one agent assigned = no actual delegation happening.
  if (tasksTotal >= 5 && agentsAssigned <= 1) score -= 15
  return Math.max(0, Math.min(100, score))
}
