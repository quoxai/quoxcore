/**
 * Tools Routes for Quox Auth Service
 * Phase B.1: Asset registry - Tools
 *
 * Tools are reusable capabilities that agents can invoke.
 * Types: mcp, function, api, script, workflow
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { getScopeById, getScopeForEntity, canAccessScope } from '../utils/scopes.js';
import { Capabilities, canAccessAsset } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, slugify, getPagination, formatPaginatedResponse } from '../utils/helpers.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Valid tool types
const TOOL_TYPES = ['mcp', 'function', 'api', 'script', 'workflow'];
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const TOOL_STATUSES = ['draft', 'active', 'deprecated', 'archived'];

/**
 * GET /orgs/:orgId/tools
 * List tools in an org with filtering
 */
router.get('/orgs/:orgId/tools', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { type, status, scope_id, tag, search, include_spec } = req.query;
        const userId = req.user.id;
        const pagination = getPagination(req.query);

        // Build query
        let whereClause = 'WHERE t.org_id = ?';
        const params = [orgId];

        if (type) {
            whereClause += ' AND t.tool_type = ?';
            params.push(type);
        }

        if (status) {
            whereClause += ' AND t.status = ?';
            params.push(status);
        } else {
            // Default to non-archived
            whereClause += ' AND t.status != ?';
            params.push('archived');
        }

        if (scope_id) {
            whereClause += ' AND t.home_scope_id = ?';
            params.push(scope_id);
        }

        if (search) {
            whereClause += ' AND (t.name LIKE ? OR t.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        // Get total count
        const countResult = prepare(`SELECT COUNT(*) as count FROM tools t ${whereClause}`).get(...params);
        const total = countResult.count;

        // Get tools with pagination
        let selectFields = `
            t.id, t.org_id, t.name, t.slug, t.description, t.icon,
            t.tool_type, t.risk_level, t.requires_approval, t.status, t.version,
            t.home_scope_id, t.share_policy_id,
            t.created_by, t.created_at, t.updated_at, t.published_at,
            u.display_name as created_by_name,
            s.path as scope_path, s.name_cache as scope_name,
            sp.name as share_policy_name, sp.mode as share_mode
        `;

        if (include_spec === 'true') {
            selectFields += ', t.spec_json, t.input_schema_json, t.output_schema_json, t.examples_json';
        }

        let tools = prepare(`
            SELECT ${selectFields}
            FROM tools t
            LEFT JOIN users u ON t.created_by = u.id
            LEFT JOIN scopes s ON t.home_scope_id = s.id
            LEFT JOIN share_policies sp ON t.share_policy_id = sp.id
            ${whereClause}
            ORDER BY t.name
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        // Filter by tag if specified
        if (tag) {
            const taggedToolIds = prepare(`
                SELECT asset_id FROM asset_tags
                WHERE asset_type = 'tool' AND tag_id = ?
            `).all(tag).map(r => r.asset_id);

            tools = tools.filter(t => taggedToolIds.includes(t.id));
        }

        // Get tags for each tool
        for (const tool of tools) {
            const tags = prepare(`
                SELECT tag.id, tag.name, tag.slug, tag.color
                FROM asset_tags at
                JOIN tags tag ON at.tag_id = tag.id
                WHERE at.asset_type = 'tool' AND at.asset_id = ?
            `).all(tool.id);
            tool.tags = tags;
        }

        res.json(formatPaginatedResponse(tools, total, pagination));
    } catch (error) {
        console.error('Error listing tools:', error);
        res.status(500).json({ error: 'Failed to list tools' });
    }
});

/**
 * GET /orgs/:orgId/tools/:toolId
 * Get a single tool with full details
 */
router.get('/orgs/:orgId/tools/:toolId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, toolId } = req.params;

        const tool = prepare(`
            SELECT t.*, u.display_name as created_by_name,
                   s.path as scope_path, s.name_cache as scope_name,
                   sp.name as share_policy_name, sp.mode as share_mode
            FROM tools t
            LEFT JOIN users u ON t.created_by = u.id
            LEFT JOIN scopes s ON t.home_scope_id = s.id
            LEFT JOIN share_policies sp ON t.share_policy_id = sp.id
            WHERE t.id = ? AND t.org_id = ?
        `).get(toolId, orgId);

        if (!tool) {
            return res.status(404).json({ error: 'Tool not found' });
        }

        // Get tags
        const tags = prepare(`
            SELECT tag.id, tag.name, tag.slug, tag.color
            FROM asset_tags at
            JOIN tags tag ON at.tag_id = tag.id
            WHERE at.asset_type = 'tool' AND at.asset_id = ?
        `).all(toolId);

        // Get version history
        const versions = prepare(`
            SELECT tv.version, tv.change_summary, tv.created_at,
                   u.display_name as created_by_name
            FROM tool_versions tv
            LEFT JOIN users u ON tv.created_by = u.id
            WHERE tv.tool_id = ?
            ORDER BY tv.version DESC
            LIMIT 10
        `).all(toolId);

        res.json({
            tool: {
                ...tool,
                spec: JSON.parse(tool.spec_json || '{}'),
                input_schema: JSON.parse(tool.input_schema_json || '{}'),
                output_schema: JSON.parse(tool.output_schema_json || '{}'),
                examples: JSON.parse(tool.examples_json || '[]'),
                tags,
                versions
            }
        });
    } catch (error) {
        console.error('Error getting tool:', error);
        res.status(500).json({ error: 'Failed to get tool' });
    }
});

/**
 * POST /orgs/:orgId/tools
 * Create a new tool
 */
router.post('/orgs/:orgId/tools', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const {
            name, slug, description, icon,
            tool_type, spec, input_schema, output_schema, examples,
            home_scope_id, share_policy_id,
            risk_level, requires_approval,
            tags
        } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_CREATE_TOOL)) {
            return res.status(403).json({ error: 'Insufficient permissions to create tools' });
        }

        // Validate required fields
        if (!name || !tool_type) {
            return res.status(400).json({ error: 'Name and tool_type are required' });
        }

        // Validate tool_type
        if (!TOOL_TYPES.includes(tool_type)) {
            return res.status(400).json({
                error: `Invalid tool_type. Must be one of: ${TOOL_TYPES.join(', ')}`
            });
        }

        // Validate risk_level if provided
        if (risk_level && !RISK_LEVELS.includes(risk_level)) {
            return res.status(400).json({
                error: `Invalid risk_level. Must be one of: ${RISK_LEVELS.join(', ')}`
            });
        }

        // Generate slug if not provided
        const toolSlug = slug || slugify(name);

        // Check for duplicate slug
        const existing = prepare(`
            SELECT id FROM tools WHERE org_id = ? AND slug = ?
        `).get(orgId, toolSlug);

        if (existing) {
            return res.status(409).json({ error: 'A tool with this slug already exists' });
        }

        // Validate home_scope_id if provided
        if (home_scope_id) {
            const scope = getScopeById(home_scope_id);
            if (!scope || scope.org_id !== orgId) {
                return res.status(400).json({ error: 'Invalid home_scope_id' });
            }
        }

        // Validate share_policy_id if provided
        if (share_policy_id) {
            const policy = prepare('SELECT id FROM share_policies WHERE id = ? AND org_id = ?').get(share_policy_id, orgId);
            if (!policy) {
                return res.status(400).json({ error: 'Invalid share_policy_id' });
            }
        }

        const db = getDb();
        const id = ulid();

        db.transaction(() => {
            // Create tool
            prepare(`
                INSERT INTO tools (
                    id, org_id, name, slug, description, icon,
                    tool_type, spec_json, input_schema_json, output_schema_json, examples_json,
                    home_scope_id, share_policy_id,
                    risk_level, requires_approval, status, created_by
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
            `).run(
                id, orgId, name, toolSlug, description || null, icon || null,
                tool_type,
                JSON.stringify(spec || {}),
                JSON.stringify(input_schema || {}),
                JSON.stringify(output_schema || {}),
                JSON.stringify(examples || []),
                home_scope_id || null, share_policy_id || null,
                risk_level || 'low', requires_approval ? 1 : 0,
                userId
            );

            // Create initial version
            prepare(`
                INSERT INTO tool_versions (id, tool_id, version, spec_json, input_schema_json, output_schema_json, change_summary, created_by)
                VALUES (?, ?, 1, ?, ?, ?, 'Initial version', ?)
            `).run(ulid(), id, JSON.stringify(spec || {}), JSON.stringify(input_schema || {}), JSON.stringify(output_schema || {}), userId);

            // Add tags if provided
            if (tags && tags.length > 0) {
                for (const tagId of tags) {
                    prepare(`
                        INSERT INTO asset_tags (id, asset_type, asset_id, tag_id)
                        VALUES (?, 'tool', ?, ?)
                    `).run(ulid(), id, tagId);
                }
            }
        })();

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool.create',
            targetType: 'tool',
            targetId: id,
            metadata: { name, tool_type, risk_level }
        });

        const tool = prepare('SELECT * FROM tools WHERE id = ?').get(id);

        res.status(201).json({
            tool: {
                ...tool,
                spec: JSON.parse(tool.spec_json || '{}'),
                input_schema: JSON.parse(tool.input_schema_json || '{}'),
                output_schema: JSON.parse(tool.output_schema_json || '{}')
            }
        });
    } catch (error) {
        console.error('Error creating tool:', error);
        res.status(500).json({ error: 'Failed to create tool' });
    }
});

/**
 * PATCH /orgs/:orgId/tools/:toolId
 * Update a tool
 */
router.patch('/orgs/:orgId/tools/:toolId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, toolId } = req.params;
        const {
            name, slug, description, icon,
            spec, input_schema, output_schema, examples,
            home_scope_id, share_policy_id,
            risk_level, requires_approval, status,
            change_summary
        } = req.body;
        const userId = req.user.id;

        // Check tool exists
        const existing = prepare('SELECT * FROM tools WHERE id = ? AND org_id = ?').get(toolId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Tool not found' });
        }

        // Check permission (creator or admin)
        const isCreator = existing.created_by === userId;
        const canEdit = resolveCap(req, Capabilities.DIRECTORY_CREATE_TOOL);
        if (!isCreator && !canEdit) {
            return res.status(403).json({ error: 'Insufficient permissions to edit this tool' });
        }

        // Validate status if changing
        if (status && !TOOL_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Must be one of: ${TOOL_STATUSES.join(', ')}`
            });
        }

        // Check slug uniqueness if changing
        if (slug && slug !== existing.slug) {
            const slugExists = prepare('SELECT id FROM tools WHERE org_id = ? AND slug = ? AND id != ?').get(orgId, slug, toolId);
            if (slugExists) {
                return res.status(409).json({ error: 'A tool with this slug already exists' });
            }
        }

        const db = getDb();
        const specChanged = spec && JSON.stringify(spec) !== existing.spec_json;

        db.transaction(() => {
            // Build update
            const updates = [];
            const values = [];

            if (name !== undefined) { updates.push('name = ?'); values.push(name); }
            if (slug !== undefined) { updates.push('slug = ?'); values.push(slug); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }
            if (spec !== undefined) { updates.push('spec_json = ?'); values.push(JSON.stringify(spec)); }
            if (input_schema !== undefined) { updates.push('input_schema_json = ?'); values.push(JSON.stringify(input_schema)); }
            if (output_schema !== undefined) { updates.push('output_schema_json = ?'); values.push(JSON.stringify(output_schema)); }
            if (examples !== undefined) { updates.push('examples_json = ?'); values.push(JSON.stringify(examples)); }
            if (home_scope_id !== undefined) { updates.push('home_scope_id = ?'); values.push(home_scope_id); }
            if (share_policy_id !== undefined) { updates.push('share_policy_id = ?'); values.push(share_policy_id); }
            if (risk_level !== undefined) { updates.push('risk_level = ?'); values.push(risk_level); }
            if (requires_approval !== undefined) { updates.push('requires_approval = ?'); values.push(requires_approval ? 1 : 0); }
            if (status !== undefined) {
                updates.push('status = ?');
                values.push(status);
                if (status === 'active' && existing.status === 'draft') {
                    updates.push("published_at = datetime('now')");
                }
                if (status === 'deprecated' && !existing.deprecated_at) {
                    updates.push("deprecated_at = datetime('now')");
                }
            }

            if (updates.length === 0) {
                return;
            }

            // Increment version if spec changed
            if (specChanged) {
                updates.push('version = version + 1');
            }

            updates.push("updated_at = datetime('now')");
            values.push(toolId);

            prepare(`UPDATE tools SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Create version entry if spec changed
            if (specChanged) {
                const newVersion = existing.version + 1;
                prepare(`
                    INSERT INTO tool_versions (id, tool_id, version, spec_json, input_schema_json, output_schema_json, change_summary, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    ulid(), toolId, newVersion,
                    JSON.stringify(spec),
                    JSON.stringify(input_schema || JSON.parse(existing.input_schema_json || '{}')),
                    JSON.stringify(output_schema || JSON.parse(existing.output_schema_json || '{}')),
                    change_summary || 'Updated',
                    userId
                );
            }
        })();

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool.update',
            targetType: 'tool',
            targetId: toolId,
            metadata: { updated_fields: Object.keys(req.body), spec_changed: specChanged }
        });

        const tool = prepare('SELECT * FROM tools WHERE id = ?').get(toolId);

        res.json({
            tool: {
                ...tool,
                spec: JSON.parse(tool.spec_json || '{}')
            }
        });
    } catch (error) {
        console.error('Error updating tool:', error);
        res.status(500).json({ error: 'Failed to update tool' });
    }
});

/**
 * DELETE /orgs/:orgId/tools/:toolId
 * Delete a tool (soft delete - set status to archived)
 */
router.delete('/orgs/:orgId/tools/:toolId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, toolId } = req.params;
        const userId = req.user.id;

        // Check tool exists
        const existing = prepare('SELECT * FROM tools WHERE id = ? AND org_id = ?').get(toolId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Tool not found' });
        }

        // Check permission
        const isCreator = existing.created_by === userId;
        const canDelete = resolveCap(req, Capabilities.DIRECTORY_CREATE_TOOL);
        if (!isCreator && !canDelete) {
            return res.status(403).json({ error: 'Insufficient permissions to delete this tool' });
        }

        // Soft delete
        prepare(`
            UPDATE tools SET status = 'archived', updated_at = datetime('now')
            WHERE id = ?
        `).run(toolId);

        // Audit log
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool.delete',
            targetType: 'tool',
            targetId: toolId,
            metadata: { name: existing.name }
        });

        res.json({ success: true, message: 'Tool archived' });
    } catch (error) {
        console.error('Error deleting tool:', error);
        res.status(500).json({ error: 'Failed to delete tool' });
    }
});

/**
 * POST /orgs/:orgId/tools/:toolId/publish
 * Publish a tool (change status from draft to active)
 */
router.post('/orgs/:orgId/tools/:toolId/publish', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, toolId } = req.params;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.DIRECTORY_PUBLISH)) {
            return res.status(403).json({ error: 'Insufficient permissions to publish tools' });
        }

        const tool = prepare('SELECT * FROM tools WHERE id = ? AND org_id = ?').get(toolId, orgId);
        if (!tool) {
            return res.status(404).json({ error: 'Tool not found' });
        }

        if (tool.status !== 'draft') {
            return res.status(400).json({ error: 'Only draft tools can be published' });
        }

        prepare(`
            UPDATE tools SET status = 'active', published_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(toolId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tool.publish',
            targetType: 'tool',
            targetId: toolId,
            metadata: { name: tool.name }
        });

        res.json({ success: true, message: 'Tool published' });
    } catch (error) {
        console.error('Error publishing tool:', error);
        res.status(500).json({ error: 'Failed to publish tool' });
    }
});

/**
 * POST /orgs/:orgId/tools/:toolId/tags
 * Add tags to a tool
 */
router.post('/orgs/:orgId/tools/:toolId/tags', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, toolId } = req.params;
        const { tag_ids } = req.body;

        if (!tag_ids || !Array.isArray(tag_ids)) {
            return res.status(400).json({ error: 'tag_ids array is required' });
        }

        const tool = prepare('SELECT id FROM tools WHERE id = ? AND org_id = ?').get(toolId, orgId);
        if (!tool) {
            return res.status(404).json({ error: 'Tool not found' });
        }

        for (const tagId of tag_ids) {
            // Check tag exists
            const tag = prepare('SELECT id FROM tags WHERE id = ? AND org_id = ?').get(tagId, orgId);
            if (!tag) continue;

            // Check if already tagged
            const existing = prepare('SELECT id FROM asset_tags WHERE asset_type = ? AND asset_id = ? AND tag_id = ?').get('tool', toolId, tagId);
            if (existing) continue;

            prepare('INSERT INTO asset_tags (id, asset_type, asset_id, tag_id) VALUES (?, ?, ?, ?)').run(ulid(), 'tool', toolId, tagId);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error adding tags:', error);
        res.status(500).json({ error: 'Failed to add tags' });
    }
});

/**
 * DELETE /orgs/:orgId/tools/:toolId/tags/:tagId
 * Remove a tag from a tool
 */
router.delete('/orgs/:orgId/tools/:toolId/tags/:tagId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, toolId, tagId } = req.params;

        const tool = prepare('SELECT id FROM tools WHERE id = ? AND org_id = ?').get(toolId, orgId);
        if (!tool) {
            return res.status(404).json({ error: 'Tool not found' });
        }

        prepare('DELETE FROM asset_tags WHERE asset_type = ? AND asset_id = ? AND tag_id = ?').run('tool', toolId, tagId);

        res.json({ success: true });
    } catch (error) {
        console.error('Error removing tag:', error);
        res.status(500).json({ error: 'Failed to remove tag' });
    }
});

export default router;
