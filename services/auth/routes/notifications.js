/**
 * Notification Routes for Quox Auth Service
 * Phase C.1: User notification preferences and integrations
 *
 * Handles notification channel configuration and delivery tracking.
 */

import { Router } from 'express';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, getPagination, formatPaginatedResponse } from '../utils/helpers.js';

const router = Router();

router.use(requireAuth);

// Channel types — expanded for Phase 4 channel driver architecture
const CHANNEL_TYPES = [
  'email', 'slack', 'telegram', 'in_app', 'webhook',
  'discord', 'msteams', 'twilio-sms', 'pagerduty',
  'opsgenie', 'mattermost', 'ntfy', 'pushover',
  'google-chat', 'gotify', 'rocketchat', 'line'
];

// Integration types — expanded for Phase 4
// Note: 'sms' and 'twilio' are aliases for 'twilio-sms' driver
const INTEGRATION_TYPES = [
  'slack', 'telegram', 'email', 'webhook', 'sms',
  'discord', 'msteams', 'twilio-sms', 'pagerduty',
  'opsgenie', 'mattermost', 'ntfy', 'pushover',
  'google-chat', 'gotify', 'rocketchat', 'line'
];

/**
 * GET /users/me/notification-channels[?org_id=X]
 * Get current user's notification channel preferences.
 * Optional org_id filters to channels for a specific org.
 */
router.get('/users/me/notification-channels', async (req, res) => {
    try {
        const userId = req.user.id;
        const orgId = req.query.org_id;

        let sql = `SELECT * FROM notification_channels WHERE user_id = ?`;
        const params = [userId];

        if (orgId) {
            sql += ` AND org_id = ?`;
            params.push(orgId);
        }

        sql += ` ORDER BY channel_type`;
        const channels = prepare(sql).all(...params);

        // Ensure all channel types exist (with defaults)
        const channelMap = {};
        for (const ch of channels) {
            channelMap[ch.channel_type] = {
                ...ch,
                config: ch.config_json ? JSON.parse(ch.config_json) : {},
                preferences: ch.preferences_json ? JSON.parse(ch.preferences_json) : {}
            };
        }

        // Add missing channels with defaults
        for (const type of CHANNEL_TYPES) {
            if (!channelMap[type]) {
                channelMap[type] = {
                    channel_type: type,
                    enabled: type === 'in_app' ? 1 : 0, // in_app enabled by default
                    config: {},
                    preferences: {},
                    org_id: orgId || null,
                    verified_at: null
                };
            }
        }

        res.json({ channels: Object.values(channelMap) });
    } catch (error) {
        console.error('Error getting notification channels:', error);
        res.status(500).json({ error: 'Failed to get notification channels' });
    }
});

/**
 * PUT /users/me/notification-channels/:type
 * Update a notification channel preference.
 * Accepts optional org_id in body for multi-org channel isolation.
 */
router.put('/users/me/notification-channels/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { enabled, config, preferences, org_id } = req.body;
        const userId = req.user.id;

        if (!CHANNEL_TYPES.includes(type)) {
            return res.status(400).json({ error: 'Invalid channel type' });
        }

        // Check if exists (org-scoped lookup)
        let existSql = `SELECT id FROM notification_channels WHERE user_id = ? AND channel_type = ?`;
        const existParams = [userId, type];
        if (org_id) {
            existSql += ` AND org_id = ?`;
            existParams.push(org_id);
        } else {
            existSql += ` AND org_id IS NULL`;
        }
        const existing = prepare(existSql).get(...existParams);

        if (existing) {
            // Update
            const updates = [];
            const params = [];

            if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
            if (config !== undefined) { updates.push('config_json = ?'); params.push(JSON.stringify(config)); }
            if (preferences !== undefined) { updates.push('preferences_json = ?'); params.push(JSON.stringify(preferences)); }

            if (updates.length > 0) {
                prepare(`UPDATE notification_channels SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
                    .run(...params, existing.id);
            }
        } else {
            // Insert with org_id
            prepare(`
                INSERT INTO notification_channels (id, user_id, channel_type, enabled, config_json, preferences_json, org_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                ulid(), userId, type,
                enabled !== false ? 1 : 0,
                JSON.stringify(config || {}),
                JSON.stringify(preferences || {}),
                org_id || null
            );
        }

        res.json({ message: 'Channel preferences updated' });
    } catch (error) {
        console.error('Error updating notification channel:', error);
        res.status(500).json({ error: 'Failed to update channel' });
    }
});

/**
 * GET /orgs/:orgId/notification-integrations
 * List notification integrations for an org (Slack, Telegram, etc.)
 * NOTE: Renamed from /integrations to avoid collision with vault /integrations routes
 */
router.get('/orgs/:orgId/notification-integrations', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { type, status, page, limit } = req.query;
        const pagination = getPagination({ page, limit });

        let conditions = ['i.org_id = ?'];
        let params = [orgId];

        if (type) {
            conditions.push('i.integration_type = ?');
            params.push(type);
        }

        if (status) {
            conditions.push('i.status = ?');
            params.push(status);
        }

        const countResult = prepare(`
            SELECT COUNT(*) as total FROM integrations i
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        const integrations = prepare(`
            SELECT i.*, s.name_cache as scope_name, u.display_name as created_by_name
            FROM integrations i
            LEFT JOIN scopes s ON i.scope_id = s.id
            LEFT JOIN users u ON i.created_by = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY i.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        const sanitized = integrations.map(i => ({
            ...i,
            config: i.config_json ? JSON.parse(i.config_json) : {},
            // Don't expose secret_id details
            has_credentials: !!i.secret_id
        }));

        res.json(formatPaginatedResponse(sanitized, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing integrations:', error);
        res.status(500).json({ error: 'Failed to list integrations' });
    }
});

/**
 * POST /orgs/:orgId/notification-integrations
 * Create a new notification integration (Slack, Telegram, etc.)
 * NOTE: Renamed from /integrations to avoid collision with vault /integrations routes
 */
router.post('/orgs/:orgId/notification-integrations', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { integration_type, name, scope_id, config } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions to manage integrations' });
        }

        if (!INTEGRATION_TYPES.includes(integration_type)) {
            return res.status(400).json({ error: 'Invalid integration type' });
        }

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const integrationId = ulid();

        prepare(`
            INSERT INTO integrations (id, org_id, integration_type, name, scope_id, config_json, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(integrationId, orgId, integration_type, name, scope_id || null, JSON.stringify(config || {}), userId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'integration.created',
            targetType: 'integration',
            targetId: integrationId,
            metadata: { integration_type, name }
        });

        res.status(201).json({
            integration: {
                id: integrationId,
                integration_type,
                name,
                status: 'pending'
            }
        });
    } catch (error) {
        console.error('Error creating integration:', error);
        res.status(500).json({ error: 'Failed to create integration' });
    }
});

/**
 * PATCH /orgs/:orgId/notification-integrations/:integrationId
 * Update an integration
 */
router.patch('/orgs/:orgId/notification-integrations/:integrationId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, integrationId } = req.params;
        const { name, scope_id, config, status } = req.body;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const integration = prepare(`SELECT id FROM integrations WHERE id = ? AND org_id = ?`).get(integrationId, orgId);
        if (!integration) {
            return res.status(404).json({ error: 'Integration not found' });
        }

        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (scope_id !== undefined) { updates.push('scope_id = ?'); params.push(scope_id || null); }
        if (config !== undefined) { updates.push('config_json = ?'); params.push(JSON.stringify(config)); }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        prepare(`UPDATE integrations SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
            .run(...params, integrationId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'integration.updated',
            targetType: 'integration',
            targetId: integrationId
        });

        res.json({ message: 'Integration updated' });
    } catch (error) {
        console.error('Error updating integration:', error);
        res.status(500).json({ error: 'Failed to update integration' });
    }
});

/**
 * DELETE /orgs/:orgId/notification-integrations/:integrationId
 * Delete a notification integration
 */
router.delete('/orgs/:orgId/notification-integrations/:integrationId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, integrationId } = req.params;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const result = prepare(`DELETE FROM integrations WHERE id = ? AND org_id = ?`).run(integrationId, orgId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Integration not found' });
        }

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'integration.deleted',
            targetType: 'integration',
            targetId: integrationId
        });

        res.json({ message: 'Integration deleted' });
    } catch (error) {
        console.error('Error deleting integration:', error);
        res.status(500).json({ error: 'Failed to delete integration' });
    }
});

/**
 * GET /orgs/:orgId/notification-deliveries
 * Get notification delivery history
 */
router.get('/orgs/:orgId/notification-deliveries', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { status, channel_type, inbox_item_id, page, limit } = req.query;
        const pagination = getPagination({ page, limit });

        let conditions = ['nd.org_id = ?'];
        let params = [orgId];

        if (status) {
            conditions.push('nd.status = ?');
            params.push(status);
        }

        if (channel_type) {
            conditions.push('nd.channel_type = ?');
            params.push(channel_type);
        }

        if (inbox_item_id) {
            conditions.push('nd.inbox_item_id = ?');
            params.push(inbox_item_id);
        }

        const countResult = prepare(`
            SELECT COUNT(*) as total FROM notification_deliveries nd
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        const deliveries = prepare(`
            SELECT nd.*, ii.title as inbox_item_title
            FROM notification_deliveries nd
            LEFT JOIN inbox_items ii ON nd.inbox_item_id = ii.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY nd.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        res.json(formatPaginatedResponse(deliveries, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing notification deliveries:', error);
        res.status(500).json({ error: 'Failed to list deliveries' });
    }
});

/**
 * POST /orgs/:orgId/notification-deliveries/:id/retry
 * Retry a failed delivery. Re-dispatches via collector's notification/send endpoint.
 */
router.post('/orgs/:orgId/notification-deliveries/:id/retry', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, id } = req.params;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const delivery = prepare(`
            SELECT nd.*, ii.title as inbox_item_title, ii.kind, ii.priority
            FROM notification_deliveries nd
            LEFT JOIN inbox_items ii ON nd.inbox_item_id = ii.id
            WHERE nd.id = ? AND nd.org_id = ?
        `).get(id, orgId);

        if (!delivery) {
            return res.status(404).json({ error: 'Delivery not found' });
        }

        if (delivery.status === 'sent' || delivery.status === 'delivered') {
            return res.status(400).json({ error: 'Delivery already succeeded' });
        }

        // Reset status to pending and increment attempts
        prepare(`
            UPDATE notification_deliveries
            SET status = 'pending', last_attempt_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(id);

        // Parse content and re-dispatch
        let content = {};
        try { content = JSON.parse(delivery.content_json || '{}'); } catch { /* empty */ }

        const collectorBase = process.env.COLLECTOR_BASE_URL || 'http://localhost:9848';
        try {
            const resp = await fetch(`${collectorBase}/api/notification/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // COLLECTOR-AUTH #52: authenticate server-to-server via INTERNAL_SERVICE_KEY.
                    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                },
                body: JSON.stringify({
                    channel: delivery.channel_type,
                    recipient: delivery.recipient,
                    title: content.title || delivery.inbox_item_title || 'Notification',
                    message: content.message || content.body || '',
                    priority: delivery.priority || 'normal',
                    orgId
                }),
                signal: AbortSignal.timeout(30000)
            });

            if (resp.ok) {
                prepare(`
                    UPDATE notification_deliveries
                    SET status = 'sent', sent_at = datetime('now'), attempts = attempts + 1, updated_at = datetime('now')
                    WHERE id = ?
                `).run(id);
                res.json({ success: true, status: 'sent' });
            } else {
                const errData = await resp.json().catch(() => ({}));
                prepare(`
                    UPDATE notification_deliveries
                    SET status = 'failed', last_error = ?, attempts = attempts + 1, updated_at = datetime('now')
                    WHERE id = ?
                `).run(errData.error || 'Dispatch failed', id);
                res.json({ success: false, status: 'failed', error: errData.error || 'Dispatch failed' });
            }
        } catch (dispatchErr) {
            prepare(`
                UPDATE notification_deliveries
                SET status = 'failed', last_error = ?, attempts = attempts + 1, updated_at = datetime('now')
                WHERE id = ?
            `).run(dispatchErr.message, id);
            res.json({ success: false, status: 'failed', error: dispatchErr.message });
        }
    } catch (error) {
        console.error('Error retrying delivery:', error);
        res.status(500).json({ error: 'Failed to retry delivery' });
    }
});

export default router;
