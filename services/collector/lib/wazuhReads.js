'use strict';
/**
 * Wazuh read operations, shared by the collector routes (GET /api/v1/wazuh/manager/status,
 * /agents, /alerts, /vulnerabilities in server.js) and the agent tools (wazuh_manager_status,
 * wazuh_agents, wazuh_alerts, wazuh_vulnerabilities in lib/agentTools.js). One implementation,
 * two callers: the route bodies used to carry this logic inline.
 *
 * Every function resolves to { status, body, aee } and never throws:
 *   status  the HTTP status a route should answer with
 *   body    the JSON body a route should send ({ success, ... })
 *   aee     { type?, intent, payload } for the caller to emit, or null
 * A config failure carries body.code = 'wazuh_not_configured' (or 'wazuh_lease_blocked'); an
 * indexer failure carries body.error = the wazuhIndexerExec code (wazuh_exec_failed, ...).
 */
const https = require('https');
const { resolveWazuhConnection, resolveWazuhIndexerConnection } = require('./wazuhCredentials.js');

const WAZUH_READ_STATUS = { wazuh_bad_query: 400, wazuh_exec_failed: 502, wazuh_parse_error: 502 };

// per-orgId manager API token cache: { token, expiry, host, port }
const _tokenCache = new Map();

function agentTools() { return require('./agentTools.js'); }

/** Get a Wazuh Manager API token for the org: { token, host, port }. Cached 10 minutes. */
async function getWazuhToken(orgId, deps = {}) {
  const cacheKey = orgId || 'default';
  const now = Date.now();
  const cached = _tokenCache.get(cacheKey);
  if (cached && now < cached.expiry) return { token: cached.token, host: cached.host, port: cached.port };

  const resolveCred = deps.resolveCredentialForAgent || agentTools().resolveCredentialForAgent;
  const resolved = await resolveCred(orgId, 'argus', 'wazuh');
  const { host, port: portNum, user, password } = resolveWazuhConnection(resolved);
  const credentials = Buffer.from(`${user}:${password}`).toString('base64');

  const token = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, port: portNum, path: '/security/user/authenticate?raw=true', method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
      rejectUnauthorized: false, timeout: 15000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        if (resp.statusCode === 200) resolve(data.trim().replace(/^"|"$/g, ''));
        else reject(new Error(`Wazuh auth failed (${resp.statusCode}): ${data}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Wazuh auth timeout')); });
    req.end();
  });

  _tokenCache.set(cacheKey, { token, expiry: now + 10 * 60 * 1000, host, port: portNum });
  return { token, host, port: portNum };
}

function _clearTokenCache() { _tokenCache.clear(); }

/** A thrown credential/connection error as a route body, with a stable code for tool callers. */
function configFailure(err) {
  const body = { success: false, error: err.message };
  if (err.leaseBlocked) { body.code = 'wazuh_lease_blocked'; return { status: 403, body }; }
  if (/WAZUH_HOST|WAZUH_API_PASSWORD|vault entry/.test(err.message)) { body.code = 'wazuh_not_configured'; }
  return { status: 500, body };
}

function managerGet(path, token, host, port) {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: host, port, path, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      rejectUnauthorized: false, timeout: 15000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try { resolve({ success: true, data: JSON.parse(data), status: resp.statusCode }); }
        catch { resolve({ success: false, data, status: resp.statusCode }); }
      });
    });
    request.on('error', (err) => resolve({ success: false, error: err.message, status: 500 }));
    request.on('timeout', () => { request.destroy(); resolve({ success: false, error: 'Timeout', status: 500 }); });
    request.end();
  });
}

async function _managerRead(orgId, path, okIntent, failIntent, okPayload, deps) {
  try {
    const { token, host, port } = await (deps.getWazuhToken || getWazuhToken)(orgId, deps);
    const result = await (deps.managerGet || managerGet)(path, token, host, port);
    return { status: 200, body: result, aee: { intent: okIntent, payload: okPayload(result) } };
  } catch (err) {
    const f = configFailure(err);
    return { status: f.status, body: f.body, aee: { type: 'error', intent: failIntent, payload: { error: err.message } } };
  }
}

/** Wazuh manager daemon status. */
function managerStatus(orgId, deps = {}) {
  return _managerRead(orgId, '/manager/status', 'quox.wazuh.manager.status', 'quox.wazuh.manager.status.failed',
    (r) => ({ success: r.success }), deps);
}

/** Wazuh agents; `query` is passed through to the manager API (status, limit, ...). */
function listAgents(orgId, query = {}, deps = {}) {
  const qs = new URLSearchParams(query).toString();
  return _managerRead(orgId, qs ? `/agents?${qs}` : '/agents', 'quox.wazuh.agents.list', 'quox.wazuh.agents.list.failed',
    () => ({ query }), deps);
}

async function _fleetAgents() {
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 9848}/api/v1/agents`, {
    headers: process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`fleet list returned ${r.status}`);
  return (await r.json()).agents || [];
}

async function wazuhIndexerRead(orgId, { logTag, index, buildBody, okIntent, failIntent, okPayload }, deps) {
  let wazuhHost;
  try {
    const resolveCredentialForAgent = deps.resolveCredentialForAgent || agentTools().resolveCredentialForAgent;
    const resolvedWazuhCred = await resolveCredentialForAgent(orgId, 'argus', 'wazuh');
    ({ host: wazuhHost } = resolveWazuhIndexerConnection(resolvedWazuhCred));
  } catch (credErr) {
    console.error(`[${logTag}] Credential resolution error:`, credErr.message);
    const body = { success: false, error: credErr.message };
    if (credErr.leaseBlocked) body.code = 'wazuh_lease_blocked';
    return { status: credErr.leaseBlocked ? 403 : 500, body, aee: null };
  }
  const searchBody = buildBody();
  const runIndexerQuery = deps.runIndexerQuery || require('./wazuhIndexerExec.js').runIndexerQuery;
  const r = await runIndexerQuery({
    index, body: searchBody, wazuhHost: wazuhHost || process.env.WAZUH_HOST || '',
    callBastion: deps.callBastion || require('./bastionSshExecutor.js')._internal.callBastion,
    listAgents: deps.listFleetAgents || _fleetAgents,
    resolveHost: (h) => agentTools().resolveHostId(h),
  });
  if (!r.ok) {
    return {
      status: WAZUH_READ_STATUS[r.error] || 503,
      body: { success: false, error: r.error, message: r.detail },
      aee: { type: 'error', intent: failIntent, payload: { error: r.error } },
    };
  }
  const hits = r.json.hits?.hits?.map((h) => h._source) || [];
  const total = r.json.hits?.total?.value || hits.length;
  return { status: 200, body: { success: true, data: hits, total }, aee: { intent: okIntent, payload: { ...okPayload, total } } };
}

/** Recent alerts from the Wazuh indexer. opts: { limit (1-500, default 50), q, min_level }. */
function listAlerts(orgId, opts = {}, deps = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 500);
  const query = opts.q || '*';
  const minLevel = parseInt(opts.min_level, 10);
  return wazuhIndexerRead(orgId, {
    logTag: 'Wazuh Alerts', index: 'wazuh-alerts-*',
    buildBody: () => {
      // match_all or multi_match only, never query_string with user input (injection)
      let esQuery;
      if (!query || query === '*') esQuery = { match_all: {} };
      else {
        const sanitised = String(query).replace(/[^a-zA-Z0-9\s.\-_]/g, '');
        esQuery = { multi_match: { query: sanitised, fields: ['rule.description', 'agent.name', 'rule.groups'] } };
      }
      if (Number.isFinite(minLevel) && minLevel > 0) {
        esQuery = { bool: { must: [esQuery], filter: [{ range: { 'rule.level': { gte: minLevel } } }] } };
      }
      return JSON.stringify({ size: limit, sort: [{ 'timestamp': { order: 'desc' } }], query: esQuery });
    },
    okIntent: 'quox.wazuh.alerts.list', failIntent: 'quox.wazuh.alerts.list.failed', okPayload: { limit, query },
  }, deps);
}

/** Vulnerability states from the Wazuh indexer. opts: { agent_id, agent_name, severity, limit (1-1000, default 100) }. */
function listVulnerabilities(orgId, opts = {}, deps = {}) {
  const agentId = opts.agent_id;
  const agentName = opts.agent_name;
  const severity = opts.severity;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 1000);
  return wazuhIndexerRead(orgId, {
    logTag: 'Wazuh Vulns', index: 'wazuh-states-vulnerabilities-*',
    buildBody: () => {
      const filters = [];
      if (agentId) filters.push({ term: { 'agent.id': String(agentId).replace(/[^a-zA-Z0-9]/g, '') } });
      if (agentName) filters.push({ term: { 'agent.name': String(agentName).replace(/[^a-zA-Z0-9._-]/g, '') } });
      if (severity) filters.push({ term: { 'vulnerability.severity': String(severity).replace(/[^a-zA-Z]/g, '') } });
      const esQuery = filters.length > 0 ? { bool: { filter: filters } } : { match_all: {} };
      return JSON.stringify({ size: limit, sort: [{ 'vulnerability.score.base': { order: 'desc' } }], query: esQuery });
    },
    okIntent: 'quox.wazuh.vulnerability.scan', failIntent: 'quox.wazuh.vulnerability.scan.failed',
    okPayload: { agentId, agentName, severity },
  }, deps);
}

/**
 * Express handlers for the four routes, so the route and the tools call the same functions above.
 * `emitAEE(req, aee)` is the caller's evidence emitter. Each handler: auth is the caller's middleware;
 * it calls the read, emits the AEE the read returned, and answers with its status and body.
 */
function routeHandler(read, emitAEE) {
  return async (req, res) => {
    const orgId = (req.user && req.user.org_id) || 'system';
    const r = await read(orgId, req.query);
    if (r.aee) emitAEE(req, r.aee);
    return res.status(r.status).json(r.body);
  };
}
const managerStatusRoute = (emitAEE) => routeHandler((orgId) => managerStatus(orgId), emitAEE);
const agentsRoute = (emitAEE) => routeHandler((orgId, q) => listAgents(orgId, q), emitAEE);
const alertsRoute = (emitAEE) => routeHandler((orgId, q) => listAlerts(orgId, q), emitAEE);
const vulnerabilitiesRoute = (emitAEE) => routeHandler((orgId, q) => listVulnerabilities(orgId, q), emitAEE);

module.exports = { managerStatusRoute, agentsRoute, alertsRoute, vulnerabilitiesRoute, getWazuhToken, managerStatus, listAgents, listAlerts, listVulnerabilities, WAZUH_READ_STATUS, _clearTokenCache };
