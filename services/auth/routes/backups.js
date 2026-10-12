/**
 * Backup Routes for QuoxCORE Auth Service
 * Phase D.1: Backup, Restore, and Migration
 *
 * Provides API endpoints for:
 * - Creating and managing backups
 * - Verifying backup integrity (SHA-256)
 * - Restoring from backups
 * - Managing backup schedules
 * - Audit logging with DEFCON levels
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, getPagination, formatPaginatedResponse, safeJsonParse } from '../utils/helpers.js';
import { emitItemCreated, emitStatsUpdate } from '../utils/inboxEvents.js';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import * as path from 'path';
import { getInstanceSetting, getSetting } from '../lib/configResolver.js';

const router = Router();

// SSE progress emitters for restore operations
const restoreProgressEmitters = new Map();

function emitRestoreProgress(restoreId, event) {
    const listeners = restoreProgressEmitters.get(restoreId) || [];
    for (const listener of listeners) {
        try { listener(event); } catch { /* ignore broken connections */ }
    }
    if (event.type === 'complete') {
        restoreProgressEmitters.delete(restoreId);
    }
}

// All routes require authentication
router.use(requireAuth);

// Configuration
const BACKUP_ROOT = process.env.BACKUP_ROOT || '/opt/quoxcore/backups';
import { tryLaunchDetachedBackup, isBackupContainerRunning } from '../lib/backupDetach.js';
import { classifyBackupExit, parseSkippedRequired, degradedMessage, isBackupComplete } from '../lib/backupStatus.js';
const BACKUP_SCRIPT = process.env.BACKUP_SCRIPT || '/app/project/scripts/backup-quox.sh';

// DEFCON levels for operations
const DEFCON_LEVELS = {
    BACKUP_CREATE: 'GREEN',
    BACKUP_VERIFY: 'GREEN',
    BACKUP_DELETE: 'BLUE',
    RESTORE_DRY_RUN: 'BLUE',
    RESTORE_SELECTIVE: 'AMBER',
    RESTORE_FULL: 'ORANGE',
    RESTORE_FAILED: 'RED',
    BACKUP_FAILED: 'RED'
};

// ============================================================================
// AUDIT LOGGING
// ============================================================================

/**
 * Log a backup operation to the dedicated backup audit table
 */
function logBackupAudit(event) {
    const id = ulid();
    try {
        prepare(`
            INSERT INTO backup_audit_log (id, org_id, operation, defcon_level, backup_id, restore_id, operator, operator_id, result, duration_ms, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            event.orgId || null,
            event.operation,
            event.defconLevel || 'GREEN',
            event.backupId || null,
            event.restoreId || null,
            event.operator || 'system',
            event.operatorId || null,
            event.result || 'pending',
            event.durationMs || null,
            JSON.stringify(event.metadata || {})
        );
    } catch (error) {
        console.error('Failed to log backup audit:', error);
    }
    return id;
}

// ============================================================================
// BACKUP COMPONENTS
// ============================================================================

/**
 * GET /orgs/:orgId/backup-components
 * List available backup components
 */
router.get('/orgs/:orgId/backup-components', requireOrgMembership, async (req, res) => {
    try {
        const components = prepare(`
            SELECT * FROM backup_components ORDER BY priority
        `).all();

        // Parse source_paths_json for each component
        const parsed = components.map(c => ({
            ...c,
            sourcePaths: safeJsonParse(c.source_paths_json, []),
            defaultEnabled: c.default_enabled === 1
        }));

        res.json({ components: parsed });
    } catch (error) {
        console.error('Error listing backup components:', error);
        res.status(500).json({ error: 'Failed to list backup components' });
    }
});

// ============================================================================
// BACKUPS CRUD
// ============================================================================

// Stale backup marker.
//
// 2026-08-19: this was 30 minutes while a REPAIRED FULL BACKUP TAKES 31
// (20260819_103803: started 10:38, archive completed 11:09). So a backup that
// was working correctly got stamped "Timed out after 30.0 minutes" every single
// night, and the owner reasonably read that as backups still being broken.
// The threshold was shorter than the job it measured.
//
// TWO THINGS THIS IS NOT, both of which cost real confusion:
//   1. It is NOT a timeout. Nothing is killed. It only UPDATES a database row.
//      The 02:00 run on 2026-08-19 was still writing its tarball at 14:09,
//      twelve hours after being marked failed, which is why disk kept filling.
//   2. It is NOT authoritative. The completion path below sets 'completed'
//      with no status guard, so a run marked stale and then finishing silently
//      overwrites the failure and nobody learns it overran.
//
// Raised well clear of a real run and made overridable, because the honest
// number depends on the estate's size and will drift as volt.db grows.
const STALE_BACKUP_MINUTES_DEFAULT = Number(process.env.BACKUP_STALE_MINUTES) > 0
    ? Number(process.env.BACKUP_STALE_MINUTES)
    : 180;

// VAULT-INTEG P17: last value markStaleBackups() actually resolved (env or
// stored instance override) — read by the completion-message text below so
// an operator sees the threshold that was actually in effect for the tick
// that marked a run stale, not a frozen module-load constant.
let staleBackupMinutesLastResolved = STALE_BACKUP_MINUTES_DEFAULT;

// VAULT-INTEG P17: was a bare process.env read frozen at module load — now
// resolved via configResolver.getInstanceSetting() (instance-wide: applies
// across every org's backups on one shared check) fresh on EVERY
// markStaleBackups() call, which already runs on a real recurring interval
// (every 5 minutes, see below) — so a stored/env override takes effect
// within one tick, genuinely live, no restart needed. Fail-safe: any
// resolver failure (no service key, network error, no override stored)
// falls back to the env value.
async function resolveStaleBackupMinutes(deps = {}) {
    try {
        const resolved = await getInstanceSetting('BACKUP_STALE_MINUTES', deps);
        if (resolved && resolved.value !== undefined) {
            const n = Number(resolved.value);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch (err) {
        console.error('[Backup] BACKUP_STALE_MINUTES instance-setting resolver failed, falling back to env —', err.message);
    }
    return STALE_BACKUP_MINUTES_DEFAULT;
}

async function markStaleBackups(deps = {}) {
    try {
        const staleBackupMinutes = await resolveStaleBackupMinutes();
        staleBackupMinutesLastResolved = staleBackupMinutes;
        // #727: a row whose detached container is still running is NOT stale.
        // The container enforces its own deadline, and a rebuilt auth adopts it.
        const candidates = prepare(`
            SELECT id, container_id FROM backups
            WHERE status = 'running'
                AND created_at < datetime('now', '-' || ? || ' minutes')
        `).all(staleBackupMinutes);
        let marked = 0;
        for (const row of candidates) {
            if (row.container_id) {
                const running = await isBackupContainerRunning(row.id, deps);
                if (running !== false) continue; // running, or docker unreachable: do not guess
            }
            const r = prepare(`
                UPDATE backups SET status = 'failed',
                    error_message = 'No completion recorded after ' || ? || ' minutes — marked stale. The backup PROCESS is not killed by this and may still be running; check for a running backup-quox.sh before starting another.',
                    completed_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = ? AND status = 'running'
            `).run(staleBackupMinutes, row.id);
            marked += r.changes;
        }
        if (marked > 0) {
            console.log(`[Backup] Marked ${marked} stale backup(s) as failed (>${staleBackupMinutes}min)`);
        }
    } catch (err) {
        console.error('[Backup] Failed to check stale backups:', err.message);
    }
}

// Run stale check on startup and every 5 minutes
markStaleBackups();
setInterval(() => markStaleBackups(), 5 * 60 * 1000);

/**
 * GET /orgs/:orgId/backups
 * List all backups with filtering
 */
router.get('/orgs/:orgId/backups', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { status, type, verified } = req.query;
        const pagination = getPagination(req.query);

        let whereClause = 'WHERE b.org_id = ?';
        const params = [orgId];

        if (status) {
            whereClause += ' AND b.status = ?';
            params.push(status);
        }

        if (type) {
            whereClause += ' AND b.backup_type = ?';
            params.push(type);
        }

        if (verified === 'true') {
            whereClause += ' AND b.status = ?';
            params.push('verified');
        }

        // Get total count
        const countResult = prepare(`SELECT COUNT(*) as count FROM backups b ${whereClause}`).get(...params);
        const total = countResult.count;

        // Get backups with pagination
        const backups = prepare(`
            SELECT b.*, u.display_name as created_by_name
            FROM backups b
            LEFT JOIN users u ON b.created_by = u.id
            ${whereClause}
            ORDER BY b.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        // Parse JSON fields
        const parsed = backups.map(b => ({
            ...b,
            manifest: safeJsonParse(b.manifest_json, null),
            components: safeJsonParse(b.components_json, []),
            verification: safeJsonParse(b.verification_json, null)
        }));

        res.json(formatPaginatedResponse(parsed, total, pagination));
    } catch (error) {
        console.error('Error listing backups:', error);
        res.status(500).json({ error: 'Failed to list backups' });
    }
});

/**
 * GET /orgs/:orgId/backups/:backupId
 * Get backup details
 */
router.get('/orgs/:orgId/backups/:backupId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, backupId } = req.params;

        const backup = prepare(`
            SELECT b.*, u.display_name as created_by_name
            FROM backups b
            LEFT JOIN users u ON b.created_by = u.id
            WHERE b.id = ? AND b.org_id = ?
        `).get(backupId, orgId);

        if (!backup) {
            return res.status(404).json({ error: 'Backup not found' });
        }

        res.json({
            backup: {
                ...backup,
                manifest: safeJsonParse(backup.manifest_json, null),
                components: safeJsonParse(backup.components_json, []),
                verification: safeJsonParse(backup.verification_json, null)
            }
        });
    } catch (error) {
        console.error('Error getting backup:', error);
        res.status(500).json({ error: 'Failed to get backup' });
    }
});

/**
 * POST /orgs/:orgId/backups
 * Create a new backup
 */
router.post('/orgs/:orgId/backups', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { backup_type = 'full', name, description, components } = req.body;
        const userId = req.user.id;
        const userEmail = req.user.primary_email;

        // Check permission
        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions. Requires ORG_MANAGE_SETTINGS capability.' });
        }

        const backupId = ulid();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
        const backupName = name || `Backup ${timestamp}`;

        // Validate components if selective backup
        if (backup_type === 'selective' && (!components || components.length === 0)) {
            return res.status(400).json({ error: 'Selective backup requires at least one component' });
        }

        // Create backup record
        prepare(`
            INSERT INTO backups (id, org_id, backup_type, name, description, status, components_json, created_by, started_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?, datetime('now'))
        `).run(backupId, orgId, backup_type, backupName, description || null,
               components ? JSON.stringify(components) : null, userId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'backup.created',
            targetType: 'backup',
            targetId: backupId,
            metadata: { backup_type, components }
        });

        // Log to backup audit
        logBackupAudit({
            orgId,
            operation: 'BACKUP_STARTED',
            defconLevel: DEFCON_LEVELS.BACKUP_CREATE,
            backupId,
            operator: userEmail,
            operatorId: userId,
            result: 'pending',
            metadata: { backup_type, components, name: backupName }
        });

        // Start backup process asynchronously
        runBackupProcess(backupId, orgId, backup_type, components, userEmail, userId);

        res.status(201).json({
            backup: {
                id: backupId,
                status: 'running',
                backup_type,
                name: backupName,
                message: 'Backup started. Poll /backups/:id for status updates.'
            }
        });
    } catch (error) {
        console.error('Error creating backup:', error);
        res.status(500).json({ error: 'Failed to create backup' });
    }
});

/**
 * DELETE /orgs/:orgId/backups/:backupId
 * Delete a backup
 */
router.delete('/orgs/:orgId/backups/:backupId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, backupId } = req.params;
        const userId = req.user.id;
        const userEmail = req.user.primary_email;

        // Check permission
        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const backup = prepare(`SELECT * FROM backups WHERE id = ? AND org_id = ?`).get(backupId, orgId);
        if (!backup) {
            return res.status(404).json({ error: 'Backup not found' });
        }

        // Delete archive file if it exists
        if (backup.archive_path && existsSync(backup.archive_path)) {
            try {
                await fs.unlink(backup.archive_path);
            } catch (e) {
                console.warn('Failed to delete archive file:', e.message);
            }
        }

        // Delete from database
        prepare(`DELETE FROM backups WHERE id = ?`).run(backupId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'backup.deleted',
            targetType: 'backup',
            targetId: backupId,
            metadata: { name: backup.name }
        });

        logBackupAudit({
            orgId,
            operation: 'BACKUP_DELETED',
            defconLevel: DEFCON_LEVELS.BACKUP_DELETE,
            backupId,
            operator: userEmail,
            operatorId: userId,
            result: 'success',
            metadata: { name: backup.name, sizeBytes: backup.archive_size_bytes }
        });

        res.json({ message: 'Backup deleted successfully' });
    } catch (error) {
        console.error('Error deleting backup:', error);
        res.status(500).json({ error: 'Failed to delete backup' });
    }
});

// ============================================================================
// VERIFICATION
// ============================================================================

/**
 * POST /orgs/:orgId/backups/:backupId/verify
 * Verify backup integrity using SHA-256 checksums
 */
router.post('/orgs/:orgId/backups/:backupId/verify', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, backupId } = req.params;
        const userId = req.user.id;
        const userEmail = req.user.primary_email;

        const backup = prepare(`SELECT * FROM backups WHERE id = ? AND org_id = ?`).get(backupId, orgId);

        if (!backup) {
            return res.status(404).json({ error: 'Backup not found' });
        }

        if (backup.status !== 'completed' && backup.status !== 'verified' && backup.status !== 'degraded') {
            return res.status(400).json({ error: 'Can only verify completed backups' });
        }

        if (!backup.archive_path || !existsSync(backup.archive_path)) {
            return res.status(400).json({ error: 'Backup archive not found' });
        }

        // Update status
        prepare(`UPDATE backups SET status = 'verifying', updated_at = datetime('now') WHERE id = ?`).run(backupId);

        logBackupAudit({
            orgId,
            operation: 'BACKUP_VERIFY_STARTED',
            defconLevel: DEFCON_LEVELS.BACKUP_VERIFY,
            backupId,
            operator: userEmail,
            operatorId: userId,
            result: 'pending'
        });

        // Run verification asynchronously
        verifyBackupIntegrity(backupId, orgId, backup.archive_path, safeJsonParse(backup.manifest_json, null), userEmail, userId);

        res.json({
            message: 'Verification started',
            status: 'verifying'
        });
    } catch (error) {
        console.error('Error starting verification:', error);
        res.status(500).json({ error: 'Failed to start verification' });
    }
});

// ============================================================================
// RESTORE
// ============================================================================

/**
 * POST /orgs/:orgId/backups/:backupId/restore
 * Restore from a backup (supports dry-run)
 */
router.post('/orgs/:orgId/backups/:backupId/restore', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, backupId } = req.params;
        const { dry_run = true, components } = req.body;
        const userId = req.user.id;
        const userEmail = req.user.primary_email;

        // Check permission
        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const backup = prepare(`SELECT * FROM backups WHERE id = ? AND org_id = ?`).get(backupId, orgId);

        if (!backup) {
            return res.status(404).json({ error: 'Backup not found' });
        }

        if (backup.status !== 'completed' && backup.status !== 'verified' && backup.status !== 'degraded') {
            return res.status(400).json({ error: 'Can only restore from completed, verified or degraded backups' });
        }

        if (!backup.archive_path || !existsSync(backup.archive_path)) {
            return res.status(400).json({ error: 'Backup archive not found' });
        }

        const restoreId = ulid();
        const isDryRun = dry_run === true || dry_run === 'true';

        // Determine DEFCON level
        let defconLevel = DEFCON_LEVELS.RESTORE_FULL;
        if (isDryRun) {
            defconLevel = DEFCON_LEVELS.RESTORE_DRY_RUN;
        } else if (components && components.length > 0) {
            defconLevel = DEFCON_LEVELS.RESTORE_SELECTIVE;
        }

        // Create restore operation record
        prepare(`
            INSERT INTO restore_operations (id, org_id, backup_id, dry_run, components_json, status, performed_by, started_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, datetime('now'))
        `).run(restoreId, orgId, backupId, isDryRun ? 1 : 0,
               components ? JSON.stringify(components) : null, userId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: isDryRun ? 'restore.dry_run' : 'restore.started',
            targetType: 'restore',
            targetId: restoreId,
            metadata: { backup_id: backupId, components, dry_run: isDryRun }
        });

        logBackupAudit({
            orgId,
            operation: isDryRun ? 'RESTORE_DRY_RUN' : 'RESTORE_STARTED',
            defconLevel,
            backupId,
            restoreId,
            operator: userEmail,
            operatorId: userId,
            result: 'pending',
            metadata: { components, dry_run: isDryRun }
        });

        // Run restore asynchronously
        runRestoreProcess(restoreId, orgId, backup, components, isDryRun, userEmail, userId);

        res.status(201).json({
            restore: {
                id: restoreId,
                status: 'running',
                dry_run: isDryRun,
                message: isDryRun
                    ? 'Dry-run started. No changes will be made.'
                    : 'Restore started. Poll /restore-operations/:id for status.'
            }
        });
    } catch (error) {
        console.error('Error starting restore:', error);
        res.status(500).json({ error: 'Failed to start restore' });
    }
});

/**
 * GET /orgs/:orgId/restore-operations/:restoreId
 * Get restore operation status
 */
router.get('/orgs/:orgId/restore-operations/:restoreId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, restoreId } = req.params;

        const restore = prepare(`
            SELECT r.*, b.name as backup_name, u.display_name as performed_by_name
            FROM restore_operations r
            JOIN backups b ON r.backup_id = b.id
            LEFT JOIN users u ON r.performed_by = u.id
            WHERE r.id = ? AND r.org_id = ?
        `).get(restoreId, orgId);

        if (!restore) {
            return res.status(404).json({ error: 'Restore operation not found' });
        }

        res.json({
            restore: {
                ...restore,
                components: safeJsonParse(restore.components_json, []),
                warnings: safeJsonParse(restore.warnings_json, []),
                preview: safeJsonParse(restore.preview_json, null),
                dry_run: restore.dry_run === 1
            }
        });
    } catch (error) {
        console.error('Error getting restore operation:', error);
        res.status(500).json({ error: 'Failed to get restore operation' });
    }
});

/**
 * GET /orgs/:orgId/restore-operations/:restoreId/progress
 * SSE endpoint for real-time restore progress
 */
router.get('/orgs/:orgId/restore-operations/:restoreId/progress', requireOrgMembership, async (req, res) => {
    const { orgId, restoreId } = req.params;

    const restore = prepare(`SELECT * FROM restore_operations WHERE id = ? AND org_id = ?`).get(restoreId, orgId);
    if (!restore) return res.status(404).json({ error: 'Restore operation not found' });

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    // Register listener
    const listener = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    restoreProgressEmitters.set(restoreId, [...(restoreProgressEmitters.get(restoreId) || []), listener]);

    // If already complete, send final status and close
    if (['completed', 'completed_with_errors', 'failed', 'dry_run_complete'].includes(restore.status)) {
        listener({ type: 'complete', status: restore.status });
        res.end();
        return;
    }

    // Cleanup on close
    req.on('close', () => {
        const listeners = restoreProgressEmitters.get(restoreId) || [];
        restoreProgressEmitters.set(restoreId, listeners.filter(l => l !== listener));
    });
});

/**
 * GET /orgs/:orgId/restore-operations
 * List recent restore operations (for restore history / rollback UI)
 */
router.get('/orgs/:orgId/restore-operations', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { limit = 10 } = req.query;

        const ops = prepare(`
            SELECT r.*, b.name as backup_name, u.display_name as performed_by_name
            FROM restore_operations r
            JOIN backups b ON r.backup_id = b.id
            LEFT JOIN users u ON r.performed_by = u.id
            WHERE r.org_id = ? AND r.dry_run = 0
            ORDER BY r.started_at DESC
            LIMIT ?
        `).all(orgId, parseInt(limit) || 10);

        const items = ops.map(r => ({
            ...r,
            components: safeJsonParse(r.components_json, []),
            warnings: safeJsonParse(r.warnings_json, []),
            dry_run: r.dry_run === 1,
            has_rollback: r.status === 'completed' || r.status === 'completed_with_errors'
        }));

        // Check which ones still have pre-restore snapshots on disk
        for (const item of items) {
            const preRestoreDir = path.join(BACKUP_ROOT, `.pre-restore-${item.id}`);
            item.rollback_available = existsSync(preRestoreDir);
        }

        res.json({ items });
    } catch (error) {
        console.error('Error listing restore operations:', error);
        res.status(500).json({ error: 'Failed to list restore operations' });
    }
});

/**
 * POST /orgs/:orgId/restore-operations/:restoreId/rollback
 * Rollback a restore by applying the pre-restore snapshot
 */
router.post('/orgs/:orgId/restore-operations/:restoreId/rollback', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, restoreId } = req.params;
        const userId = req.user.id;
        const userEmail = req.user.primary_email;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const restore = prepare(`SELECT * FROM restore_operations WHERE id = ? AND org_id = ?`).get(restoreId, orgId);
        if (!restore) return res.status(404).json({ error: 'Restore operation not found' });

        const preRestoreDir = path.join(BACKUP_ROOT, `.pre-restore-${restoreId}`);
        if (!existsSync(preRestoreDir)) {
            return res.status(400).json({ error: 'Pre-restore snapshot no longer exists' });
        }

        // List what's in the snapshot
        const snapshotEntries = await fs.readdir(preRestoreDir);
        if (snapshotEntries.length === 0) {
            return res.status(400).json({ error: 'Pre-restore snapshot is empty' });
        }

        logBackupAudit({
            orgId,
            operation: 'ROLLBACK_STARTED',
            defconLevel: DEFCON_LEVELS.RESTORE_FULL,
            restoreId,
            operator: userEmail,
            operatorId: userId,
            result: 'pending',
            metadata: { components: snapshotEntries }
        });

        // Apply snapshot — each subdirectory is a component_key
        const allComponents = prepare('SELECT * FROM backup_components ORDER BY priority').all();
        const warnings = [];
        let filesRolledBack = 0;

        for (const compKey of snapshotEntries) {
            const comp = allComponents.find(c => c.component_key === compKey);
            if (!comp) {
                warnings.push({ message: `Unknown component: ${compKey}`, severity: 'warning' });
                continue;
            }

            const snapshotPath = path.join(preRestoreDir, compKey);
            const sourcePaths = safeJsonParse(comp.source_paths_json, []);

            for (const rawTarget of sourcePaths) {
                const targetPath = resolveSourcePath(rawTarget);
                if (targetPath.startsWith('docker://') || targetPath.startsWith('rsync://')) continue;

                try {
                    const snapshotFiles = await fs.readdir(snapshotPath);
                    for (const file of snapshotFiles) {
                        const src = path.join(snapshotPath, file);
                        const dest = path.join(path.dirname(targetPath), file);
                        const stat = await fs.stat(src);
                        if (stat.isDirectory()) {
                            await runCommand('rsync', ['-a', '--delete', `${src}/`, `${dest}/`]);
                        } else {
                            await fs.copyFile(src, dest);
                        }
                        filesRolledBack++;
                    }
                } catch (err) {
                    warnings.push({ message: `Rollback of ${compKey} failed: ${err.message}`, severity: 'error' });
                }
            }
        }

        // Mark the original restore as rolled back
        prepare(`UPDATE restore_operations SET status = 'rolled_back' WHERE id = ?`).run(restoreId);

        logBackupAudit({
            orgId,
            operation: 'ROLLBACK_COMPLETED',
            defconLevel: DEFCON_LEVELS.RESTORE_FULL,
            restoreId,
            operator: userEmail,
            operatorId: userId,
            result: warnings.some(w => w.severity === 'error') ? 'partial' : 'success',
            metadata: { filesRolledBack, warnings }
        });

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'restore.rolled_back',
            targetType: 'restore',
            targetId: restoreId,
            metadata: { filesRolledBack }
        });

        res.json({
            success: true,
            filesRolledBack,
            warnings,
            message: `Rolled back ${filesRolledBack} files to pre-restore state`
        });
    } catch (error) {
        console.error('Error rolling back restore:', error);
        res.status(500).json({ error: 'Failed to rollback restore' });
    }
});

// ============================================================================
// SCHEDULES
// ============================================================================

/**
 * GET /orgs/:orgId/backup-schedules
 * List backup schedules
 */
router.get('/orgs/:orgId/backup-schedules', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;

        const schedules = prepare(`
            SELECT s.*, u.display_name as created_by_name,
                   b.name as last_backup_name, b.status as last_backup_status
            FROM backup_schedules s
            LEFT JOIN users u ON s.created_by = u.id
            LEFT JOIN backups b ON s.last_backup_id = b.id
            WHERE s.org_id = ?
            ORDER BY s.created_at DESC
        `).all(orgId);

        const parsed = schedules.map(s => ({
            ...s,
            components: safeJsonParse(s.components_json, []),
            enabled: s.enabled === 1
        }));

        res.json({ schedules: parsed });
    } catch (error) {
        console.error('Error listing schedules:', error);
        res.status(500).json({ error: 'Failed to list schedules' });
    }
});

/**
 * POST /orgs/:orgId/backup-schedules
 * Create a backup schedule
 */
router.post('/orgs/:orgId/backup-schedules', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const {
            name,
            schedule_type = 'daily',
            cron_expression,
            schedule_hour = 2,
            schedule_minute = 0,
            schedule_day_of_week,
            schedule_day_of_month,
            backup_type = 'full',
            components,
            retention_days = 30,
            max_backups = 10
        } = req.body;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        if (!name) {
            return res.status(400).json({ error: 'Schedule name is required' });
        }

        const scheduleId = ulid();

        // Calculate next run time
        const nextRun = calculateNextRun(schedule_type, schedule_hour, schedule_minute, schedule_day_of_week, schedule_day_of_month);

        prepare(`
            INSERT INTO backup_schedules (id, org_id, name, schedule_type, cron_expression, schedule_hour, schedule_minute, schedule_day_of_week, schedule_day_of_month, backup_type, components_json, retention_days, max_backups, next_run_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            scheduleId, orgId, name, schedule_type, cron_expression || null,
            schedule_hour, schedule_minute, schedule_day_of_week || null, schedule_day_of_month || null,
            backup_type, components ? JSON.stringify(components) : null,
            retention_days, max_backups, nextRun, userId
        );

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'backup.schedule_created',
            targetType: 'backup_schedule',
            targetId: scheduleId,
            metadata: { name, schedule_type, backup_type }
        });

        res.status(201).json({
            schedule: {
                id: scheduleId,
                name,
                schedule_type,
                next_run_at: nextRun
            }
        });
    } catch (error) {
        console.error('Error creating schedule:', error);
        res.status(500).json({ error: 'Failed to create schedule' });
    }
});

/**
 * PATCH /orgs/:orgId/backup-schedules/:scheduleId
 * Update a backup schedule
 */
router.patch('/orgs/:orgId/backup-schedules/:scheduleId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, scheduleId } = req.params;
        const updates = req.body;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const schedule = prepare(`SELECT * FROM backup_schedules WHERE id = ? AND org_id = ?`).get(scheduleId, orgId);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }

        // Build update query
        const allowedFields = ['name', 'schedule_type', 'cron_expression', 'schedule_hour', 'schedule_minute',
                              'schedule_day_of_week', 'schedule_day_of_month', 'backup_type', 'enabled',
                              'retention_days', 'max_backups'];
        const sets = [];
        const params = [];

        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                sets.push(`${field} = ?`);
                params.push(field === 'components' ? JSON.stringify(updates[field]) : updates[field]);
            }
        }

        if (updates.components !== undefined) {
            sets.push('components_json = ?');
            params.push(JSON.stringify(updates.components));
        }

        if (sets.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        sets.push('updated_at = datetime(\'now\')');
        params.push(scheduleId);

        prepare(`UPDATE backup_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);

        res.json({ message: 'Schedule updated' });
    } catch (error) {
        console.error('Error updating schedule:', error);
        res.status(500).json({ error: 'Failed to update schedule' });
    }
});

/**
 * DELETE /orgs/:orgId/backup-schedules/:scheduleId
 * Delete a backup schedule
 */
router.delete('/orgs/:orgId/backup-schedules/:scheduleId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, scheduleId } = req.params;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const schedule = prepare(`SELECT * FROM backup_schedules WHERE id = ? AND org_id = ?`).get(scheduleId, orgId);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }

        prepare(`DELETE FROM backup_schedules WHERE id = ?`).run(scheduleId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'backup.schedule_deleted',
            targetType: 'backup_schedule',
            targetId: scheduleId,
            metadata: { name: schedule.name }
        });

        res.json({ message: 'Schedule deleted' });
    } catch (error) {
        console.error('Error deleting schedule:', error);
        res.status(500).json({ error: 'Failed to delete schedule' });
    }
});

// ============================================================================
// AUDIT LOG
// ============================================================================

/**
 * GET /orgs/:orgId/backup-audit-log
 * Get backup audit log entries
 */
router.get('/orgs/:orgId/backup-audit-log', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { operation, defcon_level, backup_id } = req.query;
        const pagination = getPagination(req.query);

        let whereClause = 'WHERE org_id = ?';
        const params = [orgId];

        if (operation) {
            whereClause += ' AND operation = ?';
            params.push(operation);
        }

        if (defcon_level) {
            whereClause += ' AND defcon_level = ?';
            params.push(defcon_level);
        }

        if (backup_id) {
            whereClause += ' AND backup_id = ?';
            params.push(backup_id);
        }

        const countResult = prepare(`SELECT COUNT(*) as count FROM backup_audit_log ${whereClause}`).get(...params);
        const total = countResult.count;

        const entries = prepare(`
            SELECT * FROM backup_audit_log
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        const parsed = entries.map(e => ({
            ...e,
            metadata: safeJsonParse(e.metadata_json, {})
        }));

        res.json(formatPaginatedResponse(parsed, total, pagination));
    } catch (error) {
        console.error('Error getting backup audit log:', error);
        res.status(500).json({ error: 'Failed to get audit log' });
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Run backup process asynchronously
 */
// Maximum time a backup process can run before being killed (5 minutes)
const BACKUP_TIMEOUT_DEFAULT = parseInt(process.env.BACKUP_TIMEOUT_MS || '300000', 10);

// VAULT-INTEG P17: was a bare process.env read frozen at module load — now
// resolved via configResolver.getSetting() (org-scoped: this is a per-run
// budget for the org that requested the backup, not an instance-wide tick
// cadence) fresh on every runBackupProcess() call, which happens once per
// backup request — a stored override applies to the very next backup this
// org runs, no restart needed. Fail-safe: any resolver failure (no service
// key, network error, no override stored) falls back to the env value.
async function resolveBackupTimeoutMs(orgId, deps = {}) {
    try {
        const resolved = await getSetting(orgId, 'BACKUP_TIMEOUT_MS', deps);
        // #728: only a STORED setting overrides. source 'env' is the COLLECTOR's
        // own env (it has no BACKUP_TIMEOUT_MS, so it reported its 300000
        // default), but the backup runs HERE in auth, so auth's env must win.
        if (resolved && resolved.source === 'setting' && resolved.value !== undefined) {
            const n = Number(resolved.value);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch (err) {
        console.error('[Backup] BACKUP_TIMEOUT_MS resolver failed for org=%s, falling back to env —', orgId, err.message);
    }
    return BACKUP_TIMEOUT_DEFAULT;
}

async function runBackupProcess(backupId, orgId, backupType, components, operator, operatorId) {
    const startTime = Date.now();

    try {
        // Determine script mode
        const mode = backupType === 'quick' ? '--quick' : '--full';

        // GTM-G3b: fail HONESTLY when the backup engine is not reachable in
        // this deployment. In baked/public deployments the container has no
        // bind mount of the project dir, so BACKUP_SCRIPT is absent and the
        // spawn used to die with an opaque "spawn ... ENOENT / Exit code -2".
        // backup-quox.sh runs host-side in the public model (it needs the
        // docker socket to dump the data containers), so tell the operator
        // exactly that instead of a cryptic exit code.
        if (!existsSync(BACKUP_SCRIPT)) {
            const duration = Date.now() - startTime;
            const msg = `Backups run host-side in this deployment. The in-container backup engine (${BACKUP_SCRIPT}) is not present in this image, so the dashboard cannot run a backup here. Run \`quox backup create\` on the host (which has Docker access), or follow the backup runbook. Set BACKUP_SCRIPT if the engine lives elsewhere.`;
            console.error(`Backup ${backupId}: ${msg}`);
            prepare(`
                UPDATE backups
                SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ? AND status = 'running'
            `).run(msg, duration, backupId);
            logBackupAudit({
                orgId,
                operation: 'BACKUP_FAILED',
                defconLevel: DEFCON_LEVELS.BACKUP_FAILED,
                backupId,
                operator,
                operatorId,
                result: 'failed',
                durationMs: duration,
                metadata: { error: 'backup_engine_unavailable', script: BACKUP_SCRIPT }
            });
            createBackupNotification(orgId, backupId, false, { error: msg });
            return;
        }

        // Resolved BEFORE spawning so the kill-timer is armed the instant the
        // process starts — no unmonitored gap while the resolver call is in
        // flight.
        const backupTimeoutMs = await resolveBackupTimeoutMs(orgId);

        // #727: prefer a DETACHED one-shot container so an auth rebuild or
        // restart cannot kill a 44 minute run. Falls back to the old child
        // process (honest log line) when docker is unavailable.
        const detached = await tryLaunchDetachedBackup({
            backupId, mode, orgId, origin: 'route', operator, operatorId,
            timeoutMs: backupTimeoutMs, backupScript: BACKUP_SCRIPT, backupRoot: BACKUP_ROOT
        });
        const proc = detached || spawn(BACKUP_SCRIPT, [mode], {
            cwd: '/opt/quoxcore',
            env: { ...process.env, BACKUP_ID: backupId }
        });

        // Kill the process if it exceeds the timeout
        const timeoutTimer = setTimeout(() => {
            const duration = Date.now() - startTime;
            console.error(`Backup ${backupId} timed out after ${duration}ms — killing process`);
            proc.kill('SIGKILL');

            prepare(`
                UPDATE backups
                SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ? AND status = 'running'
            `).run(`Backup timed out after ${Math.round(duration / 1000)}s`, duration, backupId);

            logBackupAudit({
                orgId,
                operation: 'BACKUP_FAILED',
                defconLevel: DEFCON_LEVELS.BACKUP_FAILED,
                backupId,
                operator,
                operatorId,
                result: 'failed',
                durationMs: duration,
                metadata: { error: 'timeout', timeout_ms: backupTimeoutMs }
            });

            createBackupNotification(orgId, backupId, false, {
                error: `Backup timed out after ${Math.round(duration / 1000)}s`
            });
        }, backupTimeoutMs);

        // Ring buffer: keep last 100KB of stdout/stderr to prevent unbounded memory growth
        const MAX_OUTPUT = 100 * 1024;
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT);
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT);
        });

        proc.on('error', (err) => {
            clearTimeout(timeoutTimer);
            const duration = Date.now() - startTime;
            console.error(`Backup process spawn error: ${err.message}`);

            prepare(`
                UPDATE backups
                SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ?
            `).run(`Failed to start backup: ${err.message}`, duration, backupId);

            logBackupAudit({
                orgId,
                operation: 'BACKUP_FAILED',
                defconLevel: DEFCON_LEVELS.BACKUP_FAILED,
                backupId,
                operator,
                operatorId,
                result: 'failed',
                durationMs: duration,
                metadata: { error: err.message, code: err.code }
            });

            createBackupNotification(orgId, backupId, false, {
                error: `Failed to start backup: ${err.message}`
            });
        });

        proc.on('close', async (code) => {
            clearTimeout(timeoutTimer);
            await finalizeBackupRun({ backupId, orgId, operator, operatorId, startTime }, code, stdout, stderr);
            if (proc.release) await proc.release();
        });

    } catch (error) {
        const duration = Date.now() - startTime;

        prepare(`
            UPDATE backups
            SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(error.message, duration, backupId);

        logBackupAudit({
            orgId,
            operation: 'BACKUP_FAILED',
            defconLevel: DEFCON_LEVELS.BACKUP_FAILED,
            backupId,
            operator,
            operatorId,
            result: 'failed',
            durationMs: duration,
            metadata: { error: error.message }
        });
    }
}

/**
 * Turn a finished backup run (exit code + captured output) into the backup row,
 * audit trail and notification. Shared by the live monitor (child process or
 * detached container) and by adoption after an auth restart (#727), so the
 * result parsing exists exactly once.
*/
async function finalizeBackupRun({ backupId, orgId, operator, operatorId, startTime }, code, stdout, stderr) {
    const duration = Date.now() - startTime;

    const exitClass = classifyBackupExit(code);
    if (exitClass === 'completed' || exitClass === 'degraded') {
        const isDegraded = exitClass === 'degraded';
        const skippedRequired = isDegraded ? parseSkippedRequired(stdout) : [];
        // Find the created archive
        const archiveMatch = stdout.match(/Created archive: ([^\s]+\.tar\.gz)/);
        const archivePath = archiveMatch ? archiveMatch[1] : null;

        let archiveSize = 0;
        if (archivePath && existsSync(archivePath)) {
            const stats = await fs.stat(archivePath);
            archiveSize = stats.size;
        }

        // Generate manifest
        const manifest = await generateManifest(archivePath);
        if (manifest && isDegraded) {
            manifest.degraded = true;
            manifest.skipped_required = skippedRequired;
        }

        // Update backup record.
        //
        // If the stale marker already stamped this row 'failed', the run
        // OVERRAN its budget. It did finish, so 'completed' is right, but
        // saying only that erases the fact that it blew the window — which
        // is the signal that the budget or the backup needs changing.
        // Record both rather than letting success quietly overwrite the
        // warning.
        const prior = prepare('SELECT status FROM backups WHERE id = ?').get(backupId);
        const overran = prior && prior.status === 'failed';
        prepare(`
            UPDATE backups
            SET status = ?, archive_path = ?, archive_size_bytes = ?,
                manifest_json = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now'),
                error_message = ?
            WHERE id = ?
        `).run(
            isDegraded ? 'degraded' : 'completed',
            archivePath, archiveSize, JSON.stringify(manifest), duration,
            isDegraded
                ? degradedMessage(skippedRequired)
                : overran
                ? `Completed, but exceeded the ${staleBackupMinutesLastResolved}-minute stale window (took ${Math.round(duration / 60000)} min) — raise BACKUP_STALE_MINUTES or shrink the backup.`
                : null,
            backupId
        );

        // Log success to backup audit + main audit trail
        logBackupAudit({
            orgId,
            operation: isDegraded ? 'BACKUP_DEGRADED' : 'BACKUP_COMPLETED',
            defconLevel: isDegraded ? DEFCON_LEVELS.BACKUP_FAILED : DEFCON_LEVELS.BACKUP_CREATE,
            backupId,
            operator,
            operatorId,
            result: isDegraded ? 'degraded' : 'success',
            durationMs: duration,
            metadata: {
                archivePath,
                sizeBytes: archiveSize,
                filesCount: manifest?.totalFiles || 0,
                ...(isDegraded ? { degraded: true, skippedRequired } : {})
            }
        });
        createAuditEvent({
            orgId,
            actorType: operatorId ? 'user' : 'system',
            actorId: operatorId,
            action: isDegraded ? 'backup.degraded' : 'backup.completed',
            targetType: 'backup',
            targetId: backupId,
            metadata: { archivePath, sizeBytes: archiveSize, durationMs: duration, ...(isDegraded ? { degraded: true, skippedRequired } : {}) }
        });

        // Create inbox notification
        if (isDegraded) {
            createBackupNotification(orgId, backupId, false, {
                degraded: true,
                error: degradedMessage(skippedRequired)
            });
        } else {
            createBackupNotification(orgId, backupId, true, {
                name: `Backup ${backupId}`,
                sizeBytes: archiveSize,
                duration
            });
        }

    } else {
        // Update with failure
        prepare(`
            UPDATE backups
            SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(stderr || `Exit code ${code}`, duration, backupId);

        logBackupAudit({
            orgId,
            operation: 'BACKUP_FAILED',
            defconLevel: DEFCON_LEVELS.BACKUP_FAILED,
            backupId,
            operator,
            operatorId,
            result: 'failed',
            durationMs: duration,
            metadata: { error: stderr, exitCode: code }
        });
        createAuditEvent({
            orgId,
            actorType: operatorId ? 'user' : 'system',
            actorId: operatorId,
            action: 'backup.failed',
            targetType: 'backup',
            targetId: backupId,
            status: 'failed',
            metadata: { error: stderr?.substring(0, 500), exitCode: code, durationMs: duration }
        });

        createBackupNotification(orgId, backupId, false, {
            error: stderr || `Exit code ${code}`
        });
    }
}

/**
 * Generate manifest with SHA-256 checksums
 */
async function generateManifest(archivePath) {
    if (!archivePath || !existsSync(archivePath)) {
        return null;
    }

    try {
        // Calculate archive hash
        const archiveHash = await hashFile(archivePath);

        // For now, return basic manifest
        // Full file-by-file manifest would require extracting archive
        const stats = await fs.stat(archivePath);

        return {
            archiveHash: `sha256:${archiveHash}`,
            archivePath,
            totalBytes: stats.size,
            createdAt: new Date().toISOString(),
            checksumAlgorithm: 'sha256'
        };
    } catch (error) {
        console.error('Failed to generate manifest:', error);
        return null;
    }
}

/**
 * Hash a file using SHA-256
 */
function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);

        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * Verify backup integrity
 */
async function verifyBackupIntegrity(backupId, orgId, archivePath, manifest, operator, operatorId) {
    const startTime = Date.now();

    try {
        // Verify archive hash
        const currentHash = await hashFile(archivePath);
        const expectedHash = manifest?.archiveHash?.replace('sha256:', '') || null;

        const isValid = expectedHash ? currentHash === expectedHash : false;

        // A degraded backup can have a perfectly intact archive and still be
        // missing required components. "valid" speaks for the archive hash only;
        // "complete" is the honest answer to "is everything in it".
        const complete = isBackupComplete(manifest);
        const verification = {
            valid: isValid,
            complete,
            ...(complete ? {} : { skippedRequired: manifest.skipped_required || [], note: 'archive hash valid but backup is INCOMPLETE (required components skipped)' }),
            verifiedAt: new Date().toISOString(),
            archiveHash: `sha256:${currentHash}`,
            expectedHash: manifest?.archiveHash || 'none',
            matches: isValid ? 1 : 0,
            mismatches: isValid ? [] : expectedHash
                ? [{ type: 'archive', expected: expectedHash, actual: currentHash }]
                : [{ type: 'archive', reason: 'no manifest hash to verify against' }]
        };

        // Update backup
        prepare(`
            UPDATE backups
            SET status = ?, verification_json = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(complete ? (isValid ? 'verified' : 'completed') : 'degraded', JSON.stringify(verification), backupId);

        const duration = Date.now() - startTime;

        logBackupAudit({
            orgId,
            operation: isValid ? 'BACKUP_VERIFIED' : 'BACKUP_VERIFICATION_FAILED',
            defconLevel: DEFCON_LEVELS.BACKUP_VERIFY,
            backupId,
            operator,
            operatorId,
            result: isValid ? 'success' : 'failed',
            durationMs: duration,
            metadata: verification
        });
        createAuditEvent({
            orgId,
            actorType: operatorId ? 'user' : 'system',
            actorId: operatorId,
            action: isValid ? 'backup.verified' : 'backup.verification_failed',
            targetType: 'backup',
            targetId: backupId,
            metadata: { valid: isValid, durationMs: duration }
        });

    } catch (error) {
        prepare(`
            UPDATE backups
            SET status = CASE WHEN status = 'degraded' THEN 'degraded' ELSE 'completed' END, verification_json = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify({ valid: false, error: error.message }), backupId);
    }
}

// Project root for resolving relative source paths
// /app/project is the Docker bind mount of the compose working directory
const PROJECT_ROOT = process.env.PROJECT_ROOT || (existsSync('/app/project/docker-compose.yml') ? '/app/project' : '/opt/quoxcore');

// Maps component_key → directory names used by backup-quox.sh inside the archive
const ARCHIVE_DIR_MAP = {
    'auth_db':                  ['databases'],
    'collector_aee_db':         ['databases'],
    'collector_volt_db':        ['databases'],
    'collector_ward_db':        ['databases'],
    'collector_ward_keys':      ['ward-keys'],
    'collector_feedback_db':    ['databases'],
    'collector_wazuh_db':       ['databases'],
    'memory_db':                ['databases'],
    'tasks_db':                 ['databases'],
    'memory_system':            ['quox-memory'],
    'qdrant_vectors':           ['databases/qdrant-data'],
    'user_uploads':             ['user-uploads', 'dashboard-data'],
    'postgres_db':              ['databases'],
    'org_logos':                ['org-logos'],
    'quoxflow_evidence':        ['quoxflow-evidence'],
    'files_data':               ['files-data'],
    'n8n_workflows':            ['n8n-data', 'databases/n8n-data'],
    'quoxagent_playbooks':      ['quoxagent-playbooks'],
    'collector_images':         ['collector-images'],
    'env_secrets':              ['env-secrets', '.'],
    'plugin_configs':           ['plugin-configs', 'src/config/plugins'],
    'agent_definitions':        ['agent-definitions', 'src/config/entities/assistants'],
    'tool_definitions':         ['tool-definitions', 'src/config/entities/tools'],
    'ssl_certs':                ['ssl-certs'],
    'ssh_keys':                 ['ssh-keys'],
    'host_configs':             ['host-configs', '.'],
    'quoxagent_configs':        ['quoxagent-configs'],
    'bastion_fleet_registry':   ['bastion-fleet'],
    'bastion_audit_logs':       ['bastion-audit-logs'],
};

// Maps docker:// paths to {container, path} for resolve
function parseDockerPath(sourcePath) {
    const match = sourcePath.match(/^docker:\/\/([^:]+):(.+)$/);
    if (match) return { container: match[1], containerPath: match[2] };
    return null;
}

// Container map for docker_cp restore
const DOCKER_CP_CONTAINERS = {
    'n8n_workflows':     'n8n',
    'org_logos':         'quox-auth',
    'quoxflow_evidence': 'quox-quoxflow',
};

/**
 * Extract a tar.gz archive to a destination directory
 */
function extractArchive(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        const proc = spawn('tar', ['-xzf', archivePath, '-C', destDir], {
            timeout: 600000 // 10 minutes max
        });

        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 100 * 1024) stderr = stderr.slice(-100 * 1024); });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar extract failed (exit ${code}): ${stderr}`));
        });
        proc.on('error', reject);
    });
}

/**
 * Run a shell command and return { stdout, stderr, code }
 */
function runCommand(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { timeout: 300000, ...options });
        const MAX_OUT = 100 * 1024;
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > MAX_OUT) stdout = stdout.slice(-MAX_OUT); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > MAX_OUT) stderr = stderr.slice(-MAX_OUT); });
        proc.on('close', (code) => resolve({ stdout, stderr, code }));
        proc.on('error', reject);
    });
}

/**
 * Resolve a Docker Compose service name to its running container name.
 * Falls back to common naming patterns if docker compose is unavailable.
 */
async function resolveContainer(serviceName) {
    try {
        const result = await runCommand('docker', ['compose', 'ps', '-q', serviceName], { cwd: PROJECT_ROOT });
        const containerId = result.stdout.trim();
        if (containerId) return containerId;
    } catch { /* fall through */ }
    // Fallback: try common naming conventions
    for (const candidate of [`quox-${serviceName}`, `quox-dashboard-${serviceName}-1`, serviceName]) {
        try {
            const check = await runCommand('docker', ['inspect', '--format', '{{.State.Running}}', candidate]);
            if (check.stdout.trim() === 'true') return candidate;
        } catch { /* try next */ }
    }
    return `quox-${serviceName}`; // last resort
}

/**
 * Resolve a source path (may be relative to project root, absolute, or docker://)
 */
function resolveSourcePath(sourcePath) {
    // docker:// paths are not filesystem paths — return as-is for callers to handle
    if (sourcePath.startsWith('docker://')) return sourcePath;
    // rsync:// paths are remote — return as-is
    if (sourcePath.startsWith('rsync://')) return sourcePath;
    if (path.isAbsolute(sourcePath)) return sourcePath;
    return path.join(PROJECT_ROOT, sourcePath);
}

/**
 * Find component data inside the extracted archive
 * Returns the path to the data or null if not found
 */
async function findComponentInArchive(componentKey, archiveRoot) {
    const candidates = ARCHIVE_DIR_MAP[componentKey] || [];

    for (const candidate of candidates) {
        const candidatePath = path.join(archiveRoot, candidate);
        if (existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    // Fallback: scan top-level dirs for a fuzzy match
    try {
        const entries = await fs.readdir(archiveRoot);
        const keyParts = componentKey.replace(/_/g, '-').toLowerCase();
        for (const entry of entries) {
            if (entry.toLowerCase().includes(keyParts)) {
                return path.join(archiveRoot, entry);
            }
        }
    } catch { /* ignore */ }

    return null;
}

/**
 * Get directory size recursively
 */
async function getDirSize(dirPath) {
    let total = 0;
    let fileCount = 0;
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const sub = await getDirSize(fullPath);
                total += sub.bytes;
                fileCount += sub.files;
            } else {
                const stat = await fs.stat(fullPath);
                total += stat.size;
                fileCount++;
            }
        }
    } catch { /* ignore unreadable dirs */ }
    return { bytes: total, files: fileCount };
}

/**
 * Restore a single component from the extracted archive
 */
async function restoreComponent(component, archiveRoot, preRestoreDir, warnings, tempDir) {
    const sourcePaths = safeJsonParse(component.source_paths_json, []);
    let filesRestored = 0;
    let bytesRestored = 0;

    // Find this component's data in the archive
    const archiveData = await findComponentInArchive(component.component_key, archiveRoot);
    if (!archiveData) {
        warnings.push({
            message: `${component.name} not found in archive — skipped`,
            component: component.component_key,
            severity: 'warning'
        });
        return { files: 0, bytes: 0 };
    }

    // Determine target paths
    for (const rawTarget of sourcePaths) {
        const targetPath = resolveSourcePath(rawTarget);
        const isDockerTarget = rawTarget.startsWith('docker://');
        const dockerTarget = isDockerTarget ? parseDockerPath(rawTarget) : null;
        const isRemotePath = isDockerTarget || targetPath.startsWith('rsync://');
        const targetDir = isRemotePath ? null : path.dirname(targetPath);

        // Create pre-restore backup of existing data (skip for docker/rsync targets)
        if (!isRemotePath) {
            try {
                if (existsSync(targetPath)) {
                    const backupDest = path.join(preRestoreDir, component.component_key, path.basename(targetPath));
                    await fs.mkdir(path.dirname(backupDest), { recursive: true });

                    const stat = await fs.stat(targetPath);
                    if (stat.isDirectory()) {
                        await runCommand('rsync', ['-a', `${targetPath}/`, `${backupDest}/`]);
                    } else {
                        await fs.copyFile(targetPath, backupDest);
                    }
                }
            } catch (err) {
                warnings.push({
                    message: `Pre-restore backup of ${rawTarget} failed: ${err.message}`,
                    component: component.component_key,
                    severity: 'warning'
                });
            }
        }

        // Restore based on method
        try {
            if (targetDir) await fs.mkdir(targetDir, { recursive: true });

            switch (component.backup_method) {
                case 'rsync': {
                    const archiveStat = await fs.stat(archiveData);
                    if (archiveStat.isDirectory()) {
                        const result = await runCommand('rsync', [
                            '-rl', '--delete', '--no-group', '--no-owner', '--no-perms', '--omit-dir-times',
                            `${archiveData}/`,
                            targetPath.endsWith('/') ? targetPath : `${targetPath}/`
                        ]);
                        if (result.code !== 0) {
                            throw new Error(`rsync failed: ${result.stderr}`);
                        }
                    }
                    const size = await getDirSize(targetPath);
                    filesRestored += size.files;
                    bytesRestored += size.bytes;
                    break;
                }

                case 'copy': {
                    // Use read+write to avoid EPERM from metadata preservation in containers
                    // Unlink first if file exists with different ownership
                    const copyFileNoMeta = async (src, dest) => {
                        const content = await fs.readFile(src);
                        try { await fs.unlink(dest); } catch { /* may not exist */ }
                        await fs.writeFile(dest, content);
                    };
                    const archiveStat = await fs.stat(archiveData);
                    if (archiveStat.isDirectory()) {
                        // Find the specific file in the archive directory
                        const basename = path.basename(targetPath);
                        const sourceFile = path.join(archiveData, basename);
                        if (existsSync(sourceFile)) {
                            await copyFileNoMeta(sourceFile, targetPath);
                            const stat = await fs.stat(targetPath);
                            filesRestored++;
                            bytesRestored += stat.size;
                        }
                    } else {
                        await copyFileNoMeta(archiveData, targetPath);
                        const stat = await fs.stat(targetPath);
                        filesRestored++;
                        bytesRestored += stat.size;
                    }
                    break;
                }

                case 'sqlite_backup': {
                    // Find the .db file in the archive
                    const isDockerTarget = rawTarget.startsWith('docker://');
                    const dockerTarget = isDockerTarget ? parseDockerPath(rawTarget) : null;
                    const dbBaseName = isDockerTarget
                        ? path.basename(dockerTarget.containerPath)
                        : path.basename(targetPath);

                    let sourceDb = archiveData;
                    const archiveStat = await fs.stat(archiveData);
                    if (archiveStat.isDirectory()) {
                        sourceDb = path.join(archiveData, dbBaseName);
                        if (!existsSync(sourceDb)) {
                            // Search for any .db file
                            const files = await fs.readdir(archiveData);
                            const dbFile = files.find(f => f.endsWith('.db') || f.endsWith('.sqlite'));
                            if (dbFile) sourceDb = path.join(archiveData, dbFile);
                            else throw new Error(`No database file found in archive for ${component.name}`);
                        }
                    }

                    if (isDockerTarget && dockerTarget) {
                        // Docker-based SQLite: stop container, copy DB + clear WAL/SHM, start container
                        // Must stop first — WAL/SHM files from the running process will corrupt the restored DB
                        const dbCheck = await runCommand('docker', ['inspect', '--format', '{{.State.Running}}', dockerTarget.container]);
                        const wasRunning = dbCheck.stdout.trim() === 'true';
                        if (wasRunning) {
                            await runCommand('docker', ['stop', dockerTarget.container]);
                        }
                        const cpResult = await runCommand('docker', ['cp', sourceDb, `${dockerTarget.container}:${dockerTarget.containerPath}`]);
                        if (cpResult.code !== 0) {
                            // Restart container if we stopped it
                            if (wasRunning) await runCommand('docker', ['start', dockerTarget.container]);
                            throw new Error(`docker cp failed: ${cpResult.stderr}`);
                        }
                        // Remove stale WAL/SHM files that belong to the old database
                        const walPath = dockerTarget.containerPath + '-wal';
                        const shmPath = dockerTarget.containerPath + '-shm';
                        const emptyFile = path.join(tempDir, '_empty_wal_' + component.component_key);
                        await fs.writeFile(emptyFile, '');
                        await runCommand('docker', ['cp', emptyFile, `${dockerTarget.container}:${walPath}`]);
                        await runCommand('docker', ['cp', emptyFile, `${dockerTarget.container}:${shmPath}`]);
                        // Start the container with clean DB
                        if (wasRunning) {
                            await runCommand('docker', ['start', dockerTarget.container]);
                        }
                        const stat = await fs.stat(sourceDb);
                        filesRestored++;
                        bytesRestored += stat.size;
                        warnings.push({
                            message: `${component.name} restored into ${dockerTarget.container} (stopped → copied → started)`,
                            component: component.component_key,
                            severity: 'info'
                        });
                    } else {
                        // Host-accessible SQLite: direct file copy
                        if (existsSync(targetPath)) {
                            const bakPath = `${targetPath}.bak.${Date.now()}`;
                            await fs.copyFile(targetPath, bakPath);
                        }
                        await fs.copyFile(sourceDb, targetPath);
                        const stat = await fs.stat(targetPath);
                        filesRestored++;
                        bytesRestored += stat.size;
                        warnings.push({
                            message: `${component.name} restored — service restart recommended`,
                            component: component.component_key,
                            severity: 'info'
                        });
                    }
                    break;
                }

                case 'docker_cp': {
                    // Determine container from docker:// path or container map
                    let container = DOCKER_CP_CONTAINERS[component.component_key];
                    let containerTarget = rawTarget;

                    // Parse docker:// prefix if present
                    const dockerInfo = parseDockerPath(rawTarget);
                    if (dockerInfo) {
                        container = dockerInfo.container;
                        containerTarget = dockerInfo.containerPath;
                    }

                    if (!container) {
                        throw new Error(`No container mapping for ${component.component_key}`);
                    }

                    // Check container is running
                    const check = await runCommand('docker', ['inspect', '--format', '{{.State.Running}}', container]);
                    if (check.stdout.trim() !== 'true') {
                        throw new Error(`Container ${container} is not running`);
                    }

                    // docker cp archive contents into container
                    const result = await runCommand('docker', [
                        'cp', `${archiveData}/.`, `${container}:${containerTarget}`
                    ]);
                    if (result.code !== 0) {
                        throw new Error(`docker cp failed: ${result.stderr}`);
                    }

                    const size = await getDirSize(archiveData);
                    filesRestored += size.files;
                    bytesRestored += size.bytes;

                    warnings.push({
                        message: `${component.name} restored into container ${container} — container restart recommended`,
                        component: component.component_key,
                        severity: 'info'
                    });
                    break;
                }

                case 'pg_dump': {
                    // Find the .pgdump file in the archive
                    let dumpFile = archiveData;
                    const archiveStat = await fs.stat(archiveData);
                    if (archiveStat.isDirectory()) {
                        const files = await fs.readdir(archiveData);
                        const pgFile = files.find(f => f.endsWith('.pgdump') || f.endsWith('.dump'));
                        if (pgFile) dumpFile = path.join(archiveData, pgFile);
                        else throw new Error(`No .pgdump file found in archive for ${component.name}`);
                    }

                    // Determine container + database from source path
                    const pgContainer = await resolveContainer('postgres');
                    const rawDb = sourcePaths[0] || 'quoxflow';
                    // Guard: extract database name from docker:// paths if someone adds one
                    const pgDatabase = rawDb.startsWith('docker://') ? rawDb.split(':').pop().replace(/^\//, '') : rawDb;

                    // Check container is running
                    const pgCheck = await runCommand('docker', ['inspect', '--format', '{{.State.Running}}', pgContainer]);
                    if (pgCheck.stdout.trim() !== 'true') {
                        throw new Error(`Container ${pgContainer} is not running`);
                    }

                    // Copy dump file into container
                    const cpResult = await runCommand('docker', ['cp', dumpFile, `${pgContainer}:/tmp/restore.pgdump`]);
                    if (cpResult.code !== 0) {
                        throw new Error(`Failed to copy dump into container: ${cpResult.stderr}`);
                    }

                    // Detect POSTGRES_USER from container env
                    const pgUserResult = await runCommand('docker', ['exec', pgContainer, 'printenv', 'POSTGRES_USER']);
                    const pgUser = pgUserResult.stdout.trim() || 'postgres';

                    // Run pg_restore
                    const restoreResult = await runCommand('docker', [
                        'exec', pgContainer,
                        'pg_restore', '-U', pgUser, '--no-owner', '--clean', '--if-exists',
                        '-d', pgDatabase, '/tmp/restore.pgdump'
                    ]);

                    // pg_restore returns non-zero for warnings too, check stderr for actual errors
                    if (restoreResult.code !== 0 && restoreResult.stderr.includes('FATAL')) {
                        throw new Error(`pg_restore failed: ${restoreResult.stderr}`);
                    }

                    // Cleanup
                    await runCommand('docker', ['exec', pgContainer, 'rm', '-f', '/tmp/restore.pgdump']);

                    const dumpStat = await fs.stat(dumpFile);
                    filesRestored++;
                    bytesRestored += dumpStat.size;

                    warnings.push({
                        message: `${component.name} restored via pg_restore — application restart recommended`,
                        component: component.component_key,
                        severity: 'info'
                    });
                    break;
                }

                case 'qdrant_snapshot': {
                    // Try Qdrant snapshot restore API first, fall back to file copy
                    const qdrantHost = process.env.QDRANT_HOST || 'qdrant';
                    let qdrantRestoreOk = false;
                    try {
                        const resp = await fetch(`http://${qdrantHost}:6333/snapshots/recover`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ location: archiveData })
                        });
                        qdrantRestoreOk = resp.ok;
                    } catch { /* fetch failed, fall back */ }

                    if (!qdrantRestoreOk) {
                        // Fallback: docker cp for docker:// targets, rsync for host paths
                        if (isDockerTarget && dockerTarget) {
                            await runCommand('docker', ['stop', dockerTarget.container]);
                            const cpResult = await runCommand('docker', ['cp', `${archiveData}/.`, `${dockerTarget.container}:${dockerTarget.containerPath}`]);
                            await runCommand('docker', ['start', dockerTarget.container]);
                            if (cpResult.code !== 0) {
                                throw new Error(`Qdrant docker cp failed: ${cpResult.stderr}`);
                            }
                        } else {
                            const result = await runCommand('rsync', [
                                '-rl', '--delete', '--no-group', '--no-owner', '--no-perms', '--omit-dir-times',
                                `${archiveData}/`,
                                targetPath.endsWith('/') ? targetPath : `${targetPath}/`
                            ]);
                            if (result.code !== 0) {
                                throw new Error(`Qdrant restore failed: ${result.stderr}`);
                            }
                        }
                        warnings.push({
                            message: 'Qdrant vectors restored via file copy — Qdrant restart required',
                            component: component.component_key,
                            severity: 'warning'
                        });
                    }

                    // For docker targets, get size from archive data (can't stat inside container easily)
                    let qdrantSize;
                    try { qdrantSize = await getDirSize(archiveData); } catch { qdrantSize = { files: 0, bytes: 0 }; }
                    filesRestored += qdrantSize.files;
                    bytesRestored += qdrantSize.bytes;
                    break;
                }

                default:
                    warnings.push({
                        message: `Unknown backup method '${component.backup_method}' for ${component.name}`,
                        component: component.component_key,
                        severity: 'warning'
                    });
            }
        } catch (err) {
            warnings.push({
                message: `Restore of ${rawTarget} failed: ${err.message}`,
                component: component.component_key,
                severity: 'error'
            });
        }
    }

    return { files: filesRestored, bytes: bytesRestored };
}

/**
 * Run restore process
 */
async function runRestoreProcess(restoreId, orgId, backup, components, isDryRun, operator, operatorId) {
    const startTime = Date.now();

    try {
        // ====================================================================
        // STEP 1: Extract archive to temp directory
        // ====================================================================
        emitRestoreProgress(restoreId, { type: 'extracting' });

        const tempDir = path.join(BACKUP_ROOT, `.restore-${restoreId}`);
        await fs.mkdir(tempDir, { recursive: true });

        try {
            await extractArchive(backup.archive_path, tempDir);
        } catch (err) {
            throw new Error(`Failed to extract archive: ${err.message}`);
        }

        // The archive typically contains a single timestamp directory
        const entries = await fs.readdir(tempDir);
        let archiveRoot = tempDir;
        if (entries.length === 1) {
            const innerPath = path.join(tempDir, entries[0]);
            const stat = await fs.stat(innerPath);
            if (stat.isDirectory()) archiveRoot = innerPath;
        }

        // ====================================================================
        // STEP 2: Resolve which components to restore
        // ====================================================================
        const allComponents = prepare('SELECT * FROM backup_components ORDER BY priority').all();
        const selectedKeys = components || safeJsonParse(backup.components_json, null);
        const componentsToRestore = selectedKeys
            ? allComponents.filter(c => selectedKeys.includes(c.component_key))
            : allComponents.filter(c => c.default_enabled === 1);

        emitRestoreProgress(restoreId, { type: 'started', totalComponents: componentsToRestore.length, isDryRun });

        // ====================================================================
        // DRY RUN: Inspect archive and report what would be restored
        // ====================================================================
        if (isDryRun) {
            const wouldRestore = [];

            for (let i = 0; i < componentsToRestore.length; i++) {
                const comp = componentsToRestore[i];
                emitRestoreProgress(restoreId, {
                    type: 'component_start',
                    component: comp.component_key,
                    name: comp.name,
                    index: i,
                    total: componentsToRestore.length
                });
                const archiveData = await findComponentInArchive(comp.component_key, archiveRoot);
                if (archiveData) {
                    const archiveStat = await fs.stat(archiveData);
                    let size, fileCount;
                    if (archiveStat.isDirectory()) {
                        const info = await getDirSize(archiveData);
                        size = info.bytes;
                        fileCount = info.files;
                    } else {
                        size = archiveStat.size;
                        fileCount = 1;
                    }

                    const targets = safeJsonParse(comp.source_paths_json, []);
                    const targetPath = targets[0] ? resolveSourcePath(targets[0]) : 'unknown';
                    const existsOnDisk = existsSync(targetPath);

                    wouldRestore.push({
                        component: comp.component_key,
                        name: comp.name,
                        method: comp.backup_method,
                        archiveSize: size,
                        fileCount,
                        targetPath,
                        action: existsOnDisk ? 'overwrite' : 'create',
                        category: comp.category
                    });
                    emitRestoreProgress(restoreId, {
                        type: 'component_done',
                        component: comp.component_key,
                        name: comp.name,
                        files: fileCount,
                        bytes: size
                    });
                } else {
                    wouldRestore.push({
                        component: comp.component_key,
                        name: comp.name,
                        action: 'skip',
                        reason: 'Not found in archive'
                    });
                    emitRestoreProgress(restoreId, {
                        type: 'component_done',
                        component: comp.component_key,
                        name: comp.name,
                        files: 0,
                        bytes: 0,
                        skipped: true,
                        reason: 'Not found in archive'
                    });
                }
            }

            const totalSize = wouldRestore.reduce((sum, r) => sum + (r.archiveSize || 0), 0);
            const totalFiles = wouldRestore.reduce((sum, r) => sum + (r.fileCount || 0), 0);

            const preview = {
                backupName: backup.name,
                archivePath: backup.archive_path,
                archiveSize: backup.archive_size_bytes,
                components: componentsToRestore.map(c => c.component_key),
                wouldRestore,
                totalSize,
                totalFiles,
                summary: `Dry run complete. Would restore ${totalFiles} files (${formatBytes(totalSize)}) across ${wouldRestore.filter(r => r.action !== 'skip').length} components. No changes were made.`
            };

            // Cleanup temp dir
            await fs.rm(tempDir, { recursive: true, force: true });

            prepare(`
                UPDATE restore_operations
                SET status = 'dry_run_complete', preview_json = ?, duration_ms = ?, completed_at = datetime('now')
                WHERE id = ?
            `).run(JSON.stringify(preview), Date.now() - startTime, restoreId);

            logBackupAudit({
                orgId,
                operation: 'RESTORE_DRY_RUN_COMPLETE',
                defconLevel: DEFCON_LEVELS.RESTORE_DRY_RUN,
                backupId: backup.id,
                restoreId,
                operator,
                operatorId,
                result: 'dry_run',
                durationMs: Date.now() - startTime,
                metadata: preview
            });

            emitRestoreProgress(restoreId, {
                type: 'complete',
                status: 'dry_run_complete',
                totalFiles,
                totalSize,
                duration: Date.now() - startTime
            });

            return;
        }

        // ====================================================================
        // ACTUAL RESTORE
        // ====================================================================
        const warnings = [];
        let filesRestored = 0;
        let bytesRestored = 0;

        // Create pre-restore backup directory (safety net)
        const preRestoreDir = path.join(BACKUP_ROOT, `.pre-restore-${restoreId}`);
        await fs.mkdir(preRestoreDir, { recursive: true });

        // Restore each component in priority order
        for (let i = 0; i < componentsToRestore.length; i++) {
            const comp = componentsToRestore[i];
            emitRestoreProgress(restoreId, {
                type: 'component_start',
                component: comp.component_key,
                name: comp.name,
                index: i,
                total: componentsToRestore.length
            });

            try {
                const result = await restoreComponent(comp, archiveRoot, preRestoreDir, warnings, tempDir);
                filesRestored += result.files;
                bytesRestored += result.bytes;

                emitRestoreProgress(restoreId, {
                    type: 'component_done',
                    component: comp.component_key,
                    name: comp.name,
                    files: result.files,
                    bytes: result.bytes
                });

                if (result.files > 0) {
                    console.log(`[Restore] ${comp.name}: ${result.files} files, ${formatBytes(result.bytes)}`);
                }
            } catch (err) {
                warnings.push({
                    message: `Component ${comp.name} failed: ${err.message}`,
                    component: comp.component_key,
                    severity: 'error'
                });
                emitRestoreProgress(restoreId, {
                    type: 'component_error',
                    component: comp.component_key,
                    name: comp.name,
                    error: err.message
                });
            }
        }

        // Cleanup temp extraction dir (keep pre-restore backup for rollback)
        await fs.rm(tempDir, { recursive: true, force: true });

        const duration = Date.now() - startTime;
        const hasErrors = warnings.some(w => w.severity === 'error');

        prepare(`
            UPDATE restore_operations
            SET status = ?, files_restored = ?, bytes_restored = ?,
                warnings_json = ?, duration_ms = ?, completed_at = datetime('now')
            WHERE id = ?
        `).run(
            hasErrors ? 'completed_with_errors' : 'completed',
            filesRestored, bytesRestored,
            JSON.stringify(warnings), duration, restoreId
        );

        logBackupAudit({
            orgId,
            operation: 'RESTORE_COMPLETED',
            defconLevel: components ? DEFCON_LEVELS.RESTORE_SELECTIVE : DEFCON_LEVELS.RESTORE_FULL,
            backupId: backup.id,
            restoreId,
            operator,
            operatorId,
            result: hasErrors ? 'failed' : 'success',
            durationMs: duration,
            metadata: {
                components: componentsToRestore.map(c => c.component_key),
                filesRestored,
                bytesRestored,
                warningCount: warnings.length,
                errorCount: warnings.filter(w => w.severity === 'error').length,
                preRestoreBackup: preRestoreDir
            }
        });
        createAuditEvent({
            orgId,
            actorType: operatorId ? 'user' : 'system',
            actorId: operatorId,
            action: 'restore.completed',
            targetType: 'restore',
            targetId: restoreId,
            metadata: { backupId: backup.id, filesRestored, bytesRestored, durationMs: duration }
        });

        emitRestoreProgress(restoreId, {
            type: 'complete',
            status: hasErrors ? 'completed_with_errors' : 'completed',
            filesRestored,
            bytesRestored,
            duration
        });

        // Notify
        createBackupNotification(orgId, backup.id, !hasErrors, {
            name: `Restore from ${backup.name}`,
            filesRestored,
            sizeBytes: bytesRestored,
            duration,
            warnings: warnings.length
        });

    } catch (error) {
        const duration = Date.now() - startTime;

        // Cleanup temp dir on failure
        const tempDir = path.join(BACKUP_ROOT, `.restore-${restoreId}`);
        try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

        prepare(`
            UPDATE restore_operations
            SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now')
            WHERE id = ?
        `).run(error.message, duration, restoreId);

        emitRestoreProgress(restoreId, {
            type: 'complete',
            status: 'failed',
            error: error.message,
            duration
        });

        logBackupAudit({
            orgId,
            operation: 'RESTORE_FAILED',
            defconLevel: DEFCON_LEVELS.RESTORE_FAILED,
            backupId: backup.id,
            restoreId,
            operator,
            operatorId,
            result: 'failed',
            durationMs: duration,
            metadata: { error: error.message }
        });
        createAuditEvent({
            orgId,
            actorType: operatorId ? 'user' : 'system',
            actorId: operatorId,
            action: 'restore.failed',
            targetType: 'restore',
            targetId: restoreId,
            status: 'failed',
            metadata: { backupId: backup.id, error: error.message, durationMs: duration }
        });
    }
}

/**
 * Create inbox notification for backup completion/failure
 */
function createBackupNotification(orgId, backupId, success, details) {
    try {
        const kind = success ? 'info' : 'incident';
        const priority = success ? 'low' : 'high';
        const title = success ? 'Backup Completed Successfully' : (details.degraded ? 'Backup DEGRADED (incomplete)' : 'Backup Failed');

        const body = success
            ? `**Backup** completed successfully.\n\n- Name: ${details.name || 'Backup'}\n- Size: ${formatBytes(details.sizeBytes || 0)}\n- Duration: ${details.duration || 0}ms`
            : (details.degraded
                ? `**Backup is incomplete (degraded)**\n\nThe archive was kept, but ${details.error || 'required components were skipped'}`
                : `**Backup failed**\n\nError: ${details.error || 'Unknown error'}`);

        // Find all org owners and admins to notify
        const admins = prepare(`
            SELECT user_id FROM org_memberships
            WHERE org_id = ? AND role IN ('owner', 'admin')
        `).all(orgId);

        if (admins.length === 0) {
            console.log(`[Backup Notification] ${title} (no admins to notify)`);
            return;
        }

        for (const { user_id } of admins) {
            // Ensure personal inbox exists
            let inbox = prepare(`
                SELECT id FROM inboxes WHERE org_id = ? AND owner_id = ? AND inbox_type = 'personal'
            `).get(orgId, user_id);

            if (!inbox) {
                const inboxId = ulid();
                prepare(`
                    INSERT INTO inboxes (id, org_id, owner_id, inbox_type, name, created_at, updated_at)
                    VALUES (?, ?, ?, 'personal', 'My Inbox', datetime('now'), datetime('now'))
                `).run(inboxId, orgId, user_id);
                inbox = { id: inboxId };
            }

            const itemId = ulid();
            prepare(`
                INSERT INTO inbox_items (
                    id, org_id, inbox_id, kind, priority, title, body_md,
                    payload_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
            `).run(itemId, orgId, inbox.id, kind, priority, title, body, JSON.stringify({ source: 'backup', backupId }));

            // Push real-time SSE notification
            emitItemCreated(orgId, { id: itemId, kind, priority, title, status: 'open' });
        }

        emitStatsUpdate(orgId);
    } catch (error) {
        console.error('Failed to create backup notification:', error);
    }
}

/**
 * Calculate next run time for schedule
 */
function calculateNextRun(scheduleType, hour, minute, dayOfWeek, dayOfMonth) {
    const now = new Date();
    const next = new Date(now);

    // Set time
    next.setHours(hour || 2, minute || 0, 0, 0);

    switch (scheduleType) {
        case 'hourly':
            next.setMinutes(minute || 0);
            if (next <= now) {
                next.setHours(next.getHours() + 1);
            }
            break;

        case 'daily':
            if (next <= now) {
                next.setDate(next.getDate() + 1);
            }
            break;

        case 'weekly':
            const targetDay = dayOfWeek || 0; // Default Sunday
            const currentDay = now.getDay();
            let daysUntil = targetDay - currentDay;
            if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
                daysUntil += 7;
            }
            next.setDate(next.getDate() + daysUntil);
            break;

        case 'monthly':
            const targetDate = dayOfMonth || 1;
            next.setDate(targetDate);
            if (next <= now) {
                next.setMonth(next.getMonth() + 1);
            }
            break;
    }

    return next.toISOString();
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================================================
// BACKUP STATUS / HEALTH ENDPOINT
// ============================================================================

/**
 * GET /orgs/:orgId/backup-status
 * Returns backup health status, last success/failure, schedule stats, and totals.
 * Health thresholds: <24h = healthy, <72h = warning, >72h = critical, no backups = unknown
 */
router.get('/orgs/:orgId/backup-status', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;

        // Last successful backup
        const lastSuccess = prepare(`
            SELECT id, name, backup_type, archive_size_bytes, completed_at, duration_ms
            FROM backups
            WHERE org_id = ? AND status IN ('completed', 'verified')
            ORDER BY completed_at DESC LIMIT 1
        `).get(orgId);

        // Last failed backup
        const lastFailed = prepare(`
            SELECT id, name, error_message, completed_at
            FROM backups
            WHERE org_id = ? AND status = 'failed'
            ORDER BY completed_at DESC LIMIT 1
        `).get(orgId);

        // Last degraded backup (archive built, REQUIRED component skipped)
        const lastDegraded = prepare(`
            SELECT id, name, error_message, completed_at
            FROM backups
            WHERE org_id = ? AND status = 'degraded'
            ORDER BY completed_at DESC LIMIT 1
        `).get(orgId);

        // Currently running backup
        const running = prepare(`
            SELECT id, name, backup_type, started_at
            FROM backups
            WHERE org_id = ? AND status = 'running'
            ORDER BY started_at DESC LIMIT 1
        `).get(orgId);

        // Totals
        const totals = prepare(`
            SELECT
                COUNT(*) as count,
                COALESCE(SUM(archive_size_bytes), 0) as totalBytes
            FROM backups
            WHERE org_id = ? AND status IN ('completed', 'verified')
        `).get(orgId);

        // Schedule stats
        const scheduleStats = prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled,
                MIN(CASE WHEN enabled = 1 AND next_run_at IS NOT NULL THEN next_run_at END) as nextRun
            FROM backup_schedules
            WHERE org_id = ?
        `).get(orgId);

        // Calculate health
        let health = 'unknown';
        let healthReason = 'No backups found';

        if (lastSuccess?.completed_at) {
            const lastSuccessAge = Date.now() - new Date(lastSuccess.completed_at).getTime();
            const hoursAgo = lastSuccessAge / (1000 * 60 * 60);

            if (hoursAgo < 24) {
                health = 'healthy';
                healthReason = `Last backup ${Math.round(hoursAgo)}h ago`;
            } else if (hoursAgo < 72) {
                health = 'warning';
                healthReason = `Last backup ${Math.round(hoursAgo)}h ago`;
            } else {
                health = 'critical';
                healthReason = `Last backup ${Math.round(hoursAgo / 24)}d ago — overdue`;
            }
        }

        // If the most recent event is a failure after the last success, escalate
        if (lastFailed?.completed_at && lastSuccess?.completed_at) {
            if (new Date(lastFailed.completed_at) > new Date(lastSuccess.completed_at)) {
                if (health === 'healthy') health = 'warning';
                healthReason += ' (last attempt failed)';
            }
        }

        // A degraded run newer than the last full success means the freshest
        // backup is missing required data: never report that as healthy.
        if (lastDegraded?.completed_at &&
            (!lastSuccess?.completed_at || new Date(lastDegraded.completed_at) > new Date(lastSuccess.completed_at))) {
            if (health === 'healthy' || health === 'unknown') health = 'warning';
            healthReason += ` (latest backup DEGRADED: ${lastDegraded.error_message || 'required components skipped'})`;
        }

        res.json({
            health,
            healthReason,
            lastDegraded: lastDegraded ? {
                id: lastDegraded.id,
                name: lastDegraded.name,
                message: lastDegraded.error_message,
                completedAt: lastDegraded.completed_at
            } : null,
            lastSuccess: lastSuccess ? {
                id: lastSuccess.id,
                name: lastSuccess.name,
                type: lastSuccess.backup_type,
                sizeBytes: lastSuccess.archive_size_bytes,
                completedAt: lastSuccess.completed_at,
                durationMs: lastSuccess.duration_ms
            } : null,
            lastFailed: lastFailed ? {
                id: lastFailed.id,
                name: lastFailed.name,
                error: lastFailed.error_message,
                completedAt: lastFailed.completed_at
            } : null,
            running: running ? {
                id: running.id,
                name: running.name,
                type: running.backup_type,
                startedAt: running.started_at
            } : null,
            totals: {
                count: totals?.count || 0,
                totalBytes: totals?.totalBytes || 0,
                storagePath: BACKUP_ROOT
            },
            schedules: {
                total: scheduleStats?.total || 0,
                enabled: scheduleStats?.enabled || 0,
                nextRun: scheduleStats?.nextRun || null
            }
        });
    } catch (err) {
        console.error('Failed to get backup status:', err);
        res.status(500).json({ error: 'Failed to get backup status' });
    }
});

// ============================================================================
// POST-RESTORE VALIDATION
// ============================================================================

/**
 * GET /orgs/:orgId/backups/validate-restore
 * Runs validation checks against the current instance to verify
 * that a restore completed successfully. Returns a checklist of
 * pass/fail results for each critical component.
 */
router.get('/orgs/:orgId/backups/validate-restore', requireOrgMembership, async (req, res) => {
    try {
        const checks = [];

        // 1. Auth DB: user count
        const db = getDb();
        const userRow = prepare(db, 'SELECT COUNT(*) as count FROM users').get();
        checks.push({
            component: 'auth_db',
            label: 'User accounts',
            status: userRow.count > 0 ? 'pass' : 'fail',
            detail: `${userRow.count} user(s) found`,
        });

        // 2. Auth DB: org count
        const orgRow = prepare(db, 'SELECT COUNT(*) as count FROM orgs').get();
        checks.push({
            component: 'auth_db',
            label: 'Organizations',
            status: orgRow.count > 0 ? 'pass' : 'warn',
            detail: `${orgRow.count} organization(s)`,
        });

        // 3. Auth DB: API keys present (encrypted, not readable)
        const keyRow = prepare(db, "SELECT COUNT(*) as count FROM setup_config WHERE key IN ('anthropic_api_key', 'claude_oauth_token') AND value IS NOT NULL AND value != ''").get();
        checks.push({
            component: 'auth_db',
            label: 'LLM credentials',
            status: keyRow.count > 0 ? 'pass' : 'warn',
            detail: keyRow.count > 0 ? `${keyRow.count} credential(s) configured` : 'No LLM credentials — users will need to re-authenticate',
        });

        // 4. Memory DB: query via container
        try {
            const memCheck = await runValidationCommand('docker', ['exec', 'quox-memory', 'sqlite3', '/var/lib/quox/memory.db', 'SELECT COUNT(*) FROM memories']);
            const memCount = parseInt(memCheck.stdout.trim()) || 0;
            checks.push({
                component: 'memory_db',
                label: 'Memories',
                status: memCount > 0 ? 'pass' : 'warn',
                detail: `${memCount} memory record(s)`,
            });
        } catch {
            checks.push({ component: 'memory_db', label: 'Memories', status: 'fail', detail: 'Could not query memory database' });
        }

        // 5. Tasks DB: objectives + tasks
        try {
            const taskCheck = await runValidationCommand('docker', ['exec', 'quox-tasks', 'sqlite3', '/var/lib/quox/tasks.db', "SELECT (SELECT COUNT(*) FROM objectives) || '/' || (SELECT COUNT(*) FROM tasks)"]);
            const [objCount, tskCount] = (taskCheck.stdout.trim() || '0/0').split('/');
            checks.push({
                component: 'tasks_db',
                label: 'Objectives & tasks',
                status: parseInt(objCount) > 0 ? 'pass' : 'warn',
                detail: `${objCount} objective(s), ${tskCount} task(s)`,
            });
        } catch {
            checks.push({ component: 'tasks_db', label: 'Objectives & tasks', status: 'fail', detail: 'Could not query tasks database' });
        }

        // 6. AEE DB: envelope count
        try {
            const aeeCheck = await runValidationCommand('docker', ['exec', 'quox-collector', 'sqlite3', '/var/lib/quox/aee.db', 'SELECT COUNT(*) FROM envelopes']);
            const aeeCount = parseInt(aeeCheck.stdout.trim()) || 0;
            checks.push({
                component: 'aee_db',
                label: 'Audit envelopes',
                status: aeeCount > 0 ? 'pass' : 'warn',
                detail: `${aeeCount} envelope(s)`,
            });
        } catch {
            checks.push({ component: 'aee_db', label: 'Audit envelopes', status: 'fail', detail: 'Could not query AEE database' });
        }

        // 7. Container health
        const containers = ['quox-auth', 'quox-collector', 'quox-memory', 'quox-tasks'];
        for (const ctr of containers) {
            try {
                const check = await runValidationCommand('docker', ['inspect', '--format', '{{.State.Running}}', ctr]);
                const running = check.stdout.trim() === 'true';
                checks.push({
                    component: 'containers',
                    label: `Container: ${ctr}`,
                    status: running ? 'pass' : 'fail',
                    detail: running ? 'Running' : 'Not running',
                });
            } catch {
                checks.push({ component: 'containers', label: `Container: ${ctr}`, status: 'fail', detail: 'Could not inspect' });
            }
        }

        // 8. Plugin state in user preferences
        const prefRow = prepare(db, "SELECT preferences_json FROM users WHERE role = 'admin' LIMIT 1").get();
        if (prefRow?.preferences_json) {
            const prefs = JSON.parse(prefRow.preferences_json || '{}');
            const extCount = prefs.extensions ? Object.keys(prefs.extensions).filter(k => prefs.extensions[k]).length : 0;
            checks.push({
                component: 'preferences',
                label: 'Plugin activations',
                status: extCount > 0 ? 'pass' : 'warn',
                detail: `${extCount} active plugin(s) in server preferences`,
            });
        } else {
            checks.push({ component: 'preferences', label: 'Plugin activations', status: 'warn', detail: 'No admin user preferences found' });
        }

        // Summary
        const passCount = checks.filter(c => c.status === 'pass').length;
        const warnCount = checks.filter(c => c.status === 'warn').length;
        const failCount = checks.filter(c => c.status === 'fail').length;

        res.json({
            checks,
            summary: {
                total: checks.length,
                pass: passCount,
                warn: warnCount,
                fail: failCount,
                overall: failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass',
            },
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Restore validation failed:', err);
        res.status(500).json({ error: 'Validation check failed' });
    }
});

// ============================================================================
// PRE-RESTORE COMPARISON
// ============================================================================

/**
 * GET /orgs/:orgId/backups/:backupId/compare
 * Returns backup source counts vs current instance counts so the user
 * can see the impact of a restore before starting it.
 */
router.get('/orgs/:orgId/backups/:backupId/compare', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, backupId } = req.params;

        const backup = prepare(`SELECT * FROM backups WHERE id = ? AND org_id = ?`).get(backupId, orgId);
        if (!backup) return res.status(404).json({ error: 'Backup not found' });

        // Get current instance counts
        const current = {};
        const db = getDb();

        // Auth DB counts (local, direct access)
        try {
            current.users = prepare(db, 'SELECT COUNT(*) as count FROM users WHERE org_id = ?').get(orgId)?.count || 0;
            current.organizations = prepare(db, 'SELECT COUNT(*) as count FROM orgs').get()?.count || 0;
        } catch { current.users = 0; current.organizations = 0; }

        // Memory DB (via docker exec)
        try {
            const memOut = await runValidationCommand('docker', ['exec', 'quox-memory', 'sqlite3', '/var/lib/quox/memory.db', 'SELECT COUNT(*) FROM memories']);
            current.memories = parseInt(memOut.stdout.trim()) || 0;
        } catch { current.memories = 0; }

        // Tasks DB
        try {
            const taskOut = await runValidationCommand('docker', ['exec', 'quox-tasks', 'sqlite3', '/var/lib/quox/tasks.db', 'SELECT COUNT(*) FROM objectives']);
            current.objectives = parseInt(taskOut.stdout.trim()) || 0;
            const taskOut2 = await runValidationCommand('docker', ['exec', 'quox-tasks', 'sqlite3', '/var/lib/quox/tasks.db', 'SELECT COUNT(*) FROM tasks']);
            current.tasks = parseInt(taskOut2.stdout.trim()) || 0;
        } catch { current.objectives = 0; current.tasks = 0; }

        // AEE DB
        try {
            const aeeOut = await runValidationCommand('docker', ['exec', 'quox-collector', 'sqlite3', '/var/lib/quox/aee.db', 'SELECT COUNT(*) FROM envelopes']);
            current.envelopes = parseInt(aeeOut.stdout.trim()) || 0;
        } catch { current.envelopes = 0; }

        // Parse backup metadata for source counts
        const backupMeta = safeJsonParse(backup.metadata_json, {});
        const source = backupMeta.manifest?.components || {};

        res.json({
            backup: {
                id: backup.id,
                name: backup.name,
                created_at: backup.created_at,
                archive_size_bytes: backup.archive_size_bytes,
                source_instance: backupMeta.manifest?.source_instance || 'unknown'
            },
            source: {
                users: source.auth_db?.users || null,
                memories: source.memory_db?.memories || null,
                objectives: source.tasks_db?.objectives || null,
                tasks: source.tasks_db?.tasks || null,
                envelopes: source.aee_db?.envelopes || null
            },
            current
        });
    } catch (error) {
        console.error('Error comparing backup:', error);
        res.status(500).json({ error: 'Failed to compare backup' });
    }
});

// ============================================================================
// SCAN & IMPORT — Discover backup archives on disk
// ============================================================================

/**
 * POST /orgs/:orgId/backups/scan-imports
 * Scan the backup directory for .tar.gz archives not already registered
 * in the database. Registers any found archives as importable backups.
 */
router.post('/orgs/:orgId/backups/scan-imports',
    requireOrgMembership,
    requireOrgRole('admin', 'owner'),
    async (req, res) => {
    const { orgId } = req.params;
    const userId = req.user.id;
    const userEmail = req.user.email;

    try {
        // Read backup directory
        if (!existsSync(BACKUP_ROOT)) {
            return res.json({ imported: 0, archives: [], message: 'Backup directory does not exist' });
        }

        const files = await fs.readdir(BACKUP_ROOT);
        const archives = files.filter(f => f.endsWith('.tar.gz') && !f.startsWith('.'));

        // Get already-registered archive paths
        const registered = prepare(`
            SELECT archive_path FROM backups WHERE org_id = ?
        `).all(orgId).map(r => r.archive_path);

        const registeredBasenames = new Set(registered.map(p => p ? path.basename(p) : null).filter(Boolean));

        const imported = [];

        for (const archive of archives) {
            if (registeredBasenames.has(archive)) continue;

            const archivePath = path.join(BACKUP_ROOT, archive);
            const stat = await fs.stat(archivePath);

            // Try to extract manifest from archive without full extraction
            let manifest = null;
            let manifestJson = null;
            try {
                const { stdout } = await new Promise((resolve, reject) => {
                    const proc = spawn('tar', ['-xzf', archivePath, '-O', 'manifest.json'], { timeout: 30000 });
                    let stdout = '', stderr = '';
                    proc.stdout.on('data', d => { stdout += d; });
                    proc.stderr.on('data', d => { stderr += d; });
                    proc.on('close', code => {
                        if (code === 0) resolve({ stdout, stderr });
                        else reject(new Error(stderr));
                    });
                    proc.on('error', reject);
                });
                manifest = JSON.parse(stdout);
                manifestJson = stdout;
            } catch {
                // No manifest — still importable, just without metadata
            }

            // Parse timestamp from filename (YYYYMMDD_HHMMSS.tar.gz)
            let createdAt = stat.mtime.toISOString();
            const match = archive.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
            if (match) {
                const [, y, mo, d, h, mi, s] = match;
                createdAt = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
            }

            // Determine component list from manifest
            const componentsJson = manifest?.components
                ? JSON.stringify(Object.keys(manifest.components))
                : null;

            // Register in database
            const backupId = ulid();
            const backupName = manifest?.source_instance
                ? `Imported: ${manifest.source_instance} (${archive})`
                : `Imported: ${archive}`;

            prepare(`
                INSERT INTO backups (id, org_id, backup_type, name, description, status, archive_path, archive_size_bytes, manifest_json, components_json, created_by, started_at, completed_at, created_at)
                VALUES (?, ?, 'full', ?, 'Imported from backup directory', 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                backupId, orgId, backupName,
                archivePath, stat.size,
                manifestJson, componentsJson,
                userId, createdAt, createdAt, createdAt
            );

            imported.push({
                id: backupId,
                name: backupName,
                archive: archive,
                size: stat.size,
                created: createdAt,
                hasManifest: !!manifest,
                componentCount: manifest?.components ? Object.keys(manifest.components).length : null
            });
        }

        // Audit
        if (imported.length > 0) {
            logBackupAudit({
                orgId,
                operation: 'BACKUP_IMPORTED',
                defconLevel: 'GREEN',
                operator: userEmail,
                operatorId: userId,
                result: 'success',
                metadata: { count: imported.length, archives: imported.map(i => i.archive) }
            });
        }

        res.json({
            imported: imported.length,
            archives: imported,
            totalScanned: archives.length,
            alreadyRegistered: archives.length - imported.length,
            message: imported.length > 0
                ? `Found and imported ${imported.length} backup archive(s)`
                : 'No new backup archives found'
        });

    } catch (error) {
        console.error('Error scanning for backups:', error);
        res.status(500).json({ error: 'Failed to scan backup directory' });
    }
});

/** Helper: run a command and return stdout/stderr */
function runValidationCommand(cmd, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { timeout: 10000 });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('close', code => {
            if (code === 0) resolve({ stdout, stderr, code });
            else reject(new Error(`${cmd} exited with ${code}: ${stderr}`));
        });
        proc.on('error', reject);
    });
}

export default router;

// QLUSTER-4: reused by routes/internal-backups.js so the internal (service-key
// gated) trigger runs the exact same async backup-execution path (spawn script,
// timeout, manifest, backup_audit_log) as POST /orgs/:orgId/backups — no
// duplicated logic. Additive named export; default export unchanged.
export { finalizeBackupRun, markStaleBackups, runBackupProcess, verifyBackupIntegrity, runRestoreProcess, logBackupAudit, DEFCON_LEVELS, resolveStaleBackupMinutes, resolveBackupTimeoutMs };
