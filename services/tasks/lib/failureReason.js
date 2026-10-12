export function getObjectiveFailureReason(db, objectiveId) {
  const failureLog = db.prepare(`
    SELECT message
    FROM task_logs
    WHERE objective_id = ?
      AND level = 'error'
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(objectiveId)

  return failureLog?.message || null
}
