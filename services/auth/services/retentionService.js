/**
 * Data Retention Service
 * Security Issue #73: No data retention policy or automatic cleanup
 *
 * Handles automatic cleanup of old data based on configurable retention policies.
 * Supports instance-level, org-level, and user-level retention settings.
 */

import { getDb } from '../db/index.js';
import { generateId } from '../utils/crypto.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Auto-archive window (days) for terminal inbox items. This is the lifecycle
// GRACE tier that sits BEFORE the hard delete of inbox_items (see
// DEFAULT_RETENTION.inbox_items below): terminal items older than this get
// their user-assignee rows archived so the Archive folder gathers them, well
// before deletion. Must stay < DEFAULT_RETENTION.inbox_items or it never fires
// (items would be deleted before they aged into the archive window).
// Configurable via instance_config key `retention.inbox_archive_days`.
const DEFAULT_INBOX_ARCHIVE_DAYS = 30;

// Default retention periods (days) - can be overridden by instance config
const DEFAULT_RETENTION = {
    audit_events: 365,         // 1 year for compliance
    sessions: 30,              // 30 days
    rate_limits: 7,            // 7 days
    run_events: 90,            // 90 days
    inbox_items: 90,           // 90 days
    notification_deliveries: 30, // 30 days
    system_logs: 30,           // 30 days
    api_key_access: 90,        // 90 days
    backup_audit: 365          // 1 year for compliance
};

// Data type to table mapping with cleanup queries
const CLEANUP_CONFIGS = {
    audit_events: {
        table: 'audit_events',
        dateColumn: 'created_at',
        // For org-scoped cleanup
        scopeColumn: 'org_id',
        // Additional conditions
        conditions: null
    },
    sessions: {
        table: 'sessions',
        dateColumn: 'created_at',
        scopeColumn: null, // Sessions are user-scoped, cleaned globally
        // Only clean revoked or expired sessions
        conditions: "(revoked_at IS NOT NULL OR expires_at < datetime('now'))"
    },
    rate_limits: {
        table: 'rate_limits',
        dateColumn: 'window_start',
        scopeColumn: null,
        conditions: null
    },
    run_events: {
        table: 'run_events',
        dateColumn: 'run_events.created_at',
        // Join through runs to get org_id
        scopeColumn: null,
        joinClause: 'JOIN runs r ON run_events.run_id = r.id',
        scopeJoinColumn: 'r.org_id'
    },
    inbox_items: {
        table: 'inbox_items',
        dateColumn: 'resolved_at',
        scopeColumn: 'org_id',
        // Only clean resolved items
        conditions: "status IN ('resolved', 'cancelled', 'expired') AND deleted_at IS NULL"
    },
    notification_deliveries: {
        table: 'notification_deliveries',
        dateColumn: 'created_at',
        scopeColumn: 'org_id',
        // Only clean completed deliveries
        conditions: "status IN ('delivered', 'failed', 'bounced')"
    },
    system_logs: {
        table: 'system_logs',
        dateColumn: 'created_at',
        scopeColumn: null,
        conditions: null
    },
    api_key_access: {
        table: 'api_key_access_log',
        dateColumn: 'api_key_access_log.created_at',
        scopeColumn: null, // Through api_keys table
        joinClause: 'JOIN api_keys ak ON api_key_access_log.api_key_id = ak.id',
        scopeJoinColumn: 'ak.scope_id'
    },
    backup_audit: {
        table: 'backup_audit_log',
        dateColumn: 'created_at',
        scopeColumn: 'org_id',
        conditions: null
    }
};

// ============================================================================
// RETENTION POLICY HELPERS
// ============================================================================

/**
 * Get instance-level retention configuration
 */
export function getInstanceRetentionConfig() {
    const db = getDb();
    const config = {};

    const rows = db.prepare(`
        SELECT key, value, value_type
        FROM instance_config
        WHERE key LIKE 'retention.%'
    `).all();

    for (const row of rows) {
        const key = row.key.replace('retention.', '');
        if (row.value_type === 'number') {
            config[key] = parseInt(row.value, 10) || DEFAULT_RETENTION[key.replace('_days', '')] || 90;
        } else if (row.value_type === 'boolean') {
            config[key] = row.value === 'true';
        } else {
            config[key] = row.value;
        }
    }

    // Fill in defaults
    for (const [dataType, days] of Object.entries(DEFAULT_RETENTION)) {
        const key = `${dataType}_days`;
        if (config[key] === undefined) {
            config[key] = days;
        }
    }

    if (config.cleanup_enabled === undefined) {
        config.cleanup_enabled = true;
    }
    if (config.cleanup_hour === undefined) {
        config.cleanup_hour = 3;
    }
    if (config.min_user_retention_days === undefined) {
        config.min_user_retention_days = 7;
    }
    // Surface the inbox auto-archive window in the config so the dashboard/
    // retention API reports it (no env-only switches). Read from
    // `retention.inbox_archive_days` above; default otherwise.
    if (config.inbox_archive_days === undefined) {
        config.inbox_archive_days = DEFAULT_INBOX_ARCHIVE_DAYS;
    }

    return config;
}

/**
 * Get org-level retention policy (with instance defaults fallback)
 */
export function getOrgRetentionPolicy(orgId) {
    const db = getDb();
    const instanceConfig = getInstanceRetentionConfig();

    const orgPolicy = db.prepare(`
        SELECT * FROM org_retention_policies WHERE org_id = ?
    `).get(orgId);

    if (!orgPolicy) {
        return {
            org_id: orgId,
            auto_cleanup_enabled: instanceConfig.cleanup_enabled,
            ...Object.fromEntries(
                Object.keys(DEFAULT_RETENTION).map(dt => [`${dt}_days`, instanceConfig[`${dt}_days`]])
            )
        };
    }

    // Merge with instance defaults
    const policy = { ...orgPolicy };
    for (const dataType of Object.keys(DEFAULT_RETENTION)) {
        const key = `${dataType}_days`;
        if (policy[key] === null || policy[key] === undefined) {
            policy[key] = instanceConfig[key];
        }
    }

    return policy;
}

/**
 * Get user retention preferences (with org defaults fallback)
 */
export function getUserRetentionPreferences(userId, orgId) {
    const db = getDb();
    const orgPolicy = getOrgRetentionPolicy(orgId);
    const instanceConfig = getInstanceRetentionConfig();

    const userPrefs = db.prepare(`
        SELECT * FROM user_retention_preferences WHERE user_id = ?
    `).get(userId);

    if (!userPrefs) {
        return {
            user_id: userId,
            personal_data_days: orgPolicy.audit_events_days,
            session_history_days: orgPolicy.sessions_days,
            audit_events_days: orgPolicy.audit_events_days,
            pending_deletions_json: '[]'
        };
    }

    // Enforce minimum retention and org caps
    const result = { ...userPrefs };
    const minDays = instanceConfig.min_user_retention_days;

    for (const key of ['personal_data_days', 'session_history_days', 'audit_events_days']) {
        if (result[key] !== null && result[key] !== undefined) {
            // Enforce minimum
            result[key] = Math.max(result[key], minDays);
            // Enforce org cap (user can't request longer than org policy)
            const orgKey = key === 'personal_data_days' ? 'audit_events_days' : key;
            const orgValue = orgPolicy[orgKey.replace('session_history', 'sessions')];
            if (orgValue) {
                result[key] = Math.min(result[key], orgValue);
            }
        }
    }

    return result;
}

/**
 * Update user retention preferences
 */
export function updateUserRetentionPreferences(userId, preferences) {
    const db = getDb();
    const instanceConfig = getInstanceRetentionConfig();
    const minDays = instanceConfig.min_user_retention_days;

    // Validate and cap values
    const validated = {};
    for (const [key, value] of Object.entries(preferences)) {
        if (['personal_data_days', 'session_history_days', 'audit_events_days'].includes(key)) {
            if (value !== null && value !== undefined) {
                validated[key] = Math.max(parseInt(value, 10) || minDays, minDays);
            }
        }
    }

    const existing = db.prepare(`
        SELECT id FROM user_retention_preferences WHERE user_id = ?
    `).get(userId);

    if (existing) {
        const updates = Object.keys(validated).map(k => `${k} = ?`).join(', ');
        if (updates) {
            db.prepare(`
                UPDATE user_retention_preferences
                SET ${updates}
                WHERE user_id = ?
            `).run(...Object.values(validated), userId);
        }
    } else {
        db.prepare(`
            INSERT INTO user_retention_preferences (id, user_id, personal_data_days, session_history_days, audit_events_days)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            generateId(),
            userId,
            validated.personal_data_days || null,
            validated.session_history_days || null,
            validated.audit_events_days || null
        );
    }

    return getUserRetentionPreferences(userId, null);
}

// ============================================================================
// CLEANUP FUNCTIONS
// ============================================================================

/**
 * Log a cleanup operation
 */
function logCleanup(db, options) {
    const {
        scopeType,
        scopeId,
        dataType,
        retentionDays,
        cutoffDate,
        recordsDeleted,
        bytesFreed,
        status,
        errorMessage,
        startedAt,
        triggeredBy
    } = options;

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt) - new Date(startedAt);

    db.prepare(`
        INSERT INTO retention_cleanup_log (
            id, scope_type, scope_id, data_type, retention_days, cutoff_date,
            records_deleted, bytes_freed, status, error_message,
            started_at, completed_at, duration_ms, triggered_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        generateId(),
        scopeType,
        scopeId || null,
        dataType,
        retentionDays,
        cutoffDate,
        recordsDeleted,
        bytesFreed || null,
        status,
        errorMessage || null,
        startedAt,
        completedAt,
        durationMs,
        triggeredBy
    );
}

/**
 * Clean up a specific data type for instance level
 */
function cleanupDataType(db, dataType, retentionDays, triggeredBy = 'system') {
    const config = CLEANUP_CONFIGS[dataType];
    if (!config) {
        console.warn(`[Retention] Unknown data type: ${dataType}`);
        return { deleted: 0, error: null };
    }

    const startedAt = new Date().toISOString();
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    try {
        // Build DELETE query
        let sql = `DELETE FROM ${config.table}`;

        if (config.joinClause) {
            // For tables that need joins, we need to use a subquery
            let subquery = `SELECT ${config.table}.rowid FROM ${config.table} ${config.joinClause}`;
            subquery += ` WHERE ${config.dateColumn} < ?`;
            if (config.conditions) {
                subquery += ` AND ${config.conditions}`;
            }
            sql = `DELETE FROM ${config.table} WHERE rowid IN (${subquery})`;
        } else {
            sql += ` WHERE ${config.dateColumn} < ?`;
            if (config.conditions) {
                sql += ` AND ${config.conditions}`;
            }
        }

        const result = db.prepare(sql).run(cutoffDate);

        logCleanup(db, {
            scopeType: 'instance',
            scopeId: null,
            dataType,
            retentionDays,
            cutoffDate,
            recordsDeleted: result.changes,
            status: 'completed',
            startedAt,
            triggeredBy
        });

        console.log(`[Retention] Cleaned ${result.changes} ${dataType} records older than ${retentionDays} days`);

        return { deleted: result.changes, error: null };

    } catch (error) {
        console.error(`[Retention] Error cleaning ${dataType}:`, error.message);

        logCleanup(db, {
            scopeType: 'instance',
            scopeId: null,
            dataType,
            retentionDays,
            cutoffDate,
            recordsDeleted: 0,
            status: 'failed',
            errorMessage: error.message,
            startedAt,
            triggeredBy
        });

        return { deleted: 0, error: error.message };
    }
}

/**
 * Auto-archive the GRACE tier for terminal inbox items.
 *
 * Terminal items (resolved/cancelled/expired) older than the archive window get
 * their user-assignee rows archived (archived_at set), so the frontend Archive
 * folder gathers them automatically and they leave the resolved/cancelled views,
 * well before the 90-day hard delete in cleanupDataType('inbox_items').
 *
 * - Terminal-only: never touches open/in_progress/waiting items (they have no
 *   resolved_at, and the status filter excludes them regardless).
 * - Age-gated on resolved_at (the moment the item reached its terminal state).
 * - Idempotent: only rows with archived_at IS NULL are updated, so re-runs are
 *   no-ops and existing archive stamps are never overwritten.
 * - Runs at instance scope (all orgs) inside the existing daily cleanup timer;
 *   it adds no new scheduler, so the loop-hygiene triad of the daily job covers
 *   it (try/catch accounting + logged outcome + durable archived_at retirement).
 *
 * Returns { archived, error }. archiveDays overrides the configured window
 * (used by tests); production callers omit it and take instance config.
 */
export function archiveOldTerminalInboxItems(triggeredBy = 'schedule', archiveDays) {
    const db = getDb();
    const instanceConfig = getInstanceRetentionConfig();
    const days = Number.isFinite(archiveDays)
        ? archiveDays
        : (instanceConfig.inbox_archive_days || DEFAULT_INBOX_ARCHIVE_DAYS);
    const startedAt = new Date().toISOString();
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    try {
        const result = db.prepare(`
            UPDATE inbox_item_assignees
            SET archived_at = datetime('now')
            WHERE assignee_type = 'user'
              AND archived_at IS NULL
              AND inbox_item_id IN (
                  SELECT id FROM inbox_items
                  WHERE status IN ('resolved', 'cancelled', 'expired')
                    AND deleted_at IS NULL
                    AND resolved_at IS NOT NULL
                    AND resolved_at < ?
              )
        `).run(cutoffDate);

        logCleanup(db, {
            scopeType: 'instance',
            scopeId: null,
            dataType: 'inbox_items_archive',
            retentionDays: days,
            cutoffDate,
            recordsDeleted: result.changes, // rows archived (log column is generic "records affected")
            status: 'completed',
            startedAt,
            triggeredBy
        });

        if (result.changes > 0) {
            console.log(`[Retention] Auto-archived ${result.changes} inbox assignee row(s) for terminal items older than ${days} days`);
        }

        return { archived: result.changes, error: null };

    } catch (error) {
        console.error('[Retention] Error auto-archiving inbox items:', error.message);
        logCleanup(db, {
            scopeType: 'instance',
            scopeId: null,
            dataType: 'inbox_items_archive',
            retentionDays: days,
            cutoffDate,
            recordsDeleted: 0,
            status: 'failed',
            errorMessage: error.message,
            startedAt,
            triggeredBy
        });
        return { archived: 0, error: error.message };
    }
}

/**
 * Clean up data for a specific org
 */
function cleanupOrgData(db, orgId, triggeredBy = 'system') {
    const policy = getOrgRetentionPolicy(orgId);

    if (!policy.auto_cleanup_enabled) {
        console.log(`[Retention] Cleanup disabled for org ${orgId}`);
        return { total: 0, details: {}, skipped: true };
    }

    const results = { total: 0, details: {} };

    for (const [dataType, config] of Object.entries(CLEANUP_CONFIGS)) {
        // Skip data types that don't have org scope
        if (!config.scopeColumn && !config.scopeJoinColumn) {
            continue;
        }

        const retentionDays = policy[`${dataType}_days`] || DEFAULT_RETENTION[dataType];
        const startedAt = new Date().toISOString();
        const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

        try {
            let sql;
            const scopeCol = config.scopeColumn || config.scopeJoinColumn;

            if (config.joinClause) {
                let subquery = `SELECT ${config.table}.rowid FROM ${config.table} ${config.joinClause}`;
                subquery += ` WHERE ${scopeCol} = ? AND ${config.dateColumn} < ?`;
                if (config.conditions) {
                    subquery += ` AND ${config.conditions}`;
                }
                sql = `DELETE FROM ${config.table} WHERE rowid IN (${subquery})`;
            } else {
                sql = `DELETE FROM ${config.table} WHERE ${scopeCol} = ? AND ${config.dateColumn} < ?`;
                if (config.conditions) {
                    sql += ` AND ${config.conditions}`;
                }
            }

            const result = db.prepare(sql).run(orgId, cutoffDate);

            results.details[dataType] = { deleted: result.changes };
            results.total += result.changes;

            if (result.changes > 0) {
                logCleanup(db, {
                    scopeType: 'org',
                    scopeId: orgId,
                    dataType,
                    retentionDays,
                    cutoffDate,
                    recordsDeleted: result.changes,
                    status: 'completed',
                    startedAt,
                    triggeredBy
                });
            }

        } catch (error) {
            console.error(`[Retention] Error cleaning ${dataType} for org ${orgId}:`, error.message);
            results.details[dataType] = { deleted: 0, error: error.message };
        }
    }

    return results;
}

/**
 * Run full instance-level cleanup
 */
export function runInstanceCleanup(triggeredBy = 'schedule') {
    const db = getDb();
    const instanceConfig = getInstanceRetentionConfig();

    if (!instanceConfig.cleanup_enabled) {
        console.log('[Retention] Instance cleanup is disabled');
        return { success: false, reason: 'disabled', results: {} };
    }

    console.log('[Retention] Starting instance-level cleanup...');

    const results = { total: 0, details: {} };

    // Clean each data type using instance retention settings
    for (const dataType of Object.keys(CLEANUP_CONFIGS)) {
        const retentionDays = instanceConfig[`${dataType}_days`] || DEFAULT_RETENTION[dataType];
        const { deleted, error } = cleanupDataType(db, dataType, retentionDays, triggeredBy);
        results.details[dataType] = { deleted, error };
        results.total += deleted;
    }

    // Update last cleanup timestamp
    db.prepare(`
        INSERT OR REPLACE INTO instance_config (key, value, value_type, description)
        VALUES ('retention.last_cleanup_at', ?, 'string', 'Timestamp of last cleanup run')
    `).run(new Date().toISOString());

    console.log(`[Retention] Instance cleanup complete. Total records cleaned: ${results.total}`);

    return { success: true, results };
}

/**
 * Run cleanup for all orgs
 */
export function runAllOrgsCleanup(triggeredBy = 'schedule') {
    const db = getDb();

    console.log('[Retention] Starting org-level cleanup for all orgs...');

    const orgs = db.prepare(`
        SELECT id FROM orgs WHERE deleted_at IS NULL
    `).all();

    const results = { total: 0, orgs: {} };

    for (const org of orgs) {
        const orgResult = cleanupOrgData(db, org.id, triggeredBy);
        results.orgs[org.id] = orgResult;
        results.total += orgResult.total;
    }

    console.log(`[Retention] Org cleanup complete. Total records cleaned: ${results.total}`);

    return results;
}

/**
 * Run full cleanup (instance + all orgs)
 */
export function runFullCleanup(triggeredBy = 'schedule') {
    console.log('[Retention] Starting full data retention cleanup...');

    // Grace tier first: archive aged terminal inbox items BEFORE the hard-delete
    // pass below reaches the 90-day band, so items pass through Archive on the way out.
    const archiveResult = archiveOldTerminalInboxItems(triggeredBy);

    const instanceResults = runInstanceCleanup(triggeredBy);
    const orgResults = runAllOrgsCleanup(triggeredBy);

    const totalCleaned = instanceResults.results.total + orgResults.total;

    console.log(`[Retention] Full cleanup complete. Archived: ${archiveResult.archived}, deleted: ${totalCleaned}`);

    return {
        inboxArchive: archiveResult,
        instance: instanceResults,
        orgs: orgResults,
        totalCleaned
    };
}

/**
 * Get cleanup statistics for dashboard
 */
export function getCleanupStats(orgId = null) {
    const db = getDb();

    // Recent cleanup log entries
    let logQuery = `
        SELECT
            scope_type, scope_id, data_type, retention_days,
            records_deleted, status, started_at, duration_ms, triggered_by
        FROM retention_cleanup_log
    `;

    if (orgId) {
        logQuery += ` WHERE scope_id = ? OR scope_type = 'instance'`;
    }

    logQuery += ` ORDER BY started_at DESC LIMIT 100`;

    const recentLogs = orgId
        ? db.prepare(logQuery).all(orgId)
        : db.prepare(logQuery).all();

    // Summary stats
    const summaryQuery = `
        SELECT
            data_type,
            SUM(records_deleted) as total_deleted,
            COUNT(*) as cleanup_count,
            MAX(started_at) as last_cleanup
        FROM retention_cleanup_log
        WHERE status = 'completed'
        ${orgId ? "AND (scope_id = ? OR scope_type = 'instance')" : ''}
        GROUP BY data_type
    `;

    const summary = orgId
        ? db.prepare(summaryQuery).all(orgId)
        : db.prepare(summaryQuery).all();

    // Instance config
    const instanceConfig = getInstanceRetentionConfig();

    return {
        config: instanceConfig,
        recentLogs,
        summary
    };
}

// ============================================================================
// SCHEDULED CLEANUP
// ============================================================================

let cleanupTimer = null;

/**
 * Calculate milliseconds until next scheduled cleanup
 */
function msUntilNextCleanup(cleanupHour) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(cleanupHour, 0, 0, 0);

    // If we've passed the cleanup hour today, schedule for tomorrow
    if (now >= next) {
        next.setDate(next.getDate() + 1);
    }

    return next.getTime() - now.getTime();
}

/**
 * Start the scheduled cleanup job
 */
export function startScheduledCleanup() {
    if (cleanupTimer) {
        console.log('[Retention] Scheduled cleanup already running');
        return;
    }

    const instanceConfig = getInstanceRetentionConfig();

    if (!instanceConfig.cleanup_enabled) {
        console.log('[Retention] Scheduled cleanup is disabled');
        return;
    }

    const cleanupHour = instanceConfig.cleanup_hour || 3;

    // Schedule first run
    const scheduleNextRun = () => {
        const msUntilRun = msUntilNextCleanup(cleanupHour);
        const nextRunTime = new Date(Date.now() + msUntilRun);

        console.log(`[Retention] Next cleanup scheduled for ${nextRunTime.toISOString()}`);

        cleanupTimer = setTimeout(() => {
            try {
                runFullCleanup('schedule');
            } catch (error) {
                console.error('[Retention] Scheduled cleanup failed:', error.message);
            }

            // Schedule next run
            scheduleNextRun();
        }, msUntilRun);

        // Don't prevent process exit
        cleanupTimer.unref();
    };

    scheduleNextRun();
    console.log(`[Retention] Scheduled cleanup started (runs daily at ${cleanupHour}:00)`);
}

/**
 * Stop the scheduled cleanup job
 */
export function stopScheduledCleanup() {
    if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
        console.log('[Retention] Scheduled cleanup stopped');
    }
}

/**
 * Check if scheduled cleanup is running
 */
export function isScheduledCleanupRunning() {
    return cleanupTimer !== null;
}

export default {
    // Configuration
    getInstanceRetentionConfig,
    getOrgRetentionPolicy,
    getUserRetentionPreferences,
    updateUserRetentionPreferences,

    // Cleanup functions
    runInstanceCleanup,
    runAllOrgsCleanup,
    runFullCleanup,
    archiveOldTerminalInboxItems,
    getCleanupStats,

    // Scheduling
    startScheduledCleanup,
    stopScheduledCleanup,
    isScheduledCleanupRunning
};
