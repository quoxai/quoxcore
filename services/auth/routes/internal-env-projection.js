/**
 * SETEC S2: auth's own env projection for the collector's Instance settings
 * page, plus the instance-admin check the collector uses to gate that page.
 *
 *   GET /api/internal/env-projection            auth's own projection
 *   GET /api/internal/instance-admin/:userId    { isAdmin }
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY) only, timing-safe, fails CLOSED
 * when the key is not configured. Values are filtered by the shared allowlist
 * projection (services/shared/envProjection.cjs); secrets are set/unset only.
 * Nothing here logs a value.
 */
import { Router } from 'express';
import { createRequire } from 'node:module';
import { safeCompare } from '../utils/crypto.js';
import { checkInstanceAdmin } from '../middleware/instanceAdmin.js';

const require = createRequire(import.meta.url);

function loadShared(file) {
    // Dev: services/auth/routes -> services/shared. Docker: WORKDIR is
    // /app/services/auth so the same relative path resolves.
    for (const p of [`../../shared/${file}`, `../services/shared/${file}`]) {
        try { return require(p); } catch { /* try next */ }
    }
    return null;
}

export function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured, denying env-projection request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

const router = Router();
router.use('/env-projection', requireInternalAuth);
router.use('/instance-admin', requireInternalAuth);

router.get('/env-projection', (req, res) => {
    const reg = loadShared('envRegistry.cjs');
    const proj = loadShared('envProjection.cjs');
    if (!reg || !proj) return res.status(503).json({ error: 'env_registry_unavailable' });
    return res.json({ service: 'auth', rows: proj.projectEnv(reg.ENV_REGISTRY, process.env, { service: 'auth' }) });
});

router.get('/instance-admin/:userId', (req, res) => {
    try {
        const { isAdmin } = checkInstanceAdmin(String(req.params.userId || ''));
        return res.json({ isAdmin: Boolean(isAdmin) });
    } catch {
        return res.status(500).json({ error: 'instance_admin_check_failed' });
    }
});

export default router;
