/**
 * #453 phase 15 — resident agent identity, derived from an Ed25519 keypair
 * on a dev server's own host. Zero human minting: the host generates a
 * keypair itself, registers the public half, then proves possession of the
 * private half via challenge/response to get a real access JWT.
 *
 * Default export: internalRouter (mount /api/internal/resident-identities)
 *   X-Service-Key auth, mirrors requireInternalAuth in routes/mcp-tokens.js
 *   and routes/identity.js exactly. Called by whatever provisions the dev
 *   server (not by an interactive admin) — this is the "zero human minting"
 *   half of the flow.
 *
 *   POST /register  {org_id, host_id, public_key_b64, rotate?}
 *   POST /revoke     {org_id, host_id}
 *
 * Named export `publicRouter` (mount /api/auth/resident) — NO auth, this is
 * the whole point: an unauthenticated host proves it holds the private key
 * matching a previously registered public key and gets minted a session.
 *
 *   POST /challenge  {org_id, host_id}
 *   POST /token       {challenge_id, org_id, host_id, signature_b64}
 *
 * The minted JWT carries `agent_id: user.id` — load-bearing. The collector's
 * utils/httpAuth.js deriveActorType() reads req.user.agent_id to classify
 * the caller as an agent; every human-only gate downstream depends on that
 * claim being present and truthy. Never omit it.
 *
 * DB design note: handlers use `req.db || getDb()` (same pattern as
 * mcp-tokens.js / identity.js) so tests can inject an in-memory DB.
 *
 * Deviation from spec: on `rotate: true` against an existing (possibly
 * revoked) identity, status is reset to 'active'. There is no separate
 * "un-revoke" endpoint, and rotate is the natural re-enable path — a host
 * that lost its key material and was revoked needs a way back in that
 * doesn't require a brand new (org_id, host_id) row.
 */

import { randomBytes, createHash, createPublicKey, verify as edVerify } from 'crypto';
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare, generateId, createAccessToken, jwtConfig } from '../utils/crypto.js';
import { createLimiter } from '../middleware/rateLimit.js';

const AGENT_EMAIL_DOMAIN = 'agents.quox.local';
const HOST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CHALLENGE_TTL_MS = 60 * 1000;

// ============================================================================
// Internal auth middleware (mirrors mcp-tokens.js / identity.js exactly)
// ============================================================================

function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

// ============================================================================
// Helpers
// ============================================================================

function decodeBase64ToBuffer(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
        const buf = Buffer.from(value, 'base64');
        // Round-trip check: a genuinely non-base64 string can still decode
        // (Buffer.from is lenient) but won't round-trip to the same length.
        if (buf.length === 0) return null;
        return buf;
    } catch {
        return null;
    }
}

function buildEd25519PublicKeyObject(raw32) {
    return createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: raw32.toString('base64url') },
        format: 'jwk'
    });
}

/**
 * Seconds form of JWT_ACCESS_EXPIRY (e.g. '1h' -> 3600). Mirrors the
 * private parseDuration() in utils/crypto.js, which is not exported.
 */
function accessTokenExpirySeconds() {
    const match = /^(\d+)([smhd])$/.exec(jwtConfig.accessExpiry || '1h');
    if (!match) return 3600;
    const [, num, unit] = match;
    const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
    return parseInt(num, 10) * multipliers[unit];
}

/**
 * Find-or-create the actor_type='agent' user row + active 'builder'
 * membership for a resident host. Idempotent — safe to call on every
 * register, including the already_registered path.
 */
function ensureResidentUser(db, orgId, hostId) {
    const email = `resident+${hostId}@${AGENT_EMAIL_DOMAIN}`;

    let user = db.prepare('SELECT * FROM users WHERE primary_email = ?').get(email);
    if (!user) {
        const userId = generateId();
        db.prepare(`
            INSERT INTO users (id, primary_email, display_name, status, actor_type)
            VALUES (?, ?, ?, 'active', 'agent')
        `).run(userId, email, `Resident (${hostId})`);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    } else if (user.actor_type !== 'agent') {
        throw new Error(`user ${email} exists with actor_type '${user.actor_type}', refusing to bind a resident identity`);
    }

    const membership = db.prepare(
        'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?'
    ).get(orgId, user.id);
    if (!membership) {
        db.prepare(`
            INSERT INTO org_memberships (id, org_id, user_id, role, status)
            VALUES (?, ?, ?, 'builder', 'active')
        `).run(generateId(), orgId, user.id);
    }

    return user;
}

// ============================================================================
// Internal router — /api/internal/resident-identities
// ============================================================================

export const internalRouter = Router();
internalRouter.use(requireInternalAuth);

/**
 * POST /api/internal/resident-identities/register
 * Create-or-get the resident identity for (org_id, host_id). Re-registering
 * without rotate leaves the existing public key untouched — re-enable must
 * never silently rotate identity.
 */
internalRouter.post('/register', (req, res) => {
    const { org_id, host_id, public_key_b64, rotate } = req.body || {};

    if (!org_id || typeof org_id !== 'string') {
        return res.status(400).json({ error: 'org_id_required' });
    }
    if (!host_id || typeof host_id !== 'string' || !HOST_ID_RE.test(host_id)) {
        return res.status(400).json({ error: 'invalid_host_id', message: 'host_id must match /^[A-Za-z0-9._-]{1,64}$/' });
    }
    const rawKey = decodeBase64ToBuffer(public_key_b64);
    if (!rawKey || rawKey.length !== 32) {
        return res.status(400).json({ error: 'invalid_public_key', message: 'public_key_b64 must decode to exactly 32 bytes' });
    }

    const db = req.db || getDb();

    let user;
    try {
        user = ensureResidentUser(db, org_id, host_id);
    } catch (err) {
        return res.status(409).json({ error: 'actor_type_conflict', message: err.message });
    }

    const existing = db.prepare(
        'SELECT * FROM resident_identities WHERE org_id = ? AND host_id = ?'
    ).get(org_id, host_id);

    if (existing && rotate !== true) {
        return res.status(200).json({
            identity_id: existing.id,
            user_id: existing.user_id,
            key_id: existing.key_id,
            org_id: existing.org_id,
            host_id: existing.host_id,
            status: existing.status,
            already_registered: true
        });
    }

    if (existing && rotate === true) {
        const keyId = `resident-${host_id}-${randomBytes(4).toString('hex')}`;
        db.prepare(`
            UPDATE resident_identities
            SET public_key = ?, key_id = ?, status = 'active', rotated_at = datetime('now')
            WHERE id = ?
        `).run(rawKey.toString('base64'), keyId, existing.id);

        return res.status(200).json({
            identity_id: existing.id,
            user_id: existing.user_id,
            key_id: keyId,
            org_id,
            host_id,
            status: 'active'
        });
    }

    // Fresh row.
    const identityId = generateId();
    const keyId = `resident-${host_id}-${randomBytes(4).toString('hex')}`;
    db.prepare(`
        INSERT INTO resident_identities (id, org_id, host_id, key_id, public_key, user_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(identityId, org_id, host_id, keyId, rawKey.toString('base64'), user.id);

    return res.status(201).json({
        identity_id: identityId,
        user_id: user.id,
        key_id: keyId,
        org_id,
        host_id,
        status: 'active'
    });
});

/**
 * GET /api/internal/resident-identities/verify?org_id=&user_id=
 *
 * QUOXTRUST — the anchor the collector's resident-agent recognition trusts
 * (services/collector/lib/agentIdResolver.js isKnownResidentAgent). Answers:
 * is <user_id> a legitimate ACTIVE resident agent IN <org_id>? Org-scoped like
 * internal-assistants.js — a 404 for a revoked, cross-org, or unknown resident
 * IS the tenant + revocation boundary (the collector fails closed on it). The
 * collector passes org_id + user_id straight from the VERIFIED resident JWT
 * (agent_id claim == users-row ULID), never a body value, so this endpoint
 * never mints trust for a caller-supplied identity. Returns only non-secret
 * identity fields (no key material beyond the key_id label).
 */
internalRouter.get('/verify', (req, res) => {
    const orgId = req.query.org_id;
    const userId = req.query.user_id;
    if (!orgId || typeof orgId !== 'string') {
        return res.status(400).json({ error: 'org_id_required' });
    }
    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'user_id_required' });
    }

    const db = req.db || getDb();
    const row = db.prepare(`
        SELECT id, org_id, host_id, user_id, key_id, status
        FROM resident_identities
        WHERE org_id = ? AND user_id = ? AND status = 'active'
    `).get(orgId, userId);

    if (!row) {
        return res.status(404).json({ error: 'resident_not_found' });
    }
    return res.status(200).json({
        id: row.id,
        org_id: row.org_id,
        host_id: row.host_id,
        user_id: row.user_id,
        key_id: row.key_id,
        status: row.status,
    });
});

/**
 * POST /api/internal/resident-identities/revoke
 * 404 if no identity exists for (org_id, host_id).
 */
internalRouter.post('/revoke', (req, res) => {
    const { org_id, host_id } = req.body || {};
    if (!org_id || !host_id) {
        return res.status(400).json({ error: 'org_id_and_host_id_required' });
    }

    const db = req.db || getDb();
    const existing = db.prepare(
        'SELECT id, status FROM resident_identities WHERE org_id = ? AND host_id = ?'
    ).get(org_id, host_id);

    if (!existing) {
        return res.status(404).json({ error: 'not_found' });
    }

    db.prepare(`UPDATE resident_identities SET status = 'revoked' WHERE id = ?`).run(existing.id);

    return res.status(200).json({ identity_id: existing.id, org_id, host_id, status: 'revoked' });
});

// ============================================================================
// Public router — /api/auth/resident (no auth: this IS the auth)
// ============================================================================

export const publicRouter = Router();

// In-module challenge store. Keyed by challenge_id.
// { orgId, hostId, challengeBytes: Buffer, expiresAt: ms, used: boolean }
const challenges = new Map();

// Injectable clock for tests — production always uses Date.now.
let clockNow = () => Date.now();
export function __setClockForTests(fn) {
    clockNow = typeof fn === 'function' ? fn : () => Date.now();
}
// Test-only accessor so a suite can assert on/clear store state without
// reaching into module internals.
export function __getChallengeStoreForTests() {
    return challenges;
}

function pruneExpiredChallenges() {
    const now = clockNow();
    for (const [id, entry] of challenges) {
        if (entry.expiresAt <= now) challenges.delete(id);
    }
}

const residentAuthLimiter = createLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many resident authentication attempts, please try again later',
    keyGenerator: (req) => `resident:${req.ip}`
});

function failInvalidResidentAuth(res, reason) {
    console.warn(`[resident-identity] auth failed: ${reason}`);
    return res.status(401).json({ error: 'invalid_resident_auth' });
}

/**
 * POST /api/auth/resident/challenge
 * Always returns a challenge whether or not the identity exists — never
 * lets a caller enumerate registered hosts by probing this endpoint.
 */
publicRouter.post('/challenge', residentAuthLimiter, (req, res) => {
    const { org_id, host_id } = req.body || {};
    if (!org_id || !host_id) {
        return res.status(400).json({ error: 'org_id_and_host_id_required' });
    }

    pruneExpiredChallenges();

    const challengeId = generateId();
    const challengeBytes = randomBytes(32);
    challenges.set(challengeId, {
        orgId: org_id,
        hostId: host_id,
        challengeBytes,
        expiresAt: clockNow() + CHALLENGE_TTL_MS,
        used: false
    });

    return res.status(200).json({
        challenge_id: challengeId,
        challenge_b64: challengeBytes.toString('base64'),
        expires_in: CHALLENGE_TTL_MS / 1000
    });
});

/**
 * POST /api/auth/resident/token
 * Single-use challenge exchange for an access JWT. Every failure path
 * returns the same 401 shape; the specific cause is logged server-side
 * only, never returned to the caller.
 */
publicRouter.post('/token', residentAuthLimiter, (req, res) => {
    const { challenge_id, org_id, host_id, signature_b64 } = req.body || {};

    if (!challenge_id || !org_id || !host_id || !signature_b64) {
        return failInvalidResidentAuth(res, 'missing_fields');
    }

    pruneExpiredChallenges();

    const entry = challenges.get(challenge_id);
    if (!entry) {
        return failInvalidResidentAuth(res, 'challenge_not_found_or_expired');
    }
    if (entry.used) {
        return failInvalidResidentAuth(res, 'challenge_already_used');
    }
    if (entry.expiresAt <= clockNow()) {
        challenges.delete(challenge_id);
        return failInvalidResidentAuth(res, 'challenge_expired');
    }
    if (entry.orgId !== org_id || entry.hostId !== host_id) {
        return failInvalidResidentAuth(res, 'challenge_org_host_mismatch');
    }

    // Single-use: consume the challenge now, before signature verification,
    // so a failed attempt can never be retried against the same challenge.
    challenges.delete(challenge_id);

    const sigBuffer = decodeBase64ToBuffer(signature_b64);
    if (!sigBuffer) {
        return failInvalidResidentAuth(res, 'malformed_signature');
    }

    const db = req.db || getDb();
    const identity = db.prepare(
        `SELECT * FROM resident_identities WHERE org_id = ? AND host_id = ? AND status = 'active'`
    ).get(org_id, host_id);
    if (!identity) {
        return failInvalidResidentAuth(res, 'identity_not_found_or_revoked');
    }

    let valid;
    try {
        const rawKey = Buffer.from(identity.public_key, 'base64');
        const pubKeyObj = buildEd25519PublicKeyObject(rawKey);
        valid = edVerify(null, entry.challengeBytes, pubKeyObj, sigBuffer);
    } catch (err) {
        return failInvalidResidentAuth(res, `signature_verify_error: ${err.message}`);
    }
    if (!valid) {
        return failInvalidResidentAuth(res, 'bad_signature');
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
    if (!user) {
        return failInvalidResidentAuth(res, 'user_not_found');
    }
    const membership = db.prepare(
        `SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`
    ).get(org_id, identity.user_id);
    if (!membership) {
        return failInvalidResidentAuth(res, 'membership_not_found');
    }

    db.prepare(`UPDATE resident_identities SET last_used_at = datetime('now') WHERE id = ?`).run(identity.id);

    const accessToken = createAccessToken({
        sub: user.id,
        email: user.primary_email,
        org_id,
        role: membership.role,
        agent_id: user.id,
        resident_host: host_id,
        mfa_verified: false
    });

    return res.status(200).json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: accessTokenExpirySeconds(),
        user: {
            id: user.id,
            email: user.primary_email,
            role: membership.role,
            actor_type: 'agent',
            host_id
        }
    });
});
