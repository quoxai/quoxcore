/**
 * MATRIX-P4a — Matrix SSO token bridge.
 *
 * Mints a short-lived HS256 JWT for the authenticated Quox user so the
 * frontend can exchange it at the Synapse homeserver's `org.matrix.login.jwt`
 * login flow (jwt_config in homeserver.yaml, same MATRIX_JWT_SECRET).
 *
 *   GET/POST /api/matrix/token — requires an authenticated Quox session
 *
 * requireAuth is applied PER-ROUTE (not router-level) — mirrors
 * mcp-tokens.js exactly (known /api/internal mount-order trap).
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../middleware/auth.js';
import { prepare } from '../db/index.js';
import { perOrgIdentityEnabled, resolveMatrixServerName } from '../lib/matrixProvisioner.js';

const router = Router();

// Matrix localparts only allow lowercase a-z, 0-9, ., _, =, -, /. Each
// segment is lowercased and additionally stripped of anything outside that
// set defensively (ids are server-generated, but never trust it blind).
function safeSegment(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9._=\-/]/g, '_');
}

// M-ISO #209: with an orgId the localpart is the per-org identity
// `human.<userId>.<orgId>`; without one it stays the legacy shared
// identity `human.<userId>`. MUST stay in lockstep with
// humanMatrixUserId() in lib/matrixProvisioner.js.
function toLocalpart(userId, orgId) {
    return orgId
        ? `human.${safeSegment(userId)}.${safeSegment(orgId)}`
        : `human.${safeSegment(userId)}`;
}

/**
 * POST /api/matrix/token
 * Issue a short-lived JWT for Matrix (Synapse) JWT login for the
 * authenticated Quox user.
 *
 * M-ISO #209: when MATRIX_PER_ORG_IDENTITY is on, the body MUST carry
 * `org_id` and the caller must be an active member of that org; the minted
 * localpart is the per-org identity. Flag off: legacy shared identity,
 * org_id ignored. The frontend stays flag-agnostic; it always sends its
 * current org and the server decides which identity model applies.
 */
router.post('/', requireAuth, (req, res) => {
    const secret = process.env.MATRIX_JWT_SECRET;
    if (!secret) {
        console.error('[SECURITY] MATRIX_JWT_SECRET not configured — refusing to mint Matrix token');
        return res.status(503).json({
            error: 'matrix_not_configured',
            message: 'Matrix JWT secret is not configured on this server'
        });
    }

    let orgId = null;
    if (perOrgIdentityEnabled()) {
        orgId = req.body && typeof req.body.org_id === 'string' ? req.body.org_id : null;
        if (!orgId) {
            return res.status(400).json({
                error: 'org_id_required',
                message: 'Per-org Matrix identities are enabled: org_id is required'
            });
        }
        const member = prepare(
            "SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1"
        ).get(orgId, req.user.id);
        if (!member) {
            return res.status(403).json({
                error: 'not_org_member',
                message: 'You are not an active member of this organisation'
            });
        }
    }

    const serverName = resolveMatrixServerName();
    const localpart = toLocalpart(req.user.id, orgId);
    const now = Math.floor(Date.now() / 1000);

    const token = jwt.sign(
        {
            sub: localpart,
            iss: 'quox-auth',
            iat: now,
            exp: now + 300, // 5 minutes — single-use for the login exchange
        },
        secret,
        { algorithm: 'HS256' }
    );

    return res.status(200).json({
        jwt: token,
        server_name: serverName,
        base_url: '/matrix',
        matrix_user_id: `@${localpart}:${serverName}`,
        // M-P5: forwarded so the frontend can sync the Matrix profile
        // displayname to the user's real name instead of leaving it to
        // default to the raw `human.<ulid>` localpart.
        display_name: req.user.displayName || null,
        // M-P5 avatar sync: forwarded so the frontend can mirror the
        // dashboard profile photo (users.avatar_url, served from
        // /uploads) onto the Matrix profile. Without this the Matrix
        // user `human.<ulid>` has no avatar and every Rooms surface
        // falls back to a monogram.
        avatar_url: req.user.avatarUrl || null
    });
});

export default router;
