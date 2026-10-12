/**
 * Wazuh Client Service
 *
 * Communicates with the Wazuh REST API (v4.x) via the collector proxy.
 * All requests go through the collector to avoid CORS and to keep
 * credentials server-side.
 *
 * The collector proxies to https://<wazuh-host>:55000 with JWT auth.
 */

import { getPluginConfig } from './pluginConfigStorage'
import { csrfFetch } from '../utils/csrfFetch'
import { VAULT_CREATE, VAULT_LIST } from '../config/apiPaths'

const COLLECTOR_BASE = '/collector/api/v1/wazuh'

/**
 * Read the user-saved plugin config for Wazuh.
 *
 * Authoritative source: PluginConfigModal saves via savePluginConfig('wazuh', ...)
 * which writes to org-scoped 'plugin-configs' storage. Returns whatever the user
 * filled in on Settings → Plugins → Configure (wazuhHost, wazuhApiPort, wazuhUser,
 * wazuhPassword, bastionHost — all per the manifest's configSchema).
 *
 * Falls back to the legacy 'quox-extensions-state.wazuh.config' shape ONLY for
 * users who configured Wazuh under the old (broken) read path before this fix.
 */
function getConfig() {
  try {
    const cfg = getPluginConfig('wazuh') || {}
    if (cfg.wazuhHost || cfg.wazuhPassword || cfg.bastionHost) return cfg
  } catch {
    // fall through to legacy
  }
  try {
    const state = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}')
    return state['wazuh']?.config || {}
  } catch {
    return {}
  }
}

/**
 * Make a request to the Wazuh API via collector proxy.
 * Uses the generic proxy endpoint for arbitrary Wazuh API calls,
 * or convenience endpoints for common operations.
 */
async function wazuhFetch(endpoint, options = {}, orgId) {
  const headers = { 'Content-Type': 'application/json' }
  if (orgId) headers['X-Org-Id'] = orgId
  const res = await fetch(`${COLLECTOR_BASE}/proxy`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({
      endpoint,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : undefined,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || body.detail || `Wazuh API error: ${res.status}`)
  }

  const json = await res.json()
  if (json.success === false) {
    throw new Error(json.error || 'Wazuh API request failed')
  }
  return json.data || json
}

// ── Manager ──────────────────────────────────────────────

/**
 * Get Wazuh manager daemon statuses
 */
export async function getManagerStatus(orgId) {
  const headers = {}
  if (orgId) headers['X-Org-Id'] = orgId
  const res = await fetch(`${COLLECTOR_BASE}/manager/status`, { headers, credentials: 'include' })
  if (!res.ok) throw new Error(`Manager status failed: ${res.status}`)
  const json = await res.json()
  // Unwrap collector envelope: { success, data: { data: { affected_items } } } → { data: { affected_items } }
  return json.data || json
}

/**
 * Get Wazuh manager info (version, install path)
 */
export async function getManagerInfo(orgId) {
  return wazuhFetch('/manager/info', {}, orgId)
}

/**
 * Get manager event processing stats
 */
export async function getManagerStats(orgId) {
  return wazuhFetch('/manager/stats', {}, orgId)
}

/**
 * Get manager log entries
 */
export async function getManagerLogs(params = {}, orgId) {
  const query = new URLSearchParams(params).toString()
  return wazuhFetch(`/manager/logs${query ? `?${query}` : ''}`, {}, orgId)
}

// ── Agents ───────────────────────────────────────────────

/**
 * List all Wazuh agents
 */
export async function getAgents(params = {}, orgId) {
  const query = new URLSearchParams(params).toString()
  const headers = {}
  if (orgId) headers['X-Org-Id'] = orgId
  const res = await fetch(`${COLLECTOR_BASE}/agents${query ? `?${query}` : ''}`, { headers, credentials: 'include' })
  if (!res.ok) throw new Error(`Agents list failed: ${res.status}`)
  const json = await res.json()
  // Unwrap collector envelope: { success, data: { data: { affected_items } } } → { data: { affected_items } }
  return json.data || json
}

/**
 * Get a single agent by ID
 */
export async function getAgent(agentId, orgId) {
  return wazuhFetch(`/agents/${agentId}`, {}, orgId)
}

/**
 * Register a new agent (pre-enrollment)
 */
export async function registerAgent(name, ip = 'any', orgId) {
  return wazuhFetch('/agents', {
    method: 'POST',
    body: JSON.stringify({ name, ip }),
  }, orgId)
}

/**
 * Remove an agent
 */
export async function removeAgent(agentId, orgId) {
  return wazuhFetch(`/agents/${agentId}`, { method: 'DELETE' }, orgId)
}

/**
 * Get agent key for manual enrollment
 */
export async function getAgentKey(agentId, orgId) {
  return wazuhFetch(`/agents/${agentId}/key`, {}, orgId)
}

/**
 * Deploy Wazuh agent to a host via bastion SSH
 * This calls a collector endpoint that handles the two-hop SSH deployment
 */
export async function deployAgentToHost(hostname, hostIp, options = {}, orgId) {
  const config = getConfig()
  const headers = { 'Content-Type': 'application/json' }
  if (orgId) headers['X-Org-Id'] = orgId

  // Frontend pre-flight: if config has no wazuhHost, fail fast with a useful
  // dump so we can tell whether it's a save-side or read-side problem.
  if (!config.wazuhHost) {
    const lsKeys = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && (k.endsWith('plugin-configs') || k === 'quox-extensions-state')) lsKeys.push(k)
      }
    } catch { /* ignore */ }
    console.error('[Wazuh deploy] config.wazuhHost is empty. config keys:',
      Object.keys(config), 'localStorage keys with plugin config:', lsKeys)
    throw new Error(
      `Wazuh Server IP missing from saved config. localStorage has: ${lsKeys.join(', ') || '(none)'}. ` +
      `Open DevTools → Application → Local Storage and check the keys above for a "wazuh" entry with wazuhHost.`
    )
  }

  return fetch('/collector/api/v1/wazuh/deploy-agent', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({
      hostname,
      hostIp,
      wazuhServer: config.wazuhHost || '',
      bastionHost: config.bastionHost || '',
      sshUser: options.sshUser || 'control',
      ...options,
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Deploy failed: ${res.status}`)
    }
    return res.json()
  })
}

/**
 * Get persistent deploy history from server-side SQLite
 * @param {string} mode - 'latest' (one per host) or 'all' (full log)
 */
export async function getDeployHistory(mode = 'latest', orgId) {
  const headers = {}
  if (orgId) headers['X-Org-Id'] = orgId
  return fetch(`/collector/api/v1/wazuh/deploy-history?mode=${mode}`, { headers, credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return { deploys: [] }
      return res.json()
    })
    .catch(() => ({ deploys: [] }))
}

/**
 * Check agent deployment status on a host
 */
export async function checkAgentStatus(hostIp, orgId) {
  const headers = { 'Content-Type': 'application/json' }
  if (orgId) headers['X-Org-Id'] = orgId
  return fetch('/collector/api/v1/wazuh/agent-status', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ hostIp }),
  }).then(async (res) => {
    if (!res.ok) return { installed: false }
    return res.json()
  })
}

/**
 * Bulk deploy agents to multiple hosts
 */
export async function bulkDeployAgents(hosts, options = {}, orgId) {
  const headers = { 'Content-Type': 'application/json' }
  if (orgId) headers['X-Org-Id'] = orgId
  return fetch('/collector/api/v1/wazuh/deploy-bulk', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ hosts, ...options }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Bulk deploy failed: ${res.status}`)
    }
    return res.json()
  })
}

// ── Alerts ───────────────────────────────────────────────

/**
 * Get recent alerts (from indexer via collector)
 */
export async function getAlerts(params = {}, orgId) {
  const query = new URLSearchParams({
    limit: '50',
    ...params,
  }).toString()
  const headers = {}
  if (orgId) headers['X-Org-Id'] = orgId
  const res = await fetch(`${COLLECTOR_BASE}/alerts${query ? `?${query}` : ''}`, { headers, credentials: 'include' })
  if (!res.ok) throw new Error(`Alerts fetch failed: ${res.status}`)
  return res.json()
}

/**
 * Get alert summary (counts by severity, agent, rule)
 */
export async function getAlertSummary(params = {}, orgId) {
  return wazuhFetch('/alerts/summary', {
    method: 'POST',
    body: JSON.stringify(params),
  }, orgId)
}

// ── Vulnerability Detection ──────────────────────────────

/**
 * Get vulnerabilities for an agent (from Wazuh Indexer, not API — removed in 4.8+)
 */
export async function getVulnerabilities(agentId, params = {}, orgId) {
  const query = new URLSearchParams({
    agent_id: agentId,
    limit: '200',
    ...params,
  }).toString()
  const headers = {}
  if (orgId) headers['X-Org-Id'] = orgId
  const res = await fetch(`${COLLECTOR_BASE}/vulnerabilities?${query}`, { headers, credentials: 'include' })
  if (!res.ok) throw new Error(`Vulnerabilities fetch failed: ${res.status}`)
  return res.json()
}

/**
 * Get last vulnerability scan info (deprecated in Wazuh 4.8+, returns stub)
 */
export async function getLastVulnScan(agentId, orgId) {
  // Vulnerability API removed in 4.8+; last_scan info is no longer available via REST
  return { data: { affected_items: [{ status: 'unknown' }] } }
}

// ── File Integrity (Syscheck) ────────────────────────────

/**
 * Get syscheck (FIM) results for an agent
 */
export async function getSyscheck(agentId, params = {}, orgId) {
  const query = new URLSearchParams(params).toString()
  return wazuhFetch(`/syscheck/${agentId}${query ? `?${query}` : ''}`, {}, orgId)
}

/**
 * Trigger a FIM scan on an agent
 */
export async function triggerSyscheck(agentId, orgId) {
  return wazuhFetch(`/syscheck/${agentId}`, { method: 'PUT' }, orgId)
}

// ── SCA (Compliance) ─────────────────────────────────────

/**
 * Get SCA policy results for an agent
 */
export async function getScaResults(agentId, orgId) {
  return wazuhFetch(`/sca/${agentId}`, {}, orgId)
}

/**
 * Get detailed checks for a specific SCA policy
 */
export async function getScaChecks(agentId, policyId, orgId) {
  return wazuhFetch(`/sca/${agentId}/checks/${policyId}`, {}, orgId)
}

// ── Active Response ──────────────────────────────────────

/**
 * Trigger an active response on agent(s) via the HITL-gated collector route.
 * Returns 202 awaiting_approval with an inbox_item_id — the caller does NOT
 * see immediate execution. The HITL Inbox approval card runs the command on
 * approval and emits AEE evidence at every step.
 *
 * @param {string[]} agentList - Wazuh agent IDs (alphanumeric, ≤8 chars each)
 * @param {string} command - One of: firewall-block, host-isolate, restart-wazuh-agent
 * @param {string} reason - Justification (≥10 chars, shown on approval card)
 * @param {string[]} args - Optional command arguments (e.g. [srcip])
 * @param {string} orgId - Org context for the approval card
 * @returns {Promise<{success, status, inbox_item_id, message}>}
 */
export async function triggerActiveResponse(agentList, command, reason, args = [], orgId) {
  const agents = Array.isArray(agentList) ? agentList : [agentList]
  const headers = { 'Content-Type': 'application/json' }
  if (orgId) headers['X-Org-Id'] = orgId
  const res = await fetch('/collector/api/v1/wazuh/active-response', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ agentList: agents, command, args, reason }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Active response failed: ${res.status}`)
  }
  return res.json()
}

/** Allowlisted active-response commands matching the collector's enforcement list. */
export const ACTIVE_RESPONSE_COMMANDS = [
  { id: 'firewall-block',       label: 'Firewall Block (drop traffic from src IP)', requiresIp: true },
  { id: 'host-isolate',         label: 'Host Isolate (network-quarantine the agent host)', requiresIp: false },
  { id: 'restart-wazuh-agent',  label: 'Restart Wazuh Agent (force agent service restart)', requiresIp: false },
]

// ── Convenience ──────────────────────────────────────────

/**
 * Get a full status overview (manager + agents + alert count)
 */
export async function getOverview(orgId) {
  const [manager, agents] = await Promise.all([
    getManagerStatus(orgId).catch(() => ({ data: { affected_items: [] } })),
    getAgents({ limit: '500' }, orgId).catch(() => ({ data: { affected_items: [], total_affected_items: 0 } })),
  ])

  const agentList = agents?.data?.affected_items || []
  const activeAgents = agentList.filter(a => a.status === 'active').length
  const disconnectedAgents = agentList.filter(a => a.status === 'disconnected').length
  const totalAgents = agents?.data?.total_affected_items || agentList.length

  // Extract daemon statuses
  const daemons = manager?.data?.affected_items?.[0] || {}

  // Only these daemons must be running for a healthy manager
  const CRITICAL_DAEMONS = ['wazuh-db', 'wazuh-modulesd', 'wazuh-analysisd', 'wazuh-remoted', 'wazuh-syscheckd']
  const healthy = CRITICAL_DAEMONS.every(d => !daemons[d] || daemons[d] === 'running')

  return {
    manager: {
      daemons,
      healthy,
    },
    agents: {
      total: totalAgents,
      active: activeAgents,
      disconnected: disconnectedAgents,
      neverConnected: agentList.filter(a => a.status === 'never_connected').length,
      list: agentList,
    },
  }
}

// ── Stream WAZ P2.5 — Vault migration helper ─────────────────────────────────

/**
 * One-shot: read Wazuh credentials from localStorage (legacy config) and POST
 * them to the integrations API as a vault-stored credential.
 * Safe to call on repeated boots — returns { migrated: false, reason: 'already-migrated' }
 * after the first successful run.
 *
 * NOTE: This helper is exported but NOT auto-called from any view yet.
 *       Wiring into WazuhView is deferred to Stream WAZ P5.
 *
 * @param {string} orgId - The org to create the integration under.
 * @returns {Promise<{ migrated: boolean, reason?: string }>}
 */
/**
 * Check whether the minimum required Wazuh config is present.
 * Minimum = wazuhHost + wazuhPassword (port and user have safe defaults).
 * @returns {boolean}
 */
export function isWazuhConfigured() {
  const cfg = getConfig()
  return Boolean(cfg.wazuhHost && cfg.wazuhPassword)
}

export async function migrateLocalCredsToVault(orgId) {
  if (typeof localStorage === 'undefined' || !orgId) {
    return { migrated: false, reason: 'no-localstorage-or-org' };
  }
  // Prefer the canonical plugin-config store; fall back to the legacy state key.
  let cfg = {};
  try { cfg = getPluginConfig('wazuh') || {}; } catch { /* ignore */ }
  if (!cfg.wazuhPassword || !cfg.wazuhHost) {
    try {
      const state = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}');
      cfg = state.wazuh?.config || cfg;
    } catch {
      return { migrated: false, reason: 'parse-error' };
    }
  }
  if (!cfg?.wazuhPassword || !cfg?.wazuhHost) {
    return { migrated: false, reason: 'no-creds-in-localstorage' };
  }
  if (cfg._migrated_to_vault) {
    return { migrated: false, reason: 'already-migrated' };
  }

  // Build base_url from host + port
  const port = cfg.wazuhPort || '55000';
  const base_url = `https://${cfg.wazuhHost}:${port}`;
  const username = cfg.wazuhUser || 'wazuh-wui';

  // POST to integrations API
  const res = await fetch(`/auth/api/orgs/${encodeURIComponent(orgId)}/integrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      type: 'wazuh',
      name: 'Wazuh (migrated)',
      credentials: { base_url, username, password: cfg.wazuhPassword },
    }),
  });
  if (!res.ok) return { migrated: false, reason: `api-${res.status}` };

  // Mark migrated and clear the secret from the legacy localStorage shape so
  // we never read it again. The canonical 'plugin-configs' password field is
  // left in place for one release for users who haven't reloaded yet — Settings
  // UI will treat the vault entry as authoritative going forward.
  try {
    const state = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}');
    if (state.wazuh?.config) {
      state.wazuh.config._migrated_to_vault = true;
      delete state.wazuh.config.wazuhPassword;
      localStorage.setItem('quox-extensions-state', JSON.stringify(state));
    }
  } catch { /* non-fatal */ }

  return { migrated: true };
}

// ── AGENT-OVERHAUL — server-side is the source of truth ─────────────────────
//
// WazuhSetupGate used to persist host/port/user/password with
// savePluginConfig('wazuh', ...) (localStorage 'plugin-configs' only — the
// secret never reached the server), while the runtime (collector's
// getWazuhToken) only ever read WAZUH_HOST/WAZUH_API_PASSWORD env vars. The
// two halves were disconnected. saveWazuhConfig() below is the one write
// path: it POSTs directly to the org's vault (services/auth
// integrationTypeRegistry's `wazuh` type — { base_url, username, password }),
// which is exactly what collector's getWazuhToken now resolves via
// resolveCredentialForAgent(orgId, 'argus', 'wazuh').

/**
 * Persist Wazuh credentials to the server-side vault (org integrations API).
 * The password is never written to localStorage — the vault is the sole
 * source of truth, consulted by both this saver and (server-side) by ARGUS.
 *
 * @param {string} orgId
 * @param {{ wazuhHost: string, wazuhApiPort?: string, wazuhUser?: string, wazuhPassword: string }} values
 * @returns {Promise<object>} the created credential record (no secret fields)
 * @throws {Error} when orgId is missing or the API call fails
 */
export async function saveWazuhConfig(orgId, values) {
  if (!orgId) throw new Error('saveWazuhConfig requires an orgId');
  const { wazuhHost, wazuhApiPort, wazuhUser, wazuhPassword } = values || {};
  const port = wazuhApiPort || '55000';
  const base_url = `https://${wazuhHost}:${port}`;

  const res = await csrfFetch(VAULT_CREATE(orgId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      integration_type: 'wazuh',
      label: 'Wazuh',
      is_default: true,
      credentials: {
        base_url,
        username: wazuhUser || 'wazuh-wui',
        password: wazuhPassword,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Failed to save Wazuh configuration (HTTP ${res.status})`);
  }

  return res.json();
}

/**
 * Server-side "is Wazuh configured?" check — queries the org's vault for an
 * existing `wazuh` credential rather than trusting a browser-local flag.
 * A fresh browser with empty localStorage must see the same answer as one
 * that configured Wazuh yesterday.
 *
 * @param {string} orgId
 * @param {(url: string, options?: object) => Promise<Response>} [authFetch] -
 *   AuthContext's authFetch (retries through token refresh on 401 — see
 *   #233). Falls back to plain fetch when not supplied (e.g. from a context
 *   without AuthProvider); callers that have authFetch available MUST pass
 *   it so an expired-token 401 isn't misread as "not configured".
 * @returns {Promise<boolean>}
 */
export async function checkWazuhConfiguredServer(orgId, authFetch) {
  if (!orgId) return false;
  const doFetch = authFetch || fetch;
  try {
    const res = await doFetch(`${VAULT_LIST(orgId)}?type=wazuh`, { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.credentials) && data.credentials.length > 0;
  } catch {
    return false;
  }
}

export default {
  getManagerStatus,
  getManagerInfo,
  getManagerStats,
  getManagerLogs,
  getAgents,
  getAgent,
  registerAgent,
  removeAgent,
  getAgentKey,
  deployAgentToHost,
  checkAgentStatus,
  bulkDeployAgents,
  getDeployHistory,
  getAlerts,
  getAlertSummary,
  getVulnerabilities,
  getLastVulnScan,
  getSyscheck,
  triggerSyscheck,
  getScaResults,
  getScaChecks,
  triggerActiveResponse,
  getOverview,
  migrateLocalCredsToVault,
  saveWazuhConfig,
  checkWazuhConfiguredServer,
}
