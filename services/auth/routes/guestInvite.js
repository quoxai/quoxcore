/**
 * ET-6B + ET-ENFORCE G — guest invite HTTP routes.
 *
 * Endpoints:
 *   POST /orgs/:orgId/invites/guest         Enterprise + ORG_MANAGE_MEMBERS
 *       body: { email, target_scope_id, invite_type? }
 *   POST /invites/:token/accept-guest       Authed user accepts own invite
 *   POST /invites/:token/signup-and-accept  Anonymous → user + accept in one txn
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    ensureGuestInviteSchema,
    createGuestInvite,
    acceptGuestInvite,
    isGuestInvite,
    INVITE_TYPES,
} from '../utils/guestInvite.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { requirePlan } from '../middleware/requirePlan.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { hashPassword, sha256, createAccessToken, createRefreshToken } from '../utils/crypto.js';
import { validatePassword as validatePasswordPolicy } from '../utils/passwordValidation.js';
import { enforceIpAllowlist } from '../utils/enforcement.js';
import { emitAndDispatch } from '../utils/teamEventEmitter.js';

const router = Router();

function db(req) { return req.db || getDb(); }

function ensureAuthedOrg(req, res, next) {
    if (req.user && req.org && req.orgMembership) return next();
    return requireAuth(req, res, (err) => {
        if (err) return next(err);
        return requireOrgMembership(req, res, next);
    });
}

function requireAuthedOrg(req, res, next) {
    if (!req.user || !req.org) return res.status(401).json({ error: 'unauthenticated' });
    next();
}

function requireManageMembers(req, res, next) {
    const role = req.orgMembership?.role;
    if (!resolveCap(req, Capabilities.ORG_MANAGE_MEMBERS)) {
        return res.status(403).json({ error: 'forbidden', required: Capabilities.ORG_MANAGE_MEMBERS });
    }
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'invite', ?, 'success', ?)
        `).run(ulid(), req.org?.id || null, req.user?.id || null, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[guest-invite] audit insert failed:', err.message);
    }
}

function lazyEnsure(req) {
    try { ensureGuestInviteSchema(db(req)); } catch { /* noop */ }
}

const adminChain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('enterprise'), requireManageMembers];

// ──────────────────────────────────────────────────────────────────────
// Admin — create guest invite
// ──────────────────────────────────────────────────────────────────────

router.post('/orgs/:orgId/invites/guest', ...adminChain, (req, res) => {
    lazyEnsure(req);
    const { email, target_scope_id, invite_type } = req.body || {};
    if (!email)            return res.status(400).json({ error: 'email_required' });
    if (!target_scope_id)  return res.status(400).json({ error: 'target_scope_id_required' });
    if (invite_type && !INVITE_TYPES.includes(invite_type)) {
        return res.status(400).json({ error: 'invalid_invite_type' });
    }
    try {
        const invite = createGuestInvite(db(req), {
            orgId:         req.org.id,
            email,
            targetScopeId: target_scope_id,
            invitedBy:     req.user.id,
            inviteType:    invite_type || 'guest',
        });
        emitAudit(req, 'org.invite.guest_created', invite.id, {
            email, target_scope_id, invite_type: invite.invite_type,
        });
        res.status(201).json({ invite });
    } catch (err) {
        const msg = String(err?.message || err);
        const status = /not found|different org/i.test(msg) ? 404 : 400;
        return res.status(status).json({ error: 'invalid_input', message: msg });
    }
});

// ──────────────────────────────────────────────────────────────────────
// Guest — accept invite
// ──────────────────────────────────────────────────────────────────────

function authedOrTestUser(req, res, next) {
    // In prod, authenticate via cookie (requireAuth). For tests, the
    // fixture injects req.user directly. If neither, 401.
    if (req.user?.id) return next();
    return requireAuth(req, res, (err) => {
        if (err || !req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
        next();
    });
}

// ──────────────────────────────────────────────────────────────────────
// ET-ENFORCE G — anonymous signup + accept in one transaction
// ──────────────────────────────────────────────────────────────────────

router.post('/invites/:token/signup-and-accept', async (req, res) => {
    lazyEnsure(req);
    const token = req.params.token;
    const password = req.body?.password;
    const rawDisplayName = req.body?.display_name;
    if (rawDisplayName != null && (typeof rawDisplayName !== 'string' || rawDisplayName.length > 200)) {
        return res.status(400).json({ error: 'invalid_display_name' });
    }
    const displayName = rawDisplayName || null;

    // ET-ENFORCE round-3: look up invite BEFORE password validation. Earlier
    // ordering let an attacker probe token presence via timing — password
    // validation short-circuits before any DB read on weak passwords. Now
    // every code path hits the DB first, so the time-to-response on the
    // unhappy paths converges.
    const database = db(req);
    const invite = database.prepare(`SELECT * FROM invites WHERE token = ?`).get(token);

    // Round-3: collapse "missing", "expired", "consumed" into a single 410
    // invite_not_usable so an admin holding a guest invite cannot probe the
    // lifecycle. Wrong-invite-type stays a separate 400 — by the time you've
    // got a non-guest token in your hand, no oracle is possible (you already
    // know the invite exists).
    if (!invite ||
        invite.status !== 'pending' ||
        (invite.expires_at && new Date(invite.expires_at) < new Date())) {
        if (invite && invite.expires_at && new Date(invite.expires_at) < new Date() && invite.status === 'pending') {
            try { database.prepare(`UPDATE invites SET status = 'expired' WHERE id = ?`).run(invite.id); } catch { /* best-effort */ }
        }
        return res.status(410).json({ error: 'invite_not_usable' });
    }
    if (!isGuestInvite(invite)) {
        return res.status(400).json({ error: 'invite_not_guest_type' });
    }

    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'password_required' });
    }
    const pwCheck = validatePasswordPolicy(password);
    if (!pwCheck.valid) {
        return res.status(400).json({ error: 'weak_password', message: pwCheck.message });
    }

    // ET-ENFORCE G audit fix — apply the org's IP allowlist before any
    // user-creation work. Otherwise a guest invite from outside the
    // network's allowlisted range becomes a back-door around login-time
    // enforcement (Phase E). The invite row stays pending so a legitimate
    // visit from an allowed IP still works.
    const ipVerdict = enforceIpAllowlist(database, { orgId: invite.org_id, ip: req.ip });
    if (!ipVerdict.allowed) {
        return res.status(403).json({
            error: 'ip_not_allowed',
            message: 'Your IP address is not on this organisation’s allowlist.',
        });
    }

    const email = String(invite.email).toLowerCase();
    // Check BOTH users.primary_email and user_emails.email — a user may
    // have added this address as a non-primary alias, which would still
    // trip user_emails.email UNIQUE inside the transaction below and
    // leave the caller with an opaque 500.
    const existingByPrimary = database.prepare(
        `SELECT id FROM users WHERE primary_email = ?`,
    ).get(email);
    const existingByAlias = database.prepare(
        `SELECT user_id FROM user_emails WHERE email = ?`,
    ).get(email);
    if (existingByPrimary || existingByAlias) {
        return res.status(409).json({
            error:   'email_exists',
            message: 'An account with this email already exists. Sign in first, then accept the invite.',
        });
    }

    let passwordHash;
    try {
        passwordHash = await hashPassword(password);
    } catch (err) {
        console.error('[guest-signup] hashPassword failed:', err.message);
        return res.status(500).json({ error: 'signup_failed' });
    }

    const userId = ulid();
    const emailId = ulid();
    const authId = ulid();
    const sessionId = ulid();
    const refreshToken = createRefreshToken({ sub: userId, session_id: sessionId, org_id: invite.org_id });

    let txError = null;
    try {
        database.transaction(() => {
            // Create user (auto-active because the invite token already
            // proves the email belongs to this person — no separate
            // verification step needed).
            database.prepare(`
                INSERT INTO users (id, primary_email, display_name, status)
                VALUES (?, ?, ?, 'active')
            `).run(userId, email, displayName || email.split('@')[0]);

            database.prepare(`
                INSERT INTO user_emails (id, user_id, email, is_primary, verified_at)
                VALUES (?, ?, ?, 1, datetime('now'))
            `).run(emailId, userId, email);

            database.prepare(`
                INSERT INTO auth_identities (id, user_id, provider, password_hash)
                VALUES (?, ?, 'password', ?)
            `).run(authId, userId, passwordHash);

            // Membership + capability + invite-accept (mirrors the
            // logic in acceptGuestInvite but happens inside the same
            // txn so a failure rolls back the user creation too).
            const prefs = {
                invite_type:    invite.invite_type,
                guest_scope_id: invite.target_scope_id,
            };
            database.prepare(`
                INSERT INTO org_memberships
                    (id, org_id, user_id, role, status, preferences_json)
                VALUES (?, ?, ?, 'viewer', 'active', ?)
            `).run(ulid(), invite.org_id, userId, JSON.stringify(prefs));

            database.prepare(`
                INSERT OR IGNORE INTO capability_grants
                    (id, principal_type, principal_id, capability, scope_id, granted_by)
                VALUES (?, 'user', ?, 'assistant.use', ?, ?)
            `).run(ulid(), userId, invite.target_scope_id, invite.invited_by);

            database.prepare(`
                UPDATE invites SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?
                WHERE id = ? AND status = 'pending'
            `).run(userId, invite.id);

            database.prepare(`
                INSERT INTO sessions
                    (id, user_id, org_id, refresh_token_hash, device_fingerprint, ip_address, user_agent, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                sessionId, userId, invite.org_id, refreshToken.hash,
                req.headers['user-agent']?.slice(0, 100) || null,
                req.ip || null,
                req.headers['user-agent']?.slice(0, 500) || null,
                refreshToken.expiresAt,
            );
        }).immediate();
    } catch (err) {
        txError = err;
    }
    if (txError) {
        console.error('[guest-signup] transaction failed:', txError.message);
        return res.status(500).json({ error: 'signup_failed', message: txError.message });
    }

    emitAudit(
        { ...req, org: { id: invite.org_id }, user: { id: userId } },
        'org.invite.guest_signup_accepted',
        invite.id,
        { user_id: userId, target_scope_id: invite.target_scope_id, invite_type: invite.invite_type },
    );

    // ET-ENFORCE audit-2: fire team.member.joined so Matrix + webhook
    // subscribers see the new guest. teamId stays null (guest invites use
    // target_scope_id rather than team_id); the metadata carries the scope
    // and invite_type so consumers can route appropriately. Fire-and-forget.
    emitAndDispatch(database, {
        orgId:         invite.org_id,
        teamId:        invite.team_id || null,
        eventType:     'team.member.joined',
        actorId:       invite.invited_by || null,
        subjectUserId: userId,
        metadata: {
            invite_id:       invite.id,
            invite_type:     invite.invite_type,
            target_scope_id: invite.target_scope_id,
            email,
            via:             'guest_signup',
        },
    }).catch(err => console.error('[guest-signup] team-event dispatch failed:', err.message));

    const accessToken = createAccessToken({
        sub: userId,
        email,
        org_id: invite.org_id,
        role: 'viewer',
        session_id: sessionId,
        mfa_verified: false,
    });

    res.status(201).json({
        access_token:    accessToken,
        refresh_token:   refreshToken.signed,
        token_type:      'Bearer',
        expires_in:      3600,
        user:            { id: userId, email, display_name: displayName || email.split('@')[0] },
        org_id:          invite.org_id,
        target_scope_id: invite.target_scope_id,
        invite_type:     invite.invite_type,
    });
});

router.post('/invites/:token/accept-guest', authedOrTestUser, (req, res) => {
    lazyEnsure(req);
    try {
        const out = acceptGuestInvite(db(req), {
            token:  req.params.token,
            userId: req.user.id,
        });
        emitAudit(req, 'org.invite.guest_accepted', req.params.token, {
            user_id:         out.userId,
            target_scope_id: out.targetScopeId,
            invite_type:     out.inviteType,
        });
        res.json({
            user_id:         out.userId,
            org_id:          out.orgId,
            target_scope_id: out.targetScopeId,
            invite_type:     out.inviteType,
        });
    } catch (err) {
        const msg = String(err?.message || err);
        const status = /not found/i.test(msg) ? 404 : 400;
        return res.status(status).json({ error: 'invite_accept_failed', message: msg });
    }
});

export default router;
