/**
 * LICENSE-LAUNCH LL-9i2 (Quox Verified, dependency 2) — internal current-lease
 * accessor.
 *
 * GET /api/internal/current-lease  ->  { lease } | { lease: null }
 *
 * The collector-side (CJS) WARD "quox-verified" sink cannot read auth's
 * instance_config directly, so it asks auth for the instance's CURRENT valid
 * lease — the same signed token entitlements.js trusts: it cryptographically
 * verifies against the embedded quox.ai public key, is bound to THIS instance,
 * and is unexpired. When several qualify, the longest-lived (latest expiry) is
 * returned deterministically.
 *
 * WHAT THIS RETURNS: the lease is a PUBLIC signed proof-of-holding. It carries
 * NO signing key and NO secret — it is the same object quox.ai handed the box
 * on activation. It is returned verbatim so the sink can forward it to the
 * countersign endpoint as proof the box is licensed.
 *
 * WHY IT IS INTERNAL-ONLY (orchestrator review note 1, BINDING): the presence
 * of a lease is an "is this box licensed" signal that must not become an
 * external surface. This router is INTERNAL_SERVICE_KEY gated (X-Service-Key,
 * timing-safe, fail CLOSED when the key is unconfigured), mounted under
 * /api/internal only, and never added to any public allowlist — the same gate
 * every other /api/internal router uses (see internal-instance.js,
 * internal-orgs.js).
 *
 * Fail-safe: no stored lease, or none that verifies / binds / is live, reads as
 * { lease: null } rather than erroring, so the sink simply skips the
 * countersignature (fail-soft) and never gates local evidence on it.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { verifyLease } from '../lib/licenseVerify.js';
import { getInstanceId } from '../lib/instanceIdentity.js';

const router = Router();

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying current-lease request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

/**
 * The instance's current valid lease, resolved exactly the way entitlements.js
 * resolves entitlements: verify, instance-bound, unexpired. Corrupted rows are
 * skipped, not fatal.
 */
function resolveCurrentLease(db) {
  const instanceId = getInstanceId(db);
  if (!instanceId) return null;

  const rows = db.prepare("SELECT value FROM instance_config WHERE key LIKE 'licensing.lease.%'").all();
  const now = Date.now();
  let best = null;
  let bestExpiry = -Infinity;

  for (const row of rows) {
    let lease;
    try {
      const parsed = JSON.parse(row.value);
      lease = parsed?.lease;
    } catch {
      continue; // corrupted row — skip, never fail the whole read
    }
    if (!lease) continue;

    const verification = verifyLease(lease);
    if (!verification.valid) continue;
    if (lease.instance_id !== instanceId) continue;

    const expiresAtMs = Date.parse(lease.expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;

    if (expiresAtMs > bestExpiry) {
      best = lease;
      bestExpiry = expiresAtMs;
    }
  }

  return best;
}

router.get('/current-lease', (req, res) => {
  const db = req.db || getDb();
  return res.json({ lease: resolveCurrentLease(db) });
});

/**
 * LICENSE-LAUNCH LL-9i3 — the Quox Verified enable flag, for the WARD sink.
 *
 * NO-ENV-ONLY-CONFIG (owner hard rule): the sink's switch is a server-side
 * instance_config value (licensing.quox_verified.enabled), with the env flag
 * WARD_QUOX_VERIFIED_ENABLED kept only as the fallback default. The sink reads
 * it here and the dashboard writes it via /api/admin/quox-verified/config.
 *
 * Returns { enabled: true | false | null }: a boolean when instance_config has
 * a value, or null when it is UNSET so the sink defers to its env default. The
 * env flag is resolved sink-side, not here, so this endpoint reports only the
 * stored instance_config state. Internal-only + service-key gated, same as the
 * current-lease accessor above.
 */
router.get('/quox-verified-enabled', (req, res) => {
  const db = req.db || getDb();
  let enabled = null;
  try {
    const row = db.prepare("SELECT value FROM instance_config WHERE key = 'licensing.quox_verified.enabled'").get();
    if (row && (row.value === 'true' || row.value === 'false')) {
      enabled = row.value === 'true';
    }
  } catch {
    enabled = null; // unreadable -> unset; the sink falls back to its env default
  }
  return res.json({ enabled });
});

export default router;
