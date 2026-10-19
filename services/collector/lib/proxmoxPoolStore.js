'use strict';

/**
 * Proxmox disposable VM pool: durable store (DEVFLEET-P10).
 *
 * Two tables on the collector's aee.db handle (same convention as
 * fleetStandingGrants.ensure(db)): proxmox_pool_vms (one row per pool VM) and
 * proxmox_pool_config (one row per org). EVERY query filters by org_id, and
 * org_id always comes from the trusted caller, never from a request body.
 */

const STATES = ['building', 'ready', 'leased', 'recycling', 'failed'];

const CONFIG_DEFAULTS = Object.freeze({
  enabled: 0,
  lanes: [],            // [{ node, template_vmid, max, clone_mode: 'linked'|'full', avx2: bool }], each covered by its own standing grant
  deny_nodes: [],       // hard denylist: never place, list, or touch these nodes
  prom_url: null,       // Prometheus base URL for free-RAM-fraction placement (null = fewest pool VMs)
  backup_window: null,  // 'HH:MM-HH:MM' UTC during which the scheduler does not warm
  vmid_min: null,
  vmid_max: null,
  warm_target: 2,
  max_pool: 10,
  default_cores: 4,
  default_mem_gb: 8,
  default_disk_gb: 40,
  lease_ttl_h: 24,
  guest_user: 'hyp',
  cpu_type: 'host',
  admin_keys: [],       // up to 8 ssh public key lines written into every leased VM's authorized_keys beside the lessee's
  // Guest addressing. mode 'static' (owner rule 2026-10-15: servers are static, never DHCP) hands each VM
  // the lowest free address in ip_range; 'dhcp' is the back-compat default when no ip_range is set.
  network: { mode: 'dhcp', ip_range: null, prefix: 24, gateway: null, dns: ['1.1.1.1', '1.0.0.1'] },
});

const CONFIG_FIELDS = Object.keys(CONFIG_DEFAULTS);

const VM_COLUMNS = ['name', 'node', 'state', 'ip', 'cores', 'mem_gb', 'disk_gb', 'lessee', 'purpose',
  'ssh_pubkey_fp', 'leased_at', 'lease_expires_at', 'last_error', 'ip_check_error',
  'host_key_line', 'host_key_fingerprint', 'host_key_error', 'tags_status'];

let _db = null;

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxmox_pool_vms (
      org_id           TEXT NOT NULL,
      vmid             INTEGER NOT NULL,
      name             TEXT NOT NULL,
      node             TEXT NOT NULL,
      state            TEXT NOT NULL CHECK (state IN ('building','ready','leased','recycling','failed')),
      ip               TEXT,
      cores            INTEGER NOT NULL,
      mem_gb           INTEGER NOT NULL,
      disk_gb          INTEGER NOT NULL,
      lessee           TEXT,
      purpose          TEXT,
      ssh_pubkey_fp    TEXT,
      leased_at        INTEGER,
      lease_expires_at INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      last_error       TEXT,
      ip_check_error   TEXT,
      host_key_line        TEXT,
      host_key_fingerprint TEXT,
      host_key_error       TEXT,
      tags_status          TEXT,
      PRIMARY KEY (org_id, vmid)
    );
    CREATE INDEX IF NOT EXISTS idx_proxmox_pool_vms_org_state ON proxmox_pool_vms(org_id, state);
    CREATE TABLE IF NOT EXISTS proxmox_pool_config (
      org_id          TEXT PRIMARY KEY,
      enabled         INTEGER NOT NULL DEFAULT 0,
      node            TEXT,
      template_vmid   INTEGER,
      lanes_json      TEXT NOT NULL DEFAULT '[]',
      deny_nodes_json TEXT NOT NULL DEFAULT '[]',
      prom_url        TEXT,
      backup_window   TEXT,
      vmid_min        INTEGER,
      vmid_max        INTEGER,
      warm_target     INTEGER NOT NULL DEFAULT 2,
      max_pool        INTEGER NOT NULL DEFAULT 10,
      default_cores   INTEGER NOT NULL DEFAULT 4,
      default_mem_gb  INTEGER NOT NULL DEFAULT 8,
      default_disk_gb INTEGER NOT NULL DEFAULT 40,
      lease_ttl_h     INTEGER NOT NULL DEFAULT 24,
      guest_user      TEXT NOT NULL DEFAULT 'hyp',
      cpu_type        TEXT NOT NULL DEFAULT 'host',
      network_json    TEXT,
      admin_keys_json TEXT NOT NULL DEFAULT '[]',
      updated_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proxmox_pool_ips (
      org_id       TEXT NOT NULL,
      ip           TEXT NOT NULL,
      vmid         INTEGER NOT NULL,
      allocated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, ip)
    );
    CREATE INDEX IF NOT EXISTS idx_proxmox_pool_ips_vmid ON proxmox_pool_ips(org_id, vmid);
  `);
  // Idempotent upgrade for a table created before lanes existed (legacy node/template_vmid columns stay, unused).
  const haveVm = new Set(db.prepare('PRAGMA table_info(proxmox_pool_vms)').all().map((c) => c.name));
  if (!haveVm.has('ip_check_error')) db.exec('ALTER TABLE proxmox_pool_vms ADD COLUMN ip_check_error TEXT');
  for (const c of ['host_key_line', 'host_key_fingerprint', 'host_key_error', 'tags_status']) {
    if (!haveVm.has(c)) db.exec(`ALTER TABLE proxmox_pool_vms ADD COLUMN ${c} TEXT`);
  }
  const have = new Set(db.prepare('PRAGMA table_info(proxmox_pool_config)').all().map((c) => c.name));
  if (!have.has('lanes_json')) db.exec("ALTER TABLE proxmox_pool_config ADD COLUMN lanes_json TEXT NOT NULL DEFAULT '[]'");
  if (!have.has('deny_nodes_json')) db.exec("ALTER TABLE proxmox_pool_config ADD COLUMN deny_nodes_json TEXT NOT NULL DEFAULT '[]'");
  if (!have.has('prom_url')) db.exec('ALTER TABLE proxmox_pool_config ADD COLUMN prom_url TEXT');
  if (!have.has('network_json')) db.exec('ALTER TABLE proxmox_pool_config ADD COLUMN network_json TEXT');
  if (!have.has('admin_keys_json')) db.exec("ALTER TABLE proxmox_pool_config ADD COLUMN admin_keys_json TEXT NOT NULL DEFAULT '[]'");
  if (!have.has('backup_window')) db.exec('ALTER TABLE proxmox_pool_config ADD COLUMN backup_window TEXT');
  _db = db;
}

function parseJsonArray(t) {
  try { const v = JSON.parse(t || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function requireDb() {
  if (!_db) throw new Error('proxmoxPoolStore.ensure(db) must be called before use');
  return _db;
}

function rowToVm(r) {
  if (!r) return null;
  const iso = (n) => (n ? new Date(n).toISOString() : null);
  return {
    org_id: r.org_id, vmid: r.vmid, name: r.name, node: r.node, state: r.state, ip: r.ip,
    cores: r.cores, mem_gb: r.mem_gb, disk_gb: r.disk_gb, lessee: r.lessee, purpose: r.purpose,
    ssh_pubkey_fp: r.ssh_pubkey_fp, leased_at: iso(r.leased_at), lease_expires_at: iso(r.lease_expires_at),
    created_at: iso(r.created_at), updated_at: iso(r.updated_at), last_error: r.last_error, ip_check_error: r.ip_check_error || null,
    host_key_line: r.host_key_line || null, host_key_fingerprint: r.host_key_fingerprint || null, host_key_error: r.host_key_error || null, tags_status: r.tags_status || null,
    _lease_expires_ms: r.lease_expires_at || null, _created_ms: r.created_at, _updated_ms: r.updated_at,
  };
}

function needOrg(orgId) {
  if (!orgId || typeof orgId !== 'string') throw new Error('org_id is required');
}

function getConfig(orgId) {
  needOrg(orgId);
  const r = requireDb().prepare('SELECT * FROM proxmox_pool_config WHERE org_id = ?').get(orgId);
  const cfg = { ...CONFIG_DEFAULTS, lanes: [], deny_nodes: [], admin_keys: [], network: { ...CONFIG_DEFAULTS.network, dns: [...CONFIG_DEFAULTS.network.dns] } };
  if (r) {
    for (const k of CONFIG_FIELDS) if (k !== 'lanes' && k !== 'deny_nodes' && k !== 'network' && k !== 'admin_keys') cfg[k] = r[k];
    if (r.network_json) { try { const n = JSON.parse(r.network_json); if (n && typeof n === 'object') cfg.network = { ...cfg.network, ...n }; } catch { /* keep defaults */ } }
    cfg.lanes = parseJsonArray(r.lanes_json);
    cfg.deny_nodes = parseJsonArray(r.deny_nodes_json);
    cfg.admin_keys = parseJsonArray(r.admin_keys_json);
  }
  cfg.enabled = cfg.enabled ? 1 : 0;
  cfg.org_id = orgId;
  cfg.configured = !!r;
  return cfg;
}

/** Upsert a FULL, already-validated config for the org. */
function putConfig(orgId, cfg) {
  needOrg(orgId);
  const v = { ...CONFIG_DEFAULTS, ...cfg };
  requireDb().prepare(`
    INSERT INTO proxmox_pool_config (org_id, enabled, lanes_json, deny_nodes_json, prom_url, backup_window, vmid_min, vmid_max, warm_target, max_pool,
      default_cores, default_mem_gb, default_disk_gb, lease_ttl_h, guest_user, cpu_type, network_json, admin_keys_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET enabled=excluded.enabled, lanes_json=excluded.lanes_json, deny_nodes_json=excluded.deny_nodes_json,
      prom_url=excluded.prom_url, backup_window=excluded.backup_window,
      vmid_min=excluded.vmid_min, vmid_max=excluded.vmid_max, warm_target=excluded.warm_target, max_pool=excluded.max_pool,
      default_cores=excluded.default_cores, default_mem_gb=excluded.default_mem_gb, default_disk_gb=excluded.default_disk_gb,
      lease_ttl_h=excluded.lease_ttl_h, guest_user=excluded.guest_user, cpu_type=excluded.cpu_type, network_json=excluded.network_json, admin_keys_json=excluded.admin_keys_json, updated_at=excluded.updated_at
  `).run(orgId, v.enabled ? 1 : 0, JSON.stringify(v.lanes || []), JSON.stringify(v.deny_nodes || []), v.prom_url || null, v.backup_window || null, v.vmid_min, v.vmid_max, v.warm_target, v.max_pool,
    v.default_cores, v.default_mem_gb, v.default_disk_gb, v.lease_ttl_h, v.guest_user, v.cpu_type, JSON.stringify(v.network || CONFIG_DEFAULTS.network), JSON.stringify(v.admin_keys || []), Date.now());
  return getConfig(orgId);
}

function listEnabledOrgs() {
  return requireDb().prepare('SELECT org_id FROM proxmox_pool_config WHERE enabled = 1').all().map((r) => r.org_id);
}

function listVms(orgId) {
  needOrg(orgId);
  return requireDb().prepare('SELECT * FROM proxmox_pool_vms WHERE org_id = ? ORDER BY vmid').all(orgId).map(rowToVm);
}

function getVm(orgId, vmid) {
  needOrg(orgId);
  return rowToVm(requireDb().prepare('SELECT * FROM proxmox_pool_vms WHERE org_id = ? AND vmid = ?').get(orgId, vmid));
}

/**
 * Insert a fresh `building` row. A tombstone in `failed` state on the same vmid is
 * replaced (its VM was retired); any other existing row is a conflict.
 */
function insertBuilding(orgId, vm) {
  needOrg(orgId);
  const t = Date.now();
  const db = requireDb();
  const ex = db.prepare('SELECT state FROM proxmox_pool_vms WHERE org_id = ? AND vmid = ?').get(orgId, vm.vmid);
  if (ex && ex.state !== 'failed') throw new Error(`vmid ${vm.vmid} already tracked in state ${ex.state}`);
  if (ex) {
    db.prepare('DELETE FROM proxmox_pool_vms WHERE org_id = ? AND vmid = ?').run(orgId, vm.vmid);
    db.prepare('DELETE FROM proxmox_pool_ips WHERE org_id = ? AND vmid = ?').run(orgId, vm.vmid);
  }
  db.prepare(`
    INSERT INTO proxmox_pool_vms (org_id, vmid, name, node, state, cores, mem_gb, disk_gb, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'building', ?, ?, ?, ?, ?)
  `).run(orgId, vm.vmid, vm.name, vm.node, vm.cores, vm.mem_gb, vm.disk_gb, t, t);
  return getVm(orgId, vm.vmid);
}

function updateVm(orgId, vmid, patch) {
  needOrg(orgId);
  const keys = Object.keys(patch).filter((k) => VM_COLUMNS.includes(k));
  if (!keys.length) return getVm(orgId, vmid);
  if (patch.state !== undefined && !STATES.includes(patch.state)) throw new Error(`bad state ${patch.state}`);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  requireDb().prepare(`UPDATE proxmox_pool_vms SET ${sets}, updated_at = ? WHERE org_id = ? AND vmid = ?`)
    .run(...keys.map((k) => patch[k]), Date.now(), orgId, vmid);
  return getVm(orgId, vmid);
}

/** Addresses currently held by pool VMs (any state). -> Set<string> */
function listAllocatedIps(orgId) {
  needOrg(orgId);
  return new Set(requireDb().prepare('SELECT ip FROM proxmox_pool_ips WHERE org_id = ?').all(orgId).map((r) => r.ip));
}

/** The static address held by a VM, or null. */
function getAllocatedIp(orgId, vmid) {
  needOrg(orgId);
  const r = requireDb().prepare('SELECT ip FROM proxmox_pool_ips WHERE org_id = ? AND vmid = ?').get(orgId, vmid);
  return r ? r.ip : null;
}

/** Reserve an address for a VM. Returns false (never throws) when it is already held: the PK makes double allocation impossible. */
function reserveIp(orgId, ip, vmid) {
  needOrg(orgId);
  try {
    requireDb().prepare('INSERT INTO proxmox_pool_ips (org_id, ip, vmid, allocated_at) VALUES (?, ?, ?, ?)').run(orgId, ip, vmid, Date.now());
    return true;
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e && e.message))) return false;
    throw e;
  }
}

function releaseIp(orgId, vmid) {
  needOrg(orgId);
  return requireDb().prepare('DELETE FROM proxmox_pool_ips WHERE org_id = ? AND vmid = ?').run(orgId, vmid).changes;
}

function deleteVm(orgId, vmid) {
  needOrg(orgId);
  releaseIp(orgId, vmid);
  return requireDb().prepare('DELETE FROM proxmox_pool_vms WHERE org_id = ? AND vmid = ?').run(orgId, vmid).changes > 0;
}

module.exports = {
  ensure, STATES, CONFIG_DEFAULTS, CONFIG_FIELDS,
  getConfig, putConfig, listEnabledOrgs, listVms, getVm, insertBuilding, updateVm, deleteVm,
  listAllocatedIps, getAllocatedIp, reserveIp, releaseIp,
};
