/**
 * ET-2 Phase B — JIT user provisioning on first SSO login.
 *
 * Called by the /callback route after the OIDC handshake has produced
 * verified claims. Creates (or attaches to) a user record, attaches
 * the provider identity, and ensures an org_membership row exists
 * (pending by default — admin approves).
 */

import { ulid } from './helpers.js';

export function provisionSsoUser(db, { providerId, orgId, claims }) {
    if (!claims || typeof claims !== 'object') throw new Error('claims required');
    const sub   = claims.sub;
    const email = claims.email ? String(claims.email).toLowerCase() : null;
    if (!sub)   throw new Error('claim.sub is required');
    if (!email) throw new Error('claim.email is required');
    if (claims.email_verified === false) {
        throw new Error('provider reported email_verified=false — refusing to provision');
    }

    const provider = db.prepare(
        `SELECT id, provider_key, org_id FROM sso_providers WHERE id = ?`,
    ).get(providerId);
    if (!provider) throw new Error('sso provider not found');
    if (provider.org_id !== orgId) {
        throw new Error('provider.org_id does not match requested orgId');
    }

    // Find-or-create user by primary_email.
    let user = db.prepare(
        `SELECT id, display_name FROM users WHERE primary_email = ?`,
    ).get(email);
    let created = false;
    if (!user) {
        const id = ulid();
        db.prepare(`
            INSERT INTO users (id, primary_email, display_name, avatar_url, status)
            VALUES (?, ?, ?, ?, 'active')
        `).run(
            id, email,
            claims.name || null,
            claims.picture || null,
        );
        user = { id, display_name: claims.name || null };
        created = true;
    } else if (!user.display_name && claims.name) {
        db.prepare(`UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(claims.name, user.id);
    }

    // Attach identity. UNIQUE(user_id, provider) — INSERT OR IGNORE is
    // the idempotent shortcut for the normal "reconnect" path.
    db.prepare(`
        INSERT OR IGNORE INTO auth_identities (id, user_id, provider, provider_sub, metadata_json)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        ulid(), user.id, provider.provider_key, sub,
        JSON.stringify({ sso_provider_id: provider.id, last_claims: { name: claims.name, picture: claims.picture } }),
    );

    // Ensure org_membership exists. We do NOT overwrite role/status for
    // an existing row — only insert a pending one if absent.
    db.prepare(`
        INSERT OR IGNORE INTO org_memberships
            (id, org_id, user_id, role, status, invited_at)
        VALUES (?, ?, ?, 'viewer', 'invited', datetime('now'))
    `).run(ulid(), orgId, user.id);

    return { userId: user.id, created };
}

export function upsertSsoSession(db, { providerId, userId, subject, email }) {
    if (!providerId || !userId || !subject) {
        throw new Error('providerId, userId, subject required');
    }
    db.prepare(`
        INSERT INTO sso_sessions (id, user_id, provider_id, subject, email)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, subject) DO UPDATE SET
            last_login_at = datetime('now'),
            email         = excluded.email
    `).run(ulid(), userId, providerId, subject, email || null);
}
