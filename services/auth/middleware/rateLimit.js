/**
 * Rate limiting middleware for Quox Auth Service
 */

import rateLimit from 'express-rate-limit';
import { getDb } from '../db/index.js';
import { generateId } from '../utils/crypto.js';
import { hasValidInternalServiceKey } from '../utils/internalServiceAuth.js';

// ============================================================================
// SQLite-backed Store for Rate Limiting
// ============================================================================

class SqliteStore {
    constructor(options = {}) {
        this.windowMs = options.windowMs || 60000;
        this.db = null;
    }

    init() {
        if (!this.db) {
            this.db = getDb();
        }
    }

    /**
     * Increment the hit count for a key
     */
    async increment(key) {
        this.init();
        const now = new Date();
        const windowStart = new Date(Math.floor(now.getTime() / this.windowMs) * this.windowMs).toISOString();

        try {
            // Try to increment existing record
            const result = this.db.prepare(`
                UPDATE rate_limits
                SET request_count = request_count + 1
                WHERE key = ? AND endpoint = ? AND window_start = ?
            `).run(key, '*', windowStart);

            if (result.changes === 0) {
                // Create new record
                this.db.prepare(`
                    INSERT INTO rate_limits (id, key, endpoint, window_start, request_count)
                    VALUES (?, ?, ?, ?, 1)
                `).run(generateId(), key, '*', windowStart);
            }

            // Get current count
            const row = this.db.prepare(`
                SELECT request_count FROM rate_limits
                WHERE key = ? AND endpoint = ? AND window_start = ?
            `).get(key, '*', windowStart);

            const resetTime = new Date(new Date(windowStart).getTime() + this.windowMs);

            return {
                totalHits: row?.request_count || 1,
                resetTime
            };
        } catch (err) {
            // On conflict, just return a safe default
            console.error('Rate limit increment error:', err.message);
            return { totalHits: 1, resetTime: new Date(now.getTime() + this.windowMs) };
        }
    }

    /**
     * Decrement the hit count (for successful requests).
     * express-rate-limit calls this when skipSuccessfulRequests is set, to
     * refund a successful response. It MUST actually decrement or that option
     * is a silent no-op — which made authLimiter count successful logins
     * against the 15-attempt lockout, so normal logins filled the bucket and a
     * single mistype tripped it. Mirror increment()'s key/window; floor at 0.
     */
    async decrement(key) {
        this.init();
        const now = new Date();
        const windowStart = new Date(Math.floor(now.getTime() / this.windowMs) * this.windowMs).toISOString();
        try {
            this.db.prepare(`
                UPDATE rate_limits
                SET request_count = MAX(request_count - 1, 0)
                WHERE key = ? AND endpoint = ? AND window_start = ?
            `).run(key, '*', windowStart);
        } catch (err) {
            console.error('Rate limit decrement error:', err.message);
        }
    }

    /**
     * Reset the count for a key
     */
    async resetKey(key) {
        this.init();
        this.db.prepare(`
            DELETE FROM rate_limits WHERE key = ?
        `).run(key);
    }

    /**
     * Clean up old records
     */
    cleanup() {
        this.init();
        const cutoff = new Date(Date.now() - this.windowMs * 2).toISOString();
        this.db.prepare(`
            DELETE FROM rate_limits WHERE window_start < ?
        `).run(cutoff);
    }
}

// ============================================================================
// Rate Limiter Factory
// ============================================================================

/**
 * Create a rate limiter with standard options
 */
function createLimiter(options = {}) {
    const {
        windowMs = 60 * 1000,  // 1 minute
        max = 100,             // 100 requests per window
        message = 'Too many requests, please try again later',
        keyGenerator,
        skipSuccessfulRequests = false,
        skipFailedRequests = false
    } = options;

    const store = new SqliteStore({ windowMs });

    return rateLimit({
        windowMs,
        max,
        message: { error: 'rate_limited', message },
        standardHeaders: true,
        legacyHeaders: false,
        store,
        // A caller presenting the valid INTERNAL_SERVICE_KEY is our own
        // backend, not a customer: throttling it starves vault resolution,
        // licence checks and membership verification, which then surface as
        // false authorization errors downstream (2026-09-21: identity/verify
        // 429s made the collector report an org member as not a member).
        // The compare is timing-safe; absent or wrong keys stay limited.
        skip: (req) => hasValidInternalServiceKey(req),
        keyGenerator: keyGenerator || ((req) => {
            // Use user ID if authenticated, otherwise IP
            return req.user?.id || req.serviceAccount?.id || req.ip;
        }),
        skipSuccessfulRequests,
        skipFailedRequests,
        handler: (req, res) => {
            res.status(429).json({
                error: 'rate_limited',
                message,
                retryAfter: Math.ceil(windowMs / 1000)
            });
        }
    });
}

// ============================================================================
// Pre-configured Limiters
// ============================================================================

// Helper to read env as integer with a default
const envInt = (key, fallback) => {
    const val = process.env[key];
    return val ? parseInt(val, 10) : fallback;
};

/**
 * Strict limiter for authentication endpoints (login, signup)
 * Configurable via RATE_LIMIT_AUTH_MAX / RATE_LIMIT_AUTH_WINDOW_MS
 */
export { createLimiter };

export const authLimiter = createLimiter({
    windowMs: envInt('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60 * 1000),  // default 15 minutes
    max: envInt('RATE_LIMIT_AUTH_MAX', 15),
    message: 'Too many authentication attempts, please try again later',
    keyGenerator: (req) => req.ip,  // Always use IP for auth
    skipSuccessfulRequests: true    // Only count failed attempts
});

/**
 * Password reset limiter
 * 3 requests per hour per email
 */
export const passwordResetLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 3,
    message: 'Too many password reset requests',
    keyGenerator: (req) => `reset:${(req.body?.email || '').toLowerCase().trim() || req.ip}`
});

/**
 * Email verification limiter
 * 5 requests per hour per user
 */
export const emailVerifyLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: 'Too many verification requests',
    keyGenerator: (req) => `verify:${req.user?.id || req.ip}`
});

/**
 * MFA verification limiter
 * 5 attempts per 5 minutes
 */
export const mfaLimiter = createLimiter({
    windowMs: 5 * 60 * 1000,
    max: 5,
    message: 'Too many MFA attempts, please try again later',
    keyGenerator: (req) => `mfa:${req.user?.id || req.ip}`,
    skipSuccessfulRequests: true
});

/**
 * Standard API limiter
 * Configurable via RATE_LIMIT_API_MAX / RATE_LIMIT_API_WINDOW_MS
 */
export const apiLimiter = createLimiter({
    windowMs: envInt('RATE_LIMIT_API_WINDOW_MS', 60 * 1000),  // default 1 minute
    max: envInt('RATE_LIMIT_API_MAX', 300),
    message: 'Rate limit exceeded'
});

/**
 * Invite creation limiter
 * Configurable via RATE_LIMIT_INVITE_MAX / RATE_LIMIT_INVITE_WINDOW_MS
 */
export const inviteLimiter = createLimiter({
    windowMs: envInt('RATE_LIMIT_INVITE_WINDOW_MS', 60 * 60 * 1000),  // default 1 hour
    max: envInt('RATE_LIMIT_INVITE_MAX', 20),
    message: 'Too many invites sent, please try again later'
});

/**
 * Organization creation limiter
 * 10 orgs per day per user (dev default; should be tier-based — free vs enterprise)
 */
export const orgCreationLimiter = createLimiter({
    windowMs: 24 * 60 * 60 * 1000,
    max: 10,
    message: 'Too many organizations created, please try again tomorrow'
});

/**
 * GDPR data export limiter (Security Issue #56)
 * 1 export per hour per user
 */
export const dataExportLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 1,
    message: 'Data export limit reached. You can request another export in 1 hour.',
    keyGenerator: (req) => `export:${req.user?.id || req.ip}`
});

/**
 * Email test limiter (Security Issue #43)
 * 5 test emails per hour per user to prevent abuse
 */
export const emailTestLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 5,
    message: 'Too many test email requests, please try again later',
    keyGenerator: (req) => `email_test:${req.user?.id || req.ip}`
});

// QUOXTRUST S2 (FND_01M3CJJQSWWJN76YV35DWJN76Y): /api/notifications/send-email was
// requireAuth-only with no rate limit, so any authenticated user could drive the org
// SMTP relay unbounded. Bounds bulk abuse while leaving the legitimate per-user alert
// path (alertService -> coreCommsService.sendEmail) comfortable headroom.
export const sendEmailLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 60,
    message: 'Too many email send requests, please try again later',
    keyGenerator: (req) => `email_send:${req.user?.id || req.ip}`
});

// ============================================================================
// Cleanup Task
// ============================================================================

let cleanupInterval = null;

export function startCleanup(intervalMs = 60 * 60 * 1000) {
    if (cleanupInterval) return;

    const store = new SqliteStore({ windowMs: 60000 });
    cleanupInterval = setInterval(() => {
        try {
            store.cleanup();
        } catch (err) {
            console.error('Rate limit cleanup error:', err.message);
        }
    }, intervalMs);

    // Don't prevent process exit
    cleanupInterval.unref();
}

export function stopCleanup() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

export default {
    createLimiter,
    authLimiter,
    passwordResetLimiter,
    emailVerifyLimiter,
    mfaLimiter,
    apiLimiter,
    inviteLimiter,
    orgCreationLimiter,
    dataExportLimiter,
    emailTestLimiter,
    sendEmailLimiter,
    startCleanup,
    stopCleanup
};
