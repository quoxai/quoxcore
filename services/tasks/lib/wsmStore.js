// Stream QMH-3 — server-side Working Set Memory store.
//
// Replaces the browser-only WSM (src/services/workingSetMemory.js
// localStorage) for the QuoxFocus signal path. The browser version was the
// reason QuoxFocus showed "0 open loops" forever — its data source vanished
// on every page reload AND was license-blocked at workingSetMemory.js:439-442
// (memoryTier.js: hasWSM=false on the free tier).
//
// Schema lives in services/tasks/db/schema.sql.
//
// Per-user, per-org. All read/write APIs require both orgId and userId.
//
// Public API:
//   getCurrentFocus(db, { orgId, userId })
//   setCurrentFocus(db, { orgId, userId, task, project, goal, context })
//   clearCurrentFocus(db, { orgId, userId })
//   addOpenLoop(db, { orgId, userId, type, description, ... })
//   listOpenLoops(db, { orgId, userId, includeResolved? })
//   resolveOpenLoop(db, { id, outcome? })
//   touchEntity(db, { orgId, userId, entityType, entityId, name?, context? })
//   listRecentEntities(db, { orgId, userId, limit? })

import { ulid } from 'ulid'

// ── Focus ─────────────────────────────────────────────────────────────────

export function getCurrentFocus(db, { orgId, userId } = {}) {
  if (!orgId || !userId) throw new Error('getCurrentFocus: orgId and userId required')
  const row = db.prepare(`
    SELECT task, project, goal, started_at, context_json, updated_at
    FROM wsm_focus
    WHERE org_id = ? AND user_id = ?
  `).get(orgId, userId)
  if (!row) return null
  return {
    task: row.task,
    project: row.project,
    goal: row.goal,
    startedAt: row.started_at,
    context: parseJson(row.context_json),
    updatedAt: row.updated_at,
  }
}

export function setCurrentFocus(db, { orgId, userId, task, project, goal, context, startedAt } = {}) {
  if (!orgId || !userId) throw new Error('setCurrentFocus: orgId and userId required')
  const ctxJson = JSON.stringify(context || {})
  const start = startedAt || new Date().toISOString()
  db.prepare(`
    INSERT INTO wsm_focus (org_id, user_id, task, project, goal, started_at, context_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(org_id, user_id) DO UPDATE SET
      task = excluded.task,
      project = excluded.project,
      goal = excluded.goal,
      started_at = COALESCE(excluded.started_at, wsm_focus.started_at),
      context_json = excluded.context_json,
      updated_at = datetime('now')
  `).run(orgId, userId, task ?? null, project ?? null, goal ?? null, start, ctxJson)
}

export function clearCurrentFocus(db, { orgId, userId } = {}) {
  if (!orgId || !userId) throw new Error('clearCurrentFocus: orgId and userId required')
  db.prepare(`DELETE FROM wsm_focus WHERE org_id = ? AND user_id = ?`).run(orgId, userId)
}

// ── Open Loops ────────────────────────────────────────────────────────────

export function addOpenLoop(db, {
  orgId, userId, type, description,
  priority = 'medium', relatedProject = null, context = null, trigger = null, dueBy = null,
} = {}) {
  if (!orgId || !userId) throw new Error('addOpenLoop: orgId and userId required')
  if (!type) throw new Error('addOpenLoop: type required')
  if (!description) throw new Error('addOpenLoop: description required')

  const id = ulid()
  db.prepare(`
    INSERT INTO wsm_open_loops
      (id, org_id, user_id, type, description, status, priority,
       related_project, context_json, trigger_json, due_by,
       created_at, last_touched_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id, orgId, userId, type, description, priority,
    relatedProject,
    context ? JSON.stringify(context) : null,
    trigger ? JSON.stringify(trigger) : null,
    dueBy
  )
  return { id }
}

export function listOpenLoops(db, { orgId, userId, includeResolved = false, limit = 100 } = {}) {
  if (!orgId || !userId) throw new Error('listOpenLoops: orgId and userId required')
  const statusClause = includeResolved ? '' : "AND status = 'open'"
  const rows = db.prepare(`
    SELECT id, type, description, status, priority, related_project,
           context_json, trigger_json, created_at, last_touched_at,
           due_by, resolved_at, resolution_outcome
    FROM wsm_open_loops
    WHERE org_id = ? AND user_id = ? ${statusClause}
    ORDER BY last_touched_at DESC
    LIMIT ?
  `).all(orgId, userId, limit)

  return rows.map(r => ({
    id: r.id,
    type: r.type,
    description: r.description,
    status: r.status,
    priority: r.priority,
    relatedProject: r.related_project,
    context: parseJson(r.context_json),
    trigger: parseJson(r.trigger_json),
    createdAt: r.created_at,
    lastTouchedAt: r.last_touched_at,
    dueBy: r.due_by,
    resolvedAt: r.resolved_at,
    resolutionOutcome: r.resolution_outcome,
  }))
}

export function resolveOpenLoop(db, { id, outcome = null } = {}) {
  if (!id) throw new Error('resolveOpenLoop: id required')
  db.prepare(`
    UPDATE wsm_open_loops
       SET status = 'resolved',
           resolved_at = datetime('now'),
           resolution_outcome = ?,
           last_touched_at = datetime('now')
     WHERE id = ?
  `).run(outcome, id)
}

// ── Recent Entities ──────────────────────────────────────────────────────

export function touchEntity(db, { orgId, userId, entityType, entityId, name = null, context = null } = {}) {
  if (!orgId || !userId) throw new Error('touchEntity: orgId and userId required')
  if (!entityType) throw new Error('touchEntity: entityType required')
  if (!entityId) throw new Error('touchEntity: entityId required')

  const ctxJson = context ? JSON.stringify(context) : null
  db.prepare(`
    INSERT INTO wsm_recent_entities
      (org_id, user_id, entity_type, entity_id, name, last_mentioned_at, mention_count, context_json)
    VALUES (?, ?, ?, ?, ?, datetime('now'), 1, ?)
    ON CONFLICT(org_id, user_id, entity_type, entity_id) DO UPDATE SET
      name = COALESCE(excluded.name, wsm_recent_entities.name),
      last_mentioned_at = datetime('now'),
      mention_count = wsm_recent_entities.mention_count + 1,
      context_json = COALESCE(excluded.context_json, wsm_recent_entities.context_json)
  `).run(orgId, userId, entityType, entityId, name, ctxJson)
}

export function listRecentEntities(db, { orgId, userId, limit = 50 } = {}) {
  if (!orgId || !userId) throw new Error('listRecentEntities: orgId and userId required')
  const rows = db.prepare(`
    SELECT entity_type, entity_id, name, last_mentioned_at, mention_count, context_json
    FROM wsm_recent_entities
    WHERE org_id = ? AND user_id = ?
    ORDER BY last_mentioned_at DESC
    LIMIT ?
  `).all(orgId, userId, limit)
  return rows.map(r => ({
    entityType: r.entity_type,
    entityId: r.entity_id,
    name: r.name,
    lastMentionedAt: r.last_mentioned_at,
    mentionCount: r.mention_count,
    context: parseJson(r.context_json),
  }))
}

// ── helpers ──────────────────────────────────────────────────────────────

function parseJson(s) {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}
