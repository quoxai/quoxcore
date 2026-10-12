/**
 * Tags Routes for Quox Auth Service
 * Phase B.1: Asset tagging system
 */

import { Router } from 'express';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, slugify } from '../utils/helpers.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /orgs/:orgId/tags
 * List all tags in an org
 */
router.get('/orgs/:orgId/tags', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { include_counts } = req.query;

        let tags = prepare(`
            SELECT t.*, u.display_name as created_by_name
            FROM tags t
            LEFT JOIN users u ON t.created_by = u.id
            WHERE t.org_id = ?
            ORDER BY t.name
        `).all(orgId);

        if (include_counts === 'true') {
            for (const tag of tags) {
                const counts = prepare(`
                    SELECT asset_type, COUNT(*) as count
                    FROM asset_tags
                    WHERE tag_id = ?
                    GROUP BY asset_type
                `).all(tag.id);

                tag.usage = {};
                for (const c of counts) {
                    tag.usage[c.asset_type] = c.count;
                }
                tag.total_usage = counts.reduce((sum, c) => sum + c.count, 0);
            }
        }

        res.json({ tags });
    } catch (error) {
        console.error('Error listing tags:', error);
        res.status(500).json({ error: 'Failed to list tags' });
    }
});

/**
 * GET /orgs/:orgId/tags/:tagId
 * Get a single tag
 */
router.get('/orgs/:orgId/tags/:tagId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, tagId } = req.params;

        const tag = prepare(`
            SELECT t.*, u.display_name as created_by_name
            FROM tags t
            LEFT JOIN users u ON t.created_by = u.id
            WHERE t.id = ? AND t.org_id = ?
        `).get(tagId, orgId);

        if (!tag) {
            return res.status(404).json({ error: 'Tag not found' });
        }

        // Get usage
        const usage = prepare(`
            SELECT asset_type, COUNT(*) as count
            FROM asset_tags
            WHERE tag_id = ?
            GROUP BY asset_type
        `).all(tagId);

        res.json({
            tag: {
                ...tag,
                usage: Object.fromEntries(usage.map(u => [u.asset_type, u.count]))
            }
        });
    } catch (error) {
        console.error('Error getting tag:', error);
        res.status(500).json({ error: 'Failed to get tag' });
    }
});

/**
 * POST /orgs/:orgId/tags
 * Create a new tag
 */
router.post('/orgs/:orgId/tags', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { name, slug, description, color, icon } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.TAGS_MANAGE)) {
            return res.status(403).json({ error: 'Insufficient permissions to manage tags' });
        }

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const tagSlug = slug || slugify(name);

        // Check for duplicate
        const existing = prepare('SELECT id FROM tags WHERE org_id = ? AND slug = ?').get(orgId, tagSlug);
        if (existing) {
            return res.status(409).json({ error: 'A tag with this slug already exists' });
        }

        // Validate color format if provided
        if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
            return res.status(400).json({ error: 'Color must be a valid hex color (e.g., #ff3333)' });
        }

        const id = ulid();

        prepare(`
            INSERT INTO tags (id, org_id, name, slug, description, color, icon, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, orgId, name, tagSlug, description || null, color || '#666666', icon || null, userId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tag.create',
            targetType: 'tag',
            targetId: id,
            metadata: { name }
        });

        const tag = prepare('SELECT * FROM tags WHERE id = ?').get(id);
        res.status(201).json({ tag });
    } catch (error) {
        console.error('Error creating tag:', error);
        res.status(500).json({ error: 'Failed to create tag' });
    }
});

/**
 * PATCH /orgs/:orgId/tags/:tagId
 * Update a tag
 */
router.patch('/orgs/:orgId/tags/:tagId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, tagId } = req.params;
        const { name, slug, description, color, icon } = req.body;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.TAGS_MANAGE)) {
            return res.status(403).json({ error: 'Insufficient permissions to manage tags' });
        }

        const existing = prepare('SELECT * FROM tags WHERE id = ? AND org_id = ?').get(tagId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Tag not found' });
        }

        if (slug && slug !== existing.slug) {
            const slugExists = prepare('SELECT id FROM tags WHERE org_id = ? AND slug = ? AND id != ?').get(orgId, slug, tagId);
            if (slugExists) {
                return res.status(409).json({ error: 'A tag with this slug already exists' });
            }
        }

        const updates = [];
        const values = [];

        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (slug !== undefined) { updates.push('slug = ?'); values.push(slug); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (color !== undefined) { updates.push('color = ?'); values.push(color); }
        if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(tagId);
        prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tag.update',
            targetType: 'tag',
            targetId: tagId,
            metadata: { updated_fields: Object.keys(req.body) }
        });

        const tag = prepare('SELECT * FROM tags WHERE id = ?').get(tagId);
        res.json({ tag });
    } catch (error) {
        console.error('Error updating tag:', error);
        res.status(500).json({ error: 'Failed to update tag' });
    }
});

/**
 * DELETE /orgs/:orgId/tags/:tagId
 * Delete a tag
 */
router.delete('/orgs/:orgId/tags/:tagId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, tagId } = req.params;
        const userId = req.user.id;

        if (!resolveCap(req, Capabilities.TAGS_MANAGE)) {
            return res.status(403).json({ error: 'Insufficient permissions to manage tags' });
        }

        const existing = prepare('SELECT * FROM tags WHERE id = ? AND org_id = ?').get(tagId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Tag not found' });
        }

        // Delete tag associations
        prepare('DELETE FROM asset_tags WHERE tag_id = ?').run(tagId);

        // Delete tag
        prepare('DELETE FROM tags WHERE id = ?').run(tagId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'tag.delete',
            targetType: 'tag',
            targetId: tagId,
            metadata: { name: existing.name }
        });

        res.json({ success: true, message: 'Tag deleted' });
    } catch (error) {
        console.error('Error deleting tag:', error);
        res.status(500).json({ error: 'Failed to delete tag' });
    }
});

export default router;
