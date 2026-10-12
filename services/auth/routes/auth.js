/**
 * Authentication routes for Quox Auth Service
 *
 * POST /signup - Create new user account
 * POST /login - Authenticate and get tokens
 * POST /logout - Revoke current session
 * POST /refresh - Refresh access token
 * POST /verify-email - Verify email address
 * POST /resend-verification - Resend verification email
 * POST /forgot-password - Request password reset
 * POST /reset-password - Complete password reset
 * GET /me - Get current user info
 * PATCH /me - Update user profile
 * PATCH /me/password - Change password
 * GET /me/export - Export all user data (GDPR Art. 15, 20)
 * DELETE /me - Delete user account (GDPR Art. 17)
 * POST /me/cancel-deletion - Cancel scheduled account deletion
 * GET /me/deletion-status - Check account deletion status
 */

import { pickAgentClaims } from '../utils/principal.js';
import { agentClaims } from '../utils/agentClaims.js';
import { Router } from 'express';
import contentDisposition from 'content-disposition';
import {
    generateId,
    generateToken,
    hashPassword,
    verifyPassword,
    createAccessToken,
    createRefreshToken,
    verifyToken,
    sha256
} from '../utils/crypto.js';
import { queries, transaction, getDb } from '../db/index.js';
import { pendingInviteForOrg } from '../utils/myInvites.js';
import { logAuthEvent, AuditActions } from '../utils/audit.js';
import { enforceSsoOnlyForEmail } from '../utils/ssoEnforcement.js';
import { enforceIpAllowlist, enforceMfaGate, enforceSessionPolicy } from '../utils/enforcement.js';
import { setAccessTokenCookie, resolveCookieSecure } from '../lib/accessTokenCookie.js';
import { resolveAppBaseUrl } from '../lib/instanceConfigOverrides.js';
import { mintEnrolmentTicket } from '../lib/mfaEnrolmentTicket.js';
import { getSessionPolicy, REMEMBER_ME_MAX_SESSION_SEC } from '../utils/sessionPolicy.js';
import { MFA_MODES } from '../utils/mfaPolicy.js';
import { autoJoinByVerifiedDomain } from '../utils/autoJoin.js';
import {
    createOrgWithDefaults,
    generateOrgSlug,
    resolveAvailableSlug,
    runPostOrgCreationProvisioning,
} from '../lib/orgProvisioning.js';
import { validatePassword as validatePasswordPolicy } from '../utils/passwordValidation.js';
import { authenticate } from '../middleware/authenticate.js';
import { authLimiter, passwordResetLimiter, emailVerifyLimiter, dataExportLimiter } from '../middleware/rateLimit.js';
import { checkInstanceAdmin } from '../middleware/instanceAdmin.js';
import { sendEmail } from '../utils/emailService.js';

const router = Router();

// ============================================================================
// Helper Functions
// ============================================================================

// Cookie secure flag - can be disabled for HTTP production deployments (Issue #115)
// COOKIE_SECURE and ACCESS_TOKEN_COOKIE_MAX_AGE_MS now live in
// lib/accessTokenCookie.js (imported above) so there is one owner of the
// access-token cookie's security attributes.

// TRUST-GATE-1.14 — single source of truth for the access-token cookie's
// maxAge so it can't drift out of sync with the JWT's own expiry (must
// match JWT_ACCESS_EXPIRY default of '1h' in utils/crypto.js). Previously
// /switch-org set this cookie with a hardcoded 15-minute maxAge while the
// access token itself remained valid for the full hour — the cookie would
// silently stop being sent 45 minutes before the token actually expired,
// surfacing as a premature "logged out" experience after switching orgs.

function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// Use shared password validation from utils/passwordValidation.js
function validatePassword(password) {
    return validatePasswordPolicy(password);
}

// ET-ENFORCE E — parse orgs.security_flags_json.mfa.mode, defaulting to
// 'optional' if unset or malformed. Organisations flip this via the
// PUT /orgs/:orgId/security/mfa surface.
function parseOrgMfaMode(org) {
    if (!org?.security_flags_json) return MFA_MODES.OPTIONAL;
    try {
        const flags = typeof org.security_flags_json === 'string'
            ? JSON.parse(org.security_flags_json)
            : org.security_flags_json;
        return flags?.mfa?.mode || MFA_MODES.OPTIONAL;
    } catch {
        return MFA_MODES.OPTIONAL;
    }
}

function generateVerificationToken() {
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
    return { token, expiresAt };
}

// AUTH-REMEMBER-ME: refresh_token cookie maxAge matches the JWT's own
// expiry, same "single source of truth" reasoning as ACCESS_TOKEN_COOKIE_MAX_AGE_MS
// above — remember-me logins mint a longer-lived refresh JWT (see login route),
// so the cookie must be extended to match or it would silently stop being
// sent well before the token actually expires.
const REFRESH_TOKEN_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (default / non-remember-me)

function setAuthCookies(res, accessToken, refreshToken, { rememberMeMaxAgeMs = null } = {}) {
    // Access token - httpOnly, 1 hour expiry. Policy owned by
    // lib/accessTokenCookie.js so login, refresh, org-switch and MFA verify
    // cannot drift apart.
    setAccessTokenCookie(res, accessToken);

    // Refresh token - long lived, httpOnly, path restricted. When
    // rememberMeMaxAgeMs is supplied (remember-me opted in + org allows
    // it), the cookie is extended to match the longer-lived refresh JWT.
    res.cookie('refresh_token', refreshToken.signed, {
        httpOnly: true,
        secure: resolveCookieSecure(),
        sameSite: 'lax',  // Allows top-level navigation, protects against CSRF on cross-site POST
        path: '/api/auth/refresh',
        maxAge: rememberMeMaxAgeMs || REFRESH_TOKEN_COOKIE_MAX_AGE_MS
    });
}

function clearAuthCookies(res) {
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
}

async function sendVerificationEmail(email, token, displayName) {
    const base = resolveAppBaseUrl();
    const link = `${base}/verify-email?token=${encodeURIComponent(token)}`;
    const who  = displayName || email.split('@')[0];
    const plain = [
        `Hi ${who},`,
        ``,
        `Please verify your email address to activate your Quox account:`,
        link,
        ``,
        `If you didn't create this account, you can ignore this email.`,
    ].join('\n');
    const html = `
        <p>Hi ${who},</p>
        <p>Please verify your email address to activate your Quox account.</p>
        <p><a href="${link}" style="background:#38bdf8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Verify email</a></p>
        <p>Or paste this link into your browser:<br/><code>${link}</code></p>
        <p style="color:#888;font-size:12px">If you didn't create this account, you can ignore this email.</p>
    `;
    try {
        const result = await sendEmail({
            to:      email,
            subject: 'Verify your Quox email address',
            text:    plain,
            html,
        });
        if (!result.delivered) {
            console.log(`[EMAIL] verification email not delivered (${result.reason}) — to=${email} at ${new Date().toISOString()}`);
        }
        return true;
    } catch (err) {
        console.error('[EMAIL] verification email send failed:', err.message);
        return true;
    }
}

async function sendPasswordResetEmail(email, token) {
    const base = resolveAppBaseUrl();
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
    const plain = [
        `Hi,`,
        ``,
        `We received a request to reset your Quox password. This link expires in 1 hour:`,
        link,
        ``,
        `If you didn't request this, you can ignore this email.`,
    ].join('\n');
    const html = `
        <p>Hi,</p>
        <p>We received a request to reset your Quox password. This link expires in 1 hour.</p>
        <p><a href="${link}" style="background:#38bdf8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Reset password</a></p>
        <p>Or paste this link into your browser:<br/><code>${link}</code></p>
        <p style="color:#888;font-size:12px">If you didn't request this, you can ignore this email.</p>
    `;
    try {
        const result = await sendEmail({
            to:      email,
            subject: 'Reset your Quox password',
            text:    plain,
            html,
        });
        if (!result.delivered) {
            console.log(`[EMAIL] password reset email not delivered (${result.reason}) — to=${email} at ${new Date().toISOString()}`);
        }
        return true;
    } catch (err) {
        console.error('[EMAIL] password reset email send failed:', err.message);
        return true;
    }
}

// ============================================================================
// Account Lockout (Security Issue #47)
// ============================================================================

const LOCKOUT_CONFIG = {
    maxAttempts: 5,              // Lock after 5 failed attempts
    // Exponential backoff durations in minutes: 1, 5, 15, 60
    lockoutDurations: [1, 5, 15, 60]
};

/**
 * Calculate lockout duration based on failed attempt count
 * Uses exponential backoff: 1 min, 5 min, 15 min, 1 hour
 */
function calculateLockoutDuration(failedCount) {
    // How many times account has been locked (every 5 failures = 1 lockout)
    const lockoutIndex = Math.floor((failedCount - 1) / LOCKOUT_CONFIG.maxAttempts);
    // Cap at the maximum duration
    const durationIndex = Math.min(lockoutIndex, LOCKOUT_CONFIG.lockoutDurations.length - 1);
    return LOCKOUT_CONFIG.lockoutDurations[durationIndex];
}

/**
 * Check if account is currently locked
 * Returns { locked: boolean, remainingSeconds?: number }
 */
function checkAccountLockout(user) {
    if (!user.lockout_until) {
        return { locked: false };
    }

    const lockoutUntil = new Date(user.lockout_until);
    const now = new Date();

    if (now < lockoutUntil) {
        const remainingMs = lockoutUntil.getTime() - now.getTime();
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        return { locked: true, remainingSeconds };
    }

    return { locked: false };
}

/**
 * Handle failed login attempt - increment counter and potentially lock account
 */
function handleFailedLogin(userId) {
    // Increment failed login count
    queries.incrementFailedLogin(userId);

    // Get updated attempt info
    const attemptInfo = queries.getLoginAttemptInfo(userId);
    const failedCount = attemptInfo.failed_login_count;

    // Check if we should lock the account (every 5 failures)
    if (failedCount >= LOCKOUT_CONFIG.maxAttempts && failedCount % LOCKOUT_CONFIG.maxAttempts === 0) {
        const lockoutMinutes = calculateLockoutDuration(failedCount);
        const lockoutUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000).toISOString();
        queries.setAccountLockout(userId, lockoutUntil);

        return {
            locked: true,
            lockoutMinutes,
            failedCount
        };
    }

    return {
        locked: false,
        failedCount,
        attemptsRemaining: LOCKOUT_CONFIG.maxAttempts - (failedCount % LOCKOUT_CONFIG.maxAttempts)
    };
}

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /signup
 * Create a new user account
 */

// SVC-AUTH #447 bridge (2026-08-15): an "agent ops" account is a real user a
// governed agent session operates. Its JWTs carry agent_ops:true so (a) the
// tasks service's HITL gates can REJECT it (the no-agent-self-approval
// invariant becomes enforceable, not promised) while ordinary org-scoped
// operations accept it, and (b) session idle-timeout exempts it (agents have
// legitimate long thinking gaps — the original #447 complaint). The flag
// lives in users.metadata_json and NEVER grants anything; it only restricts.
function isAgentOpsUser(user) {
    try { return !!JSON.parse(user?.metadata_json || '{}').agent_ops; }
    catch { return false; }
}

router.post('/signup', authLimiter, async (req, res) => {
    try {
        const { email, password, display_name } = req.body;

        // Validate input
        if (!email || !password) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Email and password are required'
            });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Invalid email address'
            });
        }

        const passwordValidation = validatePassword(password);
        if (!passwordValidation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: passwordValidation.message
            });
        }

        // Check if email already exists
        const existingUser = queries.getUserByEmail(email.toLowerCase());
        if (existingUser) {
            return res.status(409).json({
                error: 'email_exists',
                message: 'An account with this email already exists'
            });
        }

        // Create user
        const userId = generateId();
        const emailId = generateId();
        const authId = generateId();
        const passwordHash = await hashPassword(password);
        const { token: verificationToken, expiresAt: verificationExpires } = generateVerificationToken();

        transaction(() => {
            // Create user - auto-verified for MVP (no SMTP configured)
            queries.createUser({
                id: userId,
                primary_email: email.toLowerCase(),
                display_name: display_name || email.split('@')[0],
                status: 'active'
            });

            // Create email record - pre-verified for MVP
            queries.createUserEmail({
                id: emailId,
                user_id: userId,
                email: email.toLowerCase(),
                is_primary: true,
                verified_at: new Date().toISOString(),
                verification_token: null,
                verification_expires_at: null
            });

            // Create password identity
            queries.createAuthIdentity({
                id: authId,
                user_id: userId,
                provider: 'password',
                password_hash: passwordHash
            });
        });

        // Send verification email
        await sendVerificationEmail(email, verificationToken, display_name);

        // ET-ENFORCE F — verified-domain auto-join. If the new user's email
        // domain is owned by a verified org, give them a viewer membership
        // so they don't have to be invited explicitly. Idempotent + emits
        // org.member.auto_joined audit. Failures are non-fatal — signup
        // must not break because of a downstream join issue.
        let autoJoined = null;
        try {
            const join = autoJoinByVerifiedDomain(getDb(), {
                userId,
                email: email.toLowerCase(),
            });
            if (join.joined) autoJoined = { org_id: join.orgId, role: join.role };
        } catch (joinErr) {
            console.error('[signup] auto-join failed (non-fatal):', joinErr.message);
        }

        // GTM-A1/B3: give the new account a workspace.
        //
        // Until now, UI signup produced a user with NO organisation and no
        // onboarding to fix it: org-scoped calls fired with an empty id and
        // 400'd, the sidebar silently dropped four sections, and the only way
        // to get an org was `quox org create` from a terminal, which nothing
        // in the product mentions. A user who is auto-joined to a verified
        // domain org already has a workspace, so only provision when they do
        // not.
        //
        // Non-fatal by the same contract as auto-join above: a provisioning
        // hiccup must degrade to the old orgless state, never fail account
        // creation. The account is already committed at this point.
        const resolvedDisplayName = display_name || email.split('@')[0];
        let provisionedOrg = null;
        if (!autoJoined) {
            try {
                const orgName = `${resolvedDisplayName}'s Workspace`;
                const slug = resolveAvailableSlug(generateOrgSlug(orgName) || 'workspace');
                const created = createOrgWithDefaults({
                    name: orgName,
                    slug,
                    description: null,
                    userId
                });
                provisionedOrg = { org_id: created.orgId, role: 'owner', name: orgName, slug: created.slug };
                await runPostOrgCreationProvisioning(getDb(), { orgId: created.orgId, userId });
            } catch (orgErr) {
                console.error('[signup] workspace provisioning failed (non-fatal):', orgErr.message);
            }
        }

        const activeOrgId = autoJoined?.org_id || provisionedOrg?.org_id || null;
        const activeOrgRole = autoJoined?.role || (provisionedOrg ? 'owner' : null);

        // Log signup
        logAuthEvent(AuditActions.AUTH_SIGNUP, userId, req, {
            email,
            auto_joined_org_id: autoJoined?.org_id || null,
            provisioned_org_id: provisionedOrg?.org_id || null
        });

        // GTM-A1/B5: sign the new user in.
        //
        // Signup used to return 201 and bounce the user back to the login form
        // to retype the credentials they had just chosen, at the exact moment
        // they have the most momentum. Mint the same session, tokens and
        // cookies /login does, so the account is usable immediately.
        //
        // Also non-fatal: if session creation fails, fall back to the old
        // "now go and log in" response rather than losing the account.
        // GTM-A1 (second-eye): do NOT auto-sign-in on an sso_only domain.
        // Login refuses password sessions for sso_only domains via
        // enforceSsoOnlyForEmail; signup's auto sign-in must apply the same
        // rule, otherwise a user on an sso_only domain gains a password
        // session by signing up instead of logging in. The account is still
        // created; the user must complete SSO to get a session.
        const ssoOnly = enforceSsoOnlyForEmail(getDb(), email.toLowerCase());

        let session = null;
        if (!ssoOnly) try {
            const sessionId = generateId();
            const refreshToken = createRefreshToken({ sub: userId, session_id: sessionId });

            queries.createSession({
                id: sessionId,
                user_id: userId,
                org_id: activeOrgId,
                refresh_token_hash: refreshToken.hash,
                device_fingerprint: req.headers['user-agent']?.slice(0, 100),
                ip_address: req.ip,
                user_agent: req.headers['user-agent']?.slice(0, 500),
                expires_at: refreshToken.expiresAt,
                remember_me: false
            });

            const accessToken = createAccessToken({
                sub: userId,
                email: email.toLowerCase(),
                org_id: activeOrgId,
                role: activeOrgRole,
                session_id: sessionId,
                mfa_verified: false
            });

            setAuthCookies(res, accessToken, refreshToken);
            session = { accessToken, refreshToken };
        } catch (sessionErr) {
            console.error('[signup] auto sign-in failed (non-fatal):', sessionErr.message);
        }

        const orgPayload = provisionedOrg
            ? { id: provisionedOrg.org_id, name: provisionedOrg.name, slug: provisionedOrg.slug, role: 'owner' }
            : null;

        res.status(201).json({
            success: true,
            message: session
                ? 'Account created successfully.'
                : ssoOnly
                    ? 'Account created. Your organisation requires single sign-on, please continue with SSO.'
                    : 'Account created successfully. You can now log in.',
            signed_in: Boolean(session),
            ...(ssoOnly ? { sso_required: true, sso_login_url: ssoOnly.login_url } : {}),
            user: {
                id: userId,
                email: email.toLowerCase(),
                display_name: resolvedDisplayName,
                status: 'active',
                auto_joined_org: autoJoined,
                org: orgPayload,
            },
            org: orgPayload,
            ...(session ? {
                access_token: session.accessToken,
                refresh_token: session.refreshToken.signed,
                token_type: 'Bearer',
                expires_in: 3600,
            } : {})
        });

    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({
            error: 'signup_failed',
            message: 'Failed to create account'
        });
    }
});

/**
 * POST /login
 * Authenticate user and return tokens
 */
router.post('/login', authLimiter, async (req, res) => {
    try {
        const { email, password, org_id, remember_me } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Email and password are required'
            });
        }

        // ET-2 Phase C: sso_only enforcement. Runs at the domain level
        // BEFORE user lookup so it cannot be used as a user-existence
        // oracle — the response is identical whether or not the user
        // actually exists, as long as the domain is sso_only.
        const ssoBlock = enforceSsoOnlyForEmail(getDb(), email.toLowerCase());
        if (ssoBlock) {
            logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, null, req, {
                email, reason: 'sso_required', provider_id: ssoBlock.provider_id,
            });
            return res.status(403).json({
                error:        'sso_required',
                message:      `This domain requires single sign-on via ${ssoBlock.display_name}.`,
                provider_id:  ssoBlock.provider_id,
                provider_key: ssoBlock.provider_key,
                login_url:    ssoBlock.login_url,
            });
        }

        // Find user
        const user = queries.getUserByEmail(email.toLowerCase());
        if (!user) {
            logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, null, req, {
                email,
                reason: 'user_not_found'
            });
            return res.status(401).json({
                error: 'invalid_credentials',
                message: 'Invalid email or password'
            });
        }

        // Check account lockout (Security Issue #47)
        const lockoutStatus = checkAccountLockout(user);
        if (lockoutStatus.locked) {
            const remainingMinutes = Math.ceil(lockoutStatus.remainingSeconds / 60);
            logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, user.id, req, {
                reason: 'account_locked',
                remaining_seconds: lockoutStatus.remainingSeconds
            });
            return res.status(423).json({
                error: 'account_locked',
                message: `Account is temporarily locked. Please try again in ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}.`,
                retry_after: lockoutStatus.remainingSeconds
            });
        }

        // Check user status
        if (user.status === 'suspended') {
            logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, user.id, req, {
                reason: 'account_suspended'
            });
            return res.status(403).json({
                error: 'account_suspended',
                message: 'Your account has been suspended'
            });
        }

        if (user.status === 'deleted') {
            return res.status(401).json({
                error: 'invalid_credentials',
                message: 'Invalid email or password'
            });
        }

        // P2 (QUOXPERTICUS governed identity): only a human identity may log
        // in interactively. An agent-as-user row (actor_type 'agent', e.g.
        // the resident agent's mcp_token binding) or a service principal must
        // never hold a password session, or it would masquerade as a human to
        // every gate that derives actor type from credential class (DEC-2).
        if (user.actor_type && user.actor_type !== 'human') {
            logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, user.id, req, {
                reason: 'non_human_actor_type',
                actor_type: user.actor_type
            });
            return res.status(403).json({
                error: 'agent_identity',
                message: 'This identity is a non-human principal and cannot log in interactively'
            });
        }

        // Get password identity
        const passwordIdentity = queries.getPasswordIdentity(user.id);
        if (!passwordIdentity) {
            return res.status(401).json({
                error: 'invalid_credentials',
                message: 'Invalid email or password'
            });
        }

        // Verify password
        const validPassword = await verifyPassword(passwordIdentity.password_hash, password);
        if (!validPassword) {
            // Handle failed login with lockout logic (Security Issue #47)
            const lockoutResult = handleFailedLogin(user.id);

            logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, user.id, req, {
                reason: 'invalid_password',
                failed_count: lockoutResult.failedCount,
                account_locked: lockoutResult.locked
            });

            if (lockoutResult.locked) {
                return res.status(423).json({
                    error: 'account_locked',
                    message: `Too many failed login attempts. Account locked for ${lockoutResult.lockoutMinutes} minute${lockoutResult.lockoutMinutes > 1 ? 's' : ''}.`,
                    retry_after: lockoutResult.lockoutMinutes * 60
                });
            }

            return res.status(401).json({
                error: 'invalid_credentials',
                message: 'Invalid email or password'
            });
        }

        // Check email verification for non-verified users
        if (user.status === 'pending_verification') {
            return res.status(403).json({
                error: 'email_not_verified',
                message: 'Please verify your email address before logging in'
            });
        }

        // Reset failed login counter on successful authentication (Security Issue #47)
        if (user.failed_login_count > 0) {
            queries.resetFailedLogins(user.id);
        }

        // Get org membership — auto-resolve default org if none specified
        let orgRole = null;
        let activeOrg = null;
        let resolvedOrgId = org_id;
        if (!resolvedOrgId) {
            const userOrgs = queries.getUserOrgs(user.id);
            if (userOrgs.length > 0) {
                resolvedOrgId = userOrgs[0].id;
            }
        }
        if (resolvedOrgId) {
            const membership = queries.getOrgMembership(resolvedOrgId, user.id);
            if (membership && membership.status === 'active') {
                orgRole = membership.role;
                activeOrg = queries.getOrgById(resolvedOrgId);
            }
        }

        // ET-ENFORCE round-4 — deprovisioned-user persistence guard. SCIM
        // DELETE / admin-remove flips org_memberships.status to 'removed'
        // but does not touch users.status. Without this check a user can
        // re-login with their existing password and obtain a fresh access
        // + refresh token with org_id=null — bypassing the
        // membership_revoked path in authenticate() (which requires an
        // org_id in the JWT to fire). They'd retain access to /me/*
        // (export personal data, change password, etc).
        //
        // Rule: if the user has at least one terminal membership row
        // (removed / suspended / left) and ZERO active memberships,
        // refuse login. They need a fresh invite to come back. Users with
        // no membership history (genuinely brand-new accounts pre-org)
        // are unaffected.
        try {
            const counts = getDb().prepare(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count
                FROM org_memberships WHERE user_id = ?
            `).get(user.id);
            if (counts && counts.total > 0 && counts.active_count === 0) {
                logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, user.id, req, {
                    reason: 'no_active_memberships',
                });
                return res.status(403).json({
                    error:   'deprovisioned',
                    message: 'Your access has been removed. Contact your administrator for a new invite.',
                });
            }
        } catch (err) {
            // Non-fatal — fall through to normal login flow.
            console.error('[login] deprovision check failed (non-fatal):', err.message);
        }

        // ET-ENFORCE E — enforce org-scoped login policies before issuing
        // credentials: IP allowlist + MFA-required mode.
        if (resolvedOrgId) {
            const db = getDb();
            const ipVerdict = enforceIpAllowlist(db, { orgId: resolvedOrgId, ip: req.ip });
            if (!ipVerdict.allowed) {
                logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, user.id, req, {
                    reason: 'ip_not_allowed',
                    org_id: resolvedOrgId,
                });
                return res.status(403).json({
                    error:   'ip_not_allowed',
                    message: 'Your IP address is not on this organisation’s allowlist.',
                });
            }
            const mfaMode = parseOrgMfaMode(activeOrg);
            const mfaVerdict = enforceMfaGate({
                mode:        mfaMode,
                userHasMfa:  !!user.mfa_enabled,
                mfaVerified: false,
                userRole:    orgRole,
                phase:       'login',
            });
            if (!mfaVerdict.allowed) {
                logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, user.id, req, {
                    reason: mfaVerdict.reason,
                    org_id: resolvedOrgId,
                });
                // LAUNCH-SPINE: an unenrolled user is refused here and gets no
                // session, but /mfa/setup needs one — which made this org's MFA
                // requirement unsatisfiable for anyone not already enrolled.
                // Mint a single-purpose enrolment ticket so they can break the
                // deadlock. Safe to issue: the password check above already
                // passed, so this is not a way around the first factor. The
                // ticket authorises enrolment and nothing else.
                let enrolmentTicket = null;
                if (mfaVerdict.reason === 'mfa_enrollment_required') {
                    try {
                        enrolmentTicket = mintEnrolmentTicket(getDb(), {
                            userId: user.id,
                            orgId:  resolvedOrgId,
                            ip:     req.ip,
                        }).ticket;
                    } catch (ticketErr) {
                        // Never let ticket minting turn a clean 403 into a 500.
                        console.warn('[Auth] enrolment ticket mint failed (non-fatal):', ticketErr.message);
                    }
                }
                return res.status(403).json({
                    error:    mfaVerdict.reason,
                    required: true,
                    message:  'This organisation requires multi-factor authentication. Enroll before signing in.',
                    ...(enrolmentTicket ? { enrolment_ticket: enrolmentTicket, enrolment_expires_in_seconds: 600 } : {}),
                });
            }
        }

        // SCOPE-JWT-3: revoke any prior active session bound to this same
        // browser cookie before minting a new one. Without this, a re-login
        // (without an explicit /logout) leaves the old session active in the
        // DB. The user ends up with multiple active sessions — the browser
        // refresh-cookie can be bound to the older one, so /api/auth/refresh
        // mints a JWT carrying the OLD session's stale org_id even though
        // the new login picked the correct one. (Caught in the 2026-05-10
        // SCOPE-JWT investigation: Adam had a 13:04 Hot Tubs session AND a
        // 13:05 QUOX DEV session, browser was bound to the older one.)
        const priorRefreshToken = req.cookies?.refresh_token;
        if (priorRefreshToken) {
            try {
                const priorPayload = verifyToken(priorRefreshToken);
                if (priorPayload?.session_id) {
                    queries.revokeSession(priorPayload.session_id);
                }
            } catch {
                // Invalid/expired prior token — nothing to revoke. Don't fail login.
            }
        }

        // AUTH-REMEMBER-ME: "remember me" only takes effect if the user
        // opted in AND the org's session policy allows it (org can opt out
        // via PUT /orgs/:orgId/security/session-policy). Idle timeout is
        // unaffected either way — enforceSessionPolicy() still applies it
        // on every request. Server stays authoritative: a client sending
        // remember_me=true against a policy that disallows it is silently
        // downgraded to a normal session, not honoured.
        const loginSessionPolicy = getSessionPolicy(getDb(), resolvedOrgId || null);
        const rememberMeActive = !!remember_me && loginSessionPolicy.rememberMeEnabled;

        // Create session
        const sessionId = generateId();
        const refreshToken = createRefreshToken({
            sub: user.id,
            session_id: sessionId
        }, rememberMeActive ? { expiresIn: `${REMEMBER_ME_MAX_SESSION_SEC / 86400}d` } : {});

        queries.createSession({
            id: sessionId,
            user_id: user.id,
            org_id: resolvedOrgId || null,
            refresh_token_hash: refreshToken.hash,
            device_fingerprint: req.headers['user-agent']?.slice(0, 100),
            ip_address: req.ip,
            user_agent: req.headers['user-agent']?.slice(0, 500),
            expires_at: refreshToken.expiresAt,
            remember_me: rememberMeActive
        });

        // Create access token (carries session_id so authenticate()
        // middleware can enforce session policy / idle timeout per request)
        const accessToken = createAccessToken({
            sub: user.id,
            email: user.primary_email,
            org_id: resolvedOrgId || null,
            role: orgRole,
            session_id: sessionId,
            mfa_verified: false,  // Will be true after MFA verification
            ...(isAgentOpsUser(user) ? { agent_ops: true } : {})
        });

        // Set cookies — remember-me extends the refresh_token cookie's
        // maxAge to match the longer-lived refresh JWT minted above.
        setAuthCookies(res, accessToken, refreshToken, {
            rememberMeMaxAgeMs: rememberMeActive ? REMEMBER_ME_MAX_SESSION_SEC * 1000 : null
        });

        // Log login
        logAuthEvent(AuditActions.AUTH_LOGIN, user.id, req, {
            org_id: resolvedOrgId,
            session_id: sessionId,
            remember_me: rememberMeActive
        });

        // Check if MFA is required
        const mfaRequired = user.mfa_enabled;

        // SCOPE-JWT-1: also embed org inside user so WorkspaceContext fast
        // path (user?.org) fires immediately after login without waiting on /me.
        const orgPayload = activeOrg ? {
            id: activeOrg.id,
            name: activeOrg.name,
            slug: activeOrg.slug,
            role: orgRole
        } : null;

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.primary_email,
                display_name: user.display_name,
                mfa_enabled: !!user.mfa_enabled,
                org: orgPayload
            },
            org: orgPayload,
            mfa_required: mfaRequired,
            access_token: accessToken,
            refresh_token: refreshToken.signed,
            token_type: 'Bearer',
            expires_in: 3600,  // 1 hour (matches JWT_ACCESS_EXPIRY)
            remember_me: rememberMeActive
        });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({
            error: 'login_failed',
            message: 'Login failed'
        });
    }
});

/**
 * POST /logout
 * Revoke current session
 */
router.post('/logout', authenticate({ required: false }), async (req, res) => {
    try {
        // Get refresh token from cookie or body
        const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;

        if (refreshToken) {
            // Verify and decode token
            const payload = verifyToken(refreshToken);
            if (payload && payload.session_id) {
                // Revoke session
                queries.revokeSession(payload.session_id);

                // Log logout
                if (req.user) {
                    logAuthEvent(AuditActions.AUTH_LOGOUT, req.user.id, req, {
                        session_id: payload.session_id
                    });
                }
            }
        }

        // Clear cookies
        clearAuthCookies(res);

        res.json({
            success: true,
            message: 'Logged out successfully'
        });

    } catch (err) {
        console.error('Logout error:', err);
        // Still clear cookies even if revocation fails
        clearAuthCookies(res);
        res.json({
            success: true,
            message: 'Logged out'
        });
    }
});

/**
 * POST /refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', async (req, res) => {
    try {
        // Get refresh token from cookie or body
        const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;

        if (!refreshToken) {
            return res.status(401).json({
                error: 'no_refresh_token',
                message: 'Refresh token required'
            });
        }

        // Verify token
        const payload = verifyToken(refreshToken);
        if (!payload || payload.type !== 'refresh') {
            return res.status(401).json({
                error: 'invalid_refresh_token',
                message: 'Invalid or expired refresh token'
            });
        }

        // Check session exists and is valid
        // LAUNCH-SPINE: look the session up by the jti PREFIX, not sha256(jti).
        // The jti is already the first 16 chars of the stored
        // refresh_token_hash, so hashing it again produced a value that matched
        // nothing and made every refresh return 401 session_revoked. See
        // db/index.js:getSessionByRefreshJti.
        const session = queries.getSessionByRefreshJti(payload.jti || '', payload.sub);

        // ET-ENFORCE D/E audit fix — getSessionByTokenHash filters on
        // revoked_at IS NULL. A null row means SCIM deprovision (or the
        // session-policy enforcer) revoked this session. Refresh must
        // not silently mint a new access token in that case; reject so
        // the client can show a clean re-login prompt.
        if (!session) {
            return res.status(401).json({
                error: 'session_revoked',
                message: 'Your session has been revoked. Please sign in again.',
            });
        }

        // Get user
        const user = queries.getUserById(payload.sub);
        if (!user || user.status !== 'active') {
            return res.status(401).json({
                error: 'user_invalid',
                message: 'User not found or inactive'
            });
        }

        // ET-ENFORCE E — refresh must not bypass idle / max-session
        // timeouts. If the session is past either policy window, revoke
        // it and force a fresh login. Without this, a user could refresh
        // indefinitely and only trip the policy on the very next API call.
        const refreshDb = getDb();
        const sessionVerdict = enforceSessionPolicy(refreshDb, {
            sessionId: session.id,
            userId:    user.id,
        });
        if (!sessionVerdict.allowed) {
            return res.status(401).json({
                error:   'session_expired',
                reason:  sessionVerdict.reason,
                message: 'Your session has expired — please sign in again.',
            });
        }

        // ET-ENFORCE E audit fix — refresh must also honour the org's
        // IP allowlist, otherwise a token captured on an allowed network
        // can be refreshed indefinitely from anywhere. Per-request
        // authenticate() already enforces this on access-token-protected
        // routes, but refresh itself was a gap.
        if (session.org_id) {
            const ipVerdict = enforceIpAllowlist(refreshDb, { orgId: session.org_id, ip: req.ip });
            if (!ipVerdict.allowed) {
                return res.status(403).json({
                    error:   'ip_not_allowed',
                    message: 'Your IP address is not on this organisation’s allowlist.',
                });
            }
        }

        // Resolve org context — prefer session org_id (updated by switch-org)
        // over refresh token payload (which may be stale)
        let refreshOrgId = null;
        let refreshRole = null;

        // Try session org_id first (updated by switch-org), then refresh token, then latest session
        if (session?.org_id) {
            refreshOrgId = session.org_id;
        } else {
            // Session lookup may fail — check latest active session for this user
            const latestSession = queries.getLatestSessionOrg(user.id);
            if (latestSession?.org_id) {
                refreshOrgId = latestSession.org_id;
            } else if (payload.org_id) {
                refreshOrgId = payload.org_id;
            }
        }

        // If still no org, auto-resolve from user's memberships
        if (!refreshOrgId) {
            const userOrgs = queries.getUserOrgs(user.id);
            if (userOrgs.length > 0) {
                refreshOrgId = userOrgs[0].id;
            }
        }

        // Resolve role for the org
        if (refreshOrgId) {
            const membership = queries.getOrgMembership(refreshOrgId, user.id);
            refreshRole = membership?.status === 'active' ? membership.role : null;
        }

        // Create new access token (carry session_id so per-request
        // session-policy enforcement still has a handle after refresh)
        const accessToken = createAccessToken({
            ...(isAgentOpsUser(user) ? { agent_ops: true } : {}),
            ...agentClaims(user, payload),
            ...pickAgentClaims(payload),
            sub: user.id,
            email: user.primary_email,
            org_id: refreshOrgId || null,
            role: refreshRole || null,
            session_id: session?.id || payload.session_id || null,
            // LAUNCH-SPINE: read mfa_verified from the SESSION ROW, which is
            // where POST /api/mfa/verify records it, not from the refresh
            // token payload. The payload was minted at login with false and
            // never updated, so copying it silently demoted a user who had
            // just passed the MFA challenge back to unverified on their next
            // refresh — locking them out of an MFA-required org again. Falls
            // back to the payload when no session row is available.
            mfa_verified: session?.mfa_verified != null
                ? !!session.mfa_verified
                : !!payload.mfa_verified
        });

        // Set new access token cookie
        setAccessTokenCookie(res, accessToken);

        res.json({
            success: true,
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600  // 1 hour (matches JWT_ACCESS_EXPIRY)
        });

    } catch (err) {
        console.error('Token refresh error:', err);
        res.status(500).json({
            error: 'refresh_failed',
            message: 'Token refresh failed'
        });
    }
});

/**
 * POST /switch-org
 * Switch organization context without re-authenticating
 * Phase 2: Multi-tenancy support
 */
router.post('/switch-org', authenticate({ required: true }), async (req, res) => {
    try {
        const { org_id } = req.body;
        const userId = req.user.id;

        if (!org_id) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'org_id is required'
            });
        }

        // Verify user is a member of the target org
        const membership = queries.getOrgMembership(org_id, userId);
        if (!membership || membership.status !== 'active') {
            // GRIPE-712: an un-accepted invite gets a pointer, not a bare refusal.
            try {
                const pending = pendingInviteForOrg(getDb(), userId, org_id);
                if (pending) {
                    return res.status(403).json({
                        error: 'pending_invitation',
                        message: `You have a pending invitation to ${pending.org_name}: run \`quox invites accept ${pending.id}\``,
                        invite_id: pending.id,
                        organization: { id: pending.org_id, name: pending.org_name },
                    });
                }
            } catch { /* fall through */ }
            return res.status(403).json({
                error: 'not_org_member',
                message: 'You are not a member of this organization'
            });
        }

        // Get org details
        const org = queries.getOrgById(org_id);
        if (!org || org.deleted_at) {
            return res.status(404).json({
                error: 'org_not_found',
                message: 'Organization not found'
            });
        }

        // Get user for token payload
        const user = queries.getUserById(userId);

        // ET-ENFORCE round-3: switch-org is a credential-mint path. Mirror
        // login's IP allowlist + MFA-required gates so a token captured on
        // an allowed network for ORG_A can't pivot into ORG_B from outside
        // ORG_B's allowlist, and so MFA-required orgs aren't bypassed by
        // switching from a non-MFA org.
        const switchDb = getDb();
        const ipVerdict = enforceIpAllowlist(switchDb, { orgId: org_id, ip: req.ip });
        if (!ipVerdict.allowed) {
            return res.status(403).json({
                error:   'ip_not_allowed',
                message: 'Your IP address is not on this organisation’s allowlist.',
            });
        }
        const mfaMode = parseOrgMfaMode(org);
        // ET-ENFORCE round-4 — when switching INTO an org with MFA required,
        // force a fresh challenge regardless of the current session's
        // mfa_verified flag. The flag is global on the JWT and was set when
        // the user verified in (potentially) a different org with mode=optional.
        // Without this gate, switch-org becomes an MFA-bypass primitive: log
        // into a low-security org, MFA there, then switch into a high-security
        // org without ever re-challenging. We use phase='request' (not
        // 'login') so enforceMfaGate returns mfa_challenge_required when the
        // user is enrolled but not verified for THIS org.
        const mfaVerdict = enforceMfaGate({
            mode:        mfaMode,
            userHasMfa:  !!user.mfa_enabled,
            mfaVerified: false,  // ALWAYS require fresh challenge on org switch
            userRole:    membership.role,
            phase:       'request',
        });
        if (!mfaVerdict.allowed) {
            return res.status(403).json({
                error:    mfaVerdict.reason,
                required: true,
                message:  mfaVerdict.reason === 'mfa_enrollment_required'
                    ? 'Enroll in multi-factor authentication before switching to this organisation.'
                    : 'Re-verify multi-factor authentication for this organisation.',
            });
        }

        // Update session org_id so token refresh preserves org context
        // ET-ENFORCE round-3: scope the update to the calling session only,
        // so switch-org doesn't silently flip org context on the user's
        // other devices. req.user.sessionId is set by authenticate() from
        // the access-token payload.
        queries.updateSessionOrg(userId, org_id, req.user?.sessionId || null);

        // Create new access token with updated org context (keep the
        // same session_id so session-policy continuity survives switch-org)
        const accessToken = createAccessToken({
            ...(isAgentOpsUser(user) ? { agent_ops: true } : {}),
            // An agent stays an agent across an org switch (2026-10-11 attribution fix).
            ...agentClaims(user, req.user),
            ...pickAgentClaims(req.user),
            sub: user.id,
            email: user.primary_email,
            org_id: org_id,
            role: membership.role,
            session_id: req.user?.sessionId || null,
            mfa_verified: req.user.mfaVerified || false
        });

        // Update access token cookie — maxAge must match the access token's
        // own TTL (see ACCESS_TOKEN_COOKIE_MAX_AGE_MS). This previously
        // used a hardcoded 15 minutes while the token itself lived 1 hour,
        // causing the cookie to stop being sent well before the token
        // actually expired (premature logout after switching orgs).
        setAccessTokenCookie(res, accessToken);

        // Log org switch
        // fleet #438: org_switch had 134 envelopes and ZERO org-tagged, despite
        // being the one auth event whose org is never in doubt: the org it
        // switched to. Tagged explicitly.
        logAuthEvent(AuditActions.AUTH_ORG_SWITCH || 'auth.org_switch', user.id, req, {
            from_org_id: req.org?.id || null,
            to_org_id: org_id
        }, org_id);

        res.json({
            success: true,
            org: {
                id: org.id,
                name: org.name,
                slug: org.slug,
                plan: org.plan
            },
            role: membership.role,
            access_token: accessToken
        });

    } catch (err) {
        console.error('Org switch error:', err);
        res.status(500).json({
            error: 'switch_failed',
            message: 'Failed to switch organization'
        });
    }
});

/**
 * POST /verify-email
 * Verify email address with token
 */
router.post('/verify-email', async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Verification token required'
            });
        }

        // Find email by token
        const userEmail = queries.getUserEmailByToken(token);
        if (!userEmail) {
            return res.status(400).json({
                error: 'invalid_token',
                message: 'Invalid or expired verification token'
            });
        }

        // Check expiry
        if (new Date(userEmail.verification_expires_at) < new Date()) {
            return res.status(400).json({
                error: 'token_expired',
                message: 'Verification token has expired'
            });
        }

        // Verify email
        transaction(() => {
            queries.verifyUserEmail(userEmail.id);

            // Activate user if this is their primary email
            if (userEmail.is_primary) {
                queries.updateUser(userEmail.user_id, { status: 'active' });
            }
        });

        // Log verification
        logAuthEvent(AuditActions.AUTH_EMAIL_VERIFY, userEmail.user_id, req, {
            email: userEmail.email
        });

        res.json({
            success: true,
            message: 'Email verified successfully'
        });

    } catch (err) {
        console.error('Email verification error:', err);
        res.status(500).json({
            error: 'verification_failed',
            message: 'Email verification failed'
        });
    }
});

/**
 * POST /resend-verification
 * Resend verification email
 */
router.post('/resend-verification', emailVerifyLimiter, async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Email required'
            });
        }

        // Find user
        const user = queries.getUserByEmail(email.toLowerCase());
        if (!user) {
            // Don't reveal if email exists
            return res.json({
                success: true,
                message: 'If the email exists, a verification link has been sent'
            });
        }

        // Check if already verified
        if (user.status === 'active') {
            return res.json({
                success: true,
                message: 'If the email exists, a verification link has been sent'
            });
        }

        // Generate new token
        const { token, expiresAt } = generateVerificationToken();

        // Update email record
        const db = (await import('../db/index.js')).getDb();
        db.prepare(`
            UPDATE user_emails
            SET verification_token = ?, verification_expires_at = ?
            WHERE user_id = ? AND is_primary = 1
        `).run(token, expiresAt, user.id);

        // Send email
        await sendVerificationEmail(email, token, user.display_name);

        res.json({
            success: true,
            message: 'If the email exists, a verification link has been sent'
        });

    } catch (err) {
        console.error('Resend verification error:', err);
        res.status(500).json({
            error: 'resend_failed',
            message: 'Failed to resend verification email'
        });
    }
});

/**
 * POST /forgot-password
 * Request password reset
 */
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Email required'
            });
        }

        // Find user
        const user = queries.getUserByEmail(email.toLowerCase());

        // Always return success to prevent email enumeration
        if (!user) {
            return res.json({
                success: true,
                message: 'If the email exists, a password reset link has been sent'
            });
        }

        // Generate reset token
        const resetToken = generateToken(32);
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

        // Store token (we'll use metadata_json in auth_identities)
        const db = (await import('../db/index.js')).getDb();
        db.prepare(`
            UPDATE auth_identities
            SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.reset_token', ?, '$.reset_expires', ?)
            WHERE user_id = ? AND provider = 'password'
        `).run(resetToken, resetExpires, user.id);

        // Send reset email
        await sendPasswordResetEmail(email, resetToken);

        // Log request
        logAuthEvent(AuditActions.AUTH_PASSWORD_RESET_REQUEST, user.id, req);

        res.json({
            success: true,
            message: 'If the email exists, a password reset link has been sent'
        });

    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({
            error: 'request_failed',
            message: 'Failed to process password reset request'
        });
    }
});

/**
 * POST /reset-password
 * Complete password reset
 */
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Token and new password required'
            });
        }

        // Validate new password
        const passwordValidation = validatePassword(password);
        if (!passwordValidation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: passwordValidation.message
            });
        }

        // Find identity with this reset token
        const db = (await import('../db/index.js')).getDb();
        const identity = db.prepare(`
            SELECT * FROM auth_identities
            WHERE provider = 'password'
            AND json_extract(metadata_json, '$.reset_token') = ?
        `).get(token);

        if (!identity) {
            return res.status(400).json({
                error: 'invalid_token',
                message: 'Invalid or expired reset token'
            });
        }

        // Check expiry
        const metadata = JSON.parse(identity.metadata_json || '{}');
        if (new Date(metadata.reset_expires) < new Date()) {
            return res.status(400).json({
                error: 'token_expired',
                message: 'Reset token has expired'
            });
        }

        // Hash new password
        const passwordHash = await hashPassword(password);

        // Update password and clear reset token
        transaction(() => {
            queries.updatePasswordHash(identity.user_id, passwordHash);

            db.prepare(`
                UPDATE auth_identities
                SET metadata_json = json_remove(metadata_json, '$.reset_token', '$.reset_expires')
                WHERE id = ?
            `).run(identity.id);

            // Revoke all sessions for security
            queries.revokeAllUserSessions(identity.user_id);
        });

        // Log password change
        logAuthEvent(AuditActions.AUTH_PASSWORD_RESET_COMPLETE, identity.user_id, req);

        res.json({
            success: true,
            message: 'Password reset successfully. Please log in with your new password.'
        });

    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({
            error: 'reset_failed',
            message: 'Failed to reset password'
        });
    }
});

/**
 * Safely parse preferences_json — returns {} on corrupt/invalid JSON
 */
function safeParsePreferences(raw) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * GET /authcheck
 * Lightweight edge-auth gate for nginx auth_request (F01 files-store stopgap,
 * engagement trust-proof-isolation-sweep-c1). Returns 204 when the access_token
 * cookie/Bearer is valid, 401 otherwise. Deliberately does NO profile fetch
 * beyond authenticate()'s own session check, because nginx calls it as a
 * subrequest on every legacy /files/ request until the org-scoped file-store
 * migration lands and the legacy service is decommissioned.
 */
router.get('/authcheck', authenticate(), (req, res) => {
    res.sendStatus(204);
});

/**
 * GET /me
 * Get current user info
 */
router.get('/me', authenticate(), async (req, res) => {
    try {
        const user = queries.getUserById(req.user.id);

        if (!user) {
            return res.status(404).json({
                error: 'user_not_found',
                message: 'User not found'
            });
        }

        // Get user's organizations
        const orgs = queries.getUserOrgs(user.id);

        // CLARITY-CONSOLE-7: include instance admin role so the frontend
        // can skip the /api/admin/stats probe for non-admin users.
        const { isAdmin: isInstanceAdmin, role: instanceAdminRole } = checkInstanceAdmin(user.id);

        // ET-4/TRUST-GATE-1.14 follow-up — surface the *effective* session
        // policy (org override, else instance default) to any authenticated
        // member, not just org admins. Read-only, non-sensitive (a number of
        // minutes), so no capability/plan gate — unlike the admin-only
        // GET /orgs/:orgId/security/session-policy route. The frontend uses
        // this to power an inactivity warning that mirrors the server's own
        // idle window instead of guessing/hardcoding one.
        let sessionPolicy = null;
        try {
            sessionPolicy = getSessionPolicy(getDb(), req.org?.id || null);
        } catch (err) {
            console.error('[auth] /me session policy lookup failed:', err.message);
        }

        res.json({
            user: {
                id: user.id,
                email: user.primary_email,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
                status: user.status,
                mfa_enabled: !!user.mfa_enabled,
                timezone: user.timezone || null,
                preferences: safeParsePreferences(user.preferences_json),
                created_at: user.created_at,
                // SCOPE-JWT-1: embed JWT-derived current org so WorkspaceContext
                // fast path (user?.org) fires and the dropdown reflects what the
                // server is actually filtering by, not stale localStorage.
                org: req.org ? { ...req.org, role: req.user?.orgRole || 'viewer' } : null,
                // TOOLSMITH-E-fix: flat org_id for consumers that read user.org_id
                // directly (e.g. ScriptForgeView install pipeline). Mirrors the
                // org.id already present in user.org but avoids the extra property
                // access which fails when user.org is null.
                org_id: req.org?.id || req.user?.org_id || null,
                // CLARITY-CONSOLE-7: null means not an instance admin — frontend
                // skips the /api/admin/stats probe when this is explicitly null.
                instance_admin_role: isInstanceAdmin ? instanceAdminRole : null,
            },
            organizations: orgs.map(o => ({
                id: o.id,
                name: o.name,
                slug: o.slug,
                role: o.role,
                plan: o.plan,
                preferences: safeParsePreferences(o.member_preferences_json)
            })),
            current_org: req.org || null,
            session_policy: sessionPolicy
        });

    } catch (err) {
        console.error('Get me error:', err);
        res.status(500).json({
            error: 'fetch_failed',
            message: 'Failed to fetch user info'
        });
    }
});

/**
 * PATCH /me
 * Update current user's profile
 *
 * Body: { display_name?, avatar_url?, timezone?, preferences? }
 */
router.patch('/me', authenticate(), async (req, res) => {
    try {
        const { display_name, avatar_url, timezone, preferences } = req.body;
        const userId = req.user.id;

        // Build update query
        const updates = [];
        const values = [];
        const changedFields = [];

        if (display_name !== undefined) {
            if (typeof display_name !== 'string' || display_name.length > 100) {
                return res.status(400).json({
                    error: 'invalid_display_name',
                    message: 'Display name must be a string under 100 characters'
                });
            }
            updates.push('display_name = ?');
            values.push(display_name.trim());
            changedFields.push('display_name');
        }

        if (avatar_url !== undefined) {
            if (avatar_url && (typeof avatar_url !== 'string' || avatar_url.length > 500)) {
                return res.status(400).json({
                    error: 'invalid_avatar_url',
                    message: 'Avatar URL must be a string under 500 characters'
                });
            }
            updates.push('avatar_url = ?');
            values.push(avatar_url || null);
            changedFields.push('avatar_url');
        }

        if (timezone !== undefined) {
            // Basic timezone validation
            if (timezone && typeof timezone !== 'string') {
                return res.status(400).json({
                    error: 'invalid_timezone',
                    message: 'Timezone must be a string'
                });
            }
            updates.push('timezone = ?');
            values.push(timezone || null);
            changedFields.push('timezone');
        }

        if (preferences !== undefined) {
            if (preferences && typeof preferences !== 'object') {
                return res.status(400).json({
                    error: 'invalid_preferences',
                    message: 'Preferences must be an object'
                });
            }
            // Read-modify-write: merge incoming preferences with existing ones
            // to avoid clobbering changes from other devices
            const db = getDb();
            const existing = db.prepare('SELECT preferences_json FROM users WHERE id = ?').get(userId);
            const existingPrefs = safeParsePreferences(existing?.preferences_json) || {};
            const merged = { ...existingPrefs, ...preferences };
            const prefsJson = JSON.stringify(merged);
            if (prefsJson.length > 102400) {
                return res.status(400).json({
                    error: 'preferences_too_large',
                    message: 'Preferences must be under 100KB'
                });
            }
            updates.push('preferences_json = ?');
            values.push(prefsJson);
            changedFields.push('preferences');
        }

        if (updates.length === 0) {
            return res.status(400).json({
                error: 'no_updates',
                message: 'No fields to update'
            });
        }

        updates.push("updated_at = datetime('now')");
        values.push(userId);

        const db = getDb();
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        // Audit log
        logAuthEvent(AuditActions.AUTH_PROFILE_UPDATE, userId, req, {
            action: 'profile_update',
            updated_fields: changedFields
        });

        // Return updated user
        const user = queries.getUserById(userId);

        res.json({
            user: {
                id: user.id,
                email: user.primary_email,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
                timezone: user.timezone,
                preferences: safeParsePreferences(user.preferences_json),
                status: user.status,
                mfa_enabled: !!user.mfa_enabled,
                created_at: user.created_at,
                updated_at: user.updated_at
            }
        });

    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({
            error: 'update_failed',
            message: 'Failed to update profile'
        });
    }
});

/**
 * POST /api/auth/me/preferences-sync
 * Beacon-friendly endpoint for syncing preferences on page unload.
 * Accepts { namespaces: { key: value } } and merges into preferences_json.
 * Used by serverSyncQueue.js sendBeacon on beforeunload.
 */
router.post('/me/preferences-sync', authenticate(), async (req, res) => {
    try {
        const { namespaces } = req.body;
        if (!namespaces || typeof namespaces !== 'object') {
            return res.status(400).json({ error: 'Expected namespaces object' });
        }

        const userId = req.user.id;
        // fleet #382 (found by the same lint fix): `db` was never obtained in
        // this handler, so every call threw ReferenceError. This is the route
        // serverSyncQueue.js beacons on beforeunload, so preference syncing
        // on tab close has been silently failing.
        const db = getDb();
        const user = db.prepare('SELECT preferences_json FROM users WHERE id = ?').get(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const currentPrefs = safeParsePreferences(user.preferences_json);
        const merged = { ...currentPrefs, ...namespaces };
        const prefsJson = JSON.stringify(merged);

        if (prefsJson.length > 102400) {
            return res.status(400).json({ error: 'preferences_too_large' });
        }

        db.prepare('UPDATE users SET preferences_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(prefsJson, userId);

        res.json({ synced: Object.keys(namespaces).length });
    } catch (err) {
        console.error('Preferences sync error:', err);
        res.status(500).json({ error: 'sync_failed' });
    }
});

/**
 * PATCH /me/password
 * Change current user's password
 *
 * Body: { current_password, new_password }
 */
router.patch('/me/password', authenticate(), async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        const userId = req.user.id;

        // Validate inputs
        if (!current_password || !new_password) {
            return res.status(400).json({
                error: 'missing_fields',
                message: 'Both current_password and new_password are required'
            });
        }

        const passwordValidation = validatePassword(new_password);
        if (!passwordValidation.valid) {
            return res.status(400).json({
                error: 'weak_password',
                message: passwordValidation.message,
                errors: passwordValidation.errors
            });
        }

        // Get current password identity
        const passwordIdentity = queries.getPasswordIdentity(userId);
        if (!passwordIdentity) {
            return res.status(400).json({
                error: 'no_password',
                message: 'No password set for this account. Use OAuth provider to manage credentials.'
            });
        }

        // Verify current password
        const validPassword = await verifyPassword(passwordIdentity.password_hash, current_password);
        if (!validPassword) {
            logAuthEvent(AuditActions.AUTH_LOGIN_FAILED, userId, req, {
                reason: 'invalid_current_password',
                action: 'password_change'
            });

            return res.status(401).json({
                error: 'invalid_password',
                message: 'Current password is incorrect'
            });
        }

        // Hash new password
        const newPasswordHash = await hashPassword(new_password);

        // Update password
        const db = getDb();
        db.prepare(`
            UPDATE auth_identities
            SET password_hash = ?, updated_at = datetime('now')
            WHERE user_id = ? AND provider = 'password'
        `).run(newPasswordHash, userId);

        // Audit log
        logAuthEvent(AuditActions.AUTH_PASSWORD_CHANGE, userId, req, {
            action: 'password_change'
        });

        res.json({
            success: true,
            message: 'Password changed successfully'
        });

    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({
            error: 'change_failed',
            message: 'Failed to change password'
        });
    }
});

// ============================================================================
// GDPR Data Export (Security Issue #56 - GDPR Art. 15, 20)
// ============================================================================

/**
 * GET /me/export
 * Export all user data for GDPR compliance (Right of Access / Data Portability)
 *
 * This endpoint gathers all data associated with the user:
 * - Profile information
 * - Email addresses
 * - Organization memberships
 * - Team memberships
 * - Sessions (without sensitive hashes)
 * - Audit log entries where user is the actor
 * - Inbox items assigned to user
 * - Notification preferences
 *
 * Rate limited to 1 request per hour to prevent abuse.
 */
router.get('/me/export', authenticate(), dataExportLimiter, async (req, res) => {
    try {
        const userId = req.user.id;
        const db = (await import('../db/index.js')).getDb();

        // Log the export request for compliance
        logAuthEvent(AuditActions.GDPR_DATA_EXPORT, userId, req, {
            export_type: 'full',
            requested_at: new Date().toISOString()
        });

        // 1. Get user profile
        const user = queries.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                error: 'user_not_found',
                message: 'User not found'
            });
        }

        // 2. Get all email addresses
        const emails = db.prepare(`
            SELECT id, email, is_primary, verified_at, created_at
            FROM user_emails
            WHERE user_id = ?
            ORDER BY is_primary DESC, created_at ASC
        `).all(userId);

        // 3. Get auth identities (providers only, no sensitive data)
        const authIdentities = db.prepare(`
            SELECT id, provider, provider_sub, created_at, updated_at
            FROM auth_identities
            WHERE user_id = ?
        `).all(userId);

        // 4. Get organization memberships
        const orgMemberships = db.prepare(`
            SELECT
                om.id,
                om.org_id,
                o.name as org_name,
                o.slug as org_slug,
                om.role,
                om.status,
                om.invited_by,
                om.invited_at,
                om.accepted_at,
                om.created_at,
                om.updated_at
            FROM org_memberships om
            JOIN orgs o ON o.id = om.org_id
            WHERE om.user_id = ?
            ORDER BY om.created_at DESC
        `).all(userId);

        // 5. Get team memberships
        const teamMemberships = db.prepare(`
            SELECT
                tm.id,
                tm.team_id,
                t.name as team_name,
                t.slug as team_slug,
                t.org_id,
                o.name as org_name,
                tm.role,
                tm.status,
                tm.created_at,
                tm.updated_at
            FROM team_memberships tm
            JOIN teams t ON t.id = tm.team_id
            JOIN orgs o ON o.id = t.org_id
            WHERE tm.user_id = ?
            ORDER BY tm.created_at DESC
        `).all(userId);

        // 6. Get sessions (sanitized - no token hashes)
        const sessions = db.prepare(`
            SELECT
                id,
                org_id,
                device_fingerprint,
                ip_address,
                user_agent,
                mfa_verified,
                created_at,
                expires_at,
                revoked_at,
                last_used_at
            FROM sessions
            WHERE user_id = ?
            ORDER BY created_at DESC
        `).all(userId);

        // 7. Get audit events where user is the actor (last 1 year)
        const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
        const auditEvents = db.prepare(`
            SELECT
                id,
                org_id,
                action,
                target_type,
                target_id,
                scope_id,
                status,
                ip_address,
                user_agent,
                metadata_json,
                created_at
            FROM audit_events
            WHERE actor_type = 'user' AND actor_id = ?
            AND created_at > ?
            ORDER BY created_at DESC
            LIMIT 10000
        `).all(userId, oneYearAgo);

        // 8. Get notification channel preferences (if table exists)
        let notificationChannels = [];
        try {
            notificationChannels = db.prepare(`
                SELECT
                    id,
                    channel_type,
                    enabled,
                    preferences_json,
                    verified_at,
                    created_at,
                    updated_at
                FROM notification_channels
                WHERE user_id = ?
            `).all(userId);
        } catch {
            // Table may not exist yet
        }

        // 9. Get inbox items assigned to user (if tables exist)
        let inboxAssignments = [];
        try {
            inboxAssignments = db.prepare(`
                SELECT
                    ia.id as assignment_id,
                    ia.mode,
                    ia.status as assignment_status,
                    ia.assigned_at,
                    ia.viewed_at,
                    ia.responded_at,
                    ii.id as item_id,
                    ii.kind,
                    ii.status as item_status,
                    ii.priority,
                    ii.title,
                    ii.created_at,
                    ii.resolved_at
                FROM inbox_item_assignees ia
                JOIN inbox_items ii ON ii.id = ia.inbox_item_id
                WHERE ia.assignee_type = 'user' AND ia.assignee_id = ?
                ORDER BY ia.assigned_at DESC
                LIMIT 1000
            `).all(userId);
        } catch {
            // Tables may not exist yet
        }

        // 10. Get invites sent by user
        const invitesSent = db.prepare(`
            SELECT
                id,
                org_id,
                team_id,
                email,
                role,
                status,
                expires_at,
                accepted_at,
                created_at
            FROM invites
            WHERE invited_by = ?
            ORDER BY created_at DESC
            LIMIT 500
        `).all(userId);

        // Build the export object
        const exportData = {
            export_metadata: {
                version: '1.0',
                exported_at: new Date().toISOString(),
                user_id: userId,
                data_subject_request: 'GDPR Article 15 (Right of Access) / Article 20 (Data Portability)',
                format: 'application/json'
            },
            profile: {
                id: user.id,
                primary_email: user.primary_email,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
                status: user.status,
                timezone: user.timezone,
                mfa_enabled: !!user.mfa_enabled,
                preferences: user.preferences_json ? JSON.parse(user.preferences_json) : {},
                created_at: user.created_at,
                updated_at: user.updated_at
            },
            emails: emails.map(e => ({
                id: e.id,
                email: e.email,
                is_primary: !!e.is_primary,
                verified_at: e.verified_at,
                created_at: e.created_at
            })),
            auth_providers: authIdentities.map(ai => ({
                id: ai.id,
                provider: ai.provider,
                provider_user_id: ai.provider_sub,
                linked_at: ai.created_at,
                last_updated: ai.updated_at
            })),
            organizations: orgMemberships.map(om => ({
                membership_id: om.id,
                org_id: om.org_id,
                org_name: om.org_name,
                org_slug: om.org_slug,
                role: om.role,
                status: om.status,
                invited_by: om.invited_by,
                invited_at: om.invited_at,
                accepted_at: om.accepted_at,
                joined_at: om.created_at
            })),
            teams: teamMemberships.map(tm => ({
                membership_id: tm.id,
                team_id: tm.team_id,
                team_name: tm.team_name,
                team_slug: tm.team_slug,
                org_id: tm.org_id,
                org_name: tm.org_name,
                role: tm.role,
                status: tm.status,
                joined_at: tm.created_at
            })),
            sessions: sessions.map(s => ({
                id: s.id,
                org_context: s.org_id,
                device: s.device_fingerprint,
                ip_address: s.ip_address,
                user_agent: s.user_agent,
                mfa_verified: !!s.mfa_verified,
                created_at: s.created_at,
                expires_at: s.expires_at,
                revoked_at: s.revoked_at,
                last_used_at: s.last_used_at
            })),
            activity_log: auditEvents.map(ae => ({
                id: ae.id,
                org_id: ae.org_id,
                action: ae.action,
                target_type: ae.target_type,
                target_id: ae.target_id,
                status: ae.status,
                ip_address: ae.ip_address,
                timestamp: ae.created_at,
                metadata: ae.metadata_json ? JSON.parse(ae.metadata_json) : {}
            })),
            notification_preferences: notificationChannels.map(nc => ({
                id: nc.id,
                channel_type: nc.channel_type,
                enabled: !!nc.enabled,
                preferences: nc.preferences_json ? JSON.parse(nc.preferences_json) : {},
                verified_at: nc.verified_at,
                created_at: nc.created_at
            })),
            inbox_assignments: inboxAssignments.map(ia => ({
                assignment_id: ia.assignment_id,
                item_id: ia.item_id,
                kind: ia.kind,
                title: ia.title,
                priority: ia.priority,
                assignment_status: ia.assignment_status,
                item_status: ia.item_status,
                assigned_at: ia.assigned_at,
                viewed_at: ia.viewed_at,
                responded_at: ia.responded_at,
                item_created_at: ia.created_at,
                item_resolved_at: ia.resolved_at
            })),
            invites_sent: invitesSent.map(i => ({
                id: i.id,
                org_id: i.org_id,
                team_id: i.team_id,
                invited_email: i.email,
                role: i.role,
                status: i.status,
                expires_at: i.expires_at,
                accepted_at: i.accepted_at,
                created_at: i.created_at
            }))
        };

        // Set headers for JSON download
        // Use content-disposition library for proper RFC 5987 encoding
        // This prevents HTTP header injection via malicious filenames
        const filename = `quox-data-export-${userId}-${new Date().toISOString().split('T')[0]}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', contentDisposition(filename, { type: 'attachment' }));
        res.setHeader('X-Content-Type-Options', 'nosniff');

        res.json(exportData);

    } catch (err) {
        console.error('GDPR data export error:', err);
        res.status(500).json({
            error: 'export_failed',
            message: 'Failed to export user data'
        });
    }
});

// ============================================================================
// Account Deletion (GDPR Art. 17 - Right to Erasure) - Security Issue #57
// ============================================================================

/**
 * DELETE /me
 * Request account deletion with cascade deletion of all user data
 *
 * Body: { password, immediate?: boolean }
 * - password: Current password for confirmation (required)
 * - immediate: If true, delete immediately. If false, schedule for 14-day grace period
 *
 * Deletes/anonymizes:
 * - User profile
 * - All sessions
 * - Auth identities
 * - MFA backup codes
 * - Org memberships (leaves orgs, transfers ownership if needed)
 * - Team memberships
 * - Audit logs (anonymized, not deleted for compliance)
 * - Requests deletion from collector service (conversations/memories)
 */
router.delete('/me', authenticate(), async (req, res) => {
    try {
        const { password, immediate = false } = req.body;
        const userId = req.user.id;

        // Password confirmation required for account deletion
        if (!password) {
            return res.status(400).json({
                error: 'password_required',
                message: 'Password confirmation is required to delete your account'
            });
        }

        // Verify password
        const passwordIdentity = queries.getPasswordIdentity(userId);
        if (!passwordIdentity) {
            return res.status(400).json({
                error: 'no_password',
                message: 'Cannot verify identity - no password set for this account'
            });
        }

        const validPassword = await verifyPassword(passwordIdentity.password_hash, password);
        if (!validPassword) {
            logAuthEvent(AuditActions.AUTH_ACCOUNT_DELETE_REQUEST, userId, req, {
                status: 'failed',
                reason: 'invalid_password'
            });

            return res.status(401).json({
                error: 'invalid_password',
                message: 'Password is incorrect'
            });
        }

        const user = queries.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                error: 'user_not_found',
                message: 'User not found'
            });
        }

        const db = (await import('../db/index.js')).getDb();

        // Check if user owns any orgs - they need to transfer ownership first
        const ownedOrgs = db.prepare(`
            SELECT id, name FROM orgs WHERE owner_user_id = ? AND deleted_at IS NULL
        `).all(userId);

        if (ownedOrgs.length > 0) {
            return res.status(400).json({
                error: 'org_owner',
                message: 'You must transfer ownership of your organizations before deleting your account',
                owned_orgs: ownedOrgs.map(o => ({ id: o.id, name: o.name }))
            });
        }

        if (immediate) {
            // Immediate deletion
            await performAccountDeletion(db, userId, user, req);

            // Clear auth cookies
            clearAuthCookies(res);

            res.json({
                success: true,
                message: 'Your account has been deleted. All your data has been removed.',
                deleted_at: new Date().toISOString()
            });
        } else {
            // Schedule deletion for 14-day grace period
            const scheduledAt = new Date();
            const deletionDate = new Date(scheduledAt.getTime() + 14 * 24 * 60 * 60 * 1000);

            // Mark user for scheduled deletion
            db.prepare(`
                UPDATE users
                SET status = 'pending_deletion',
                    metadata_json = json_set(COALESCE(metadata_json, '{}'),
                        '$.deletion_scheduled_at', ?,
                        '$.deletion_date', ?),
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(scheduledAt.toISOString(), deletionDate.toISOString(), userId);

            logAuthEvent(AuditActions.AUTH_ACCOUNT_DELETE_SCHEDULED, userId, req, {
                scheduled_at: scheduledAt.toISOString(),
                deletion_date: deletionDate.toISOString()
            });

            res.json({
                success: true,
                message: 'Your account is scheduled for deletion.',
                scheduled_at: scheduledAt.toISOString(),
                deletion_date: deletionDate.toISOString(),
                grace_period_days: 14,
                cancellation_available: true
            });
        }

    } catch (err) {
        console.error('Account deletion error:', err);
        res.status(500).json({
            error: 'deletion_failed',
            message: 'Failed to process account deletion request'
        });
    }
});

/**
 * POST /me/cancel-deletion
 * Cancel a scheduled account deletion during the grace period
 */
router.post('/me/cancel-deletion', authenticate(), async (req, res) => {
    try {
        const userId = req.user.id;
        const user = queries.getUserById(userId);

        if (!user) {
            return res.status(404).json({
                error: 'user_not_found',
                message: 'User not found'
            });
        }

        if (user.status !== 'pending_deletion') {
            return res.status(400).json({
                error: 'not_scheduled',
                message: 'Your account is not scheduled for deletion'
            });
        }

        const db = (await import('../db/index.js')).getDb();

        // Remove deletion schedule
        db.prepare(`
            UPDATE users
            SET status = 'active',
                metadata_json = json_remove(COALESCE(metadata_json, '{}'),
                    '$.deletion_scheduled_at',
                    '$.deletion_date'),
                updated_at = datetime('now')
            WHERE id = ?
        `).run(userId);

        logAuthEvent(AuditActions.AUTH_ACCOUNT_DELETE_CANCELLED, userId, req);

        res.json({
            success: true,
            message: 'Account deletion has been cancelled. Your account will remain active.'
        });

    } catch (err) {
        console.error('Cancel deletion error:', err);
        res.status(500).json({
            error: 'cancellation_failed',
            message: 'Failed to cancel account deletion'
        });
    }
});

/**
 * GET /me/deletion-status
 * Check if account is scheduled for deletion and get details
 */
router.get('/me/deletion-status', authenticate(), async (req, res) => {
    try {
        const userId = req.user.id;
        const user = queries.getUserById(userId);

        if (!user) {
            return res.status(404).json({
                error: 'user_not_found',
                message: 'User not found'
            });
        }

        if (user.status !== 'pending_deletion') {
            return res.json({
                scheduled: false,
                status: user.status
            });
        }

        // Parse metadata for deletion info
        const metadata = user.metadata_json ? JSON.parse(user.metadata_json) : {};

        res.json({
            scheduled: true,
            status: 'pending_deletion',
            scheduled_at: metadata.deletion_scheduled_at,
            deletion_date: metadata.deletion_date,
            days_remaining: Math.ceil(
                (new Date(metadata.deletion_date) - new Date()) / (1000 * 60 * 60 * 24)
            ),
            cancellation_available: true
        });

    } catch (err) {
        console.error('Deletion status error:', err);
        res.status(500).json({
            error: 'status_check_failed',
            message: 'Failed to check deletion status'
        });
    }
});

/**
 * Perform the actual account deletion - cascade delete all user data
 */
async function performAccountDeletion(db, userId, user, req) {
    const deletionTransaction = db.transaction(() => {
        // 1. Revoke all sessions
        queries.revokeAllUserSessions(userId);

        // 2. Delete MFA backup codes
        db.prepare('DELETE FROM mfa_backup_codes WHERE user_id = ?').run(userId);

        // 3. Delete auth identities
        db.prepare('DELETE FROM auth_identities WHERE user_id = ?').run(userId);

        // 4. Delete user emails
        db.prepare('DELETE FROM user_emails WHERE user_id = ?').run(userId);

        // 5. Leave all team memberships
        db.prepare(`
            UPDATE team_memberships
            SET status = 'removed', updated_at = datetime('now')
            WHERE user_id = ?
        `).run(userId);

        // 6. Leave all org memberships
        db.prepare(`
            UPDATE org_memberships
            SET status = 'left', updated_at = datetime('now')
            WHERE user_id = ?
        `).run(userId);

        // 7. Anonymize invites sent by this user (keep for audit trail)
        db.prepare(`
            UPDATE invites
            SET invited_by = 'DELETED_USER'
            WHERE invited_by = ?
        `).run(userId);

        // 8. Anonymize audit logs (don't delete - needed for compliance)
        // Replace actor_id and target_id with anonymized values
        const anonymizedId = `DELETED_${userId.slice(-8)}`;
        db.prepare(`
            UPDATE audit_events
            SET actor_id = CASE WHEN actor_id = ? THEN ? ELSE actor_id END,
                target_id = CASE WHEN target_id = ? THEN ? ELSE target_id END,
                metadata_json = json_set(metadata_json, '$.anonymized', 1, '$.anonymized_at', datetime('now'))
            WHERE actor_id = ? OR target_id = ?
        `).run(userId, anonymizedId, userId, anonymizedId, userId, userId);

        // 9. Delete integration credentials created by this user
        db.prepare('DELETE FROM integration_credentials WHERE created_by = ?').run(userId);

        // 10. Delete secrets created by this user
        db.prepare('DELETE FROM secrets WHERE created_by = ?').run(userId);

        // 11. Mark user as deleted (soft delete for audit purposes)
        db.prepare(`
            UPDATE users
            SET status = 'deleted',
                primary_email = ?,
                display_name = 'Deleted User',
                avatar_url = NULL,
                mfa_enabled = 0,
                mfa_secret = NULL,
                deleted_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?
        `).run(`deleted_${userId.slice(-8)}@deleted.local`, userId);
    });

    // Execute the transaction
    deletionTransaction();

    // Log the deletion event
    logAuthEvent(AuditActions.AUTH_ACCOUNT_DELETE_COMPLETE, userId, req, {
        email: user.primary_email,
        deletion_type: 'immediate'
    });

    // Request deletion from collector service (async, non-blocking)
    requestCollectorDataDeletion(userId, user.primary_email).catch(err => {
        console.error('[Account Deletion] Collector deletion request failed:', err.message);
    });
}

/**
 * Request data deletion from the collector service
 * This handles conversation/memory data stored separately
 */
async function requestCollectorDataDeletion(userId, email) {
    const collectorUrl = process.env.COLLECTOR_URL || 'http://localhost:9848';

    try {
        // Request deletion of all user-related envelopes/conversations
        const response = await fetch(`${collectorUrl}/api/v1/users/${userId}/data`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Service': 'auth-service',
                // The collector's /api/v1/users/:id/data route now requires a
                // timing-safe X-Service-Key (the old X-Internal-Service header
                // was spoofable — cross-tenant GDPR erasure). Send the shared
                // INTERNAL_SERVICE_KEY so GDPR deletion keeps working.
                'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || ''
            },
            body: JSON.stringify({
                user_id: userId,
                email: email,
                reason: 'gdpr_erasure_request'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[Account Deletion] Collector returned ${response.status}: ${errorText}`);
        } else {
            console.log(`[Account Deletion] Collector data deletion requested for user ${userId}`);
        }
    } catch (err) {
        // Don't fail the main deletion if collector is unavailable
        console.warn('[Account Deletion] Could not reach collector service:', err.message);
    }
}

export default router;
