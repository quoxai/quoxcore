/**
 * STUDY-REV-2 / P4.0.A — Install-to-Scope Endpoints
 *
 * Three endpoints for managing tool installations at org scope:
 *   GET    /tools/installed?scope_id=:orgId
 *   POST   /tools/install-to-scope
 *   DELETE /tools/install-to-scope/:tool_id
 *
 * org_id is derived from JWT (req.user.org_id) or query param scope_id
 * (JWT wins on conflict). No :orgId URL param required.
 *
 * Auth pattern mirrors routes/plugins.js:
 *   - requireUserAuth short-circuits if req.user already set (tests inject this)
 *   - Falls through to requireAuth for production JWT validation
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { ulid } from '../utils/helpers.js';
import { toolNotInCatalogMessage } from '../lib/toolNotInCatalogHint.js';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Use injected req.db (tests) or singleton getDb() (production). */
function dbFor(req) { return req.db || getDb(); }

/**
 * Short-circuits if req.user is already populated (test injection).
 * Falls through to requireAuth (JWT verification) for production requests.
 */
function requireUserAuth(req, res, next) {
    if (req.user) return next();
    return requireAuth(req, res, next);
}

/**
 * quox#989: the caller's org is the one authenticate.js VERIFIED (req.org / req.orgMembership, set
 * from the token's org_id after a membership check). It never puts org_id on req.user, so reading
 * req.user.org_id made every human install fail. req.user.org_id stays as a fallback for injected
 * callers that set it.
 */
function verifiedOrgId(req) {
    return (req.org && req.org.id) || (req.orgMembership && req.orgMembership.org_id) || req.user?.org_id || null;
}

// ── GET /tools/installed ─────────────────────────────────────────────────────

/**
 * GET /tools/installed?scope_id=:orgId
 * Returns tools the org has explicitly installed-to-scope.
 * Joins tool_installations (install metadata) with tool_definitions (library def).
 *
 * orgId source precedence: JWT org_id > scope_id query param.
 * Response: { installations: [{ id, tool_id, name, description, category,
 *              enabled, installed_at, ... }] }
 */
router.get('/tools/installed', requireUserAuth, (req, res) => {
    // quox#989: ?scope_id is honoured only for an org the caller belongs to; it used to be read unchecked.
    const verified = verifiedOrgId(req);
    const scope = req.query.scope_id ? String(req.query.scope_id) : null;
    let orgId = verified;
    if (scope && scope !== verified) {
        if (verified) return res.status(403).json({ error: 'forbidden_scope', message: 'scope_id must be your own organisation' });
        const m = dbFor(req).prepare("SELECT status FROM org_memberships WHERE org_id = ? AND user_id = ?").get(scope, req.user.id);
        if (!m || m.status !== 'active') return res.status(403).json({ error: 'forbidden_scope', message: 'not a member of that organisation' });
        orgId = scope;
    }
    if (!orgId) {
        return res.status(400).json({
            error: 'scope_id_required',
            message: 'scope_id query param or org_id in JWT is required',
        });
    }

    try {
        const db = dbFor(req);
        const installations = db.prepare(`
            SELECT
                ti.id, ti.org_id, ti.tool_definition_id,
                ti.config_json, ti.enabled, ti.pinned_version,
                ti.installed_by, ti.installed_at, ti.updated_at,
                ti.disabled_at,
                td.tool_id, td.name, td.description, td.category, td.subcategory,
                td.provider, td.version as catalog_version,
                td.risk_level, td.sandbox_profile, td.icon
            FROM tool_installations ti
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            WHERE ti.org_id = ?
            ORDER BY td.name
        `).all(orgId);

        for (const inst of installations) {
            inst.config = JSON.parse(inst.config_json || '{}');
            delete inst.config_json;
        }

        return res.json({ installations });
    } catch (err) {
        console.error('Error listing installed tools:', err);
        return res.status(500).json({ error: 'Failed to list installed tools' });
    }
});

// ── POST /tools/install-to-scope ─────────────────────────────────────────────

/**
 * POST /tools/install-to-scope
 * Body: { tool_id: string, config?: object, pinned_version?: string }
 *
 * Idempotent on (org_id, tool_definition_id):
 *   - New row  → INSERT, returns 201
 *   - Existing → UPDATE (re-enable + refresh config), returns 201 with same id
 *
 * Validates tool_id against tool_definitions. 404 if not found.
 * org_id derived from JWT.
 */
router.post('/tools/install-to-scope', requireUserAuth, (req, res) => {
    const orgId = verifiedOrgId(req);
    if (!orgId) {
        return res.status(400).json({
            error: 'org_id_required',
            message: 'org_id must be present in JWT',
        });
    }

    const { tool_id, config, pinned_version } = req.body || {};
    if (!tool_id) {
        return res.status(400).json({
            error: 'tool_id_required',
            message: 'tool_id is required',
        });
    }

    try {
        const db = dbFor(req);

        // Validate tool_id exists in catalog
        const toolDef = db.prepare('SELECT * FROM tool_definitions WHERE tool_id = ?').get(tool_id);
        if (!toolDef) {
            return res.status(404).json({
                error: 'tool_not_found',
                message: toolNotInCatalogMessage(db, orgId, tool_id),
            });
        }

        // Check for existing installation (idempotent upsert)
        const existing = db.prepare(
            'SELECT * FROM tool_installations WHERE org_id = ? AND tool_definition_id = ?'
        ).get(orgId, toolDef.id);

        if (existing) {
            // Re-enable + optionally update config
            const configJson = config !== undefined ? JSON.stringify(config) : existing.config_json;
            db.prepare(`
                UPDATE tool_installations
                SET enabled = 1, config_json = ?, updated_at = datetime('now'), disabled_at = NULL
                WHERE id = ?
            `).run(configJson, existing.id);

            const updated = db.prepare(`
                SELECT ti.*, td.tool_id, td.name, td.description, td.category
                FROM tool_installations ti
                JOIN tool_definitions td ON ti.tool_definition_id = td.id
                WHERE ti.id = ?
            `).get(existing.id);

            return res.status(201).json({
                installation: {
                    ...updated,
                    config: JSON.parse(updated.config_json || '{}'),
                    config_json: undefined,
                },
            });
        }

        // New installation
        const id = ulid();
        db.prepare(`
            INSERT INTO tool_installations
                (id, org_id, tool_definition_id, config_json, enabled, pinned_version, installed_by)
            VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(
            id, orgId, toolDef.id,
            JSON.stringify(config || {}),
            pinned_version || null,
            req.user.id
        );

        const installation = db.prepare(`
            SELECT ti.*, td.tool_id, td.name, td.description, td.category
            FROM tool_installations ti
            JOIN tool_definitions td ON ti.tool_definition_id = td.id
            WHERE ti.id = ?
        `).get(id);

        return res.status(201).json({
            installation: {
                ...installation,
                config: JSON.parse(installation.config_json || '{}'),
                config_json: undefined,
            },
        });
    } catch (err) {
        console.error('Error installing tool to scope:', err);
        return res.status(500).json({ error: 'Failed to install tool' });
    }
});

// ── DELETE /tools/install-to-scope/:tool_id ──────────────────────────────────

/**
 * DELETE /tools/install-to-scope/:tool_id
 *
 * Soft-disables the installation: sets enabled=0 and disabled_at.
 * Idempotent — returns ok=true, removed=false if no installation exists.
 * org_id derived from JWT.
 *
 * Response: { ok: true, removed: boolean }
 */
router.delete('/tools/install-to-scope/:tool_id', requireUserAuth, (req, res) => {
    const orgId = verifiedOrgId(req);
    if (!orgId) {
        return res.status(400).json({
            error: 'org_id_required',
            message: 'org_id must be present in JWT',
        });
    }

    const { tool_id } = req.params;

    try {
        const db = dbFor(req);

        // Resolve tool_id → internal id
        const toolDef = db.prepare('SELECT id FROM tool_definitions WHERE tool_id = ?').get(tool_id);
        if (!toolDef) {
            // Unknown tool — idempotent no-op
            return res.json({ ok: true, removed: false });
        }

        const existing = db.prepare(
            'SELECT id FROM tool_installations WHERE org_id = ? AND tool_definition_id = ?'
        ).get(orgId, toolDef.id);

        if (!existing) {
            return res.json({ ok: true, removed: false });
        }

        db.prepare(`
            UPDATE tool_installations
            SET enabled = 0,
                disabled_at = datetime('now'),
                disabled_by = ?,
                updated_at = datetime('now')
            WHERE id = ?
        `).run(req.user.id, existing.id);

        return res.json({ ok: true, removed: true });
    } catch (err) {
        console.error('Error disabling tool installation:', err);
        return res.status(500).json({ error: 'Failed to disable tool installation' });
    }
});

export default router;
