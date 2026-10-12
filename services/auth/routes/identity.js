/**
 * MCPB-HARDEN-1a — Identity / membership verification (internal service-to-service).
 *
 * Allows the collector to validate that a (org_id, user_id) pair supplied
 * in an MCP service-key request actually corresponds to an active membership,
 * closing the forgeable-audit-attribution gap where any holder of
 * INTERNAL_SERVICE_KEY could impersonate any user.
 *
 * Route: GET /api/internal/identity/verify?org_id=X&user_id=Y
 *   200 { ok: true, role: '<role>' }   — active membership found
 *   404 { ok: false, error: 'membership_not_found' }
 *   400 { error: 'org_id and user_id required' }  — missing params
 *   401                                            — bad/missing service key
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';

const router = Router();

/**
 * Internal service key auth middleware.
 * Fails closed when INTERNAL_SERVICE_KEY is not configured.
 */
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

router.use(requireInternalAuth);

/**
 * GET /api/internal/identity/verify?org_id=X&user_id=Y
 *
 * Returns the role of an active org membership, or 404 if none exists.
 * Used by the collector to validate service-key-supplied org_id/user_id before
 * trusting them for audit envelope attribution.
 */
router.get('/identity/verify', (req, res) => {
    const { org_id, user_id } = req.query;

    if (!org_id || !user_id) {
        return res.status(400).json({ error: 'org_id and user_id required' });
    }

    try {
        // req.db allows test injection; fall back to the singleton in production
        const db = req.db || getDb();
        const row = db.prepare(`
            SELECT role FROM org_memberships
            WHERE org_id = ? AND user_id = ? AND status = 'active'
            LIMIT 1
        `).get(org_id, user_id);

        if (!row) {
            return res.status(404).json({ ok: false, error: 'membership_not_found' });
        }

        return res.json({ ok: true, role: row.role });
    } catch (err) {
        console.error('[identity/verify] DB error:', err.message);
        return res.status(500).json({ error: 'internal_error' });
    }
});

/**
 * GET /api/internal/identity/display-name?org_id=X&user_id=Y
 *
 * HITL-CONTEXT: lets the collector show "Adam" instead of a bare user id on an
 * approval card. Org-scoped (active membership required, so one tenant can
 * never read another's names) and returns the display name ONLY, never email.
 */
router.get('/identity/display-name', (req, res) => {
    const { org_id, user_id } = req.query;
    if (!org_id || !user_id) {
        return res.status(400).json({ error: 'org_id and user_id required' });
    }
    try {
        const db = req.db || getDb();
        const row = db.prepare(`
            SELECT u.display_name AS display_name
            FROM org_memberships m JOIN users u ON u.id = m.user_id
            WHERE m.org_id = ? AND m.user_id = ? AND m.status = 'active'
            LIMIT 1
        `).get(org_id, user_id);
        const name = row && typeof row.display_name === 'string' ? row.display_name.trim() : '';
        if (!row || !name) {
            return res.status(404).json({ ok: false, error: 'name_not_found' });
        }
        return res.json({ ok: true, display_name: name.slice(0, 80) });
    } catch (err) {
        console.error('[identity/display-name] DB error:', err.message);
        return res.status(500).json({ error: 'internal_error' });
    }
});

export default router;
