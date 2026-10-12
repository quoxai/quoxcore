/**
 * Division Routes for Quox Auth Service
 * Phase B.1: Organizational hierarchy
 *
 * Divisions are top-level organizational units within an org.
 * Structure: Org → Division → Department → Team
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { createScope, getScopeForEntity, deleteScope, updateScopeNameCache } from '../utils/scopes.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';
import { generateDivisionAssistantPersona, generateDivisionAssistantName } from '../utils/scopeAssistantTemplates.js';
import { buildAssistantPersistencePayload } from './assistantLlm.js';
import { provisionRoomForNode, deprovisionRoomForNode, isMatrixRoomsEnabled } from '../lib/matrixProvisioner.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /orgs/:orgId/divisions
 * List all divisions in an org
 */
router.get('/orgs/:orgId/divisions', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { includeStats } = req.query;

        let divisions = prepare(`
            SELECT d.*, u.display_name as created_by_name
            FROM divisions d
            LEFT JOIN users u ON d.created_by = u.id
            WHERE d.org_id = ? AND d.deleted_at IS NULL
            ORDER BY d.sort_order, d.name
        `).all(orgId);

        // Optionally include department counts
        if (includeStats === 'true') {
            const stats = prepare(`
                SELECT division_id, COUNT(*) as department_count
                FROM departments
                WHERE org_id = ? AND deleted_at IS NULL
                GROUP BY division_id
            `).all(orgId);

            const statsMap = new Map(stats.map(s => [s.division_id, s.department_count]));
            divisions = divisions.map(div => ({
                ...div,
                department_count: statsMap.get(div.id) || 0
            }));
        }

        res.json({ divisions });
    } catch (error) {
        console.error('Error listing divisions:', error);
        res.status(500).json({ error: 'Failed to list divisions' });
    }
});

/**
 * GET /orgs/:orgId/divisions/:divisionId
 * Get a single division
 */
router.get('/orgs/:orgId/divisions/:divisionId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, divisionId } = req.params;

        const division = prepare(`
            SELECT d.*, u.display_name as created_by_name
            FROM divisions d
            LEFT JOIN users u ON d.created_by = u.id
            WHERE d.id = ? AND d.org_id = ? AND d.deleted_at IS NULL
        `).get(divisionId, orgId);

        if (!division) {
            return res.status(404).json({ error: 'Division not found' });
        }

        // Get scope info
        const scope = getScopeForEntity('division', divisionId);

        // Get department count
        const deptCount = prepare(`
            SELECT COUNT(*) as count FROM departments
            WHERE division_id = ? AND deleted_at IS NULL
        `).get(divisionId);

        res.json({
            division: {
                ...division,
                scope,
                department_count: deptCount?.count || 0
            }
        });
    } catch (error) {
        console.error('Error getting division:', error);
        res.status(500).json({ error: 'Failed to get division' });
    }
});

/**
 * POST /orgs/:orgId/divisions
 * Create a new division
 */
router.post('/orgs/:orgId/divisions',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const { name, slug, description, profile } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage divisions' });
            }

            // Validate required fields
            if (!name || !slug) {
                return res.status(400).json({ error: 'Name and slug are required' });
            }

            // Validate slug format
            if (!/^[a-z0-9-]+$/.test(slug)) {
                return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens' });
            }

            // Check for duplicate slug
            const existing = prepare(`
                SELECT id FROM divisions WHERE org_id = ? AND slug = ? AND deleted_at IS NULL
            `).get(orgId, slug);

            if (existing) {
                return res.status(409).json({ error: 'A division with this slug already exists' });
            }

            const db = getDb();
            const id = ulid();

            // Get org scope to use as parent
            const orgScope = getScopeForEntity('org', orgId);
            if (!orgScope) {
                // Create org scope if it doesn't exist
                const org = prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
                createScope(orgId, 'org', orgId, null, org?.name || 'Organization');
            }
            const parentScope = getScopeForEntity('org', orgId);

            db.transaction(() => {
                // Create division
                prepare(`
                    INSERT INTO divisions (id, org_id, name, slug, description, profile_json, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(id, orgId, name, slug, description || null, JSON.stringify(profile || {}), userId);

                // Create scope for division
                const divisionScope = createScope(orgId, 'division', id, parentScope?.id, name);

                // Auto-create division team
                const orgTeam = prepare(
                    'SELECT id FROM teams WHERE org_id = ? AND parent_team_id IS NULL LIMIT 1'
                ).get(orgId);
                const teamId = ulid();
                const teamSlug = slug + '-team';
                prepare(`
                    INSERT INTO teams (id, org_id, name, slug, description, parent_team_id, attach_scope_id, settings_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(teamId, orgId, `${name} Team`, teamSlug, `Auto-created team for ${name}`,
                       orgTeam?.id || null, divisionScope.id,
                       JSON.stringify({ created_by: userId, auto_created: true }));

                // Create scope for the team
                createScope(orgId, 'team', teamId, divisionScope.id, `${name} Team`);

                // Add creator as team admin
                prepare(`
                    INSERT INTO team_memberships (id, team_id, user_id, role, status)
                    VALUES (?, ?, ?, 'admin', 'active')
                `).run(ulid(), teamId, userId);

                // Auto-create division scope assistant
                const org = prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
                const divAssistantId = ulid();
                const divPersona = generateDivisionAssistantPersona(name, org?.name || 'Organization');
                const divAssistantPersistence = buildAssistantPersistencePayload({ persona: divPersona });
                prepare(`
                    INSERT INTO assistants (id, org_id, home_scope_id, name, slug, description,
                        persona_json, model_id, model_config_json, status, created_by, published_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
                `).run(
                    divAssistantId,
                    orgId,
                    divisionScope.id,
                    generateDivisionAssistantName(name, org?.name || 'Organization'),
                    slug + '-assistant',
                    `AI assistant for ${name} division`,
                    divAssistantPersistence.personaJson,
                    divAssistantPersistence.modelId,
                    divAssistantPersistence.modelConfigJson,
                    userId
                );
            })();

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'division.create',
                targetType: 'division',
                targetId: id,
                metadata: { name, slug }
            });

            // M-ROOMS Phase 1: eager Matrix room provisioning. Non-fatal by
            // contract; backfillRooms is the backstop.
            if (await isMatrixRoomsEnabled(orgId)) {
                provisionRoomForNode({ orgId, nodeType: 'division', nodeId: id, actorId: userId })
                    .catch((err) => console.error('[MatrixRooms] eager division-room provision failed (non-fatal):', err.message));
            }

            const division = prepare('SELECT * FROM divisions WHERE id = ?').get(id);
            const scope = getScopeForEntity('division', id);

            res.status(201).json({
                division: { ...division, scope }
            });
        } catch (error) {
            console.error('Error creating division:', error);
            res.status(500).json({ error: 'Failed to create division' });
        }
    }
);

/**
 * PATCH /orgs/:orgId/divisions/:divisionId
 * Update a division
 */
router.patch('/orgs/:orgId/divisions/:divisionId',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, divisionId } = req.params;
            const { name, slug, description, profile, sort_order } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage divisions' });
            }

            // Check division exists
            const existing = prepare(`
                SELECT * FROM divisions WHERE id = ? AND org_id = ? AND deleted_at IS NULL
            `).get(divisionId, orgId);

            if (!existing) {
                return res.status(404).json({ error: 'Division not found' });
            }

            // Check slug uniqueness if changing
            if (slug && slug !== existing.slug) {
                if (!/^[a-z0-9-]+$/.test(slug)) {
                    return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens' });
                }
                const slugExists = prepare(`
                    SELECT id FROM divisions WHERE org_id = ? AND slug = ? AND id != ? AND deleted_at IS NULL
                `).get(orgId, slug, divisionId);
                if (slugExists) {
                    return res.status(409).json({ error: 'A division with this slug already exists' });
                }
            }

            // Build update
            const updates = [];
            const values = [];

            if (name !== undefined) { updates.push('name = ?'); values.push(name); }
            if (slug !== undefined) { updates.push('slug = ?'); values.push(slug); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (profile !== undefined) { updates.push('profile_json = ?'); values.push(JSON.stringify(profile)); }
            if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            updates.push("updated_at = datetime('now')");
            values.push(divisionId);

            prepare(`UPDATE divisions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Update scope name cache if name changed
            if (name && name !== existing.name) {
                updateScopeNameCache('division', divisionId, name);
            }

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'division.update',
                targetType: 'division',
                targetId: divisionId,
                metadata: { updated_fields: Object.keys(req.body) }
            });

            const division = prepare('SELECT * FROM divisions WHERE id = ?').get(divisionId);
            res.json({ division });
        } catch (error) {
            console.error('Error updating division:', error);
            res.status(500).json({ error: 'Failed to update division' });
        }
    }
);

/**
 * DELETE /orgs/:orgId/divisions/:divisionId
 * Soft delete a division (and cascade to departments/teams)
 */
router.delete('/orgs/:orgId/divisions/:divisionId',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, divisionId } = req.params;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.ORG_MANAGE_DIVISIONS)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage divisions' });
            }

            // Check division exists
            const existing = prepare(`
                SELECT * FROM divisions WHERE id = ? AND org_id = ? AND deleted_at IS NULL
            `).get(divisionId, orgId);

            if (!existing) {
                return res.status(404).json({ error: 'Division not found' });
            }

            const db = getDb();

            db.transaction(() => {
                // Soft delete departments in this division
                prepare(`
                    UPDATE departments SET deleted_at = datetime('now')
                    WHERE division_id = ? AND deleted_at IS NULL
                `).run(divisionId);

                // Soft delete the division
                prepare(`
                    UPDATE divisions SET deleted_at = datetime('now')
                    WHERE id = ?
                `).run(divisionId);

                // Delete scope (this cascades to child scopes)
                const scope = getScopeForEntity('division', divisionId);
                if (scope) {
                    deleteScope(scope.id);
                }
            })();

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'division.delete',
                targetType: 'division',
                targetId: divisionId,
                metadata: { name: existing.name }
            });

            // M-ROOMS teardown: retire the division's Matrix room ledger row.
            if (await isMatrixRoomsEnabled(orgId)) {
                deprovisionRoomForNode({ orgId, nodeType: 'division', nodeId: divisionId, actorId: userId })
                    .catch((err) => console.warn('[MatrixRooms] eager division-room deprovision failed (non-fatal):', err.message));
            }

            res.json({ success: true, message: 'Division deleted' });
        } catch (error) {
            console.error('Error deleting division:', error);
            res.status(500).json({ error: 'Failed to delete division' });
        }
    }
);

export default router;
