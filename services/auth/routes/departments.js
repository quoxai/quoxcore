/**
 * Department Routes for Quox Auth Service
 * Phase B.1: Organizational hierarchy
 *
 * Departments belong to divisions and contain teams.
 * Structure: Org → Division → Department → Team
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { createScope, getScopeForEntity, deleteScope, updateScopeNameCache } from '../utils/scopes.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, slugify } from '../utils/helpers.js';
import { generateDepartmentAssistantPersona, generateDepartmentAssistantName } from '../utils/scopeAssistantTemplates.js';
import { buildAssistantPersistencePayload } from './assistantLlm.js';
import { provisionRoomForNode, deprovisionRoomForNode, isMatrixRoomsEnabled } from '../lib/matrixProvisioner.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /orgs/:orgId/divisions/:divisionId/departments
 * List all departments in a division
 */
router.get('/orgs/:orgId/divisions/:divisionId/departments', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, divisionId } = req.params;
        const { includeStats } = req.query;

        // Verify division exists
        const division = prepare(`
            SELECT id FROM divisions WHERE id = ? AND org_id = ? AND deleted_at IS NULL
        `).get(divisionId, orgId);

        if (!division) {
            return res.status(404).json({ error: 'Division not found' });
        }

        let departments = prepare(`
            SELECT d.*, u.display_name as created_by_name
            FROM departments d
            LEFT JOIN users u ON d.created_by = u.id
            WHERE d.division_id = ? AND d.deleted_at IS NULL
            ORDER BY d.sort_order, d.name
        `).all(divisionId);

        // Optionally include team counts
        if (includeStats === 'true') {
            // Get teams attached to department scopes
            for (const dept of departments) {
                const scope = getScopeForEntity('department', dept.id);
                if (scope) {
                    const teamCount = prepare(`
                        SELECT COUNT(*) as count FROM teams
                        WHERE attach_scope_id = ? AND org_id = ?
                    `).get(scope.id, orgId);
                    dept.team_count = teamCount?.count || 0;
                } else {
                    dept.team_count = 0;
                }
            }
        }

        res.json({ departments });
    } catch (error) {
        console.error('Error listing departments:', error);
        res.status(500).json({ error: 'Failed to list departments' });
    }
});

/**
 * GET /orgs/:orgId/departments
 * List all departments in an org (flat list)
 */
router.get('/orgs/:orgId/departments', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { includeStats } = req.query;

        const departments = prepare(`
            SELECT d.*, div.name as division_name, div.slug as division_slug,
                   u.display_name as created_by_name
            FROM departments d
            JOIN divisions div ON d.division_id = div.id
            LEFT JOIN users u ON d.created_by = u.id
            WHERE d.org_id = ? AND d.deleted_at IS NULL AND div.deleted_at IS NULL
            ORDER BY div.sort_order, div.name, d.sort_order, d.name
        `).all(orgId);

        // Optionally include team counts (same logic as per-division endpoint)
        if (includeStats === 'true') {
            for (const dept of departments) {
                const scope = getScopeForEntity('department', dept.id);
                if (scope) {
                    const teamCount = prepare(`
                        SELECT COUNT(*) as count FROM teams
                        WHERE attach_scope_id = ? AND org_id = ?
                    `).get(scope.id, orgId);
                    dept.team_count = teamCount?.count || 0;
                } else {
                    dept.team_count = 0;
                }
            }
        }

        res.json({ departments });
    } catch (error) {
        console.error('Error listing departments:', error);
        res.status(500).json({ error: 'Failed to list departments' });
    }
});

/**
 * GET /orgs/:orgId/divisions/:divisionId/departments/:departmentId
 * Get a single department
 */
router.get('/orgs/:orgId/divisions/:divisionId/departments/:departmentId',
    requireOrgMembership,
    async (req, res) => {
        try {
            const { orgId, divisionId, departmentId } = req.params;

            const department = prepare(`
                SELECT d.*, div.name as division_name, u.display_name as created_by_name
                FROM departments d
                JOIN divisions div ON d.division_id = div.id
                LEFT JOIN users u ON d.created_by = u.id
                WHERE d.id = ? AND d.division_id = ? AND d.org_id = ? AND d.deleted_at IS NULL
            `).get(departmentId, divisionId, orgId);

            if (!department) {
                return res.status(404).json({ error: 'Department not found' });
            }

            // Get scope info
            const scope = getScopeForEntity('department', departmentId);

            res.json({
                department: { ...department, scope }
            });
        } catch (error) {
            console.error('Error getting department:', error);
            res.status(500).json({ error: 'Failed to get department' });
        }
    }
);

/**
 * POST /orgs/:orgId/divisions/:divisionId/departments
 * Create a new department
 */
router.post('/orgs/:orgId/divisions/:divisionId/departments',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, divisionId } = req.params;
            const { name, description, profile } = req.body;
            // #991: the CLI and API callers may omit slug; derive it from the name.
            const slug = req.body.slug || (name ? slugify(String(name)).replace(/_/g, '-') : '');
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.ORG_MANAGE_DEPARTMENTS)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage departments' });
            }

            // Verify division exists
            const division = prepare(`
                SELECT * FROM divisions WHERE id = ? AND org_id = ? AND deleted_at IS NULL
            `).get(divisionId, orgId);

            if (!division) {
                return res.status(404).json({ error: 'Division not found' });
            }

            // Validate required fields
            if (!name || !slug) {
                return res.status(400).json({ error: 'Name and slug are required' });
            }

            // Validate slug format
            if (!/^[a-z0-9-]+$/.test(slug)) {
                return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens' });
            }

            // Check for duplicate slug within division
            const existing = prepare(`
                SELECT id FROM departments WHERE division_id = ? AND slug = ? AND deleted_at IS NULL
            `).get(divisionId, slug);

            if (existing) {
                return res.status(409).json({ error: 'A department with this slug already exists in this division' });
            }

            const db = getDb();
            const id = ulid();

            // Get division scope as parent
            const divisionScope = getScopeForEntity('division', divisionId);
            if (!divisionScope) {
                return res.status(500).json({ error: 'Division scope not found' });
            }

            db.transaction(() => {
                // Create department
                prepare(`
                    INSERT INTO departments (id, org_id, division_id, name, slug, description, profile_json, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(id, orgId, divisionId, name, slug, description || null, JSON.stringify(profile || {}), userId);

                // Create scope for department
                const deptScope = createScope(orgId, 'department', id, divisionScope.id, name);

                // Auto-create department team
                // Find parent division's team
                const divTeam = prepare(
                    'SELECT id FROM teams WHERE org_id = ? AND attach_scope_id = ? LIMIT 1'
                ).get(orgId, divisionScope.id);
                const teamId = ulid();
                const teamSlug = slug + '-team';
                prepare(`
                    INSERT INTO teams (id, org_id, name, slug, description, parent_team_id, attach_scope_id, settings_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(teamId, orgId, `${name} Team`, teamSlug, `Auto-created team for ${name}`,
                       divTeam?.id || null, deptScope.id,
                       JSON.stringify({ created_by: userId, auto_created: true }));

                // Create scope for the team
                createScope(orgId, 'team', teamId, deptScope.id, `${name} Team`);

                // Add creator as team admin
                prepare(`
                    INSERT INTO team_memberships (id, team_id, user_id, role, status)
                    VALUES (?, ?, ?, 'admin', 'active')
                `).run(ulid(), teamId, userId);

                // Auto-create department scope assistant
                const org = prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
                const division = prepare('SELECT name FROM divisions WHERE id = ?').get(divisionId);
                const deptAssistantId = ulid();
                const deptPersona = generateDepartmentAssistantPersona(
                    name, division?.name || 'Division', org?.name || 'Organization'
                );
                const deptAssistantPersistence = buildAssistantPersistencePayload({ persona: deptPersona });
                prepare(`
                    INSERT INTO assistants (id, org_id, home_scope_id, name, slug, description,
                        persona_json, model_id, model_config_json, status, created_by, published_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
                `).run(
                    deptAssistantId,
                    orgId,
                    deptScope.id,
                    generateDepartmentAssistantName(name, org?.name || 'Organization'),
                    slug + '-assistant',
                    `AI assistant for ${name} department`,
                    deptAssistantPersistence.personaJson,
                    deptAssistantPersistence.modelId,
                    deptAssistantPersistence.modelConfigJson,
                    userId
                );
            })();

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'department.create',
                targetType: 'department',
                targetId: id,
                metadata: { name, slug, division_id: divisionId }
            });

            // M-ROOMS Phase 1: eager Matrix room provisioning. Non-fatal by
            // contract; backfillRooms is the backstop.
            if (await isMatrixRoomsEnabled(orgId)) {
                provisionRoomForNode({ orgId, nodeType: 'department', nodeId: id, actorId: userId })
                    .catch((err) => console.error('[MatrixRooms] eager department-room provision failed (non-fatal):', err.message));
            }

            const department = prepare('SELECT * FROM departments WHERE id = ?').get(id);
            const scope = getScopeForEntity('department', id);

            res.status(201).json({
                department: { ...department, scope }
            });
        } catch (error) {
            console.error('Error creating department:', error);
            res.status(500).json({ error: 'Failed to create department' });
        }
    }
);

/**
 * PATCH /orgs/:orgId/divisions/:divisionId/departments/:departmentId
 * Update a department
 */
router.patch('/orgs/:orgId/divisions/:divisionId/departments/:departmentId',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, divisionId, departmentId } = req.params;
            const { name, slug, description, profile, sort_order } = req.body;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.ORG_MANAGE_DEPARTMENTS)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage departments' });
            }

            // Check department exists
            const existing = prepare(`
                SELECT * FROM departments WHERE id = ? AND division_id = ? AND org_id = ? AND deleted_at IS NULL
            `).get(departmentId, divisionId, orgId);

            if (!existing) {
                return res.status(404).json({ error: 'Department not found' });
            }

            // Check slug uniqueness if changing
            if (slug && slug !== existing.slug) {
                if (!/^[a-z0-9-]+$/.test(slug)) {
                    return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens' });
                }
                const slugExists = prepare(`
                    SELECT id FROM departments WHERE division_id = ? AND slug = ? AND id != ? AND deleted_at IS NULL
                `).get(divisionId, slug, departmentId);
                if (slugExists) {
                    return res.status(409).json({ error: 'A department with this slug already exists' });
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
            values.push(departmentId);

            prepare(`UPDATE departments SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Update scope name cache if name changed
            if (name && name !== existing.name) {
                updateScopeNameCache('department', departmentId, name);
            }

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'department.update',
                targetType: 'department',
                targetId: departmentId,
                metadata: { updated_fields: Object.keys(req.body) }
            });

            const department = prepare('SELECT * FROM departments WHERE id = ?').get(departmentId);
            res.json({ department });
        } catch (error) {
            console.error('Error updating department:', error);
            res.status(500).json({ error: 'Failed to update department' });
        }
    }
);

/**
 * DELETE /orgs/:orgId/divisions/:divisionId/departments/:departmentId
 * Soft delete a department
 */
router.delete('/orgs/:orgId/divisions/:divisionId/departments/:departmentId',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, divisionId, departmentId } = req.params;
            const userId = req.user.id;

            // Check capability
            if (!resolveCap(req, Capabilities.ORG_MANAGE_DEPARTMENTS)) {
                return res.status(403).json({ error: 'Insufficient permissions to manage departments' });
            }

            // Check department exists
            const existing = prepare(`
                SELECT * FROM departments WHERE id = ? AND division_id = ? AND org_id = ? AND deleted_at IS NULL
            `).get(departmentId, divisionId, orgId);

            if (!existing) {
                return res.status(404).json({ error: 'Department not found' });
            }

            const db = getDb();

            db.transaction(() => {
                // Soft delete the department
                prepare(`
                    UPDATE departments SET deleted_at = datetime('now')
                    WHERE id = ?
                `).run(departmentId);

                // Delete scope
                const scope = getScopeForEntity('department', departmentId);
                if (scope) {
                    // #994: the department's auto-created team and scope assistant
                    // (made in the create handler) go with it; they still point at
                    // the scope and would block the delete on the FOREIGN KEY.
                    const autoTeams = prepare(
                        'SELECT id, settings_json FROM teams WHERE org_id = ? AND attach_scope_id = ?'
                    ).all(orgId, scope.id).filter((t) => {
                        try { return JSON.parse(t.settings_json || '{}').auto_created === true; } catch { return false; }
                    });
                    for (const t of autoTeams) {
                        prepare('DELETE FROM team_memberships WHERE team_id = ?').run(t.id);
                        prepare('DELETE FROM teams WHERE id = ?').run(t.id);
                    }
                    prepare(`
                        UPDATE assistants SET status = 'archived', home_scope_id = NULL, updated_at = datetime('now')
                        WHERE org_id = ? AND home_scope_id = ? AND slug = ?
                    `).run(orgId, scope.id, `${existing.slug}-assistant`);
                    deleteScope(scope.id);
                }
            })();

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'department.delete',
                targetType: 'department',
                targetId: departmentId,
                metadata: { name: existing.name }
            });

            // M-ROOMS teardown: retire the department's Matrix room ledger row.
            if (await isMatrixRoomsEnabled(orgId)) {
                deprovisionRoomForNode({ orgId, nodeType: 'department', nodeId: departmentId, actorId: userId })
                    .catch((err) => console.warn('[MatrixRooms] eager department-room deprovision failed (non-fatal):', err.message));
            }

            res.json({ success: true, message: 'Department deleted' });
        } catch (error) {
            console.error('Error deleting department:', error);
            if (error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                return res.status(409).json({ error: 'This department still has assistants, tools or other items homed in it. Move or delete them first.' });
            }
            res.status(500).json({ error: 'Failed to delete department' });
        }
    }
);

export default router;
