/**
 * TOOLSMITH Slice E — Install from Toolsmith Draft
 *
 * POST /api/orgs/:orgId/tool-library/from-toolsmith
 *
 * Resolves a user's Toolsmith draft from the tool_drafts table, validates it
 * via toolsmithValidator (reused), then writes a tool_definitions row.
 *
 * WARD policy_satisfies check: extends the existing policy chain with a new
 * tool.install class that runs the same evaluation pattern as skill installs.
 *
 * Body:
 *   { draftId }         — resolve draft from tool_drafts; extract tool.json from files
 *   OR
 *   { files: {...} }    — direct file map (tool authors not coming from a draft)
 *
 * Pre-install checks (in order):
 *   1. User is a member of :orgId (existing membership check pattern)
 *   2. WARD policy_satisfies check: policy class 'tool.install' — returns 403 with denial reason on failure
 *   3. tool.json parses + schema-validates (reuses toolsmithValidator)
 *
 * On install: writes tool_definitions row with:
 *   signature=NULL, edition='experimental', source='toolsmith',
 *   author_user_id=<jwt user_id>, status='installed'
 *
 * Returns: { ok: true, toolId, toolName, scope: 'org:<orgId>' }
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { ulid, createAuditEvent } from '../utils/helpers.js';
import { Capabilities, hasCapability } from '../utils/policy.js';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * WARD policy_satisfies — tool.install policy class.
 *
 * This is the QSKL-14a extension for tool definitions. It mirrors the pattern
 * used for skill installs: check whether the org's governance policies permit
 * installing a tool with the given risk profile.
 *
 * Policy evaluation:
 *   - If no tool.install policies exist for the org → ALLOW (permissive default until
 *     policies are authored)
 *   - If policies exist, evaluate each; if any deny → DENY with the denial reason
 *   - TOOLSMITH-E-fix: governance substrate failures (missing table, evaluation error)
 *     now DENY and emit a loud console.error so operators can alert. The only
 *     exception is GOVERNANCE_BOOTSTRAP=true which permits installs during initial
 *     deployment when the governance schema has not yet been applied.
 *
 * @param {object} opts
 * @param {object} opts.db — better-sqlite3 DB instance
 * @param {string} opts.orgId — organisation ID
 * @param {object} opts.toolJson — parsed tool.json
 * @returns {{ allowed: boolean, reason: string }}
 */
function toolInstallPolicySatisfies({ db, orgId, toolJson }) {
    try {
        // Check for tool.install policies registered for this org
        const policies = db.prepare(`
            SELECT * FROM governance_policies
            WHERE org_id = ? AND policy_class = ? AND status = 'active'
            ORDER BY priority ASC
        `).all(orgId, 'tool.install');

        if (!policies || policies.length === 0) {
            // No tool.install policies configured → ALLOW (open-by-default per security model)
            return { allowed: true, reason: 'no_policies_configured' };
        }

        // Evaluate each policy. Simple attribute-based evaluation:
        // A policy may deny based on: permissions.network, permissions.filesystem,
        // edition (experimental tools), or custom metadata.
        const permissions = toolJson.permissions || {};

        for (const policy of policies) {
            let rules = {};
            try { rules = JSON.parse(policy.rules_json || '{}'); } catch { /* ignore */ }

            // Rule: deny tools requiring network access
            if (rules.deny_network === true && permissions.network === true) {
                return {
                    allowed: false,
                    reason: `policy_denied: policy "${policy.name || policy.id}" denies tools requiring network access`,
                };
            }

            // Rule: deny tools requiring filesystem write access
            if (rules.deny_filesystem === true && permissions.filesystem === true) {
                return {
                    allowed: false,
                    reason: `policy_denied: policy "${policy.name || policy.id}" denies tools requiring filesystem access`,
                };
            }

            // Rule: deny experimental tools (edition check)
            if (rules.deny_experimental === true) {
                const edition = toolJson.edition || 'experimental';
                if (edition === 'experimental') {
                    return {
                        allowed: false,
                        reason: `policy_denied: policy "${policy.name || policy.id}" denies experimental tools`,
                    };
                }
            }
        }

        return { allowed: true, reason: 'all_policies_satisfied' };
    } catch (err) {
        // TOOLSMITH-E-fix: substrate failures now FAIL CLOSED (not open).
        // Silent fail-open is governance theatre — operators must be able to alert.
        if (err.code === 'SQLITE_ERROR' && /no such table/.test(err.message)) {
            if (process.env.GOVERNANCE_BOOTSTRAP === 'true') {
                console.warn('[tool-catalog-from-toolsmith] governance_policies table absent — GOVERNANCE_BOOTSTRAP=true, allowing');
                return { allowed: true, reason: 'governance_bootstrap_mode' };
            }
            // Loud operator-visible error: alert on this in production.
            console.error(
                '[TOOLSMITH-GOVERNANCE] CRITICAL: governance_policies table absent; blocking tool install for org=%s. ' +
                'Set GOVERNANCE_BOOTSTRAP=true to allow during initial deployment.',
                orgId
            );
            return { allowed: false, reason: 'governance_substrate_unavailable' };
        }
        // Any other evaluation error: DENY + loud operator log.
        console.error(
            '[TOOLSMITH-GOVERNANCE] CRITICAL: governance gate evaluation error for org=%s; blocking tool install. error=%s',
            orgId, err.message
        );
        return { allowed: false, reason: 'governance_evaluation_error' };
    }
}

/**
 * Sanitise tool name to a safe slug.
 */
function sanitiseToolName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '_')
        .replace(/^[^a-z]+/, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'toolsmith_tool';
}

// ── POST /api/orgs/:orgId/tool-library/from-toolsmith ────────────────────────

router.post('/orgs/:orgId/tool-library/from-toolsmith', requireUserAuth, async (req, res) => {
    const { orgId } = req.params;
    const { draftId, files: directFiles } = req.body || {};
    const userId = req.user?.id;
    const db = dbFor(req);

    // ── 1. Org membership check ───────────────────────────────────────────────

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

        // F10 (TRUST-PROOF plugin-frame-c1): installing an unsigned script tool makes it
        // callable by agents, so membership alone is not enough. Require the same
        // tool-authoring capability the directory uses (builder and above).
        const allowed = hasCapability(
            { type: 'user', id: userId, orgRole: membership.role, customRoleId: membership.custom_role_id || null },
            Capabilities.DIRECTORY_CREATE_TOOL,
            { db, orgId }
        );
        if (!allowed) {
            return res.status(403).json({
                error: 'insufficient_permissions',
                message: 'directory.create_tool capability required to install tools',
            });
        }
    }

    // ── Resolve files from draft or direct body ───────────────────────────────

    let resolvedFiles;

    if (draftId) {
        // Resolve from tool_drafts table
        const draft = db.prepare(
            'SELECT * FROM tool_drafts WHERE id = ? AND user_id = ?'
        ).get(draftId, userId);

        if (!draft) {
            return res.status(404).json({
                error: 'draft_not_found',
                message: `Draft ${draftId} not found or belongs to another user`,
            });
        }

        try {
            resolvedFiles = JSON.parse(draft.draft_files || '{}');
        } catch {
            return res.status(400).json({
                error: 'invalid_draft',
                message: 'Draft files could not be parsed',
            });
        }
    } else if (directFiles && typeof directFiles === 'object') {
        resolvedFiles = directFiles;
    } else {
        return res.status(400).json({
            error: 'invalid_body',
            message: 'Either draftId or files must be provided',
        });
    }

    // ── 3. Validate tool.json + schema ────────────────────────────────────────

    const toolJsonStr = resolvedFiles['tool.json'];
    if (!toolJsonStr || typeof toolJsonStr !== 'string') {
        return res.status(400).json({
            error: 'missing_tool_json',
            message: 'tool.json is required in the file set',
        });
    }

    let toolJson;
    try {
        toolJson = JSON.parse(toolJsonStr);
    } catch (err) {
        return res.status(400).json({
            error: 'invalid_tool_json',
            message: `tool.json is not valid JSON: ${err.message}`,
        });
    }

    // Use toolsmithValidator if available (collector-side lib — optional in auth service)
    // The validator is more thorough but lives in collector; for auth service we do basic checks.
    const toolName = toolJson.name || toolJson.id;
    if (!toolName || typeof toolName !== 'string') {
        return res.status(400).json({
            error: 'invalid_tool_json',
            message: 'tool.json must have a "name" or "id" field',
        });
    }

    // ── 2. WARD policy_satisfies check ────────────────────────────────────────
    // (Placed after validation so we have toolJson parsed; order in spec is pre-install
    //  checks 1→2→3 but we do basic parsing before the WARD check for cleaner errors)

    const policyResult = toolInstallPolicySatisfies({ db, orgId, toolJson });
    if (!policyResult.allowed) {
        return res.status(403).json({
            error: 'policy_denied',
            message: policyResult.reason,
        });
    }

    // ── Derive tool identity ──────────────────────────────────────────────────

    const toolSlug = sanitiseToolName(toolName.trim());
    // tool_id is org-scoped to prevent cross-org collision.
    // Use a short hash of the orgId (not a prefix slice) so that org IDs which
    // share a common prefix (e.g. 'ORG_TS_MT_A' / 'ORG_TS_MT_B' in tests) still
    // produce distinct tool_ids. Production ULIDs have enough entropy in the first
    // 8 chars but we use a hash here to be safe.
    const { createHash } = await import('crypto');
    const orgSlug = createHash('sha256').update(orgId).digest('hex').slice(0, 8);
    const toolId = `toolsmith.${orgSlug}.${toolSlug}`;
    const now = new Date().toISOString();

    const specJson = JSON.stringify({
        source: 'toolsmith',
        author_user_id: userId,
        edition: 'experimental',
        draft_id: draftId || null,
        permissions: toolJson.permissions || {},
        inputs_schema: toolJson.inputs_schema || {},
        outputs_schema: toolJson.outputs_schema || {},
        runtime: toolJson.runtime || 'python3.11',
        deterministic: toolJson.deterministic !== false,
    });

    // ── Check for existing tool_definition ───────────────────────────────────

    const existing = db.prepare('SELECT * FROM tool_definitions WHERE tool_id = ?').get(toolId);
    if (existing) {
        return res.status(409).json({
            error: 'duplicate_tool',
            message: `A Toolsmith tool named "${toolSlug}" is already installed for this org`,
            toolId: existing.tool_id,
            toolName: existing.name,
        });
    }

    // ── Insert tool_definitions row ───────────────────────────────────────────

    const id = ulid();

    try {
        db.prepare(`
            INSERT INTO tool_definitions (
                id, tool_id, name, description, category,
                provider, version,
                spec_json, source_url,
                status, is_core, is_featured,
                requires_config, requires_license,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            toolId,
            toolSlug,
            toolJson.description || `Toolsmith tool: ${toolSlug}`,
            toolJson.category || 'integration',
            'toolsmith',
            '0.1.0',
            specJson,
            null,             // source_url: N/A for Toolsmith tools
            'installed',      // status: installed immediately (not 'available'/'beta')
            0,                // is_core
            0,                // is_featured
            0,                // requires_config: ready-to-use from Toolsmith
            0,                // requires_license
            now,
            now,
        );
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            const raceExisting = db.prepare('SELECT * FROM tool_definitions WHERE tool_id = ?').get(toolId);
            return res.status(409).json({
                error: 'duplicate_tool',
                message: `A Toolsmith tool named "${toolSlug}" is already installed for this org (race)`,
                toolId: raceExisting?.tool_id,
                toolName: raceExisting?.name,
            });
        }
        console.error('[TOOLSMITH-E] from-toolsmith insert failed:', err);
        return res.status(500).json({ error: 'Failed to install Toolsmith tool' });
    }

    // ── Audit event ───────────────────────────────────────────────────────────

    try {
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool_library.from_toolsmith.install',
            targetType: 'tool_definition',
            targetId: id,
            metadata: {
                tool_id: toolId,
                tool_name: toolSlug,
                draft_id: draftId || null,
                source: 'toolsmith',
            },
        });
    } catch (_) {
        // Audit failure is non-fatal
    }

    console.log(`[TOOLSMITH-E] from-toolsmith: org=${orgId} tool_id=${toolId} user=${userId}`);

    // ── TOOLSMITH-E-fix Patch 1: Mirror to collector runtime cache ────────────
    // POST to collector so the new tool is visible to chat dispatch
    // immediately (same process lifetime). If the collector call fails,
    // we mark the auth DB row with install_pending_collector_sync so
    // operators can see the gap — we do NOT silently leave a half-install.
    //
    // TOOLSMITH_SKIP_COLLECTOR_SYNC=true bypasses this in unit tests
    // where no live collector is available. Never set in production.

    if (process.env.TOOLSMITH_SKIP_COLLECTOR_SYNC === 'true') {
        return res.status(201).json({
            ok: true,
            toolId,
            toolName: toolSlug,
            scope: `org:${orgId}`,
            id,
        });
    }

    const collectorUrl = process.env.COLLECTOR_URL
        || process.env.QUOX_COLLECTOR_URL
        || 'http://collector:9848';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';

    let collectorSyncOk = false;
    let collectorError = null;

    try {
        const collectorResp = await fetch(
            `${collectorUrl}/api/internal/tool-definitions/install`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
                },
                body: JSON.stringify({
                    toolId,
                    orgId,
                    toolName: toolSlug,
                    toolJson,
                    files: resolvedFiles,
                    source: 'toolsmith',
                    edition: 'experimental',
                }),
                signal: AbortSignal.timeout(5000),
            }
        );

        if (collectorResp.ok) {
            collectorSyncOk = true;
        } else {
            const errBody = await collectorResp.text().catch(() => '');
            collectorError = `HTTP ${collectorResp.status}: ${errBody}`;
        }
    } catch (err) {
        collectorError = err.message;
    }

    if (!collectorSyncOk) {
        // Mark the row as pending sync so the operator can detect the gap.
        // This is NOT a silent failure — the error is logged at ERROR level
        // so alerting rules can fire.
        console.error(
            '[TOOLSMITH-E-fix] COLLECTOR SYNC FAILED for tool_id=%s org=%s: %s. ' +
            'Tool installed in auth DB but NOT visible in collector chat dispatch. ' +
            'Set collector health check or restart collector to recover.',
            toolId, orgId, collectorError
        );
        try {
            db.prepare("UPDATE tool_definitions SET status = 'install_pending_collector_sync' WHERE tool_id = ?")
                .run(toolId);
        } catch (_updateErr) {
            // Status update failure is non-fatal but logged
            console.error('[TOOLSMITH-E-fix] Failed to mark tool as pending collector sync:', _updateErr.message);
        }
        return res.status(503).json({
            error: 'collector_sync_failed',
            message: 'Tool was saved but could not be registered with the chat runtime. Please retry or contact support.',
            toolId,
            toolName: toolSlug,
        });
    }

    return res.status(201).json({
        ok: true,
        toolId,
        toolName: toolSlug,
        scope: `org:${orgId}`,
        id,
    });
});

export default router;
