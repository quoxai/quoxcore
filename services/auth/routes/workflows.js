/**
 * Workflow Routes for Quox Auth Service
 * Phase B.1: Workflow asset management
 *
 * Workflows are multi-step automations that combine tools and actions.
 */

import { Router } from 'express';
import { prepare, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities, canAccessAsset } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, slugify, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { getScopeById, canAccessScope, getScopeDescendants } from '../utils/scopes.js';

const router = Router();

router.use(requireAuth);

// Workflow statuses
const WORKFLOW_STATUSES = ['draft', 'active', 'deprecated', 'archived'];

// Step types
const STEP_TYPES = ['tool', 'condition', 'loop', 'parallel', 'wait', 'notify', 'transform'];

/**
 * GET /orgs/:orgId/workflows
 * List workflows in an org
 */
router.get('/orgs/:orgId/workflows', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { status, scope_id, tag, search, page, limit } = req.query;
        const userId = req.user.id;
        const pagination = getPagination({ page, limit });

        let conditions = ['w.org_id = ?'];
        let params = [orgId];

        if (status) {
            conditions.push('w.status = ?');
            params.push(status);
        }

        if (scope_id) {
            // Include workflows from this scope AND all descendant scopes
            const descendants = getScopeDescendants(scope_id);
            const allScopeIds = [scope_id, ...descendants.map(d => d.id)];
            conditions.push(`w.home_scope_id IN (${allScopeIds.map(() => '?').join(',')})`);
            params.push(...allScopeIds);
        }

        if (tag) {
            conditions.push(`EXISTS (
                SELECT 1 FROM asset_tags at
                JOIN tags t ON at.tag_id = t.id
                WHERE at.asset_type = 'workflow' AND at.asset_id = w.id
                AND (t.id = ? OR t.slug = ?)
            )`);
            params.push(tag, tag);
        }

        if (search) {
            conditions.push('(w.name LIKE ? OR w.description LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        // Count total
        const countResult = prepare(`
            SELECT COUNT(*) as total FROM workflows w
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        // Get workflows
        const workflows = prepare(`
            SELECT w.*, u.display_name as created_by_name,
                   sp.name as share_policy_name, sp.mode as share_policy_mode,
                   s.name_cache as scope_name, s.scope_type as scope_type,
                   s.path as scope_path, s.parent_scope_id as scope_parent_id
            FROM workflows w
            LEFT JOIN users u ON w.created_by = u.id
            LEFT JOIN share_policies sp ON w.share_policy_id = sp.id
            LEFT JOIN scopes s ON w.home_scope_id = s.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY w.updated_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        // Filter by access and enrich with tags
        const accessibleWorkflows = [];
        for (const workflow of workflows) {
            const canAccess = canAccessAsset(
                { id: userId, orgRole: req.orgMembership.role },
                {
                    created_by: workflow.created_by,
                    home_scope_id: workflow.home_scope_id,
                    share_policy_mode: workflow.share_policy_mode
                },
                workflow.share_policy_mode ? { mode: workflow.share_policy_mode } : null
            );

            if (canAccess.allowed) {
                // Get tags
                const tags = prepare(`
                    SELECT t.id, t.name, t.slug, t.color
                    FROM tags t
                    JOIN asset_tags at ON t.id = at.tag_id
                    WHERE at.asset_type = 'workflow' AND at.asset_id = ?
                `).all(workflow.id);

                // Get step count
                const stepCount = prepare(`
                    SELECT COUNT(*) as count FROM workflow_steps WHERE workflow_id = ?
                `).get(workflow.id);

                accessibleWorkflows.push({
                    ...workflow,
                    definition: undefined, // Don't include full definition in list
                    tags,
                    step_count: stepCount?.count || 0
                });
            }
        }

        res.json(formatPaginatedResponse(accessibleWorkflows, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing workflows:', error);
        res.status(500).json({ error: 'Failed to list workflows' });
    }
});

/**
 * GET /orgs/:orgId/workflows/:workflowId
 * Get a single workflow with full details
 */
router.get('/orgs/:orgId/workflows/:workflowId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId } = req.params;
        const userId = req.user.id;

        const workflow = prepare(`
            SELECT w.*, u.display_name as created_by_name,
                   sp.name as share_policy_name, sp.mode as share_policy_mode,
                   s.name_cache as scope_name, s.scope_type as scope_type,
                   s.path as scope_path, s.parent_scope_id as scope_parent_id
            FROM workflows w
            LEFT JOIN users u ON w.created_by = u.id
            LEFT JOIN share_policies sp ON w.share_policy_id = sp.id
            LEFT JOIN scopes s ON w.home_scope_id = s.id
            WHERE w.id = ? AND w.org_id = ?
        `).get(workflowId, orgId);

        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check access
        const canAccess = canAccessAsset(
            { id: userId, orgRole: req.orgMembership.role },
            {
                created_by: workflow.created_by,
                home_scope_id: workflow.home_scope_id,
                share_policy_mode: workflow.share_policy_mode
            },
            workflow.share_policy_mode ? { mode: workflow.share_policy_mode } : null
        );

        if (!canAccess.allowed) {
            return res.status(403).json({ error: 'Access denied to this workflow', reason: canAccess.reason });
        }

        // Get tags
        const tags = prepare(`
            SELECT t.id, t.name, t.slug, t.color
            FROM tags t
            JOIN asset_tags at ON t.id = at.tag_id
            WHERE at.asset_type = 'workflow' AND at.asset_id = ?
        `).all(workflowId);

        // Get steps
        const steps = prepare(`
            SELECT ws.*, t.name as tool_name
            FROM workflow_steps ws
            LEFT JOIN tools t ON ws.ref_id = t.id AND ws.step_type = 'tool'
            WHERE ws.workflow_id = ?
            ORDER BY ws.idx
        `).all(workflowId);

        // Get version history
        const versions = prepare(`
            SELECT id, version, change_summary, created_by, created_at
            FROM workflow_versions
            WHERE workflow_id = ?
            ORDER BY version DESC
            LIMIT 10
        `).all(workflowId);

        res.json({
            workflow: {
                ...workflow,
                definition: JSON.parse(workflow.definition_json || '{}'),
                tags,
                steps: steps.map(s => ({
                    ...s,
                    config: JSON.parse(s.config_json || '{}')
                })),
                versions
            }
        });
    } catch (error) {
        console.error('Error getting workflow:', error);
        res.status(500).json({ error: 'Failed to get workflow' });
    }
});

/**
 * POST /orgs/:orgId/workflows
 * Create a new workflow
 */
router.post('/orgs/:orgId/workflows', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { name, slug, description, notes, definition, home_scope_id, share_policy_id, steps } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_CREATE_WORKFLOW)) {
            return res.status(403).json({ error: 'Insufficient permissions to create workflows' });
        }

        // Validate required fields
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        // Validate scope access if provided
        if (home_scope_id) {
            const scope = getScopeById(home_scope_id);
            if (!scope || scope.org_id !== orgId) {
                return res.status(400).json({ error: 'Invalid home scope' });
            }
            if (!canAccessScope(userId, home_scope_id)) {
                return res.status(403).json({ error: 'Access denied to specified scope' });
            }
        }

        // Validate share policy
        if (share_policy_id) {
            const policy = prepare('SELECT id FROM share_policies WHERE id = ? AND org_id = ?').get(share_policy_id, orgId);
            if (!policy) {
                return res.status(400).json({ error: 'Invalid share policy' });
            }
        }

        const workflowSlug = slug || slugify(name);

        // Check for duplicate slug
        const existing = prepare('SELECT id FROM workflows WHERE org_id = ? AND slug = ?').get(orgId, workflowSlug);
        if (existing) {
            return res.status(409).json({ error: 'A workflow with this slug already exists' });
        }

        // Get default share policy if not provided
        let policyId = share_policy_id;
        if (!policyId) {
            const defaultPolicy = prepare(`
                SELECT id FROM share_policies WHERE org_id = ? AND name = 'Private'
            `).get(orgId);
            policyId = defaultPolicy?.id;
        }

        const id = ulid();

        prepare(`
            INSERT INTO workflows (id, org_id, name, slug, description, notes, definition_json,
                home_scope_id, share_policy_id, status, version, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?)
        `).run(
            id, orgId, name, workflowSlug, description || null, notes || null,
            JSON.stringify(definition || {}), home_scope_id || null,
            policyId, userId
        );

        // Create initial version
        prepare(`
            INSERT INTO workflow_versions (id, workflow_id, version, definition_json, change_summary, created_by)
            VALUES (?, ?, 1, ?, 'Initial version', ?)
        `).run(ulid(), id, JSON.stringify(definition || {}), userId);

        // Add steps if provided
        if (steps && Array.isArray(steps)) {
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                if (!STEP_TYPES.includes(step.step_type)) {
                    continue; // Skip invalid step types
                }
                prepare(`
                    INSERT INTO workflow_steps (id, workflow_id, idx, step_type, ref_id, config_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(ulid(), id, i, step.step_type, step.ref_id || null, JSON.stringify(step.config || {}));
            }
        }

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'workflow.create',
            targetType: 'workflow',
            targetId: id,
            metadata: { name }
        });

        const workflow = prepare('SELECT * FROM workflows WHERE id = ?').get(id);

        res.status(201).json({
            workflow: {
                ...workflow,
                definition: JSON.parse(workflow.definition_json || '{}')
            }
        });
    } catch (error) {
        console.error('Error creating workflow:', error);
        res.status(500).json({ error: 'Failed to create workflow' });
    }
});

/**
 * PATCH /orgs/:orgId/workflows/:workflowId
 * Update a workflow
 */
router.patch('/orgs/:orgId/workflows/:workflowId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId } = req.params;
        const { name, slug, description, notes, definition, home_scope_id, share_policy_id, status } = req.body;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can modify this workflow' });
        }

        // Validate status
        if (status && !WORKFLOW_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${WORKFLOW_STATUSES.join(', ')}` });
        }

        // Check slug uniqueness
        if (slug && slug !== existing.slug) {
            const slugExists = prepare('SELECT id FROM workflows WHERE org_id = ? AND slug = ? AND id != ?').get(orgId, slug, workflowId);
            if (slugExists) {
                return res.status(409).json({ error: 'A workflow with this slug already exists' });
            }
        }

        // Validate scope
        if (home_scope_id && home_scope_id !== existing.home_scope_id) {
            const scope = getScopeById(home_scope_id);
            if (!scope || scope.org_id !== orgId) {
                return res.status(400).json({ error: 'Invalid home scope' });
            }
        }

        // Build update
        const updates = [];
        const values = [];
        let createVersion = false;

        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (slug !== undefined) { updates.push('slug = ?'); values.push(slug); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (notes !== undefined) { updates.push('notes = ?'); values.push(notes); }
        if (home_scope_id !== undefined) { updates.push('home_scope_id = ?'); values.push(home_scope_id); }
        if (share_policy_id !== undefined) { updates.push('share_policy_id = ?'); values.push(share_policy_id); }
        if (status !== undefined) { updates.push('status = ?'); values.push(status); }

        if (definition !== undefined) {
            const existingDef = JSON.stringify(JSON.parse(existing.definition_json || '{}'));
            const newDef = JSON.stringify(definition);
            if (existingDef !== newDef) {
                updates.push('definition_json = ?');
                values.push(newDef);
                updates.push('version = version + 1');
                createVersion = true;
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push("updated_at = datetime('now')");
        values.push(workflowId);

        prepare(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        // Create version record if definition changed
        if (createVersion) {
            const updated = prepare('SELECT version FROM workflows WHERE id = ?').get(workflowId);
            prepare(`
                INSERT INTO workflow_versions (id, workflow_id, version, definition_json, change_summary, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ulid(), workflowId, updated.version, JSON.stringify(definition), req.body.change_summary || 'Updated definition', userId);
        }

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'workflow.update',
            targetType: 'workflow',
            targetId: workflowId,
            metadata: { updated_fields: Object.keys(req.body) }
        });

        const workflow = prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);

        res.json({
            workflow: {
                ...workflow,
                definition: JSON.parse(workflow.definition_json || '{}')
            }
        });
    } catch (error) {
        console.error('Error updating workflow:', error);
        res.status(500).json({ error: 'Failed to update workflow' });
    }
});

/**
 * DELETE /orgs/:orgId/workflows/:workflowId
 * Delete a workflow
 */
router.delete('/orgs/:orgId/workflows/:workflowId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId } = req.params;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can delete this workflow' });
        }

        // Delete related records
        prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(workflowId);
        prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(workflowId);
        prepare('DELETE FROM asset_tags WHERE asset_type = ? AND asset_id = ?').run('workflow', workflowId);
        prepare('DELETE FROM user_favorites WHERE asset_type = ? AND asset_id = ?').run('workflow', workflowId);
        prepare('DELETE FROM user_recent WHERE asset_type = ? AND asset_id = ?').run('workflow', workflowId);
        prepare('DELETE FROM directory_index WHERE asset_type = ? AND asset_id = ?').run('workflow', workflowId);

        // Delete workflow
        prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'workflow.delete',
            targetType: 'workflow',
            targetId: workflowId,
            metadata: { name: existing.name }
        });

        res.json({ success: true, message: 'Workflow deleted' });
    } catch (error) {
        console.error('Error deleting workflow:', error);
        res.status(500).json({ error: 'Failed to delete workflow' });
    }
});

/**
 * POST /orgs/:orgId/workflows/:workflowId/publish
 * Publish a draft workflow (set to active)
 */
router.post('/orgs/:orgId/workflows/:workflowId/publish', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId } = req.params;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        if (existing.status !== 'draft') {
            return res.status(400).json({ error: 'Only draft workflows can be published' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can publish this workflow' });
        }

        // Validate workflow has steps
        const stepCount = prepare('SELECT COUNT(*) as count FROM workflow_steps WHERE workflow_id = ?').get(workflowId);
        if (stepCount.count === 0) {
            return res.status(400).json({ error: 'Workflow must have at least one step to publish' });
        }

        prepare(`UPDATE workflows SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(workflowId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'workflow.publish',
            targetType: 'workflow',
            targetId: workflowId,
            metadata: { name: existing.name }
        });

        const workflow = prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);

        res.json({
            workflow: {
                ...workflow,
                definition: JSON.parse(workflow.definition_json || '{}')
            }
        });
    } catch (error) {
        console.error('Error publishing workflow:', error);
        res.status(500).json({ error: 'Failed to publish workflow' });
    }
});

/**
 * PUT /orgs/:orgId/workflows/:workflowId/steps
 * Replace all workflow steps
 */
router.put('/orgs/:orgId/workflows/:workflowId/steps', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId } = req.params;
        const { steps } = req.body;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can modify workflow steps' });
        }

        if (!Array.isArray(steps)) {
            return res.status(400).json({ error: 'Steps must be an array' });
        }

        // fleet #375: accept `type` as an alias for `step_type`, matching the
        // convention POST /api/memory and the entity routes already use —
        // the DB column name was leaking out as the user-facing contract.
        const normalised = steps.map(s => ({
            ...s,
            step_type: s.step_type ?? s.type,
        }));

        // Validate EVERY step before mutating anything. This loop used to run
        // AFTER the DELETE below, and returned mid-iteration on the first bad
        // step — so a rejected request destroyed the workflow's existing steps
        // and left either nothing or a partial prefix behind. In #375's own
        // repro (every step invalid because of the field name) that silently
        // wiped all existing steps and returned 400.
        for (let i = 0; i < normalised.length; i++) {
            if (!STEP_TYPES.includes(normalised[i].step_type)) {
                return res.status(400).json({
                    error: `Invalid step type at index ${i}: ${normalised[i].step_type}`,
                    valid_step_types: STEP_TYPES,
                    hint: 'Each step needs a step_type (alias: type), one of the values above.',
                });
            }
        }

        // Replace atomically: a failure partway through must not leave the
        // workflow with a half-written step list.
        transaction(() => {
            prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(workflowId);
            for (let i = 0; i < normalised.length; i++) {
                const step = normalised[i];
                prepare(`
                    INSERT INTO workflow_steps (id, workflow_id, idx, step_type, ref_id, label, config_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(ulid(), workflowId, i, step.step_type, step.ref_id || null, step.label ?? null, JSON.stringify(step.config || {}));
            }
        });

        // Update workflow timestamp
        prepare(`UPDATE workflows SET updated_at = datetime('now') WHERE id = ?`).run(workflowId);

        // Get updated steps
        const updatedSteps = prepare(`
            SELECT ws.*, t.name as tool_name
            FROM workflow_steps ws
            LEFT JOIN tools t ON ws.ref_id = t.id AND ws.step_type = 'tool'
            WHERE ws.workflow_id = ?
            ORDER BY ws.idx
        `).all(workflowId);

        res.json({
            steps: updatedSteps.map(s => ({
                ...s,
                config: JSON.parse(s.config_json || '{}')
            }))
        });
    } catch (error) {
        console.error('Error updating workflow steps:', error);
        res.status(500).json({ error: 'Failed to update workflow steps' });
    }
});

/**
 * POST /orgs/:orgId/workflows/:workflowId/tags
 * Add a tag to a workflow
 */
router.post('/orgs/:orgId/workflows/:workflowId/tags', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId } = req.params;
        const { tag_id } = req.body;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can tag this workflow' });
        }

        // Validate tag
        const tag = prepare('SELECT * FROM tags WHERE id = ? AND org_id = ?').get(tag_id, orgId);
        if (!tag) {
            return res.status(404).json({ error: 'Tag not found' });
        }

        // Check if already tagged
        const existingTag = prepare(`
            SELECT * FROM asset_tags WHERE asset_type = 'workflow' AND asset_id = ? AND tag_id = ?
        `).get(workflowId, tag_id);

        if (existingTag) {
            return res.status(409).json({ error: 'Workflow already has this tag' });
        }

        prepare(`
            INSERT INTO asset_tags (asset_type, asset_id, tag_id) VALUES ('workflow', ?, ?)
        `).run(workflowId, tag_id);

        res.status(201).json({ success: true, tag });
    } catch (error) {
        console.error('Error adding tag to workflow:', error);
        res.status(500).json({ error: 'Failed to add tag' });
    }
});

/**
 * DELETE /orgs/:orgId/workflows/:workflowId/tags/:tagId
 * Remove a tag from a workflow
 */
router.delete('/orgs/:orgId/workflows/:workflowId/tags/:tagId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId, tagId } = req.params;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can untag this workflow' });
        }

        prepare(`
            DELETE FROM asset_tags WHERE asset_type = 'workflow' AND asset_id = ? AND tag_id = ?
        `).run(workflowId, tagId);

        res.json({ success: true, message: 'Tag removed' });
    } catch (error) {
        console.error('Error removing tag from workflow:', error);
        res.status(500).json({ error: 'Failed to remove tag' });
    }
});

/**
 * GET /orgs/:orgId/workflows/:workflowId/versions
 * List version history for a workflow (latest 50, newest-first).
 * Returns {version, change_summary, created_by, created_by_name, created_at} per row.
 * Pass ?include=definition to also receive definition_json (payload-heavy, off by default).
 */
router.get('/orgs/:orgId/workflows/:workflowId/versions', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId } = req.params;
        const includeDefinition = req.query.include === 'definition';

        const workflow = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        const policy = prepare('SELECT mode FROM share_policies WHERE id = ?').get(workflow.share_policy_id);
        const canAccess = canAccessAsset(
            { id: req.user.id, orgRole: req.orgMembership.role },
            {
                created_by: workflow.created_by,
                home_scope_id: workflow.home_scope_id,
                share_policy_mode: policy?.mode
            },
            policy?.mode ? { mode: policy.mode } : null
        );
        if (!canAccess.allowed) {
            return res.status(403).json({ error: 'Access denied', reason: canAccess.reason });
        }

        const selectCols = includeDefinition
            ? 'wv.id, wv.version, wv.definition_json, wv.change_summary, wv.created_by, u.display_name as created_by_name, wv.created_at'
            : 'wv.id, wv.version, wv.change_summary, wv.created_by, u.display_name as created_by_name, wv.created_at';

        const versions = prepare(`
            SELECT ${selectCols}
            FROM workflow_versions wv
            LEFT JOIN users u ON wv.created_by = u.id
            WHERE wv.workflow_id = ?
            ORDER BY version DESC
            LIMIT 50
        `).all(workflowId);

        res.json({ versions });
    } catch (error) {
        console.error('Error listing workflow versions:', error);
        res.status(500).json({ error: 'Failed to list workflow versions' });
    }
});

/**
 * GET /orgs/:orgId/workflows/:workflowId/versions/:version
 * Get a specific version of a workflow
 */
router.get('/orgs/:orgId/workflows/:workflowId/versions/:version', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId, version } = req.params;
        const userId = req.user.id;

        const workflow = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check access
        const policy = prepare('SELECT mode FROM share_policies WHERE id = ?').get(workflow.share_policy_id);
        const canAccess = canAccessAsset(
            { id: userId, orgRole: req.orgMembership.role },
            {
                created_by: workflow.created_by,
                home_scope_id: workflow.home_scope_id,
                share_policy_mode: policy?.mode
            },
            policy?.mode ? { mode: policy.mode } : null
        );

        if (!canAccess.allowed) {
            return res.status(403).json({ error: 'Access denied', reason: canAccess.reason });
        }

        const versionRecord = prepare(`
            SELECT wv.*, u.display_name as created_by_name
            FROM workflow_versions wv
            LEFT JOIN users u ON wv.created_by = u.id
            WHERE wv.workflow_id = ? AND wv.version = ?
        `).get(workflowId, parseInt(version));

        if (!versionRecord) {
            return res.status(404).json({ error: 'Version not found' });
        }

        res.json({
            version: {
                ...versionRecord,
                definition: JSON.parse(versionRecord.definition_json || '{}')
            }
        });
    } catch (error) {
        console.error('Error getting workflow version:', error);
        res.status(500).json({ error: 'Failed to get workflow version' });
    }
});

/**
 * POST /orgs/:orgId/workflows/:workflowId/versions/:version/restore
 * Restore a prior workflow version.
 *
 * Creates a new highest-version row in workflow_versions whose definition_json
 * equals the restored version's definition_json, sets change_summary to
 * "Restored from v{N}", records the requesting user as created_by, and updates
 * workflows.definition_json to match — all in a single transaction.
 */
router.post('/orgs/:orgId/workflows/:workflowId/versions/:version/restore', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, workflowId, version } = req.params;
        const userId = req.user.id;

        const workflow = prepare('SELECT * FROM workflows WHERE id = ? AND org_id = ?').get(workflowId, orgId);
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        const policy = prepare('SELECT mode FROM share_policies WHERE id = ?').get(workflow.share_policy_id);
        const canAccess = canAccessAsset(
            { id: userId, orgRole: req.orgMembership.role },
            {
                created_by: workflow.created_by,
                home_scope_id: workflow.home_scope_id,
                share_policy_mode: policy?.mode
            },
            policy?.mode ? { mode: policy.mode } : null
        );
        if (!canAccess.allowed) {
            return res.status(403).json({ error: 'Access denied', reason: canAccess.reason });
        }

        // Restore is a MUTATION (writes a new version + updates the live
        // workflow), not a read. canAccessAsset above only proves VIEW
        // access (creator / admin / share policy); it does not prove the
        // caller may change the asset. Match the same creator-or-admin gate
        // every other mutating workflow route uses (PATCH/DELETE/publish/
        // steps/tags above).
        const isOwner = workflow.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can restore this workflow' });
        }

        const targetVersion = prepare(`
            SELECT * FROM workflow_versions
            WHERE workflow_id = ? AND version = ?
        `).get(workflowId, parseInt(version));

        if (!targetVersion) {
            return res.status(404).json({ error: `Version ${version} not found for this workflow` });
        }

        // Wrap insert + update in a transaction so partial writes can't happen.
        const newVersionRow = transaction(() => {
            // Compute the next version number (current highest + 1).
            const maxRow = prepare(`
                SELECT MAX(version) as max_v FROM workflow_versions WHERE workflow_id = ?
            `).get(workflowId);
            const nextVersion = (maxRow?.max_v ?? workflow.version) + 1;

            // Insert a new version row with the restored definition.
            const newId = ulid();
            prepare(`
                INSERT INTO workflow_versions (id, workflow_id, version, definition_json, change_summary, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(newId, workflowId, nextVersion, targetVersion.definition_json, `Restored from v${version}`, userId);

            // Update the live workflow definition + bump the version counter.
            prepare(`
                UPDATE workflows
                SET definition_json = ?, version = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(targetVersion.definition_json, nextVersion, workflowId);

            return { newId, nextVersion };
        });

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'workflow.version_restore',
            targetType: 'workflow',
            targetId: workflowId,
            metadata: { restored_from_version: parseInt(version), new_version: newVersionRow.nextVersion }
        });

        res.json({
            restored: true,
            restored_from_version: parseInt(version),
            new_version: newVersionRow.nextVersion
        });
    } catch (error) {
        console.error('Error restoring workflow version:', error);
        res.status(500).json({ error: 'Failed to restore workflow version' });
    }
});

export default router;
