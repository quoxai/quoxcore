/**
 * Routing Rules Routes for Quox Auth Service
 * Phase C.1: HITL routing configuration
 *
 * Routing rules determine where inbox items are sent based on conditions.
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

/**
 * GET /orgs/:orgId/routing-rules
 * List routing rules for an org
 */
router.get('/orgs/:orgId/routing-rules', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { scope_id, enabled, page, limit } = req.query;
        const pagination = getPagination({ page, limit });

        let conditions = ['rr.org_id = ?'];
        let params = [orgId];

        if (scope_id) {
            conditions.push('rr.scope_id = ?');
            params.push(scope_id);
        }

        if (enabled !== undefined) {
            conditions.push('rr.enabled = ?');
            params.push(enabled === 'true' ? 1 : 0);
        }

        const countResult = prepare(`
            SELECT COUNT(*) as total FROM routing_rules rr
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        const rules = prepare(`
            SELECT rr.*, s.name_cache as scope_name, u.display_name as created_by_name
            FROM routing_rules rr
            LEFT JOIN scopes s ON rr.scope_id = s.id
            LEFT JOIN users u ON rr.created_by = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY rr.priority ASC, rr.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        const enrichedRules = rules.map(rule => ({
            ...rule,
            match: rule.match_json ? JSON.parse(rule.match_json) : {},
            route: rule.route_json ? JSON.parse(rule.route_json) : {}
        }));

        res.json(formatPaginatedResponse(enrichedRules, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing routing rules:', error);
        res.status(500).json({ error: 'Failed to list routing rules' });
    }
});

/**
 * GET /orgs/:orgId/routing-rules/:ruleId
 * Get a single routing rule
 */
router.get('/orgs/:orgId/routing-rules/:ruleId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, ruleId } = req.params;

        const rule = prepare(`
            SELECT rr.*, s.name_cache as scope_name, u.display_name as created_by_name
            FROM routing_rules rr
            LEFT JOIN scopes s ON rr.scope_id = s.id
            LEFT JOIN users u ON rr.created_by = u.id
            WHERE rr.id = ? AND rr.org_id = ?
        `).get(ruleId, orgId);

        if (!rule) {
            return res.status(404).json({ error: 'Routing rule not found' });
        }

        res.json({
            rule: {
                ...rule,
                match: rule.match_json ? JSON.parse(rule.match_json) : {},
                route: rule.route_json ? JSON.parse(rule.route_json) : {}
            }
        });
    } catch (error) {
        console.error('Error getting routing rule:', error);
        res.status(500).json({ error: 'Failed to get routing rule' });
    }
});

/**
 * POST /orgs/:orgId/routing-rules
 * Create a new routing rule
 */
router.post('/orgs/:orgId/routing-rules', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { name, description, scope_id, match, route, priority, enabled } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions to manage routing rules' });
        }

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const ruleId = ulid();

        prepare(`
            INSERT INTO routing_rules (id, org_id, scope_id, name, description, match_json, route_json, priority, enabled, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            ruleId, orgId, scope_id || null,
            name, description || null,
            JSON.stringify(match || {}),
            JSON.stringify(route || {}),
            priority || 100,
            enabled !== false ? 1 : 0,
            userId
        );

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'routing_rule.created',
            targetType: 'routing_rule',
            targetId: ruleId
        });

        res.status(201).json({
            rule: {
                id: ruleId,
                name,
                enabled: enabled !== false
            }
        });
    } catch (error) {
        console.error('Error creating routing rule:', error);
        res.status(500).json({ error: 'Failed to create routing rule' });
    }
});

/**
 * PATCH /orgs/:orgId/routing-rules/:ruleId
 * Update a routing rule
 */
router.patch('/orgs/:orgId/routing-rules/:ruleId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, ruleId } = req.params;
        const { name, description, scope_id, match, route, priority, enabled } = req.body;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const rule = prepare(`SELECT id FROM routing_rules WHERE id = ? AND org_id = ?`).get(ruleId, orgId);
        if (!rule) {
            return res.status(404).json({ error: 'Routing rule not found' });
        }

        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (scope_id !== undefined) { updates.push('scope_id = ?'); params.push(scope_id || null); }
        if (match !== undefined) { updates.push('match_json = ?'); params.push(JSON.stringify(match)); }
        if (route !== undefined) { updates.push('route_json = ?'); params.push(JSON.stringify(route)); }
        if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
        if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        prepare(`UPDATE routing_rules SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
            .run(...params, ruleId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'routing_rule.updated',
            targetType: 'routing_rule',
            targetId: ruleId
        });

        res.json({ message: 'Routing rule updated' });
    } catch (error) {
        console.error('Error updating routing rule:', error);
        res.status(500).json({ error: 'Failed to update routing rule' });
    }
});

/**
 * DELETE /orgs/:orgId/routing-rules/:ruleId
 * Delete a routing rule
 */
router.delete('/orgs/:orgId/routing-rules/:ruleId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, ruleId } = req.params;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const result = prepare(`DELETE FROM routing_rules WHERE id = ? AND org_id = ?`).run(ruleId, orgId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Routing rule not found' });
        }

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'routing_rule.deleted',
            targetType: 'routing_rule',
            targetId: ruleId
        });

        res.json({ message: 'Routing rule deleted' });
    } catch (error) {
        console.error('Error deleting routing rule:', error);
        res.status(500).json({ error: 'Failed to delete routing rule' });
    }
});

export default router;
