/**
 * MFA routes for Quox Auth Service
 *
 * POST /mfa/setup - Start MFA setup
 * POST /mfa/verify-setup - Complete MFA setup
 * POST /mfa/verify - Verify MFA code during login
 * POST /mfa/disable - Disable MFA
 * GET /mfa/backup-codes - Get backup codes
 * POST /mfa/regenerate-backup-codes - Generate new backup codes
 */

import { Router } from 'express';
import { generateSecret, verify } from 'otplib';
import { buildOtpauthUri } from '../lib/otpauthUri.js';
import { setAccessTokenCookie } from '../lib/accessTokenCookie.js';
import QRCode from 'qrcode';
import { generateId, generateBackupCodes, sha256, verifyToken, createAccessToken } from '../utils/crypto.js';
import { queries, transaction, getDb } from '../db/index.js';
import { logAuthEvent, AuditActions } from '../utils/audit.js';
import { isNonHumanPrincipal, userRowIsNonHuman, pickAgentClaims } from '../utils/principal.js';
import { authenticate, requireMfa } from '../middleware/authenticate.js';
import { mfaLimiter } from '../middleware/rateLimit.js';
import { verifyEnrolmentTicket, consumeEnrolmentTicket } from '../lib/mfaEnrolmentTicket.js';

const router = Router();

/**
 * LAUNCH-SPINE: accept an MFA enrolment ticket in place of a session, on the
 * two enrolment routes ONLY.
 *
 * A user refused at login with mfa_enrollment_required has no session, but
 * enrolment needs one — a deadlock that made an org's MFA requirement
 * unsatisfiable for anyone not already enrolled. The ticket is minted at that
 * refusal, after the password check passed.
 *
 * Falls through to normal authenticate() when no ticket is presented, so the
 * ordinary in-session enrolment path is unchanged. The ticket is NOT consumed
 * here: /setup runs before /verify-setup, and only completing enrolment should
 * spend it.
 */
function authenticateOrEnrolmentTicket() {
    const sessionAuth = authenticate();
    return (req, res, next) => {
        const ticket = req.get('X-MFA-Enrolment-Ticket') || req.body?.enrolment_ticket;
        if (!ticket) return sessionAuth(req, res, next);

        const check = verifyEnrolmentTicket(getDb(), ticket);
        if (!check.valid) {
            return res.status(401).json({
                error: 'invalid_enrolment_ticket',
                message: 'This enrolment link is no longer valid. Sign in again to restart enrolment.',
                reason: check.reason,
            });
        }

        // Deliberately minimal: an id and an org, no role, no session id. This
        // must never look enough like a session to satisfy anything else.
        req.user = { id: check.userId, org_id: check.orgId };
        req.enrolmentTicket = ticket;
        next();
    };
}

// Configuration for TOTP verification
const TOTP_WINDOW = 1;  // Allow 1 step before/after for clock drift
const ISSUER = 'Quox';

// LAUNCH-SPINE: otpauth URI construction lives in lib/otpauthUri.js so the
// otplib option-name contract can be unit tested without booting this router.

/**
 * POST /mfa/setup
 * Start MFA setup - returns secret and QR code
 */
router.post('/setup', authenticateOrEnrolmentTicket(), async (req, res) => {
    try {
        const user = queries.getUserById(req.user.id);

        // F14: agent / agent_ops / attach principals never enrol MFA (a TOTP secret
        // on an agent account would let it mint human-looking mfa_verified tokens).
        if (isNonHumanPrincipal(req) || userRowIsNonHuman(user)) {
            return res.status(403).json({
                error: 'mfa_enrolment_human_only',
                message: 'Agent accounts cannot enrol MFA'
            });
        }

        if (user.mfa_enabled) {
            return res.status(400).json({
                error: 'mfa_already_enabled',
                message: 'MFA is already enabled on this account'
            });
        }

        // Generate secret
        const secret = generateSecret();

        // Generate OTP auth URL
        const otpauth = await buildOtpauthUri({
            secret,
            email: user.primary_email,
        });

        // Generate QR code
        const qrCode = await QRCode.toDataURL(otpauth);

        // Store secret temporarily (not enabled until verified)
        queries.setMfaSecret(user.id, secret);

        res.json({
            success: true,
            secret,
            qr_code: qrCode,
            otpauth_url: otpauth,
            message: 'Scan the QR code with your authenticator app, then verify with a code'
        });

    } catch (err) {
        console.error('MFA setup error:', err);
        res.status(500).json({
            error: 'setup_failed',
            message: 'Failed to setup MFA'
        });
    }
});

/**
 * POST /mfa/verify-setup
 * Complete MFA setup by verifying initial code
 */
router.post('/verify-setup', authenticateOrEnrolmentTicket(), mfaLimiter, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                error: 'code_required',
                message: 'Verification code required'
            });
        }

        const user = queries.getUserById(req.user.id);

        // F14: agent / agent_ops / attach principals never enrol MFA (a TOTP secret
        // on an agent account would let it mint human-looking mfa_verified tokens).
        if (isNonHumanPrincipal(req) || userRowIsNonHuman(user)) {
            return res.status(403).json({
                error: 'mfa_enrolment_human_only',
                message: 'Agent accounts cannot enrol MFA'
            });
        }

        if (user.mfa_enabled) {
            return res.status(400).json({
                error: 'mfa_already_enabled',
                message: 'MFA is already enabled'
            });
        }

        if (!user.mfa_secret) {
            return res.status(400).json({
                error: 'setup_required',
                message: 'Please start MFA setup first'
            });
        }

        // Verify the code
        const result = await verify({
            secret: user.mfa_secret,
            token: code,
            window: TOTP_WINDOW
        });

        if (!result.valid) {
            return res.status(400).json({
                error: 'invalid_code',
                message: 'Invalid verification code'
            });
        }

        // Generate backup codes
        const backupCodes = generateBackupCodes(10);

        transaction(() => {
            // Enable MFA
            queries.enableMfa(user.id);

            // Store backup codes
            const backupCodeRecords = backupCodes.map(bc => ({
                id: generateId(),
                user_id: user.id,
                code_hash: bc.hash
            }));
            queries.createBackupCodes(backupCodeRecords);
        });

        // LAUNCH-SPINE: enrolment is done, so burn the ticket. Single-use is the
        // property that keeps it from being a reusable way back in. Failure to
        // consume must not fail the request — MFA is already enabled at this
        // point, and the ticket expires on its own regardless.
        if (req.enrolmentTicket) {
            try {
                consumeEnrolmentTicket(getDb(), req.enrolmentTicket, { ip: req.ip });
            } catch (consumeErr) {
                console.warn('[MFA] enrolment ticket consume failed (non-fatal):', consumeErr.message);
            }
        }

        // Log MFA enable
        logAuthEvent(AuditActions.AUTH_MFA_ENABLE, user.id, req);

        res.json({
            success: true,
            message: 'MFA enabled successfully',
            backup_codes: backupCodes.map(bc => bc.plain),
            warning: 'Save these backup codes in a safe place. They will not be shown again.',
            // Signals to the enrolment screen that it must send the user back to
            // a normal sign-in: the ticket is spent and was never a session.
            reauth_required: !!req.enrolmentTicket
        });

    } catch (err) {
        console.error('MFA verify setup error:', err);
        res.status(500).json({
            error: 'verify_failed',
            message: 'Failed to verify MFA setup'
        });
    }
});

/**
 * POST /mfa/verify
 * Verify MFA code during login (elevates session)
 */
router.post('/verify', authenticate(), mfaLimiter, async (req, res) => {
    try {
        const { code, backup_code } = req.body;

        if (!code && !backup_code) {
            return res.status(400).json({
                error: 'code_required',
                message: 'Verification code or backup code required'
            });
        }

        const user = queries.getUserById(req.user.id);

        if (!user.mfa_enabled) {
            return res.status(400).json({
                error: 'mfa_not_enabled',
                message: 'MFA is not enabled on this account'
            });
        }

        let isValid = false;
        let usedBackupCode = false;

        if (code) {
            // Verify TOTP code
            const result = await verify({
                secret: user.mfa_secret,
                token: code,
                window: TOTP_WINDOW
            });
            isValid = result.valid;
        } else if (backup_code) {
            // Verify backup code
            const codeHash = sha256(backup_code.toUpperCase());
            const result = queries.useBackupCode(user.id, codeHash);
            isValid = result.changes > 0;
            usedBackupCode = isValid;
        }

        if (!isValid) {
            return res.status(400).json({
                error: 'invalid_code',
                message: 'Invalid verification code'
            });
        }

        const db = getDb();

        // LAUNCH-SPINE: identify the CALLING session from the access token.
        //
        // This used to read the session id out of the refresh_token cookie,
        // but that cookie is set with path '/api/auth/refresh', so a browser
        // never sends it to this route. The "shouldn't happen in normal flow"
        // fallback below therefore fired on every single verification and
        // marked the most recently CREATED session verified instead of the
        // caller's. With /auth/refresh now reading mfa_verified off the
        // session row, that is a cross-session elevation: verifying in one
        // browser could grant MFA to a different, newer session that never
        // passed a challenge, while demoting the one that did.
        //
        // req.user.sessionId comes from the verified access token, so it names
        // the session actually making this request. The refresh cookie stays
        // as a fallback for non-browser callers that do present it.
        const refreshToken = req.cookies?.refresh_token;
        const refreshPayload = refreshToken ? verifyToken(refreshToken) : null;
        const sessionId = req.user?.sessionId || refreshPayload?.session_id;

        if (sessionId) {
            // Update only the specific session
            db.prepare(`
                UPDATE sessions
                SET mfa_verified = 1
                WHERE id = ? AND user_id = ? AND revoked_at IS NULL
            `).run(sessionId, user.id);
        } else {
            // Fallback: if no session_id available, update current active session only
            // This shouldn't happen in normal flow but provides safety
            console.warn(`MFA verify: No session_id found in refresh token for user ${user.id}`);
            db.prepare(`
                UPDATE sessions
                SET mfa_verified = 1
                WHERE user_id = ? AND revoked_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
            `).run(user.id);
        }

        // Log MFA verification
        logAuthEvent(AuditActions.AUTH_MFA_VERIFY, user.id, req, {
            used_backup_code: usedBackupCode
        });

        // Check remaining backup codes if one was used
        let backupCodesRemaining = null;
        if (usedBackupCode) {
            const remaining = queries.getUnusedBackupCodes(user.id);
            backupCodesRemaining = remaining.length;
        }

        // LAUNCH-SPINE: elevate the CREDENTIAL, not just the session row.
        //
        // The per-request gate in middleware/authenticate.js reads
        // mfa_verified from the JWT payload. Writing sessions.mfa_verified = 1
        // and returning JSON left the caller holding a token that still said
        // false, so every org route kept returning mfa_challenge_required and
        // the user stayed locked out of an MFA-required org even after
        // submitting a correct code. /auth/refresh did not rescue them either:
        // it copied mfa_verified from the refresh token minted at login.
        //
        // Re-minting here keeps the JWT self-contained and truthful, which is
        // what every other reader of that claim assumes, and matches what the
        // frontend already expected ("tokens are now set as httpOnly cookies
        // by the server" in AuthContext.verifyMfa).
        //
        // Org scope and session handle are carried across deliberately: the
        // elevated token must be the same session with one claim changed, not
        // a broader credential.
        const elevatedToken = createAccessToken({
            sub:          user.id,
            email:        user.primary_email,
            org_id:       req.org?.id || null,
            role:         req.user?.orgRole || null,
            session_id:   req.user?.sessionId || sessionId || null,
            mfa_verified: true,
            // F14: the elevated token is the same principal with one claim changed;
            // an agent session must stay an agent session.
            ...pickAgentClaims(req.user),
        });
        setAccessTokenCookie(res, elevatedToken);

        res.json({
            success: true,
            message: 'MFA verified',
            mfa_verified: true,
            backup_codes_remaining: backupCodesRemaining,
            access_token: elevatedToken,
            // AuthContext.verifyMfa() does setUser(data.user) on success, so
            // omitting this cleared the signed-in user on a SUCCESSFUL verify.
            user: {
                id:           user.id,
                email:        user.primary_email,
                display_name: user.display_name,
                mfa_enabled:  !!user.mfa_enabled,
                org:          req.org ? { id: req.org.id, name: req.org.name, slug: req.org.slug, role: req.user?.orgRole || null } : null,
            },
        });

    } catch (err) {
        console.error('MFA verify error:', err);
        res.status(500).json({
            error: 'verify_failed',
            message: 'Failed to verify MFA'
        });
    }
});

/**
 * POST /mfa/disable
 * Disable MFA (requires current MFA code)
 */
router.post('/disable', authenticate(), mfaLimiter, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                error: 'code_required',
                message: 'Current MFA code required to disable'
            });
        }

        const user = queries.getUserById(req.user.id);

        if (!user.mfa_enabled) {
            return res.status(400).json({
                error: 'mfa_not_enabled',
                message: 'MFA is not enabled'
            });
        }

        // Verify code
        const result = await verify({
            secret: user.mfa_secret,
            token: code,
            window: TOTP_WINDOW
        });

        if (!result.valid) {
            return res.status(400).json({
                error: 'invalid_code',
                message: 'Invalid verification code'
            });
        }

        transaction(() => {
            // Disable MFA
            queries.disableMfa(user.id);

            // Delete backup codes
            queries.deleteBackupCodes(user.id);
        });

        // Log MFA disable
        logAuthEvent(AuditActions.AUTH_MFA_DISABLE, user.id, req);

        res.json({
            success: true,
            message: 'MFA disabled'
        });

    } catch (err) {
        console.error('MFA disable error:', err);
        res.status(500).json({
            error: 'disable_failed',
            message: 'Failed to disable MFA'
        });
    }
});

/**
 * GET /mfa/backup-codes
 * Get remaining backup codes count (requires MFA)
 */
router.get('/backup-codes', authenticate(), requireMfa(), async (req, res) => {
    try {
        const user = queries.getUserById(req.user.id);

        if (!user.mfa_enabled) {
            return res.status(400).json({
                error: 'mfa_not_enabled',
                message: 'MFA is not enabled'
            });
        }

        const remaining = queries.getUnusedBackupCodes(user.id);

        res.json({
            backup_codes_remaining: remaining.length,
            warning: remaining.length <= 2 ? 'Low backup codes - consider regenerating' : null
        });

    } catch (err) {
        console.error('Get backup codes error:', err);
        res.status(500).json({
            error: 'fetch_failed',
            message: 'Failed to fetch backup codes'
        });
    }
});

/**
 * POST /mfa/regenerate-backup-codes
 * Generate new backup codes (requires current MFA code)
 */
router.post('/regenerate-backup-codes', authenticate(), mfaLimiter, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                error: 'code_required',
                message: 'Current MFA code required'
            });
        }

        const user = queries.getUserById(req.user.id);

        if (!user.mfa_enabled) {
            return res.status(400).json({
                error: 'mfa_not_enabled',
                message: 'MFA is not enabled'
            });
        }

        // Verify code
        const result = await verify({
            secret: user.mfa_secret,
            token: code,
            window: TOTP_WINDOW
        });

        if (!result.valid) {
            return res.status(400).json({
                error: 'invalid_code',
                message: 'Invalid verification code'
            });
        }

        // Generate new backup codes
        const backupCodes = generateBackupCodes(10);

        transaction(() => {
            // Delete old backup codes
            queries.deleteBackupCodes(user.id);

            // Store new backup codes
            const backupCodeRecords = backupCodes.map(bc => ({
                id: generateId(),
                user_id: user.id,
                code_hash: bc.hash
            }));
            queries.createBackupCodes(backupCodeRecords);
        });

        res.json({
            success: true,
            backup_codes: backupCodes.map(bc => bc.plain),
            warning: 'Save these new backup codes. Previous codes are now invalid.'
        });

    } catch (err) {
        console.error('Regenerate backup codes error:', err);
        res.status(500).json({
            error: 'regenerate_failed',
            message: 'Failed to regenerate backup codes'
        });
    }
});

export default router;
