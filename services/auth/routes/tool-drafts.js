/**
 * TOOLSMITH Slice B — Tool Draft Persistence
 *
 * Endpoints (mounted under /api/toolsmith):
 *   PUT  /drafts/:id   — upsert a draft (idempotent; creates or updates)
 *   GET  /drafts/:id   — fetch a draft (user-scoped; 404 if not found or belongs to another user)
 *
 * Auth: user JWT via requireAuth middleware (cookie-based). req.user is injected
 *       by requireAuth in production, or by the test harness in tests.
 * Multi-tenant: every row is scoped to user_id; cross-user access returns 404.
 *
 * The tool_drafts table is created on first access via the migration in db/index.js.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

/** Use injected req.db (tests) or singleton getDb() (production). */
function dbFor(req) { return req.db || getDb(); }

/**
 * Ensure the tool_drafts table exists (idempotent).
 * Called on each request so it auto-creates in both prod and tests.
 */
function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS tool_drafts (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            draft_files  TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tool_drafts_user ON tool_drafts(user_id);
    `);
}

// ── PUT /drafts/:id ───────────────────────────────────────────────────────────

/**
 * Upsert a draft. Body: { files: { [filename]: string } }
 * Creates the draft if it doesn't exist; updates draft_files if it does.
 * Always enforces user_id scoping — a user cannot overwrite another user's draft.
 */
router.put('/drafts/:id', (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'authentication_required' });
    }

    const db = dbFor(req);
    ensureSchema(db);

    const { id } = req.params;
    const { files } = req.body;

    if (!files || typeof files !== 'object' || Array.isArray(files)) {
        return res.status(400).json({ error: 'invalid_body', message: '`files` must be a key-value object' });
    }

    const userId = req.user.id;
    const filesJson = JSON.stringify(files);
    const now = new Date().toISOString();

    // Check if existing draft belongs to a different user
    const existing = db.prepare('SELECT user_id FROM tool_drafts WHERE id = ?').get(id);
    if (existing && existing.user_id !== userId) {
        return res.status(403).json({ error: 'forbidden', message: 'Draft belongs to another user' });
    }

    if (existing) {
        db.prepare(
            'UPDATE tool_drafts SET draft_files = ?, updated_at = ? WHERE id = ?'
        ).run(filesJson, now, id);
    } else {
        db.prepare(
            'INSERT INTO tool_drafts (id, user_id, draft_files, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(id, userId, filesJson, now, now);
    }

    const row = db.prepare('SELECT id, user_id, updated_at FROM tool_drafts WHERE id = ?').get(id);
    return res.json({ id: row.id, user_id: row.user_id, updated_at: row.updated_at });
});

// ── GET /drafts/:id ───────────────────────────────────────────────────────────

/**
 * Fetch a draft by ID. Returns 404 if not found or owned by a different user.
 */
router.get('/drafts/:id', (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'authentication_required' });
    }

    const db = dbFor(req);
    ensureSchema(db);

    const { id } = req.params;
    const userId = req.user.id;

    const row = db.prepare(
        'SELECT id, user_id, draft_files, created_at, updated_at FROM tool_drafts WHERE id = ? AND user_id = ?'
    ).get(id, userId);

    if (!row) {
        return res.status(404).json({ error: 'not_found', message: 'Draft not found' });
    }

    let files;
    try {
        files = JSON.parse(row.draft_files);
    } catch {
        files = {};
    }

    return res.json({
        id: row.id,
        user_id: row.user_id,
        files,
        created_at: row.created_at,
        updated_at: row.updated_at
    });
});

export default router;
