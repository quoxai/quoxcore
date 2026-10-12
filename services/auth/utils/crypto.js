/**
 * Cryptographic utilities for Quox Auth Service
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { ulid } from 'ulid';

// Environment configuration
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('[SECURITY] WARNING: JWT_SECRET not set — authentication will fail. Set JWT_SECRET (min 32 chars).');
}
const DEFAULT_SECRET = 'dev-secret-change-in-production'; // Only used for comparison in validateJwtSecurity()
const JWT_ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY || '1h';
const JWT_REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';

// Track if we've warned about insecure secret
let secretWarningShown = false;

/**
 * Validate JWT configuration security
 * @returns {{ secure: boolean, warnings: string[] }}
 */
export function validateJwtSecurity() {
    // STABILITY-AUDITS: an absent JWT_SECRET used to fall through to
    // `JWT_SECRET.length` below and crash with an opaque TypeError
    // ("Cannot read properties of undefined"). Name the real problem
    // immediately — the caller (server.js boot) catches and exits either
    // way, but the logged message now says what's actually wrong.
    if (!JWT_SECRET) {
        throw new Error('JWT_SECRET is required — set it in your environment (min 32 chars).');
    }

    const warnings = [];
    const isProduction = process.env.NODE_ENV === 'production';
    const isDefaultSecret = JWT_SECRET === DEFAULT_SECRET;
    const isWeakSecret = JWT_SECRET.length < 32;

    if (isDefaultSecret) {
        warnings.push('JWT_SECRET is using the default insecure value. Set a secure secret in production!');
    } else if (isWeakSecret) {
        warnings.push(`JWT_SECRET is only ${JWT_SECRET.length} characters. Recommended: 64+ characters.`);
    }

    // In production, these are critical errors
    if (isProduction && isDefaultSecret) {
        throw new Error(
            '\n' +
            '╔═══════════════════════════════════════════════════════════════════╗\n' +
            '║  CRITICAL SECURITY ERROR: Cannot start in production mode         ║\n' +
            '║  with default JWT_SECRET. Generate a secure secret:               ║\n' +
            '║                                                                    ║\n' +
            '║  node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'base64url\'))"  ║\n' +
            '║                                                                    ║\n' +
            '║  Then set JWT_SECRET in your .env file or environment.            ║\n' +
            '╚═══════════════════════════════════════════════════════════════════╝'
        );
    }

    return {
        secure: !isDefaultSecret && !isWeakSecret,
        warnings,
        isProduction,
        secretLength: JWT_SECRET.length
    };
}

/**
 * Generate a cryptographically secure JWT secret
 * @param {number} bytes - Number of bytes (default 64)
 * @returns {string} Base64url encoded secret
 */
export function generateSecureSecret(bytes = 64) {
    return randomBytes(bytes).toString('base64url');
}

/**
 * Log security warnings (only once per startup)
 */
export function logSecurityWarnings() {
    if (secretWarningShown) return;
    secretWarningShown = true;

    const { secure, warnings, isProduction } = validateJwtSecurity();

    if (warnings.length > 0) {
        console.warn('\n' +
            '╔═══════════════════════════════════════════════════════════════════╗\n' +
            '║  ⚠️  JWT SECURITY WARNINGS                                         ║\n' +
            '╠═══════════════════════════════════════════════════════════════════╣'
        );
        warnings.forEach(w => {
            console.warn(`║  ${w.padEnd(65)}║`);
        });
        console.warn(
            '╠═══════════════════════════════════════════════════════════════════╣\n' +
            '║  Generate a secure secret:                                        ║\n' +
            '║  npm run generate-secret                                          ║\n' +
            '╚═══════════════════════════════════════════════════════════════════╝\n'
        );
    }

    return { secure, warnings };
}

// ============================================================================
// ID Generation
// ============================================================================

export function generateId() {
    return ulid();
}

export function generateToken(bytes = 32) {
    return randomBytes(bytes).toString('base64url');
}

export function generateApiKey() {
    // Format: msk_<prefix>_<secret>
    const prefix = randomBytes(4).toString('hex');  // 8 chars
    const secret = randomBytes(24).toString('base64url');  // 32 chars
    return {
        key: `msk_${prefix}_${secret}`,
        prefix: prefix,
        hash: sha256(`msk_${prefix}_${secret}`)
    };
}

// ============================================================================
// Hashing
// ============================================================================

export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

export async function hashPassword(password) {
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,  // 64 MB
        timeCost: 3,
        parallelism: 4
    });
}

export async function verifyPassword(hash, password) {
    try {
        return await argon2.verify(hash, password);
    } catch {
        return false;
    }
}

// ============================================================================
// JWT Tokens
// ============================================================================

// QUOXIDENTITY P1: optional expiresIn override, same pattern as
// createRefreshToken's below. Every existing caller passes only `payload`
// and keeps getting JWT_ACCESS_EXPIRY; routes/agent-attach.js is the first
// caller to pass a per-lease ttl_seconds so a short attach lease mints a
// short-lived token instead of the default 1h.
export function createAccessToken(payload, { expiresIn } = {}) {
    return jwt.sign(
        {
            ...payload,
            type: 'access'
        },
        JWT_SECRET,
        { expiresIn: expiresIn || JWT_ACCESS_EXPIRY }
    );
}

// AUTH-REMEMBER-ME: optional expiresIn override (e.g. a longer duration
// for "remember me" logins). Defaults to JWT_REFRESH_EXPIRY, matching
// existing behaviour for every caller that doesn't pass one.
export function createRefreshToken(payload, { expiresIn } = {}) {
    const effectiveExpiry = expiresIn || JWT_REFRESH_EXPIRY;
    const token = generateToken(32);
    const signed = jwt.sign(
        {
            ...payload,
            type: 'refresh',
            jti: sha256(token).slice(0, 16)  // Token ID
        },
        JWT_SECRET,
        { expiresIn: effectiveExpiry }
    );
    return {
        token,
        signed,
        hash: sha256(token),
        expiresAt: new Date(Date.now() + parseDuration(effectiveExpiry)).toISOString()
    };
}

export function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
        return null;
    }
}

export function decodeToken(token) {
    return jwt.decode(token);
}

// ============================================================================
// MFA
// ============================================================================

export function generateBackupCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const code = randomBytes(5).toString('hex').toUpperCase();
        // Format: XXXX-XXXX
        const formatted = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
        codes.push({
            plain: formatted,
            hash: sha256(formatted)
        });
    }
    return codes;
}

// ============================================================================
// Helpers
// ============================================================================

function parseDuration(str) {
    const match = str.match(/^(\d+)([smhd])$/);
    if (!match) return 0;
    const [, num, unit] = match;
    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000
    };
    return parseInt(num) * multipliers[unit];
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Always performs the comparison in constant time regardless of input.
 * @param {string} a - First string to compare
 * @param {string} b - Second string to compare
 * @returns {boolean} - True if strings are equal
 */
export function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        // Still perform a comparison to maintain constant time
        const dummy = Buffer.from('dummy');
        timingSafeEqual(dummy, dummy);
        return false;
    }
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Compare against itself to maintain constant time and avoid length-based timing leak
        timingSafeEqual(bufA, bufA);
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}

// Export JWT config for reference
export const jwtConfig = {
    accessExpiry: JWT_ACCESS_EXPIRY,
    refreshExpiry: JWT_REFRESH_EXPIRY
};
