/**
 * Action Item Routes for Quox Auth Service
 * Scoped Action Tracker — org-scoped CRUD with role-based visibility
 *
 * Follows the inbox route pattern: authenticate → requireOrgMembership → handler
 */

import { Router } from 'express';
import { prepare, getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { ulid, createAuditEvent, getPagination, formatPaginatedResponse } from '../utils/helpers.js';

const router = Router();

// Valid values for validation
const VALID_STATUSES = ['todo', 'doing', 'done'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_SOURCES = ['user', 'ai', 'workflow'];
// ACTIONQ-FIX-SPEC 1a — explicit visibility. 'private' = creator + explicit
// assignee only, no admin override; 'org' = all active members; 'scope' =
// the pre-existing creator/assignee/admin/visible-scope behavior.
const VALID_VISIBILITIES = ['private', 'org', 'scope'];

// Cap the number of items a /sync call can submit to prevent DoS via mass-import.
const MAX_SYNC_ITEMS = 500;

// ========================================================================
// Streak helpers (ACT-STREAK)
// ========================================================================

/** Today's date as YYYY-MM-DD (UTC) — matches the localStorage convention. */
function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Read the current streak row for (user, org). Returns a defaulted object
 * even when no row exists yet, so callers don't need to null-check.
 */
function getStreak(userId, orgId) {
    const row = getDb().prepare(`
        SELECT current_streak AS current, best_streak AS best,
               last_completion_date AS lastCompletionDate
        FROM user_action_streaks
        WHERE user_id = ? AND org_id = ?
    `).get(userId, orgId);
    return row || { current: 0, best: 0, lastCompletionDate: null };
}

/**
 * Bump the streak when a user marks any action 'done' for (user, org).
 * Idempotent within a single calendar day. Returns the updated streak.
 *
 *   first ever completion       → current=1, best=max(1, best)
 *   same day repeat completion  → no change
 *   next-day completion         → current+=1, best=max
 *   gap >1 day                  → current=1, best unchanged
 */
function bumpStreak(userId, orgId) {
    const db = getDb();
    const today = todayUtc();
    const prev = getStreak(userId, orgId);

    let nextCurrent = 1;
    if (prev.lastCompletionDate === today) {
        nextCurrent = prev.current; // already counted today
    } else if (prev.lastCompletionDate) {
        const last = new Date(prev.lastCompletionDate + 'T00:00:00Z');
        const now = new Date(today + 'T00:00:00Z');
        const diffDays = Math.round((now - last) / 86400000);
        nextCurrent = diffDays === 1 ? prev.current + 1 : 1;
    }
    const nextBest = Math.max(prev.best, nextCurrent);
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO user_action_streaks
            (user_id, org_id, current_streak, best_streak, last_completion_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, org_id) DO UPDATE SET
            current_streak = excluded.current_streak,
            best_streak = excluded.best_streak,
            last_completion_date = excluded.last_completion_date,
            updated_at = excluded.updated_at
    `).run(userId, orgId, nextCurrent, nextBest, today, now);

    return { current: nextCurrent, best: nextBest, lastCompletionDate: today };
}

// ========================================================================
// Helpers
// ========================================================================

/**
 * Get scope paths for a user's team memberships in an org.
 * Returns all scope paths the user belongs to (for visibility filtering).
 */
function getUserScopePaths(orgId, userId) {
    const db = getDb();

    // Find teams the user belongs to
    const memberships = db.prepare(`
        SELECT t.id AS team_id, t.attach_scope_id
        FROM team_memberships tm
        JOIN teams t ON tm.team_id = t.id
        WHERE t.org_id = ? AND tm.user_id = ? AND tm.status = 'active'
    `).all(orgId, userId);

    if (memberships.length === 0) return [];

    // Get scope paths for each team's attached scope
    const scopeIds = memberships
        .map(m => m.attach_scope_id)
        .filter(Boolean);

    if (scopeIds.length === 0) return [];

    const placeholders = scopeIds.map(() => '?').join(',');
    const scopes = db.prepare(`
        SELECT id, path FROM scopes WHERE id IN (${placeholders})
    `).all(...scopeIds);

    return scopes;
}

/**
 * Get all scope IDs visible to a user based on their scope paths.
 * A user at /org/X/div/A/dept/B/team/C can see scopes that are
 * ancestors or descendants of their position.
 */
function getVisibleScopeIds(orgId, userScopes) {
    if (userScopes.length === 0) return [];

    const db = getDb();
    const visibleIds = new Set();

    for (const scope of userScopes) {
        // Add the scope itself
        visibleIds.add(scope.id);

        // Find ancestors (parent scopes up the tree)
        // e.g., if user is at /org/X/div/A/dept/B/team/C,
        // they can see items scoped to /org/X/div/A/dept/B and /org/X/div/A
        const pathParts = scope.path.split('/').filter(Boolean);
        let currentPath = '';
        for (let i = 0; i < pathParts.length; i++) {
            currentPath += '/' + pathParts[i];
            // Look up scope with this path prefix (at each level boundary)
            if (i % 2 === 1) { // scope type + id pairs
                const ancestor = db.prepare(`
                    SELECT id FROM scopes WHERE org_id = ? AND path = ?
                `).get(orgId, currentPath);
                if (ancestor) visibleIds.add(ancestor.id);
            }
        }

        // Find descendants (child scopes under this path)
        const descendants = db.prepare(`
            SELECT id FROM scopes WHERE org_id = ? AND path LIKE ?
        `).all(orgId, scope.path + '/%');
        for (const d of descendants) visibleIds.add(d.id);
    }

    return [...visibleIds];
}

/**
 * ACTIONQ-FIX-SPEC 1a — the ONE shared read-authorization predicate. Every
 * site that lists, counts, or looks up an action item for read OR as a
 * precondition to a write must use this, so visibility can never drift
 * between endpoints (the root cause of the original null-scope/public-list
 * vs /sync mismatch).
 *
 * `private` tasks are visible to creator/assignee only — administrators get
 * NO override, by design (spec: "no administrator read override").
 * `org` tasks are visible to every active member. `scope` tasks keep the
 * pre-existing creator/assignee/admin/visible-scope behavior.
 *
 * Returns { sql, params } — `sql` is a boolean expression (no leading AND),
 * `params` must be bound in order before any additional filter params.
 */
function buildVisibilityPredicate({ orgId, userId, isAdmin, visibleScopeIds }) {
    const scopeIds = visibleScopeIds || [];
    const scopeClause = isAdmin
        ? '1'
        : (scopeIds.length > 0 ? `ai.scope_id IN (${scopeIds.map(() => '?').join(',')})` : '0');

    const sql = `(
        ai.org_id = ?
        AND ai.deleted_at IS NULL
        AND (
            ai.created_by = ?
            OR ai.assigned_to = ?
            OR ai.visibility = 'org'
            OR (ai.visibility = 'scope' AND (${scopeClause}))
        )
    )`;

    const params = [orgId, userId, userId];
    if (!isAdmin) params.push(...scopeIds);

    return { sql, params };
}

/** Convenience: resolve the visible-scope-id set for a non-admin user. */
function resolveVisibleScopeIds(orgId, userId, isAdmin) {
    if (isAdmin) return [];
    const userScopes = getUserScopePaths(orgId, userId);
    return getVisibleScopeIds(orgId, userScopes);
}

/**
 * Validate a proposed (visibility, scope_id) pair for create/update/sync.
 * Returns null when valid, or an error payload to send as a 400.
 */
function validateVisibilityScope(orgId, { visibility, scopeId }) {
    if (visibility !== undefined && !VALID_VISIBILITIES.includes(visibility)) {
        return { error: 'invalid_visibility_scope' };
    }
    const effectiveVisibility = visibility || (scopeId ? 'scope' : 'private');

    if ((effectiveVisibility === 'private' || effectiveVisibility === 'org') && scopeId) {
        return { error: 'invalid_visibility_scope' };
    }
    if (effectiveVisibility === 'scope') {
        if (!scopeId) return { error: 'invalid_visibility_scope' };
        const scope = getDb().prepare('SELECT id FROM scopes WHERE id = ? AND org_id = ?').get(scopeId, orgId);
        if (!scope) return { error: 'invalid_visibility_scope' };
    }
    return null;
}

// ACTIONQ-FIX-SPEC 1e — shared tags/order validation, used by public and
// internal POST/PATCH and by /sync.
const MAX_TAGS = 20;
const MAX_TAG_CODEPOINTS = 64;
const MAX_ORDER = 2147483647;

/** True if `s` contains any C0 control character or DEL — rejected in tags. */
function hasControlChar(s) {
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

/**
 * Normalize + validate a proposed tags array. Returns { tags } on success or
 * { error: 'invalid_tags' } on failure — never silently drops bad values.
 */
function validateAndNormalizeTags(rawTags) {
    if (rawTags === undefined) return { tags: undefined }; // omitted — caller decides default/unchanged
    if (!Array.isArray(rawTags) || rawTags.length > MAX_TAGS) {
        return { error: 'invalid_tags' };
    }
    const seen = new Set();
    const normalized = [];
    for (const raw of rawTags) {
        if (typeof raw !== 'string') return { error: 'invalid_tags' };
        const tag = raw.normalize('NFC').trim().toLowerCase();
        const codepoints = Array.from(tag).length;
        if (codepoints < 1 || codepoints > MAX_TAG_CODEPOINTS) return { error: 'invalid_tags' };
        if (hasControlChar(tag)) return { error: 'invalid_tags' };
        if (!seen.has(tag)) {
            seen.add(tag);
            normalized.push(tag);
        }
    }
    return { tags: normalized };
}

/** Validate a proposed `order` value. Returns {order} or {error:'invalid_order'}. */
function validateOrder(rawOrder) {
    if (rawOrder === undefined) return { order: undefined };
    if (!Number.isInteger(rawOrder) || rawOrder < 0 || rawOrder > MAX_ORDER) {
        return { error: 'invalid_order' };
    }
    return { order: rawOrder };
}

// ========================================================================
// Routes — all under /orgs/:orgId/actions
// ========================================================================

/**
 * GET /orgs/:orgId/actions
 * List action items with role-based visibility filtering.
 */
router.get('/orgs/:orgId/actions', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const role = req.orgMembership.role;
        const { status, scope_id, assigned_to, source, include_archived } = req.query;
        const { limit, offset, page } = getPagination(req.query, 20, 100);

        const db = getDb();
        const isAdmin = role === 'owner' || role === 'admin';
        const visibleScopeIds = resolveVisibleScopeIds(orgId, userId, isAdmin);
        const predicate = buildVisibilityPredicate({ orgId, userId, isAdmin, visibleScopeIds });

        let conditions = [predicate.sql];
        let params = [...predicate.params];

        // Status filter
        if (status && status !== 'all') {
            if (VALID_STATUSES.includes(status)) {
                conditions.push('ai.status = ?');
                params.push(status);
            }
        }

        // Scope filter
        if (scope_id) {
            // Include the scope and its children (path prefix match)
            const targetScope = db.prepare('SELECT path FROM scopes WHERE id = ? AND org_id = ?').get(scope_id, orgId);
            if (targetScope) {
                conditions.push('(ai.scope_id = ? OR ai.scope_id IN (SELECT id FROM scopes WHERE org_id = ? AND path LIKE ?))');
                params.push(scope_id, orgId, targetScope.path + '/%');
            } else {
                conditions.push('ai.scope_id = ?');
                params.push(scope_id);
            }
        }

        // Assigned to filter
        if (assigned_to === 'me') {
            conditions.push('ai.assigned_to = ?');
            params.push(userId);
        }

        // Source filter
        if (source && VALID_SOURCES.includes(source)) {
            conditions.push('ai.source = ?');
            params.push(source);
        }

        // Archive filter
        if (include_archived !== 'true') {
            conditions.push('ai.archived_at IS NULL');
        }

        const where = conditions.join(' AND ');

        // Count total
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM action_items ai WHERE ${where}`).get(...params);
        const total = countRow.total;

        // Fetch items with scope name
        const items = db.prepare(`
            SELECT ai.*, s.name_cache AS scope_name, s.path AS scope_path
            FROM action_items ai
            LEFT JOIN scopes s ON s.id = ai.scope_id AND s.org_id = ai.org_id
            WHERE ${where}
            ORDER BY ai.created_at DESC, ai.id DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        // Parse JSON fields
        const mapped = items.map(item => ({
            ...item,
            tags: safeJsonParse(item.tags, []),
        }));

        res.json(formatPaginatedResponse(mapped, total, { limit, offset, page }));
    } catch (error) {
        console.error('[Actions] Error listing actions:', error);
        res.status(500).json({ error: 'Failed to list action items' });
    }
});

/**
 * POST /orgs/:orgId/actions
 * Create a new action item.
 */
router.post('/orgs/:orgId/actions', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const {
            title, description, priority, category, status,
            due_date, scope_id, assigned_to,
            source, source_agent, tags, notes, visibility, order
        } = req.body;

        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }

        if (priority && !VALID_PRIORITIES.includes(priority)) {
            return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
        }

        if (status && !VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
        }

        if (source && !VALID_SOURCES.includes(source)) {
            return res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
        }

        // ACTIONQ-FIX-SPEC 1e: tags/order validated and normalized here —
        // bad values are rejected (400), never silently dropped. Omitted
        // POST tags -> []; omitted POST order -> 0.
        const tagsResult = validateAndNormalizeTags(tags);
        if (tagsResult.error) return res.status(400).json({ error: tagsResult.error });
        const normalizedTags = tagsResult.tags ?? [];

        const orderResult = validateOrder(order);
        if (orderResult.error) return res.status(400).json({ error: orderResult.error });
        const normalizedOrder = orderResult.order ?? 0;

        // ACTIONQ-FIX-SPEC 1a: visibility/scope must agree — new unscoped
        // tasks default to private; a scope with omitted visibility defaults
        // to 'scope'. Validated BEFORE the FK-level scope_id check below so
        // the error is the documented invalid_visibility_scope, not a
        // generic scope message.
        const visibilityError = validateVisibilityScope(orgId, { visibility, scopeId: scope_id });
        if (visibilityError) {
            return res.status(400).json(visibilityError);
        }
        const effectiveVisibility = visibility || (scope_id ? 'scope' : 'private');

        // Validate assigned_to is an active, unexpired org member
        if (assigned_to) {
            const member = getDb().prepare(
                `SELECT user_id FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = 'active'
                 AND (expires_at IS NULL OR expires_at > datetime('now'))`
            ).get(orgId, assigned_to);
            if (!member) {
                return res.status(400).json({ error: 'Assigned user is not an active member of this organization' });
            }
        }

        const id = ulid();
        const now = new Date().toISOString();

        prepare(`
            INSERT INTO action_items (
                id, org_id, scope_id, created_by, assigned_to,
                title, description, priority, category, status,
                due_date, source, source_agent, tags, notes, visibility, "order",
                completed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, orgId, scope_id || null, userId, assigned_to || null,
            title.trim(), (description || '').trim(), priority || 'medium',
            (category || '').trim(), status || 'todo',
            due_date || null, source || 'user', source_agent || null,
            JSON.stringify(normalizedTags), (notes || '').trim(), effectiveVisibility, normalizedOrder,
            status === 'done' ? now : null,
            now, now
        );

        const item = getDb().prepare('SELECT * FROM action_items WHERE id = ?').get(id);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'action_item.create',
            targetType: 'action_item',
            targetId: id,
            scopeId: scope_id || null,
            metadata: { title: title.trim(), source: source || 'user' }
        });

        res.status(201).json({
            success: true,
            item: { ...item, tags: safeJsonParse(item.tags, []) }
        });
    } catch (error) {
        console.error('[Actions] Error creating action:', error);
        res.status(500).json({ error: 'Failed to create action item' });
    }
});

/**
 * GET /orgs/:orgId/streak
 * Return the current+best completion streak for the requesting user in
 * this org. ACT-STREAK migration target — replaces localStorage streak.
 */
router.get('/orgs/:orgId/streak', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        res.json({ success: true, streak: getStreak(userId, orgId) });
    } catch (error) {
        console.error('[Actions] Error fetching streak:', error);
        res.status(500).json({ error: 'Failed to fetch streak' });
    }
});

/**
 * GET /orgs/:orgId/actions/:id
 * Fetch a single action item by ID. Same visibility rules as the list endpoint.
 */
router.get('/orgs/:orgId/actions/:id', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        const userId = req.user.id;
        const role = req.orgMembership.role;
        const isAdmin = role === 'owner' || role === 'admin';
        const visibleScopeIds = resolveVisibleScopeIds(orgId, userId, isAdmin);
        const predicate = buildVisibilityPredicate({ orgId, userId, isAdmin, visibleScopeIds });

        const item = getDb().prepare(`
            SELECT ai.*, s.name_cache AS scope_name, s.path AS scope_path
            FROM action_items ai
            LEFT JOIN scopes s ON s.id = ai.scope_id AND s.org_id = ai.org_id
            WHERE ai.id = ? AND ${predicate.sql}
        `).get(id, ...predicate.params);

        if (!item) {
            // 404 for both "doesn't exist" and "not visible to you" — never
            // leak existence of a hidden/private item.
            return res.status(404).json({ error: 'Action item not found' });
        }

        res.json({
            success: true,
            item: { ...item, tags: safeJsonParse(item.tags, []) }
        });
    } catch (error) {
        console.error('[Actions] Error fetching action:', error);
        res.status(500).json({ error: 'Failed to fetch action item' });
    }
});

/**
 * PATCH /orgs/:orgId/actions/:id
 * Update an action item. Creator, assignee, or admin can update.
 */
router.patch('/orgs/:orgId/actions/:id', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        const userId = req.user.id;
        const role = req.orgMembership.role;
        const isAdmin = role === 'owner' || role === 'admin';

        // ACTIONQ-FIX-SPEC 1a: require a READABLE row first — visible-but-
        // forbidden is 403, invisible/missing is 404 either way.
        const visibleScopeIds = resolveVisibleScopeIds(orgId, userId, isAdmin);
        const predicate = buildVisibilityPredicate({ orgId, userId, isAdmin, visibleScopeIds });
        const item = getDb().prepare(
            `SELECT * FROM action_items ai WHERE ai.id = ? AND ${predicate.sql}`
        ).get(id, ...predicate.params);

        if (!item) {
            return res.status(404).json({ error: 'Action item not found' });
        }

        // Permission: creator, assignee, or admin may update ordinary fields.
        if (!isAdmin && item.created_by !== userId && item.assigned_to !== userId) {
            return res.status(403).json({ error: 'You can only update your own or assigned action items' });
        }

        const allowedFields = [
            'title', 'description', 'priority', 'category', 'status',
            'due_date', 'scope_id', 'assigned_to', 'tags', 'notes', 'archived_at', 'visibility', 'order'
        ];
        // Sharing changes — visibility, scope, assignment — require creator
        // or admin. An assignee (who may otherwise update status/notes/etc.)
        // cannot silently broaden sharing (NEW-1).
        const sharingFields = new Set(['visibility', 'scope_id', 'assigned_to']);
        const isSharingAuthority = isAdmin || item.created_by === userId;

        const updates = {};
        const changedFields = [];

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                let value = req.body[field];

                if (sharingFields.has(field) && !isSharingAuthority) {
                    return res.status(403).json({ error: 'Only the creator or an administrator can change sharing (visibility, scope, or assignment)' });
                }

                // Validate specific fields
                if (field === 'status' && !VALID_STATUSES.includes(value)) {
                    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
                }
                if (field === 'priority' && value && !VALID_PRIORITIES.includes(value)) {
                    return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
                }
                // ACTIONQ-FIX-SPEC 1e: PATCH `[]` clears tags; omitted (handled
                // above by the `!== undefined` guard) leaves them unchanged.
                // Bad values are rejected (400), never silently dropped.
                if (field === 'tags') {
                    const tagsResult = validateAndNormalizeTags(value);
                    if (tagsResult.error) return res.status(400).json({ error: tagsResult.error });
                    value = JSON.stringify(tagsResult.tags);
                }
                if (field === 'order') {
                    const orderResult = validateOrder(value);
                    if (orderResult.error) return res.status(400).json({ error: orderResult.error });
                    value = orderResult.order;
                }

                updates[field] = value;
                changedFields.push(field);
            }
        }

        // Validate scope_id belongs to this org (NEW-1: PATCH previously
        // accepted any globally-existing scope_id with no org check).
        if (updates.scope_id !== undefined && updates.scope_id !== null) {
            const scope = getDb().prepare('SELECT id FROM scopes WHERE id = ? AND org_id = ?').get(updates.scope_id, orgId);
            if (!scope) {
                return res.status(400).json({ error: 'invalid_visibility_scope' });
            }
        }
        // Validate assigned_to is an active, unexpired org member (NEW-1:
        // PATCH previously accepted any user id with no membership check).
        if (updates.assigned_to !== undefined && updates.assigned_to !== null) {
            const member = getDb().prepare(
                `SELECT user_id FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = 'active'
                 AND (expires_at IS NULL OR expires_at > datetime('now'))`
            ).get(orgId, updates.assigned_to);
            if (!member) {
                return res.status(400).json({ error: 'Assigned user is not an active member of this organization' });
            }
        }
        // Validate the resulting (visibility, scope_id) pair is consistent —
        // whichever of the two is actually changing, checked against the
        // other's post-update value.
        if (updates.visibility !== undefined || updates.scope_id !== undefined) {
            const nextScopeId = updates.scope_id !== undefined ? updates.scope_id : item.scope_id;
            const nextVisibility = updates.visibility !== undefined ? updates.visibility : item.visibility;
            const visibilityError = validateVisibilityScope(orgId, { visibility: nextVisibility, scopeId: nextScopeId });
            if (visibilityError) {
                return res.status(400).json(visibilityError);
            }
        }

        if (changedFields.length === 0) {
            return res.json({ success: true, item: { ...item, tags: safeJsonParse(item.tags, []) }, message: 'No changes made' });
        }

        // Handle status change side-effects
        const now = new Date().toISOString();
        const flippedToDone = updates.status === 'done' && item.status !== 'done';
        if (flippedToDone) {
            updates.completed_at = now;
        } else if (updates.status && updates.status !== 'done' && item.status === 'done') {
            updates.completed_at = null;
        }
        updates.updated_at = now;

        // Build SET clause
        // ACTIONQ-FIX-SPEC 1e: "order" is a SQL reserved word — quote it.
        // Appending it to this dynamic SET construction unquoted would be
        // invalid SQL ("near ORDER: syntax error").
        const setClauses = Object.keys(updates).map(k => (k === 'order' ? `"order" = ?` : `${k} = ?`));
        const setValues = Object.values(updates);

        // ACTIONQ-FIX-SPEC 1c (NEW-6): the item write and the streak bump run
        // in ONE transaction. A streak failure must roll back the completion
        // too — a prior sequential version could commit "done" and then
        // 500 on the streak write, leaving a completed item with no streak
        // credit, with no way for a retry to repair it (repeating 'done'
        // would see an already-done item and skip the bump entirely).
        let updated, streak = null;
        const db = getDb();
        db.transaction(() => {
            db.prepare(`
                UPDATE action_items SET ${setClauses.join(', ')} WHERE id = ? AND org_id = ?
            `).run(...setValues, id, orgId);

            updated = db.prepare('SELECT * FROM action_items WHERE id = ?').get(id);

            // ACT-STREAK: bump streak when ANYONE completing an item — both the
            // creator (most common case) AND any assignee. We attribute to
            // whoever marked it done (the requesting user).
            if (flippedToDone) {
                streak = bumpStreak(userId, orgId);
            }
        })();

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'action_item.update',
            targetType: 'action_item',
            targetId: id,
            metadata: { changedFields }
        });

        res.json({
            success: true,
            item: { ...updated, tags: safeJsonParse(updated.tags, []) },
            changedFields,
            ...(streak ? { streak } : {})
        });
    } catch (error) {
        console.error('[Actions] Error updating action:', error);
        res.status(500).json({ error: 'Failed to update action item' });
    }
});

/**
 * DELETE /orgs/:orgId/actions/:id
 * Soft-delete an action item. Creator or admin only.
 */
router.delete('/orgs/:orgId/actions/:id', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        const userId = req.user.id;
        const role = req.orgMembership.role;
        const isAdmin = role === 'owner' || role === 'admin';

        // Require a readable row first — same predicate as every other site.
        const visibleScopeIds = resolveVisibleScopeIds(orgId, userId, isAdmin);
        const predicate = buildVisibilityPredicate({ orgId, userId, isAdmin, visibleScopeIds });
        const item = getDb().prepare(
            `SELECT * FROM action_items ai WHERE ai.id = ? AND ${predicate.sql}`
        ).get(id, ...predicate.params);

        if (!item) {
            return res.status(404).json({ error: 'Action item not found' });
        }

        // Permission: creator or admin
        if (!isAdmin && item.created_by !== userId) {
            return res.status(403).json({ error: 'You can only delete your own action items' });
        }

        const now = new Date().toISOString();
        getDb().prepare(
            'UPDATE action_items SET deleted_at = ? WHERE id = ? AND org_id = ?'
        ).run(now, id, orgId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'action_item.delete',
            targetType: 'action_item',
            targetId: id,
            metadata: { title: item.title }
        });

        res.json({ success: true, deleted: true, title: item.title });
    } catch (error) {
        console.error('[Actions] Error deleting action:', error);
        res.status(500).json({ error: 'Failed to delete action item' });
    }
});

/**
 * POST /orgs/:orgId/actions/sync
 * Merge browser localStorage items into auth DB.
 * Used for one-time migration from localStorage to server storage.
 */
router.post('/orgs/:orgId/actions/sync', requireAuth, requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const role = req.orgMembership.role;
        const isAdmin = role === 'owner' || role === 'admin';
        const { items: browserItems } = req.body;

        if (!Array.isArray(browserItems)) {
            return res.status(400).json({ error: 'Expected items array' });
        }

        if (browserItems.length > MAX_SYNC_ITEMS) {
            return res.status(413).json({
                error: `Too many items in one sync (max ${MAX_SYNC_ITEMS})`,
                received: browserItems.length
            });
        }

        const db = getDb();

        // Global id lookup (including tombstones) — the browser-supplied id is
        // a claim, never authority, but an EXISTING id must never be treated
        // as "new" (NEW-3: a cached colleague-created scoped task must not be
        // reborn as a requester-owned, scope-stripped duplicate).
        const idLookup = db.prepare('SELECT id, org_id, deleted_at FROM action_items WHERE id = ?');

        // Pass 1 — validate provenance and id-collisions for the WHOLE batch
        // before writing anything. Any violation rejects the entire sync
        // atomically rather than importing a partial, inconsistent result.
        const candidates = [];
        let skippedExisting = 0;

        for (const item of browserItems) {
            if (!item || typeof item.title !== 'string' || !item.title.trim()) continue;

            const claimedOrgId = item.org_id || item.orgId;
            if (claimedOrgId && claimedOrgId !== orgId) {
                return res.status(400).json({ success: false, error: 'invalid_import_provenance' });
            }
            const claimedCreatedBy = item.created_by || item.createdBy;
            if (claimedCreatedBy && claimedCreatedBy !== userId) {
                return res.status(400).json({ success: false, error: 'invalid_import_provenance' });
            }

            if (item.id) {
                const existing = idLookup.get(item.id);
                if (existing) {
                    if (existing.org_id !== orgId) {
                        // Claiming an id that belongs to (or was tombstoned in)
                        // another org — reject the whole batch; disclose nothing
                        // about the foreign row.
                        return res.status(409).json({ success: false, error: 'import_conflict' });
                    }
                    // Already present in this org (active or tombstoned) —
                    // never insert a duplicate, never overwrite it.
                    skippedExisting++;
                    continue;
                }
            }

            candidates.push(item);
        }

        // Pass 2 — insert the validated candidates. Legacy secondary safeguard:
        // dedupe by (org_id, created_by, title, created_at) for items that
        // never carried a client id (e.g. a previous sync already imported
        // them under a server-generated id).
        const dedupeStmt = db.prepare(`
            SELECT id FROM action_items
            WHERE org_id = ? AND created_by = ? AND title = ? AND created_at = ?
            LIMIT 1
        `);

        let imported = 0;
        const insertAll = db.transaction((rows) => {
            for (const item of rows) {
                const status = VALID_STATUSES.includes(item.status) ? item.status : 'todo';
                const priority = VALID_PRIORITIES.includes(item.priority) ? item.priority : 'medium';
                const source = VALID_SOURCES.includes(item.source) ? item.source : 'user';
                const createdAt = item.createdAt || item.created_at || new Date().toISOString();

                const existing = dedupeStmt.get(orgId, userId, item.title.trim(), createdAt);
                if (existing) { skippedExisting++; continue; }

                const id = ulid();
                const now = new Date().toISOString();

                try {
                    // ACTIONQ-FIX-SPEC 1b/1a: an imported legacy row is always
                    // private (creator-only) — /sync cannot know who was
                    // originally meant to see a browser-cache item, so it
                    // never guesses org-wide or scope sharing.
                    prepare(`
                        INSERT INTO action_items (
                            id, org_id, created_by, title, description, priority,
                            category, status, due_date, source, source_agent,
                            tags, notes, archived_at, completed_at, visibility,
                            created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        id, orgId, userId,
                        item.title.trim(), item.description || '', priority,
                        item.category || '', status,
                        item.dueDate || item.due_date || null,
                        source, item.sourceAgent || item.source_agent || null,
                        JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
                        item.notes || '',
                        item.archivedAt || item.archived_at || null,
                        item.completedAt || item.completed_at || null,
                        'private',
                        createdAt,
                        item.updatedAt || item.updated_at || now
                    );
                    imported++;
                } catch (insertErr) {
                    console.warn(`[Actions] Sync: failed to import item "${item.title}":`, insertErr.message);
                }
            }
        });
        insertAll(candidates);

        // Return the same authorized page the list endpoint would — the
        // shared predicate, not a hand-rolled parallel visibility rule.
        const visibleScopeIds = resolveVisibleScopeIds(orgId, userId, isAdmin);
        const predicate = buildVisibilityPredicate({ orgId, userId, isAdmin, visibleScopeIds });

        const allItems = db.prepare(
            `SELECT ai.* FROM action_items ai WHERE ${predicate.sql} ORDER BY ai.created_at DESC, ai.id DESC`
        ).all(...predicate.params);

        res.json({
            success: true,
            items: allItems.map(i => ({ ...i, tags: safeJsonParse(i.tags, []) })),
            imported,
            skipped: skippedExisting,
            lastSync: new Date().toISOString()
        });
    } catch (error) {
        console.error('[Actions] Sync error:', error);
        res.status(500).json({ error: 'Failed to sync action items' });
    }
});

// ========================================================================
// JSON helper
// ========================================================================

function safeJsonParse(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
}

export default router;
