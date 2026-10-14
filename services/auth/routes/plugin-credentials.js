/**
 * SEC-PLUGIN-TRUST C1: per-plugin host credentials (qplg_*).
 *
 * Internal router only (mount at /api/internal/plugin-credentials), service-key
 * auth. A qplg_ token itself can never mint, validate or revoke: those calls
 * need the instance master key, which no plugin container holds.
 *
 *   POST /mint     { plugin_id }  -> { token, plugin_id }  (raw token returned ONCE;
 *                                    revokes any prior active credential: rotation)
 *   POST /validate { token }      -> { valid, plugin_id } | { valid:false, reason }
 *   POST /revoke   { plugin_id }  -> { revoked: n }
 *
 * Handlers use `req.db || getDb()` so tests can inject a DB (mcp-tokens pattern).
 */
import { randomBytes, createHash } from 'crypto';
import { Router } from 'express';
import { safeCompare, generateId } from '../utils/crypto.js';
import { getDb } from '../db/index.js';

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured, denying request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const generatePluginToken = () => `qplg_${randomBytes(32).toString('base64url')}`;

export const internalRouter = Router();
internalRouter.use(requireInternalAuth);

internalRouter.post('/mint', (req, res) => {
    const pluginId = req.body?.plugin_id;
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
        return res.status(400).json({ error: 'invalid_plugin_id' });
    }
    const db = req.db || getDb();
    const token = generatePluginToken();
    const hash = sha256hex(token);
    db.transaction(() => {
        db.prepare(`UPDATE plugin_credentials SET revoked_at = datetime('now')
                    WHERE plugin_id = ? AND revoked_at IS NULL`).run(pluginId);
        db.prepare(`INSERT INTO plugin_credentials (id, plugin_id, token_hash) VALUES (?, ?, ?)`)
            .run(generateId(), pluginId, hash);
    })();
    return res.status(200).json({ token, plugin_id: pluginId });
});

internalRouter.post('/validate', (req, res) => {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'token_required' });
    }
    if (!token.startsWith('qplg_')) return res.status(200).json({ valid: false, reason: 'unknown' });
    const db = req.db || getDb();
    const row = db.prepare(`SELECT id, plugin_id, revoked_at FROM plugin_credentials WHERE token_hash = ?`)
        .get(sha256hex(token));
    if (!row) return res.status(200).json({ valid: false, reason: 'unknown' });
    if (row.revoked_at != null) return res.status(200).json({ valid: false, reason: 'revoked' });
    try {
        db.prepare(`UPDATE plugin_credentials SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
    } catch (err) {
        console.warn('[plugin-credentials] last_used_at update failed (non-fatal):', err.message);
    }
    return res.status(200).json({ valid: true, plugin_id: row.plugin_id });
});

internalRouter.post('/revoke', (req, res) => {
    const pluginId = req.body?.plugin_id;
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
        return res.status(400).json({ error: 'invalid_plugin_id' });
    }
    const db = req.db || getDb();
    const r = db.prepare(`UPDATE plugin_credentials SET revoked_at = datetime('now')
                          WHERE plugin_id = ? AND revoked_at IS NULL`).run(pluginId);
    return res.status(200).json({ revoked: r.changes });
});

export default internalRouter;
