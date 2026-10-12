/**
 * Update Routes for QuoxCORE Auth Service
 * Phase D.2: System Maintenance — Update Detection, Execution, and Settings
 *
 * Provides API endpoints for:
 * - Checking for available updates (GitHub Releases)
 * - Viewing update status and changelog
 * - Starting, cancelling, and rolling back updates
 * - Viewing update history
 * - Managing auto-check and maintenance window settings
 *
 * The auth service handles RBAC, audit, history, and settings (request layer).
 * The orchestrator handles Docker operations, git, and builds (execution layer).
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { createAuditEvent, ulid, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { resolveVersion } from '../lib/resolveVersion.js';
import { emitItemCreated } from '../utils/inboxEvents.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Orchestrator URL for delegating execution
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:3100';

// GitHub API for version checks
const GITHUB_REPO = process.env.GITHUB_REPO || 'quoxai/quox';
const GITHUB_API_BASE = 'https://api.github.com';

// Rate limit: max 1 update check per 5 minutes
const checkCooldowns = new Map();
const CHECK_COOLDOWN_MS = 5 * 60 * 1000;

// Rate limit: max 1 update execution per hour
const updateCooldowns = new Map();
const UPDATE_COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Read current version: QUOXCORE_VERSION build arg, then the canonical
 * /app/VERSION file, then '0.0.0'. Prevents silently reporting the placeholder
 * when the build arg was not passed.
 */
function getCurrentVersion() {
    return resolveVersion();
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 */
function compareSemver(a, b) {
    const pa = (a || '0.0.0').replace(/^v/, '').split('.').map(Number);
    const pb = (b || '0.0.0').replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

/**
 * Fetch the latest release from GitHub API
 *
 * VAULT-INTEG P3: this used to read process.env.GITHUB_TOKEN directly under
 * a comment claiming "from QuoxVault" — the comment was aspirational, not
 * true. Now resolves via credentialResolver.js's resolveProviderKey()
 * waterfall (org vault -> instance_config -> env), the same resolver this
 * service already owns for every other provider key. `orgId` may be null
 * for callers outside an org context (unauthenticated update checks); the
 * resolver's org-vault step is a no-op without one and it falls straight to
 * GITHUB_TOKEN, unchanged from before.
 */
async function fetchLatestRelease(orgId = null) {
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`;
    const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'QuoxCORE-Updater'
    };

    const { resolveProviderKey } = await import('../services/credentialResolver.js');
    const { key: ghToken } = resolveProviderKey(orgId, 'github');
    if (ghToken) {
        headers['Authorization'] = `Bearer ${ghToken}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });

    if (res.status === 404) {
        return null; // No releases yet
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API error: ${res.status} ${text.slice(0, 200)}`);
    }

    const release = await res.json();
    return {
        version: (release.tag_name || '').replace(/^v/, ''),
        tag: release.tag_name,
        name: release.name,
        body: release.body || '',
        published_at: release.published_at,
        html_url: release.html_url,
        prerelease: release.prerelease,
        draft: release.draft
    };
}

// ============================================================================
// UPDATE STATUS
// ============================================================================

/**
 * GET /orgs/:orgId/update-status
 * Returns current version, available version, last check time, and active operation
 */
router.get('/orgs/:orgId/update-status', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const currentVersion = getCurrentVersion();

        // Get latest check result
        const latestCheck = prepare(`
            SELECT * FROM update_checks
            WHERE org_id = ?
            ORDER BY checked_at DESC
            LIMIT 1
        `).get(orgId);

        // Get any active update operation
        const activeOp = prepare(`
            SELECT * FROM update_operations
            WHERE org_id = ? AND status IN ('pending', 'running')
            ORDER BY created_at DESC
            LIMIT 1
        `).get(orgId);

        // Get settings
        const settings = prepare(`
            SELECT * FROM update_settings WHERE org_id = ?
        `).get(orgId);

        res.json({
            current_version: currentVersion,
            available_version: latestCheck?.available_version || null,
            update_available: latestCheck?.update_available === 1,
            release_notes_md: latestCheck?.release_notes_md || null,
            release_url: latestCheck?.release_url || null,
            published_at: latestCheck?.published_at || null,
            last_check: latestCheck?.checked_at || null,
            active_operation: activeOp || null,
            settings: settings || {
                auto_check_enabled: 1,
                check_interval_hours: 6,
                auto_backup_before_update: 1,
                release_channel: 'stable'
            }
        });
    } catch (err) {
        console.error('[Updates] Status error:', err);
        res.status(500).json({ error: 'Failed to get update status' });
    }
});

// ============================================================================
// CHECK FOR UPDATES
// ============================================================================

/**
 * POST /orgs/:orgId/update-check
 * Force a version check against GitHub releases
 */
router.post('/orgs/:orgId/update-check', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;

        // Rate limit
        const lastCheck = checkCooldowns.get(orgId);
        if (lastCheck && (Date.now() - lastCheck) < CHECK_COOLDOWN_MS) {
            const retryAfter = Math.ceil((lastCheck + CHECK_COOLDOWN_MS - Date.now()) / 1000);
            return res.status(429).json({ error: 'Check rate limited', retryAfter });
        }
        checkCooldowns.set(orgId, Date.now());

        const currentVersion = getCurrentVersion();
        const release = await fetchLatestRelease(orgId);

        const id = ulid();
        let updateAvailable = 0;
        let availableVersion = null;
        let releaseNotes = null;
        let publishedAt = null;
        let releaseUrl = null;

        if (release && !release.draft) {
            // Get settings to check channel preference
            const settings = prepare(`SELECT release_channel FROM update_settings WHERE org_id = ?`).get(orgId);
            const channel = settings?.release_channel || 'stable';

            // Skip pre-releases unless on beta/nightly channel
            if (release.prerelease && channel === 'stable') {
                // No stable update available
            } else if (compareSemver(release.version, currentVersion) > 0) {
                updateAvailable = 1;
                availableVersion = release.version;
                releaseNotes = release.body;
                publishedAt = release.published_at;
                releaseUrl = release.html_url;
            }
        }

        prepare(`
            INSERT INTO update_checks (id, org_id, current_version, available_version, update_available, release_notes_md, published_at, release_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, orgId, currentVersion, availableVersion, updateAvailable, releaseNotes, publishedAt, releaseUrl);

        // Audit: update check performed
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user?.id,
            action: 'update.checked',
            targetType: 'system',
            targetId: id,
            metadata: { current_version: currentVersion, available_version: availableVersion, update_available: updateAvailable === 1 }
        });

        // Create inbox notification if update is available
        if (updateAvailable) {
            try {
                const db = getDb();
                const inbox = db.prepare(`SELECT id FROM inboxes WHERE org_id = ? LIMIT 1`).get(orgId);
                if (inbox) {
                    const itemId = ulid();
                    db.prepare(`
                        INSERT INTO inbox_items (id, inbox_id, type, title, body_md, priority, source, source_ref, metadata_json, status)
                        VALUES (?, ?, 'notification', ?, ?, 'low', 'system-maintenance', ?, ?, 'open')
                    `).run(
                        itemId,
                        inbox.id,
                        `Update available: v${availableVersion}`,
                        `A new version of QuoxCORE (v${availableVersion}) is available. Visit System Maintenance to review and install.`,
                        `update-check-${id}`,
                        JSON.stringify({ type: 'update_available', version: availableVersion })
                    );
                    emitItemCreated(orgId, { id: itemId, type: 'notification', title: `Update available: v${availableVersion}` });
                }
            } catch (notifErr) {
                console.warn('[Updates] Failed to create notification:', notifErr.message);
            }
        }

        res.json({
            current_version: currentVersion,
            available_version: availableVersion,
            update_available: updateAvailable === 1,
            release_notes_md: releaseNotes,
            published_at: publishedAt,
            release_url: releaseUrl,
            checked_at: new Date().toISOString()
        });
    } catch (err) {
        console.error('[Updates] Check error:', err);
        res.status(500).json({ error: `Version check failed: ${err.message}` });
    }
});

// ============================================================================
// CHANGELOG
// ============================================================================

/**
 * GET /orgs/:orgId/update-changelog
 * Returns full release notes markdown for the available update
 */
router.get('/orgs/:orgId/update-changelog', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;

        const latestCheck = prepare(`
            SELECT release_notes_md, available_version, published_at, release_url
            FROM update_checks
            WHERE org_id = ? AND update_available = 1
            ORDER BY checked_at DESC
            LIMIT 1
        `).get(orgId);

        if (!latestCheck) {
            return res.json({ changelog: null, message: 'No update available' });
        }

        res.json({
            version: latestCheck.available_version,
            changelog: latestCheck.release_notes_md,
            published_at: latestCheck.published_at,
            release_url: latestCheck.release_url
        });
    } catch (err) {
        console.error('[Updates] Changelog error:', err);
        res.status(500).json({ error: 'Failed to get changelog' });
    }
});

// ============================================================================
// START UPDATE
// ============================================================================

/**
 * POST /orgs/:orgId/update-start
 * Begin an update operation (delegates execution to orchestrator)
 * Requires admin role.
 */
router.post('/orgs/:orgId/update-start', requireOrgMembership, requireOrgRole('admin'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user?.id;

        // Rate limit: 1 update per hour
        const lastUpdate = updateCooldowns.get(orgId);
        if (lastUpdate && (Date.now() - lastUpdate) < UPDATE_COOLDOWN_MS) {
            const retryAfter = Math.ceil((lastUpdate + UPDATE_COOLDOWN_MS - Date.now()) / 1000);
            return res.status(429).json({ error: 'Update rate limited', retryAfter });
        }

        // Check there's no active operation
        const activeOp = prepare(`
            SELECT id, status FROM update_operations
            WHERE org_id = ? AND status IN ('pending', 'running')
            LIMIT 1
        `).get(orgId);

        if (activeOp) {
            return res.status(409).json({ error: 'An update is already in progress', operation_id: activeOp.id });
        }

        // Get the target version from latest check
        const latestCheck = prepare(`
            SELECT available_version FROM update_checks
            WHERE org_id = ? AND update_available = 1
            ORDER BY checked_at DESC LIMIT 1
        `).get(orgId);

        if (!latestCheck?.available_version) {
            return res.status(400).json({ error: 'No update available. Run a check first.' });
        }

        const currentVersion = getCurrentVersion();
        const targetVersion = latestCheck.available_version;

        // Get settings for auto-backup preference
        const settings = prepare(`SELECT auto_backup_before_update FROM update_settings WHERE org_id = ?`).get(orgId);
        const autoBackup = settings?.auto_backup_before_update !== 0;

        // Create the operation record
        const opId = ulid();
        const steps = [
            { name: 'preflight', label: 'Preflight checks', status: 'pending' },
            ...(autoBackup ? [{ name: 'backup', label: 'Pre-update backup', status: 'pending' }] : []),
            { name: 'git_pull', label: 'Pull latest code', status: 'pending' },
            { name: 'build', label: 'Build services', status: 'pending' },
            { name: 'restart', label: 'Restart services', status: 'pending' },
            { name: 'verify', label: 'Post-update verification', status: 'pending' }
        ];

        prepare(`
            INSERT INTO update_operations (id, org_id, from_version, to_version, status, steps_json, performed_by)
            VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `).run(opId, orgId, currentVersion, targetVersion, JSON.stringify(steps), userId);

        updateCooldowns.set(orgId, Date.now());

        // Audit: update started
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'update.started',
            targetType: 'update_operation',
            targetId: opId,
            metadata: { from_version: currentVersion, to_version: targetVersion, auto_backup: autoBackup }
        });

        // Delegate execution to orchestrator
        try {
            const orchestratorRes = await fetch(`${ORCHESTRATOR_URL}/update/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers.authorization
                },
                body: JSON.stringify({
                    operation_id: opId,
                    org_id: orgId,
                    from_version: currentVersion,
                    to_version: targetVersion,
                    auto_backup: autoBackup,
                    steps
                }),
                signal: AbortSignal.timeout(10000)
            });

            if (!orchestratorRes.ok) {
                const text = await orchestratorRes.text();
                throw new Error(`Orchestrator error: ${orchestratorRes.status} ${text.slice(0, 200)}`);
            }

            // Update operation status to running
            prepare(`
                UPDATE update_operations SET status = 'running', started_at = datetime('now')
                WHERE id = ?
            `).run(opId);

            res.json({
                operation_id: opId,
                from_version: currentVersion,
                to_version: targetVersion,
                status: 'running',
                steps
            });
        } catch (orchErr) {
            // Mark operation as failed if orchestrator is unreachable
            prepare(`
                UPDATE update_operations SET status = 'failed', error_message = ?, error_step = 'preflight'
                WHERE id = ?
            `).run(`Orchestrator unreachable: ${orchErr.message}`, opId);

            // Audit: update failed to start
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'update.failed',
                targetType: 'update_operation',
                targetId: opId,
                status: 'failure',
                metadata: { error: orchErr.message, step: 'preflight' }
            });

            res.status(502).json({ error: `Could not start update: ${orchErr.message}`, operation_id: opId });
        }
    } catch (err) {
        console.error('[Updates] Start error:', err);
        res.status(500).json({ error: 'Failed to start update' });
    }
});

// ============================================================================
// UPDATE PROGRESS (SSE proxy from orchestrator)
// ============================================================================

/**
 * GET /orgs/:orgId/update-progress
 * SSE stream proxied from orchestrator for real-time update progress
 */
router.get('/orgs/:orgId/update-progress', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;

        // Get active operation
        const activeOp = prepare(`
            SELECT id FROM update_operations
            WHERE org_id = ? AND status IN ('pending', 'running')
            ORDER BY created_at DESC LIMIT 1
        `).get(orgId);

        if (!activeOp) {
            return res.status(404).json({ error: 'No active update operation' });
        }

        // Set up SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // Proxy SSE from orchestrator
        try {
            const controller = new AbortController();
            const orchRes = await fetch(`${ORCHESTRATOR_URL}/update/progress?operation_id=${activeOp.id}`, {
                headers: { 'Authorization': req.headers.authorization },
                signal: controller.signal
            });

            if (!orchRes.ok) {
                res.write(`data: ${JSON.stringify({ error: 'Orchestrator unavailable' })}\n\n`);
                res.end();
                return;
            }

            // Pipe the SSE stream
            const reader = orchRes.body.getReader();
            const decoder = new TextDecoder();

            req.on('close', () => controller.abort());

            const pump = async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value, { stream: true });
                        res.write(chunk);

                        // Update operation record with current step from SSE data
                        try {
                            const lines = chunk.split('\n');
                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const data = JSON.parse(line.slice(6));
                                    if (data.step) {
                                        prepare(`UPDATE update_operations SET current_step = ? WHERE id = ?`)
                                            .run(data.step, activeOp.id);
                                    }
                                    if (data.steps) {
                                        prepare(`UPDATE update_operations SET steps_json = ? WHERE id = ?`)
                                            .run(JSON.stringify(data.steps), activeOp.id);
                                    }
                                    if (data.status === 'completed') {
                                        prepare(`UPDATE update_operations SET status = 'completed', completed_at = datetime('now'), duration_ms = ? WHERE id = ?`)
                                            .run(data.duration_ms || null, activeOp.id);
                                    }
                                    if (data.status === 'failed') {
                                        prepare(`UPDATE update_operations SET status = 'failed', error_message = ?, error_step = ? WHERE id = ?`)
                                            .run(data.error || 'Unknown error', data.step || null, activeOp.id);
                                    }
                                }
                            }
                        } catch { /* best effort state tracking */ }
                    }
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('[Updates] SSE proxy error:', err.message);
                    }
                }
                res.end();
            };

            pump();
        } catch (err) {
            res.write(`data: ${JSON.stringify({ error: `SSE proxy failed: ${err.message}` })}\n\n`);
            res.end();
        }
    } catch (err) {
        console.error('[Updates] Progress error:', err);
        res.status(500).json({ error: 'Failed to get update progress' });
    }
});

// ============================================================================
// CANCEL UPDATE
// ============================================================================

/**
 * POST /orgs/:orgId/update-cancel
 * Cancel an in-progress update
 */
router.post('/orgs/:orgId/update-cancel', requireOrgMembership, requireOrgRole('admin'), async (req, res) => {
    try {
        const { orgId } = req.params;

        const activeOp = prepare(`
            SELECT id FROM update_operations
            WHERE org_id = ? AND status IN ('pending', 'running')
            ORDER BY created_at DESC LIMIT 1
        `).get(orgId);

        if (!activeOp) {
            return res.status(404).json({ error: 'No active update to cancel' });
        }

        // Tell orchestrator to cancel
        try {
            await fetch(`${ORCHESTRATOR_URL}/update/cancel`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers.authorization
                },
                body: JSON.stringify({ operation_id: activeOp.id }),
                signal: AbortSignal.timeout(10000)
            });
        } catch { /* best effort */ }

        prepare(`
            UPDATE update_operations SET status = 'cancelled', completed_at = datetime('now')
            WHERE id = ?
        `).run(activeOp.id);

        // Audit: update cancelled
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user?.id,
            action: 'update.cancelled',
            targetType: 'update_operation',
            targetId: activeOp.id,
            metadata: {}
        });

        res.json({ success: true, operation_id: activeOp.id, status: 'cancelled' });
    } catch (err) {
        console.error('[Updates] Cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel update' });
    }
});

// ============================================================================
// ROLLBACK
// ============================================================================

/**
 * POST /orgs/:orgId/update-rollback
 * Rollback = restore from pre-update backup + git checkout previous tag
 */
router.post('/orgs/:orgId/update-rollback', requireOrgMembership, requireOrgRole('admin'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { operation_id } = req.body || {};

        // Find the operation to rollback
        const targetOp = operation_id
            ? prepare(`SELECT * FROM update_operations WHERE id = ? AND org_id = ?`).get(operation_id, orgId)
            : prepare(`
                SELECT * FROM update_operations
                WHERE org_id = ? AND status IN ('completed', 'failed')
                ORDER BY created_at DESC LIMIT 1
              `).get(orgId);

        if (!targetOp) {
            return res.status(404).json({ error: 'No update operation found to rollback' });
        }

        if (!targetOp.pre_update_backup_id) {
            return res.status(400).json({ error: 'No pre-update backup associated with this operation. Manual rollback required.' });
        }

        // Create a rollback operation record
        const rollbackId = ulid();
        prepare(`
            INSERT INTO update_operations (id, org_id, from_version, to_version, status, performed_by, current_step)
            VALUES (?, ?, ?, ?, 'running', ?, 'rollback')
        `).run(rollbackId, orgId, targetOp.to_version, targetOp.from_version, req.user?.id);

        // Audit: rollback started
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user?.id,
            action: 'update.rollback_started',
            targetType: 'update_operation',
            targetId: rollbackId,
            metadata: { rolling_back_from: targetOp.to_version, rolling_back_to: targetOp.from_version, backup_id: targetOp.pre_update_backup_id }
        });

        // Delegate rollback to orchestrator
        try {
            const orchRes = await fetch(`${ORCHESTRATOR_URL}/update/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers.authorization
                },
                body: JSON.stringify({
                    operation_id: rollbackId,
                    org_id: orgId,
                    from_version: targetOp.to_version,
                    to_version: targetOp.from_version,
                    rollback: true,
                    restore_backup_id: targetOp.pre_update_backup_id,
                    steps: [
                        { name: 'git_checkout', label: 'Checkout previous version', status: 'pending' },
                        { name: 'restore', label: 'Restore pre-update backup', status: 'pending' },
                        { name: 'build', label: 'Rebuild services', status: 'pending' },
                        { name: 'restart', label: 'Restart services', status: 'pending' },
                        { name: 'verify', label: 'Post-rollback verification', status: 'pending' }
                    ]
                }),
                signal: AbortSignal.timeout(10000)
            });

            if (!orchRes.ok) {
                throw new Error(`Orchestrator: ${orchRes.status}`);
            }

            res.json({
                operation_id: rollbackId,
                rolling_back_to: targetOp.from_version,
                backup_id: targetOp.pre_update_backup_id,
                status: 'running'
            });
        } catch (orchErr) {
            prepare(`UPDATE update_operations SET status = 'failed', error_message = ? WHERE id = ?`)
                .run(`Rollback failed: ${orchErr.message}`, rollbackId);

            // Audit: rollback failed
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: req.user?.id,
                action: 'update.rollback_failed',
                targetType: 'update_operation',
                targetId: rollbackId,
                status: 'failure',
                metadata: { error: orchErr.message }
            });

            res.status(502).json({ error: `Rollback failed: ${orchErr.message}` });
        }
    } catch (err) {
        console.error('[Updates] Rollback error:', err);
        res.status(500).json({ error: 'Failed to rollback update' });
    }
});

// ============================================================================
// UPDATE HISTORY
// ============================================================================

/**
 * GET /orgs/:orgId/update-history
 * Past update operations with pagination
 */
router.get('/orgs/:orgId/update-history', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { limit = 20, offset = 0 } = req.query;

        const total = prepare(`SELECT COUNT(*) as count FROM update_operations WHERE org_id = ?`).get(orgId)?.count || 0;

        const operations = prepare(`
            SELECT * FROM update_operations
            WHERE org_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `).all(orgId, parseInt(limit), parseInt(offset));

        res.json({
            operations,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (err) {
        console.error('[Updates] History error:', err);
        res.status(500).json({ error: 'Failed to get update history' });
    }
});

// ============================================================================
// UPDATE SETTINGS
// ============================================================================

/**
 * GET /orgs/:orgId/update-settings
 * Get update settings for this org
 */
router.get('/orgs/:orgId/update-settings', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;

        const settings = prepare(`SELECT * FROM update_settings WHERE org_id = ?`).get(orgId);

        res.json(settings || {
            org_id: orgId,
            auto_check_enabled: 1,
            check_interval_hours: 6,
            auto_backup_before_update: 1,
            maintenance_window_enabled: 0,
            maintenance_day: null,
            maintenance_hour: null,
            notification_lead_hours: 24,
            release_channel: 'stable'
        });
    } catch (err) {
        console.error('[Updates] Settings get error:', err);
        res.status(500).json({ error: 'Failed to get update settings' });
    }
});

/**
 * PATCH /orgs/:orgId/update-settings
 * Update settings (admin only)
 */
router.patch('/orgs/:orgId/update-settings', requireOrgMembership, requireOrgRole('admin'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const allowed = [
            'auto_check_enabled', 'check_interval_hours', 'auto_backup_before_update',
            'maintenance_window_enabled', 'maintenance_day', 'maintenance_hour',
            'notification_lead_hours', 'release_channel'
        ];

        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        // Validate release_channel
        if (updates.release_channel && !['stable', 'beta', 'nightly'].includes(updates.release_channel)) {
            return res.status(400).json({ error: 'Invalid release channel' });
        }

        // Upsert settings
        const existing = prepare(`SELECT org_id FROM update_settings WHERE org_id = ?`).get(orgId);

        if (existing) {
            const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
            const values = [...Object.values(updates), orgId];
            prepare(`UPDATE update_settings SET ${setClauses}, updated_at = datetime('now') WHERE org_id = ?`).run(...values);
        } else {
            const cols = ['org_id', ...Object.keys(updates)];
            const placeholders = cols.map(() => '?').join(', ');
            prepare(`INSERT INTO update_settings (${cols.join(', ')}) VALUES (${placeholders})`).run(orgId, ...Object.values(updates));
        }

        // Audit: settings changed
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user?.id,
            action: 'update.settings_changed',
            targetType: 'update_settings',
            targetId: orgId,
            metadata: { changed_fields: Object.keys(updates) }
        });

        const settings = prepare(`SELECT * FROM update_settings WHERE org_id = ?`).get(orgId);
        res.json(settings);
    } catch (err) {
        console.error('[Updates] Settings patch error:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

export default router;
