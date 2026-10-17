/**
 * Organization routes for Quox Auth Service
 *
 * POST /orgs - Create new organization
 * GET /orgs - List user's organizations
 * GET /orgs/:orgId - Get organization details
 * PATCH /orgs/:orgId - Update organization
 * DELETE /orgs/:orgId - Delete organization
 * GET /orgs/:orgId/members - List members
 * POST /orgs/:orgId/members - Add member (invite)
 * PATCH /orgs/:orgId/members/:userId - Update member role
 * DELETE /orgs/:orgId/members/:userId - Remove member
 */

import { Router } from 'express';
import contentDisposition from 'content-disposition';
import { generateId, generateToken } from '../utils/crypto.js';
import { queries, getDb, prepare } from '../db/index.js';
import { logOrgEvent, logMembershipEvent, AuditActions } from '../utils/audit.js';
import { createScope, getScopeForEntity } from '../utils/scopes.js';
import { resolveAppBaseUrl } from '../lib/instanceConfigOverrides.js';
// GTM-A1/B3: the org-creation imports (ulid, scope assistant templates,
// first-party and eager room provisioning, assistant persistence) moved with
// that code into lib/orgProvisioning.js. What remains here is deprovisioning,
// which is still this router's job.
import { deprovisionRoomForNode, isMatrixRoomsEnabled } from '../lib/matrixProvisioner.js';
import {
    createOrgWithDefaults,
    resolveAvailableSlug,
    runPostOrgCreationProvisioning,
} from '../lib/orgProvisioning.js';
// Retained from main (LICENSE-AUDIT-3): org DEPROVISIONING releases licence slots.
import { releaseAllOrgSlots, clearEntitlementsCache } from '../lib/entitlements.js';
import { authenticate, requireOrg } from '../middleware/authenticate.js';
import { requireCapability, requireAdmin, requireOrgScope } from '../middleware/authorize.js';
import { Capabilities, OrgRoles, hasRoleLevel } from '../utils/policy.js';
import { orgCreationLimiter, inviteLimiter } from '../middleware/rateLimit.js';
import {
    buildAuditQuery,
    renderAuditCsv,
    renderAuditJson,
    renderAuditBundle,
} from '../utils/auditExport.js';
import {
    canonicalizeAuditPayload,
    signAuditExport,
    loadOrCreateAuditSigner,
    AUDIT_EXPORT_TOOL_VERSION,
} from '../utils/auditSigning.js';
import {
    getPlanCaps,
    getPlanFeatures,
    getPlanRank,
    resolveEffectivePlan,
} from '../utils/planTiers.js';
import { sendEmail } from '../utils/emailService.js';
import { emitAndDispatch } from '../utils/teamEventEmitter.js';
import { humanGrantorOnly } from '../utils/principal.js';

const router = Router();

// ============================================================================
// Helper Functions
// ============================================================================

function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

function validateOrgName(name) {
    if (!name || name.length < 2) {
        return { valid: false, message: 'Organization name must be at least 2 characters' };
    }
    if (name.length > 100) {
        return { valid: false, message: 'Organization name must be less than 100 characters' };
    }
    return { valid: true };
}

async function sendInviteEmail(email, inviterName, orgName, token) {
    const base  = resolveAppBaseUrl();
    const link  = `${base}/invite/${encodeURIComponent(token)}`;
    const who   = inviterName || 'Someone';
    const plain = [
        `Hi,`,
        ``,
        `${who} has invited you to join ${orgName} on Quox.`,
        ``,
        `Accept the invitation:`,
        link,
        ``,
        `If you weren't expecting this, you can ignore the email.`,
    ].join('\n');
    const html = `
        <p>Hi,</p>
        <p><strong>${who}</strong> has invited you to join <strong>${orgName}</strong> on Quox.</p>
        <p><a href="${link}" style="background:#38bdf8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Accept invitation</a></p>
        <p>Or paste this link into your browser:<br/><code>${link}</code></p>
        <p style="color:#888;font-size:12px">If you weren't expecting this, you can ignore the email.</p>
    `;
    try {
        const result = await sendEmail({
            to:      email,
            subject: `Invitation to join ${orgName} on Quox`,
            text:    plain,
            html,
        });
        if (!result.delivered) {
            console.log(`[invite] email not delivered (${result.reason}) — to=${email} org=${orgName}`);
        }
        return result.delivered;
    } catch (err) {
        console.error('[invite] email delivery failed:', err.message);
        return false;
    }
}

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /orgs
 * Create new organization
 */
router.post('/', authenticate(), orgCreationLimiter, async (req, res) => {
    try {
        const { name, slug: customSlug, description } = req.body;

        // Validate name
        const nameValidation = validateOrgName(name);
        if (!nameValidation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: nameValidation.message
            });
        }

        // Generate or validate slug
        const slug = resolveAvailableSlug(customSlug || generateSlug(name));

        // GTM-A1/B3: org creation now lives in lib/orgProvisioning.js so that
        // UI signup provisions a workspace through this exact code instead of
        // a second, drifting copy. Behaviour here is unchanged.
        const { orgId } = createOrgWithDefaults({
            name,
            slug,
            description,
            userId: req.user.id
        });

        // Log creation
        logOrgEvent(AuditActions.ORG_CREATE, {
            type: 'user',
            id: req.user.id
        }, orgId, req, { name, slug });

        // Post-commit provisioning (first-party plugins, Matrix rooms). Both
        // are non-fatal by contract and each has its own backstop reconciler.
        await runPostOrgCreationProvisioning(getDb(), { orgId, userId: req.user.id });

        res.status(201).json({
            success: true,
            organization: {
                id: orgId,
                name,
                slug,
                description: description || null,
                plan: 'free',
                role: OrgRoles.OWNER
            }
        });

    } catch (err) {
        console.error('Create org error:', err);
        res.status(500).json({
            error: 'create_failed',
            message: 'Failed to create organization'
        });
    }
});

/**
 * GET /orgs
 * List user's organizations
 */
router.get('/', authenticate(), async (req, res) => {
    try {
        const db = getDb();
        const orgs = queries.getUserOrgs(req.user.id);

        res.json({
            organizations: orgs.map(o => {
                // Fetch counts inline — cheap scalar queries
                const memberCount = prepare(
                    'SELECT COUNT(*) as count FROM org_memberships WHERE org_id = ? AND status = ?'
                ).get(o.id, 'active');
                const teamCount = prepare(
                    'SELECT COUNT(*) as count FROM teams WHERE org_id = ?'
                ).get(o.id);
                const divisionCount = prepare(
                    'SELECT COUNT(*) as count FROM divisions WHERE org_id = ? AND deleted_at IS NULL'
                ).get(o.id);

                return {
                    id: o.id,
                    name: o.name,
                    slug: o.slug,
                    description: o.description || null,
                    plan: o.plan,
                    logo_url: o.logo_url || null,
                    role: o.role,
                    membership_status: o.membership_status,
                    member_count: memberCount?.count || 0,
                    team_count: teamCount?.count || 0,
                    division_count: divisionCount?.count || 0
                };
            })
        });

    } catch (err) {
        console.error('List orgs error:', err);
        res.status(500).json({
            error: 'fetch_failed',
            message: 'Failed to fetch organizations'
        });
    }
});

/**
 * GET /orgs/:orgId
 * Get organization details
 */
router.get('/:orgId', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        // Check membership
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || membership.status !== 'active') {
            return res.status(403).json({
                error: 'not_member',
                message: 'You are not a member of this organization'
            });
        }

        const org = queries.getOrgById(orgId);
        if (!org) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Organization not found'
            });
        }

        // Get member count
        const db = getDb();
        const memberCount = db.prepare(`
            SELECT COUNT(*) as count FROM org_memberships
            WHERE org_id = ? AND status = 'active'
        `).get(orgId);

        res.json({
            organization: {
                id: org.id,
                name: org.name,
                slug: org.slug,
                description: org.description || null,
                plan: org.plan,
                logo_url: org.logo_url,
                mfa_policy: org.mfa_policy,
                created_at: org.created_at,
                member_count: memberCount.count
            },
            membership: {
                role: membership.role,
                status: membership.status,
                joined_at: membership.accepted_at || membership.created_at
            }
        });

    } catch (err) {
        console.error('Get org error:', err);
        res.status(500).json({
            error: 'fetch_failed',
            message: 'Failed to fetch organization'
        });
    }
});

/**
 * PATCH /orgs/:orgId
 * Update organization
 */
router.patch('/:orgId', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { name, description, logo_url, mfa_policy, settings } = req.body;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required'
            });
        }

        const org = queries.getOrgById(orgId);
        if (!org) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Organization not found'
            });
        }

        // Build update
        const updates = {};
        if (name) {
            const nameValidation = validateOrgName(name);
            if (!nameValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: nameValidation.message
                });
            }
            updates.name = name;
        }
        if (description !== undefined) updates.description = description;
        if (logo_url !== undefined) updates.logo_url = logo_url;
        if (mfa_policy) {
            if (!['optional', 'required_admins', 'required_all'].includes(mfa_policy)) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'Invalid MFA policy'
                });
            }
            updates.mfa_policy = mfa_policy;
        }
        if (settings) {
            updates.settings_json = JSON.stringify(settings);
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                error: 'no_updates',
                message: 'No valid updates provided'
            });
        }

        // Update org
        const updateSql = Object.keys(updates)
            .map(k => `${k} = ?`)
            .join(', ');
        const db = getDb();
        db.prepare(`
            UPDATE orgs SET ${updateSql}, updated_at = datetime('now')
            WHERE id = ?
        `).run(...Object.values(updates), orgId);

        // Log update
        logOrgEvent(AuditActions.ORG_UPDATE, {
            type: 'user',
            id: req.user.id
        }, orgId, req, { updates: Object.keys(updates) });

        // Return updated org
        const updatedOrg = queries.getOrgById(orgId);

        res.json({
            success: true,
            organization: {
                id: updatedOrg.id,
                name: updatedOrg.name,
                slug: updatedOrg.slug,
                description: updatedOrg.description || null,
                plan: updatedOrg.plan,
                logo_url: updatedOrg.logo_url,
                mfa_policy: updatedOrg.mfa_policy
            }
        });

    } catch (err) {
        console.error('Update org error:', err);
        res.status(500).json({
            error: 'update_failed',
            message: 'Failed to update organization'
        });
    }
});

/**
 * DELETE /orgs/:orgId
 * Delete organization (owner only)
 */
router.delete('/:orgId', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        // Check ownership (only owner can delete)
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || membership.role !== OrgRoles.OWNER) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Only the organization owner can delete it'
            });
        }

        const org = queries.getOrgById(orgId);
        if (!org) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Organization not found'
            });
        }

        // Soft delete the org
        const db = getDb();
        db.prepare(`
            UPDATE orgs SET deleted_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(orgId);

        // Free every licence slot the org held (licensing.orgs.* bands are
        // otherwise append-only and a dead org's seats block real orgs
        // forever — 2026-09-18 audit). Non-fatal: deletion must not fail on
        // licensing bookkeeping.
        try {
            const { released } = releaseAllOrgSlots(db, orgId);
            if (released > 0) clearEntitlementsCache();
        } catch (slotErr) {
            console.warn('[Orgs] releaseAllOrgSlots on delete failed (non-fatal):', slotErr.message);
        }

        // Log deletion
        logOrgEvent(AuditActions.ORG_DELETE, {
            type: 'user',
            id: req.user.id
        }, orgId, req, { name: org.name });

        // M-ROOMS teardown: retire the org's Matrix room ledger row, non-fatal.
        if (await isMatrixRoomsEnabled(orgId)) {
            deprovisionRoomForNode({ orgId, nodeType: 'org', nodeId: orgId, actorId: req.user.id })
                .catch((err) => console.warn('[MatrixRooms] eager org-room deprovision failed (non-fatal):', err.message));
        }

        res.json({
            success: true,
            message: 'Organization deleted'
        });

    } catch (err) {
        console.error('Delete org error:', err);
        res.status(500).json({
            error: 'delete_failed',
            message: 'Failed to delete organization'
        });
    }
});

/**
 * GET /orgs/:orgId/members
 * List organization members
 */
router.get('/:orgId/members', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        // Check membership
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || membership.status !== 'active') {
            return res.status(403).json({
                error: 'not_member',
                message: 'You are not a member of this organization'
            });
        }

        const members = queries.getOrgMembers(orgId);

        // Get pending invites if admin
        let invites = [];
        if (hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            const db = getDb();
            invites = db.prepare(`
                SELECT email, role, status, created_at, expires_at
                FROM invites
                WHERE org_id = ? AND status = 'pending'
                ORDER BY created_at DESC
            `).all(orgId);
        }

        res.json({
            members: members.map(m => ({
                id: m.id,
                email: m.primary_email,
                display_name: m.display_name,
                role: m.role,
                status: m.status,
                joined_at: m.joined_at,
                custom_role_id: m.custom_role_id || null,
                custom_role_name: m.custom_role_name || null,
            })),
            invites: invites.map(i => ({
                email: i.email,
                role: i.role,
                status: i.status,
                created_at: i.created_at,
                expires_at: i.expires_at
            }))
        });

    } catch (err) {
        console.error('List members error:', err);
        res.status(500).json({
            error: 'fetch_failed',
            message: 'Failed to fetch members'
        });
    }
});

/**
 * POST /orgs/:orgId/members
 * Invite new member
 */
router.post('/:orgId/members', authenticate(), humanGrantorOnly, inviteLimiter, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { email, role = OrgRoles.VIEWER } = req.body;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required to invite members'
            });
        }

        // Validate role
        if (!Object.values(OrgRoles).includes(role)) {
            return res.status(400).json({
                error: 'invalid_role',
                message: 'Invalid role specified'
            });
        }

        // Can't invite as owner
        if (role === OrgRoles.OWNER) {
            return res.status(400).json({
                error: 'invalid_role',
                message: 'Cannot invite as owner'
            });
        }

        // Check if user is already a member
        const existingUser = queries.getUserByEmail(email.toLowerCase());
        if (existingUser) {
            const existingMembership = queries.getOrgMembership(orgId, existingUser.id);
            if (existingMembership && existingMembership.status === 'active') {
                return res.status(409).json({
                    error: 'already_member',
                    message: 'User is already a member'
                });
            }
        }

        // Check for existing pending invite
        const db = getDb();
        const existingInvite = db.prepare(`
            SELECT * FROM invites
            WHERE org_id = ? AND email = ? AND status = 'pending'
        `).get(orgId, email.toLowerCase());

        if (existingInvite) {
            return res.status(409).json({
                error: 'invite_exists',
                message: 'An invite for this email is already pending'
            });
        }

        const org = queries.getOrgById(orgId);

        // Create invite
        const inviteId = generateId();
        const token = generateToken(32);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

        queries.createInvite({
            id: inviteId,
            org_id: orgId,
            team_id: null,
            email: email.toLowerCase(),
            role,
            invited_by: req.user.id,
            token,
            expires_at: expiresAt
        });

        // Send invite email
        const inviter = queries.getUserById(req.user.id);
        await sendInviteEmail(email, inviter.display_name, org.name, token);

        // Log invite
        logMembershipEvent(AuditActions.ORG_MEMBER_INVITE, {
            type: 'user',
            id: req.user.id
        }, orgId, email, req, { role });

        // ET-ENFORCE C — fire team.member.invited so Matrix + webhook
        // subscribers see invite lifecycle for single invites (bulk-invite
        // already emits this). Fire-and-forget.
        emitAndDispatch(db, {
            orgId,
            teamId:    null,
            eventType: 'team.member.invited',
            actorId:   req.user.id,
            metadata:  { email: email.toLowerCase(), role, invite_id: inviteId, via: 'org_invite' },
        }).catch(err => console.error('[org-invite] dispatch failed:', err.message));

        res.status(201).json({
            success: true,
            invite: {
                id: inviteId,
                email: email.toLowerCase(),
                role,
                expires_at: expiresAt
            }
        });

    } catch (err) {
        console.error('Invite member error:', err);
        res.status(500).json({
            error: 'invite_failed',
            message: 'Failed to send invite'
        });
    }
});

/**
 * POST /orgs/:orgId/auditor-invites
 *
 * AUD-WS-1: Invite an external auditor with time-bounded access.
 * Creates an invite with role='auditor' and sets membership_expires_at
 * to now + duration_days. When accepted, the resulting membership inherits
 * that expiry and the requireOrgMembership middleware rejects after.
 *
 * Body: { email, duration_days (30|60|90, default 30) }
 * Response: { invite, expires_at }
 */
router.post('/:orgId/auditor-invites', authenticate(), inviteLimiter, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { email, duration_days = 30 } = req.body;

        // Admin or owner only
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required to invite auditors'
            });
        }

        // Validate duration
        const allowedDurations = [30, 60, 90];
        if (!allowedDurations.includes(Number(duration_days))) {
            return res.status(400).json({
                error: 'invalid_duration',
                message: `duration_days must be one of: ${allowedDurations.join(', ')}`
            });
        }

        // Email required
        if (!email || typeof email !== 'string') {
            return res.status(400).json({
                error: 'email_required',
                message: 'email is required'
            });
        }

        // Check existing pending invite
        const db = getDb();
        const existingInvite = db.prepare(`
            SELECT * FROM invites
            WHERE org_id = ? AND email = ? AND status = 'pending'
        `).get(orgId, email.toLowerCase());

        if (existingInvite) {
            return res.status(409).json({
                error: 'invite_exists',
                message: 'An invite for this email is already pending'
            });
        }

        const org = queries.getOrgById(orgId);
        const inviteId = generateId();
        const token = generateToken(32);

        // Invite link expires in 7 days (user has to click it within that window)
        const linkExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        // Membership expires in duration_days from now
        const membershipExpiresAt = new Date(Date.now() + Number(duration_days) * 24 * 60 * 60 * 1000).toISOString();

        // Insert invite directly (the generic createInvite helper doesn't know
        // about membership_expires_at yet)
        db.prepare(`
            INSERT INTO invites (id, org_id, team_id, email, role, invited_by, token, expires_at, membership_expires_at)
            VALUES (?, ?, ?, ?, 'auditor', ?, ?, ?, ?)
        `).run(inviteId, orgId, null, email.toLowerCase(), req.user.id, token, linkExpiresAt, membershipExpiresAt);

        // Reuse the existing invite email (it communicates the role + org)
        const inviter = queries.getUserById(req.user.id);
        try {
            await sendInviteEmail(email, inviter.display_name, org.name, token);
        } catch (emailErr) {
            console.warn('[auditor-invite] email send failed (non-fatal):', emailErr.message);
        }

        logMembershipEvent(AuditActions.ORG_MEMBER_INVITE, {
            orgId,
            actorId: req.user.id,
            targetEmail: email,
            role: 'auditor',
            metadata: { duration_days, membership_expires_at: membershipExpiresAt },
        });

        // ET-ENFORCE C — fire team.member.invited for auditor invites too
        // so external subscribers see every invite-creation path.
        emitAndDispatch(db, {
            orgId,
            teamId:    null,
            eventType: 'team.member.invited',
            actorId:   req.user.id,
            metadata:  {
                email: email.toLowerCase(),
                role: 'auditor',
                invite_id: inviteId,
                via: 'auditor_invite',
                membership_expires_at: membershipExpiresAt,
            },
        }).catch(err => console.error('[auditor-invite] dispatch failed:', err.message));

        res.status(201).json({
            success: true,
            data: {
                invite_id: inviteId,
                email,
                role: 'auditor',
                duration_days: Number(duration_days),
                link_expires_at: linkExpiresAt,
                membership_expires_at: membershipExpiresAt,
                accept_url: `${req.protocol}://${req.get('host')}/invites/${token}`
            }
        });
    } catch (err) {
        console.error('auditor invite error:', err);
        res.status(500).json({
            error: 'invite_failed',
            message: 'Failed to send auditor invite'
        });
    }
});

/**
 * PATCH /orgs/:orgId/members/:userId
 * Update member role
 */
router.patch('/:orgId/members/:userId', authenticate(), humanGrantorOnly, async (req, res) => {
    try {
        const { orgId, userId } = req.params;
        const { role } = req.body;

        // Check admin permissions
        const myMembership = queries.getOrgMembership(orgId, req.user.id);
        if (!myMembership || !hasRoleLevel(myMembership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required'
            });
        }

        // Can't change your own role
        if (userId === req.user.id) {
            return res.status(400).json({
                error: 'self_modification',
                message: 'Cannot change your own role'
            });
        }

        // Get target membership
        const targetMembership = queries.getOrgMembership(orgId, userId);
        if (!targetMembership) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Member not found'
            });
        }

        // Can't change owner role (transfer ownership instead)
        if (targetMembership.role === OrgRoles.OWNER) {
            return res.status(400).json({
                error: 'cannot_demote_owner',
                message: 'Cannot change owner role. Transfer ownership instead.'
            });
        }

        // Only owner can promote to admin
        if (role === OrgRoles.ADMIN && myMembership.role !== OrgRoles.OWNER) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Only owner can promote to admin'
            });
        }

        // Validate role
        if (!Object.values(OrgRoles).includes(role) || role === OrgRoles.OWNER) {
            return res.status(400).json({
                error: 'invalid_role',
                message: 'Invalid role'
            });
        }

        // Update role
        queries.updateOrgMembership(targetMembership.id, { role });

        // Log role change
        logMembershipEvent(AuditActions.ORG_MEMBER_ROLE_CHANGE, {
            type: 'user',
            id: req.user.id
        }, orgId, userId, req, {
            old_role: targetMembership.role,
            new_role: role
        });

        res.json({
            success: true,
            message: 'Member role updated'
        });

    } catch (err) {
        console.error('Update member error:', err);
        res.status(500).json({
            error: 'update_failed',
            message: 'Failed to update member'
        });
    }
});

/**
 * DELETE /orgs/:orgId/members/:userId
 * Remove member
 */
router.delete('/:orgId/members/:userId', authenticate(), async (req, res) => {
    try {
        const { orgId, userId } = req.params;

        const myMembership = queries.getOrgMembership(orgId, req.user.id);

        // Self-leave
        if (userId === req.user.id) {
            if (myMembership.role === OrgRoles.OWNER) {
                return res.status(400).json({
                    error: 'owner_cannot_leave',
                    message: 'Owner cannot leave. Transfer ownership first.'
                });
            }

            queries.updateOrgMembership(myMembership.id, { status: 'left' });

            logMembershipEvent(AuditActions.ORG_MEMBER_LEAVE, {
                type: 'user',
                id: req.user.id
            }, orgId, userId, req);

            return res.json({
                success: true,
                message: 'You have left the organization'
            });
        }

        // Remove another member - requires admin
        if (!hasRoleLevel(myMembership?.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required'
            });
        }

        const targetMembership = queries.getOrgMembership(orgId, userId);
        if (!targetMembership) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Member not found'
            });
        }

        // Can't remove owner
        if (targetMembership.role === OrgRoles.OWNER) {
            return res.status(400).json({
                error: 'cannot_remove_owner',
                message: 'Cannot remove organization owner'
            });
        }

        // Update status to removed
        queries.updateOrgMembership(targetMembership.id, { status: 'removed' });

        // Log removal
        logMembershipEvent(AuditActions.ORG_MEMBER_REMOVE, {
            type: 'user',
            id: req.user.id
        }, orgId, userId, req);

        res.json({
            success: true,
            message: 'Member removed'
        });

    } catch (err) {
        console.error('Remove member error:', err);
        res.status(500).json({
            error: 'remove_failed',
            message: 'Failed to remove member'
        });
    }
});

// ============================================================================
// Division Routes
// ============================================================================

/**
 * GET /orgs/:orgId/divisions
 * List organization divisions
 */
router.get('/:orgId/divisions', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        // Check membership
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || membership.status !== 'active') {
            return res.status(403).json({
                error: 'not_member',
                message: 'You are not a member of this organization'
            });
        }

        const divisions = queries.getDivisionsByOrg(orgId);

        res.json({
            divisions: divisions.map(d => ({
                id: d.id,
                name: d.name,
                slug: d.slug,
                description: d.description,
                member_count: d.member_count || 0,
                created_at: d.created_at
            }))
        });

    } catch (err) {
        console.error('List divisions error:', err);
        res.status(500).json({
            error: 'fetch_failed',
            message: 'Failed to fetch divisions'
        });
    }
});

/**
 * POST /orgs/:orgId/divisions
 * Create new division
 */
router.post('/:orgId/divisions', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { name, description } = req.body;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required to create divisions'
            });
        }

        // Validate name
        if (!name || name.length < 2) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Division name must be at least 2 characters'
            });
        }

        // Generate slug
        let slug = generateSlug(name);

        // Check slug uniqueness within org
        const existing = queries.getDivisionBySlug(orgId, slug);
        if (existing) {
            slug = `${slug}-${generateId().slice(-6).toLowerCase()}`;
        }

        // Create division
        const divisionId = generateId();
        queries.createDivision({
            id: divisionId,
            org_id: orgId,
            name,
            slug,
            description: description || null,
            created_by: req.user.id
        });

        // Materialise the division in the canonical scopes tree (org creation
        // does this for org+team; divisions were skipped, which left them
        // invisible to every scope consumer, found via QuoxPlan P5. Divisions
        // created before this fix have no scope row.)
        try {
            const orgScope = getScopeForEntity('org', orgId);
            if (orgScope) {
                createScope(orgId, 'division', divisionId, orgScope.id, name);
            } else {
                console.warn(`[divisions] org scope missing for ${orgId}; division ${divisionId} has no scope row`);
            }
        } catch (scopeErr) {
            console.error('Create division scope error:', scopeErr);
        }

        // Log creation
        logOrgEvent(AuditActions.ORG_UPDATE, {
            type: 'user',
            id: req.user.id
        }, orgId, req, { action: 'create_division', division_id: divisionId, name });

        res.status(201).json({
            success: true,
            division: {
                id: divisionId,
                name,
                slug,
                description: description || null,
                member_count: 0
            }
        });

    } catch (err) {
        console.error('Create division error:', err);
        res.status(500).json({
            error: 'create_failed',
            message: 'Failed to create division'
        });
    }
});

/**
 * PATCH /orgs/:orgId/divisions/:divisionId
 * Update division
 */
router.patch('/:orgId/divisions/:divisionId', authenticate(), async (req, res) => {
    try {
        const { orgId, divisionId } = req.params;
        const { name, description } = req.body;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required'
            });
        }

        const division = queries.getDivisionById(divisionId);
        if (!division || division.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Division not found'
            });
        }

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                error: 'no_updates',
                message: 'No valid updates provided'
            });
        }

        queries.updateDivision(divisionId, updates);

        res.json({
            success: true,
            division: {
                id: divisionId,
                ...division,
                ...updates
            }
        });

    } catch (err) {
        console.error('Update division error:', err);
        res.status(500).json({
            error: 'update_failed',
            message: 'Failed to update division'
        });
    }
});

/**
 * DELETE /orgs/:orgId/divisions/:divisionId
 * Delete division
 */
router.delete('/:orgId/divisions/:divisionId', authenticate(), async (req, res) => {
    try {
        const { orgId, divisionId } = req.params;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required'
            });
        }

        const division = queries.getDivisionById(divisionId);
        if (!division || division.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Division not found'
            });
        }

        queries.deleteDivision(divisionId);

        // Log deletion
        logOrgEvent(AuditActions.ORG_UPDATE, {
            type: 'user',
            id: req.user.id
        }, orgId, req, { action: 'delete_division', division_id: divisionId, name: division.name });

        res.json({
            success: true,
            message: 'Division deleted'
        });

    } catch (err) {
        console.error('Delete division error:', err);
        res.status(500).json({
            error: 'delete_failed',
            message: 'Failed to delete division'
        });
    }
});

// ============================================================================
// AUDIT LOG VIEWER (Enterprise)
// ============================================================================

/**
 * GET /:orgId/audit
 * View audit logs for an organization
 *
 * Query params:
 * - limit: number of events to return (default 100, max 500)
 * - offset: pagination offset
 * - action: filter by action type (e.g., 'org.member.invite')
 * - actor_id: filter by actor user ID
 * - target_type: filter by target type (e.g., 'user', 'agent', 'team')
 * - target_id: filter by target ID
 * - from_date: filter from date (ISO 8601)
 * - to_date: filter to date (ISO 8601)
 * - status: filter by status ('success', 'failure', 'denied')
 */
router.get('/:orgId/audit',
    authenticate(),
    requireOrg(),
    requireOrgScope(), // FND_01M50Y4CMYSWF93DR97MSWF93D: the URL org must be the caller's org
    requireCapability(Capabilities.ORG_VIEW_AUDIT),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const {
                limit = 100,
                offset = 0,
                action,
                actor_id,
                target_type,
                target_id,
                from_date,
                to_date,
                status
            } = req.query;

            // Validate and cap limit
            const parsedLimit = Math.min(parseInt(limit) || 100, 500);
            const parsedOffset = parseInt(offset) || 0;

            // Build query
            // #1106: qualified with the audit_events alias; the events query joins users (created_at, status exist there too).
            const conditions = ['ae.org_id = ?'];
            const params = [orgId];

            if (action) {
                conditions.push('ae.action = ?');
                params.push(action);
            }

            if (actor_id) {
                conditions.push('ae.actor_id = ?');
                params.push(actor_id);
            }

            if (target_type) {
                conditions.push('ae.target_type = ?');
                params.push(target_type);
            }

            if (target_id) {
                conditions.push('ae.target_id = ?');
                params.push(target_id);
            }

            if (from_date) {
                conditions.push('ae.created_at >= ?');
                params.push(from_date);
            }

            if (to_date) {
                conditions.push('ae.created_at <= ?');
                params.push(to_date);
            }

            if (status) {
                conditions.push('ae.status = ?');
                params.push(status);
            }

            const whereClause = conditions.join(' AND ');

            // Get total count
            const countQuery = `SELECT COUNT(*) as total FROM audit_events ae WHERE ${whereClause}`;
            const countResult = getDb().prepare(countQuery).get(...params);
            const total = countResult?.total || 0;

            // Get events with actor details
            const eventsQuery = `
                SELECT
                    ae.*,
                    u.display_name as actor_name,
                    u.primary_email as actor_email
                FROM audit_events ae
                LEFT JOIN users u ON ae.actor_type = 'user' AND ae.actor_id = u.id
                WHERE ${whereClause}
                ORDER BY ae.created_at DESC
                LIMIT ? OFFSET ?
            `;
            params.push(parsedLimit, parsedOffset);

            const events = getDb().prepare(eventsQuery).all(...params);

            // Parse metadata JSON
            const parsedEvents = events.map(event => ({
                ...event,
                metadata: event.metadata_json ? JSON.parse(event.metadata_json) : {},
                aocl_layers: event.aocl_layers_json ? JSON.parse(event.aocl_layers_json) : []
            }));

            res.json({
                events: parsedEvents,
                pagination: {
                    total,
                    limit: parsedLimit,
                    offset: parsedOffset,
                    has_more: parsedOffset + parsedLimit < total
                }
            });

        } catch (err) {
            console.error('Get audit log error:', err);
            res.status(500).json({
                error: 'fetch_failed',
                message: 'Failed to fetch audit log'
            });
        }
    }
);

/**
 * GET /:orgId/audit/actions
 * Get list of unique action types in audit log (for filter dropdown)
 */
router.get('/:orgId/audit/actions',
    authenticate(),
    requireOrg(),
    requireOrgScope(), // FND_01M50Y4CMYSWF93DR97MSWF93D: the URL org must be the caller's org
    requireCapability(Capabilities.ORG_VIEW_AUDIT),
    async (req, res) => {
        try {
            const { orgId } = req.params;

            const actions = getDb().prepare(`
                SELECT DISTINCT action, COUNT(*) as count
                FROM audit_events
                WHERE org_id = ?
                GROUP BY action
                ORDER BY count DESC
            `).all(orgId);

            res.json({ actions });

        } catch (err) {
            console.error('Get audit actions error:', err);
            res.status(500).json({
                error: 'fetch_failed',
                message: 'Failed to fetch audit actions'
            });
        }
    }
);

/**
 * GET /:orgId/audit/export
 *
 * Export audit log in one of three formats:
 *   format=csv     — backwards compatible; plain CSV
 *   format=json    — { events, receipt } with detached evidence signature
 *   format=bundle  — zip with csv + json + receipt + manifest (ET-5)
 *
 * Supported filters:
 *   from / from_date   ISO timestamp lower bound
 *   to   / to_date     ISO timestamp upper bound
 *   actor_id           exact match
 *   action             exact match
 *   target_type        exact match
 *   scope_id           exact match
 *
 * All formats include the detached-signature evidence receipt
 * (Ed25519, WARD-compatible canonical payload hash). Bundle format
 * is the recommended auditor export (self-describing manifest).
 */
router.get('/:orgId/audit/export',
    authenticate(),
    requireOrg(),
    requireOrgScope(), // FND_01M50Y4CMYSWF93DR97MSWF93D: the URL org must be the caller's org
    requireCapability(Capabilities.ORG_VIEW_AUDIT),
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const format = (req.query.format || 'csv').toLowerCase();

            const { whereClause, params } = buildAuditQuery(orgId, req.query, { alias: 'ae.' }); // #1106: the export joins users

            const events = getDb().prepare(`
                SELECT
                    ae.created_at,
                    ae.action,
                    ae.actor_type,
                    ae.actor_id,
                    u.display_name as actor_name,
                    ae.target_type,
                    ae.target_id,
                    ae.status,
                    ae.ip_address,
                    ae.metadata_json
                FROM audit_events ae
                LEFT JOIN users u ON ae.actor_type = 'user' AND ae.actor_id = u.id
                WHERE ${whereClause}
                ORDER BY ae.created_at DESC
                LIMIT 10000
            `).all(...params);

            // CSV format — backwards compatible; no receipt wrapping.
            if (format === 'csv') {
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', contentDisposition(`audit-log-${orgId}.csv`, { type: 'attachment' }));
                res.send(renderAuditCsv(events));
                return;
            }

            // Build signing metadata common to json + bundle formats.
            const meta = {
                org_id:       orgId,
                filters:      extractAppliedFilters(req.query),
                exported_by:  req.user?.id || null,
                exported_at:  new Date().toISOString(),
                tool_version: AUDIT_EXPORT_TOOL_VERSION,
            };
            const payload = canonicalizeAuditPayload({ events, ...meta });
            const { privateKey, signerId } = loadOrCreateAuditSigner(getDb());
            const receipt = signAuditExport(payload, { privateKey, signerId });

            if (format === 'json') {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Content-Disposition', contentDisposition(`audit-log-${orgId}.json`, { type: 'attachment' }));
                res.json(renderAuditJson(events, receipt));
                return;
            }

            if (format === 'bundle') {
                const zipBuf = renderAuditBundle(events, receipt, meta);
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', contentDisposition(`audit-log-${orgId}.zip`, { type: 'attachment' }));
                res.send(zipBuf);
                return;
            }

            res.status(400).json({
                error: 'invalid_format',
                message: `Unknown format '${format}'. Use csv, json, or bundle.`,
            });
        } catch (err) {
            console.error('Export audit log error:', err);
            res.status(500).json({
                error: 'export_failed',
                message: 'Failed to export audit log',
            });
        }
    }
);

/**
 * GET /:orgId/audit/signer-key
 *
 * Return the public Ed25519 key used to sign evidence receipts so
 * auditors can verify bundles offline. Public read; no tier gate.
 */
router.get('/:orgId/audit/signer-key',
    authenticate(),
    requireOrg(),
    requireOrgScope(), // FND_01M50Y4CMYSWF93DR97MSWF93D: the URL org must be the caller's org
    requireCapability(Capabilities.ORG_VIEW_AUDIT),
    async (req, res) => {
        try {
            const { publicKey, signerId } = loadOrCreateAuditSigner(getDb());
            res.json({
                signer_id:  signerId,
                public_key: publicKey,
                algorithm:  'ed25519',
                format:     'pem-spki',
            });
        } catch (err) {
            console.error('Signer key error:', err);
            res.status(500).json({ error: 'signer_key_failed' });
        }
    }
);

/**
 * GET /:orgId/plan
 *
 * Return the org's effective plan + caps + feature list. Used by the
 * frontend to render tier badges, upgrade prompts, and to hide
 * features the user's plan doesn't include (UI-level gate; the
 * authoritative gate is requirePlan() middleware on each endpoint).
 */
router.get('/:orgId/plan',
    authenticate(),
    requireOrg(),
    async (req, res) => {
        try {
            const effective = resolveEffectivePlan(req.org, { db: req.db || getDb() });
            const plan = effective.plan;
            res.json({
                plan,
                plan_rank:   getPlanRank(plan),
                is_trial:    effective.is_trial,
                expired:     effective.expired,
                started_at:  req.org?.plan_started_at || null,
                expires_at:  effective.expires_at,
                caps:        getPlanCaps(plan),
                features:    getPlanFeatures(plan),
            });
        } catch (err) {
            console.error('Plan info error:', err);
            res.status(500).json({ error: 'plan_info_failed' });
        }
    }
);

// Strip anything not an actual filter before surfacing in the receipt.
function extractAppliedFilters(query) {
    const allow = ['from', 'to', 'from_date', 'to_date', 'actor_id', 'action', 'target_type', 'scope_id'];
    const out = {};
    for (const key of allow) {
        if (typeof query[key] === 'string' && query[key].trim().length > 0) {
            out[key] = query[key];
        }
    }
    return out;
}

/**
 * POST /:orgId/audit
 * Create a frontend audit event (Security Issue #69)
 *
 * This endpoint allows the frontend to log audit events to the server-side
 * database instead of using tamperable localStorage.
 *
 * Body:
 * - action: string (required) - Action type (e.g., 'frontend.operation', 'frontend.router.decision')
 * - operation: string (optional) - Operation description
 * - query: string (optional) - Original query/command
 * - targets: string[] (optional) - Affected targets
 * - status: string (optional) - 'success' | 'failure' | 'blocked' | 'dry_run' (default: 'success')
 * - defconLevel: string (optional) - DEFCON level (GREEN, BLUE, AMBER, ORANGE, RED)
 * - metadata: object (optional) - Additional event-specific data
 */
router.post('/:orgId/audit',
    authenticate(),
    requireOrg(),
    requireOrgScope(), // FND_01M50Y4GR4RPAWKZ5QC5RPAWKZ: no writes into another org's audit trail
    async (req, res) => {
        try {
            const { orgId } = req.params;
            const userId = req.user.id;

            const {
                action,
                operation,
                query,
                targets,
                status = 'success',
                defconLevel,
                metadata = {}
            } = req.body;

            // Validate action - must be a frontend action type
            const allowedActions = [
                'frontend.operation',
                'frontend.operation.blocked',
                'frontend.operation.dry_run',
                'frontend.router.decision',
                'frontend.router.escalation'
            ];

            if (!action || !allowedActions.includes(action)) {
                return res.status(400).json({
                    error: 'invalid_action',
                    message: `Action must be one of: ${allowedActions.join(', ')}`
                });
            }

            // Validate status
            const allowedStatuses = ['success', 'failure', 'blocked', 'dry_run', 'denied'];
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({
                    error: 'invalid_status',
                    message: `Status must be one of: ${allowedStatuses.join(', ')}`
                });
            }

            // Build metadata with frontend-specific fields
            const eventMetadata = {
                ...metadata,
                operation: operation || null,
                query: query ? query.slice(0, 1000) : null, // Limit query length
                targets: Array.isArray(targets) ? targets.slice(0, 100) : [], // Limit targets
                defconLevel: defconLevel || 'GREEN',
                source: 'frontend'
            };

            // Log the audit event
            const auditEvent = logOrgEvent(
                action,
                { type: 'user', id: userId },
                orgId,
                req,
                eventMetadata
            );

            res.status(201).json({
                id: auditEvent.id,
                created_at: new Date().toISOString()
            });

        } catch (err) {
            console.error('Create frontend audit event error:', err);
            res.status(500).json({
                error: 'create_failed',
                message: 'Failed to create audit event'
            });
        }
    }
);

// ============================================================================
// ORG-SCOPED USER PREFERENCES
// ============================================================================

function safeParseJson(raw) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * GET /orgs/:orgId/my-preferences
 * Get current user's preferences for this org
 */
router.get('/:orgId/my-preferences', authenticate(), requireOrg(), requireOrgScope(), async (req, res) => {
    try {
        const membership = getDb().prepare(
            'SELECT preferences_json FROM org_memberships WHERE org_id = ? AND user_id = ?'
        ).get(req.params.orgId, req.user.id);

        if (!membership) {
            return res.status(404).json({ error: 'not_member', message: 'Not a member of this org' });
        }

        res.json({ preferences: safeParseJson(membership.preferences_json) });
    } catch (err) {
        console.error('Get org preferences error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to get preferences' });
    }
});

/**
 * PATCH /orgs/:orgId/my-preferences
 * Update current user's preferences for this org (merge)
 */
router.patch('/:orgId/my-preferences', authenticate(), requireOrg(), requireOrgScope(), async (req, res) => {
    try {
        const { preferences } = req.body;
        if (!preferences || typeof preferences !== 'object') {
            return res.status(400).json({ error: 'invalid_body', message: 'preferences object required' });
        }

        const db = getDb();
        const membership = db.prepare(
            'SELECT preferences_json FROM org_memberships WHERE org_id = ? AND user_id = ?'
        ).get(req.params.orgId, req.user.id);

        if (!membership) {
            return res.status(404).json({ error: 'not_member', message: 'Not a member of this org' });
        }

        const current = safeParseJson(membership.preferences_json);
        const updated = { ...current, ...preferences };
        const json = JSON.stringify(updated);

        if (json.length > 102400) {
            return res.status(413).json({ error: 'too_large', message: 'Org preferences exceed 100KB limit' });
        }

        db.prepare(
            'UPDATE org_memberships SET preferences_json = ?, updated_at = datetime(\'now\') WHERE org_id = ? AND user_id = ?'
        ).run(json, req.params.orgId, req.user.id);

        res.json({ synced: Object.keys(preferences).length });
    } catch (err) {
        console.error('Update org preferences error:', err);
        res.status(500).json({ error: 'update_failed', message: 'Failed to update preferences' });
    }
});

/**
 * POST /orgs/:orgId/my-preferences-sync
 * Beacon-friendly merge sync for org-scoped preferences (sendBeacon on page unload)
 */
router.post('/:orgId/my-preferences-sync', authenticate(), requireOrg(), requireOrgScope(), async (req, res) => {
    try {
        const { namespaces } = req.body;
        if (!namespaces || typeof namespaces !== 'object') {
            return res.status(400).json({ error: 'invalid_body', message: 'namespaces object required' });
        }

        const db = getDb();
        const membership = db.prepare(
            'SELECT preferences_json FROM org_memberships WHERE org_id = ? AND user_id = ?'
        ).get(req.params.orgId, req.user.id);

        if (!membership) {
            return res.status(404).json({ error: 'not_member' });
        }

        const current = safeParseJson(membership.preferences_json);
        const updated = { ...current, ...namespaces };
        const json = JSON.stringify(updated);

        if (json.length > 102400) {
            return res.status(413).json({ error: 'too_large' });
        }

        db.prepare(
            'UPDATE org_memberships SET preferences_json = ?, updated_at = datetime(\'now\') WHERE org_id = ? AND user_id = ?'
        ).run(json, req.params.orgId, req.user.id);

        res.json({ synced: Object.keys(namespaces).length });
    } catch (err) {
        console.error('Org preferences sync error:', err);
        res.status(500).json({ error: 'sync_failed' });
    }
});

export default router;
