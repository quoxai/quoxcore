/**
 * SETEC S2: GET /api/v1/admin/instance-settings
 *
 * Read-only projection of the env registry for the dashboard's "Instance
 * settings" page. Mounted behind requireServiceOrUserAuth() (NOT in the
 * default-deny allowlist). Gate, fail closed at every step:
 *   1. a real human JWT session (service keys, agent and agent-ops sessions
 *      are rejected: 403),
 *   2. that user is an INSTANCE admin, proven by asking auth
 *      (GET /api/internal/instance-admin/:userId with the service key).
 *      Any failure to prove it is a 403, never a pass.
 * Rows: the collector's own projection, plus auth's (fetched from auth's
 * internal route). Vars read only by other services are listed honestly as
 * not reported yet. Values go through the shared allowlist projection; this
 * file never logs a value.
 */
'use strict';

function loadShared(file) {
  for (const p of [`../../shared/${file}`, `../services-shared/${file}`]) {
    try { return require(p); } catch { /* try next */ }
  }
  return null;
}

const REPORTING_SERVICES = ['collector', 'auth'];

function createInstanceSettingsHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const registry = deps.registry || (loadShared('envRegistry.cjs') || {}).ENV_REGISTRY || [];
  const proj = deps.projection || loadShared('envProjection.cjs');
  const authUrl = deps.authUrl || env.AUTH_SERVICE_URL || 'http://auth:3101';
  const isHumanAdmin = deps.isHumanAdmin;

  async function authGet(path) {
    const key = env.INTERNAL_SERVICE_KEY || '';
    if (!key) throw new Error('service_key_missing');
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
    try {
      const r = await fetchImpl(`${authUrl}${path}`, { headers: { 'x-service-key': key }, signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error(`auth_status_${r.status}`);
      return await r.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  return async function instanceSettingsHandler(req, res) {
    if (!proj) return res.status(503).json({ error: 'env_projection_unavailable' });
    if (!isHumanAdmin || !isHumanAdmin(req) || !req.user || !req.user.id) {
      return res.status(403).json({ error: 'instance_admin_required' });
    }
    try {
      const chk = await authGet(`/api/internal/instance-admin/${encodeURIComponent(req.user.id)}`);
      if (!chk || chk.isAdmin !== true) return res.status(403).json({ error: 'instance_admin_required' });
    } catch {
      return res.status(403).json({ error: 'instance_admin_required' });
    }

    const rows = [];
    const gaps = [];
    for (const r of proj.projectEnv(registry, env, { service: 'collector' })) {
      rows.push({ ...r, reportedBy: 'collector', restartNeeded: true });
    }
    let authOk = true;
    try {
      const a = await authGet('/api/internal/env-projection');
      for (const r of (a && Array.isArray(a.rows) ? a.rows : [])) {
        // Re-assert the allowlist on the way through: never trust a peer to have filtered.
        const entry = registry.find((e) => e.name === r.name);
        const safe = { ...r, reportedBy: 'auth', restartNeeded: true };
        delete safe.value;
        safe.shown = 'set-only';
        if (r.shown === 'value' && entry && proj.mayShowValue(entry, String(r.value))) {
          safe.shown = 'value';
          safe.value = String(r.value);
        }
        rows.push(safe);
      }
    } catch {
      authOk = false;
      gaps.push({ service: 'auth', reason: 'auth projection unavailable' });
    }
    // Vars read by services that do not report yet (and not by collector/auth).
    for (const e of proj.surfaceEntries(registry)) {
      const svcs = Array.isArray(e.services) ? e.services : [];
      if (svcs.some((s) => REPORTING_SERVICES.includes(s))) continue;
      rows.push({
        name: e.name, classification: e.classification, services: svcs, surface: e.surface || null,
        note: e.note || '', isSet: null, shown: 'not-reported', source: 'not-reported',
        reportedBy: null, restartNeeded: true,
      });
    }
    return res.json({ rows, gaps, authReported: authOk, generatedAt: new Date().toISOString() });
  };
}

module.exports = { createInstanceSettingsHandler };
