/**
 * Caller-scoped invitations (GRIPE-712).
 *
 * An invite is addressed to an email. These helpers match it to the signed-in
 * user ONLY through an email that user has VERIFIED (user_emails.verified_at),
 * so one user can never see or accept another user's invite, and an
 * unverified address cannot be used to claim an invite sent to it.
 *
 * All functions take the db handle explicitly so they are testable against an
 * in-memory database.
 */

export function verifiedEmailsFor(db, userId) {
    return db.prepare(`
        SELECT LOWER(email) AS email FROM user_emails
        WHERE user_id = ? AND verified_at IS NOT NULL
    `).all(userId).map(r => r.email);
}

/** Pending, unexpired invites addressed to one of the user's verified emails. */
export function listPendingInvitesForUser(db, userId) {
    const emails = verifiedEmailsFor(db, userId);
    if (emails.length === 0) return [];
    const marks = emails.map(() => '?').join(',');
    return db.prepare(`
        SELECT i.id, i.org_id, i.email, i.role, i.expires_at, i.created_at,
               o.name AS org_name, o.slug AS org_slug,
               u.display_name AS invited_by_name
        FROM invites i
        JOIN orgs o ON o.id = i.org_id
        LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.status = 'pending'
          AND LOWER(i.email) IN (${marks})
          AND (i.expires_at IS NULL OR i.expires_at > ?)
        ORDER BY i.created_at DESC
    `).all(...emails, new Date().toISOString());
}

/** First pending invite the user holds for one org, or null. */
export function pendingInviteForOrg(db, userId, orgId) {
    return listPendingInvitesForUser(db, userId).find(i => i.org_id === orgId) || null;
}

/**
 * Accept by invite id. Returns { ok, status, error, organization, invite }.
 * Not-yours is reported as not_found so ids of other users' invites are not
 * confirmable.
 */
export function acceptInviteById(db, { inviteId, userId, newId }) {
    return db.transaction(() => {
        const invite = db.prepare(`
            SELECT i.*, o.name AS org_name, o.slug AS org_slug
            FROM invites i JOIN orgs o ON o.id = i.org_id
            WHERE i.id = ? AND i.status = 'pending'
        `).get(inviteId);
        const mine = invite && verifiedEmailsFor(db, userId).includes(String(invite.email).toLowerCase());
        if (!invite || !mine) return { ok: false, status: 404, error: 'not_found' };

        if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
            db.prepare(`UPDATE invites SET status = 'expired' WHERE id = ?`).run(invite.id);
            return { ok: false, status: 410, error: 'expired' };
        }

        const org = { id: invite.org_id, name: invite.org_name, slug: invite.org_slug, role: invite.role };
        const existing = db.prepare(`SELECT * FROM org_memberships WHERE org_id = ? AND user_id = ?`)
            .get(invite.org_id, userId);

        if (existing && existing.status === 'active') {
            db.prepare(`UPDATE invites SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?
                        WHERE id = ? AND status = 'pending'`).run(userId, invite.id);
            return { ok: true, status: 200, alreadyMember: true, organization: org, invite };
        }
        const expiresAt = invite.membership_expires_at || null;
        if (existing) {
            db.prepare(`UPDATE org_memberships
                        SET role = ?, status = 'active', expires_at = ?, custom_role_id = NULL,
                            accepted_at = datetime('now'), updated_at = datetime('now')
                        WHERE id = ?`).run(invite.role, expiresAt, existing.id);
        } else {
            db.prepare(`INSERT INTO org_memberships
                        (id, org_id, user_id, role, status, expires_at, invited_by, invited_at, accepted_at)
                        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'))`)
              .run(newId, invite.org_id, userId, invite.role, expiresAt, invite.invited_by, invite.created_at);
        }
        const upd = db.prepare(`UPDATE invites SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?
                                WHERE id = ? AND status = 'pending'`).run(userId, invite.id);
        if (upd.changes === 0) return { ok: false, status: 409, error: 'already_accepted' };
        return { ok: true, status: 200, organization: org, invite };
    }).immediate();
}
