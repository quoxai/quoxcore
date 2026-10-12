/**
 * STUDY-REV-2 / P7.E.1 — User-owned Prompts Library
 *
 * Replaces the scraped third-party prompt corpus with a server-side, user-owned
 * prompts library. All prompts are stored in the auth-service SQLite DB with
 * full version history.
 *
 * Endpoints:
 *   POST   /api/prompts                         create
 *   GET    /api/prompts?org_id=&q=&tags=        list/search
 *   GET    /api/prompts/export?org_id=          export all caller's prompts
 *   POST   /api/prompts/import                  bulk import
 *   POST   /api/prompts/migrate                 drain localStorage backup
 *   GET    /api/prompts/:id?org_id=             fetch one
 *   PATCH  /api/prompts/:id                     update (bumps version)
 *   DELETE /api/prompts/:id                     soft-delete
 *   GET    /api/prompts/:id/versions?org_id=    version history
 *   POST   /api/prompts/:id/restore/:version    restore to old version
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Auth guard — all prompts routes require a logged-in user.
// req.user must be set by the caller (real: requireAuth middleware; tests: inline injection).
router.use((req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: 'authentication_required', message: 'Must be authenticated' });
    }
    next();
});

/** Use injected req.db (tests) or singleton getDb() (production). */
function dbFor(req) { return req.db || getDb(); }

/** Minimal ULID-compatible monotonic ID. */
function makeId() {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const now = Date.now();
    let id = '';
    let t = now;
    for (let i = 9; i >= 0; i--) {
        id = chars[t % 32] + id;
        t = Math.floor(t / 32);
    }
    for (let i = 0; i < 16; i++) {
        id += chars[Math.floor(Math.random() * 32)];
    }
    return id;
}

/** Current epoch in ms. */
function now() { return Date.now(); }

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify the calling user has access to the given org_id.
 * Returns true if user is a member of the org, false otherwise.
 */
function isMember(db, orgId, userId) {
    const row = db.prepare(
        `SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
    ).get(orgId, userId);
    return !!row;
}

/**
 * Get the next version number for a prompt.
 */
function nextVersion(db, promptId) {
    const row = db.prepare(
        `SELECT MAX(version) as max_v FROM prompt_versions WHERE prompt_id = ?`
    ).get(promptId);
    return (row?.max_v || 0) + 1;
}

/**
 * Write a version row for a prompt.
 */
function writeVersion(db, promptId, versionNo, body, name, description, userId) {
    db.prepare(
        `INSERT INTO prompt_versions (id, prompt_id, version, body, name, description, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(makeId(), promptId, versionNo, body || null, name || null, description || null, now(), userId || null);
}

// ── Collection endpoints ──────────────────────────────────────────────────────

/**
 * POST /api/prompts
 * Create a new prompt. Writes initial v1 in prompt_versions.
 *
 * Body: { name, body, org_id, description?, tags?, category?, visibility?, variables?, deploy_targets? }
 */
router.post('/prompts', (req, res) => {
    const { org_id, name, body, description, tags, category, visibility, variables, deploy_targets } = req.body || {};
    const userId = req.user.id;

    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'name_required', message: 'name is required' });
    }
    if (!body || typeof body !== 'string' || body.trim() === '') {
        return res.status(400).json({ error: 'body_required', message: 'body is required' });
    }
    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    const id = makeId();
    const ts = now();
    const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]');
    const variablesJson = Array.isArray(variables) ? JSON.stringify(variables) : (variables || '[]');
    const deployTargetsJson = Array.isArray(deploy_targets) ? JSON.stringify(deploy_targets) : (deploy_targets || '[]');
    const vis = ['private', 'org'].includes(visibility) ? visibility : 'private';

    try {
        db.prepare(
            `INSERT INTO prompts (id, org_id, user_id, name, description, body, tags, category, visibility, variables, deploy_targets, created_at, updated_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, org_id, userId, name.trim(), description || null, body, tagsJson, category || null, vis, variablesJson, deployTargetsJson, ts, ts, userId);

        // Write initial version
        writeVersion(db, id, 1, body, name.trim(), description, userId);

        const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
        return res.status(201).json({ prompt });
    } catch (err) {
        console.error('[prompts] POST error:', err);
        return res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

/**
 * GET /api/prompts?org_id=&q=&tags=
 * List prompts: caller's private + org-visible in the org. Excludes soft-deleted.
 * Supports ?q= (substring on name/body) and ?tags= (comma-separated tag filter, match any).
 */
router.get('/prompts', (req, res) => {
    const { org_id, q, tags } = req.query;
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id query param is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    let sql = `
        SELECT * FROM prompts
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND (user_id = ? OR visibility = 'org')
    `;
    const params = [org_id, userId];

    if (q && q.trim()) {
        sql += ` AND (name LIKE ? OR body LIKE ?)`;
        const like = `%${q.trim()}%`;
        params.push(like, like);
    }

    sql += ` ORDER BY updated_at DESC`;

    let prompts = db.prepare(sql).all(...params);

    // Tag filter (match any requested tag)
    if (tags && tags.trim()) {
        const requestedTags = tags.split(',').map(t => t.trim()).filter(Boolean);
        if (requestedTags.length > 0) {
            prompts = prompts.filter(p => {
                try {
                    const ptags = JSON.parse(p.tags || '[]');
                    return requestedTags.some(rt => ptags.includes(rt));
                } catch {
                    return false;
                }
            });
        }
    }

    return res.json({ prompts });
});

/**
 * GET /api/prompts/export?org_id=
 * Export all of the calling user's prompts (excluding soft-deleted) as JSON.
 * Note: this route MUST be declared before /:id to avoid path conflicts.
 */
router.get('/prompts/export', (req, res) => {
    const { org_id } = req.query;
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    const prompts = db.prepare(
        `SELECT * FROM prompts WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`
    ).all(org_id, userId);

    return res.json({ prompts, exportedAt: new Date().toISOString(), version: '2.0' });
});

/**
 * POST /api/prompts/import
 * Bulk-import prompts. Idempotent on (org_id, user_id, name) — returns 409 if ANY dup found.
 *
 * Body: { org_id, prompts: [{ name, body, ... }] }
 */
router.post('/prompts/import', (req, res) => {
    const { org_id, prompts } = req.body || {};
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }
    if (!Array.isArray(prompts)) {
        return res.status(400).json({ error: 'prompts_required', message: 'prompts must be an array' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    // Check for duplicates first
    for (const p of prompts) {
        if (!p.name) continue;
        const exists = db.prepare(
            `SELECT 1 FROM prompts WHERE org_id = ? AND user_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`
        ).get(org_id, userId, p.name.trim());
        if (exists) {
            return res.status(409).json({
                error: 'duplicate_name',
                message: `A prompt named "${p.name.trim()}" already exists`,
            });
        }
    }

    let imported = 0;
    const ts = now();

    const insertStmt = db.prepare(
        `INSERT INTO prompts (id, org_id, user_id, name, description, body, tags, category, visibility, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)`
    );

    for (const p of prompts) {
        if (!p.name || !p.body) continue;
        const id = makeId();
        const tagsJson = Array.isArray(p.tags) ? JSON.stringify(p.tags) : '[]';
        insertStmt.run(id, org_id, userId, p.name.trim(), p.description || null, p.body, tagsJson, p.category || null, ts, ts, userId);
        writeVersion(db, id, 1, p.body, p.name.trim(), p.description, userId);
        imported++;
    }

    return res.json({ imported });
});

/**
 * POST /api/prompts/migrate
 * Drain localStorage backup. Called once by P7.E.2 when the UI first loads.
 * Upserts customs, drafts (as prompts), history items.
 * Idempotent on (org_id, user_id, name) — skips existing names.
 *
 * Body: { org_id, customs: [...], drafts: [...], history: [...] }
 */
router.post('/prompts/migrate', (req, res) => {
    const { org_id, customs = [], drafts = [], history = [] } = req.body || {};
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    let imported = 0;
    const ts = now();

    // Helper: upsert one item (skip on dup name, idempotent)
    function tryInsert(name, bodyText, tagsArr, description) {
        if (!name || !bodyText) return;
        const exists = db.prepare(
            `SELECT 1 FROM prompts WHERE org_id = ? AND user_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`
        ).get(org_id, userId, name.trim());
        if (exists) return;

        const id = makeId();
        const tagsJson = Array.isArray(tagsArr) ? JSON.stringify(tagsArr) : '[]';
        db.prepare(
            `INSERT INTO prompts (id, org_id, user_id, name, description, body, tags, visibility, created_at, updated_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)`
        ).run(id, org_id, userId, name.trim(), description || null, bodyText, tagsJson, ts, ts, userId);
        writeVersion(db, id, 1, bodyText, name.trim(), description, userId);
        imported++;
    }

    // customs: [{ name, content, tags, description }]
    for (const c of customs) {
        tryInsert(c.name, c.content || c.body, c.tags, c.description);
    }

    // drafts: [{ name, content, tags, description }]
    for (const d of drafts) {
        tryInsert(d.name ? `[Draft] ${d.name}` : null, d.content || d.body, d.tags, d.description);
    }

    // history items: best-effort (skip if no name/content)
    for (const h of history) {
        tryInsert(h.name, h.content || h.body, h.tags, h.description);
    }

    return res.json({ imported });
});

// ── Item endpoints ────────────────────────────────────────────────────────────

/**
 * GET /api/prompts/:id?org_id=
 * Fetch a single prompt by ID. Returns 404 if not found or soft-deleted.
 */
router.get('/prompts/:id', (req, res) => {
    const { id } = req.params;
    const { org_id } = req.query;
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    const prompt = db.prepare(
        `SELECT * FROM prompts WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND (user_id = ? OR visibility = 'org')`
    ).get(id, org_id, userId);

    if (!prompt) {
        return res.status(404).json({ error: 'not_found', message: 'Prompt not found' });
    }

    return res.json({ prompt });
});

/**
 * PATCH /api/prompts/:id
 * Update name/body/description/tags/category/visibility. Bumps version.
 *
 * Body: { org_id, name?, body?, description?, tags?, category?, visibility? }
 */
router.patch('/prompts/:id', (req, res) => {
    const { id } = req.params;
    const { org_id, name, body, description, tags, category, visibility } = req.body || {};
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    const existing = db.prepare(
        `SELECT * FROM prompts WHERE id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`
    ).get(id, org_id, userId);

    if (!existing) {
        return res.status(404).json({ error: 'not_found', message: 'Prompt not found or not owned by caller' });
    }

    const newName    = name        !== undefined ? name.trim()       : existing.name;
    const newBody    = body        !== undefined ? body              : existing.body;
    const newDesc    = description !== undefined ? description       : existing.description;
    const newTags    = tags        !== undefined ? (Array.isArray(tags) ? JSON.stringify(tags) : tags) : existing.tags;
    const newCat     = category    !== undefined ? category          : existing.category;
    const newVis     = visibility  !== undefined && ['private', 'org'].includes(visibility) ? visibility : existing.visibility;
    const ts         = now();

    db.prepare(
        `UPDATE prompts SET name=?, body=?, description=?, tags=?, category=?, visibility=?, updated_at=? WHERE id=?`
    ).run(newName, newBody, newDesc, newTags, newCat, newVis, ts, id);

    // Write new version
    const vNo = nextVersion(db, id);
    writeVersion(db, id, vNo, newBody, newName, newDesc, userId);

    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    return res.json({ prompt });
});

/**
 * DELETE /api/prompts/:id
 * Soft-delete: sets deleted_at. Row remains in DB.
 *
 * Body: { org_id }
 */
router.delete('/prompts/:id', (req, res) => {
    const { id } = req.params;
    const { org_id } = req.body || req.query;
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    const existing = db.prepare(
        `SELECT 1 FROM prompts WHERE id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`
    ).get(id, org_id, userId);

    if (!existing) {
        return res.status(404).json({ error: 'not_found', message: 'Prompt not found' });
    }

    db.prepare(`UPDATE prompts SET deleted_at = ? WHERE id = ?`).run(now(), id);
    return res.json({ ok: true });
});

/**
 * GET /api/prompts/:id/versions?org_id=
 * Version history, newest-first, capped at 50.
 */
router.get('/prompts/:id/versions', (req, res) => {
    const { id } = req.params;
    const { org_id } = req.query;
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    // Caller must have access to the prompt (own or org-visible)
    const prompt = db.prepare(
        `SELECT 1 FROM prompts WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND (user_id = ? OR visibility = 'org')`
    ).get(id, org_id, userId);

    if (!prompt) {
        return res.status(404).json({ error: 'not_found', message: 'Prompt not found' });
    }

    // F12 (cross-plugin defect sweep, 2026-10-03): this endpoint used to cap
    // at 50 rows with no way for a caller to tell "that's everything" from
    // "that's the first 50 of more". `total` is the real row count and
    // `truncated` says explicitly whether this page is the whole history.
    // `versions` stays the array the existing client (promptsClient.js)
    // already reads — additive fields only, no breaking shape change.
    // `limit`/`offset` are optional query params for a caller that wants to
    // page further; defaulting both preserves today's exact behavior.
    const PAGE_CAP = 50;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = PAGE_CAP;
    limit = Math.min(limit, 200);
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const total = db.prepare(
        `SELECT COUNT(*) AS n FROM prompt_versions WHERE prompt_id = ?`
    ).get(id).n;

    const versions = db.prepare(
        `SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`
    ).all(id, limit, offset);

    return res.json({
        versions,
        total,
        limit,
        offset,
        truncated: offset + versions.length < total,
    });
});

/**
 * POST /api/prompts/:id/restore/:version
 * Restore a prompt to a previous version.
 * Creates a new prompt_versions row (new highest version) with old body/name/desc,
 * and updates the prompt row to reflect the restored state.
 *
 * Body: { org_id }
 */
router.post('/prompts/:id/restore/:version', (req, res) => {
    const { id, version } = req.params;
    const { org_id } = req.body || {};
    const userId = req.user.id;

    if (!org_id) {
        return res.status(400).json({ error: 'org_id_required', message: 'org_id is required' });
    }

    const versionNo = parseInt(version, 10);
    if (!versionNo || versionNo < 1) {
        return res.status(400).json({ error: 'invalid_version', message: 'version must be a positive integer' });
    }

    const db = dbFor(req);

    if (!isMember(db, org_id, userId)) {
        return res.status(403).json({ error: 'not_a_member', message: 'Not a member of this org' });
    }

    const existing = db.prepare(
        `SELECT * FROM prompts WHERE id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`
    ).get(id, org_id, userId);

    if (!existing) {
        return res.status(404).json({ error: 'not_found', message: 'Prompt not found' });
    }

    const oldVersion = db.prepare(
        `SELECT * FROM prompt_versions WHERE prompt_id = ? AND version = ?`
    ).get(id, versionNo);

    if (!oldVersion) {
        return res.status(404).json({ error: 'version_not_found', message: `Version ${versionNo} not found` });
    }

    const restoredBody = oldVersion.body || existing.body;
    const restoredName = oldVersion.name || existing.name;
    const restoredDesc = oldVersion.description;
    const ts = now();

    // Update prompt to restored state
    db.prepare(
        `UPDATE prompts SET body=?, name=?, description=?, updated_at=? WHERE id=?`
    ).run(restoredBody, restoredName, restoredDesc, ts, id);

    // Write new version row (restored snapshot)
    const newVNo = nextVersion(db, id);
    writeVersion(db, id, newVNo, restoredBody, restoredName, restoredDesc, userId);

    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    return res.json({ prompt, restoredFrom: versionNo, newVersion: newVNo });
});

export default router;
