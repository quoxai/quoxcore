/**
 * Team Routes for Quox Auth Service
 * Phase B.1: Full team implementation
 *
 * Teams belong to orgs and can be attached to any scope in the hierarchy.
 * Structure: Org → Division → Department → Team
 */

import { Router } from 'express';
import { getDb, prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgMembershipSecure, requireOrgRole } from '../middleware/org.js';
import { createScope, getScopeForEntity, getScopeById, deleteScope, updateScopeNameCache } from '../utils/scopes.js';
import { Capabilities, hasRoleLevel, OrgRoles } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, slugify } from '../utils/helpers.js';
import { emitAndDispatch } from '../utils/teamEventEmitter.js';
import { provisionRoomForNode, deprovisionRoomForNode, isMatrixRoomsEnabled } from '../lib/matrixProvisioner.js';
import { humanGrantorOnly } from '../utils/principal.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /orgs/:orgId/teams
 * List all teams in an org
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/teams', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { includeStats, scope_id } = req.query;

        let query = `
            SELECT t.*, u.display_name as created_by_name,
                   s.path as scope_path, s.name_cache as scope_name
            FROM teams t
            LEFT JOIN users u ON t.settings_json LIKE '%"created_by":"' || u.id || '"%'
            LEFT JOIN scopes s ON t.attach_scope_id = s.id
            WHERE t.org_id = ?
        `;
        const params = [orgId];

        if (scope_id) {
            query += ' AND t.attach_scope_id = ?';
            params.push(scope_id);
        }

        query += ' ORDER BY t.name';

        let teams = prepare(query).all(...params);

        // Optionally include member counts
        if (includeStats === 'true') {
            const stats = prepare(`
                SELECT team_id, COUNT(*) as member_count
                FROM team_memberships
                WHERE status = 'active'
                GROUP BY team_id
            `).all();

            const statsMap = new Map(stats.map(s => [s.team_id, s.member_count]));
            teams = teams.map(team => ({
                ...team,
                member_count: statsMap.get(team.id) || 0
            }));
        }

        res.json({ teams });
    } catch (error) {
        console.error('Error listing teams:', error);
        res.status(500).json({ error: 'Failed to list teams' });
    }
});

/**
 * GET /orgs/:orgId/teams/:teamId
 * Get a single team with members
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/teams/:teamId', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId, teamId } = req.params;

        const team = prepare(`
            SELECT t.*, s.path as scope_path, s.name_cache as scope_name
            FROM teams t
            LEFT JOIN scopes s ON t.attach_scope_id = s.id
            WHERE t.id = ? AND t.org_id = ?
        `).get(teamId, orgId);

        if (!team) {
            return res.status(404).json({ error: 'Team not found' });
        }

        // Get members
        const members = prepare(`
            SELECT tm.*, u.id as user_id, u.primary_email, u.display_name, u.avatar_url
            FROM team_memberships tm
            JOIN users u ON tm.user_id = u.id
            WHERE tm.team_id = ? AND tm.status = 'active'
            ORDER BY tm.role DESC, u.display_name
        `).all(teamId);

        // Get team scope
        const scope = getScopeForEntity('team', teamId);

        res.json({
            team: {
                ...team,
                scope,
                members
            }
        });
    } catch (error) {
        console.error('Error getting team:', error);
        res.status(500).json({ error: 'Failed to get team' });
    }
});

/**
 * POST /orgs/:orgId/teams
 * Create a new team
 */
router.post('/orgs/:orgId/teams',
    requireOrgMembership,
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const { name, description, attach_scope_id, parent_team_id, settings } = req.body;
            // #991: the CLI and API callers may omit slug; derive it from the name.
            const slug = req.body.slug || (name ? slugify(String(name)).replace(/_/g, '-') : '');
            const userId = req.user.id;

            // Check capability (admin or builder with team.create)
            const canCreate = resolveCap(req, Capabilities.TEAM_CREATE);
            if (!canCreate) {
                return res.status(403).json({ error: 'Insufficient permissions to create teams' });
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
                SELECT id FROM teams WHERE org_id = ? AND slug = ?
            `).get(orgId, slug);

            if (existing) {
                return res.status(409).json({ error: 'A team with this slug already exists' });
            }

            // Validate attach_scope_id if provided
            let parentScopeForTeam = null;
            if (attach_scope_id) {
                const scope = getScopeById(attach_scope_id);
                if (!scope || scope.org_id !== orgId) {
                    return res.status(400).json({ error: 'Invalid attach_scope_id' });
                }
                parentScopeForTeam = scope;
            } else {
                // Default to org scope
                parentScopeForTeam = getScopeForEntity('org', orgId);
            }

            // Validate parent_team_id if provided
            if (parent_team_id) {
                const parentTeam = prepare('SELECT id FROM teams WHERE id = ? AND org_id = ?').get(parent_team_id, orgId);
                if (!parentTeam) {
                    return res.status(400).json({ error: 'Invalid parent_team_id' });
                }
            }

            const db = getDb();
            const id = ulid();

            const settingsJson = JSON.stringify({
                created_by: userId,
                ...settings
            });

            db.transaction(() => {
                // Create team
                prepare(`
                    INSERT INTO teams (id, org_id, name, slug, description, parent_team_id, attach_scope_id, settings_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(id, orgId, name, slug, description || null, parent_team_id || null,
                       attach_scope_id || parentScopeForTeam?.id || null, settingsJson);

                // Create scope for team
                createScope(orgId, 'team', id, attach_scope_id || parentScopeForTeam?.id, name);

                // Add creator as team admin
                prepare(`
                    INSERT INTO team_memberships (id, team_id, user_id, role, status)
                    VALUES (?, ?, ?, 'admin', 'active')
                `).run(ulid(), id, userId);
            })();

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'team.create',
                targetType: 'team',
                targetId: id,
                metadata: { name, slug, attach_scope_id }
            });

            // ET-3 Phase B: emit lifecycle event for Matrix + webhooks.
            emitAndDispatch(getDb(), {
                orgId,
                teamId:  id,
                eventType: 'team.created',
                actorId: userId,
                metadata: { name, slug, attach_scope_id },
            });

            // M-ROOMS Phase 1: eager Matrix room provisioning for standalone
            // teams (auto-attached node teams share their node's room and are
            // skipped inside the provisioner). Non-fatal by contract.
            if (await isMatrixRoomsEnabled(orgId)) {
                provisionRoomForNode({ orgId, nodeType: 'team', nodeId: id, actorId: userId })
                    .catch((err) => console.error('[MatrixRooms] eager team-room provision failed (non-fatal):', err.message));
            }

            const team = prepare('SELECT * FROM teams WHERE id = ?').get(id);
            const scope = getScopeForEntity('team', id);

            res.status(201).json({
                team: { ...team, scope }
            });
        } catch (error) {
            console.error('Error creating team:', error);
            res.status(500).json({ error: 'Failed to create team' });
        }
    }
);

/**
 * PATCH /orgs/:orgId/teams/:teamId
 * Update a team
 */
router.patch('/orgs/:orgId/teams/:teamId',
    requireOrgMembership,
    async (req, res) => {
        try {
            const { orgId, teamId } = req.params;
            const { name, slug, description, attach_scope_id, settings } = req.body;
            const userId = req.user.id;

            // Check team exists
            const existing = prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(teamId, orgId);
            if (!existing) {
                return res.status(404).json({ error: 'Team not found' });
            }

            // Check permission (org admin or team admin)
            const isOrgAdmin = hasRoleLevel(req.orgMembership.role, OrgRoles.ADMIN);
            const teamMembership = prepare(`
                SELECT role FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active'
            `).get(teamId, userId);
            const isTeamAdmin = teamMembership?.role === 'admin';

            if (!isOrgAdmin && !isTeamAdmin) {
                return res.status(403).json({ error: 'Must be org admin or team admin to update team' });
            }

            // Check slug uniqueness if changing
            if (slug && slug !== existing.slug) {
                if (!/^[a-z0-9-]+$/.test(slug)) {
                    return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens' });
                }
                const slugExists = prepare(`
                    SELECT id FROM teams WHERE org_id = ? AND slug = ? AND id != ?
                `).get(orgId, slug, teamId);
                if (slugExists) {
                    return res.status(409).json({ error: 'A team with this slug already exists' });
                }
            }

            // Validate attach_scope_id if changing
            if (attach_scope_id !== undefined && attach_scope_id !== existing.attach_scope_id) {
                if (attach_scope_id) {
                    const scope = getScopeById(attach_scope_id);
                    if (!scope || scope.org_id !== orgId) {
                        return res.status(400).json({ error: 'Invalid attach_scope_id' });
                    }
                }
            }

            // Build update
            const updates = [];
            const values = [];

            if (name !== undefined) { updates.push('name = ?'); values.push(name); }
            if (slug !== undefined) { updates.push('slug = ?'); values.push(slug); }
            if (description !== undefined) { updates.push('description = ?'); values.push(description); }
            if (attach_scope_id !== undefined) { updates.push('attach_scope_id = ?'); values.push(attach_scope_id); }
            if (settings !== undefined) {
                const currentSettings = JSON.parse(existing.settings_json || '{}');
                updates.push('settings_json = ?');
                values.push(JSON.stringify({ ...currentSettings, ...settings }));
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            updates.push("updated_at = datetime('now')");
            values.push(teamId);

            prepare(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`).run(...values);

            // Update scope name cache if name changed
            if (name && name !== existing.name) {
                updateScopeNameCache('team', teamId, name);
            }

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'team.update',
                targetType: 'team',
                targetId: teamId,
                metadata: { updated_fields: Object.keys(req.body) }
            });

            const team = prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
            res.json({ team });
        } catch (error) {
            console.error('Error updating team:', error);
            res.status(500).json({ error: 'Failed to update team' });
        }
    }
);

/**
 * DELETE /orgs/:orgId/teams/:teamId
 * Delete a team
 */
/**
 * POST /orgs/:orgId/teams/:teamId/provision-room
 * Provision (or adopt) the governed Matrix room for a people team (#993).
 * `quox team provision-room` used to hit the tasks service, which only knows
 * agent-team definitions, so it 404'd for every id `quox team list` prints.
 */
router.post('/orgs/:orgId/teams/:teamId/provision-room',
    requireOrgMembership,
    requireOrgRole('admin'),
    async (req, res) => {
        try {
            const { orgId, teamId } = req.params;
            const team = prepare('SELECT id FROM teams WHERE id = ? AND org_id = ?').get(teamId, orgId);
            if (!team) {
                return res.status(404).json({ error: 'Team not found' });
            }
            const result = await provisionRoomForNode({ orgId, nodeType: 'team', nodeId: teamId, actorId: req.user.id });
            res.json({ status: result.status, reason: result.reason, room: result.row || null });
        } catch (error) {
            console.error('Error provisioning team room:', error);
            res.status(500).json({ error: 'Failed to provision team room' });
        }
    }
);

router.delete('/orgs/:orgId/teams/:teamId',
    requireOrgMembership,
    async (req, res) => {
        try {
            const { orgId, teamId } = req.params;
            const userId = req.user.id;

            // Check team exists
            const existing = prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(teamId, orgId);
            if (!existing) {
                return res.status(404).json({ error: 'Team not found' });
            }

            // Check permission (org admin or team admin with team.delete capability)
            const canDelete = resolveCap(req, Capabilities.TEAM_DELETE);
            if (!canDelete) {
                return res.status(403).json({ error: 'Insufficient permissions to delete teams' });
            }

            const db = getDb();

            db.transaction(() => {
                // Remove all team memberships
                prepare('DELETE FROM team_memberships WHERE team_id = ?').run(teamId);

                // Delete the team
                prepare('DELETE FROM teams WHERE id = ?').run(teamId);

                // Delete scope
                const scope = getScopeForEntity('team', teamId);
                if (scope) {
                    deleteScope(scope.id);
                }
            })();

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: 'team.delete',
                targetType: 'team',
                targetId: teamId,
                metadata: { name: existing.name }
            });

            // M-ROOMS teardown: retire the team's Matrix room ledger row.
            if (await isMatrixRoomsEnabled(orgId)) {
                deprovisionRoomForNode({ orgId, nodeType: 'team', nodeId: teamId, actorId: userId })
                    .catch((err) => console.warn('[MatrixRooms] eager team-room deprovision failed (non-fatal):', err.message));
            }

            // ET-3 Phase B: emit lifecycle event for Matrix + webhooks.
            emitAndDispatch(getDb(), {
                orgId,
                teamId,
                eventType: 'team.archived',
                actorId: userId,
                metadata: { name: existing.name },
            });

            res.json({ success: true, message: 'Team deleted' });
        } catch (error) {
            console.error('Error deleting team:', error);
            if (error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                return res.status(409).json({ error: 'This team still has assistants, tools or other items homed in it. Move or delete them first.' });
            }
            res.status(500).json({ error: 'Failed to delete team' });
        }
    }
);

// ============================================================================
// Team Membership Management
// ============================================================================

/**
 * POST /orgs/:orgId/teams/:teamId/members
 * Add a member to a team
 */
router.post('/orgs/:orgId/teams/:teamId/members',
    requireOrgMembership,
    humanGrantorOnly,
    async (req, res) => {
        try {
            const { orgId, teamId } = req.params;
            const { user_id, role = 'member' } = req.body;
            const actorId = req.user.id;

            // Validate role
            if (!['admin', 'member', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Invalid role. Must be admin, member, or viewer' });
            }

            // Check team exists
            const team = prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(teamId, orgId);
            if (!team) {
                return res.status(404).json({ error: 'Team not found' });
            }

            // Check permission
            const canManage = resolveCap(req, Capabilities.TEAM_MANAGE);
            const actorTeamMembership = prepare(`
                SELECT role FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active'
            `).get(teamId, actorId);
            const isTeamAdmin = actorTeamMembership?.role === 'admin';

            if (!canManage && !isTeamAdmin) {
                return res.status(403).json({ error: 'Must be org admin or team admin to add members' });
            }

            // Check user exists and is org member
            const userOrgMembership = prepare(`
                SELECT * FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = 'active'
            `).get(orgId, user_id);

            if (!userOrgMembership) {
                return res.status(400).json({ error: 'User is not a member of this organization' });
            }

            // Check if already a member
            const existingMembership = prepare(`
                SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ?
            `).get(teamId, user_id);

            if (existingMembership) {
                if (existingMembership.status === 'active') {
                    return res.status(409).json({ error: 'User is already a team member' });
                }
                // Reactivate
                prepare(`
                    UPDATE team_memberships SET status = 'active', role = ?, updated_at = datetime('now')
                    WHERE id = ?
                `).run(role, existingMembership.id);
            } else {
                prepare(`
                    INSERT INTO team_memberships (id, team_id, user_id, role, status)
                    VALUES (?, ?, ?, ?, 'active')
                `).run(ulid(), teamId, user_id, role);
            }

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId,
                action: 'team.member.add',
                targetType: 'user',
                targetId: user_id,
                scopeId: teamId,
                metadata: { team_id: teamId, role }
            });

            // ET-3 Phase B: emit joined (direct add is treated as joined).
            emitAndDispatch(getDb(), {
                orgId,
                teamId,
                eventType:     'team.member.joined',
                actorId,
                subjectUserId: user_id,
                metadata:      { role },
            });

            res.status(201).json({ success: true, message: 'Member added to team' });
        } catch (error) {
            console.error('Error adding team member:', error);
            res.status(500).json({ error: 'Failed to add team member' });
        }
    }
);

/**
 * PATCH /orgs/:orgId/teams/:teamId/members/:userId
 * Update a team member's role
 */
router.patch('/orgs/:orgId/teams/:teamId/members/:userId',
    requireOrgMembership,
    humanGrantorOnly,
    async (req, res) => {
        try {
            const { orgId, teamId, userId: targetUserId } = req.params;
            const { role } = req.body;
            const actorId = req.user.id;

            // Validate role
            if (!['admin', 'member', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Invalid role. Must be admin, member, or viewer' });
            }

            // Check permission
            const canManage = resolveCap(req, Capabilities.TEAM_MANAGE);
            const actorTeamMembership = prepare(`
                SELECT role FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active'
            `).get(teamId, actorId);
            const isTeamAdmin = actorTeamMembership?.role === 'admin';

            if (!canManage && !isTeamAdmin) {
                return res.status(403).json({ error: 'Must be org admin or team admin to update members' });
            }

            // Check membership exists
            const membership = prepare(`
                SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active'
            `).get(teamId, targetUserId);

            if (!membership) {
                return res.status(404).json({ error: 'Team membership not found' });
            }

            // Update
            prepare(`
                UPDATE team_memberships SET role = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(role, membership.id);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId,
                action: 'team.member.update',
                targetType: 'user',
                targetId: targetUserId,
                scopeId: teamId,
                metadata: { team_id: teamId, old_role: membership.role, new_role: role }
            });

            // ET-3 Phase B: emit role change for Matrix + webhooks.
            emitAndDispatch(getDb(), {
                orgId,
                teamId,
                eventType:     'team.member.role_changed',
                actorId,
                subjectUserId: targetUserId,
                metadata:      { old_role: membership.role, new_role: role },
            });

            res.json({ success: true, message: 'Member role updated' });
        } catch (error) {
            console.error('Error updating team member:', error);
            res.status(500).json({ error: 'Failed to update team member' });
        }
    }
);

/**
 * DELETE /orgs/:orgId/teams/:teamId/members/:userId
 * Remove a member from a team
 */
router.delete('/orgs/:orgId/teams/:teamId/members/:userId',
    requireOrgMembership,
    async (req, res) => {
        try {
            const { orgId, teamId, userId: targetUserId } = req.params;
            const actorId = req.user.id;

            // Check permission
            const canManage = resolveCap(req, Capabilities.TEAM_MANAGE);
            const actorTeamMembership = prepare(`
                SELECT role FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active'
            `).get(teamId, actorId);
            const isTeamAdmin = actorTeamMembership?.role === 'admin';

            // Users can remove themselves
            const isSelf = actorId === targetUserId;

            if (!canManage && !isTeamAdmin && !isSelf) {
                return res.status(403).json({ error: 'Must be org admin, team admin, or removing yourself' });
            }

            // Check membership exists
            const membership = prepare(`
                SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active'
            `).get(teamId, targetUserId);

            if (!membership) {
                return res.status(404).json({ error: 'Team membership not found' });
            }

            // Remove
            prepare(`
                UPDATE team_memberships SET status = 'removed', updated_at = datetime('now')
                WHERE id = ?
            `).run(membership.id);

            // Audit log
            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId,
                action: 'team.member.remove',
                targetType: 'user',
                targetId: targetUserId,
                scopeId: teamId,
                metadata: { team_id: teamId }
            });

            // ET-3 Phase B: emit left for Matrix + webhooks.
            emitAndDispatch(getDb(), {
                orgId,
                teamId,
                eventType:     'team.member.left',
                actorId,
                subjectUserId: targetUserId,
                metadata:      { self_removed: isSelf },
            });

            res.json({ success: true, message: 'Member removed from team' });
        } catch (error) {
            console.error('Error removing team member:', error);
            res.status(500).json({ error: 'Failed to remove team member' });
        }
    }
);

/**
 * GET /orgs/:orgId/my-teams
 * Get teams the current user is a member of
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/my-teams', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;

        const teams = prepare(`
            SELECT t.*, tm.role as my_role, s.path as scope_path
            FROM teams t
            JOIN team_memberships tm ON t.id = tm.team_id
            LEFT JOIN scopes s ON t.attach_scope_id = s.id
            WHERE t.org_id = ? AND tm.user_id = ? AND tm.status = 'active'
            ORDER BY t.name
        `).all(orgId, userId);

        res.json({ teams });
    } catch (error) {
        console.error('Error listing my teams:', error);
        res.status(500).json({ error: 'Failed to list teams' });
    }
});

export default router;
