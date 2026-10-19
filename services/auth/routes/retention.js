/**
 * Data Retention Routes
 * Security Issue #73: No data retention policy or automatic cleanup
 *
 * API endpoints for managing data retention policies and viewing cleanup logs.
 */

import express from 'express';
import { getDb } from '../db/index.js';
import { generateId } from '../utils/crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole, requireOrgScope } from '../middleware/authorize.js';
import { OrgRoles } from '../utils/policy.js';
import { checkInstanceAdmin } from '../middleware/instanceAdmin.js';
import { hasValidInternalServiceKey } from '../utils/internalServiceAuth.js';
import { isNonHumanPrincipal } from '../utils/principal.js';
import { logAudit, AuditActions } from '../utils/audit.js';
import {
    getInstanceRetentionConfig,
    getOrgRetentionPolicy,
    getUserRetentionPreferences,
    updateUserRetentionPreferences,
    runInstanceCleanup,
    runAllOrgsCleanup,
    runFullCleanup,
    getCleanupStats,
    isScheduledCleanupRunning
} from '../services/retentionService.js';

const router = express.Router();

// ============================================================================
// INSTANCE ADMIN ROUTES
// ============================================================================

/**
 * GET /api/admin/retention/config
 * Get instance-level retention configuration
 * Requires: instance admin
 */
router.get('/admin/retention/config', requireAuth, requireAdmin(), (req, res) => {
    try {
        const config = getInstanceRetentionConfig();

        res.json({
            config,
            scheduledCleanupRunning: isScheduledCleanupRunning()
        });

    } catch (error) {
        console.error('Get retention config error:', error);
        res.status(500).json({ error: 'Failed to get retention configuration' });
    }
});

/**
 * PATCH /api/admin/retention/config/:key
 * Update instance retention configuration
 * Requires: instance admin
 */
router.patch('/admin/retention/config/:key', requireAuth, requireAdmin(), (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    // Validate key is a retention setting
    if (!key.startsWith('retention.') && !['cleanup_enabled', 'cleanup_hour', 'default_days', 'min_user_retention_days'].includes(key)) {
        return res.status(400).json({ error: 'Invalid retention configuration key' });
    }

    const fullKey = key.startsWith('retention.') ? key : `retention.${key}`;

    try {
        const db = getDb();

        // Determine value type
        let valueType = 'string';
        let processedValue = value;

        if (typeof value === 'boolean' || value === 'true' || value === 'false') {
            valueType = 'boolean';
            processedValue = String(value);
        } else if (typeof value === 'number' || !isNaN(parseInt(value, 10))) {
            valueType = 'number';
            processedValue = String(parseInt(value, 10));
        }

        // Validate number values
        if (valueType === 'number') {
            const num = parseInt(processedValue, 10);
            if (fullKey.includes('_days') && (num < 1 || num > 3650)) {
                return res.status(400).json({ error: 'Retention days must be between 1 and 3650' });
            }
            if (fullKey === 'retention.cleanup_hour' && (num < 0 || num > 23)) {
                return res.status(400).json({ error: 'Cleanup hour must be between 0 and 23' });
            }
        }

        db.prepare(`
            INSERT OR REPLACE INTO instance_config (key, value, value_type, updated_at, updated_by)
            VALUES (?, ?, ?, datetime('now'), ?)
        `).run(fullKey, processedValue, valueType, req.user.id);

        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: fullKey },
            status: 'success',
            request: req,
            metadata: { key: fullKey, newValue: processedValue }
        });

        res.json({
            success: true,
            key: fullKey,
            value: processedValue
        });

    } catch (error) {
        console.error('Update retention config error:', error);
        res.status(500).json({ error: 'Failed to update retention configuration' });
    }
});

/**
 * POST /api/admin/retention/cleanup
 * Trigger a manual cleanup
 * Requires: instance admin
 */
// quox#1085: the instance owner is a HUMAN instance_admins superadmin. An
// agent token carrying the owner's user id is not the owner.
function isHumanInstanceOwner(req) {
    if (!req.user || isNonHumanPrincipal(req)) return false;
    const { isAdmin, role } = checkInstanceAdmin(req.user.id);
    return isAdmin && role === 'superadmin';
}

// An internal service caller (X-Service-Key == INTERNAL_SERVICE_KEY, strict,
// no loopback fallback) is trusted instance-wide and skips user auth. Everyone
// else needs a user token; the instance owner passes even without an org admin
// role, anyone else must be an org admin.
function cleanupCaller(req, res, next) {
    if (hasValidInternalServiceKey(req)) {
        req.service = { type: 'internal_service' };
        return next();
    }
    return requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (isHumanInstanceOwner(req)) {
            req.retentionInstanceOwner = true;
            return next();
        }
        return requireAdmin()(req, res, next);
    });
}

router.post('/admin/retention/cleanup', cleanupCaller, async (req, res) => {
    const body = req.body || {};
    const { scope = 'full' } = body; // 'full', 'instance', 'orgs'
    const rawDryRun = body.dry_run;

    // quox#1085: authorise the scope BEFORE anything runs, dry run or not.
    // 'full' and 'instance' (and any unknown scope, which falls through to
    // 'full') purge rows across EVERY org, so only the instance owner or a
    // service key may run them. An org admin may run 'orgs' for the org in its
    // verified token only; an org id named in the body or query that is not
    // that org is refused, never trusted.
    const instanceWide = !!req.service || req.retentionInstanceOwner === true;
    const namedOrg = body.org_id ?? body.orgId ?? req.query?.org_id ?? req.query?.orgId ?? null;
    let cleanupOrgId = null;
    if (scope !== 'orgs') {
        if (!instanceWide) {
            return res.status(403).json({
                error: 'instance_owner_required',
                message: `Retention cleanup scope '${scope}' affects every organisation and needs the instance owner or a service key. An org admin can run scope 'orgs' for their own organisation. Nothing was cleaned.`
            });
        }
    } else if (instanceWide) {
        cleanupOrgId = namedOrg || null;
    } else {
        const ownOrgId = req.org?.id || null;
        if (!ownOrgId) {
            return res.status(403).json({
                error: 'no_org_membership',
                message: 'Retention cleanup for an organisation needs a verified organisation context. Nothing was cleaned.'
            });
        }
        if (namedOrg && namedOrg !== ownOrgId) {
            return res.status(403).json({
                error: 'cross_org_access',
                message: 'You can only run retention cleanup for your own organisation. Nothing was cleaned.'
            });
        }
        cleanupOrgId = ownOrgId;
    }

    // quox#1084: dry_run used to be ignored, so `--dry-run` deleted for real.
    // Boolean only, like admin-backups.js: a string "true" or "yes" is refused
    // rather than coerced, because guessing wrong here destroys data.
    if (rawDryRun !== undefined && typeof rawDryRun !== 'boolean') {
        return res.status(400).json({
            error: 'invalid_dry_run',
            message: 'dry_run must be a boolean (true or false) when supplied. Nothing was cleaned.'
        });
    }
    const dryRun = rawDryRun === true;

    try {
        const actorId = req.user?.id || 'internal_service';
        console.log(`[Retention] Manual cleanup${dryRun ? ' preview (dry run)' : ''} (scope ${scope}${cleanupOrgId ? `, org ${cleanupOrgId}` : ''}) triggered by ${req.service ? 'service key' : `user ${actorId}`}`);

        let results;
        switch (scope) {
            case 'instance':
                results = runInstanceCleanup('admin', { dryRun });
                break;
            case 'orgs':
                results = runAllOrgsCleanup('admin', { dryRun, orgId: cleanupOrgId });
                break;
            case 'full':
            default:
                results = runFullCleanup('admin', { dryRun });
        }

        logAudit({
            action: dryRun ? 'retention.cleanup.dry_run' : 'retention.cleanup.manual',
            actor: req.service ? { type: 'service', id: 'internal_service' } : { type: 'user', id: actorId },
            ...(cleanupOrgId ? { orgId: cleanupOrgId } : {}),
            status: 'success',
            request: req,
            metadata: dryRun
                ? { scope, dry_run: true, wouldDelete: results.totalWouldDelete ?? results.would_delete ?? results.results?.would_delete ?? 0 }
                : { scope, totalCleaned: results.totalCleaned || results.total }
        });

        res.json(dryRun
            ? { success: true, dry_run: true, results }
            : { success: true, results });

    } catch (error) {
        console.error('Manual cleanup error:', error);
        res.status(500).json({ error: 'Cleanup failed', message: error.message });
    }
});

/**
 * GET /api/admin/retention/stats
 * Get cleanup statistics
 * Requires: instance admin
 */
router.get('/admin/retention/stats', requireAuth, requireAdmin(), (req, res) => {
    try {
        const stats = getCleanupStats();

        res.json(stats);

    } catch (error) {
        console.error('Get retention stats error:', error);
        res.status(500).json({ error: 'Failed to get retention statistics' });
    }
});

/**
 * GET /api/admin/retention/logs
 * Get cleanup log entries
 * Requires: instance admin
 */
router.get('/admin/retention/logs', requireAuth, requireAdmin(), (req, res) => {
    const { limit = 100, offset = 0, dataType, status } = req.query;

    try {
        const db = getDb();

        let query = `
            SELECT * FROM retention_cleanup_log
            WHERE 1=1
        `;
        const params = [];

        if (dataType) {
            query += ` AND data_type = ?`;
            params.push(dataType);
        }
        if (status) {
            query += ` AND status = ?`;
            params.push(status);
        }

        query += ` ORDER BY started_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));

        const logs = db.prepare(query).all(...params);

        res.json({ logs });

    } catch (error) {
        console.error('Get retention logs error:', error);
        res.status(500).json({ error: 'Failed to get retention logs' });
    }
});

// ============================================================================
// ORG-LEVEL ROUTES
// ============================================================================

/**
 * GET /api/orgs/:orgId/retention
 * Get org retention policy
 * Requires: org admin
 */
router.get('/orgs/:orgId/retention', requireAuth, requireOrgScope(), requireRole(OrgRoles.ADMIN), (req, res) => {
    const { orgId } = req.params;

    try {
        const policy = getOrgRetentionPolicy(orgId);
        const instanceConfig = getInstanceRetentionConfig();

        res.json({
            policy,
            instanceDefaults: instanceConfig,
            canOverride: true
        });

    } catch (error) {
        console.error('Get org retention policy error:', error);
        res.status(500).json({ error: 'Failed to get retention policy' });
    }
});

/**
 * PUT /api/orgs/:orgId/retention
 * Update org retention policy
 * Requires: org admin
 */
router.put('/orgs/:orgId/retention', requireAuth, requireOrgScope(), requireRole(OrgRoles.ADMIN), (req, res) => {
    const { orgId } = req.params;
    const {
        auto_cleanup_enabled,
        audit_events_days,
        sessions_days,
        rate_limits_days,
        run_events_days,
        inbox_items_days,
        notification_deliveries_days,
        system_logs_days,
        api_key_access_days,
        backup_audit_days,
        artifacts_days
    } = req.body;

    try {
        const db = getDb();
        const instanceConfig = getInstanceRetentionConfig();

        // Validate: org can't set longer retention than instance allows
        const validateDays = (value, instanceKey) => {
            if (value === null || value === undefined) return null;
            const num = parseInt(value, 10);
            if (isNaN(num) || num < 1) return null;
            // Org can set shorter, but not longer than instance
            const instanceMax = instanceConfig[instanceKey] || 365;
            return Math.min(num, instanceMax);
        };

        const existing = db.prepare(`
            SELECT id FROM org_retention_policies WHERE org_id = ?
        `).get(orgId);

        if (existing) {
            db.prepare(`
                UPDATE org_retention_policies SET
                    auto_cleanup_enabled = ?,
                    audit_events_days = ?,
                    sessions_days = ?,
                    rate_limits_days = ?,
                    run_events_days = ?,
                    inbox_items_days = ?,
                    notification_deliveries_days = ?,
                    system_logs_days = ?,
                    api_key_access_days = ?,
                    backup_audit_days = ?,
                    artifacts_days = ?
                WHERE org_id = ?
            `).run(
                auto_cleanup_enabled !== undefined ? (auto_cleanup_enabled ? 1 : 0) : 1,
                validateDays(audit_events_days, 'audit_events_days'),
                validateDays(sessions_days, 'sessions_days'),
                validateDays(rate_limits_days, 'rate_limits_days'),
                validateDays(run_events_days, 'run_events_days'),
                validateDays(inbox_items_days, 'inbox_items_days'),
                validateDays(notification_deliveries_days, 'notification_deliveries_days'),
                validateDays(system_logs_days, 'system_logs_days'),
                validateDays(api_key_access_days, 'api_key_access_days'),
                validateDays(backup_audit_days, 'backup_audit_days'),
                validateDays(artifacts_days, 'artifacts_days'),
                orgId
            );
        } else {
            db.prepare(`
                INSERT INTO org_retention_policies (
                    id, org_id, auto_cleanup_enabled,
                    audit_events_days, sessions_days, rate_limits_days,
                    run_events_days, inbox_items_days, notification_deliveries_days,
                    system_logs_days, api_key_access_days, backup_audit_days, artifacts_days,
                    created_by
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                generateId(),
                orgId,
                auto_cleanup_enabled !== undefined ? (auto_cleanup_enabled ? 1 : 0) : 1,
                validateDays(audit_events_days, 'audit_events_days'),
                validateDays(sessions_days, 'sessions_days'),
                validateDays(rate_limits_days, 'rate_limits_days'),
                validateDays(run_events_days, 'run_events_days'),
                validateDays(inbox_items_days, 'inbox_items_days'),
                validateDays(notification_deliveries_days, 'notification_deliveries_days'),
                validateDays(system_logs_days, 'system_logs_days'),
                validateDays(api_key_access_days, 'api_key_access_days'),
                validateDays(backup_audit_days, 'backup_audit_days'),
                validateDays(artifacts_days, 'artifacts_days'),
                req.user.id
            );
        }

        logAudit({
            action: 'retention.policy.update',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'org', id: orgId },
            orgId,
            status: 'success',
            request: req,
            metadata: { changes: req.body }
        });

        const policy = getOrgRetentionPolicy(orgId);
        res.json({ success: true, policy });

    } catch (error) {
        console.error('Update org retention policy error:', error);
        res.status(500).json({ error: 'Failed to update retention policy' });
    }
});

/**
 * GET /api/orgs/:orgId/retention/stats
 * Get cleanup statistics for org
 * Requires: org admin
 */
router.get('/orgs/:orgId/retention/stats', requireAuth, requireOrgScope(), requireRole(OrgRoles.ADMIN), (req, res) => {
    const { orgId } = req.params;

    try {
        const stats = getCleanupStats(orgId);

        res.json(stats);

    } catch (error) {
        console.error('Get org retention stats error:', error);
        res.status(500).json({ error: 'Failed to get retention statistics' });
    }
});

// ============================================================================
// USER-LEVEL ROUTES
// ============================================================================

/**
 * GET /api/users/me/retention
 * Get current user's retention preferences
 */
router.get('/users/me/retention', requireAuth, (req, res) => {
    try {
        const preferences = getUserRetentionPreferences(req.user.id, req.user.orgId);
        const instanceConfig = getInstanceRetentionConfig();

        res.json({
            preferences,
            minRetentionDays: instanceConfig.min_user_retention_days
        });

    } catch (error) {
        console.error('Get user retention preferences error:', error);
        res.status(500).json({ error: 'Failed to get retention preferences' });
    }
});

/**
 * PUT /api/users/me/retention
 * Update current user's retention preferences
 */
router.put('/users/me/retention', requireAuth, (req, res) => {
    const {
        personal_data_days,
        session_history_days,
        audit_events_days
    } = req.body;

    try {
        const updated = updateUserRetentionPreferences(req.user.id, {
            personal_data_days,
            session_history_days,
            audit_events_days
        });

        logAudit({
            action: 'retention.preferences.update',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'user', id: req.user.id },
            status: 'success',
            request: req,
            metadata: { changes: req.body }
        });

        res.json({ success: true, preferences: updated });

    } catch (error) {
        console.error('Update user retention preferences error:', error);
        res.status(500).json({ error: 'Failed to update retention preferences' });
    }
});

/**
 * POST /api/users/me/retention/request-deletion
 * Request immediate deletion of specific personal data
 */
router.post('/users/me/retention/request-deletion', requireAuth, (req, res) => {
    const { dataTypes } = req.body;

    if (!Array.isArray(dataTypes) || dataTypes.length === 0) {
        return res.status(400).json({ error: 'dataTypes must be a non-empty array' });
    }

    // Validate data types
    const allowedTypes = ['session_history', 'audit_events'];
    const validTypes = dataTypes.filter(dt => allowedTypes.includes(dt));

    if (validTypes.length === 0) {
        return res.status(400).json({
            error: 'No valid data types specified',
            allowedTypes
        });
    }

    try {
        const db = getDb();

        // Get or create user retention preferences
        const existing = db.prepare(`
            SELECT id, pending_deletions_json FROM user_retention_preferences WHERE user_id = ?
        `).get(req.user.id);

        const pendingDeletions = existing?.pending_deletions_json
            ? JSON.parse(existing.pending_deletions_json)
            : [];

        // Add new deletion requests (avoid duplicates)
        for (const dt of validTypes) {
            if (!pendingDeletions.includes(dt)) {
                pendingDeletions.push(dt);
            }
        }

        if (existing) {
            db.prepare(`
                UPDATE user_retention_preferences
                SET pending_deletions_json = ?
                WHERE user_id = ?
            `).run(JSON.stringify(pendingDeletions), req.user.id);
        } else {
            db.prepare(`
                INSERT INTO user_retention_preferences (id, user_id, pending_deletions_json)
                VALUES (?, ?, ?)
            `).run(generateId(), req.user.id, JSON.stringify(pendingDeletions));
        }

        logAudit({
            action: 'retention.deletion.requested',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'user', id: req.user.id },
            status: 'success',
            request: req,
            metadata: { dataTypes: validTypes }
        });

        res.json({
            success: true,
            message: 'Deletion request queued. Data will be removed during the next cleanup cycle.',
            pendingDeletions
        });

    } catch (error) {
        console.error('Request deletion error:', error);
        res.status(500).json({ error: 'Failed to request data deletion' });
    }
});

export default router;
