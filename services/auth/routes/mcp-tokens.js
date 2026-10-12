/**
 * MCPB-HARDEN-2B — Per-user MCP token issuance, listing, and revocation.
 *
 * Default export: user-facing router (mount at /api/auth/tokens/mcp)
 *   POST   /      — issue a new MCP token
 *   GET    /      — list caller's tokens (no hashes ever returned)
 *   DELETE /:id   — revoke a token owned by the caller
 *
 * Named export `internalRouter`: service-key-auth router (mount at /api/internal/mcp/tokens)
 *   POST /validate — validate a raw qmcp_* token (used by the collector)
 *
 * DB design note: route handlers use `req.db || getDb()` (same pattern as identity.js)
 * so tests can inject an in-memory DB via `req.db` without touching the singleton.
 * The queries object from db/index.js uses a module-level `prepare()` that calls
 * `getDb()` internally, which would NOT pick up `req.db`. Therefore all handlers
 * use raw `db.prepare()` calls directly — cleaner test injection, no indirection.
 */

import { randomBytes, createHash } from 'crypto';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { safeCompare } from '../utils/crypto.js';
import { getDb } from '../db/index.js';
import { generateId } from '../utils/crypto.js';

// ============================================================================
// Internal auth middleware (mirrors identity.js:26-35 exactly)
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
// Token generation helpers
// ============================================================================

/**
 * Generate a raw MCP token: `qmcp_` + 32 chars (base64url, sliced to 32).
 * Total length = 5 + 32 = 37 characters.
 */
function generateMcpToken() {
    // randomBytes(24) → base64url is 32 chars (ceil(24*4/3) = 32, no padding in base64url)
    const body = randomBytes(24).toString('base64url');
    return `qmcp_${body}`;
}

function sha256hex(data) {
    return createHash('sha256').update(data).digest('hex');
}

// ============================================================================
// User-facing router
// ============================================================================

const router = Router();
router.use(requireAuth);

/**
 * POST /api/auth/tokens/mcp
 * Issue a new MCP token for the authenticated user.
 */
router.post('/', (req, res) => {
    const { label } = req.body || {};

    // Validate org context.
    // authenticate() sets req.org when payload.org_id is present and the membership
    // is active. req.user.orgId is only set for service-account tokens (not JWT users).
    // JWT users must have req.org populated — if absent, no active org context.
    const orgId = req.org?.id;
    if (!orgId) {
        return res.status(400).json({
            error: 'org_context_required',
            message: 'An active organisation context is required to issue MCP tokens. Switch to an org workspace first.'
        });
    }

    // Validate label
    if (label === undefined || label === null) {
        return res.status(400).json({ error: 'label_required', message: 'label is required' });
    }
    const trimmedLabel = String(label).trim();
    if (trimmedLabel.length === 0) {
        return res.status(400).json({ error: 'label_required', message: 'label must not be empty' });
    }
    if (trimmedLabel.length > 128) {
        return res.status(400).json({ error: 'label_too_long', message: 'label must be 128 characters or fewer' });
    }

    const id = generateId();
    const rawToken = generateMcpToken();
    const token_hash = sha256hex(rawToken);

    const db = req.db || getDb();
    db.prepare(`
        INSERT INTO mcp_tokens (id, user_id, org_id, token_hash, label, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(id, req.user.id, orgId, token_hash, trimmedLabel);

    // Fetch created_at from DB so the value is consistent
    const row = db.prepare(`SELECT created_at FROM mcp_tokens WHERE id = ?`).get(id);

    // Return the raw token exactly once — never stored, never retrievable again
    return res.status(201).json({
        id,
        token: rawToken,
        label: trimmedLabel,
        created_at: row ? row.created_at : null
    });
});

/**
 * GET /api/auth/tokens/mcp
 * List the authenticated user's MCP tokens (no hashes).
 */
router.get('/', (req, res) => {
    const db = req.db || getDb();
    const tokens = db.prepare(`
        SELECT id, label, created_at, last_used_at, revoked_at
        FROM mcp_tokens
        WHERE user_id = ?
        ORDER BY created_at DESC
    `).all(req.user.id);

    // Defense-in-depth: assert no hash sneaked through
    for (const t of tokens) {
        if ('token_hash' in t) {
            // This would be a programming error, not a user error
            console.error('[SECURITY BUG] token_hash present in user-facing token list — stripping');
            delete t.token_hash;
        }
    }

    return res.status(200).json({ tokens });
});

/**
 * DELETE /api/auth/tokens/mcp/:id
 * Revoke a token owned by the authenticated user.
 * Returns 404 for not-found and already-revoked (no information leak).
 */
router.delete('/:id', (req, res) => {
    const db = req.db || getDb();
    // Use max(now, created_at + 1s) to satisfy the schema CHECK (revoked_at > created_at).
    // In the common case the two timestamps differ by seconds; only a same-second insert
    // and immediate revoke (e.g. in tests) can hit the boundary.
    const result = db.prepare(`
        UPDATE mcp_tokens
        SET revoked_at = max(datetime('now'), datetime(created_at, '+1 second'))
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(req.params.id, req.user.id);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'not_found_or_already_revoked' });
    }
    return res.status(204).send();
});

// ============================================================================
// Internal router (service-key auth — for collector)
// ============================================================================

export const internalRouter = Router();
internalRouter.use(requireInternalAuth);

/**
 * POST /api/internal/mcp/tokens/validate
 * Validate a raw qmcp_* token received by the collector.
 * Always returns 200 with { valid } — auth failure is communicated in payload.
 */
internalRouter.post('/validate', (req, res) => {
    const { token } = req.body || {};

    if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'token_required', message: 'token must be a non-empty string' });
    }

    const hash = sha256hex(token);
    const db = req.db || getDb();
    const row = db.prepare(`
        SELECT id, user_id, org_id, label, agent_id, created_at, last_used_at, revoked_at
        FROM mcp_tokens
        WHERE token_hash = ?
    `).get(hash);

    if (!row) {
        return res.status(200).json({ valid: false, reason: 'unknown' });
    }

    if (row.revoked_at != null) {
        return res.status(200).json({ valid: false, reason: 'revoked' });
    }

    // Best-effort usage timestamp — swallow errors to never break validation
    try {
        db.prepare(`UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
    } catch (err) {
        console.warn('[mcp-tokens] touchMcpTokenUsage failed (non-fatal):', err.message);
    }

    return res.status(200).json({
        valid: true,
        token_id: row.id,
        user_id: row.user_id,
        org_id: row.org_id,
        label: row.label,
        // P2: token-bound agent identity (admin agent-identity mint). Null
        // for ordinary user tokens; the collector prefers this over any
        // request-body agent_id when present.
        agent_id: row.agent_id ?? null
    });
});

export default router;
