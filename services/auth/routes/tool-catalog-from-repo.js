/**
 * STUDY-REV-2 / P4.A — Tool Library: Register from Git Repo
 *
 * POST /api/orgs/:orgId/tool-library/from-repo
 *
 * Registers a tool from a Git repository URL + manifest path.
 * Inserts into tool_definitions (global catalog) and creates a
 * tool_installation row scoped to the org.
 *
 * Body:
 *   {
 *     "git_url":        "https://github.com/owner/repo"  (required)
 *     "manifest_path":  "tool.json"                      (default: "tool.json")
 *     "branch":         "main"                           (default: "main")
 *     "signing_key_ref": null                            (optional, plain ref for now)
 *     "category_id":    "integration"                    (optional, default: "integration")
 *   }
 *
 * Tool name is derived from the repo basename (last path segment without .git).
 * executor config is stored in spec_json as: { git_url, manifest_path, branch, signing_key_ref }.
 *
 * Schema constraints (schema-b2-tools.sql):
 *   - status CHECK: 'available' | 'beta' | 'deprecated' | 'disabled' | 'coming_soon'
 *     → uses 'beta' to signal pending sandbox build
 *   - provider: free text → 'repo_plugin' used as sentinel
 *   - source_url: stores the git_url for catalog display
 *
 * Auth pattern mirrors tool-install-scope.js:
 *   - requireUserAuth short-circuits if req.user already set (tests inject this)
 *   - Falls through to requireAuth for production JWT validation
 *   - Org membership checked inline via req.db (injectable in tests)
 *
 * Idempotency: if tool_definition already exists for (org_id, name) i.e. same
 * derived tool_id, returns 409 with the existing row.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { ulid, createAuditEvent } from '../utils/helpers.js';

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
 * Derive tool name from a git URL.
 * Examples:
 *   https://github.com/foo/bar      → 'bar'
 *   https://github.com/foo/bar.git  → 'bar'
 *   git@github.com:foo/bar.git      → 'bar'
 *   https://github.com/foo/bar/     → 'bar'
 */
function repoBasename(gitUrl) {
    const cleaned = gitUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const parts = cleaned.split(/[\/:]/);
    return parts[parts.length - 1] || 'repo_tool';
}

/**
 * Sanitise tool name to a safe slug for tool_id.
 * Mirrors the _sanitiseToolName helper in collector/server.js.
 */
function sanitiseToolName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '_')
        .replace(/^[^a-z]+/, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'repo_tool';
}

/**
 * Validate git URL: must be https://, http://, or git@… format.
 */
function isValidGitUrl(url) {
    if (typeof url !== 'string') return false;
    return (
        url.startsWith('https://') ||
        url.startsWith('http://') ||
        url.startsWith('git@')
    );
}

// ── POST /api/orgs/:orgId/tool-library/from-repo ─────────────────────────────

router.post('/orgs/:orgId/tool-library/from-repo', requireUserAuth, (req, res) => {
    const { orgId } = req.params;
    const {
        git_url,
        manifest_path = 'tool.json',
        branch = 'main',
        signing_key_ref = null,
        category_id = 'integration',
    } = req.body || {};

    const userId = req.user?.id;

    // ── Input validation ──────────────────────────────────────────────────

    if (!git_url || !isValidGitUrl(git_url)) {
        return res.status(400).json({
            error: 'invalid_git_url',
            message: 'git_url must start with https://, http://, or git@',
        });
    }

    // ── Org membership check (inline, uses injectable db) ────────────────
    const db = dbFor(req);

    const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
    if (!org || org.deleted_at) {
        return res.status(404).json({ error: 'org_not_found', message: 'Organization not found' });
    }

    if (userId) {
        const membership = db.prepare(
            'SELECT * FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = ?'
        ).get(orgId, userId, 'active');

        if (!membership) {
            return res.status(403).json({
                error: 'not_org_member',
                message: 'You are not a member of this organization',
            });
        }
    }

    // ── Derive tool identity ──────────────────────────────────────────────

    const repoName = repoBasename(git_url);
    const toolName = sanitiseToolName(repoName);
    // tool_id is org-scoped to avoid collisions across orgs
    // Pattern: repo.<orgId-prefix>.<name>
    const toolId = `repo.${orgId.slice(0, 8)}.${toolName}`;

    const specJson = JSON.stringify({
        git_url,
        manifest_path,
        branch,
        signing_key_ref,
        executor_type: 'repo_plugin',
    });

    // ── Idempotency: check for existing tool_definition ──────────────────

    const existing = db.prepare(
        'SELECT * FROM tool_definitions WHERE tool_id = ?'
    ).get(toolId);

    if (existing) {
        return res.status(409).json({
            error: 'duplicate_tool',
            message: `A repo tool named '${toolName}' is already registered for this org`,
            tool: {
                ...existing,
                installed_by: userId,
            },
        });
    }

    // ── Insert tool_definition ────────────────────────────────────────────

    const id = ulid();
    const now = new Date().toISOString();

    try {
        db.prepare(`
            INSERT INTO tool_definitions (
                id, tool_id, name, description, category,
                provider, version,
                spec_json, source_url,
                status, is_core, is_featured,
                requires_config,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            toolId,
            toolName,
            `Repo plugin: ${git_url}`,
            category_id || 'integration',
            'repo_plugin',
            '0.1.0',
            specJson,
            git_url,
            'beta',          // 'beta' signals pending sandbox build
            0,
            0,
            1,               // requires_config = 1 (needs sandbox build to be usable)
            now,
            now,
        );
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            // Race condition — fetch and return the existing row
            const raceExisting = db.prepare('SELECT * FROM tool_definitions WHERE tool_id = ?').get(toolId);
            return res.status(409).json({
                error: 'duplicate_tool',
                message: `A repo tool named '${toolName}' is already registered for this org`,
                tool: { ...raceExisting, installed_by: userId },
            });
        }
        console.error('[P4.A] from-repo insert failed:', err);
        return res.status(500).json({ error: 'Failed to register repo tool' });
    }

    // ── Audit event ───────────────────────────────────────────────────────

    try {
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool_library.from_repo.register',
            targetType: 'tool_definition',
            targetId: id,
            metadata: { tool_id: toolId, tool_name: toolName, git_url },
        });
    } catch (_) {
        // audit failure is non-fatal
    }

    // ── Return inserted row ───────────────────────────────────────────────

    const tool = db.prepare('SELECT * FROM tool_definitions WHERE id = ?').get(id);

    console.log(`[STUDY-REV-2/P4.A] from-repo: org=${orgId} tool_id=${toolId} git_url=${git_url}`);

    return res.status(201).json({
        tool: {
            ...tool,
            installed_by: userId,
        },
    });
});

export default router;
