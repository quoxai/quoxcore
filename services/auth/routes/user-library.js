/**
 * STUDY-REV-2 / P5.D — User Workflow Library Routes
 *
 * Per-org/per-user saved workflow entries ("My Library").
 *
 * Endpoints:
 *   POST   /api/orgs/:orgId/user-library         → save entry (author from JWT)
 *   GET    /api/orgs/:orgId/user-library          → list caller's entries, ordered by updated_at DESC
 *   GET    /api/orgs/:orgId/user-library?source=X → filter by source ('curated'|'n8n-imported'|'mine')
 *   DELETE /api/orgs/:orgId/user-library/:id      → remove entry (404 if not found or wrong owner)
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { ulid } from '../utils/helpers.js';

const router = Router();

router.use(requireAuth);

/** Use injected req.db (tests) or singleton getDb() (production). */
function dbFor(req) { return req.db || getDb(); }

// Valid source values
const VALID_SOURCES = ['curated', 'n8n-imported', 'mine'];

// ── POST /orgs/:orgId/user-library ────────────────────────────────────────────

/**
 * Save a workflow entry to the user's library.
 *
 * Body: { name, description?, definition_json, source?, source_workflow_id?, tags? }
 * Responds: 201 { entry } on success, 400 if name missing, 409 if duplicate name.
 */
router.post('/orgs/:orgId/user-library', requireOrgMembership, (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.id;
    const { name, description, definition_json, source, source_workflow_id, tags } = req.body || {};

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({
            error: 'name_required',
            message: 'name is required and must not be empty',
        });
    }

    if (!definition_json) {
        return res.status(400).json({
            error: 'definition_json_required',
            message: 'definition_json is required',
        });
    }

    const sourceValue = source && VALID_SOURCES.includes(source) ? source : 'mine';
    const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]');
    const definitionStr = typeof definition_json === 'string'
        ? definition_json
        : JSON.stringify(definition_json);

    const id = ulid();

    try {
        const db = dbFor(req);
        db.prepare(`
            INSERT INTO user_workflow_library
                (id, org_id, user_id, name, description, definition_json, source, source_workflow_id, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, orgId, userId,
            name.trim(),
            description || null,
            definitionStr,
            sourceValue,
            source_workflow_id || null,
            tagsJson,
        );

        const entry = db.prepare(
            `SELECT * FROM user_workflow_library WHERE id = ?`
        ).get(id);

        return res.status(201).json({ entry });
    } catch (err) {
        if (err.message && /UNIQUE constraint failed/.test(err.message)) {
            return res.status(409).json({
                error: 'duplicate_name',
                message: `A saved workflow named "${name.trim()}" already exists in your library`,
            });
        }
        console.error('[user-library] POST error:', err);
        return res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// ── GET /orgs/:orgId/user-library ─────────────────────────────────────────────

/**
 * List the calling user's saved workflow library entries.
 *
 * Query params:
 *   source   'curated' | 'n8n-imported' | 'mine'  — filter by source
 *
 * Always scoped to the calling user (user_id = req.user.id).
 * Another user in the same org cannot see these entries.
 *
 * Responds: { entries: [...] } ordered by updated_at DESC.
 */
router.get('/orgs/:orgId/user-library', requireOrgMembership, (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.id;
    const sourceFilter = req.query.source;

    try {
        const db = dbFor(req);

        let sql = `
            SELECT * FROM user_workflow_library
            WHERE org_id = ? AND user_id = ?
        `;
        const params = [orgId, userId];

        if (sourceFilter && VALID_SOURCES.includes(sourceFilter)) {
            sql += ` AND source = ?`;
            params.push(sourceFilter);
        }

        sql += ` ORDER BY updated_at DESC`;

        const entries = db.prepare(sql).all(...params);
        return res.json({ entries });
    } catch (err) {
        console.error('[user-library] GET error:', err);
        return res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// ── DELETE /orgs/:orgId/user-library/:id ─────────────────────────────────────

/**
 * Remove a saved workflow library entry.
 *
 * Returns 404 if:
 *   - The entry does not exist
 *   - The entry belongs to a different user (ownership check via user_id)
 *
 * Responds: { ok: true } on success.
 */
router.delete('/orgs/:orgId/user-library/:id', requireOrgMembership, (req, res) => {
    const { orgId, id } = req.params;
    const userId = req.user.id;

    try {
        const db = dbFor(req);

        // Fetch first to check existence and ownership
        const entry = db.prepare(
            `SELECT id, user_id FROM user_workflow_library WHERE id = ? AND org_id = ?`
        ).get(id, orgId);

        if (!entry) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Library entry not found',
            });
        }

        // Ownership check — user can only delete their own entries
        if (entry.user_id !== userId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Library entry not found',
            });
        }

        db.prepare(
            `DELETE FROM user_workflow_library WHERE id = ? AND user_id = ?`
        ).run(id, userId);

        return res.json({ ok: true });
    } catch (err) {
        console.error('[user-library] DELETE error:', err);
        return res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

export default router;
