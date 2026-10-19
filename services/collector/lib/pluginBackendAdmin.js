/**
 * Plugin backend admin: instance-wide authority checks (FND_01M4SZ7NNV4NZ57ZM6J34NZ57Z).
 *
 * The plugin backend registry (PLUGIN_BACKENDS), the tool maps and the plugin
 * containers are INSTANCE-WIDE state, but requireAdminRole is true for the
 * owner/admin of the caller's OWN org (any self-signup user). So:
 *   - ensure: an org admin may activate THEIR installed plugin, but the image,
 *     port and healthPath come from that org's installed manifest, never from
 *     the request body.
 *   - register / delete: instance admin only (human, confirmed by auth).
 * Everything fails closed. Pure and injectable so it tests without the server.
 */
'use strict';

function authBase(deps) {
  const env = deps.env || process.env;
  return { env, authUrl: deps.authUrl || env.AUTH_SERVICE_URL || 'http://auth:3101' };
}

async function authGet(path, deps) {
  const { env, authUrl } = authBase(deps);
  const key = env.INTERNAL_SERVICE_KEY || '';
  if (!key) throw new Error('service_key_missing');
  const fetchImpl = deps.fetch || globalThis.fetch;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
  try {
    const r = await fetchImpl(`${authUrl}${path}`, { headers: { 'x-service-key': key }, signal: ctl ? ctl.signal : undefined });
    if (!r.ok) throw new Error(`auth_status_${r.status}`);
    return await r.json();
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * 'yes' only for a human session whose user id auth confirms as instance admin; 'no' for every other caller
 * or a definite no from auth; 'unavailable' when auth could not answer (timeout, error, no service key), so a
 * caller can say "try again" instead of a misleading 403 (live 2026-10-15: auth mid-restart). Never 'yes' on doubt.
 */
async function checkInstanceAdmin(req, deps = {}) {
  if (!deps.isHumanAdmin || !deps.isHumanAdmin(req) || !req || !req.user || !req.user.id) return 'no';
  try {
    const chk = await authGet(`/api/internal/instance-admin/${encodeURIComponent(req.user.id)}`, deps);
    return chk && chk.isAdmin === true ? 'yes' : 'no';
  } catch {
    return 'unavailable';
  }
}
/** True only for a human session whose user id auth confirms as instance admin. */
async function isInstanceAdmin(req, deps = {}) {
  try { return (await checkInstanceAdmin(req, deps)) === 'yes'; } catch { return false; }
}

/** The org's own enabled install of pluginId: {image, port, healthPath} or null. */
async function resolveOrgBackend(orgId, pluginId, deps = {}) {
  if (!orgId || !pluginId) return null;
  try {
    const q = `orgId=${encodeURIComponent(orgId)}&pluginId=${encodeURIComponent(pluginId)}`;
    const body = await authGet(`/api/internal/plugins/backends?${q}`, deps);
    const b = (body && body.backends || []).find((x) => x.pluginId === pluginId && x.image && !x.conflict);
    if (!b) return null;
    return {
      image: b.image, port: b.port ?? null, healthPath: b.healthPath || '/health',
      official: b.official === true, community: b.official !== true && b.community === true,
      community_reason: b.community_reason || null,
    };
  } catch {
    return null;
  }
}

/**
 * True when the installs of pluginId across ALL orgs disagree on the backend
 * image (auth returns conflict:true), or when that cannot be established. The
 * gateway is keyed by plugin id instance-wide, so a disagreement means one org's
 * container would serve another org's traffic. Fails closed (true) on error.
 */
async function installsConflict(pluginId, deps = {}) {
  try {
    const body = await authGet(`/api/internal/plugins/backends?pluginId=${encodeURIComponent(pluginId)}`, deps);
    const list = (body && Array.isArray(body.backends)) ? body.backends : null;
    if (!list) return true;
    return list.some((x) => x.pluginId === pluginId && x.conflict === true);
  } catch {
    return true;
  }
}

/**
 * The INSTANCE-WIDE entry auth reports for pluginId (all orgs' installs folded,
 * eligible only if every install is), or null when it cannot be established.
 */
async function instanceBackend(pluginId, deps = {}) {
  try {
    const body = await authGet(`/api/internal/plugins/backends?pluginId=${encodeURIComponent(pluginId)}`, deps);
    const list = (body && Array.isArray(body.backends)) ? body.backends : [];
    return list.find((x) => x.pluginId === pluginId) || null;
  } catch {
    return null;
  }
}

/**
 * SEC-PLUGIN-TRUST P5: which trust path lets this entry's backend run.
 * 'official' (shipped bytes + shipped image), 'community' (signature v2 from a
 * trusted, unrevoked key over a digest-pinned image, decided by auth), or null.
 * Missing flags mean null: fail closed against an older auth.
 */
function trustPath(entry) {
  if (!entry || entry.conflict) return null;
  if (entry.official === true) return 'official';
  if (entry.community === true) return 'community';
  return null;
}

/**
 * True when the registry already holds this plugin under a different image, OR
 * under an unknown image (url-registered by an instance admin, or legacy): an org
 * admin must never replace a registration whose provenance they cannot match.
 */
function registrationConflict(existing, image) {
  if (!existing) return false;
  return !existing.image || existing.image !== image;
}

const NOT_ELIGIBLE_DETAIL = 'A community plugin backend runs only when its install carries a signature v2 from a key this org trusts, neither the key nor the bundle is revoked, and the backend image is pinned by digest (image@sha256:...). Every install of this plugin id on the instance must qualify.';

/**
 * Boot reseed: start every backend auth reports as official or as an eligible
 * community install. An ineligible entry (revoked, untrusted, v1, unpinned, or
 * unflagged: fail closed) is STOPPED, so a revocation made while the collector
 * was down still takes effect at boot. Conflicted entries are skipped as before
 * (an instance admin must resolve them).
 */
async function reseedPluginBackends(deps = {}) {
  const warn = deps.warn || ((m) => console.warn(m));
  const body = await authGet('/api/internal/plugins/backends', deps);
  const list = (body && body.backends) || [];
  let ok = 0, fail = 0;
  for (const b of list) {
    if (b.conflict) {
      fail++;
      warn(`[PluginGateway] boot-reseed skipped ${b.pluginId}: installs disagree on image (conflict); an instance admin must resolve it`);
      continue;
    }
    const path = trustPath(b);
    if (!path) {
      fail++;
      const reason = b.community_reason || 'not_eligible';
      try {
        await deps.lifecycle.stopPluginBackend(b.pluginId);
        if (deps.unregisterPluginBackend) deps.unregisterPluginBackend(b.pluginId);
        warn(`[PluginGateway] boot-reseed stopped ${b.pluginId}: backend not eligible (${reason}) (SEC-PLUGIN-TRUST P5)`);
      } catch (e) {
        warn(`[PluginGateway] boot-reseed ${b.pluginId} not eligible (${reason}); stop failed: ${e.message}`);
      }
      continue;
    }
    try {
      const started = await deps.lifecycle.startPluginBackend(b.pluginId, {
        image: b.image, port: b.port, healthPath: b.healthPath,
        official: path === 'official', community: path === 'community',
      });
      deps.registerPluginBackend(b.pluginId, { url: started.url, healthPath: b.healthPath, port: b.port, image: b.image });
      ok++;
    } catch (e) {
      fail++;
      warn(`[PluginGateway] boot-reseed ${b.pluginId} failed: ${e.message}`);
    }
  }
  return { ok, fail, total: list.length };
}

function createPluginBackendHandlers(deps) {
  const audit = deps.auditOp || (() => {});
  const notInstanceAdmin = (res) => res.status(403).json({ error: 'instance_admin_required' });

  async function register(req, res) {
    if (!(await isInstanceAdmin(req, deps))) return notInstanceAdmin(res);
    try {
      const { pluginId } = req.params;
      deps.registerPluginBackend(pluginId, req.body);
      audit('ops.plugin.backend.registered', { plugin_id: pluginId, url: req.body.url });
      if (deps.onRegistered) deps.onRegistered(pluginId);
      res.json({ success: true, pluginId });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }

  async function ensure(req, res) {
    if (!deps.requireAdminRole(req, res)) return;
    const { pluginId } = req.params;
    // Service callers have no org of their own: they must name one explicitly.
    const orgId = req.service === true ? (req.body && req.body.orgId) : (req.user && req.user.org_id);
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    const backend = await resolveOrgBackend(orgId, pluginId, deps);
    if (!backend) return res.status(404).json({ error: 'plugin_not_installed' });
    // SEC-PLUGIN-TRUST P5: official installs as before; a community install also
    // needs auth's verdict (signature v2, trusted unrevoked key, digest-pinned
    // image) for THIS org and for every other install of the id instance-wide,
    // because one container serves them all. Anything else is refused and any
    // running backend for the id is stopped, so a revocation bites on next ensure.
    let path = trustPath(backend);
    let reason = backend.community_reason || 'not_eligible';
    if (path === 'community') {
      const inst = await instanceBackend(pluginId, deps);
      if (trustPath(inst) !== 'community') {
        path = null;
        reason = (inst && inst.community_reason) || 'not_eligible_instance_wide';
      }
    }
    if (!path) {
      let stopped = false;
      const inst = await instanceBackend(pluginId, deps);
      if (!trustPath(inst)) {
        try {
          const out = await deps.lifecycle.stopPluginBackend(pluginId);
          stopped = !out || out.stopped !== false;
          deps.unregisterPluginBackend(pluginId);
          if (deps.unregisterPluginTools) deps.unregisterPluginTools(pluginId);
          audit('ops.plugin.backend.stopped_not_eligible', { plugin_id: pluginId, reason, org_id: orgId });
        } catch (e) {
          console.warn(`[PluginGateway] stop of ineligible ${pluginId} failed:`, e.message);
        }
      }
      return res.status(403).json({ error: 'backend_not_eligible', reason, stopped, detail: NOT_ELIGIBLE_DETAIL });
    }
    const existing = deps.getPluginBackend(pluginId);
    const conflicted = registrationConflict(existing, backend.image) || (await installsConflict(pluginId, deps));
    if (conflicted && !(await isInstanceAdmin(req, deps))) {
      return res.status(409).json({ error: 'backend_conflict' });
    }
    try {
      const started = await deps.lifecycle.startPluginBackend(pluginId, {
        image: backend.image, port: backend.port, healthPath: backend.healthPath,
        official: path === 'official', community: path === 'community',
      });
      deps.registerPluginBackend(pluginId, {
        url: started.url, healthPath: backend.healthPath, port: backend.port, image: backend.image,
      });
      // Agent tools from a backend land in the INSTANCE-WIDE tool registry (every
      // org's agents), so only official backends may load them. Community agent
      // tools stay off until they are org-scoped (SEC-PLUGIN-TRUST P5).
      const toolsRegistered = path === 'official' && deps.loadTools ? await deps.loadTools(pluginId, started.url) : 0;
      audit('ops.plugin.backend.ensured', { plugin_id: pluginId, url: started.url, healthy: started.healthy, org_id: orgId });
      res.json({ success: true, url: started.url, healthy: started.healthy !== false, toolsRegistered });
    } catch (err) {
      console.error(`[PluginGateway] ensure ${pluginId} failed:`, err.message);
      res.status(502).json({ error: 'backend_start_failed', detail: err.message });
    }
  }

  async function remove(req, res) {
    if (!(await isInstanceAdmin(req, deps))) return notInstanceAdmin(res);
    const { pluginId } = req.params;
    deps.unregisterPluginBackend(pluginId);
    deps.unregisterPluginTools(pluginId);
    deps.lifecycle.stopPluginBackend(pluginId, { removeData: req.query.deleteData === 'true' })
      .catch((err) => console.warn(`[PluginGateway] backend stop for ${pluginId} failed:`, err.message));
    audit('ops.plugin.backend.unregistered', { plugin_id: pluginId });
    if (deps.onUnregistered) deps.onUnregistered(pluginId);
    res.json({ success: true });
  }

  // POST /api/v1/admin/plugins/:pluginId/tools writes the GLOBAL agent tool
  // registry (TOOL_DEFS/AGENT_TOOLS), so it is instance-admin only too.
  async function tools(req, res) {
    if (!(await isInstanceAdmin(req, deps))) return notInstanceAdmin(res);
    try {
      const { pluginId } = req.params;
      const list = req.body && req.body.tools;
      if (!Array.isArray(list)) return res.status(400).json({ error: 'tools must be an array' });
      const result = deps.registerPluginTools(pluginId, list);
      audit('ops.plugin.tools.registered', { plugin_id: pluginId, tool_count: list.length });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }

  return { register, ensure, remove, tools };
}

module.exports = { isInstanceAdmin, checkInstanceAdmin, resolveOrgBackend, instanceBackend, trustPath, registrationConflict, installsConflict, reseedPluginBackends, createPluginBackendHandlers };
