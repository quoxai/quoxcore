/**
 * Backup Scheduler Daemon
 *
 * Background process that checks backup_schedules every 60 seconds
 * and triggers backups for any schedules that are due.
 *
 * Features:
 * - Checks enabled schedules where next_run_at <= now
 * - Triggers backup creation via the backup script
 * - Updates last_run_at, next_run_at, last_backup_id
 * - Enforces max_backups per schedule (deletes oldest)
 * - Enforces retention_days (deletes expired backups)
 * - Logs all operations to backup_audit_log
 */

import { getDb, prepare } from '../db/index.js';
import { ulid, createAuditEvent } from '../utils/helpers.js';
import { emitItemCreated, emitStatsUpdate } from '../utils/inboxEvents.js';
import { spawn } from 'child_process';
import { tryLaunchDetachedBackup } from '../lib/backupDetach.js';
import { classifyBackupExit, parseSkippedRequired, degradedMessage } from '../lib/backupStatus.js';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { getInstanceSetting } from '../lib/configResolver.js';

// Configuration
const CHECK_INTERVAL_MS_DEFAULT = parseInt(process.env.BACKUP_SCHEDULER_INTERVAL_MS || '60000', 10); // 1 minute
const BACKUP_SCRIPT = process.env.BACKUP_SCRIPT || '/app/project/scripts/backup-quox.sh';
const BACKUP_ROOT = process.env.BACKUP_ROOT || '/opt/quoxcore/backups';

// VAULT-INTEG P17: BACKUP_SCHEDULER_INTERVAL_MS was a bare process.env read
// frozen at module load. Resolved via configResolver.getInstanceSetting()
// (instance-wide: this scheduler checks every org's due schedules on one
// shared tick, not a per-org policy) inside startBackupScheduler() below —
// but that interval is still only read ONCE, at scheduler-start call time,
// and baked into the single setInterval it creates for its whole lifetime.
// A stored override IS honoured, but only from the next auth service
// restart onward — platformCapabilities.js marks BACKUP_SCHEDULER_INTERVAL_MS
// `requiresRestart: true` for exactly this reason. Fail-safe: any resolver
// failure (no service key, network error, no override stored) falls back
// to the env value.
export async function resolveCheckIntervalMs(deps = {}) {
    try {
        const resolved = await getInstanceSetting('BACKUP_SCHEDULER_INTERVAL_MS', deps);
        if (resolved && resolved.value !== undefined) {
            const n = Number(resolved.value);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch (err) {
        console.error(`[BackupScheduler] BACKUP_SCHEDULER_INTERVAL_MS instance-setting resolver failed, falling back to env — ${err.message}`);
    }
    return CHECK_INTERVAL_MS_DEFAULT;
}

// #727: runaway guard for the detached backup container (the scheduler itself
// has never killed a run). Same knob as the stale sweep, default 180 minutes.
function schedulerTimeoutMs() {
    const m = Number(process.env.BACKUP_STALE_MINUTES);
    return (m > 0 ? m : 180) * 60 * 1000;
}

let schedulerInterval = null;
let schedulerStarting = false; // guards the start/stop race across the async interval resolution below (VAULT-INTEG P17)
let isRunning = false; // Prevent concurrent schedule checks

/**
 * Calculate the next run time for a schedule (same logic as backups.js)
 */
function calculateNextRun(scheduleType, hour, minute, dayOfWeek, dayOfMonth) {
    const now = new Date();
    const next = new Date(now);

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

        case 'weekly': {
            const targetDay = dayOfWeek || 0;
            const currentDay = now.getDay();
            let daysUntil = targetDay - currentDay;
            if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
                daysUntil += 7;
            }
            next.setDate(next.getDate() + daysUntil);
            break;
        }

        case 'monthly': {
            const targetDate = dayOfMonth || 1;
            next.setDate(targetDate);
            if (next <= now) {
                next.setMonth(next.getMonth() + 1);
            }
            break;
        }
    }

    return next.toISOString();
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
 * Ensure user has a personal inbox in the org (same pattern as bastion-approvals.js)
 */
function ensurePersonalInbox(orgId, userId) {
    const existing = prepare(`
        SELECT id FROM inboxes
        WHERE org_id = ? AND owner_id = ? AND inbox_type = 'personal'
    `).get(orgId, userId);

    if (existing) {
        return existing.id;
    }

    const inboxId = ulid();
    prepare(`
        INSERT INTO inboxes (id, org_id, inbox_type, name, owner_id)
        VALUES (?, ?, 'personal', 'Personal Inbox', ?)
    `).run(inboxId, orgId, userId);

    return inboxId;
}

/**
 * Format bytes to human readable (local copy)
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Send inbox notification after backup completes or fails.
 * Notifies all org owners/admins.
 */
function notifyBackupResult(orgId, scheduleName, backupId, success, details) {
    try {
        // Find all owners and admins in the org
        const admins = prepare(`
            SELECT user_id FROM org_memberships
            WHERE org_id = ? AND role IN ('owner', 'admin')
        `).all(orgId);

        if (admins.length === 0) return;

        const kind = success ? 'info' : 'incident';
        const priority = success ? 'low' : 'high';
        const title = success
            ? `Backup completed: ${scheduleName}`
            : (details.degraded ? `Backup DEGRADED (incomplete): ${scheduleName}` : `Backup FAILED: ${scheduleName}`);
        const body = success
            ? `Scheduled backup **${scheduleName}** completed successfully.\n\n- Size: ${formatBytes(details.sizeBytes || 0)}\n- Duration: ${details.durationMs || 0}ms`
            : (details.degraded
                ? `Scheduled backup **${scheduleName}** produced an archive but it is **INCOMPLETE**.\n\n${details.error}\n\nThe archive was kept and marked degraded. Do not treat it as a full backup.`
                : `Scheduled backup **${scheduleName}** failed.\n\nError: ${details.error || 'Unknown error'}`);

        for (const { user_id } of admins) {
            const inboxId = ensurePersonalInbox(orgId, user_id);
            const itemId = ulid();

            // inbox_items has no source_type/source_id columns; the previous
            // INSERT named them and threw into the catch below on every
            // backup, so these notifications had never fired (quox#545).
            // created_by REFERENCES users(id) and the auth db runs with
            // foreign_keys=ON, so a synthetic 'backup_scheduler' author would
            // fail the FK exactly like the original bug; attribution lives in
            // payload_json only and created_by stays NULL (system actor).
            prepare(`
                INSERT INTO inbox_items (
                    id, org_id, inbox_id, kind, priority, title, body_md,
                    payload_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
            `).run(itemId, orgId, inboxId, kind, priority, title, body,
                JSON.stringify({ source_type: 'backup_scheduler', source_id: backupId, backup_id: backupId }));

            // Push real-time SSE notification
            emitItemCreated(orgId, { id: itemId, kind, priority, title, status: 'open' });
        }

        emitStatsUpdate(orgId);
    } catch (err) {
        console.error('[BackupScheduler] Failed to send inbox notification:', err.message);
    }
}

/**
 * Run a scheduled backup
 */
export async function runScheduledBackup(schedule) {
    const backupId = ulid();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const backupName = `Scheduled: ${schedule.name} (${timestamp})`;
    const mode = schedule.backup_type === 'quick' ? '--quick' : '--full';
    const startTime = Date.now();

    console.log(`[BackupScheduler] Starting scheduled backup: ${schedule.name} (${schedule.schedule_type})`);

    // Create backup record
    try {
        prepare(`
            INSERT INTO backups (id, org_id, backup_type, name, description, status, components_json, created_by, started_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?, datetime('now'))
        `).run(
            backupId, schedule.org_id, schedule.backup_type,
            backupName, `Auto-triggered by schedule: ${schedule.name}`,
            schedule.components_json || null,
            schedule.created_by
        );
    } catch (err) {
        console.error(`[BackupScheduler] Failed to create backup record: ${err.message}`);
        return;
    }

    // Log to audit
    logSchedulerAudit(schedule.org_id, 'SCHEDULE_TRIGGERED', backupId, schedule.id, {
        scheduleName: schedule.name,
        scheduleType: schedule.schedule_type,
        backupType: schedule.backup_type
    });

    // TRUST-GATE-1.20: claim-before-spawn.
    //
    // Stamp next_run_at (and last_status='running') SYNCHRONOUSLY, before the
    // backup script is spawned. This is the crash-safe primary invariant:
    // once a schedule is claimed, no later checkAndRunDueSchedules() tick can
    // find it "due" again and fire a second backup — even if this process is
    // still running (a full backup can take minutes) or dies outright. The
    // close/error handlers below still update next_run_at again on
    // completion; recomputing it there is harmless and keeps the "run at the
    // scheduled time" semantics for hourly/weekly/monthly schedules.
    const claimedNextRun = calculateNextRun(
        schedule.schedule_type,
        schedule.schedule_hour,
        schedule.schedule_minute,
        schedule.schedule_day_of_week,
        schedule.schedule_day_of_month
    );
    prepare(`
        UPDATE backup_schedules
        SET next_run_at = ?, last_status = 'running', updated_at = datetime('now')
        WHERE id = ?
    `).run(claimedNextRun, schedule.id);

    // TRUST-GATE-1.20: honest promise. runScheduledBackup now resolves only
    // once the close/error handler has finished, so `await
    // runScheduledBackup(schedule)` in checkAndRunDueSchedules is real and
    // schedules run truly sequentially rather than the async function
    // returning immediately while the spawned process is still running.
    return new Promise((resolve) => {
        // #727: prefer a DETACHED one-shot container so an auth rebuild or
        // restart cannot kill the nightly run. The scheduler never had a kill
        // timeout; the container gets a generous one (BACKUP_STALE_MINUTES,
        // default 180) purely as a runaway guard. Falls back to a child process
        // with an honest log line when docker is unavailable.
        tryLaunchDetachedBackup({
            backupId, mode, orgId: schedule.org_id, origin: 'scheduler', scheduleId: schedule.id,
            operator: 'backup_scheduler', timeoutMs: schedulerTimeoutMs(),
            backupScript: BACKUP_SCRIPT, backupRoot: BACKUP_ROOT
        }).then((detached) => {
        const proc = detached || spawn(BACKUP_SCRIPT, [mode], {
            cwd: '/opt/quoxcore',
            env: { ...process.env, BACKUP_ID: backupId }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', async (code) => {
            await finalizeScheduledRun({ schedule, backupId, backupName, startTime }, code, stdout, stderr);
            if (proc.release) await proc.release();
            resolve();
        });

        proc.on('error', (err) => {
            console.error(`[BackupScheduler] Spawn error for ${schedule.name}: ${err.message}`);

            prepare(`
                UPDATE backups
                SET status = 'failed', error_message = ?, completed_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ?
            `).run(err.message, backupId);

            // Still update next_run_at so we don't get stuck
            const nextRun = calculateNextRun(
                schedule.schedule_type, schedule.schedule_hour,
                schedule.schedule_minute, schedule.schedule_day_of_week,
                schedule.schedule_day_of_month
            );
            prepare(`
                UPDATE backup_schedules
                SET last_run_at = datetime('now'), next_run_at = ?, last_status = 'failed', updated_at = datetime('now')
                WHERE id = ?
            `).run(nextRun, schedule.id);

            // Send inbox notification for spawn error
            notifyBackupResult(schedule.org_id, schedule.name, backupId, false, {
                error: `Spawn error: ${err.message}`
            });

            resolve();
        });
        });
    });
}

/**
 * Turn a finished scheduled run into the backup row, schedule row, audit and inbox
 * notification. Shared by the live monitor and by adoption after an auth restart (#727).
 * Resolves when done.
 */
export async function finalizeScheduledRun({ schedule, backupId, backupName, startTime }, code, stdout, stderr) {
    const duration = Date.now() - startTime;
    const exitClass = classifyBackupExit(code);
    let status = exitClass === 'failed' ? 'failed' : 'completed';
    const isDegraded = exitClass === 'degraded';
    const skippedRequired = isDegraded ? parseSkippedRequired(stdout) : [];
    let archiveSize = 0;

    if (exitClass !== 'failed') {

        // Find the created archive
        const archiveMatch = stdout.match(/Created archive: ([^\s]+\.tar\.gz)/);
        const archivePath = archiveMatch ? archiveMatch[1] : null;

        let manifestJson = null;
        if (archivePath && existsSync(archivePath)) {
            const stats = await fs.stat(archivePath);
            archiveSize = stats.size;

            // Generate manifest
            try {
                const archiveHash = await hashFile(archivePath);
                manifestJson = JSON.stringify({
                    archiveHash: `sha256:${archiveHash}`,
                    archivePath,
                    totalBytes: archiveSize,
                    createdAt: new Date().toISOString(),
                    checksumAlgorithm: 'sha256',
                    ...(isDegraded ? { degraded: true, skipped_required: skippedRequired } : {})
                });
            } catch { /* ignore manifest errors */ }
        }

        prepare(`
            UPDATE backups
            SET status = ?, archive_path = ?, archive_size_bytes = ?,
                manifest_json = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now'),
                error_message = ?
            WHERE id = ?
        `).run(isDegraded ? 'degraded' : 'completed', archivePath, archiveSize, manifestJson, duration,
            isDegraded ? degradedMessage(skippedRequired) : null, backupId);

        console.log(`[BackupScheduler] Backup ${isDegraded ? 'DEGRADED' : 'completed'}: ${backupName} (${duration}ms)${isDegraded ? ` ${degradedMessage(skippedRequired)}` : ''}`);
    } else {
        prepare(`
            UPDATE backups
            SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(stderr || `Exit code ${code}`, duration, backupId);

        console.error(`[BackupScheduler] Backup failed: ${backupName} — ${stderr || `exit ${code}`}`);
    }

    // Update schedule with results (next_run_at was already claimed
    // before spawn; recomputing here keeps last_run_at/last_status/
    // last_backup_id fresh and is harmless to run again).
    const nextRun = calculateNextRun(
        schedule.schedule_type,
        schedule.schedule_hour,
        schedule.schedule_minute,
        schedule.schedule_day_of_week,
        schedule.schedule_day_of_month
    );

    prepare(`
        UPDATE backup_schedules
        SET last_run_at = datetime('now'), next_run_at = ?, last_backup_id = ?, last_status = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(nextRun, backupId, isDegraded ? 'degraded' : (status === 'completed' ? 'success' : 'failed'), schedule.id);

    logSchedulerAudit(schedule.org_id, isDegraded ? 'SCHEDULED_BACKUP_DEGRADED' : (status === 'completed' ? 'SCHEDULED_BACKUP_COMPLETED' : 'SCHEDULED_BACKUP_FAILED'), backupId, schedule.id, {
        scheduleName: schedule.name,
        duration,
        status: isDegraded ? 'degraded' : status,
        ...(isDegraded ? { skippedRequired } : {})
    });

    // Log to main audit trail so backup events appear in Org Audit Log.
    // actorId must be non-null (audit_events.actor_id NOT NULL); use a
    // string sentinel to match the convention in routes/inbox.js where
    // system-emitted events pass actorId: 'quoxflow' etc.
    createAuditEvent({
        orgId: schedule.org_id,
        actorType: 'system',
        actorId: 'backup_scheduler',
        action: isDegraded ? 'backup.scheduled_degraded' : (status === 'completed' ? 'backup.scheduled_completed' : 'backup.scheduled_failed'),
        targetType: 'backup',
        targetId: backupId,
        metadata: { scheduleName: schedule.name, scheduleId: schedule.id, durationMs: duration }
    });

    // Send inbox notification
    notifyBackupResult(schedule.org_id, schedule.name, backupId, status === 'completed' && !isDegraded, {
        sizeBytes: status === 'completed' ? (archiveSize || 0) : 0,
        durationMs: duration,
        degraded: isDegraded,
        error: isDegraded ? degradedMessage(skippedRequired) : (status === 'failed' ? (stderr || `Exit code ${code}`) : null)
    });

    // Enforce retention after successful backup
    if (status === 'completed') {
        await enforceRetention(schedule);
    }

}

/**
 * Enforce retention policy for a schedule
 * - Deletes backups older than retention_days
 * - Keeps at most max_backups for this schedule's org
 */
async function enforceRetention(schedule) {
    const { org_id, retention_days, max_backups } = schedule;

    try {
        // Delete expired backups (older than retention_days)
        if (retention_days > 0) {
            const cutoff = new Date(Date.now() - retention_days * 24 * 60 * 60 * 1000).toISOString();
            const expired = prepare(`
                SELECT id, archive_path FROM backups
                WHERE org_id = ? AND created_at < ? AND status IN ('completed', 'verified', 'degraded')
            `).all(org_id, cutoff);

            for (const backup of expired) {
                // Delete archive file
                if (backup.archive_path && existsSync(backup.archive_path)) {
                    try { await fs.unlink(backup.archive_path); } catch { /* ignore */ }
                }
                prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
            }

            if (expired.length > 0) {
                console.log(`[BackupScheduler] Retention cleanup: deleted ${expired.length} expired backups for org ${org_id}`);
                logSchedulerAudit(org_id, 'RETENTION_CLEANUP', null, schedule.id, {
                    deletedCount: expired.length,
                    retentionDays: retention_days
                });
            }
        }

        // Enforce max_backups limit
        if (max_backups > 0) {
            const excess = prepare(`
                SELECT id, archive_path FROM backups
                WHERE org_id = ? AND status IN ('completed', 'verified', 'degraded')
                ORDER BY created_at DESC
                LIMIT -1 OFFSET ?
            `).all(org_id, max_backups);

            for (const backup of excess) {
                if (backup.archive_path && existsSync(backup.archive_path)) {
                    try { await fs.unlink(backup.archive_path); } catch { /* ignore */ }
                }
                prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
            }

            if (excess.length > 0) {
                console.log(`[BackupScheduler] Max backups cleanup: deleted ${excess.length} oldest backups for org ${org_id}`);
                logSchedulerAudit(org_id, 'MAX_BACKUPS_CLEANUP', null, schedule.id, {
                    deletedCount: excess.length,
                    maxBackups: max_backups
                });
            }
        }
    } catch (err) {
        console.error(`[BackupScheduler] Retention enforcement failed: ${err.message}`);
    }
}

/**
 * Log a scheduler operation to the backup audit table
 */
function logSchedulerAudit(orgId, operation, backupId, scheduleId, metadata) {
    try {
        prepare(`
            INSERT INTO backup_audit_log (id, org_id, operation, defcon_level, backup_id, operator, result, metadata_json)
            VALUES (?, ?, ?, 'GREEN', ?, 'scheduler', 'success', ?)
        `).run(ulid(), orgId, operation, backupId, JSON.stringify({ ...metadata, scheduleId }));
    } catch (err) {
        console.error(`[BackupScheduler] Audit log failed: ${err.message}`);
    }
}

/**
 * Check for due schedules and trigger backups
 */
export async function checkAndRunDueSchedules() {
    if (isRunning) return; // Prevent concurrent runs
    isRunning = true;

    try {
        const now = new Date().toISOString();

        // Find all enabled schedules where next_run_at has passed
        const dueSchedules = prepare(`
            SELECT * FROM backup_schedules
            WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        `).all(now);

        if (dueSchedules.length > 0) {
            console.log(`[BackupScheduler] Found ${dueSchedules.length} due schedule(s)`);
        }

        // Run each due schedule sequentially to avoid resource contention
        for (const schedule of dueSchedules) {
            await runScheduledBackup(schedule);
        }
    } catch (err) {
        console.error(`[BackupScheduler] Check failed: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

/**
 * Start the backup scheduler daemon
 */
export async function startBackupScheduler() {
    if (schedulerInterval || schedulerStarting) {
        console.log('[BackupScheduler] Already running');
        return;
    }
    schedulerStarting = true;

    // Run an initial check after a short delay (let services stabilize) —
    // fixed at 5s, unaffected by the resolved interval below.
    setTimeout(() => {
        checkAndRunDueSchedules();
    }, 5000);

    // VAULT-INTEG P17: resolved once here, at scheduler-start call time — see
    // resolveCheckIntervalMs()'s own comment for the requiresRestart honesty
    // note (this interval is baked into the single setInterval below for the
    // scheduler's whole lifetime, same as before this pass, just no longer a
    // bare process.env read).
    const checkIntervalMs = await resolveCheckIntervalMs();
    if (!schedulerStarting) return; // stopBackupScheduler() ran during the await above

    console.log(`[BackupScheduler] Starting (check interval: ${checkIntervalMs}ms)`);

    // Set up recurring check
    schedulerInterval = setInterval(() => {
        checkAndRunDueSchedules();
    }, checkIntervalMs);

    // Don't prevent process exit
    schedulerInterval.unref();
}

/**
 * Stop the backup scheduler daemon
 */
export function stopBackupScheduler() {
    schedulerStarting = false;
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        console.log('[BackupScheduler] Stopped');
    }
}

export default { startBackupScheduler, stopBackupScheduler };
