/**
 * Assistant Routes for Quox Auth Service
 * Phase B.1: Assistant asset management
 *
 * Assistants are AI personas that can be deployed to different scopes.
 */

import { Router } from 'express';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities, canAccessAsset } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, slugify, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { getScopeById, canAccessScope, getScopeDescendants } from '../utils/scopes.js';
import {
    safeParseJson,
    parseAssistantPersona,
    buildAssistantPersistencePayload,
    serializeAssistantResponse,
    serializeAssistantVersionResponse
} from './assistantLlm.js';

const router = Router();

router.use(requireAuth);

// Assistant statuses
const ASSISTANT_STATUSES = ['draft', 'active', 'deprecated', 'archived'];

// Deployment modes
const DEPLOYMENT_MODES = ['private', 'shared', 'public'];

// Deployment statuses
const DEPLOYMENT_STATUSES = ['pending', 'active', 'paused', 'stopped'];

/**
 * GET /orgs/:orgId/assistants
 * List assistants in an org
 */
router.get('/orgs/:orgId/assistants', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { status, is_template, tag, search, page, limit } = req.query;
        const userId = req.user.id;
        const pagination = getPagination({ page, limit });

        let conditions = ['a.org_id = ?'];
        let params = [orgId];

        if (status) {
            conditions.push('a.status = ?');
            params.push(status);
        }

        if (is_template !== undefined) {
            conditions.push('a.is_template = ?');
            params.push(is_template === 'true' ? 1 : 0);
        }

        if (tag) {
            conditions.push(`EXISTS (
                SELECT 1 FROM asset_tags at
                JOIN tags t ON at.tag_id = t.id
                WHERE at.asset_type = 'assistant' AND at.asset_id = a.id
                AND (t.id = ? OR t.slug = ?)
            )`);
            params.push(tag, tag);
        }

        if (search) {
            conditions.push('(a.name LIKE ? OR a.description LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        // Count total
        const countResult = prepare(`
            SELECT COUNT(*) as total FROM assistants a
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        // Get assistants
        const assistants = prepare(`
            SELECT a.*, u.display_name as created_by_name
            FROM assistants a
            LEFT JOIN users u ON a.created_by = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY a.updated_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        // Enrich with tags and deployment count
        const enrichedAssistants = assistants.map(assistant => {
            // Get tags
            const tags = prepare(`
                SELECT t.id, t.name, t.slug, t.color
                FROM tags t
                JOIN asset_tags at ON t.id = at.tag_id
                WHERE at.asset_type = 'assistant' AND at.asset_id = ?
            `).all(assistant.id);

            // Get active deployment count
            const deployments = prepare(`
                SELECT COUNT(*) as count FROM assistant_deployments
                WHERE assistant_id = ? AND status = 'active'
            `).get(assistant.id);

            // Get scope info if assistant has home_scope_id
            let scopeInfo = null;
            if (assistant.home_scope_id) {
                scopeInfo = prepare(`
                    SELECT id, scope_type, name_cache FROM scopes WHERE id = ?
                `).get(assistant.home_scope_id);
            }

            const source = assistant.home_scope_id ? 'scope'
                : assistant.created_by ? 'user' : 'core';

            return {
                ...serializeAssistantResponse(assistant),
                persona: undefined, // Don't include full persona in list
                tags,
                active_deployments: deployments?.count || 0,
                scope_type: scopeInfo?.scope_type || null,
                scope_name: scopeInfo?.name_cache || null,
                ownership: {
                    source,
                    createdBy: assistant.created_by || null,
                    orgId: assistant.org_id,
                    homeScopeId: assistant.home_scope_id || null,
                }
            };
        });

        res.json(formatPaginatedResponse(enrichedAssistants, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing assistants:', error);
        res.status(500).json({ error: 'Failed to list assistants' });
    }
});

/**
 * GET /orgs/:orgId/assistants/:assistantId
 * Get a single assistant with full details
 */
router.get('/orgs/:orgId/assistants/:assistantId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId } = req.params;

        const assistant = prepare(`
            SELECT a.*, u.display_name as created_by_name
            FROM assistants a
            LEFT JOIN users u ON a.created_by = u.id
            WHERE a.id = ? AND a.org_id = ?
        `).get(assistantId, orgId);

        if (!assistant) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        // Get tags
        const tags = prepare(`
            SELECT t.id, t.name, t.slug, t.color
            FROM tags t
            JOIN asset_tags at ON t.id = at.tag_id
            WHERE at.asset_type = 'assistant' AND at.asset_id = ?
        `).all(assistantId);

        // Get deployments
        const deployments = prepare(`
            SELECT ad.*, s.name_cache as scope_name, s.path as scope_path
            FROM assistant_deployments ad
            LEFT JOIN scopes s ON ad.scope_id = s.id
            WHERE ad.assistant_id = ?
            ORDER BY ad.deployed_at DESC
        `).all(assistantId);

        // Get version history
        const versions = prepare(`
            SELECT id, version, change_summary, created_by, created_at
            FROM assistant_versions
            WHERE assistant_id = ?
            ORDER BY version DESC
            LIMIT 10
        `).all(assistantId);

        res.json({
            assistant: serializeAssistantResponse(assistant, {
                tags,
                deployments,
                versions
            })
        });
    } catch (error) {
        console.error('Error getting assistant:', error);
        res.status(500).json({ error: 'Failed to get assistant' });
    }
});

/**
 * POST /orgs/:orgId/assistants
 * Create a new assistant
 */
router.post('/orgs/:orgId/assistants', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { name, slug, description, persona, llm, is_template, forked_from } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_CREATE_ASSISTANT)) {
            return res.status(403).json({ error: 'Insufficient permissions to create assistants' });
        }

        // Validate required fields
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const assistantSlug = slug || slugify(name);

        // Check for duplicate slug
        const existing = prepare('SELECT id FROM assistants WHERE org_id = ? AND slug = ?').get(orgId, assistantSlug);
        if (existing) {
            return res.status(409).json({ error: 'An assistant with this slug already exists' });
        }

        // Validate forked_from if provided
        if (forked_from) {
            const source = prepare('SELECT * FROM assistants WHERE id = ?').get(forked_from);
            if (!source) {
                return res.status(400).json({ error: 'Source assistant for fork not found' });
            }
            if (!source.is_template && source.org_id !== orgId) {
                return res.status(403).json({ error: 'Can only fork templates or assistants within the same org' });
            }
        }

        const id = ulid();

        const persistence = buildAssistantPersistencePayload({
            persona: {
                system_prompt: '',
                voice: null,
                tools: [],
                knowledge: [],
                // #996: the CLI sends --persona as a plain string; it is the system prompt.
                ...(typeof persona === 'string' ? { system_prompt: persona } : (persona || {}))
            },
            llm
        });

        prepare(`
            INSERT INTO assistants (id, org_id, name, slug, description, persona_json, model_id, model_config_json,
                status, is_template, forked_from, version, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 1, ?)
        `).run(
            id, orgId, name, assistantSlug, description || null,
            persistence.personaJson, persistence.modelId, persistence.modelConfigJson, is_template ? 1 : 0,
            forked_from || null, userId
        );

        // Create initial version
        prepare(`
            INSERT INTO assistant_versions (id, assistant_id, version, persona_json, model_config_json, change_summary, created_by)
            VALUES (?, ?, 1, ?, ?, 'Initial version', ?)
        `).run(ulid(), id, persistence.personaJson, persistence.modelConfigJson, userId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'assistant.create',
            targetType: 'assistant',
            targetId: id,
            metadata: { name, forked_from }
        });

        const assistant = prepare('SELECT * FROM assistants WHERE id = ?').get(id);

        res.status(201).json({
            assistant: serializeAssistantResponse(assistant)
        });
    } catch (error) {
        console.error('Error creating assistant:', error);
        res.status(500).json({ error: 'Failed to create assistant' });
    }
});

/**
 * PATCH /orgs/:orgId/assistants/:assistantId
 * Update an assistant
 */
router.patch('/orgs/:orgId/assistants/:assistantId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId } = req.params;
        const { name, slug, description, persona, llm, status, is_template } = req.body;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM assistants WHERE id = ? AND org_id = ?').get(assistantId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Assistant not found' });
        }
        // #996: a plain-string persona (the CLI's --persona) updates the system prompt only.
        const personaInput = typeof persona === 'string'
            ? { ...parseAssistantPersona(existing), system_prompt: persona }
            : persona;

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can modify this assistant' });
        }

        // Validate status
        if (status && !ASSISTANT_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${ASSISTANT_STATUSES.join(', ')}` });
        }

        // Check slug uniqueness
        if (slug && slug !== existing.slug) {
            const slugExists = prepare('SELECT id FROM assistants WHERE org_id = ? AND slug = ? AND id != ?').get(orgId, slug, assistantId);
            if (slugExists) {
                return res.status(409).json({ error: 'An assistant with this slug already exists' });
            }
        }

        // Build update
        const updates = [];
        const values = [];
        let createVersion = false;

        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (slug !== undefined) { updates.push('slug = ?'); values.push(slug); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (status !== undefined) { updates.push('status = ?'); values.push(status); }
        if (is_template !== undefined) { updates.push('is_template = ?'); values.push(is_template ? 1 : 0); }

        if (persona !== undefined || llm !== undefined) {
            const persistence = buildAssistantPersistencePayload({
                row: existing,
                persona: personaInput || parseAssistantPersona(existing),
                llm
            });
            const existingPersona = JSON.stringify(parseAssistantPersona(existing));
            const newPersona = persistence.personaJson;
            const existingModelId = existing.model_id || null;
            const existingModelConfig = JSON.stringify(safeParseJson(existing.model_config_json, {}));
            const llmChanged = existingModelId !== persistence.modelId || existingModelConfig !== persistence.modelConfigJson;
            if (existingPersona !== newPersona || llmChanged) {
                updates.push('persona_json = ?');
                values.push(newPersona);
                updates.push('model_id = ?');
                values.push(persistence.modelId);
                updates.push('model_config_json = ?');
                values.push(persistence.modelConfigJson);
                updates.push('version = version + 1');
                createVersion = true;
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push("updated_at = datetime('now')");
        values.push(assistantId);

        prepare(`UPDATE assistants SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        // Create version record if persona changed
        if (createVersion) {
            const updated = prepare('SELECT version FROM assistants WHERE id = ?').get(assistantId);
            const persistence = buildAssistantPersistencePayload({
                row: existing,
                persona: personaInput || parseAssistantPersona(existing),
                llm
            });
            prepare(`
                INSERT INTO assistant_versions (id, assistant_id, version, persona_json, model_config_json, change_summary, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(ulid(), assistantId, updated.version, persistence.personaJson, persistence.modelConfigJson, req.body.change_summary || 'Updated persona', userId);
        }

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'assistant.update',
            targetType: 'assistant',
            targetId: assistantId,
            metadata: { updated_fields: Object.keys(req.body) }
        });

        const assistant = prepare('SELECT * FROM assistants WHERE id = ?').get(assistantId);

        res.json({
            assistant: serializeAssistantResponse(assistant)
        });
    } catch (error) {
        console.error('Error updating assistant:', error);
        res.status(500).json({ error: 'Failed to update assistant' });
    }
});

/**
 * DELETE /orgs/:orgId/assistants/:assistantId
 * Delete an assistant
 */
router.delete('/orgs/:orgId/assistants/:assistantId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId } = req.params;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM assistants WHERE id = ? AND org_id = ?').get(assistantId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can delete this assistant' });
        }

        // Check for active deployments
        const activeDeployments = prepare(`
            SELECT COUNT(*) as count FROM assistant_deployments
            WHERE assistant_id = ? AND status = 'active'
        `).get(assistantId);

        if (activeDeployments.count > 0) {
            return res.status(409).json({
                error: 'Cannot delete assistant with active deployments',
                active_deployments: activeDeployments.count
            });
        }

        // Delete related records
        prepare('DELETE FROM assistant_deployments WHERE assistant_id = ?').run(assistantId);
        prepare('DELETE FROM assistant_versions WHERE assistant_id = ?').run(assistantId);
        prepare('DELETE FROM asset_tags WHERE asset_type = ? AND asset_id = ?').run('assistant', assistantId);
        prepare('DELETE FROM user_favorites WHERE asset_type = ? AND asset_id = ?').run('assistant', assistantId);
        prepare('DELETE FROM user_recent WHERE asset_type = ? AND asset_id = ?').run('assistant', assistantId);
        prepare('DELETE FROM directory_index WHERE asset_type = ? AND asset_id = ?').run('assistant', assistantId);

        // Delete assistant
        prepare('DELETE FROM assistants WHERE id = ?').run(assistantId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'assistant.delete',
            targetType: 'assistant',
            targetId: assistantId,
            metadata: { name: existing.name }
        });

        res.json({ success: true, message: 'Assistant deleted' });
    } catch (error) {
        console.error('Error deleting assistant:', error);
        res.status(500).json({ error: 'Failed to delete assistant' });
    }
});

/**
 * POST /orgs/:orgId/assistants/:assistantId/publish
 * Publish a draft assistant (set to active)
 */
router.post('/orgs/:orgId/assistants/:assistantId/publish', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId } = req.params;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM assistants WHERE id = ? AND org_id = ?').get(assistantId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        if (existing.status !== 'draft') {
            return res.status(400).json({ error: 'Only draft assistants can be published' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can publish this assistant' });
        }

        // Validate persona has system prompt
        const persona = JSON.parse(existing.persona_json || '{}');
        if (!persona.system_prompt) {
            return res.status(400).json({ error: 'Assistant must have a system prompt to publish' });
        }

        prepare(`UPDATE assistants SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(assistantId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'assistant.publish',
            targetType: 'assistant',
            targetId: assistantId,
            metadata: { name: existing.name }
        });

        const assistant = prepare('SELECT * FROM assistants WHERE id = ?').get(assistantId);

        res.json({
            assistant: serializeAssistantResponse(assistant)
        });
    } catch (error) {
        console.error('Error publishing assistant:', error);
        res.status(500).json({ error: 'Failed to publish assistant' });
    }
});

/**
 * POST /orgs/:orgId/assistants/:assistantId/deploy
 * Deploy an assistant to a scope
 */
router.post('/orgs/:orgId/assistants/:assistantId/deploy', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId } = req.params;
        const { scope_id, mode } = req.body;
        const userId = req.user.id;

        const assistant = prepare('SELECT * FROM assistants WHERE id = ? AND org_id = ?').get(assistantId, orgId);
        if (!assistant) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        if (assistant.status !== 'active') {
            return res.status(400).json({ error: 'Only active assistants can be deployed' });
        }

        // Validate scope
        if (!scope_id) {
            return res.status(400).json({ error: 'scope_id is required' });
        }

        const scope = getScopeById(scope_id);
        if (!scope || scope.org_id !== orgId) {
            return res.status(400).json({ error: 'Invalid scope' });
        }

        // Check user has access to scope
        if (!canAccessScope(userId, scope_id)) {
            return res.status(403).json({ error: 'Access denied to specified scope' });
        }

        // Validate mode
        const deploymentMode = mode || 'shared';
        if (!DEPLOYMENT_MODES.includes(deploymentMode)) {
            return res.status(400).json({ error: `Invalid mode. Must be one of: ${DEPLOYMENT_MODES.join(', ')}` });
        }

        // Check for existing active deployment at this scope
        const existingDeployment = prepare(`
            SELECT id FROM assistant_deployments
            WHERE assistant_id = ? AND scope_id = ? AND status = 'active'
        `).get(assistantId, scope_id);

        if (existingDeployment) {
            return res.status(409).json({ error: 'Assistant is already deployed at this scope' });
        }

        const id = ulid();

        prepare(`
            INSERT INTO assistant_deployments (id, assistant_id, scope_id, mode, status, deployed_by)
            VALUES (?, ?, ?, ?, 'active', ?)
        `).run(id, assistantId, scope_id, deploymentMode, userId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'assistant.deploy',
            targetType: 'assistant_deployment',
            targetId: id,
            scopeId: scope_id,
            metadata: { assistant_name: assistant.name, scope_name: scope.name_cache, mode: deploymentMode }
        });

        const deployment = prepare(`
            SELECT ad.*, s.name_cache as scope_name, s.path as scope_path
            FROM assistant_deployments ad
            LEFT JOIN scopes s ON ad.scope_id = s.id
            WHERE ad.id = ?
        `).get(id);

        res.status(201).json({ deployment });
    } catch (error) {
        console.error('Error deploying assistant:', error);
        res.status(500).json({ error: 'Failed to deploy assistant' });
    }
});

/**
 * PATCH /orgs/:orgId/assistants/:assistantId/deployments/:deploymentId
 * Update a deployment (change mode or status)
 */
router.patch('/orgs/:orgId/assistants/:assistantId/deployments/:deploymentId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId, deploymentId } = req.params;
        const { mode, status } = req.body;
        const userId = req.user.id;

        const deployment = prepare(`
            SELECT ad.*, a.org_id
            FROM assistant_deployments ad
            JOIN assistants a ON ad.assistant_id = a.id
            WHERE ad.id = ? AND ad.assistant_id = ? AND a.org_id = ?
        `).get(deploymentId, assistantId, orgId);

        if (!deployment) {
            return res.status(404).json({ error: 'Deployment not found' });
        }

        // Check user can manage this deployment (deployed it or is admin)
        const isDeployer = deployment.deployed_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isDeployer && !isAdmin) {
            return res.status(403).json({ error: 'Only the deployer or admin can modify this deployment' });
        }

        // Validate mode
        if (mode && !DEPLOYMENT_MODES.includes(mode)) {
            return res.status(400).json({ error: `Invalid mode. Must be one of: ${DEPLOYMENT_MODES.join(', ')}` });
        }

        // Validate status
        if (status && !DEPLOYMENT_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${DEPLOYMENT_STATUSES.join(', ')}` });
        }

        const updates = [];
        const values = [];

        if (mode !== undefined) { updates.push('mode = ?'); values.push(mode); }
        if (status !== undefined) { updates.push('status = ?'); values.push(status); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push("updated_at = datetime('now')");
        values.push(deploymentId);

        prepare(`UPDATE assistant_deployments SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        const updated = prepare(`
            SELECT ad.*, s.name_cache as scope_name, s.path as scope_path
            FROM assistant_deployments ad
            LEFT JOIN scopes s ON ad.scope_id = s.id
            WHERE ad.id = ?
        `).get(deploymentId);

        res.json({ deployment: updated });
    } catch (error) {
        console.error('Error updating deployment:', error);
        res.status(500).json({ error: 'Failed to update deployment' });
    }
});

/**
 * DELETE /orgs/:orgId/assistants/:assistantId/deployments/:deploymentId
 * Remove a deployment
 */
router.delete('/orgs/:orgId/assistants/:assistantId/deployments/:deploymentId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId, deploymentId } = req.params;
        const userId = req.user.id;

        const deployment = prepare(`
            SELECT ad.*, a.org_id
            FROM assistant_deployments ad
            JOIN assistants a ON ad.assistant_id = a.id
            WHERE ad.id = ? AND ad.assistant_id = ? AND a.org_id = ?
        `).get(deploymentId, assistantId, orgId);

        if (!deployment) {
            return res.status(404).json({ error: 'Deployment not found' });
        }

        // Check user can manage this deployment
        const isDeployer = deployment.deployed_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isDeployer && !isAdmin) {
            return res.status(403).json({ error: 'Only the deployer or admin can remove this deployment' });
        }

        prepare('DELETE FROM assistant_deployments WHERE id = ?').run(deploymentId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'assistant.undeploy',
            targetType: 'assistant_deployment',
            targetId: deploymentId,
            scopeId: deployment.scope_id,
            metadata: { assistant_id: assistantId }
        });

        res.json({ success: true, message: 'Deployment removed' });
    } catch (error) {
        console.error('Error removing deployment:', error);
        res.status(500).json({ error: 'Failed to remove deployment' });
    }
});

/**
 * POST /orgs/:orgId/assistants/:assistantId/fork
 * Fork an assistant (create a copy)
 */
router.post('/orgs/:orgId/assistants/:assistantId/fork', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId } = req.params;
        const { name, slug } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_CREATE_ASSISTANT)) {
            return res.status(403).json({ error: 'Insufficient permissions to create assistants' });
        }

        const source = prepare('SELECT * FROM assistants WHERE id = ?').get(assistantId);
        if (!source) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        // Can fork templates from anywhere, or assistants from same org
        if (!source.is_template && source.org_id !== orgId) {
            return res.status(403).json({ error: 'Can only fork templates or assistants within the same org' });
        }

        const forkName = name || `${source.name} (Fork)`;
        const forkSlug = slug || slugify(forkName);

        // Check slug uniqueness
        const existing = prepare('SELECT id FROM assistants WHERE org_id = ? AND slug = ?').get(orgId, forkSlug);
        if (existing) {
            return res.status(409).json({ error: 'An assistant with this slug already exists' });
        }

        const id = ulid();

        prepare(`
            INSERT INTO assistants (id, org_id, name, slug, description, persona_json, model_id, model_config_json,
                status, is_template, forked_from, version, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, 1, ?)
        `).run(
            id, orgId, forkName, forkSlug, source.description,
            source.persona_json, source.model_id, source.model_config_json, assistantId, userId
        );

        // Create initial version
        prepare(`
            INSERT INTO assistant_versions (id, assistant_id, version, persona_json, model_config_json, change_summary, created_by)
            VALUES (?, ?, 1, ?, ?, ?, ?)
        `).run(ulid(), id, source.persona_json, source.model_config_json || '{}', `Forked from ${source.name}`, userId);

        // Copy tags
        const sourceTags = prepare(`
            SELECT tag_id FROM asset_tags WHERE asset_type = 'assistant' AND asset_id = ?
        `).all(assistantId);

        for (const tag of sourceTags) {
            prepare(`
                INSERT INTO asset_tags (asset_type, asset_id, tag_id) VALUES ('assistant', ?, ?)
            `).run(id, tag.tag_id);
        }

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'assistant.fork',
            targetType: 'assistant',
            targetId: id,
            metadata: { source_id: assistantId, source_name: source.name }
        });

        const assistant = prepare('SELECT * FROM assistants WHERE id = ?').get(id);

        res.status(201).json({
            assistant: serializeAssistantResponse(assistant)
        });
    } catch (error) {
        console.error('Error forking assistant:', error);
        res.status(500).json({ error: 'Failed to fork assistant' });
    }
});

/**
 * POST /orgs/:orgId/assistants/:assistantId/tags
 * Add a tag to an assistant
 */
router.post('/orgs/:orgId/assistants/:assistantId/tags', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId } = req.params;
        const { tag_id } = req.body;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM assistants WHERE id = ? AND org_id = ?').get(assistantId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can tag this assistant' });
        }

        // Validate tag
        const tag = prepare('SELECT * FROM tags WHERE id = ? AND org_id = ?').get(tag_id, orgId);
        if (!tag) {
            return res.status(404).json({ error: 'Tag not found' });
        }

        // Check if already tagged
        const existingTag = prepare(`
            SELECT * FROM asset_tags WHERE asset_type = 'assistant' AND asset_id = ? AND tag_id = ?
        `).get(assistantId, tag_id);

        if (existingTag) {
            return res.status(409).json({ error: 'Assistant already has this tag' });
        }

        prepare(`
            INSERT INTO asset_tags (asset_type, asset_id, tag_id) VALUES ('assistant', ?, ?)
        `).run(assistantId, tag_id);

        res.status(201).json({ success: true, tag });
    } catch (error) {
        console.error('Error adding tag to assistant:', error);
        res.status(500).json({ error: 'Failed to add tag' });
    }
});

/**
 * DELETE /orgs/:orgId/assistants/:assistantId/tags/:tagId
 * Remove a tag from an assistant
 */
router.delete('/orgs/:orgId/assistants/:assistantId/tags/:tagId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId, tagId } = req.params;
        const userId = req.user.id;

        const existing = prepare('SELECT * FROM assistants WHERE id = ? AND org_id = ?').get(assistantId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        // Check ownership or admin
        const isOwner = existing.created_by === userId;
        const isAdmin = ['admin', 'owner'].includes(req.orgMembership.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the creator or admin can untag this assistant' });
        }

        prepare(`
            DELETE FROM asset_tags WHERE asset_type = 'assistant' AND asset_id = ? AND tag_id = ?
        `).run(assistantId, tagId);

        res.json({ success: true, message: 'Tag removed' });
    } catch (error) {
        console.error('Error removing tag from assistant:', error);
        res.status(500).json({ error: 'Failed to remove tag' });
    }
});

/**
 * GET /orgs/:orgId/assistants/:assistantId/versions/:version
 * Get a specific version of an assistant
 */
router.get('/orgs/:orgId/assistants/:assistantId/versions/:version', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, assistantId, version } = req.params;

        const assistant = prepare('SELECT * FROM assistants WHERE id = ? AND org_id = ?').get(assistantId, orgId);
        if (!assistant) {
            return res.status(404).json({ error: 'Assistant not found' });
        }

        const versionRecord = prepare(`
            SELECT av.*, u.display_name as created_by_name
            FROM assistant_versions av
            LEFT JOIN users u ON av.created_by = u.id
            WHERE av.assistant_id = ? AND av.version = ?
        `).get(assistantId, parseInt(version));

        if (!versionRecord) {
            return res.status(404).json({ error: 'Version not found' });
        }

        res.json({
            version: serializeAssistantVersionResponse({
                ...versionRecord,
                model_id: versionRecord.model_id || assistant.model_id,
                model_config_json: versionRecord.model_config_json || assistant.model_config_json
            })
        });
    } catch (error) {
        console.error('Error getting assistant version:', error);
        res.status(500).json({ error: 'Failed to get assistant version' });
    }
});

/**
 * GET /orgs/:orgId/available-assistants
 * Get assistants available in a scope (deployed there or to parent scopes)
 */
router.get('/orgs/:orgId/available-assistants', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { scope_id } = req.query;

        if (!scope_id) {
            return res.status(400).json({ error: 'scope_id is required' });
        }

        const scope = getScopeById(scope_id);
        if (!scope || scope.org_id !== orgId) {
            return res.status(404).json({ error: 'Scope not found' });
        }

        // Get all scope IDs in the path (current + ancestors)
        const pathParts = scope.path.split('/').filter(Boolean);
        const scopeIds = [];

        // Build ancestor paths
        for (let i = 1; i <= pathParts.length; i += 2) {
            const ancestorPath = '/' + pathParts.slice(0, i + 1).join('/');
            const ancestorScope = prepare('SELECT id FROM scopes WHERE path = ?').get(ancestorPath);
            if (ancestorScope) {
                scopeIds.push(ancestorScope.id);
            }
        }

        // Get assistants deployed to any of these scopes
        const placeholders = scopeIds.map(() => '?').join(',');
        const assistants = prepare(`
            SELECT DISTINCT a.*, ad.mode as deployment_mode, ad.scope_id as deployed_scope_id,
                   s.name_cache as deployed_scope_name
            FROM assistants a
            JOIN assistant_deployments ad ON a.id = ad.assistant_id
            JOIN scopes s ON ad.scope_id = s.id
            WHERE ad.scope_id IN (${placeholders})
            AND ad.status = 'active'
            AND a.status = 'active'
            ORDER BY a.name
        `).all(...scopeIds);

        res.json({
            assistants: assistants.map(a => ({
                ...a,
                persona: undefined // Don't include full persona in list
            }))
        });
    } catch (error) {
        console.error('Error getting available assistants:', error);
        res.status(500).json({ error: 'Failed to get available assistants' });
    }
});

export default router;
