// Stream QMH-3 part 2 — HITL checkpoint listing with priority severity.
//
// Joins pending checkpoints with their parent task to surface priority
// (written at task-creation time by decomposer via priorityScorer). The
// inbox UI sorts by this so the user reviews the most important blocked
// work first — the actual cognitive role QuoxValue describes.
//
// Public API:
//   listPendingCheckpoints(db, { orgId, limit?, includeReviewed? })

export function listPendingCheckpoints(db, { orgId, limit = 100, includeReviewed = false } = {}) {
  if (!orgId) throw new Error('listPendingCheckpoints: orgId required')

  const statusClause = includeReviewed ? '' : "AND c.status = 'pending'"

  const rows = db.prepare(`
    SELECT
      c.id,
      c.objective_id,
      c.task_id,
      c.checkpoint_type,
      c.status,
      c.title,
      c.description,
      c.created_at,
      o.title AS objective_title,
      t.priority AS task_priority,
      t.title AS task_title
    FROM checkpoints c
    INNER JOIN objectives o ON o.id = c.objective_id
    LEFT JOIN tasks t ON t.id = c.task_id
    WHERE o.org_id = ? ${statusClause}
    ORDER BY COALESCE(t.priority, 50) DESC, c.created_at ASC
    LIMIT ?
  `).all(orgId, limit)

  return rows.map(r => ({
    id: r.id,
    objectiveId: r.objective_id,
    taskId: r.task_id,
    checkpointType: r.checkpoint_type,
    status: r.status,
    title: r.title,
    description: r.description,
    createdAt: r.created_at,
    objectiveTitle: r.objective_title,
    taskTitle: r.task_title,
    taskPriority: r.task_priority ?? null,
  }))
}
