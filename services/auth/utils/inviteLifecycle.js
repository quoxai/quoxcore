/**
 * ET-ENFORCE Phase C — invite-accept lifecycle hook.
 *
 * After the DB transaction that writes the org_membership + flips the
 * invite to accepted succeeds, the route handler calls this helper to:
 *
 *   1. Write the team_memberships row if the invite carried a team_id
 *      (idempotent — UNIQUE(team_id, user_id) already guards duplicates).
 *   2. Emit `team.member.joined` via emitAndDispatch so Matrix + webhook
 *      subscribers see the lifecycle change. teamId is null for
 *      org-only invites.
 *
 * Runs outside the DB transaction so webhook dispatch failures can't
 * undo the accept. emitAndDispatch swallows its own errors.
 */

import { ulid } from './helpers.js';
import { emitAndDispatch } from './teamEventEmitter.js';

export async function finalizeInviteAccept(db, { invite, userId }) {
    if (!invite || !invite.org_id) return;
    if (!userId) return;

    if (invite.team_id) {
        try {
            db.prepare(`
                INSERT OR IGNORE INTO team_memberships
                    (id, team_id, user_id, role, status, org_id)
                VALUES (?, ?, ?, ?, 'active', ?)
            `).run(
                ulid(),
                invite.team_id,
                userId,
                invite.role && invite.role !== 'viewer' ? 'member' : 'viewer',
                invite.org_id,
            );
        } catch (err) {
            // A missing org_id column on legacy schemas shouldn't block the
            // event emit. Log and move on.
            console.error('[invite-accept] team_memberships insert failed:', err.message);
        }
    }

    await emitAndDispatch(db, {
        orgId:         invite.org_id,
        teamId:        invite.team_id || null,
        eventType:     'team.member.joined',
        actorId:       invite.invited_by || null,
        subjectUserId: userId,
        metadata: {
            invite_id: invite.id,
            role:      invite.role,
            email:     invite.email,
            via:       'org_invite_accept',
        },
    });
}
