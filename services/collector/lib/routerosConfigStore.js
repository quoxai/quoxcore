/**
 * RouterOS Proxy Config Store
 *
 * Server-side, per-org store for the RouterOS/MikroTik integration target
 * (host/port/TLS/credentials). This is the trusted source the SSRF-hardened
 * mikrotik proxy (server.js POST /api/v1/mikrotik/proxy) reads from — the
 * request body may never carry the target (see routerosProxyGuard.js and
 * WEB-REFACTOR note #2289).
 *
 * Scope note: the org vault already has a registered integration_type for
 * this (`mikrotik_routeros`, services/auth/config/integrationTypeRegistry.js
 * fields: base_url/username/password), but src/services/routerosClient.js's
 * storeConfig()/loadConfigAsync() never actually wired up to it correctly —
 * it POSTs `{type, name, config}` to /api/orgs/:orgId/integrations, which
 * requires `{integration_type, label, credentials}` and 400s on the
 * mismatch (a pre-existing, unrelated bug: the vault write silently falls
 * back to a localStorage-only cache). Fixing that migration is out of scope
 * for this SSRF fix. Instead this store follows the same pattern the actual
 * PVE-PROXY precedent uses (server.js loadMonitoringConfig()/
 * saveMonitoringConfig(): a local JSON file under the collector's persisted
 * data dir, not the vault) — keyed per-org here since RouterOS targets are
 * tenant-specific, unlike the single-tenant monitoring config. Migrating to
 * the real vault type is a follow-up.
 *
 * The password is stored in plaintext on disk, same posture as the existing
 * monitoring-config.json Proxmox `token` field and services/collector's
 * github.json config-file fallback — not a new lower bar for this codebase.
 *
 * VAULT-INTEG P3 migration note: this store's own persisted row shape
 * ({host, port, useSSL, username, password, updatedAt}) is unchanged by the
 * P3 vault-wiring pass — the fix that pass made was in the frontend vault
 * client (src/services/routerosClient.js's findVaultCredential(), which
 * read the wrong response key and so never found an existing vault
 * credential to update). No migrate-on-read path is needed HERE: this
 * store never held vault-shaped data and doesn't change shape as a result
 * of that fix. The vault WRITE itself is still a documented dead end for
 * this integration (see routerosClient.js's PROOF-LOOP #2329 comment: the
 * SSRF guard rejects the private/LAN IPs real routers use) — unfixed,
 * out of scope for P3.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(
  process.env.AEE_DB_PATH ? path.dirname(process.env.AEE_DB_PATH) : '/var/lib/quox',
  'routeros-config.json'
);

function _loadAll(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    /* corrupt/unreadable file — treat as unconfigured rather than throw */
  }
  return {};
}

function _saveAll(all, configPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(all, null, 2));
}

/**
 * @param {string} orgId
 * @param {string} [configPath] - test hook, defaults to CONFIG_PATH
 * @returns {object|null}
 */
function loadRouterosConfig(orgId, configPath = CONFIG_PATH) {
  const all = _loadAll(configPath);
  return all[orgId || 'default'] || null;
}

/**
 * @param {string} orgId
 * @param {{host: string, port: number, useSSL: boolean, username: string, password: string}} config
 * @param {string} [configPath] - test hook, defaults to CONFIG_PATH
 * @returns {object}
 */
function saveRouterosConfig(orgId, config, configPath = CONFIG_PATH) {
  const all = _loadAll(configPath);
  const key = orgId || 'default';
  all[key] = { ...config, updatedAt: new Date().toISOString() };
  _saveAll(all, configPath);
  return all[key];
}

/**
 * @param {string} orgId
 * @param {string} [configPath] - test hook, defaults to CONFIG_PATH
 */
function removeRouterosConfig(orgId, configPath = CONFIG_PATH) {
  const all = _loadAll(configPath);
  delete all[orgId || 'default'];
  _saveAll(all, configPath);
}

module.exports = {
  loadRouterosConfig,
  saveRouterosConfig,
  removeRouterosConfig,
  CONFIG_PATH,
};
