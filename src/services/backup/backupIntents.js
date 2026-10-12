/**
 * Backup AEE Intents
 * Defines intents for backup operations in the AEE protocol.
 *
 * These intents are used to log backup activities to the activity feed
 * and enable correlation of backup-related events.
 */

import { createEvent, storeEnvelope } from '../../lib/aee/index.js'

/**
 * Backup operation intents
 */
export const BACKUP_INTENTS = {
    // Backup lifecycle
    BACKUP_STARTED: 'quox.backup.started',
    BACKUP_PROGRESS: 'quox.backup.progress',
    BACKUP_COMPLETED: 'quox.backup.completed',
    BACKUP_FAILED: 'quox.backup.failed',
    BACKUP_CANCELLED: 'quox.backup.cancelled',

    // Verification
    VERIFY_STARTED: 'quox.backup.verify.started',
    VERIFY_COMPLETED: 'quox.backup.verify.completed',
    VERIFY_FAILED: 'quox.backup.verify.failed',

    // Restore lifecycle
    RESTORE_STARTED: 'quox.restore.started',
    RESTORE_PROGRESS: 'quox.restore.progress',
    RESTORE_COMPLETED: 'quox.restore.completed',
    RESTORE_FAILED: 'quox.restore.failed',
    RESTORE_DRY_RUN: 'quox.restore.dry_run',

    // Schedule events
    SCHEDULE_CREATED: 'quox.backup.schedule.created',
    SCHEDULE_UPDATED: 'quox.backup.schedule.updated',
    SCHEDULE_DELETED: 'quox.backup.schedule.deleted',
    SCHEDULE_TRIGGERED: 'quox.backup.schedule.triggered',

    // Maintenance
    CLEANUP_STARTED: 'quox.backup.cleanup.started',
    CLEANUP_COMPLETED: 'quox.backup.cleanup.completed'
}

/**
 * DEFCON levels for UI display
 */
export const DEFCON_COLORS = {
    GREEN: { bg: '#dcfce7', text: '#166534', label: 'Normal' },
    BLUE: { bg: '#dbeafe', text: '#1e40af', label: 'Elevated' },
    AMBER: { bg: '#fef3c7', text: '#92400e', label: 'Moderate' },
    ORANGE: { bg: '#fed7aa', text: '#c2410c', label: 'High' },
    RED: { bg: '#fecaca', text: '#b91c1c', label: 'Critical' }
}

/**
 * Generate a correlation ID for backup operations
 * @param {string} backupId - Backup ID
 * @returns {string} Correlation ID
 */
export function generateBackupCorrelation(backupId) {
    return `BACKUP_${backupId}_${Date.now()}`
}

/**
 * Log backup started event
 * @param {Object} backup - Backup details
 * @returns {Promise<Object>} Stored envelope
 */
export async function logBackupStarted(backup) {
    const correlationId = generateBackupCorrelation(backup.id)

    const event = createEvent(
        'plugin.backup',
        BACKUP_INTENTS.BACKUP_STARTED,
        {
            backupId: backup.id,
            backupType: backup.backup_type,
            name: backup.name,
            components: backup.components,
            timestamp: Date.now()
        },
        correlationId
    )

    await storeEnvelope(event)
    return event
}

/**
 * Log backup progress event
 * @param {string} backupId - Backup ID
 * @param {Object} progress - Progress details
 * @param {string} correlationId - Correlation ID
 * @returns {Promise<Object>} Stored envelope
 */
export async function logBackupProgress(backupId, progress, correlationId) {
    const event = createEvent(
        'plugin.backup',
        BACKUP_INTENTS.BACKUP_PROGRESS,
        {
            backupId,
            percent: progress.percent,
            currentComponent: progress.component,
            filesProcessed: progress.files,
            bytesProcessed: progress.bytes,
            timestamp: Date.now()
        },
        correlationId
    )

    await storeEnvelope(event)
    return event
}

/**
 * Log backup completed event
 * @param {Object} backup - Completed backup details
 * @param {string} correlationId - Correlation ID
 * @returns {Promise<Object>} Stored envelope
 */
export async function logBackupCompleted(backup, correlationId) {
    const event = createEvent(
        'plugin.backup',
        BACKUP_INTENTS.BACKUP_COMPLETED,
        {
            backupId: backup.id,
            archivePath: backup.archive_path,
            sizeBytes: backup.archive_size_bytes,
            duration: backup.duration_ms,
            verified: backup.status === 'verified',
            timestamp: Date.now()
        },
        correlationId
    )

    await storeEnvelope(event)
    return event
}

/**
 * Log backup failed event
 * @param {string} backupId - Backup ID
 * @param {string} error - Error message
 * @param {string} correlationId - Correlation ID
 * @returns {Promise<Object>} Stored envelope
 */
export async function logBackupFailed(backupId, error, correlationId) {
    const event = createEvent(
        'plugin.backup',
        BACKUP_INTENTS.BACKUP_FAILED,
        {
            backupId,
            error,
            timestamp: Date.now()
        },
        correlationId
    )

    await storeEnvelope(event)
    return event
}

/**
 * Log restore started event
 * @param {Object} restore - Restore operation details
 * @returns {Promise<Object>} Stored envelope
 */
export async function logRestoreStarted(restore) {
    const correlationId = `RESTORE_${restore.id}_${Date.now()}`

    const event = createEvent(
        'plugin.backup',
        restore.dry_run ? BACKUP_INTENTS.RESTORE_DRY_RUN : BACKUP_INTENTS.RESTORE_STARTED,
        {
            restoreId: restore.id,
            backupId: restore.backup_id,
            dryRun: restore.dry_run,
            components: restore.components,
            timestamp: Date.now()
        },
        correlationId
    )

    await storeEnvelope(event)
    return event
}

/**
 * Log restore completed event
 * @param {Object} restore - Completed restore details
 * @param {string} correlationId - Correlation ID
 * @returns {Promise<Object>} Stored envelope
 */
export async function logRestoreCompleted(restore, correlationId) {
    const event = createEvent(
        'plugin.backup',
        BACKUP_INTENTS.RESTORE_COMPLETED,
        {
            restoreId: restore.id,
            backupId: restore.backup_id,
            filesRestored: restore.files_restored,
            bytesRestored: restore.bytes_restored,
            duration: restore.duration_ms,
            dryRun: restore.dry_run,
            timestamp: Date.now()
        },
        correlationId
    )

    await storeEnvelope(event)
    return event
}

/**
 * Log verification event
 * @param {string} backupId - Backup ID
 * @param {Object} result - Verification result
 * @returns {Promise<Object>} Stored envelope
 */
export async function logVerification(backupId, result) {
    const correlationId = `VERIFY_${backupId}_${Date.now()}`
    const intent = result.valid ? BACKUP_INTENTS.VERIFY_COMPLETED : BACKUP_INTENTS.VERIFY_FAILED

    const event = createEvent(
        'plugin.backup',
        intent,
        {
            backupId,
            valid: result.valid,
            matches: result.matches,
            mismatches: result.mismatches?.length || 0,
            missing: result.missing?.length || 0,
            timestamp: Date.now()
        },
        correlationId
    )

    await storeEnvelope(event)
    return event
}

/**
 * Log schedule event
 * @param {string} action - 'created', 'updated', 'deleted', or 'triggered'
 * @param {Object} schedule - Schedule details
 * @returns {Promise<Object>} Stored envelope
 */
export async function logScheduleEvent(action, schedule) {
    const intentMap = {
        created: BACKUP_INTENTS.SCHEDULE_CREATED,
        updated: BACKUP_INTENTS.SCHEDULE_UPDATED,
        deleted: BACKUP_INTENTS.SCHEDULE_DELETED,
        triggered: BACKUP_INTENTS.SCHEDULE_TRIGGERED
    }

    const event = createEvent(
        'plugin.backup',
        intentMap[action] || BACKUP_INTENTS.SCHEDULE_UPDATED,
        {
            scheduleId: schedule.id,
            name: schedule.name,
            scheduleType: schedule.schedule_type,
            backupType: schedule.backup_type,
            enabled: schedule.enabled,
            timestamp: Date.now()
        },
        `SCHEDULE_${schedule.id}`
    )

    await storeEnvelope(event)
    return event
}

export default {
    BACKUP_INTENTS,
    DEFCON_COLORS,
    generateBackupCorrelation,
    logBackupStarted,
    logBackupProgress,
    logBackupCompleted,
    logBackupFailed,
    logRestoreStarted,
    logRestoreCompleted,
    logVerification,
    logScheduleEvent
}
