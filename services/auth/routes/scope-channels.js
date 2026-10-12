/**
 * Scope-Channel Assignment Routes — Phase D5
 *
 * Manages which notification channels are enabled per org scope.
 * Also serves delivery analytics aggregated server-side.
 */

import { Router } from 'express';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';

const router = Router();

router.use(requireAuth);

// ============================================================================
// Scope-Channel Assignments CRUD
// ============================================================================

/**
 * GET /orgs/:orgId/scope-channel-assignments
 * List all scope-channel assignments for an org, optionally filtered by scope_id.
 */
router.get('/orgs/:orgId/scope-channel-assignments', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { scope_id } = req.query;

        let sql = `
            SELECT sca.*, s.name_cache as scope_name, s.scope_type, s.depth, s.path
            FROM scope_channel_assignments sca
            LEFT JOIN scopes s ON sca.scope_id = s.id
            WHERE sca.org_id = ?
        `;
        const params = [orgId];

        if (scope_id) {
            sql += ' AND sca.scope_id = ?';
            params.push(scope_id);
        }

        sql += ' ORDER BY s.depth ASC, s.name_cache ASC, sca.channel_type ASC';

        const assignments = prepare(sql).all(...params);

        res.json({ data: assignments });
    } catch (err) {
        console.error('[ScopeChannels] List error:', err.message);
        res.status(500).json({ error: 'Failed to fetch scope-channel assignments' });
    }
});

/**
 * PUT /orgs/:orgId/scope-channel-assignments
 * Toggle a single scope-channel assignment (upsert).
 * Body: { scope_id, channel_type, enabled }
 */
router.put('/orgs/:orgId/scope-channel-assignments', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { scope_id, channel_type, enabled } = req.body;

        if (!scope_id || !channel_type) {
            return res.status(400).json({ error: 'scope_id and channel_type are required' });
        }

        // Permission check
        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        // Verify scope belongs to this org
        const scope = prepare('SELECT id FROM scopes WHERE id = ? AND org_id = ?').get(scope_id, orgId);
        if (!scope) {
            return res.status(404).json({ error: 'Scope not found in this organization' });
        }

        const enabledInt = enabled ? 1 : 0;
        const id = ulid();

        // Upsert: insert or update
        const existing = prepare(
            'SELECT id FROM scope_channel_assignments WHERE scope_id = ? AND channel_type = ?'
        ).get(scope_id, channel_type);

        if (existing) {
            prepare(`
                UPDATE scope_channel_assignments
                SET enabled = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(enabledInt, existing.id);
        } else {
            prepare(`
                INSERT INTO scope_channel_assignments (id, org_id, scope_id, channel_type, enabled, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(id, orgId, scope_id, channel_type, enabledInt, req.user.id);
        }

        // Audit
        createAuditEvent(orgId, req.user.id, 'scope_channel_assignment.toggle', {
            scope_id, channel_type, enabled: enabledInt
        });

        const result = prepare(`
            SELECT sca.*, s.name_cache as scope_name
            FROM scope_channel_assignments sca
            LEFT JOIN scopes s ON sca.scope_id = s.id
            WHERE sca.scope_id = ? AND sca.channel_type = ?
        `).get(scope_id, channel_type);

        res.json(result);
    } catch (err) {
        console.error('[ScopeChannels] Toggle error:', err.message);
        res.status(500).json({ error: 'Failed to toggle scope-channel assignment' });
    }
});

/**
 * PUT /orgs/:orgId/scope-channel-assignments/bulk
 * Batch upsert assignments.
 * Body: { assignments: [{ scope_id, channel_type, enabled }, ...] }
 */
router.put('/orgs/:orgId/scope-channel-assignments/bulk', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { assignments } = req.body;

        if (!Array.isArray(assignments) || assignments.length === 0) {
            return res.status(400).json({ error: 'assignments array is required' });
        }

        if (assignments.length > 500) {
            return res.status(400).json({ error: 'Maximum 500 assignments per batch' });
        }

        // Permission check
        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        let updated = 0;
        let created = 0;

        for (const a of assignments) {
            if (!a.scope_id || !a.channel_type) continue;

            const enabledInt = a.enabled ? 1 : 0;
            const existing = prepare(
                'SELECT id FROM scope_channel_assignments WHERE scope_id = ? AND channel_type = ?'
            ).get(a.scope_id, a.channel_type);

            if (existing) {
                prepare(`
                    UPDATE scope_channel_assignments
                    SET enabled = ?, updated_at = datetime('now')
                    WHERE id = ?
                `).run(enabledInt, existing.id);
                updated++;
            } else {
                prepare(`
                    INSERT INTO scope_channel_assignments (id, org_id, scope_id, channel_type, enabled, created_by)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(ulid(), orgId, a.scope_id, a.channel_type, enabledInt, req.user.id);
                created++;
            }
        }

        createAuditEvent(orgId, req.user.id, 'scope_channel_assignment.bulk_update', {
            count: assignments.length, created, updated
        });

        res.json({ success: true, created, updated });
    } catch (err) {
        console.error('[ScopeChannels] Bulk error:', err.message);
        res.status(500).json({ error: 'Failed to bulk update scope-channel assignments' });
    }
});

// ============================================================================
// Delivery Analytics
// ============================================================================

/**
 * GET /orgs/:orgId/delivery-analytics?days=7
 * Server-side aggregated delivery metrics.
 */
router.get('/orgs/:orgId/delivery-analytics', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
        const dateFilter = `datetime('now', '-${days} days')`;

        // Summary stats
        const summary = prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('sent', 'delivered') THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
            FROM notification_deliveries
            WHERE org_id = ? AND created_at >= ${dateFilter}
        `).get(orgId);

        summary.delivery_rate = summary.total > 0
            ? Math.round((summary.sent / summary.total) * 1000) / 10
            : 0;

        // Most used channel
        const topChannel = prepare(`
            SELECT channel_type, COUNT(*) as cnt
            FROM notification_deliveries
            WHERE org_id = ? AND created_at >= ${dateFilter}
            GROUP BY channel_type
            ORDER BY cnt DESC
            LIMIT 1
        `).get(orgId);

        summary.most_used_channel = topChannel?.channel_type || null;

        // By channel breakdown
        const byChannel = prepare(`
            SELECT
                channel_type,
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('sent', 'delivered') THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
            FROM notification_deliveries
            WHERE org_id = ? AND created_at >= ${dateFilter}
            GROUP BY channel_type
            ORDER BY total DESC
        `).all(orgId);

        // By day breakdown
        const byDayRaw = prepare(`
            SELECT
                date(created_at) as date,
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('sent', 'delivered') THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
            FROM notification_deliveries
            WHERE org_id = ? AND created_at >= ${dateFilter}
            GROUP BY date(created_at)
            ORDER BY date ASC
        `).all(orgId);

        // Fill missing days with zeros
        const byDay = [];
        const now = new Date();
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().slice(0, 10);
            const existing = byDayRaw.find(r => r.date === dateStr);
            byDay.push(existing || { date: dateStr, total: 0, sent: 0, failed: 0 });
        }

        // By scope breakdown (top 10)
        const byScope = prepare(`
            SELECT
                s.id as scope_id,
                s.name_cache as scope_name,
                s.scope_type,
                COUNT(nd.id) as total
            FROM notification_deliveries nd
            JOIN inbox_items ii ON nd.inbox_item_id = ii.id
            JOIN inboxes ib ON ii.inbox_id = ib.id
            JOIN scopes s ON ib.scope_id = s.id
            WHERE nd.org_id = ? AND nd.created_at >= ${dateFilter}
            GROUP BY s.id
            ORDER BY total DESC
            LIMIT 10
        `).all(orgId);

        res.json({ summary, by_channel: byChannel, by_day: byDay, by_scope: byScope });
    } catch (err) {
        console.error('[ScopeChannels] Analytics error:', err.message);
        res.status(500).json({ error: 'Failed to fetch delivery analytics' });
    }
});

export default router;
