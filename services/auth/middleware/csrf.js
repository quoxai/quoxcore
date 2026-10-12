/**
 * CSRF Protection Middleware (Security Issue #44)
 *
 * Implements the Double Submit Cookie pattern:
 * 1. A CSRF token is set as a cookie (readable by JavaScript)
 * 2. The client must include this token in the X-CSRF-Token header
 * 3. The middleware validates that both values match
 *
 * This prevents CSRF attacks because:
 * - Attackers cannot read cookies from other domains (same-origin policy)
 * - They cannot set custom headers in cross-origin requests without CORS preflight
 * - Combined with SameSite=lax cookies, provides defense in depth
 */

import crypto from 'crypto';
import { readInstanceConfigBoolean } from '../lib/instanceConfigOverrides.js';

// CSRF token configuration
const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TOKEN_LENGTH = 32; // 256 bits
const CSRF_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// Cookie secure flag - can be disabled for HTTP production deployments (Issue #115)
// Set COOKIE_SECURE=false in environment to allow cookies over HTTP
const ENV_COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production';

// VAULT-INTEG P17: instance_config ('cookie_secure', written by the setup
// wizard) wins over the env default when set — mirrors
// lib/accessTokenCookie.js's resolveCookieSecure(). Evaluated per call so a
// wizard write takes effect without a restart.
function resolveCookieSecure() {
    const override = readInstanceConfigBoolean('cookie_secure');
    return override !== null ? override : ENV_COOKIE_SECURE;
}

/**
 * Generate a cryptographically secure CSRF token
 */
function generateCsrfToken() {
    return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Check if the request method is state-changing
 */
function isStateChangingMethod(method) {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

/**
 * Paths that should be exempt from CSRF validation
 * - Login/signup endpoints need to work without prior token
 * - Webhook endpoints that use API keys for auth
 * - OAuth callbacks
 */
const CSRF_EXEMPT_PATHS = [
    '/api/auth/login',
    '/api/auth/signup',
    '/api/auth/refresh',
    '/api/auth/logout',     // Logout must always work even with stale CSRF state
    '/api/auth/forgot-password',
    '/api/auth/resident/', // #453 resident challenge/response: pre-token by design, no cookie session involved

    '/api/auth/reset-password',
    '/api/auth/verify-email',
    '/api/mfa/verify',      // MFA verify uses one-time token, not session-based
    '/api/setup/',  // Setup wizard endpoints
    '/api/tests/',  // Test lab endpoints
    '/api/internal/', // Internal service-to-service endpoints (QuoxFlow, etc.)
    // Security Issue #43: Removed /api/notifications/test-email - now requires auth + CSRF
    '/api/notifications/send-email',
    '/api/auth/me/preferences-sync', // sendBeacon cannot set custom headers
    '/health'
];

/**
 * Check if the path is exempt from CSRF validation
 */
function isExemptPath(path) {
    return CSRF_EXEMPT_PATHS.some(exempt =>
        path === exempt || path.startsWith(exempt)
    );
}

/**
 * CSRF middleware that enforces Double Submit Cookie pattern
 *
 * @param {Object} options
 * @param {boolean} options.enabled - Whether to enforce CSRF validation (default: true)
 * @param {string[]} options.exemptPaths - Additional paths to exempt from CSRF validation
 * @returns {Function} Express middleware
 */
export function csrfProtection(options = {}) {
    const {
        enabled = true,
        exemptPaths = []
    } = options;

    // Merge custom exempt paths
    const allExemptPaths = [...CSRF_EXEMPT_PATHS, ...exemptPaths];

    return (req, res, next) => {
        // Always set CSRF token cookie if not present
        if (!req.cookies[CSRF_COOKIE_NAME]) {
            const token = generateCsrfToken();
            res.cookie(CSRF_COOKIE_NAME, token, {
                httpOnly: false,  // Must be readable by JavaScript
                secure: resolveCookieSecure(),
                sameSite: 'lax',
                maxAge: CSRF_TOKEN_EXPIRY,
                path: '/'
            });
            // Store token on request for this request cycle
            req.csrfToken = token;
        } else {
            req.csrfToken = req.cookies[CSRF_COOKIE_NAME];
        }

        // Skip validation if disabled
        if (!enabled) {
            return next();
        }

        // Skip validation for safe methods (GET, HEAD, OPTIONS)
        if (!isStateChangingMethod(req.method)) {
            return next();
        }

        // Skip validation for exempt paths
        if (allExemptPaths.some(exempt => req.path === exempt || req.path.startsWith(exempt))) {
            return next();
        }

        // Skip validation for API key authenticated requests
        // (These use X-API-Key header and don't rely on cookies)
        if (req.headers['x-api-key']) {
            return next();
        }

        // Skip validation for service-key authenticated requests without a
        // session cookie — the quox CLI's automation fallback
        // (cli/lib/core/client.js) sends X-Service-Key when nobody is
        // logged in, and a browser cannot be induced to attach a custom
        // header cross-origin, so CSRF does not apply. The key itself is
        // still validated by the route's own auth. Cookie-less only, same
        // posture as the Bearer exemption below: a live browser session in
        // the same request re-arms CSRF. (Found live 2026-08-16: every
        // state-changing service-key CLI call 403'd csrf_validation_failed.)
        if (req.headers['x-service-key'] && !req.cookies['connect.sid']) {
            return next();
        }

        // Skip validation for Bearer token auth without session cookie.
        // CSRF attacks exploit automatic cookie attachment by browsers.
        // Bearer tokens are manually set by clients (CLI, SDKs) and are
        // not vulnerable to CSRF — the attacker cannot make a browser
        // send a custom Authorization header cross-origin.
        if (req.headers['authorization']?.startsWith('Bearer ') && !req.cookies['connect.sid']) {
            return next();
        }

        // Get the token from the header
        const headerToken = req.headers[CSRF_HEADER_NAME];
        const cookieToken = req.cookies[CSRF_COOKIE_NAME];

        // Validate both tokens are present
        if (!headerToken) {
            console.warn(`[CSRF] Missing X-CSRF-Token header for ${req.method} ${req.path}`);
            return res.status(403).json({
                error: 'csrf_validation_failed',
                message: 'Missing CSRF token header. Include X-CSRF-Token header with your request.'
            });
        }

        if (!cookieToken) {
            const rawCookie = req.headers.cookie || '(no Cookie header)';
            console.warn(`[CSRF] Missing CSRF cookie for ${req.method} ${req.path} | Cookie header: ${rawCookie.substring(0, 200)} | Parsed cookies: ${JSON.stringify(Object.keys(req.cookies || {}))}`);
            return res.status(403).json({
                error: 'csrf_validation_failed',
                message: 'Missing CSRF token cookie. Please refresh the page and try again.'
            });
        }

        // Validate tokens match using constant-time comparison
        if (!safeCompare(headerToken, cookieToken)) {
            console.warn(`[CSRF] Token mismatch for ${req.method} ${req.path}`);
            return res.status(403).json({
                error: 'csrf_validation_failed',
                message: 'CSRF token validation failed. Please refresh the page and try again.'
            });
        }

        // Validation passed
        next();
    };
}

/**
 * Helper middleware to refresh CSRF token
 * Call this after successful authentication to rotate the token
 */
export function refreshCsrfToken(res) {
    const token = generateCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        secure: resolveCookieSecure(),
        sameSite: 'lax',
        maxAge: CSRF_TOKEN_EXPIRY,
        path: '/'
    });
    return token;
}

/**
 * Get CSRF token endpoint handler
 * Clients can call this to get a fresh CSRF token
 */
export function getCsrfTokenHandler(req, res) {
    const token = refreshCsrfToken(res);
    res.json({ csrfToken: token });
}

export default csrfProtection;
