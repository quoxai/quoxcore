/**
 * Invite routes for Quox Auth Service
 *
 * GET /invites/:token - Get invite details
 * POST /invites/:token/accept - Accept invite
 * POST /invites/:token/decline - Decline invite
 */

import { Router } from 'express';
import { generateId } from '../utils/crypto.js';
import { queries, transaction, getDb } from '../db/index.js';
import { logMembershipEvent, AuditActions } from '../utils/audit.js';
import { authenticate } from '../middleware/authenticate.js';
import { OrgRoles } from '../utils/policy.js';
import { finalizeInviteAccept } from '../utils/inviteLifecycle.js';
import { listPendingInvitesForUser, acceptInviteById } from '../utils/myInvites.js';

const router = Router();

/**
 * GET /invites/mine  (GRIPE-712)
 * Pending invitations for the signed-in user, matched on their VERIFIED email.
 * Declared before /:token so "mine" is never read as a token.
 */
router.get('/mine', authenticate({ required: true }), (req, res) => {
    try {
        const invites = listPendingInvitesForUser(getDb(), req.user.id).map(i => ({
            id: i.id, role: i.role, expires_at: i.expires_at, created_at: i.created_at,
            invited_by: i.invited_by_name || null,
            organization: { id: i.org_id, name: i.org_name, slug: i.org_slug },
        }));
        res.json({ invites });
    } catch (err) {
        console.error('List my invites error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to list invitations' });
    }
});

/**
 * POST /invites/mine/:id/accept  (GRIPE-712)
 * Accept by invite id, no emailed token. The invite must be pending, unexpired
 * and addressed to one of the caller's verified emails.
 */
router.post('/mine/:id/accept', authenticate({ required: true }), (req, res) => {
    try {
        const r = acceptInviteById(getDb(), {
            inviteId: req.params.id, userId: req.user.id, newId: generateId(),
        });
        if (!r.ok) {
            const msg = {
                not_found: 'No pending invitation with that id for your account',
                expired: 'This invite has expired',
                already_accepted: 'This invite has already been accepted',
            }[r.error];
            return res.status(r.status).json({ error: r.error, message: msg });
        }
        if (r.alreadyMember) {
            return res.json({ success: true, message: 'You are already a member of this organization', organization: r.organization });
        }
        logMembershipEvent(AuditActions.ORG_MEMBER_ACCEPT, { type: 'user', id: req.user.id },
            r.invite.org_id, req.user.id, req, { role: r.invite.role, invite_id: r.invite.id });
        finalizeInviteAccept(getDb(), { invite: r.invite, userId: req.user.id })
            .catch(err => console.error('[invite-accept] finalize failed:', err.message));
        res.json({ success: true, message: 'Invite accepted', organization: r.organization });
    } catch (err) {
        console.error('Accept my invite error:', err);
        res.status(500).json({ error: 'accept_failed', message: 'Failed to accept invite' });
    }
});

/**
 * GET /invites/:token
 * Get invite details (public - no auth required)
 */
router.get('/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const invite = queries.getInviteByToken(token);

        if (!invite) {
            // #324: distinguish "token never existed" (404) from "invite
            // exists but is no longer usable" (410 invite_not_usable).
            // getInviteByToken only returns status='pending' rows; if the
            // token resolves via the any-status query, the invite was
            // accepted or otherwise consumed.
            const staleInvite = queries.getInviteByTokenAny(token);
            if (staleInvite) {
                return res.status(410).json({
                    error:   'invite_not_usable',
                    message: 'This invite link is no longer usable. Ask your administrator for a fresh invite.',
                });
            }
            return res.status(404).json({
                error: 'not_found',
                message: 'Invite not found or has expired'
            });
        }

        // Check expiry
        if (new Date(invite.expires_at) < new Date()) {
            return res.status(410).json({
                error:   'invite_not_usable',
                message: 'This invite link is no longer usable. Ask your administrator for a fresh invite.',
            });
        }

        // Get inviter info
        const inviter = queries.getUserById(invite.invited_by);

        res.json({
            invite: {
                email: invite.email,
                role: invite.role,
                organization: {
                    name: invite.org_name,
                    slug: invite.org_slug
                },
                invited_by: inviter ? {
                    display_name: inviter.display_name,
                    email: inviter.primary_email
                } : null,
                expires_at: invite.expires_at
            }
        });

    } catch (err) {
        console.error('Get invite error:', err);
        res.status(500).json({
            error: 'fetch_failed',
            message: 'Failed to fetch invite'
        });
    }
});

/**
 * POST /invites/:token/accept
 * Accept invite
 *
 * If user is logged in: adds them to org
 * If not logged in: returns info needed to signup/login first
 *
 * Security fix #88: Race condition prevention
 * - All checks and mutations happen inside a single IMMEDIATE transaction
 * - Uses SELECT ... WHERE status = 'pending' to atomically check-and-lock
 * - Unique constraint on (invite_id, accepted_by) prevents double-spend at DB level
 */
router.post('/:token/accept', authenticate({ required: false }), async (req, res) => {
    try {
        const { token } = req.params;

        // If not logged in, we need to check invite exists first (outside transaction is OK for read-only check)
        if (!req.user) {
            const invite = queries.getInviteByToken(token);
            if (!invite) {
                return res.status(404).json({
                    error: 'not_found',
                    message: 'Invite not found or has expired'
                });
            }
            return res.status(401).json({
                error: 'authentication_required',
                message: 'Please log in or create an account to accept this invite',
                invite: {
                    email: invite.email,
                    organization: invite.org_name
                }
            });
        }

        const db = getDb();
        const membershipId = generateId();

        // Use IMMEDIATE transaction to acquire write lock at start, preventing race conditions
        // All checks happen inside the transaction to ensure atomicity
        const result = db.transaction(() => {
            // Fetch invite with status check inside transaction
            // This ensures no other transaction can modify this invite between our check and update
            const invite = db.prepare(`
                SELECT i.*, o.name as org_name, o.slug as org_slug
                FROM invites i
                JOIN orgs o ON i.org_id = o.id
                WHERE i.token = ? AND i.status = 'pending'
            `).get(token);

            if (!invite) {
                return { error: 'not_found', status: 404 };
            }

            // Check expiry inside transaction
            if (new Date(invite.expires_at) < new Date()) {
                // Atomically mark as expired
                db.prepare(`UPDATE invites SET status = 'expired' WHERE id = ?`).run(invite.id);
                return { error: 'expired', status: 410 };
            }

            // Verify email matches
            if (req.user.email.toLowerCase() !== invite.email.toLowerCase()) {
                return { error: 'email_mismatch', status: 403 };
            }

            // Check existing membership inside transaction
            const existingMembership = db.prepare(`
                SELECT * FROM org_memberships WHERE org_id = ? AND user_id = ?
            `).get(invite.org_id, req.user.id);

            if (existingMembership && existingMembership.status === 'active') {
                // Already a member - mark invite as accepted atomically
                db.prepare(`
                    UPDATE invites SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?
                    WHERE id = ? AND status = 'pending'
                `).run(req.user.id, invite.id);

                return {
                    success: true,
                    alreadyMember: true,
                    organization: {
                        id: invite.org_id,
                        name: invite.org_name,
                        slug: invite.org_slug
                    }
                };
            }

            // AUD-WS-1: carry membership_expires_at from the invite onto the
            // membership (auditor invites set a deadline; regular invites leave
            // it null meaning no expiry).
            const membershipExpiresAt = invite.membership_expires_at || null;

            // Create or update membership
            if (existingMembership) {
                // ET-ENFORCE round-3: clear custom_role_id on reactivation.
                // The previous overlay belonged to a previous lifecycle; a
                // re-invited user must not silently re-acquire elevated
                // capabilities the new admin didn't explicitly grant.
                db.prepare(`
                    UPDATE org_memberships
                    SET role = ?, status = 'active', expires_at = ?,
                        custom_role_id = NULL,
                        accepted_at = datetime('now'), updated_at = datetime('now')
                    WHERE id = ?
                `).run(invite.role, membershipExpiresAt, existingMembership.id);
            } else {
                db.prepare(`
                    INSERT INTO org_memberships (id, org_id, user_id, role, status, expires_at, invited_by, invited_at, accepted_at)
                    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'))
                `).run(membershipId, invite.org_id, req.user.id, invite.role, membershipExpiresAt, invite.invited_by, invite.created_at);
            }

            // Atomically mark invite as accepted (only if still pending - prevents double-spend)
            const updateResult = db.prepare(`
                UPDATE invites SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?
                WHERE id = ? AND status = 'pending'
            `).run(req.user.id, invite.id);

            // If no rows updated, another transaction already accepted this invite
            if (updateResult.changes === 0) {
                // Rollback will happen automatically since we're throwing
                throw new Error('INVITE_ALREADY_ACCEPTED');
            }

            return {
                success: true,
                invite,
                organization: {
                    id: invite.org_id,
                    name: invite.org_name,
                    slug: invite.org_slug,
                    role: invite.role
                }
            };
        }).immediate(); // IMMEDIATE mode acquires write lock at transaction start

        // Handle transaction results
        if (result.error === 'not_found') {
            return res.status(404).json({
                error: 'not_found',
                message: 'Invite not found or has expired'
            });
        }

        if (result.error === 'expired') {
            return res.status(410).json({
                error: 'expired',
                message: 'This invite has expired'
            });
        }

        if (result.error === 'email_mismatch') {
            return res.status(403).json({
                error: 'email_mismatch',
                message: 'This invite was sent to a different email address'
            });
        }

        if (result.alreadyMember) {
            return res.json({
                success: true,
                message: 'You are already a member of this organization',
                organization: result.organization
            });
        }

        // Log acceptance
        logMembershipEvent(AuditActions.ORG_MEMBER_ACCEPT, {
            type: 'user',
            id: req.user.id
        }, result.invite.org_id, req.user.id, req, {
            role: result.invite.role,
            invite_id: result.invite.id
        });

        // ET-ENFORCE C — create the team_membership row (when the invite
        // carried a team_id) and fire `team.member.joined` so Matrix +
        // webhook subscribers see the lifecycle change. Fire-and-forget:
        // dispatch failures are swallowed and must not undo the accept.
        finalizeInviteAccept(getDb(), {
            invite: result.invite,
            userId: req.user.id,
        }).catch(err => console.error('[invite-accept] finalize failed:', err.message));

        res.json({
            success: true,
            message: 'Invite accepted',
            organization: result.organization
        });

    } catch (err) {
        // Handle race condition error specifically
        if (err.message === 'INVITE_ALREADY_ACCEPTED') {
            return res.status(409).json({
                error: 'already_accepted',
                message: 'This invite has already been accepted'
            });
        }

        console.error('Accept invite error:', err);
        res.status(500).json({
            error: 'accept_failed',
            message: 'Failed to accept invite'
        });
    }
});

/**
 * POST /invites/:token/decline
 * Decline invite
 */
router.post('/:token/decline', async (req, res) => {
    try {
        const { token } = req.params;

        const invite = queries.getInviteByToken(token);

        if (!invite) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Invite not found'
            });
        }

        // Mark as revoked (declined)
        queries.updateInviteStatus(invite.id, 'revoked', null);

        res.json({
            success: true,
            message: 'Invite declined'
        });

    } catch (err) {
        console.error('Decline invite error:', err);
        res.status(500).json({
            error: 'decline_failed',
            message: 'Failed to decline invite'
        });
    }
});

export default router;
