'use strict';

/**
 * Proxmox disposable VM pool (DEVFLEET-P10), productised from HYPERION's proven
 * session-bound prototype (bin/quox-vmpool). Warm standby + made to order,
 * leased to a session with ITS OWN ssh public key, destroyed on release/expiry.
 *
 * NO PARALLEL ENFORCEMENT PATH. Every host command goes through the one governed
 * `ssh_exec` boundary (agentTools.executeTool), acting as agent `atlas`, so the
 * org's fleet standing grant (proxmox-test-vm-lane preset), the bastion grant mint,
 * the AEE trail and the HITL fallback all apply unchanged. A command the grant does
 * not cover files a normal approval; this module marks the VM failed with
 * "needs approval <id>" and STOPS. It never retries into a second approval.
 *
 * Dependencies are injected (store, runTool, emit, sleep, now) so the flow is testable
 * with the ssh layer mocked at its boundary and asserted on exact command strings.
 */

const crypto = require('crypto');
const defaultStore = require('./proxmoxPoolStore.js');

const ACTOR_AGENT = 'atlas';
const NAME_PREFIX = 'hyp'; // the standing grant preset's name_prefix; clones are hyp-pool-<vmid>
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const GUEST_USER_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const CPU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const LESSEE_RE = /^[\x20-\x7e]{1,80}$/;
const TEMPLATE_DISK_GB = 20;
const STALE_BUILD_MS = 15 * 60 * 1000;
const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;
const APPROVAL_PAUSE_MS = 60 * 60 * 1000;
// The control plane (auth) failed, not the VM: never a reason to fail or destroy a healthy pool VM.
const CONTROL_PLANE_RE = /couldn't load .*permissions|auth service was slow or unreachable/i;
const TRANSIENT_RE = /grant mint failed|timed out|aborted due to timeout|ECONNRESET|slow or unreachable|hat_unresolved/;

class PoolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]{16,2048}={0,2})(?: ([A-Za-z0-9@._:+=-]{1,64}))?$/;

/** A single authorized_keys line; nothing that could escape a quoted shell context. -> { ok:{line, fp} } | { error } */
function validatePubkey(raw) {
  if (typeof raw !== 'string') return { error: 'ssh_pubkey is required' };
  const line = raw.trim();
  if (!line || line.length > 4096) return { error: 'ssh_pubkey is required' };
  if (/[\r\n\0'"`$\\]/.test(line)) return { error: 'ssh_pubkey must be one line with no quotes, backslashes or shell characters' };
  const m = PUBKEY_RE.exec(line);
  if (!m) return { error: 'ssh_pubkey must be a single ssh-ed25519, ssh-rsa or ecdsa-sha2-nistp* public key line' };
  let blob;
  try { blob = Buffer.from(m[2], 'base64'); } catch { return { error: 'ssh_pubkey is not valid base64' }; }
  if (blob.length < 12) return { error: 'ssh_pubkey is truncated' };
  const typeLen = blob.readUInt32BE(0);
  if (typeLen > 64 || blob.length < 4 + typeLen || blob.slice(4, 4 + typeLen).toString('latin1') !== m[1]) {
    return { error: 'ssh_pubkey key type does not match its key data' };
  }
  const fp = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { ok: { line, fp } };
}

function isInt(n, lo, hi) { return Number.isInteger(n) && n >= lo && n <= hi; }

const CLONE_MODES = ['linked', 'full'];
const MAX_ADMIN_KEYS = 8;
const BACKUP_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** http(s) only, no credentials, no link-local/metadata. Internal Prometheus addresses are legitimate. */
function validPromUrl(u) {
  if (typeof u !== 'string' || u.length > 200) return false;
  let x;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
  if (x.username || x.password) return false;
  if (/^169\.254\./.test(x.hostname)) return false;
  return true;
}

function validateLanes(raw) {
  if (!Array.isArray(raw) || raw.length > 8) return { error: 'lanes must be a list of at most 8 lanes' };
  const out = []; const seen = new Set();
  for (const l of raw) {
    if (!l || typeof l !== 'object') return { error: 'each lane must be an object { node, template_vmid, max, clone_mode }' };
    const node = typeof l.node === 'string' ? l.node.trim() : '';
    if (!HOST_RE.test(node)) return { error: 'lane node must be one concrete host id' };
    if (seen.has(node)) return { error: `lane node ${node} is listed twice` };
    seen.add(node);
    const tpl = Number(l.template_vmid); const max = Number(l.max === undefined ? 10 : l.max);
    if (!isInt(tpl, 100, 999999999)) return { error: `lane ${node}: template_vmid must be an integer >= 100` };
    if (!isInt(max, 1, 50)) return { error: `lane ${node}: max must be an integer from 1 to 50` };
    const mode = l.clone_mode === undefined ? 'linked' : l.clone_mode;
    if (!CLONE_MODES.includes(mode)) return { error: `lane ${node}: clone_mode must be linked or full` };
    if (l.avx2 !== undefined && typeof l.avx2 !== 'boolean') return { error: `lane ${node}: avx2 must be true or false` };
    out.push({ node, template_vmid: tpl, max, clone_mode: mode, avx2: l.avx2 === true });
  }
  return { ok: out };
}

/** Is `nowMs` inside the 'HH:MM-HH:MM' UTC window (wraps midnight)? */
function inBackupWindow(window, nowMs) {
  const m = BACKUP_RE.exec(window || '');
  if (!m) return false;
  const d = new Date(nowMs);
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
  const from = Number(m[1]) * 60 + Number(m[2]); const to = Number(m[3]) * 60 + Number(m[4]);
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

// ---- static addressing (owner rule 2026-10-15: servers are static, never DHCP) ----

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0);
const intToIp = (n) => [24, 16, 8, 0].map((sh) => Math.floor(n / (2 ** sh)) % 256).join('.');
const maskOf = (prefix) => (prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0);
const netOf = (ip, prefix) => (ipToInt(ip) & maskOf(prefix)) >>> 0;
const DEFAULT_DNS = ['1.1.1.1', '1.0.0.1'];

/** Validate a network patch merged onto the current network. -> { ok: network } | { error } */
function validateNetwork(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'network must be an object { mode, ip_range, prefix, gateway, dns }' };
  for (const k of Object.keys(patch)) if (!['mode', 'ip_range', 'prefix', 'gateway', 'dns'].includes(k)) return { error: `unknown network field: ${k}` };
  const cur = current || {};
  const n = { mode: cur.mode || 'dhcp', ip_range: cur.ip_range || null, prefix: cur.prefix ?? 24, gateway: cur.gateway || null, dns: cur.dns || [...DEFAULT_DNS] };
  if ('ip_range' in patch) n.ip_range = patch.ip_range === '' ? null : patch.ip_range;
  if ('prefix' in patch) n.prefix = typeof patch.prefix === 'string' && patch.prefix.trim() !== '' ? Number(patch.prefix) : patch.prefix;
  if ('gateway' in patch) n.gateway = patch.gateway === '' ? null : patch.gateway;
  if ('dns' in patch) n.dns = patch.dns === null ? [...DEFAULT_DNS] : patch.dns;
  if ('mode' in patch) n.mode = patch.mode;
  else n.mode = n.ip_range ? 'static' : 'dhcp';
  if (n.mode !== 'static' && n.mode !== 'dhcp') return { error: 'network.mode must be static or dhcp' };
  if (!isInt(n.prefix, 8, 30)) return { error: 'network.prefix must be an integer from 8 to 30' };
  if (!Array.isArray(n.dns) || n.dns.length < 1 || n.dns.length > 4 || n.dns.some((d) => typeof d !== 'string' || !IPV4_RE.test(d))) return { error: 'network.dns must be a list of 1 to 4 IPv4 addresses' };
  if (n.gateway !== null && (typeof n.gateway !== 'string' || !IPV4_RE.test(n.gateway))) return { error: 'network.gateway must be an IPv4 address' };
  let lo = null; let hi = null;
  if (n.ip_range !== null) {
    const m = typeof n.ip_range === 'string' ? /^(\S+)-(\S+)$/.exec(n.ip_range.trim()) : null;
    if (!m || !IPV4_RE.test(m[1]) || !IPV4_RE.test(m[2])) return { error: 'network.ip_range must look like 192.0.2.10-192.0.2.40 (two IPv4 addresses)' };
    lo = ipToInt(m[1]); hi = ipToInt(m[2]);
    if (hi < lo) return { error: 'network.ip_range start must not be after its end' };
    if (hi - lo + 1 > 256) return { error: 'network.ip_range may hold at most 256 addresses' };
    if (netOf(m[1], n.prefix) !== netOf(m[2], n.prefix)) return { error: `network.ip_range must sit inside one /${n.prefix} network` };
    const base = netOf(m[1], n.prefix); const bcast = (base | (~maskOf(n.prefix) >>> 0)) >>> 0;
    if (lo === base || hi === bcast) return { error: 'network.ip_range must not include the network or broadcast address' };
    n.ip_range = `${m[1]}-${m[2]}`;
  }
  if (n.gateway !== null) {
    if (lo !== null && netOf(n.gateway, n.prefix) !== netOf(intToIp(lo), n.prefix)) return { error: `network.gateway must be inside the same /${n.prefix} network as ip_range` };
    const g = ipToInt(n.gateway);
    if (lo !== null && g >= lo && g <= hi) return { error: 'network.ip_range must not contain the gateway' };
    const base = netOf(n.gateway, n.prefix); const bcast = (base | (~maskOf(n.prefix) >>> 0)) >>> 0;
    if (g === base || g === bcast) return { error: 'network.gateway must not be the network or broadcast address' };
  }
  if (n.mode === 'static' && (n.ip_range === null || n.gateway === null)) return { error: 'network.mode static requires ip_range and gateway' };
  return { ok: n };
}

/** Every address in a validated range, ascending. */
function rangeAddresses(ipRange) {
  const [a, b] = ipRange.split('-');
  const out = [];
  for (let i = ipToInt(a); i <= ipToInt(b); i++) out.push(intToIp(i));
  return out;
}

const isStatic = (cfg) => !!(cfg && cfg.network && cfg.network.mode === 'static' && cfg.network.ip_range && cfg.network.gateway);

const isDenied = (cfg, node) => Array.isArray(cfg.deny_nodes) && cfg.deny_nodes.includes(node);

/** Validate a config patch against the current config. -> { ok:fullConfig, changed:[fields] } | { error } */
function validateConfig(patch, current) {
  const allowed = defaultStore.CONFIG_FIELDS;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'config body must be an object' };
  for (const k of Object.keys(patch)) if (!allowed.includes(k)) return { error: `unknown config field: ${k}` };
  const next = {};
  for (const k of allowed) next[k] = current[k];
  const changed = [];
  for (const [k, raw] of Object.entries(patch)) {
    let v = raw;
    if (k === 'enabled') {
      if (v === true || v === 1 || v === '1' || v === 'true') v = 1;
      else if (v === false || v === 0 || v === '0' || v === 'false') v = 0;
      else return { error: 'enabled must be true or false' };
    } else if (k === 'lanes') {
      const r = validateLanes(v); if (r.error) return r; v = r.ok;
    } else if (k === 'deny_nodes') {
      if (!Array.isArray(v) || v.length > 32 || v.some((n) => typeof n !== 'string' || !HOST_RE.test(n))) return { error: 'deny_nodes must be a list of host ids' };
      v = [...new Set(v)];
    } else if (k === 'prom_url') {
      if (v === null || v === '') v = null;
      else if (!validPromUrl(v)) return { error: 'prom_url must be an http(s) URL without credentials' };
    } else if (k === 'backup_window') {
      if (v === null || v === '') v = null;
      else if (typeof v !== 'string' || !BACKUP_RE.test(v)) return { error: 'backup_window must look like 05:45-08:00 (UTC)' };
    } else if (k === 'network') {
      const r = validateNetwork(v, current.network); if (r.error) return r; v = r.ok;
    } else if (k === 'admin_keys') {
      if (!Array.isArray(v)) return { error: 'admin_keys must be a list of ssh public key lines' };
      if (v.length > MAX_ADMIN_KEYS) return { error: `admin_keys may hold at most ${MAX_ADMIN_KEYS} keys` };
      const lines = [];
      for (const raw2 of v) {
        const r = validatePubkey(raw2);
        if (r.error) return { error: `admin_keys: ${r.error}` };
        if (!lines.includes(r.ok.line)) lines.push(r.ok.line);
      }
      v = lines;
    } else if (k === 'guest_user') {
      if (typeof v !== 'string' || !GUEST_USER_RE.test(v)) return { error: 'guest_user must be a lowercase unix user name' };
    } else if (k === 'cpu_type') {
      if (typeof v !== 'string' || !CPU_RE.test(v)) return { error: 'cpu_type must be a Proxmox cpu type like host' };
    } else {
      v = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      const bounds = {
        vmid_min: [100, 999999999], vmid_max: [100, 999999999],
        warm_target: [0, 20], max_pool: [1, 50], default_cores: [1, 32], default_mem_gb: [1, 128],
        default_disk_gb: [TEMPLATE_DISK_GB, 500], lease_ttl_h: [1, 168],
      }[k];
      if (!isInt(v, bounds[0], bounds[1])) return { error: `${k} must be an integer from ${bounds[0]} to ${bounds[1]}` };
    }
    if (JSON.stringify(next[k]) !== JSON.stringify(v)) changed.push(k);
    next[k] = v;
  }
  const rangeSet = next.vmid_min !== null && next.vmid_min !== undefined || next.vmid_max !== null && next.vmid_max !== undefined;
  if (rangeSet) {
    if (!isInt(next.vmid_min, 100, 999999999) || !isInt(next.vmid_max, 100, 999999999)) return { error: 'vmid_min and vmid_max must both be set' };
    if (next.vmid_max < next.vmid_min || next.vmid_max - next.vmid_min > 999) return { error: 'vmid_min must be <= vmid_max and the span at most 1000' };
    for (const l of next.lanes) {
      if (l.template_vmid >= next.vmid_min && l.template_vmid <= next.vmid_max) return { error: 'the VMID range must not contain a template' };
    }
  }
  for (const l of next.lanes) if (next.deny_nodes.includes(l.node)) return { error: `lane node ${l.node} is on the deny_nodes list` };
  if (next.warm_target > next.max_pool) return { error: 'warm_target must not exceed max_pool' };
  if (next.enabled) {
    if (!next.lanes.length || !rangeSet) return { error: 'at least one lane, vmid_min and vmid_max are required before enabling the pool' };
  }
  return { ok: next, changed };
}

/** Every VMID the pool touches must sit inside the org's configured range (asserted before each command). */
function assertInRange(cfg, vmid) {
  if (!Number.isInteger(vmid) || cfg.vmid_min === null || cfg.vmid_max === null || vmid < cfg.vmid_min || vmid > cfg.vmid_max) {
    throw new PoolError('out_of_range', `vmid ${vmid} is outside the pool range ${cfg.vmid_min}-${cfg.vmid_max}`);
  }
  return vmid;
}

// ---------------------------------------------------------------------------
// Commands (pure). These strings are the contract with the proxmox-test-vm-lane
// standing grant preset; test/proxmoxPool.test.js runs every one through it.
// ---------------------------------------------------------------------------

// Grow partition, PV, then LV + filesystem (LVM golden: ubuntu-vg/ubuntu-lv on sda3).
const GROW_SNIPPET = 'for n in 3 2 1; do growpart /dev/sda $n >/dev/null 2>&1 && break; done; pvresize $(pvs --noheadings -o pv_name | head -1) >/dev/null 2>&1; lvextend -r -l +100%FREE $(findmnt -no SOURCE /) >/dev/null 2>&1 || resize2fs $(findmnt -no SOURCE /) >/dev/null 2>&1;';

/** The guest bootstrap script. Runs inside `bash -c '...'`, so it may NEVER contain a single quote. */
function staticNetScript(net) {
  const { ip, prefix, gateway, dns } = net;
  const yaml = `network:\\n  version: 2\\n  ethernets:\\n    all:\\n      match:\\n        name: e*\\n      dhcp4: false\\n      dhcp6: false\\n      addresses: [${ip}/${prefix}]\\n      routes: [{to: default, via: ${gateway}}]\\n      nameservers:\\n        addresses: [${dns.join(', ')}]\\n`;
  return [
    // Old DHCP definitions are backed up then removed, otherwise 50-cloud-init.yaml keeps asking for a lease too.
    'rm -rf /root/netplan.bak; cp -a /etc/netplan /root/netplan.bak; rm -f /etc/netplan/*.yaml;',
    `printf "${yaml}" > /etc/netplan/60-static.yaml; chmod 600 /etc/netplan/60-static.yaml;`,
    // cloud-init would regenerate the DHCP file on the next boot.
    'mkdir -p /etc/cloud/cloud.cfg.d; printf "network: {config: disabled}\\n" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg;',
    'netplan apply >/dev/null 2>&1; sleep 2;',
    `(ip -4 -o addr show | grep -qF "${ip}/${prefix}") && (for i in 1 2 3 4 5 6; do ping -c1 -W2 ${gateway} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1) && echo STATIC_OK;`,
  ].join(' ');
}

const APT_HTTPS_SNIPPET = 'sed -i -E "s#http://(([a-z]+[.])?archive|security)[.]ubuntu[.]com#https://\\1.ubuntu.com#g" /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list >/dev/null 2>&1;';
function bootstrapScript(cfg, name, staticNet = null) {
  const g = cfg.guest_user;
  return [
    `id ${g} >/dev/null 2>&1 || useradd -m -s /bin/bash ${g};`,
    `mkdir -p /home/${g}/.ssh; rm -f /home/${g}/.ssh/authorized_keys; chmod 700 /home/${g}/.ssh; chown -R ${g}:${g} /home/${g}/.ssh;`,
    `echo "${g} ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/${g}; chmod 440 /etc/sudoers.d/${g};`,
    `hostnamectl set-hostname ${name};`,
    // Clones share the template machine-id, which makes DHCP hand every clone the SAME address.
    'rm -f /etc/machine-id /var/lib/dbus/machine-id; systemd-machine-id-setup >/dev/null;',
    // Ubuntu 24.04 socket-activates sshd: a bare `systemctl restart ssh` can leave ssh AND ssh.socket
    // FAILED (live 2026-10-15, VM 9253: connection refused). Reset, restart the socket, then the service,
    // and print a marker the builder checks before the VM may be marked ready.
    'rm -f /etc/ssh/ssh_host_*; ssh-keygen -A >/dev/null; systemctl reset-failed ssh ssh.socket >/dev/null 2>&1; systemctl restart ssh.socket >/dev/null 2>&1; systemctl restart ssh >/dev/null 2>&1; sleep 1; (ss -ltn | grep -q \":22 \") && echo SSHD_LISTENING;',
    staticNet ? staticNetScript(staticNet) : 'netplan apply >/dev/null 2>&1;',
    // Ubuntu apt over https: some LANs drop TCP 80 (REL424 2026-10-19: apt-daily failing on pool VMs).
    // Only the Ubuntu archive/security hosts are rewritten; all of them serve the same paths over TLS.
    APT_HTTPS_SNIPPET,
    GROW_SNIPPET,
    'echo BOOTSTRAPPED',
  ].join(' ');
}

/** Lease-time key injection: REPLACE authorized_keys with the lessee's own key. Needs a validated key line. */
function keyScript(cfg, pubkeyLine) {
  const g = cfg.guest_user;
  // Owner rule 2026-10-19: the owner never depends on one session's key to reach a VM. Org admin keys ride along.
  const admin = (Array.isArray(cfg.admin_keys) ? cfg.admin_keys : []).map((a) => ` echo "${a}" >> /home/${g}/.ssh/authorized_keys;`).join('');
  return `mkdir -p /home/${g}/.ssh; echo "${pubkeyLine}" > /home/${g}/.ssh/authorized_keys;${admin} chmod 700 /home/${g}/.ssh; chmod 600 /home/${g}/.ssh/authorized_keys; chown -R ${g}:${g} /home/${g}/.ssh; echo KEYED`;
}

// ---- tags and host key (DEVFLEET-P19a) ----

/** Proxmox tag for a lessee, inside the lane grant's [a-z0-9_-]{1,40} charset. */
function lesseeTag(lessee) {
  const t = String(lessee || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 33).replace(/-+$/g, '');
  return `lessee-${t || 'unknown'}`;
}

/** Description text inside the grant's [A-Za-z0-9 .,:=_/@+-]{1,300} charset (anything else becomes _). */
function descText(s) { return String(s || '').replace(/[^A-Za-z0-9 .,:=_/@+-]/g, '_'); }

function leaseDescription({ lessee, purpose, since, expires }) {
  const d = `hyperion: lessee=${descText(lessee)} purpose=${descText(purpose) || 'none'} since=${since} expires=${expires || 'none'}`;
  return d.slice(0, 300);
}

const HOST_KEY_SCRIPT = 'cat /etc/ssh/ssh_host_ed25519_key.pub';

/** Pull `<type> <base64>` out of the guest-exec output and fingerprint it like ssh-keygen -lf. -> { line, fingerprint } | null */
function parseHostKey(out) {
  const m = /(ssh-ed25519) ([A-Za-z0-9+/]{16,2048}={0,2})/.exec(String(out || ''));
  if (!m) return null;
  let blob;
  try { blob = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (blob.length < 12) return null;
  const typeLen = blob.readUInt32BE(0);
  if (typeLen > 64 || blob.length < 4 + typeLen || blob.slice(4, 4 + typeLen).toString('latin1') !== m[1]) return null;
  return { line: `${m[1]} ${m[2]}`, fingerprint: `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` };
}

function guestExec(vmid, script) {
  if (script.includes("'")) throw new PoolError('bad_script', 'guest script may not contain single quotes');
  return `qm guest exec ${vmid} --timeout 120 -- bash -c '${script}'`;
}

const cmd = {
  list: () => 'qm list',
  clone: (cfg, vmid) => `qm clone ${cfg.template_vmid} ${assertInRange(cfg, vmid)} --name ${NAME_PREFIX}-pool-${vmid}`,
  // Full clones copy the whole disk and outlive one request: run detached, then poll `qm config`.
  cloneFull: (cfg, vmid) => `systemd-run --collect --unit ${NAME_PREFIX}-clone-${assertInRange(cfg, vmid)} qm clone ${cfg.template_vmid} ${vmid} --name ${NAME_PREFIX}-pool-${vmid} --full`,
  config: (cfg, vmid) => `qm config ${assertInRange(cfg, vmid)}`,
  status: (cfg, vmid) => `qm status ${assertInRange(cfg, vmid)}`,
  set: (cfg, vmid, cores, memGb) => `qm set ${assertInRange(cfg, vmid)} --cores ${cores} --memory ${memGb * 1024} --agent 1 --onboot 0 --cpu ${cfg.cpu_type}`,
  resize: (cfg, vmid, growGb) => `qm resize ${assertInRange(cfg, vmid)} scsi0 +${growGb}G`,
  start: (cfg, vmid) => `qm start ${assertInRange(cfg, vmid)}`,
  stop: (cfg, vmid) => `qm stop ${assertInRange(cfg, vmid)}`,
  destroy: (cfg, vmid) => `qm destroy ${assertInRange(cfg, vmid)} --purge`,
  ping: (cfg, vmid) => `qm guest cmd ${assertInRange(cfg, vmid)} ping`,
  net: (cfg, vmid) => `qm guest cmd ${assertInRange(cfg, vmid)} network-get-interfaces`,
  exec: (cfg, vmid, script) => guestExec(assertInRange(cfg, vmid), script),
  // Only the two shapes the lane standing grant allows: a comma tag list and a single-quoted plain-text description.
  tag: (cfg, vmid, tags, description) => `qm set ${assertInRange(cfg, vmid)} --tags ${tags} --description '${description}'`,
};

function parseQmList(out) {
  const ids = new Set();
  String(out || '').split('\n').slice(1).forEach((l) => { const m = /^\s*(\d+)\s/.exec(l); if (m) ids.add(Number(m[1])); });
  return ids;
}

function parseGuestIp(out) {
  const s = String(out || '');
  const a = s.indexOf('['); const b = s.lastIndexOf(']');
  if (a < 0 || b < a) return null;
  let ifs;
  try { ifs = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  for (const i of ifs) {
    if (!i || i.name === 'lo') continue;
    for (const ip of i['ip-addresses'] || []) {
      const addr = ip && ip['ip-address'];
      if (ip && ip['ip-address-type'] === 'ipv4' && addr && !addr.startsWith('127.') && !addr.startsWith('169.254.')) return addr;
    }
  }
  return null;
}

/** Every non-loopback, non-link-local IPv4 the guest agent reports. */
function parseGuestIps(out) {
  const s = String(out || '');
  const a = s.indexOf('['); const b = s.lastIndexOf(']');
  if (a < 0 || b < a) return [];
  let ifs;
  try { ifs = JSON.parse(s.slice(a, b + 1)); } catch { return []; }
  const ips = [];
  for (const i of ifs) {
    if (!i || i.name === 'lo') continue;
    for (const ip of i['ip-addresses'] || []) {
      const addr = ip && ip['ip-address'];
      if (ip && ip['ip-address-type'] === 'ipv4' && addr && !addr.startsWith('127.') && !addr.startsWith('169.254.')) ips.push(addr);
    }
  }
  return ips;
}

/** CLI/tool error bodies are { error:true, message } as often as { error:'text' }: never log the literal 'true'. */
function errorText(res) {
  if (!res) return '';
  if (res.error === true) return String(res.message || res.code || res.stderr || 'error');
  return String(res.error || res.message || res.stderr || '');
}

/**
 * One host command through the governed ssh_exec boundary (the ONLY execution path; the standing
 * grant / HITL decision happens inside runTool). Never throws. Shared with the rehearsal engine
 * (lib/proxmoxRehearse.js) so there is exactly one place that talks to ssh_exec for Proxmox work.
 * cfg.node is the host; reason is passed through verbatim.
 */
async function governedRun({ runTool, sleep, now = () => Date.now(), onPending = () => {} }, orgId, cfg, command, reason, { retry = true } = {}) {
  let res;
  if (isDenied(cfg, cfg.node)) return { ok: false, error: `node ${cfg.node} is on the deny list; nothing runs there` };
  for (let attempt = 1; attempt <= (retry ? 3 : 1); attempt++) {
    try { res = await runTool({ orgId, host: cfg.node, command, reason }); } catch (e) { res = { success: false, error: e && e.message ? e.message : String(e) }; }
    if (res && res.pending === true) {
      const approvalId = res.approvalId || (res._approval && res._approval.id) || 'unknown';
      onPending(approvalId);
      return { ok: false, pending: true, approvalId, error: `needs approval ${approvalId}` };
    }
    const errText = res && !res.success ? errorText(res) : '';
    // Transient control-plane blips retry (never a pending approval, never a policy denial).
    if (res && res.success === true) return { ok: true, stdout: String(res.stdout ?? res.output ?? '') };
    // A hat that could not be RESOLVED (auth slow) is a blip, not a policy denial: it retries too.
    if (!(attempt < 3 && TRANSIENT_RE.test(errText) && (!res.hatDenied || res.hatResolveFailed))) break;
    await sleep(attempt * 3000);
  }
  const err = res ? (errorText(res) || 'command failed') : 'no result';
  return { ok: false, error: err.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

function createPool({ store = defaultStore, runTool, emit = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), log = (m) => console.log(m), pingAttempts = 30, pingIntervalMs = 5000, ipSettleMs = 8000, cloneAttempts = 120, cloneIntervalMs = 10000, freeFraction = defaultFreeFraction, listClusterVmids = null, readAgentInterfaces = defaultReadAgentInterfaces, ipCheckMs = 60000, statusBudgetMs = 8000, statusConcurrency = 6, probeIp = defaultProbeIp, probeSsh = null, listFleetIps = defaultListFleetIps } = {}) {
  if (typeof runTool !== 'function') throw new Error('createPool requires runTool');

  const chains = new Map();      // org -> promise tail (one pool op per org at a time)
  const activeBuilds = new Set(); // `${org}:${vmid}` being built by THIS process
  const paused = new Map();      // org -> { approvalId, until }
  const pendingWarms = new Set();
  const retireAttempts = new Map(); // org:vmid -> retire tries (bounded)
  const ipChecked = new Map();      // org:vmid -> ms of last status-driven guest-agent read (rate limit)
  const staticMoveAttempts = new Map(); // org:vmid -> failed DHCP-to-static moves (bounded: 3, then left for a human)

  function withLock(orgId, fn) {
    const prev = chains.get(orgId) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    chains.set(orgId, tail);
    tail.then(() => { if (chains.get(orgId) === tail) chains.delete(orgId); });
    return run;
  }

  function emitOp(intent, orgId, payload, actor) {
    try { emit(intent, orgId, payload, actor); } catch { /* evidence never blocks */ }
  }

  /** One host command through the governed ssh_exec boundary. Never throws. */
  function run(orgId, cfg, command, reason, opts = {}) {
    return governedRun({ runTool, sleep, now, onPending: (approvalId) => paused.set(orgId, { approvalId, until: now() + APPROVAL_PAUSE_MS }) }, orgId, cfg, command, `Proxmox pool: ${reason}`, opts);
  }

  function must(r, what) {
    if (r.ok) return r.stdout;
    if (r.pending) throw new PoolError('pending_approval', `${what}: needs approval ${r.approvalId}`, { approvalId: r.approvalId });
    throw new PoolError('host_failed', `${what} failed: ${r.error}`);
  }

  async function failVm(orgId, cfg, vmid, err, { destroy }) {
    const msg = err && err.code === 'pending_approval' ? `needs approval ${err.approvalId}` : String(err && err.message ? err.message : err).slice(0, 300);
    store.updateVm(orgId, vmid, { state: 'failed', last_error: msg });
    if (destroy && !(err && err.code === 'pending_approval')) {
      // Retire it: best effort only, once, never retried.
      await run(orgId, cfg, cmd.stop(cfg, vmid), `stop failed ${vmid}`);
      const d = await run(orgId, cfg, cmd.destroy(cfg, vmid), `destroy failed ${vmid}`);
      // The address is only free again once the VM is really gone (a half-alive VM would still answer on it).
      if (d.ok || /does not exist|no such|not found/i.test(d.error || '')) store.releaseIp(orgId, vmid);
    }
    log(`[ProxmoxPool] org=${orgId} vm=${vmid} FAILED: ${msg}`);
  }

  async function waitAgent(orgId, cfg, vmid) {
    for (let i = 0; i < pingAttempts; i++) {
      const r = await run(orgId, cfg, cmd.ping(cfg, vmid), `agent ping ${vmid}`);
      if (r.ok) return;
      if (r.pending) must(r, 'agent ping');
      await sleep(pingIntervalMs);
    }
    throw new PoolError('agent_timeout', `guest agent on ${vmid} never answered`);
  }

  const laneCfg = (cfg, lane) => ({ ...cfg, node: lane.node, template_vmid: lane.template_vmid });
  const cfgForRow = (cfg, row) => ({ ...cfg, node: row.node });
  const activeLanes = (cfg) => cfg.lanes.filter((l) => !isDenied(cfg, l.node));
  const laneWanted = (l, want) => (!want.node || l.node === want.node) && (!want.requireAvx2 || l.avx2 === true);

  /** Parse and check the placement constraints of a lease request BEFORE anything runs. -> { node?, requireAvx2? } */
  function placementWant(cfg, req) {
    const want = {};
    if (req.require_avx2 !== undefined && req.require_avx2 !== null && typeof req.require_avx2 !== 'boolean') throw new PoolError('bad_request', 'require_avx2 must be true or false');
    if (req.require_avx2 === true) want.requireAvx2 = true;
    if (req.node !== undefined && req.node !== null && req.node !== '') {
      if (typeof req.node !== 'string' || !HOST_RE.test(req.node)) throw new PoolError('bad_request', 'node must be one concrete host id');
      const l = activeLanes(cfg).find((x) => x.node === req.node);
      if (!l) throw new PoolError('bad_request', `node ${req.node} is not an active pool lane (unknown, or on the deny list)`);
      want.node = req.node;
      if (want.requireAvx2 && l.avx2 !== true) throw new PoolError('no_avx2_lane', `lane ${req.node} does not have avx2, so it cannot take a require_avx2 lease`);
    } else if (want.requireAvx2 && !activeLanes(cfg).some((l) => l.avx2 === true)) {
      throw new PoolError('no_avx2_lane', 'no active pool lane has avx2, so a require_avx2 lease cannot be placed (mark a lane avx2:true in the pool config); nothing was built');
    }
    return want;
  }

  /** VMIDs are CLUSTER-WIDE: union `qm list` across every lane's node plus the store. */
  async function nextVmid(orgId, cfg, rows) {
    const used = new Set();
    let viaCluster = null;
    if (typeof listClusterVmids === 'function') {
      try { viaCluster = await listClusterVmids(orgId, cfg); } catch { viaCluster = null; }
    }
    if (viaCluster instanceof Set || Array.isArray(viaCluster)) {
      for (const i of viaCluster) used.add(Number(i));
    } else {
      for (const lane of activeLanes(cfg)) {
        const r = await run(orgId, laneCfg(cfg, lane), cmd.list(), `list VMs on ${lane.node}`);
        if (!r.ok) {
          if (r.pending) must(r, 'qm list');
          throw new PoolError('qm_list_failed', `could not list VMs on ${lane.node} (${r.error}); not building`);
        }
        for (const i of parseQmList(r.stdout)) used.add(i);
      }
    }
    const tracked = new Set(rows.filter((v) => v.state !== 'failed').map((v) => v.vmid));
    for (let i = cfg.vmid_min; i <= cfg.vmid_max; i++) if (!used.has(i) && !tracked.has(i)) return i;
    throw new PoolError('no_free_vmid', `no free VMID in ${cfg.vmid_min}-${cfg.vmid_max}`);
  }

  /** Highest free-RAM FRACTION among lanes under their cap; fewest pool VMs when Prometheus has nothing. */
  async function pickLane(cfg, rows, want = {}) {
    const live = rows.filter((v) => v.state !== 'failed');
    const count = (n) => live.filter((v) => v.node === n).length;
    const open = activeLanes(cfg).filter((l) => laneWanted(l, want) && count(l.node) < l.max);
    if (!open.length) {
      const what = want.node ? `lane ${want.node}` : want.requireAvx2 ? 'every avx2 lane' : 'every pool lane';
      throw new PoolError('pool_full', `${what} is at its cap (or on the deny list)`);
    }
    if (cfg.prom_url) {
      const scored = [];
      for (const l of open) {
        let f = null;
        try { f = await freeFraction(cfg.prom_url, l.node); } catch { f = null; }
        scored.push({ l, f: Number.isFinite(f) ? f : null });
      }
      if (scored.some((x) => x.f !== null)) {
        scored.sort((a, b) => (b.f ?? -1) - (a.f ?? -1) || count(a.l.node) - count(b.l.node));
        return scored[0].l;
      }
    }
    return [...open].sort((a, b) => count(a.node) - count(b.node))[0];
  }

  /** Poll a detached full clone until its lock drops and scsi0 exists (bounded, never blocks the event loop). */
  async function waitClone(orgId, cfg, vmid) {
    for (let i = 0; i < cloneAttempts; i++) {
      const r = await run(orgId, cfg, cmd.config(cfg, vmid), `clone progress ${vmid}`);
      if (r.pending) must(r, 'qm config');
      if (r.ok && !/^lock: clone/m.test(r.stdout) && /^scsi0:/m.test(r.stdout)) return;
      await sleep(cloneIntervalMs);
    }
    throw new PoolError('clone_timeout', `clone ${vmid} did not finish`);
  }

  function requireEnabled(cfg) {
    if (!cfg.enabled) throw new PoolError('pool_disabled', 'the VM pool is not enabled for this org');
  }

  /**
   * Lowest free address in the configured range (caller holds the org lock). An address is free only when
   * no pool VM holds it, it is not the gateway or a Bastion fleet host, and a live probe finds nothing on it.
   */
  async function allocateStaticIp(orgId, cfg, vmid) {
    const net = cfg.network;
    const held = store.listAllocatedIps(orgId);
    let fleet = new Set();
    try { fleet = new Set(await listFleetIps(orgId)); } catch (e) { log(`[ProxmoxPool] org=${orgId} fleet ip registry unreachable (${e.message}); relying on the live probe`); }
    for (const ip of rangeAddresses(net.ip_range)) {
      if (held.has(ip) || fleet.has(ip) || ip === net.gateway) continue;
      let inUse;
      try { inUse = await probeIp(ip); } catch (e) { throw new PoolError('ip_probe_failed', `could not probe ${ip} (${e.message}); not building`); }
      if (inUse) { log(`[ProxmoxPool] org=${orgId} ${ip} answers on the network; skipping`); continue; }
      if (store.reserveIp(orgId, ip, vmid)) return ip;
    }
    throw new PoolError('no_free_ip', `no free address in ${net.ip_range}`);
  }

  /** Clone + size + boot + bootstrap one VM (caller holds the org lock). Returns the ready row. */
  async function buildLocked(orgId, cfg, size, onReserved, want = {}) {
    const rows = store.listVms(orgId);
    if (rows.filter((v) => v.state !== 'failed').length >= cfg.max_pool) {
      throw new PoolError('pool_full', `pool at max_pool=${cfg.max_pool}; release something first`);
    }
    const lane = await pickLane(cfg, rows, want);
    const gcfg = cfg;
    cfg = laneCfg(gcfg, lane);
    const vmid = await nextVmid(orgId, gcfg, rows);
    const name = `${NAME_PREFIX}-pool-${vmid}`;
    store.insertBuilding(orgId, { vmid, name, node: cfg.node, cores: size.cores, mem_gb: size.mem_gb, disk_gb: size.disk_gb });
    let staticNet = null;
    if (isStatic(gcfg)) {
      try {
        const ip = await allocateStaticIp(orgId, gcfg, vmid);
        staticNet = { ip, prefix: gcfg.network.prefix, gateway: gcfg.network.gateway, dns: gcfg.network.dns };
      } catch (e) {
        // Nothing was cloned yet: drop the reservation row instead of leaving a failed tombstone with a VM that never existed.
        store.deleteVm(orgId, vmid);
        throw e;
      }
    }
    const key = `${orgId}:${vmid}`;
    activeBuilds.add(key);
    if (typeof onReserved === 'function') { try { onReserved(vmid); } catch { /* caller hook never breaks a build */ } }
    const t0 = now();
    try {
      // qm clone is NOT idempotent: a timed-out clone may still be running, so a retry fails with
      // 'config file already exists'. Never retry it.
      if (lane.clone_mode === 'full') {
        must(await run(orgId, cfg, cmd.cloneFull(cfg, vmid), `clone ${vmid} (detached)`, { retry: false }), `clone ${vmid} launch`);
        await waitClone(orgId, cfg, vmid);
      } else {
        must(await run(orgId, cfg, cmd.clone(cfg, vmid), `clone ${vmid}`, { retry: false }), `clone ${vmid}`);
      }
      must(await run(orgId, cfg, cmd.set(cfg, vmid, size.cores, size.mem_gb), `size ${vmid}`), `qm set ${vmid}`);
      const grow = size.disk_gb - TEMPLATE_DISK_GB;
      if (grow > 0) must(await run(orgId, cfg, cmd.resize(cfg, vmid, grow), `resize ${vmid}`), `resize ${vmid}`);
      const st = await run(orgId, cfg, cmd.start(cfg, vmid), `start ${vmid}`);
      if (!st.ok) {
        if (st.pending) must(st, `start ${vmid}`);
        // A start can succeed while its reply times out: only fail if the VM is not actually running.
        const chk = await run(orgId, cfg, cmd.status(cfg, vmid), `status ${vmid}`);
        if (chk.pending) must(chk, `status ${vmid}`);
        if (!(chk.ok && /status:\s*running/.test(chk.stdout))) throw new PoolError('host_failed', `start ${vmid} failed: ${st.error}`);
      }
      await waitAgent(orgId, cfg, vmid);
      const out = must(await run(orgId, cfg, cmd.exec(cfg, vmid, bootstrapScript(cfg, name, staticNet)), `bootstrap ${vmid}`), `bootstrap ${vmid}`);
      if (!out.includes('BOOTSTRAPPED')) throw new PoolError('bootstrap_failed', `bootstrap of ${vmid} failed`);
      if (!out.includes('SSHD_LISTENING')) throw new PoolError('bootstrap_failed', `sshd is not listening on ${vmid} after bootstrap; not handing out an unreachable VM`);
      if (staticNet && !out.includes('STATIC_OK')) throw new PoolError('bootstrap_failed', `static address ${staticNet.ip} did not come up on ${vmid} (or the gateway ${staticNet.gateway} is unreachable); not handing out a VM on an unknown address`);
      await sleep(ipSettleMs); // after netplan apply: unique machine-id => unique DHCP lease
      let ip = null;
      if (staticNet) {
        // Static is the source of truth; the guest agent is only a cross-check.
        ip = staticNet.ip;
        try {
          const r = await run(orgId, cfg, cmd.net(cfg, vmid), `ip of ${vmid}`);
          if (r.ok && !parseGuestIps(r.stdout).includes(ip)) log(`[ProxmoxPool] org=${orgId} vm=${vmid} guest agent does not report static ${ip}; keeping static`);
        } catch { /* cross-check only */ }
      }
      for (let i = 0; i < 6 && !ip; i++) {
        const r = await run(orgId, cfg, cmd.net(cfg, vmid), `ip of ${vmid}`);
        if (r.pending) must(r, 'network-get-interfaces');
        if (r.ok) ip = parseGuestIp(r.stdout);
        if (!ip && i < 5) await sleep(pingIntervalMs);
      }
      if (!ip) throw new PoolError('no_ip', `no IPv4 on ${vmid}`);
      const row = store.updateVm(orgId, vmid, { state: 'ready', ip, last_error: null });
      emitOp('quox.proxmox.pool.build', orgId, { vmid, name, node: cfg.node, cores: size.cores, mem_gb: size.mem_gb, disk_gb: size.disk_gb, outcome: 'ready', duration_ms: now() - t0 });
      log(`[ProxmoxPool] org=${orgId} vm=${vmid} READY ${ip}`);
      return row;
    } catch (e) {
      await failVm(orgId, cfg, vmid, e, { destroy: true });
      emitOp('quox.proxmox.pool.build', orgId, { vmid, name, node: cfg.node, outcome: 'failed', error: store.getVm(orgId, vmid)?.last_error || String(e.message).slice(0, 200), duration_ms: now() - t0 });
      throw e;
    } finally {
      activeBuilds.delete(key);
    }
  }

  async function destroyLocked(orgId, cfg, vmid, intent, extra) {
    store.updateVm(orgId, vmid, { state: 'recycling' });
    await run(orgId, cfg, cmd.stop(cfg, vmid), `stop ${vmid}`); // error ignored: it may already be stopped or gone
    const d = await run(orgId, cfg, cmd.destroy(cfg, vmid), `destroy ${vmid}`);
    const gone = !d.ok && !d.pending && /does not exist|no such|not found/i.test(d.error || '');
    if (!d.ok && !gone) {
      const err = d.pending ? new PoolError('pending_approval', `destroy ${vmid}: needs approval ${d.approvalId}`, { approvalId: d.approvalId }) : new PoolError('host_failed', `destroy ${vmid} failed: ${d.error}`);
      await failVm(orgId, cfg, vmid, err, { destroy: false });
      emitOp(intent, orgId, { vmid, ...extra, outcome: 'failed', error: store.getVm(orgId, vmid)?.last_error }, ACTOR_AGENT);
      throw err;
    }
    store.deleteVm(orgId, vmid);
    emitOp(intent, orgId, { vmid, ...extra, outcome: 'destroyed' }, ACTOR_AGENT);
    log(`[ProxmoxPool] org=${orgId} vm=${vmid} destroyed (${intent.split('.').pop()})`);
  }

  function scheduleWarm(orgId) {
    let cfg;
    try { cfg = store.getConfig(orgId); } catch { return null; }
    if (!cfg.enabled) return null;
    const p = warm(orgId).catch((e) => log(`[ProxmoxPool] org=${orgId} background warm failed: ${e.message}`)).finally(() => pendingWarms.delete(p));
    pendingWarms.add(p);
    return p;
  }

  // ---- public ops ---------------------------------------------------------

  /**
   * Learn the VM's CURRENT address from the QEMU guest agent (DHCP can move it on reboot).
   * Never throws: an unreadable agent keeps the stored ip and records ip_check_error (surfaced as ip_stale).
   */
  async function refreshIp(orgId, vm) {
    const key = `${orgId}:${vm.vmid}`;
    ipChecked.set(key, now());
    try {
      const data = await readAgentInterfaces({ orgId, node: vm.node, vmid: vm.vmid });
      const raw = JSON.stringify(data && !Array.isArray(data) && data.result !== undefined ? data.result : data);
      const staticIp = store.getAllocatedIp(orgId, vm.vmid);
      if (staticIp) {
        // Static is the source of truth. A disagreeing guest agent is flagged (ip_stale) and logged, never adopted.
        const seen = parseGuestIps(raw);
        if (!seen.length) throw new Error('guest agent reported no non-loopback IPv4 address');
        if (seen.includes(staticIp)) {
          if (vm.ip_check_error) store.updateVm(orgId, vm.vmid, { ip_check_error: null });
          if (vm.ip !== staticIp) store.updateVm(orgId, vm.vmid, { ip: staticIp });
          return { ip: staticIp, changed: false };
        }
        const msg = `guest agent reports ${seen.join(',')}, static address is ${staticIp}`;
        log(`[ProxmoxPool] org=${orgId} vm=${vm.vmid} ${msg}`);
        store.updateVm(orgId, vm.vmid, { ip_check_error: msg.slice(0, 200) });
        return { ip: staticIp, changed: false, error: msg };
      }
      const ip = parseGuestIp(raw);
      if (!ip) throw new Error('guest agent reported no non-loopback IPv4 address');
      const patch = {};
      if (vm.ip_check_error) patch.ip_check_error = null;
      if (ip !== vm.ip) {
        patch.ip = ip;
        store.updateVm(orgId, vm.vmid, patch);
        emitOp('quox.proxmox.pool.ip_changed', orgId, { vmid: vm.vmid, old: vm.ip || null, new: ip }, ACTOR_AGENT);
      } else if (patch.ip_check_error === null) {
        store.updateVm(orgId, vm.vmid, patch);
      }
      return { ip, changed: ip !== vm.ip };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      try { store.updateVm(orgId, vm.vmid, { ip_check_error: msg }); } catch { /* best effort */ }
      return { ip: vm.ip, changed: false, error: msg };
    }
  }

  /**
   * status() with a rate-limited (once per VM per ipCheckMs) guest-agent refresh of leased/ready VMs first.
   * Refreshes run in parallel (bounded) under a wall-clock budget: one guest-agent read over Bastion can take
   * seconds, and a serial sweep of a full pool outlived the client's 30s timeout. Reads still running at the
   * budget finish in the background (refreshIp never throws) and land on the next status.
   */
  async function statusFresh(orgId) {
    const t = now();
    const due = store.listVms(orgId).filter((v) => {
      if (v.state !== 'leased' && v.state !== 'ready') return false;
      const last = ipChecked.get(`${orgId}:${v.vmid}`);
      return last === undefined || t - last >= ipCheckMs;
    });
    if (due.length) {
      let next = 0;
      const worker = async () => { while (next < due.length) { const v = due[next++]; await refreshIp(orgId, v); } };
      const all = Promise.all(Array.from({ length: Math.min(statusConcurrency, due.length) }, worker));
      let timer;
      const budget = new Promise((r) => { timer = setTimeout(r, statusBudgetMs); if (timer.unref) timer.unref(); });
      await Promise.race([all, budget]);
      clearTimeout(timer);
    }
    return status(orgId);
  }

  function status(orgId) {
    const cfg = store.getConfig(orgId);
    const vms = store.listVms(orgId).map(({ _lease_expires_ms, _created_ms, _updated_ms, org_id, ...v }) => (v.ip_check_error ? { ...v, ip_stale: true } : v));
    const counts = {};
    for (const s of defaultStore.STATES) counts[s] = vms.filter((v) => v.state === s).length;
    const p = paused.get(orgId);
    return { config: cfg, counts, vms, paused: p && p.until > now() ? { approval_id: p.approvalId, until: new Date(p.until).toISOString() } : null };
  }

  function configure(orgId, patch, actor) {
    const cur = store.getConfig(orgId);
    const v = validateConfig(patch, cur);
    if (v.error) throw new PoolError('bad_request', v.error);
    const saved = store.putConfig(orgId, v.ok);
    paused.delete(orgId);
    const fields = {};
    for (const k of v.changed) fields[k] = saved[k];
    emitOp('quox.proxmox.pool.configure', orgId, { changed: v.changed, values: fields }, actor);
    return saved;
  }

  async function warm(orgId, { force = false } = {}) {
    const out = { built: 0, failed: 0, errors: [], skipped: null };
    for (;;) {
      const cfg = store.getConfig(orgId);
      if (!cfg.enabled) { out.skipped = 'disabled'; return out; }
      // Backup window: never warm (ready VMs are still leased). A made-to-order lease is user-initiated and unaffected.
      if (!force && inBackupWindow(cfg.backup_window, now())) { out.skipped = `backup window ${cfg.backup_window} UTC`; return out; }
      const p = paused.get(orgId);
      if (p && p.until > now()) { out.skipped = `paused: needs approval ${p.approvalId}`; return out; }
      const rows = store.listVms(orgId);
      if (rows.some((v) => v.state === 'failed' && String(v.last_error || '').startsWith('needs approval'))) {
        out.skipped = 'paused: a failed VM is waiting on an approval'; return out;
      }
      const have = rows.filter((v) => v.state === 'ready' || v.state === 'building').length;
      if (have >= cfg.warm_target || rows.filter((v) => v.state !== 'failed').length >= cfg.max_pool) return out;
      try {
        await withLock(orgId, () => buildLocked(orgId, cfg, { cores: cfg.default_cores, mem_gb: cfg.default_mem_gb, disk_gb: cfg.default_disk_gb }));
        out.built += 1;
      } catch (e) {
        out.failed += 1; out.errors.push(e.message);
        return out; // first failure stops this warm pass: no hammering
      }
    }
  }

  /** Proxmox tags + description so a human in the Proxmox UI sees who holds the VM. Never throws, never fails the lease. */
  async function tagVm(orgId, cfg, vmid, { lessee, purpose, since, expires }) {
    let status;
    try {
      const r = await run(orgId, cfg, cmd.tag(cfg, vmid, `hyperion,pool,${lesseeTag(lessee)}`, leaseDescription({ lessee, purpose, since, expires })), `tag ${vmid}`, { retry: false });
      status = r.ok ? 'ok' : `failed: ${r.pending ? `needs approval ${r.approvalId}` : r.error}`.slice(0, 200);
    } catch (e) { status = `failed: ${e && e.message ? e.message : e}`.slice(0, 200); }
    if (status !== 'ok') log(`[ProxmoxPool] org=${orgId} vm=${vmid} tag ${status}`);
    store.updateVm(orgId, vmid, { tags_status: status });
  }

  /** The VM's ED25519 host key via the guest agent, so the lessee can pin it. A failed read says so; nothing is invented. */
  async function readHostKey(orgId, cfg, vmid) {
    let line = null; let fingerprint = null; let error = null;
    try {
      const r = await run(orgId, cfg, cmd.exec(cfg, vmid, HOST_KEY_SCRIPT), `read host key ${vmid}`, { retry: false });
      if (!r.ok) error = (r.pending ? `needs approval ${r.approvalId}` : r.error) || 'guest exec failed';
      else {
        const k = parseHostKey(r.stdout);
        if (k) { line = k.line; fingerprint = k.fingerprint; } else error = 'the guest returned no ssh-ed25519 host key';
      }
    } catch (e) { error = e && e.message ? e.message : String(e); }
    if (error) log(`[ProxmoxPool] org=${orgId} vm=${vmid} host key not read: ${error}`);
    store.updateVm(orgId, vmid, { host_key_line: line, host_key_fingerprint: fingerprint, host_key_error: error ? String(error).slice(0, 200) : null });
  }

  async function lease(orgId, req = {}, actor, opts = {}) {
    const cfg = store.getConfig(orgId);
    requireEnabled(cfg);
    const lessee = typeof req.lessee === 'string' ? req.lessee.trim() : '';
    if (!LESSEE_RE.test(lessee)) throw new PoolError('bad_request', 'lessee is required (1-80 printable characters)');
    const k = validatePubkey(req.ssh_pubkey);
    if (k.error) throw new PoolError('bad_request', k.error);
    const pick = (v, d, lo, hi, name) => {
      const n = v === undefined || v === null || v === '' ? d : Number(v);
      if (!isInt(n, lo, hi)) throw new PoolError('bad_request', `${name} must be an integer from ${lo} to ${hi}`);
      return n;
    };
    const size = {
      cores: pick(req.cores, cfg.default_cores, 1, 32, 'cores'),
      mem_gb: pick(req.memory_gb ?? req.mem_gb, cfg.default_mem_gb, 1, 128, 'memory_gb'),
      disk_gb: pick(req.disk_gb, cfg.default_disk_gb, TEMPLATE_DISK_GB, 500, 'disk_gb'),
    };
    const purpose = typeof req.purpose === 'string' ? req.purpose.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) : '';
    // A lease may ask for less time than the org allows (a one-case proof run wants 2h, not 24h), never more.
    const ttlH = pick(req.ttl_h, cfg.lease_ttl_h, 1, cfg.lease_ttl_h, 'ttl_h');
    const want = placementWant(cfg, req);

    let leasedAt = 0;
    const row = await withLock(orgId, async () => {
      const candidates = store.listVms(orgId)
        .filter((v) => v.state === 'ready' && (!want.node && !want.requireAvx2 || activeLanes(cfg).some((l) => l.node === v.node && laneWanted(l, want))) && v.cores >= size.cores && v.mem_gb >= size.mem_gb && v.disk_gb >= size.disk_gb)
        .sort((a, b) => (a.cores * a.mem_gb * a.disk_gb) - (b.cores * b.mem_gb * b.disk_gb) || a.vmid - b.vmid);
      // A warm VM can go dark after it was built (a lapsed DHCP lease left 9255/9256 agent-healthy but off the LAN).
      // Never hand one out: probe ssh first; an unreachable one is marked failed, the scheduler retires it.
      let fit = null;
      for (const c of candidates) {
        if (!probeSsh || !c.ip) { fit = c; break; }
        let up = false;
        try { up = await probeSsh(c.ip); } catch { up = false; }
        if (up) { fit = c; break; }
        await failVm(orgId, cfgForRow(cfg, c), c.vmid, new Error(`unreachable: ssh on ${c.ip} did not answer from the collector at lease time`), { destroy: false });
        emitOp('quox.proxmox.pool.unreachable', orgId, { vmid: c.vmid, ip: c.ip }, ACTOR_AGENT);
      }
      const vm = fit || await buildLocked(orgId, cfg, size, (vmid) => {
        // Made to order: record who it is for the moment the VMID is reserved so status shows it while building.
        store.updateVm(orgId, vmid, { lessee, purpose, ssh_pubkey_fp: k.ok.fp });
        if (opts.onReserved) opts.onReserved(vmid);
      }, want);
      // Leased only once the lessee's key is really in: status never shows a VM the lessee cannot ssh into
      // (WORKER1 2026-10-15, a slow auth service stretched the key install and it failed while "leased").
      // The org lock keeps any other lease off this VM meanwhile.
      store.updateVm(orgId, vm.vmid, { lessee, purpose, ssh_pubkey_fp: k.ok.fp });
      try {
        const out = must(await run(orgId, cfgForRow(cfg, vm), cmd.exec(cfg, vm.vmid, keyScript(cfg, k.ok.line)), `install lessee key on ${vm.vmid}`), `key install on ${vm.vmid}`);
        if (!out.includes('KEYED')) throw new PoolError('key_failed', `key install on ${vm.vmid} did not confirm`);
        const t = now();
        store.updateVm(orgId, vm.vmid, { state: 'leased', leased_at: t, lease_expires_at: t + ttlH * 3600000 });
        leasedAt = t;
      } catch (e) {
        if (CONTROL_PLANE_RE.test(e && e.message ? e.message : '')) {
          // 2026-10-15 17:37: four healthy warm VMs were destroyed this way in one minute. Put it back, fail the lease.
          store.updateVm(orgId, vm.vmid, { state: 'ready', lessee: null, purpose: null, ssh_pubkey_fp: null });
          emitOp('quox.proxmox.pool.lease', orgId, { vmid: vm.vmid, lessee, outcome: 'failed', error: 'auth_unavailable' }, actor || ACTOR_AGENT);
          throw new PoolError('auth_unavailable', `could not lease ${vm.vmid}: the auth service was slow or unreachable, so the key was not installed. The VM is still ready; try again in a moment.`);
        }
        await failVm(orgId, cfgForRow(cfg, vm), vm.vmid, e, { destroy: true });
        emitOp('quox.proxmox.pool.lease', orgId, { vmid: vm.vmid, lessee, ssh_pubkey_fp: k.ok.fp, outcome: 'failed', error: store.getVm(orgId, vm.vmid)?.last_error }, actor || ACTOR_AGENT);
        throw e;
      }
      // Best effort from here: a tag or host-key problem is reported on the lease and never fails it.
      await tagVm(orgId, cfgForRow(cfg, vm), vm.vmid, { lessee, purpose, since: new Date(leasedAt).toISOString(), expires: new Date(leasedAt + ttlH * 3600000).toISOString() });
      await readHostKey(orgId, cfgForRow(cfg, vm), vm.vmid);
      const cur = store.getVm(orgId, vm.vmid);
      await refreshIp(orgId, cur);
      return store.getVm(orgId, vm.vmid);
    });
    emitOp('quox.proxmox.pool.lease', orgId, {
      vmid: row.vmid, lessee, purpose, ssh_pubkey_fp: k.ok.fp, cores: row.cores, mem_gb: row.mem_gb, disk_gb: row.disk_gb,
      lease_expires_at: row.lease_expires_at, outcome: 'leased',
    }, actor || ACTOR_AGENT);
    scheduleWarm(orgId);
    return {
      vmid: row.vmid, name: row.name, node: row.node, ip: row.ip, user: cfg.guest_user,
      cores: row.cores, mem_gb: row.mem_gb, disk_gb: row.disk_gb, lessee, ssh_pubkey_fp: k.ok.fp,
      lease_expires_at: row.lease_expires_at,
      tags: row.tags_status,
      host_key_line: row.host_key_line, host_key_fingerprint: row.host_key_fingerprint, host_key_error: row.host_key_error,
      ...(row.ip_check_error ? { ip_stale: true } : {}),
      ssh: `ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new ${cfg.guest_user}@${row.ip}`,
    };
  }

  /**
   * REST variant: a warm VM is leased synchronously (returns { lease }); a made-to-order build
   * returns { building: { vmid, state:'building' } } as soon as the VMID is reserved and finishes
   * (build, key install, lease) in the background. The caller polls status.
   */
  async function leaseOrStart(orgId, req = {}, actor) {
    let reservedAt = null;
    let resolveReserved;
    const reserved = new Promise((r) => { resolveReserved = r; });
    const done = lease(orgId, req, actor, { onReserved: (vmid) => { reservedAt = vmid; resolveReserved(vmid); } });
    const bg = done.catch((e) => { if (reservedAt !== null) log(`[ProxmoxPool] org=${orgId} background lease of ${reservedAt} failed: ${e.message}`); throw e; });
    const first = await Promise.race([bg.then((l) => ({ lease: l })), reserved.then((vmid) => ({ vmid }))]);
    if (first.lease) return { lease: first.lease };
    const tracked = bg.catch(() => {}).finally(() => pendingWarms.delete(tracked));
    pendingWarms.add(tracked);
    return { building: { vmid: first.vmid, state: 'building' } };
  }

  async function releaseInternal(orgId, vmid, intent, actor, extra) {
    const cfg = store.getConfig(orgId);
    if (!Number.isInteger(vmid)) throw new PoolError('bad_request', 'vmid must be an integer');
    assertInRange(cfg, vmid);
    const row = store.getVm(orgId, vmid);
    if (!row) throw new PoolError('not_found', `${vmid} is not a pool VM`);
    if (row.state === 'building' && activeBuilds.has(`${orgId}:${vmid}`)) throw new PoolError('busy', `${vmid} is still being built`);
    await withLock(orgId, () => destroyLocked(orgId, cfgForRow(cfg, row), vmid, intent, { lessee: row.lessee, ...extra }));
    return { vmid, destroyed: true };
  }

  async function release(orgId, vmid, actor) {
    const r = await releaseInternal(orgId, vmid, 'quox.proxmox.pool.release', actor);
    scheduleWarm(orgId);
    return r;
  }

  /**
   * REST variant: answers at once. The VM is marked recycling immediately (so it can never be handed out
   * again), and the destroy runs in the background once the org lock is free. A full-clone build can hold
   * that lock for minutes; waiting on it made `quox vm pool done` outlive the client's 30s timeout.
   * A failed destroy lands as state failed + last_error (destroyLocked), visible in status.
   */
  function releaseStart(orgId, vmid, actor) {
    const cfg = store.getConfig(orgId);
    if (!Number.isInteger(vmid)) throw new PoolError('bad_request', 'vmid must be an integer');
    assertInRange(cfg, vmid);
    const row = store.getVm(orgId, vmid);
    if (!row) throw new PoolError('not_found', `${vmid} is not a pool VM`);
    if (row.state === 'building' && activeBuilds.has(`${orgId}:${vmid}`)) throw new PoolError('busy', `${vmid} is still being built`);
    if (row.state !== 'recycling') store.updateVm(orgId, vmid, { state: 'recycling' });
    const bg = release(orgId, vmid, actor).catch((e) => log(`[ProxmoxPool] org=${orgId} vm=${vmid} background release failed: ${e.message}`));
    const tracked = bg.finally(() => pendingWarms.delete(tracked));
    pendingWarms.add(tracked);
    return { vmid, state: 'recycling' };
  }

  /**
   * VMs built before the org went static still run DHCP, and a lapsed lease leaves them with no IPv4 at all
   * (offload worker 9253 and proving VM 9203, 2026-10-15). Move them onto the range: ready VMs always, leased
   * VMs only once they have gone dark, so a working address is never pulled from under a lessee. The guest
   * agent still answers without a network, so this also rescues a dark VM. Two per tick, 3 tries per VM.
   */
  async function migrateToStatic(orgId, cfg, out) {
    const dark = (v) => /no non-loopback IPv4/i.test(v.ip_check_error || '');
    const todo = store.listVms(orgId)
      .filter((v) => !store.getAllocatedIp(orgId, v.vmid) && (v.state === 'ready' || (v.state === 'leased' && dark(v))))
      .filter((v) => (staticMoveAttempts.get(`${orgId}:${v.vmid}`) || 0) < 3)
      .slice(0, 2);
    for (const v of todo) {
      const key = `${orgId}:${v.vmid}`;
      await withLock(orgId, async () => {
        const cur = store.getVm(orgId, v.vmid);
        if (!cur || store.getAllocatedIp(orgId, v.vmid) || !(cur.state === 'ready' || (cur.state === 'leased' && dark(cur)))) return;
        let ip = null;
        try {
          ip = await allocateStaticIp(orgId, cfg, v.vmid);
          const net = { ip, prefix: cfg.network.prefix, gateway: cfg.network.gateway, dns: cfg.network.dns };
          const res = must(await run(orgId, cfgForRow(cfg, cur), cmd.exec(cfg, v.vmid, staticNetScript(net)), `static address for ${v.vmid}`), `static move ${v.vmid}`);
          if (!res.includes('STATIC_OK')) throw new PoolError('static_failed', `static move ${v.vmid}: ${ip} did not come up`);
          store.updateVm(orgId, v.vmid, { ip, ip_check_error: null });
          staticMoveAttempts.delete(key);
          emitOp('quox.proxmox.pool.ip_changed', orgId, { vmid: v.vmid, old: cur.ip || null, new: ip, reason: 'static_migration' }, ACTOR_AGENT);
          out.ip_migrated = (out.ip_migrated || 0) + 1; out.noop = false;
        } catch (e) {
          if (ip) store.releaseIp(orgId, v.vmid);
          staticMoveAttempts.set(key, (staticMoveAttempts.get(key) || 0) + 1);
          out.failed += 1; out.noop = false;
          out.errors.push(/static move/.test(e.message) ? e.message : `static move ${v.vmid}: ${e.message}`);
          log(`[ProxmoxPool] org=${orgId} vm=${v.vmid} static move failed (${staticMoveAttempts.get(key)}/3): ${e.message}`);
        }
      });
    }
  }

  /** Scheduler pass for one org: sweep stale builds, reap expired leases, prune old tombstones, then warm. */
  async function maintain(orgId) {
    const out = { reaped: 0, built: 0, failed: 0, errors: [], noop: true, skipped: null };
    const cfg = store.getConfig(orgId);
    if (!cfg.enabled) { out.skipped = 'disabled'; return out; }
    const t = now();
    for (const v of store.listVms(orgId)) {
      if (v.state === 'leased') { await refreshIp(orgId, v); out.ip_refreshed = (out.ip_refreshed || 0) + 1; } // never fails the tick
    }
    if (isStatic(cfg)) await migrateToStatic(orgId, cfg, out);
    for (const v of store.listVms(orgId)) {
      if (v.state === 'building' && !activeBuilds.has(`${orgId}:${v.vmid}`) && t - v._updated_ms > STALE_BUILD_MS) {
        await withLock(orgId, () => failVm(orgId, cfgForRow(cfg, v), v.vmid, new Error('stale build (collector restarted mid-build?)'), { destroy: true }));
        out.failed += 1; out.errors.push(`vm ${v.vmid}: stale build retired`); out.noop = false;
      } else if (v.state === 'failed' && t - v._updated_ms > FAILED_RETENTION_MS) {
        if (!String(v.last_error || '').startsWith('needs approval')) {
          await run(orgId, cfgForRow(cfg, v), cmd.destroy(cfg, v.vmid), `retire ${v.vmid}`); // once, best effort
        }
        store.deleteVm(orgId, v.vmid);
        out.noop = false;
      } else if (v.state === 'failed' && !String(v.last_error || '').startsWith('needs approval') && !inBackupWindow(cfg.backup_window, t)) {
        // Failed builds are retired (destroyed) on the next tick, never left behind. Bounded: 3 attempts, then the 24h prune.
        const key = `${orgId}:${v.vmid}`;
        const tries = retireAttempts.get(key) || 0;
        if (tries < 3) {
          retireAttempts.set(key, tries + 1);
          out.noop = false;
          try { await releaseInternal(orgId, v.vmid, 'quox.proxmox.pool.reap', ACTOR_AGENT, { reason: 'retire failed build' }); retireAttempts.delete(key); out.retired = (out.retired || 0) + 1; } catch (e) { out.failed += 1; out.errors.push(`retire ${v.vmid}: ${e.message}`); }
        }
      } else if (v.state === 'leased' && v._lease_expires_ms && v._lease_expires_ms <= t) {
        out.noop = false;
        try {
          await releaseInternal(orgId, v.vmid, 'quox.proxmox.pool.reap', ACTOR_AGENT, { reason: 'lease expired' });
          out.reaped += 1;
        } catch (e) { out.failed += 1; out.errors.push(`reap ${v.vmid}: ${e.message}`); }
      }
    }
    const w = await warm(orgId);
    out.built = w.built; out.failed += w.failed; out.errors.push(...w.errors);
    if (w.built || w.failed) out.noop = false;
    if (w.skipped && w.skipped.startsWith('paused')) out.skipped = w.skipped;
    return out;
  }

  return {
    status, statusFresh, refreshIp, configure, warm, lease, leaseOrStart, release, maintain, scheduleWarm,
    isPaused: (orgId) => { const p = paused.get(orgId); return !!(p && p.until > now()); },
    idle: () => Promise.all([...pendingWarms]),
    releaseStart,
    _holdLockForTest: (orgId, fn) => withLock(orgId, fn),
    store,
  };
}

// ---------------------------------------------------------------------------
// Default (production) wiring: ssh_exec through the governed executeTool choke.
// ---------------------------------------------------------------------------

/** Free-RAM fraction (x10000) of a node from Prometheus, or null when unreachable / no sample. */
async function defaultFreeFraction(promUrl, node) {
  const q = `10000*node_memory_MemAvailable_bytes{instance="${node}"}/node_memory_MemTotal_bytes{instance="${node}"}`;
  const res = await fetch(`${promUrl.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const j = await res.json();
  const v = j && j.data && j.data.result && j.data.result[0] && j.data.result[0].value && j.data.result[0].value[1];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is anything answering on this address? A TCP connect to :22 and :80 (no root needed, no ARP tooling on the
 * collector): a completed connect OR a refusal (RST) both prove a live host; only silence counts as free.
 */
async function defaultProbeIp(ip, { ports = [22, 80], timeoutMs = 1500 } = {}) {
  const net = require('net');
  const one = (port) => new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', (err) => done(err && err.code === 'ECONNREFUSED'));
  });
  const res = await Promise.all(ports.map(one));
  return res.some(Boolean);
}

/** True only when sshd accepts a TCP connection on port 22 (a refused or silent port is not a usable worker). */
async function defaultProbeSsh(ip, { timeoutMs = 3000 } = {}) {
  const net = require('net');
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port: 22 });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** IPv4 addresses of the Bastion fleet registry; [] when Bastion is not configured, throws when unreachable. */
async function defaultListFleetIps() {
  const url = process.env.BASTION_URL || '';
  const token = process.env.BASTION_API_TOKEN || '';
  if (!url || !token) return [];
  const r = await fetch(`${url.replace(/\/+$/, '')}/api/v1/hosts`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`bastion hosts HTTP ${r.status}`);
  const d = await r.json();
  const hosts = Array.isArray(d) ? d : (d.hosts || d.data || []);
  const ips = [];
  for (const h of hosts) {
    if (!h || typeof h !== 'object') continue;
    for (const k of ['ip', 'address', 'host', 'ip_address', 'hostname']) if (typeof h[k] === 'string' && IPV4_RE.test(h[k])) ips.push(h[k]);
  }
  return ips;
}

/** Default guest-agent read: REST pveGet first, Bastion pvesh-read builtin fallback (shared readJson path). */
async function defaultReadAgentInterfaces({ orgId, node, vmid }) {
  const { readJson } = require('./toolExecutors/proxmox.js');
  const path = `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`;
  const src = await readJson(
    (host, command) => defaultRunTool({ orgId, host, command, reason: `pool guest-agent ip check ${vmid}` }),
    { host: node, opts: { orgId }, label: `guest agent interfaces for ${vmid}`, restPath: path, restQuery: undefined,
      bastionRead: { path }, pvesh: `pvesh get ${path} --output-format json` },
  );
  if (src.error) throw new Error(src.error.error || src.error.message || 'guest agent read failed');
  return src.data;
}

let _default = null;
let _emitter = () => {};

function setEmitter(fn) { _emitter = typeof fn === 'function' ? fn : () => {}; }

function defaultEmit(intent, orgId, payload, actor) {
  _emitter({
    type: 'event',
    from: actor && actor !== ACTOR_AGENT ? `human.${actor}` : `agent.${ACTOR_AGENT}`,
    to: 'system.proxmox_pool',
    intent,
    corr: payload.rehearsal_id ? `rehearsal:${payload.rehearsal_id}` : payload.vmid !== undefined ? `pool:${payload.vmid}` : `pool:${orgId}`,
    payload: { orgId, org_id: orgId, ...payload },
  });
}

async function defaultRunTool({ orgId, host, command, reason }) {
  const { executeTool } = require('./agentTools.js');
  return executeTool('ssh_exec', { host, command, reason }, {
    agentId: ACTOR_AGENT, orgId, userId: 'system.proxmox-pool', conversationId: `proxmox-pool:${orgId}`,
    // a guest bootstrap outruns the default 30s Bastion budget under load; Bastion itself caps exec at 60s
    bastionTimeoutMs: 58000,
  });
}

function getPool() {
  if (!_default) _default = createPool({ runTool: defaultRunTool, emit: (...a) => defaultEmit(...a), probeSsh: defaultProbeSsh });
  return _default;
}

module.exports = {
  createPool, getPool, setEmitter, PoolError, validatePubkey, validateConfig, assertInRange, inBackupWindow, errorText, defaultFreeFraction,
  bootstrapScript, keyScript, lesseeTag, leaseDescription, parseHostKey, cmd, validateNetwork, rangeAddresses, parseGuestIps, defaultProbeIp, defaultProbeSsh, parseQmList, governedRun, isDenied, defaultRunTool, defaultEmit, APPROVAL_PAUSE_MS, parseGuestIp, NAME_PREFIX, ACTOR_AGENT,
};
