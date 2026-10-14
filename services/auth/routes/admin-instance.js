/**
 * Instance basics AFTER setup: GET/PUT /api/admin/instance/basics.
 *
 * POST /api/setup/config writes appBaseUrl and the other class-B basics but is
 * locked by requireSetupIncomplete, so once the wizard is done an operator had
 * no surface to change the public app URL. This router is that surface.
 * Server-side instance_config is the source of truth; validation is the same
 * validateInstanceBasics the wizard uses.
 *
 *   GET  readonly instance admin   stored values + the effective app URL
 *   PUT  admin instance admin      absent field = untouched, null/'' = clear
 *
 * Mounted on the narrow '/api/admin/instance' subtree before adminRoutes.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requireInstanceAdmin } from '../middleware/instanceAdmin.js';
import { getDb } from '../db/index.js';
import { logAudit, AuditActions } from '../utils/audit.js';
import { validateInstanceBasics } from './setup.js';
import { resolveAppBaseUrl, readInstanceConfigValue } from '../lib/instanceConfigOverrides.js';

const FIELDS = {
    appBaseUrl: 'app_base_url',
    publicUrl: 'public_url',
    collectorPublicUrl: 'collector_public_url',
    corsOrigins: 'cors_origins',
    cookieSecure: 'cookie_secure',
    matrixServerName: 'matrix_server_name'
};

export function createInstanceBasicsRouter(guards) {
    const router = Router();

    router.get('/basics', guards.read, (req, res) => {
        const basics = {};
        for (const [field, key] of Object.entries(FIELDS)) {
            const v = readInstanceConfigValue(key);
            basics[field] = field === 'cookieSecure' ? (v === 'true' ? true : v === 'false' ? false : null) : v;
        }
        res.json({
            basics,
            effective: {
                appBaseUrl: resolveAppBaseUrl(),
                appBaseUrlSource: basics.appBaseUrl ? 'instance_config' : 'env'
            }
        });
    });

    router.put('/basics', guards.write, (req, res) => {
        const body = req.body || {};
        const present = Object.keys(FIELDS).filter(f => body[f] !== undefined);
        if (present.length === 0) {
            return res.status(400).json({ error: 'no_fields', message: `Supply at least one of: ${Object.keys(FIELDS).join(', ')}` });
        }
        const check = validateInstanceBasics(body);
        if (!check.valid) {
            return res.status(400).json({ error: 'validation_failed', errors: check.errors });
        }
        const db = getDb();
        const updated = [];
        const cleared = [];
        for (const field of present) {
            const key = FIELDS[field];
            let value = body[field];
            if (value === null || value === '') {
                db.prepare('DELETE FROM instance_config WHERE key = ?').run(key);
                cleared.push(field);
                continue;
            }
            if (field === 'corsOrigins') value = value.split(',').map(o => o.trim()).filter(Boolean).join(',');
            db.prepare(`
                INSERT INTO instance_config (key, value, updated_at, updated_by)
                VALUES (?, ?, datetime('now'), ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
            `).run(key, String(value), req.user.id);
            updated.push(field);
        }
        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: 'instance_basics' },
            status: 'success',
            request: req,
            metadata: { updated, cleared }
        });
        res.json({ success: true, updated, cleared, effective: { appBaseUrl: resolveAppBaseUrl() } });
    });

    // LAN integration targets: the instance gate that lets self-hosted integration types
    // (Ollama, LM Studio, vLLM, Grafana, Proxmox ...) point at RFC1918 addresses. Default OFF.
    // Loopback and link-local stay blocked whatever this says (utils/urlValidation.js).
    const LAN_KEY = 'allow_lan_integration_targets';
    const lanEnabled = () => ['true', '1'].includes(String(readInstanceConfigValue(LAN_KEY)));

    router.get('/lan-targets', guards.read, (req, res) => {
        res.json({ enabled: lanEnabled(), key: LAN_KEY });
    });

    router.put('/lan-targets', guards.write, (req, res) => {
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'validation_failed', message: 'enabled must be true or false' });
        }
        getDb().prepare(`
            INSERT INTO instance_config (key, value, updated_at, updated_by)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(LAN_KEY, String(enabled), req.user.id);
        logAudit({
            action: AuditActions.CONFIG_UPDATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: LAN_KEY },
            status: 'success',
            request: req,
            metadata: { key: LAN_KEY, enabled }
        });
        res.json({ success: true, enabled: lanEnabled(), key: LAN_KEY });
    });

    return router;
}

const adminGate = requireInstanceAdmin('admin');
const readGate = requireInstanceAdmin('readonly');
const authn = authenticate();

export default createInstanceBasicsRouter({
    read: [authn, readGate],
    write: [authn, adminGate]
});
