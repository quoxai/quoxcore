/**
 * AGENT-OVERHAUL — internal (service-to-service) Action Tracker routes for
 * agent-initiated writes (action_add / action_move / action_update /
 * action_delete via services/collector/lib/actionToolHandlers.js).
 *
 * The user-facing /api/orgs/:orgId/actions routes (routes/actions.js)
 * require requireAuth (browser JWT) + CSRF double-submit for state-changing
 * verbs. Agent tool calls run server-to-server with no browser session, so
 * they can never carry a CSRF cookie/header pair — writes were 403'ing with
 * "csrf_validation_failed / Missing CSRF token header".
 *
 * These internal routes are service-key gated (X-Service-Key) and
 * CSRF-exempt (mounted under /api/internal/, already exempt in
 * middleware/csrf.js), but still enforce the SAME per-org authorization the
 * user-facing route does — nothing here widens the trust boundary:
 *   - org_id AND user_id must be supplied explicitly by the caller (never a
 *     wildcard / "any org"; the collector threads these from the agent's
 *     already-validated request context).
 *   - the user must be an ACTIVE member of that org_id — re-checked here via
 *     org_memberships, since bypassing requireAuth/requireOrgMembership
 *     means that invariant isn't free anymore.
 *   - update/delete still require the requesting user to be the item's
 *     creator/assignee, or an org admin — identical rule to routes/actions.js.
 *
 *   POST   /api/internal/actions        { org_id, user_id, title, ... }
 *   PATCH  /api/internal/actions/:id    { org_id, user_id, ...fields }
 *   DELETE /api/internal/actions/:id    { org_id, user_id }
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), timing-safe, fails CLOSED when
 * the key isn't configured — identical pattern to routes/internal-backups.js.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { ulid, createAuditEvent, safeJsonParse } from '../utils/helpers.js';

const router = Router();

const VALID_STATUSES = ['todo', 'doing', 'done'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_SOURCES = ['user', 'ai', 'workflow'];

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying internal actions request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

// Re-derives the same invariant requireOrgMembership enforces on the
// user-facing route: the acting user must be an ACTIVE member of a
// non-deleted org_id, with a membership that hasn't expired. Never trust
// org_id alone. ACTIONQ-FIX-SPEC 1a / NEW-7: this previously checked ONLY
// membership status, weaker than the public route's requireOrgMembership
// (which also rejects deleted orgs and expired (e.g. time-bounded auditor)
// memberships) — an internal write could succeed where the equivalent
// public-route request would 403/404.
function activeMembership(db, orgId, userId) {
  return db.prepare(`
    SELECT om.role FROM org_memberships om
    JOIN orgs o ON o.id = om.org_id
    WHERE om.org_id = ? AND om.user_id = ? AND om.status = 'active'
      AND o.deleted_at IS NULL
      AND (om.expires_at IS NULL OR om.expires_at > datetime('now'))
  `).get(orgId, userId) || null;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Mirrors routes/actions.js bumpStreak(), parametrized on db for testability.
function bumpStreak(db, userId, orgId) {
  const today = todayUtc();
  const row = db.prepare(`
    SELECT current_streak AS current, best_streak AS best, last_completion_date AS lastCompletionDate
    FROM user_action_streaks WHERE user_id = ? AND org_id = ?
  `).get(userId, orgId);
  const prev = row || { current: 0, best: 0, lastCompletionDate: null };

  let nextCurrent = 1;
  if (prev.lastCompletionDate === today) {
    nextCurrent = prev.current;
  } else if (prev.lastCompletionDate) {
    const last = new Date(prev.lastCompletionDate + 'T00:00:00Z');
    const now = new Date(today + 'T00:00:00Z');
    const diffDays = Math.round((now - last) / 86400000);
    nextCurrent = diffDays === 1 ? prev.current + 1 : 1;
  }
  const nextBest = Math.max(prev.best, nextCurrent);
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO user_action_streaks (user_id, org_id, current_streak, best_streak, last_completion_date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, org_id) DO UPDATE SET
      current_streak = excluded.current_streak,
      best_streak = excluded.best_streak,
      last_completion_date = excluded.last_completion_date,
      updated_at = excluded.updated_at
  `).run(userId, orgId, nextCurrent, nextBest, today, nowIso);

  return { current: nextCurrent, best: nextBest, lastCompletionDate: today };
}

/**
 * POST /api/internal/actions
 * Mirrors routes/actions.js POST /orgs/:orgId/actions.
 */
router.post('/actions', (req, res) => {
  const db = req.db || getDb();
  const {
    org_id, user_id, title, description, priority, category,
    due_date, scope_id, source, source_agent
  } = req.body || {};

  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });

  const membership = activeMembership(db, org_id, user_id);
  if (!membership) return res.status(403).json({ error: 'not_org_member', message: 'User is not an active member of this organization' });

  if (priority && !VALID_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
  }
  if (source && !VALID_SOURCES.includes(source)) {
    return res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
  }
  if (scope_id) {
    const scope = db.prepare('SELECT id FROM scopes WHERE id = ? AND org_id = ?').get(scope_id, org_id);
    if (!scope) return res.status(400).json({ error: 'Invalid scope_id for this organization' });
  }

  try {
    const id = ulid();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO action_items (
        id, org_id, scope_id, created_by, assigned_to,
        title, description, priority, category, status,
        due_date, source, source_agent, tags, notes,
        completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, org_id, scope_id || null, user_id, null,
      title.trim(), (description || '').trim(), priority || 'medium',
      (category || '').trim(), 'todo',
      due_date || null, source || 'ai', source_agent || null,
      '[]', '',
      null, now, now
    );

    const item = db.prepare('SELECT * FROM action_items WHERE id = ?').get(id);

    createAuditEvent({
      orgId: org_id, actorType: 'user', actorId: user_id,
      action: 'action_item.create', targetType: 'action_item', targetId: id,
      scopeId: scope_id || null,
      metadata: { title: title.trim(), source: source || 'ai' }
    });

    return res.status(201).json({ success: true, item: { ...item, tags: safeJsonParse(item.tags, []) } });
  } catch (err) {
    console.error('[internal-actions] create failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

/**
 * PATCH /api/internal/actions/:id
 * Mirrors routes/actions.js PATCH /orgs/:orgId/actions/:id (title, description,
 * priority, category, status, due_date — the fields actionToolHandlers.js
 * actually sends via action_move/action_update).
 */
router.patch('/actions/:id', (req, res) => {
  const db = req.db || getDb();
  const { id } = req.params;
  const { org_id, user_id, ...body } = req.body || {};

  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const membership = activeMembership(db, org_id, user_id);
  if (!membership) return res.status(403).json({ error: 'not_org_member', message: 'User is not an active member of this organization' });
  const isAdmin = membership.role === 'owner' || membership.role === 'admin';

  try {
    const item = db.prepare('SELECT * FROM action_items WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(id, org_id);
    if (!item) return res.status(404).json({ error: 'Action item not found' });

    if (!isAdmin && item.created_by !== user_id && item.assigned_to !== user_id) {
      return res.status(403).json({ error: 'You can only update your own or assigned action items' });
    }

    const allowedFields = ['title', 'description', 'priority', 'category', 'status', 'due_date'];
    const updates = {};
    const changedFields = [];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        const value = body[field];
        if (field === 'status' && !VALID_STATUSES.includes(value)) {
          return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
        }
        if (field === 'priority' && value && !VALID_PRIORITIES.includes(value)) {
          return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
        }
        updates[field] = value;
        changedFields.push(field);
      }
    }

    if (changedFields.length === 0) {
      return res.json({ success: true, item: { ...item, tags: safeJsonParse(item.tags, []) }, message: 'No changes made' });
    }

    const now = new Date().toISOString();
    const flippedToDone = updates.status === 'done' && item.status !== 'done';
    if (flippedToDone) {
      updates.completed_at = now;
    } else if (updates.status && updates.status !== 'done' && item.status === 'done') {
      updates.completed_at = null;
    }
    updates.updated_at = now;

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`);
    const setValues = Object.values(updates);
    db.prepare(`UPDATE action_items SET ${setClauses.join(', ')} WHERE id = ? AND org_id = ?`).run(...setValues, id, org_id);

    const updated = db.prepare('SELECT * FROM action_items WHERE id = ?').get(id);

    let streak = null;
    if (flippedToDone) {
      streak = bumpStreak(db, user_id, org_id);
    }

    createAuditEvent({
      orgId: org_id, actorType: 'user', actorId: user_id,
      action: 'action_item.update', targetType: 'action_item', targetId: id,
      metadata: { changedFields }
    });

    return res.json({
      success: true,
      item: { ...updated, tags: safeJsonParse(updated.tags, []) },
      changedFields,
      ...(streak ? { streak } : {})
    });
  } catch (err) {
    console.error('[internal-actions] update failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

/**
 * DELETE /api/internal/actions/:id
 * Mirrors routes/actions.js DELETE /orgs/:orgId/actions/:id (soft delete).
 */
router.delete('/actions/:id', (req, res) => {
  const db = req.db || getDb();
  const { id } = req.params;
  const { org_id, user_id } = req.body || {};

  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const membership = activeMembership(db, org_id, user_id);
  if (!membership) return res.status(403).json({ error: 'not_org_member', message: 'User is not an active member of this organization' });
  const isAdmin = membership.role === 'owner' || membership.role === 'admin';

  try {
    const item = db.prepare('SELECT * FROM action_items WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(id, org_id);
    if (!item) return res.status(404).json({ error: 'Action item not found' });

    if (!isAdmin && item.created_by !== user_id) {
      return res.status(403).json({ error: 'You can only delete your own action items' });
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE action_items SET deleted_at = ? WHERE id = ? AND org_id = ?').run(now, id, org_id);

    createAuditEvent({
      orgId: org_id, actorType: 'user', actorId: user_id,
      action: 'action_item.delete', targetType: 'action_item', targetId: id,
      metadata: { title: item.title }
    });

    return res.json({ success: true, deleted: true, title: item.title });
  } catch (err) {
    console.error('[internal-actions] delete failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
});

export default router;
