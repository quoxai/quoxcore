/**
 * Share Policy Routes for Quox Auth Service
 * Phase B.1: Asset sharing rules
 *
 * Share policies define visibility rules for assets (tools, workflows, assistants).
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// System policy modes
const POLICY_MODES = ['private', 'team', 'department', 'division', 'org', 'explicit'];

/**
 * GET /orgs/:orgId/share-policies
 * List all share policies in an org
 */
router.get('/orgs/:orgId/share-policies', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { include_system } = req.query;

        let query = `
            SELECT sp.*, u.display_name as created_by_name
            FROM share_policies sp
            LEFT JOIN users u ON sp.created_by = u.id
            WHERE sp.org_id = ?
        `;

        if (include_system !== 'true') {
            query += ' AND sp.is_system = 0';
        }

        query += ' ORDER BY sp.is_system DESC, sp.name';

        const policies = prepare(query).all(orgId);

        res.json({ policies });
    } catch (error) {
        console.error('Error listing share policies:', error);
        res.status(500).json({ error: 'Failed to list share policies' });
    }
});

/**
 * GET /orgs/:orgId/share-policies/:policyId
 * Get a single share policy
 */
router.get('/orgs/:orgId/share-policies/:policyId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, policyId } = req.params;

        const policy = prepare(`
            SELECT sp.*, u.display_name as created_by_name
            FROM share_policies sp
            LEFT JOIN users u ON sp.created_by = u.id
            WHERE sp.id = ? AND sp.org_id = ?
        `).get(policyId, orgId);

        if (!policy) {
            return res.status(404).json({ error: 'Share policy not found' });
        }

        // Get usage count
        const toolCount = prepare(`
            SELECT COUNT(*) as count FROM tools WHERE share_policy_id = ?
        `).get(policyId);
        const workflowCount = prepare(`
            SELECT COUNT(*) as count FROM workflows WHERE share_policy_id = ?
        `).get(policyId);
        const assistantCount = prepare(`
            SELECT COUNT(*) as count FROM assistants WHERE share_policy_id = ?
        `).get(policyId);

        res.json({
            policy: {
                ...policy,
                rules: JSON.parse(policy.rules_json || '{}'),
                usage: {
                    tools: toolCount?.count || 0,
                    workflows: workflowCount?.count || 0,
                    assistants: assistantCount?.count || 0
                }
            }
        });
    } catch (error) {
        console.error('Error getting share policy:', error);
        res.status(500).json({ error: 'Failed to get share policy' });
    }
});

/**
 * POST /orgs/:orgId/share-policies
 * Create a custom share policy
 */
router.post('/orgs/:orgId/share-policies',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const { name, description, mode, rules } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.SHARE_POLICIES_MANAGE)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage share policies' });
            }

            // Validate required fields
            if (!name || !mode) {
                return res.status(400).json({ error: 'Name and mode are required' });
            }

            // Validate mode
            if (!POLICY_MODES.includes(mode)) {
                return res.status(400).json({
                    error: `Invalid mode. Must be one of: ${POLICY_MODES.join(', ')}`
                });
            }

            // Check for duplicate name
            const existing = prepare(`
                SELECT id FROM share_policies WHERE org_id = ? AND name = ?
            `).get(orgId, name);

            if (existing) {
                return res.status(409).json({ error: 'A share policy with this name already exists' });
            }

            // Validate explicit mode rules
            if (mode === 'explicit') {
                if (!rules || (!rules.users && !rules.teams && !rules.scopes)) {
                    return res.status(400).json({
                        error: 'Explicit mode requires at least one of: users, teams, or scopes in rules'
                    });
                }
            }

            const id = ulid();

            prepare(`
                INSERT INTO share_policies (id, org_id, name, description, mode, rules_json, is_system, created_by)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            `).run(id, orgId, name, description || null, mode, JSON.stringify(rules || {}), userId);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'share_policy.create',
                targetType: 'share_policy',
                targetId: id,
                metadata: { name, mode }
            });

            const policy = prepare('SELECT * FROM share_policies WHERE id = ?').get(id);

            res.status(201).json({
                policy: {
                    ...policy,
                    rules: JSON.parse(policy.rules_json || '{}')
                }
            });
        } catch (error) {
            console.error('Error creating share policy:', error);
            res.status(500).json({ error: 'Failed to create share policy' });
        }
    }
);

/**
 * PATCH /orgs/:orgId/share-policies/:policyId
 * Update a share policy
 */
router.patch('/orgs/:orgId/share-policies/:policyId',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, policyId } = req.params;
            const { name, description, mode, rules } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.SHARE_POLICIES_MANAGE)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage share policies' });
            }

            // Check policy exists
            const existing = prepare(`
                SELECT * FROM share_policies WHERE id = ? AND org_id = ?
            `).get(policyId, orgId);

            if (!existing) {
                return res.status(404).json({ error: 'Share policy not found' });
            }

            // Can't modify system policies
            if (existing.is_system) {
                return res.status(403).json({ error: 'Cannot modify system share policies' });
            }

            // Check name uniqueness if changing
            if (name && name !== existing.name) {
                const nameExists = prepare(`
                    SELECT id FROM share_policies WHERE org_id = ? AND name = ? AND id != ?
                `).get(orgId, name, policyId);
                if (nameExists) {
                    return res.status(409).json({ error: 'A share policy with this name already exists' });
                }
            }

            // Validate mode if changing
            if (mode && !POLICY_MODES.includes(mode)) {
                return res.status(400).json({
                    error: `Invalid mode. Must be one of: ${POLICY_MODES.join(', ')}`
                });
            }

            // Build update
            const updates = [];
            const values = [];

            if (name !== undefined) { updates.push('name = ?'); values.push(name); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (mode !== undefined) { updates.push('mode = ?'); values.push(mode); }
            if (rules !== undefined) { updates.push('rules_json = ?'); values.push(JSON.stringify(rules)); }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            updates.push("updated_at = datetime('now')");
            values.push(policyId);

            prepare(`UPDATE share_policies SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'share_policy.update',
                targetType: 'share_policy',
                targetId: policyId,
                metadata: { updated_fields: Object.keys(req.body) }
            });

            const policy = prepare('SELECT * FROM share_policies WHERE id = ?').get(policyId);

            res.json({
                policy: {
                    ...policy,
                    rules: JSON.parse(policy.rules_json || '{}')
                }
            });
        } catch (error) {
            console.error('Error updating share policy:', error);
            res.status(500).json({ error: 'Failed to update share policy' });
        }
    }
);

/**
 * DELETE /orgs/:orgId/share-policies/:policyId
 * Delete a share policy
 */
router.delete('/orgs/:orgId/share-policies/:policyId',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, policyId } = req.params;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.SHARE_POLICIES_MANAGE)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage share policies' });
            }

            // Check policy exists
            const existing = prepare(`
                SELECT * FROM share_policies WHERE id = ? AND org_id = ?
            `).get(policyId, orgId);

            if (!existing) {
                return res.status(404).json({ error: 'Share policy not found' });
            }

            // Can't delete system policies
            if (existing.is_system) {
                return res.status(403).json({ error: 'Cannot delete system share policies' });
            }

            // Check if in use
            const inUse = prepare(`
                SELECT
                    (SELECT COUNT(*) FROM tools WHERE share_policy_id = ?) +
                    (SELECT COUNT(*) FROM workflows WHERE share_policy_id = ?) +
                    (SELECT COUNT(*) FROM assistants WHERE share_policy_id = ?) as count
            `).get(policyId, policyId, policyId);

            if (inUse.count > 0) {
                return res.status(409).json({
                    error: 'Cannot delete share policy that is in use',
                    usage_count: inUse.count
                });
            }

            prepare('DELETE FROM share_policies WHERE id = ?').run(policyId);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'share_policy.delete',
                targetType: 'share_policy',
                targetId: policyId,
                metadata: { name: existing.name }
            });

            res.json({ success: true, message: 'Share policy deleted' });
        } catch (error) {
            console.error('Error deleting share policy:', error);
            res.status(500).json({ error: 'Failed to delete share policy' });
        }
    }
);

/**
 * POST /orgs/:orgId/share-policies/init-system
 * Initialize system share policies for an org (admin only)
 */
router.post('/orgs/:orgId/share-policies/init-system',
    requireOrgMembership,
    requireOrgRole('owner'),
    async (req, res) => {
        try {
            const { orgId } = req.params;

            const systemPolicies = [
                { name: 'Private', mode: 'private', description: 'Only visible to creator' },
                { name: 'Team Only', mode: 'team', description: 'Visible to team members' },
                { name: 'Department', mode: 'department', description: 'Visible to department members' },
                { name: 'Division', mode: 'division', description: 'Visible to division members' },
                { name: 'Org-Wide', mode: 'org', description: 'Visible to all org members' }
            ];

            const created = [];

            for (const policy of systemPolicies) {
                // Check if already exists
                const existing = prepare(`
                    SELECT id FROM share_policies WHERE org_id = ? AND name = ?
                `).get(orgId, policy.name);

                if (!existing) {
                    const id = ulid();
                    prepare(`
                        INSERT INTO share_policies (id, org_id, name, description, mode, is_system)
                        VALUES (?, ?, ?, ?, ?, 1)
                    `).run(id, orgId, policy.name, policy.description, policy.mode);
                    created.push(policy.name);
                }
            }

            res.json({
                success: true,
                message: `Created ${created.length} system policies`,
                created
            });
        } catch (error) {
            console.error('Error initializing system policies:', error);
            res.status(500).json({ error: 'Failed to initialize system policies' });
        }
    }
);

export default router;
