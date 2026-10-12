/**
 * ET-6B — assistant-scoped guest invites.
 *
 * Extends the existing invites table with:
 *   - invite_type     (regular | guest | assistant_scoped)
 *   - target_scope_id (for guest / assistant_scoped invites; identifies
 *                      the scope the guest can see and chat with)
 *
 * On accept, guests land with role='viewer' + status='active' + a
 * preferences_json flag that tells the UI to render the minimal
 * guest surface. A capability_grant scoped to target_scope_id
 * limits the guest's access server-side.
 *
 * The schema extension is idempotent and backwards-compatible — older
 * rows default to invite_type='regular'.
 */

import { ulid } from './helpers.js';
import { randomBytes } from 'crypto';

export const INVITE_TYPES = Object.freeze(['regular', 'guest', 'assistant_scoped']);
const GUEST_INVITE_TTL_HOURS = 7 * 24;
const INVITE_TYPE_SET = new Set(INVITE_TYPES);

// ──────────────────────────────────────────────────────────────────────
// Schema — idempotent ALTERs
// ──────────────────────────────────────────────────────────────────────

export function ensureGuestInviteSchema(db) {
    const cols = db.prepare(`PRAGMA table_info(invites)`).all().map(c => c.name);
    if (!cols.includes('invite_type')) {
        db.exec(`ALTER TABLE invites ADD COLUMN invite_type TEXT NOT NULL DEFAULT 'regular'`);
    }
    if (!cols.includes('target_scope_id')) {
        db.exec(`ALTER TABLE invites ADD COLUMN target_scope_id TEXT`);
    }
}

// ──────────────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────────────

function generateInviteToken() {
    return `inv_${randomBytes(24).toString('base64url')}`;
}

function expiresAtIso(hours = GUEST_INVITE_TTL_HOURS) {
    return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

export function createGuestInvite(db, {
    orgId,
    email,
    targetScopeId,
    invitedBy,
    inviteType = 'guest',
}) {
    if (!orgId)         throw new Error('orgId required');
    if (!email)         throw new Error('email required');
    if (!targetScopeId) throw new Error('target_scope_id required');
    if (!invitedBy)     throw new Error('invitedBy required');
    if (!INVITE_TYPE_SET.has(inviteType) || inviteType === 'regular') {
        throw new Error(`invalid invite_type "${inviteType}" for guest flow`);
    }
    // ET-ENFORCE round-3: cap email at RFC 5321 limit so an admin can't seed
    // an invite whose email overruns DB rows + JSON serialisation everywhere
    // it's later echoed back.
    if (typeof email !== 'string' || email.length === 0 || email.length > 254) {
        throw new Error('email length out of range (1-254)');
    }
    if (!email.includes('@')) {
        throw new Error('email must contain @');
    }

    // Verify the scope belongs to this org (prevents cross-org leaks).
    const scope = db.prepare(`SELECT id, org_id, scope_type FROM scopes WHERE id = ?`).get(targetScopeId);
    if (!scope) {
        throw new Error(`target scope "${targetScopeId}" not found`);
    }
    if (scope.org_id !== orgId) {
        throw new Error(`target scope belongs to a different org`);
    }
    // ET-ENFORCE round-3: assistant.use grants are only meaningful at a team
    // scope. Refuse division/department targets so the capability_grant
    // doesn't end up over-broad. (scope_type may be null in legacy minimal
    // test schemas — treat that as "team-equivalent" for backwards compat.)
    if (scope.scope_type && scope.scope_type !== 'team') {
        throw new Error(`target scope must be a team scope, got "${scope.scope_type}"`);
    }

    const id    = ulid();
    const token = generateInviteToken();
    db.prepare(`
        INSERT INTO invites (
            id, org_id, team_id, email, role, invited_by, token,
            invite_type, target_scope_id,
            status, expires_at
        ) VALUES (?, ?, NULL, ?, 'viewer', ?, ?, ?, ?, 'pending', ?)
    `).run(id, orgId, email.toLowerCase(), invitedBy, token, inviteType, targetScopeId, expiresAtIso());

    return db.prepare(`SELECT * FROM invites WHERE id = ?`).get(id);
}

// ──────────────────────────────────────────────────────────────────────
// Detect
// ──────────────────────────────────────────────────────────────────────

export function isGuestInvite(invite) {
    if (!invite) return false;
    return invite.invite_type === 'guest' || invite.invite_type === 'assistant_scoped';
}

// ──────────────────────────────────────────────────────────────────────
// Accept
// ──────────────────────────────────────────────────────────────────────

export function acceptGuestInvite(db, { token, userId }) {
    if (!token)  throw new Error('token required');
    if (!userId) throw new Error('userId required');

    const invite = db.prepare(`SELECT * FROM invites WHERE token = ?`).get(token);
    if (!invite)                   throw new Error('invite not found');
    if (!isGuestInvite(invite))    throw new Error('invite_type is not a guest type');
    if (invite.status !== 'pending') throw new Error(`invite already ${invite.status}`);

    const user = db.prepare(`SELECT id, primary_email FROM users WHERE id = ?`).get(userId);
    if (!user) throw new Error('user not found');
    if (String(user.primary_email).toLowerCase() !== String(invite.email).toLowerCase()) {
        throw new Error('invite email does not match this user');
    }

    const prefs = {
        invite_type:     invite.invite_type,
        guest_scope_id:  invite.target_scope_id,
    };

    const tx = db.transaction(() => {
        // Membership (or revive)
        const existing = db.prepare(
            `SELECT id, preferences_json FROM org_memberships WHERE org_id = ? AND user_id = ?`,
        ).get(invite.org_id, userId);
        if (existing) {
            const merged = { ...JSON.parse(existing.preferences_json || '{}'), ...prefs };
            db.prepare(`
                UPDATE org_memberships
                SET role = 'viewer', status = 'active',
                    preferences_json = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(JSON.stringify(merged), existing.id);
        } else {
            db.prepare(`
                INSERT INTO org_memberships
                    (id, org_id, user_id, role, status, preferences_json)
                VALUES (?, ?, ?, 'viewer', 'active', ?)
            `).run(ulid(), invite.org_id, userId, JSON.stringify(prefs));
        }

        // Capability grant scoped to the target (idempotent).
        db.prepare(`
            INSERT OR IGNORE INTO capability_grants
                (id, principal_type, principal_id, capability, scope_id, granted_by)
            VALUES (?, 'user', ?, 'assistant.use', ?, ?)
        `).run(ulid(), userId, invite.target_scope_id, invite.invited_by);

        // Mark invite accepted
        db.prepare(`
            UPDATE invites SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?
            WHERE id = ?
        `).run(userId, invite.id);
    });
    tx();

    return {
        userId,
        orgId:         invite.org_id,
        targetScopeId: invite.target_scope_id,
        inviteType:    invite.invite_type,
    };
}
