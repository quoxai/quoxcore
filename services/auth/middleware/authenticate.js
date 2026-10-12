/**
 * Authentication middleware for Quox Auth Service
 */

import { verifyToken, sha256, safeCompare } from '../utils/crypto.js';
import { queries, getDb } from '../db/index.js';
import { enforceSessionPolicy, enforceIpAllowlist, enforceMfaGate } from '../utils/enforcement.js';
import { pickAgentClaims } from '../utils/principal.js';
import { MFA_MODES } from '../utils/mfaPolicy.js';
import { pendingInviteForOrg } from '../utils/myInvites.js';

// ET-ENFORCE #322 — paths exempt from the per-request MFA gate. These must be
// reachable by a token that has NOT yet cleared the gate, otherwise the gate
// blocks the very endpoints that exist to clear it.
//
// This list is a claim about where routes are actually mounted, so it is
// exported and asserted in tests/mfa-exempt-paths.test.js against the real
// mount prefixes. See that file for the lockout this prevents.
// Deliberately enumerated rather than exempting the whole '/api/mfa' router:
// only the challenge and the two enrolment steps must work before the gate is
// cleared. /api/mfa/disable, /backup-codes and /regenerate-backup-codes stay
// gated, so an unverified session cannot mutate MFA state.
const MFA_EXEMPT_PREFIXES = [
    '/api/mfa/verify',        // also covers /verify-setup (startsWith)
    '/api/mfa/setup',
    '/api/auth/mfa/',         // legacy prefix, kept in case anything still calls it
    '/api/auth/logout',
];

export function isMfaExemptPath(requestPath) {
    const p = requestPath || '';
    return MFA_EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * The absolute request path, for prefix matching.
 *
 * MUST be used instead of req.path here. authenticate() runs INSIDE routers
 * that are mounted on a prefix (app.use('/api/mfa', mfaRoutes)), and Express
 * rewrites req.url within a mounted router, so req.path is relative to the
 * mount point: a request to /api/mfa/verify sees req.path === '/verify'. Every
 * absolute prefix in MFA_EXEMPT_PREFIXES therefore failed to match, which is
 * why the exemption list was dead for ALL entries from the day it shipped,
 * logout included. req.originalUrl survives the rewrite.
 *
 * Proven live 2026-07-30: with an unverified-MFA token, both
 * POST /api/mfa/verify and POST /api/auth/logout returned
 * mfa_challenge_required, so an enrolled user in an MFA-required org could
 * neither complete the challenge nor sign out.
 */
export function fullRequestPath(req) {
    const raw = req?.originalUrl || req?.url || '';
    return raw.split('?')[0];
}

/**
 * Extract and verify JWT from Authorization header or cookie
 * Populates req.user with user data if valid
 */
function userIsAgentOps(user) {
    try { return !!JSON.parse(user?.metadata_json || '{}').agent_ops; }
    catch { return false; }
}

export function authenticate(options = {}) {
    const { required = true } = options;

    return async (req, res, next) => {
        try {
            // Extract token from header or cookie
            let token = null;

            const authHeader = req.headers.authorization;
            if (authHeader?.startsWith('Bearer ')) {
                token = authHeader.slice(7);
            } else if (req.cookies?.access_token) {
                token = req.cookies.access_token;
            }

            if (!token) {
                if (required) {
                    return res.status(401).json({
                        error: 'authentication_required',
                        message: 'No authentication token provided'
                    });
                }
                return next();
            }

            // Verify token
            const payload = verifyToken(token);
            if (!payload) {
                return res.status(401).json({
                    error: 'invalid_token',
                    message: 'Token is invalid or expired'
                });
            }

            // Check token type
            if (payload.type !== 'access') {
                return res.status(401).json({
                    error: 'invalid_token_type',
                    message: 'Expected access token'
                });
            }

            // Load user from database
            const user = queries.getUserById(payload.sub);
            if (!user) {
                return res.status(401).json({
                    error: 'user_not_found',
                    message: 'User no longer exists'
                });
            }

            // Check user status
            if (user.status !== 'active') {
                return res.status(403).json({
                    error: 'user_inactive',
                    message: `User account is ${user.status}`
                });
            }

            // Populate request with user info
            req.user = {
                id: user.id,
                email: user.primary_email,
                displayName: user.display_name,
                avatarUrl: user.avatar_url || null,
                status: user.status,
                mfaEnabled: !!user.mfa_enabled,
                mfaVerified: !!payload.mfa_verified,
                sessionId: payload.session_id || null,
                // F13: retain the token's agent identity so decision sinks can
                // classify the principal (services/shared/principal.cjs).
                ...pickAgentClaims(payload),
                ...(!payload.agent_ops && userIsAgentOps(user) ? { agent_ops: true } : {}),
                ...(user.actor_type === 'agent' ? { actor_type: 'agent' } : {}),
            };

            // ET-ENFORCE E — session policy enforcement. Access tokens
            // issued by login/refresh now carry session_id; if present,
            // verify the session row is still live, within the idle +
            // max-session windows, and stamp last_active_at. Tokens
            // minted before the migration have no session_id and are
            // grandfathered until they expire naturally (JWT TTL).
            if (payload.session_id) {
                const db = (req.db || getDb());
                const verdict = enforceSessionPolicy(db, {
                    sessionId: payload.session_id,
                    userId:    user.id,
                });
                if (!verdict.allowed) {
                    // #320: operator-driven revocation surfaces as its own code
                    // so the FE can show the correct "was revoked" copy rather
                    // than the generic "timed out" copy. idle_timeout and
                    // max_session both remain under session_expired (those ARE
                    // expirations); only the explicit revocation branches.
                    const isRevoked = verdict.reason === 'session_revoked';
                    return res.status(401).json({
                        error:   isRevoked ? 'session_revoked' : 'session_expired',
                        reason:  verdict.reason,
                        message: isRevoked
                            ? 'Your session has been revoked. Please sign in again.'
                            : 'Your session has expired — please sign in again.',
                    });
                }
            }

            // ET-ENFORCE E — IP allowlist enforcement on every request
            // that carries an org context. Empty allowlist = allow-all
            // (feature is opt-in). Enforced per-request, not just at
            // login, so a token captured on an allowed network can't
            // be replayed from anywhere.
            if (payload.org_id) {
                const db = (req.db || getDb());
                const ipVerdict = enforceIpAllowlist(db, { orgId: payload.org_id, ip: req.ip });
                if (!ipVerdict.allowed) {
                    // ET-ENFORCE round-3: audit the IP block so compliance
                    // evidence captures every refused request.
                    try {
                        const { ulid } = await import('../utils/helpers.js');
                        db.prepare(`
                            INSERT INTO audit_events
                                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
                            VALUES (?, ?, 'user', ?, 'auth.ip_blocked', 'session', ?, 'failure', ?)
                        `).run(
                            ulid(), payload.org_id, user.id,
                            payload.session_id || null,
                            JSON.stringify({ ip: req.ip, reason: ipVerdict.reason }),
                        );
                    } catch { /* swallow */ }
                    return res.status(403).json({
                        error:   'ip_not_allowed',
                        message: 'Your IP address is not on this organisation’s allowlist.',
                    });
                }
            }

            // Load org context if present in token
            if (payload.org_id) {
                const membership = queries.getOrgMembership(payload.org_id, user.id);
                // ET-ENFORCE D — a deprovisioned user must not ride out the
                // JWT TTL. If the token carries an org_id but the membership
                // is missing or not active (removed / suspended / left),
                // reject the request entirely instead of just dropping org
                // context. This closes the window between SCIM DELETE
                // (which sets status='removed' + revokes session rows) and
                // access-token expiry.
                if (!membership || membership.status !== 'active') {
                    // GRIPE-712: never-accepted invite is not a revocation.
                    if (!membership) {
                        try {
                            const pending = pendingInviteForOrg(req.db || getDb(), user.id, payload.org_id);
                            if (pending) {
                                return res.status(403).json({
                                    error: 'pending_invitation',
                                    message: `You have a pending invitation to ${pending.org_name}: run \`quox invites accept ${pending.id}\``,
                                    invite_id: pending.id,
                                    organization: { id: pending.org_id, name: pending.org_name },
                                });
                            }
                        } catch { /* fall through to membership_revoked */ }
                    }
                    return res.status(403).json({
                        error: 'membership_revoked',
                        message: 'Your access to this organisation has been revoked',
                    });
                }
                const org = queries.getOrgById(payload.org_id);
                // ET-ENFORCE round-3: refuse if the org has been soft-deleted.
                // getOrgById already filters deleted_at IS NULL in production,
                // but bandage in case the query is later relaxed.
                if (!org || org.deleted_at) {
                    return res.status(403).json({
                        error: 'org_deleted',
                        message: 'This organisation has been deleted',
                    });
                }

                // ET-ENFORCE #322 — per-request MFA gate. Enforced after org
                // existence is confirmed so we have security_flags_json.
                // Exempted paths: MFA verify/enrol endpoints and logout (they
                // must be reachable by tokens that haven't cleared the gate).
                // fullRequestPath, NOT req.path — see fullRequestPath's note.
                const requestPath = fullRequestPath(req);
                const isMfaExempt = isMfaExemptPath(requestPath);
                if (!isMfaExempt) {
                    // Parse org MFA mode from security_flags_json (same
                    // logic as auth.js:parseOrgMfaMode).
                    let mfaMode = MFA_MODES.OPTIONAL;
                    try {
                        const flags = typeof org.security_flags_json === 'string'
                            ? JSON.parse(org.security_flags_json)
                            : org.security_flags_json;
                        mfaMode = flags?.mfa?.mode || MFA_MODES.OPTIONAL;
                    } catch { /* malformed — default to optional */ }

                    const mfaVerdict = enforceMfaGate({
                        mode:        mfaMode,
                        userHasMfa:  req.user.mfaEnabled,
                        mfaVerified: req.user.mfaVerified,
                        userRole:    membership.role,
                    });
                    if (!mfaVerdict.allowed) {
                        return res.status(403).json({
                            error:   mfaVerdict.reason,
                            message: mfaVerdict.reason === 'mfa_enrollment_required'
                                ? 'This organisation requires multi-factor authentication. Enrol before continuing.'
                                : 'Verify multi-factor authentication for this organisation.',
                        });
                    }
                }

                req.org = {
                    id: org.id,
                    name: org.name,
                    slug: org.slug,
                    plan: org.plan
                };
                req.user.orgRole = membership.role;
                // ET-ENFORCE round-3 + round-4: expose ONLY the columns
                // resolveCap and downstream gates actually need on
                // req.orgMembership. Round-3 attached the full row, which
                // also exposed preferences_json (free-form blob containing
                // guest_scope_id and any future user prefs) to every
                // authenticated request — a downstream `res.json(req.orgMembership)`
                // would leak it. Slim subset shuts that channel.
                req.orgMembership = {
                    user_id:        membership.user_id,
                    org_id:         membership.org_id,
                    role:           membership.role,
                    status:         membership.status,
                    custom_role_id: membership.custom_role_id || null,
                    expires_at:     membership.expires_at || null,
                };
            }

            next();
        } catch (err) {
            console.error('Authentication error:', err);
            return res.status(500).json({
                error: 'auth_error',
                message: 'Authentication failed'
            });
        }
    };
}

/**
 * Authenticate via API key (for service accounts)
 */
export function authenticateApiKey(options = {}) {
    const { required = true } = options;

    return async (req, res, next) => {
        try {
            const apiKey = req.headers['x-api-key'];

            if (!apiKey) {
                if (required) {
                    return res.status(401).json({
                        error: 'api_key_required',
                        message: 'No API key provided'
                    });
                }
                return next();
            }

            // Validate API key format: msk_<prefix>_<secret>
            // NOTE: the secret segment is base64url-encoded and MAY itself
            // contain `_` characters, so it must never be split apart — only
            // the fixed msk_<prefix>_ header is parsed; everything after it
            // is treated as the opaque secret tail.
            const match = /^msk_([0-9a-f]{8})_(.+)$/.exec(apiKey);
            if (!match) {
                return res.status(401).json({
                    error: 'invalid_api_key_format',
                    message: 'Invalid API key format'
                });
            }

            const prefix = match[1];

            // Find service account by prefix
            const serviceAccount = queries.getServiceAccountByKeyPrefix(prefix);
            if (!serviceAccount) {
                return res.status(401).json({
                    error: 'invalid_api_key',
                    message: 'API key not found'
                });
            }

            // Verify full key hash using timing-safe comparison
            const keyHash = sha256(apiKey);
            if (!safeCompare(keyHash, serviceAccount.api_key_hash)) {
                return res.status(401).json({
                    error: 'invalid_api_key',
                    message: 'API key verification failed'
                });
            }

            // Check expiry
            if (serviceAccount.expires_at && new Date(serviceAccount.expires_at) < new Date()) {
                return res.status(401).json({
                    error: 'api_key_expired',
                    message: 'API key has expired'
                });
            }

            // Update last used timestamp
            queries.touchServiceAccount(serviceAccount.id);

            // Populate request with service account info
            req.serviceAccount = {
                id: serviceAccount.id,
                orgId: serviceAccount.org_id,
                name: serviceAccount.name,
                role: serviceAccount.role,
                type: 'service_account'
            };

            // Load org context
            const org = queries.getOrgById(serviceAccount.org_id);
            if (org) {
                req.org = {
                    id: org.id,
                    name: org.name,
                    slug: org.slug,
                    plan: org.plan
                };
            }

            next();
        } catch (err) {
            console.error('API key authentication error:', err);
            return res.status(500).json({
                error: 'auth_error',
                message: 'Authentication failed'
            });
        }
    };
}

/**
 * Combined authentication: try JWT first, then API key
 */
export function authenticateAny(options = {}) {
    const { required = true } = options;

    return async (req, res, next) => {
        // Check for API key first
        if (req.headers['x-api-key']) {
            return authenticateApiKey({ required })(req, res, next);
        }
        // Fall back to JWT
        return authenticate({ required })(req, res, next);
    };
}

/**
 * Require MFA verification for the current session
 */
export function requireMfa() {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'authentication_required',
                message: 'Must be authenticated'
            });
        }

        if (req.user.mfaEnabled && !req.user.mfaVerified) {
            return res.status(403).json({
                error: 'mfa_required',
                message: 'MFA verification required for this action'
            });
        }

        next();
    };
}

/**
 * Require active organization context
 */
export function requireOrg() {
    return (req, res, next) => {
        if (!req.org) {
            return res.status(400).json({
                error: 'org_required',
                message: 'Organization context required'
            });
        }
        next();
    };
}

export default {
    authenticate,
    authenticateApiKey,
    authenticateAny,
    requireMfa,
    requireOrg
};
