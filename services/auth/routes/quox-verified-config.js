/**
 * LICENSE-LAUNCH LL-9i3 — Quox Verified enablement config (admin surface).
 *
 * NO-ENV-ONLY-CONFIG (owner hard rule): the WARD "quox-verified" sink used to
 * be gated ONLY on the env flag WARD_QUOX_VERIFIED_ENABLED. This route makes
 * the switch a server-side instance_config value (licensing.quox_verified.enabled)
 * that an instance admin reads and writes from the dashboard. The env flag is
 * kept as the fallback DEFAULT; the instance_config value WINS when set.
 *
 * The sink reads the same value over the internal service-key channel
 * (GET /api/internal/quox-verified-enabled); this router is the human-facing
 * read/write half, admin-gated and audited. Mirrors routes/retention.js's
 * instance-config admin pattern.
 *
 *   GET   /api/admin/quox-verified/config   -> { enabled, source, envDefault }
 *   PATCH /api/admin/quox-verified/config   { enabled: bool } -> { enabled, source }
 */

import express from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireInstanceAdmin } from '../middleware/instanceAdmin.js';
import { logAudit, AuditActions } from '../utils/audit.js';

const router = express.Router();

const CONFIG_KEY = 'licensing.quox_verified.enabled';

function envDefaultEnabled() {
  return process.env.WARD_QUOX_VERIFIED_ENABLED === '1';
}

/** Resolve effective enablement: instance_config wins, env is the fallback. */
function readEffective(db) {
  const envDefault = envDefaultEnabled();
  let row = null;
  try {
    row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(CONFIG_KEY);
  } catch {
    row = null;
  }
  if (row && (row.value === 'true' || row.value === 'false')) {
    return { enabled: row.value === 'true', source: 'instance_config', envDefault };
  }
  return { enabled: envDefault, source: 'env-default', envDefault };
}

/**
 * GET /api/admin/quox-verified/config
 * Instance admin: current Quox Verified enablement + where it comes from.
 */
router.get('/admin/quox-verified/config', requireAuth, requireInstanceAdmin('readonly'), (req, res) => {
  try {
    res.json(readEffective(getDb()));
  } catch (err) {
    console.error('Get quox-verified config error:', err);
    res.status(500).json({ error: 'Failed to read Quox Verified configuration' });
  }
});

/**
 * PATCH /api/admin/quox-verified/config  { enabled: boolean }
 * Instance admin: set (or update) the instance_config override.
 */
router.patch('/admin/quox-verified/config', requireAuth, requireInstanceAdmin('admin'), (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO instance_config (key, value, value_type, updated_at, updated_by)
      VALUES (?, ?, 'boolean', datetime('now'), ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        value_type = 'boolean',
        updated_at = datetime('now'),
        updated_by = excluded.updated_by
    `).run(CONFIG_KEY, enabled ? 'true' : 'false', req.user.id);

    logAudit({
      action: AuditActions.CONFIG_UPDATE || 'admin.config.update',
      actor: { type: 'user', id: req.user.id },
      target: { type: 'config', id: CONFIG_KEY },
      status: 'success',
      request: req,
      metadata: { key: CONFIG_KEY, newValue: enabled ? 'true' : 'false' },
    });

    res.json({ enabled, source: 'instance_config' });
  } catch (err) {
    console.error('Update quox-verified config error:', err);
    res.status(500).json({ error: 'Failed to update Quox Verified configuration' });
  }
});

export default router;
