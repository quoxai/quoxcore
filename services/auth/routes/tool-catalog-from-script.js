/**
 * STUDY-REV-2 / P4.B — Tool Library: Register from Script
 *
 * POST /api/orgs/:orgId/tool-library/from-script
 *
 * Registers a tool from a script body (Python, Node, or Bash).
 * Inserts into tool_definitions (global catalog) with status='beta'.
 * No execution yet — thin registration shell only. The full Toolsmith
 * editor + sandbox agent is a separate 12-15d sub-phase.
 *
 * Body:
 *   {
 *     "name":            "my-script-tool"     (required, used as tool slug)
 *     "description":     "What it does"        (optional)
 *     "language":        "python|node|bash"    (required)
 *     "script_body_b64": "<base64 of script>"  (required, non-empty)
 *     "sandbox_profile": "default|network-allowed|filesystem-rw"
 *                                              (optional, default: "default")
 *     "entrypoint":      "main.py"             (optional)
 *     "category_id":     "integration"         (optional, default: "integration")
 *   }
 *
 * Schema constraints (schema-b2-tools.sql):
 *   - status CHECK: 'available' | 'beta' | 'deprecated' | 'disabled' | 'coming_soon'
 *     → uses 'beta' to signal pending sandbox build
 *   - provider: free text → 'script' used as sentinel
 *   - spec_json holds: { language, script_body_b64, sandbox_profile, entrypoint }
 *
 * Auth pattern mirrors tool-catalog-from-repo.js:
 *   - requireUserAuth short-circuits if req.user already set (tests inject this)
 *   - Falls through to requireAuth for production JWT validation
 *   - Org membership checked inline via req.db (injectable in tests)
 *
 * Idempotency: if a tool_definition already exists for (org_id, name),
 * returns 409 with the existing row. Mirrors from-repo's collision behaviour.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { ulid, createAuditEvent } from '../utils/helpers.js';

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_LANGUAGES = ['python', 'node', 'bash'];
const VALID_SANDBOX_PROFILES = ['default', 'network-allowed', 'filesystem-rw'];
const DEFAULT_SANDBOX_PROFILE = 'default';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Sanitise tool name to a safe slug for tool_id.
 * Mirrors the _sanitiseToolName helper used elsewhere.
 */
function sanitiseToolName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '_')
        .replace(/^[^a-z]+/, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'script_tool';
}

/**
 * Validate that a string is non-empty and plausible base64.
 * We accept any non-empty string — strict base64 validation is
 * deferred to the sandbox executor.
 */
function isNonEmptyBase64(value) {
    if (typeof value !== 'string' || value.trim().length === 0) return false;
    // Must only contain base64 alphabet characters
    return /^[A-Za-z0-9+/=\r\n]+$/.test(value.trim());
}

// ── POST /api/orgs/:orgId/tool-library/from-script ───────────────────────────

router.post('/orgs/:orgId/tool-library/from-script', requireUserAuth, (req, res) => {
    const { orgId } = req.params;
    const {
        name,
        description = '',
        language,
        script_body_b64,
        sandbox_profile,
        entrypoint = '',
        category_id = 'integration',
    } = req.body || {};

    const userId = req.user?.id;

    // ── Input validation ──────────────────────────────────────────────────

    if (!language || !VALID_LANGUAGES.includes(language)) {
        return res.status(400).json({
            error: 'invalid_language',
            message: `language must be one of: ${VALID_LANGUAGES.join(', ')}`,
        });
    }

    if (!isNonEmptyBase64(script_body_b64)) {
        return res.status(400).json({
            error: 'invalid_script_body',
            message: 'script_body_b64 must be a non-empty base64-encoded string',
        });
    }

    // Resolve sandbox_profile — default if omitted, reject if invalid non-default
    const resolvedProfile = sandbox_profile === undefined || sandbox_profile === null
        ? DEFAULT_SANDBOX_PROFILE
        : sandbox_profile;

    if (!VALID_SANDBOX_PROFILES.includes(resolvedProfile)) {
        return res.status(400).json({
            error: 'invalid_sandbox_profile',
            message: `sandbox_profile must be one of: ${VALID_SANDBOX_PROFILES.join(', ')}`,
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

    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({
            error: 'invalid_name',
            message: 'name is required',
        });
    }

    const toolName = sanitiseToolName(name.trim());
    // tool_id is org-scoped to avoid collisions across orgs
    // Pattern: script.<orgId-prefix>.<name>
    const toolId = `script.${orgId.slice(0, 8)}.${toolName}`;

    const specJson = JSON.stringify({
        language,
        script_body_b64: script_body_b64.trim(),
        sandbox_profile: resolvedProfile,
        entrypoint: entrypoint || '',
        executor_type: 'script',
    });

    // ── Idempotency: check for existing tool_definition ──────────────────

    const existing = db.prepare(
        'SELECT * FROM tool_definitions WHERE tool_id = ?'
    ).get(toolId);

    if (existing) {
        return res.status(409).json({
            error: 'duplicate_tool',
            message: `A script tool named '${toolName}' is already registered for this org`,
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
            description || `Script tool: ${toolName} (${language})`,
            category_id || 'integration',
            'script',
            '0.1.0',
            specJson,
            null,            // source_url: N/A for inline scripts
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
                message: `A script tool named '${toolName}' is already registered for this org`,
                tool: { ...raceExisting, installed_by: userId },
            });
        }
        console.error('[P4.B] from-script insert failed:', err);
        return res.status(500).json({ error: 'Failed to register script tool' });
    }

    // ── Audit event ───────────────────────────────────────────────────────

    try {
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool_library.from_script.register',
            targetType: 'tool_definition',
            targetId: id,
            metadata: { tool_id: toolId, tool_name: toolName, language },
        });
    } catch (_) {
        // audit failure is non-fatal
    }

    // ── Return inserted row ───────────────────────────────────────────────

    const tool = db.prepare('SELECT * FROM tool_definitions WHERE id = ?').get(id);

    console.log(`[STUDY-REV-2/P4.B] from-script: org=${orgId} tool_id=${toolId} language=${language}`);

    return res.status(201).json({
        tool: {
            ...tool,
            installed_by: userId,
        },
    });
});

export default router;
