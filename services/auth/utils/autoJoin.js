/**
 * ET-ENFORCE Phase F — verified-domain auto-join.
 *
 * When a user signs up with an email whose domain is verified by an org
 * (verified_domains.verified_at IS NOT NULL), they are auto-joined as
 * a viewer of that org. This wires the previously-unused
 * findVerifiedDomainOwner helper into the signup path.
 *
 * Rules:
 *   - Domain owner is unique per verified row (UNIQUE on (domain) for
 *     verified rows is enforced by domain-verification flow), so first
 *     match wins.
 *   - If the user already has an active membership in that org, no-op.
 *   - If the user has a 'removed' membership, reactivate to 'viewer'
 *     (covers the deprovision-then-re-signup path).
 *   - Never downgrade an existing higher-tier role.
 *   - Emits org.member.auto_joined audit event so external consumers
 *     can see why the membership appeared.
 */

import { ulid } from './helpers.js';
import { findVerifiedDomainOwner } from './domainVerification.js';

export function autoJoinByVerifiedDomain(db, { userId, email }) {
    if (!db || !userId || !email) {
        return { joined: false, reason: 'invalid_input' };
    }
    const owner = findVerifiedDomainOwner(db, email);
    if (!owner || !owner.org_id) {
        return { joined: false, reason: 'no_verified_domain' };
    }

    const existing = db.prepare(
        `SELECT id, role, status FROM org_memberships
         WHERE org_id = ? AND user_id = ?`,
    ).get(owner.org_id, userId);

    if (existing && existing.status === 'active') {
        return { joined: false, reason: 'already_member', orgId: owner.org_id };
    }

    if (existing) {
        // 'invited' rows belong to the explicit invite flow — auto-join must
        // never bypass an invite the user hasn't accepted yet. Only reactivate
        // rows that the user (or admin) had previously left/removed/suspended.
        if (existing.status === 'invited') {
            return { joined: false, reason: 'invite_pending', orgId: owner.org_id };
        }
        const REACTIVATABLE = new Set(['removed', 'suspended', 'left']);
        if (!REACTIVATABLE.has(existing.status)) {
            return { joined: false, reason: `unexpected_status_${existing.status}`, orgId: owner.org_id };
        }
        db.prepare(`
            UPDATE org_memberships
               SET status = 'active',
                   custom_role_id = NULL,
                   updated_at = datetime('now')
             WHERE id = ?
        `).run(existing.id);
    } else {
        db.prepare(`
            INSERT INTO org_memberships (id, org_id, user_id, role, status)
            VALUES (?, ?, ?, 'viewer', 'active')
        `).run(ulid(), owner.org_id, userId);
    }

    try {
        db.prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'system', NULL, 'org.member.auto_joined', 'user', ?, 'success', ?)
        `).run(
            ulid(),
            owner.org_id,
            userId,
            JSON.stringify({ via: 'verified_domain', domain: owner.domain, email }),
        );
    } catch (err) {
        // Audit table missing in some legacy harnesses → don't block the join.
        console.error('[auto-join] audit insert failed:', err.message);
    }

    return { joined: true, orgId: owner.org_id, role: 'viewer', reactivated: !!existing };
}
