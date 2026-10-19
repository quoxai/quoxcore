'use strict';
/**
 * The live readers behind lib/mirrorBuilder.js: one per Mirror section, each asking the OWNING
 * service for one org. Server-local pieces (tool catalog, codebase store, RepoBrain resolver, the
 * licence check) are passed in by server.js so this file has no import cycle with it.
 *
 * Every non-2xx throws an Error carrying .status and .body, so mirrorBuilder turns it into
 * { code: '<SERVICE>_HTTP_<status>', service, message }: an error body is never read as data.
 */

const DEFAULT_TIMEOUT = 5000;

async function getJson(url, headers, { timeoutMs = DEFAULT_TIMEOUT, fetchFn = fetch } = {}) {
  const res = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const e = new Error((body && (body.error || body.message)) || `HTTP ${res.status}`);
    e.status = res.status; e.body = body;
    throw e;
  }
  return body;
}

function createMirrorReaders({
  env = process.env,
  fetchFn = fetch,
  checkServiceHealth,
  toolDefs = {},
  listToolMetas,
  loadCognitiveImplants,
  listImplants,
  buildAgentRegistryList,
  listAssistants,
  agentTools = {},
  governed = {},
  checkPluginLicense,
  isPluginLicensedForOrg,
  resolveRepoBrainBackend,
  listCodebaseProjects,
} = {}) {
  const key = env.INTERNAL_SERVICE_KEY || '';
  const url = (name, dflt) => (env[name] || dflt).replace(/\/+$/, '');
  const AUTH = url('AUTH_SERVICE_URL', 'http://auth:3101');
  const MEMORY = url('MEMORY_SERVICE_URL', 'http://memory:3103');
  const FILES = url('FILES_SERVICE_URL', 'http://files:3102');
  const QUOXFLOW = url('QUOXFLOW_URL', 'http://quoxflow:3200');
  // Z2H run-6 rule (as GET /api/v1/health/aggregate): an explicit empty REPOBRAIN_URL (public install,
  // setup.sh) means RepoBrain is not installed here; unset = the default.
  const REPOBRAIN = env.REPOBRAIN_URL === '' ? '' : url('REPOBRAIN_URL', 'http://repobrain:3105');
  const QUOXBRAIN = url('QUOXBRAIN_URL', 'http://quoxbrain:3106');
  const TASKS = `http://${env.TASKS_HOST || 'tasks'}:${env.TASKS_PORT || '3104'}`;
  const svc = (orgId, extra = {}) => ({ 'X-Service-Key': key, 'X-Org-Id': orgId, ...extra });
  const get = (u, h, o) => getJson(u, h, { fetchFn, ...o });

  const readers = {
    // Platform service liveness: the same probes as GET /api/v1/health/aggregate (quox status).
    async serviceChecks() {
      const T = 3000;
      const [auth, memory, files, quoxflow, repobrain] = await Promise.all([
        checkServiceHealth(AUTH, '/health', T), checkServiceHealth(MEMORY, '/health', T), checkServiceHealth(FILES, '/health', T),
        checkServiceHealth(QUOXFLOW, '/health', T),
        // Not shipped on this install: neither up nor down (never probed, never reported as "down").
        REPOBRAIN ? checkServiceHealth(REPOBRAIN, '/healthz', T) : { status: 'not_installed', optional: true, latency_ms: null },
      ]);
      return { auth, memory, collector: { status: 'ok', latency_ms: 0 }, quoxflow, files, repobrain };
    },
    async memoryUsers(orgId) {
      const d = await get(`${MEMORY}/api/memory/org-users?with=entities`, svc(orgId, { 'X-User-Id': 'service' }));
      if (!d || !Array.isArray(d.users)) throw Object.assign(new Error('org-users returned no users list'), { code: 'MEMORY_BAD_SHAPE' });
      return d.users;
    },
    async memoryStats(orgId, userId) {
      return get(`${MEMORY}/api/memory/stats`, svc(orgId, { 'X-User-Id': userId }));
    },
    async toolCounts(orgId) {
      let org = 0;
      // Same filter as GET /api/v1/tools/list?include_user=1 (the org's user-installed tools); the store
      // also holds seeded platform rows, which TOOL_DEFS already counts.
      const INSTALLED = ['openapi', 'mcp', 'catalog', 'script', 'repo', 'toolsmith'];
      if (typeof listToolMetas === 'function') org = (await listToolMetas(orgId) || []).filter((m) => INSTALLED.includes(m.executor_type)).length;
      return { platform: Object.keys(toolDefs || {}).length, org };
    },
    async workflowCount(orgId) {
      const d = await get(`${QUOXFLOW}/api/workflows?limit=1`, { 'X-Service-Key': key, 'X-Org-ID': orgId });
      const total = d && d.pagination && d.pagination.total;
      if (typeof total !== 'number') throw Object.assign(new Error('quoxflow returned no pagination.total'), { code: 'QUOXFLOW_BAD_SHAPE' });
      return total;
    },
    async plugins(orgId) {
      const d = await get(`${AUTH}/api/internal/orgs/${encodeURIComponent(orgId)}/plugins`, svc(orgId));
      if (!d || !Array.isArray(d.plugins)) throw Object.assign(new Error('auth returned no plugins list'), { code: 'AUTH_BAD_SHAPE' });
      return d.plugins;
    },
    async agents(orgId) {
      const assistants = listAssistants();
      const out = await buildAgentRegistryList({ assistants, agentTools, governed, checkPluginLicense, orgId });
      const list = (out.agents || []).map((a) => ({ id: a.agent_id, name: a.name, role: a.role || null, level: a.level ?? null, entitled: a.entitled !== false }));
      return { count: list.length, entitled: list.filter((a) => a.entitled).length, list };
    },
    async implants(orgId) {
      const registry = await loadCognitiveImplants();
      if (!registry || !Object.keys(registry).length) throw Object.assign(new Error('implant registry unavailable'), { code: 'IMPLANT_REGISTRY_UNAVAILABLE' });
      return listImplants({ orgId, registry, tasksUrl: TASKS, serviceKey: key, fetchFn });
    },
    async qortex(orgId) {
      return get(`${QUOXBRAIN}/brain/status?embeddings=none`, svc(orgId, { 'X-User-Id': 'service' }));
    },
    async repobrain(orgId) {
      let licensed = false;
      try { licensed = await isPluginLicensedForOrg(orgId, 'quox-nucleus'); } catch { licensed = false; }
      if (!licensed) throw Object.assign(new Error('RepoBrain (quox-nucleus) is not licensed for this org'), { code: 'LICENSE_REQUIRED' });
      const backend = await resolveRepoBrainBackend(orgId);
      const d = await get(`${backend.baseUrl}/api/targets`, { 'X-Org-Id': orgId, ...(backend.sharedSecret ? { 'X-RepoBrain-Key': backend.sharedSecret } : {}) });
      const repos = Array.isArray(d) ? d : (d && (d.targets || d.repos)) || [];
      return { repos: repos.map((t) => ({ name: t.target_id || t.name || t.id || t.target, file_count: Number.isFinite(Number(t.file_count ?? t.fileCount ?? t.files)) && (t.file_count ?? t.fileCount ?? t.files) != null ? Number(t.file_count ?? t.fileCount ?? t.files) : null })) };
    },
    async codebase(orgId) {
      return listCodebaseProjects(orgId);
    },
  };
  return readers;
}

module.exports = { createMirrorReaders, getJson };
