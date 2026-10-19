/**
 * Shared engine behind `quox vm` and the QUOXON `/vm` command: drives the
 * HYPERION (agent id atlas) Proxmox tools through the governed tool route
 * (POST /api/v1/tools/execute). Pure functions over an injected `exec(tool, input)`
 * so the CLI group and the TUI share one implementation and one set of tests.
 *
 * Tool names/inputs are the contract with the server side:
 *   proxmox_vms, proxmox_containers, proxmox_vm_resources, proxmox_vm_action,
 *   proxmox_vm_snapshot, proxmox_vm_resolve {name|vmid}, proxmox_pool_status,
 *   proxmox_pool_lease, proxmox_pool_release, proxmox_pool_configure,
 *   proxmox_node_power, proxmox_rehearse {vmid, node, command, checks?, keep_twin?} (starts, returns {rehearsal_id, state:'running'}),
 *   proxmox_rehearsal_status {rehearsal_id}.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { resolveEndpoint } from '../api/endpoints.js';

export const VM_ACTIONS = ['start', 'stop', 'reboot', 'shutdown'];
export const NODE_ACTIONS = ['reboot', 'shutdown'];

/** A write was held for a human. Callers print the hint and never re-submit. */
export class VmPendingError extends Error {
  constructor(tool, data) {
    super(`${tool} is awaiting approval`);
    this.name = 'VmPendingError';
    this.tool = tool;
    this.approvalId = data?.approvalId || data?.approval_id || data?._approval?.id || null;
    this.inboxItemId = data?.inbox_item_id || null;
    this.rehearsalId = data?.rehearsal_id || null;
  }
}

export function pendingHint(e) {
  const id = e.approvalId || e.inboxItemId;
  if (!id) return `${e.tool} is awaiting approval. Check: quox approvals`;
  return `${e.tool} is awaiting approval (approval id ${id}). After a human approves, run: quox approvals result ${id}`;
}

/**
 * DEVFLEET-READ: HYPERION (atlas) is granted ONE read tool, proxmox_read, not the per-view read
 * tools. Callers keep using the old names; the wire call is proxmox_read with the matching view.
 * Writes (proxmox_vm_action, _snapshot, _rehearse, _vm_doctor, pool lease/release/config) pass through.
 */
export const PROXMOX_READ_VIEW_OF = {
  proxmox_vms: 'vms', proxmox_containers: 'containers', proxmox_cluster_status: 'cluster',
  proxmox_ha_status: 'ha', proxmox_templates_list: 'templates', proxmox_storage: 'storage',
  proxmox_node_resources: 'node', proxmox_vm_resources: 'vm', proxmox_snapshots_list: 'snapshots',
  proxmox_backup_status: 'backups', proxmox_vm_resolve: 'resolve', proxmox_pool_status: 'pool',
  proxmox_rehearsal_status: 'rehearsal', proxmox_doctor_report: 'doctor_report',
};

// Tools that fan out many Proxmox reads server-side and outlive the client's 30s default.
// VM Doctor runs 12 reads in parallel; over Bastion pvesh on a slow node that is ~30s.
export const SLOW_TOOL_TIMEOUT_MS = { proxmox_vm_doctor: 120000, proxmox_snapshots_list: 90000 };

/** Build an exec(tool, input) over an API client. Throws VmPendingError on a held call. */
export function makeExec({ client, orgId }) {
  return async function exec(tool, input = {}) {
    const ep = resolveEndpoint('v1.tools.execute');
    // HYPERION (atlas) owns these tools; without agent_id the call lands on the
    // orchestrator, which is not granted them. An attach token's agent claim still wins server-side.
    const view = PROXMOX_READ_VIEW_OF[tool];
    const body = view ? { tool_name: 'proxmox_read', input: { view, ...input }, agent_id: 'atlas' } : { tool_name: tool, input, agent_id: 'atlas' };
    if (orgId) body.org_id = orgId;
    const timeout = SLOW_TOOL_TIMEOUT_MS[tool];
    let data = await client.post(ep.path, { service: ep.service, body, ...(timeout ? { timeout } : {}) });
    // The caller's own token identity wins over agent_id server-side (e.g. an attached session runs
    // as itself, which holds the legacy reads like proxmox_vms but not proxmox_read). When proxmox_read
    // is not granted to that identity, retry once with the legacy per-view tool it does hold.
    if (view && data && data.success === false && /not granted/i.test(String(data.error || ''))) {
      const legacy = { tool_name: tool, input, agent_id: 'atlas' };
      if (orgId) legacy.org_id = orgId;
      data = await client.post(ep.path, { service: ep.service, body: legacy });
    }
    if (data && data.pending) throw new VmPendingError(tool, data);
    if (data && data.success === false) {
      const err = new Error(`${tool} via POST ${ep.path} returned success:false: ${data.error || 'unknown error'}`);
      err.toolError = data.error || 'unknown error';
      err.tool = tool;
      throw err;
    }
    return data;
  };
}

/** The tool's payload, whatever envelope it came wrapped in. */
export function payloadOf(data) {
  let p = data;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const k of ['result', 'output', 'data']) {
      if (p[k] !== undefined && p[k] !== null) { p = p[k]; break; }
    }
  }
  if (typeof p === 'string') { try { return JSON.parse(p); } catch { return p; } }
  return p;
}

function arrayOf(p, ...keys) {
  if (Array.isArray(p)) return p;
  for (const k of [...keys, 'items', 'results', 'resources']) if (Array.isArray(p?.[k])) return p[k];
  return [];
}

const normVm = (v, fallbackType) => ({
  vmid: Number(v.vmid ?? v.id),
  name: v.name ?? v.hostname ?? '',
  node: v.node ?? null,
  type: v.type === 'lxc' || v.type === 'qemu' ? v.type : (fallbackType || 'qemu'),
  status: v.status ?? v.state ?? '',
  raw: v,
});

const isUnknownTool = (e) => e?.status === 404
  || /unknown tool|tool .*not (found|available|registered)|no such tool|unsupported tool|not implemented/i.test(e?.toolError || e?.message || '');

export async function listVms(exec, { node, type } = {}) {
  if (type && !['qemu', 'lxc'].includes(type)) throw new Error('--type must be qemu or lxc');
  const out = [];
  if (type !== 'lxc') {
    const p = payloadOf(await exec('proxmox_vms', node ? { node } : {}));
    for (const v of arrayOf(p, 'vms')) out.push(normVm(v, 'qemu'));
  }
  if (type === 'lxc') {
    const p = payloadOf(await exec('proxmox_containers', node ? { node } : {}));
    for (const v of arrayOf(p, 'containers', 'lxc')) out.push(normVm(v, 'lxc'));
  }
  return node ? out.filter((v) => !v.node || v.node === node) : out;
}

/**
 * name|vmid -> { vmid, node, type, name }. Tool proxmox_vm_resolve first; if the server
 * does not know it, fall back to client-side exact match over proxmox_vms + proxmox_containers.
 * Ambiguity is an error listing candidates; never a guess.
 */
export async function resolveTarget(exec, target) {
  const t = String(target ?? '').trim();
  if (!t) throw new Error('a VM name or vmid is required');
  const numeric = /^\d+$/.test(t);
  const input = numeric ? { vmid: Number(t) } : { name: t };
  let matches = null;
  try {
    const p = payloadOf(await exec('proxmox_vm_resolve', input));
    const list = Array.isArray(p) ? p : (p?.matches || p?.candidates || (p && (p.vmid !== undefined || p.id !== undefined) ? [p] : []));
    matches = list.map((v) => normVm(v));
    if (!matches.length) throw new Error(`no VM matches "${t}" (proxmox_vm_resolve)`);
  } catch (e) {
    if (e instanceof VmPendingError || !isUnknownTool(e)) throw e;
    matches = null;
  }
  if (matches === null) {
    const all = await listVms(exec, {});
    try { all.push(...await listVms(exec, { type: 'lxc' })); } catch (e) { if (e instanceof VmPendingError) throw e; /* containers are optional */ }
    matches = all.filter((v) => (numeric ? v.vmid === Number(t) : v.name === t));
    if (!matches.length) throw new Error(`no VM matches "${t}" (checked proxmox_vms and proxmox_containers; exact name match only)`);
  }
  if (matches.length > 1) {
    const lines = matches.map((v) => `  ${v.vmid}  ${v.name}  ${v.node || '?'}  ${v.type}`).join('\n');
    throw new Error(`"${t}" is ambiguous, ${matches.length} candidates (use the vmid):\n${lines}`);
  }
  const m = matches[0];
  if (!m.node) throw new Error(`could not determine the node for "${t}" (vmid ${m.vmid})`);
  return { vmid: m.vmid, node: m.node, type: m.type, name: m.name };
}

const withReason = (input, reason) => (reason ? { ...input, _reason: reason } : input);

export async function vmInfo(exec, target) {
  const vm = await resolveTarget(exec, target);
  const data = await exec('proxmox_vm_resources', { vmid: vm.vmid, node: vm.node, type: vm.type });
  return { vm, resources: payloadOf(data) };
}

export async function vmAction(exec, action, target, { reason } = {}) {
  if (!VM_ACTIONS.includes(action)) throw new Error(`action must be one of ${VM_ACTIONS.join(', ')}`);
  const vm = await resolveTarget(exec, target);
  const data = await exec('proxmox_vm_action', withReason({ vmid: vm.vmid, node: vm.node, action, type: vm.type }, reason));
  return { vm, result: payloadOf(data) };
}

export async function vmSnapshot(exec, target, { name, reason } = {}) {
  const vm = await resolveTarget(exec, target);
  // proxmox_vm_snapshot requires snapname (Proxmox: letter first, then [A-Za-z0-9_-]).
  const snapname = name || `quox-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(snapname)) throw new Error('snapshot name must start with a letter and use only letters, digits, _ or -');
  const input = { vmid: vm.vmid, node: vm.node, snapname };
  const data = await exec('proxmox_vm_snapshot', withReason(input, reason));
  return { vm, result: payloadOf(data) };
}

/**
 * `url:http://127.0.0.1:8080/health` | `unit:nginx` | `cmd:test -f /etc/x` -> a proxmox_rehearse check.
 * Only the shape is checked here; the server validates the characters strictly.
 */
export function parseCheck(spec) {
  const m = /^(url|unit|cmd):(.+)$/.exec(String(spec ?? '').trim());
  if (!m) throw new Error(`--check must look like url:http://127.0.0.1:PORT/path, unit:NAME or cmd:COMMAND (got "${spec}")`);
  if (m[1] === 'url') return { type: 'url', url: m[2] };
  if (m[1] === 'unit') return { type: 'unit', name: m[2] };
  return { type: 'cmd', run: m[2] };
}

/** Start a rehearsal on a network-isolated twin of the VM (HYPERION proxmox_rehearse). Returns at once; the run takes minutes (a full disk copy). */
export async function vmRehearse(exec, target, command, { checks = [], keepTwin = false } = {}) {
  const c = String(command ?? '').trim();
  if (!c) throw new Error('a command is required after --');
  if (c.includes("'")) throw new Error('the command may not contain single quotes (it runs inside bash -c, use double quotes)');
  const vm = await resolveTarget(exec, target);
  const input = { vmid: vm.vmid, node: vm.node, command: c };
  if (checks.length) input.checks = checks.map(parseCheck);
  if (keepTwin) input.keep_twin = true;
  let data;
  try { data = await exec('proxmox_rehearse', input); } catch (e) {
    // The rehearsal needs ONE human approval (the card lists every host command). The proposal exists and
    // the run starts by itself once approved, so hand back the id instead of failing.
    if (e instanceof VmPendingError && e.rehearsalId) {
      return { vm, result: { rehearsal_id: e.rehearsalId, state: 'awaiting_approval', approval_id: e.approvalId, inbox_item_id: e.inboxItemId, hint: pendingHint(e) } };
    }
    throw e;
  }
  return { vm, result: payloadOf(data) };
}

export const REHEARSAL_POLL_MS = 10000;
export const REHEARSAL_TIMEOUT_MS = 50 * 60 * 1000;

/** Poll proxmox_rehearsal_status until the rehearsal is done (awaiting_approval and running both keep waiting). Throws on timeout (the id stays valid for a later look). */
export async function waitRehearsal(exec, rehearsalId, { intervalMs = REHEARSAL_POLL_MS, timeoutMs = REHEARSAL_TIMEOUT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onTick } = {}) {
  if (!/^RH_[0-9A-F]{16}$/.test(String(rehearsalId || ''))) throw new Error('the server did not return a rehearsal id');
  const t0 = Date.now();
  for (;;) {
    const rec = payloadOf(await exec('proxmox_rehearsal_status', { rehearsal_id: rehearsalId }));
    const r = rec?.rehearsal || rec;
    if (r && r.state === 'done') return r;
    if (Date.now() - t0 > timeoutMs) throw new Error(`rehearsal ${rehearsalId} is still running after ${Math.round(timeoutMs / 60000)} minutes; check later with the proxmox_rehearsal_status tool`);
    if (onTick) onTick(r);
    await sleep(intervalMs);
  }
}

/** Human REST surface for the pool. */
export function makePoolRest({ client }) {
  const call = (name, params, body, timeout) => {
    const ep = resolveEndpoint(name, params);
    const m = ep.method.toLowerCase();
    const t = timeout ? { timeout } : {};
    return m === 'get' ? client.get(ep.path, { service: ep.service, ...t }) : client[m](ep.path, { service: ep.service, body: body || {}, ...t });
  };
  return {
    status: () => call('v1.proxmox.pool'),
    configure: (body) => call('v1.proxmox.pool.config.put', {}, body),
    // A warm lease probes ssh, installs the key and refreshes the IP; a slow auth service stretches that past 30s.
    lease: (body) => call('v1.proxmox.pool.lease', {}, body, 180000),
    release: (vmid) => call('v1.proxmox.pool.release', { vmid }),
  };
}

export async function poolStatus(rest) {
  return rest.status();
}

export function defaultLessee(env = process.env) {
  return env.QUOX_SESSION || os.hostname();
}

/** --pubkey-file, else ~/.ssh/id_ed25519.pub when present, else a clear error. Reads the PUBLIC key only. */
export function readPubkey(file, { home = os.homedir() } = {}) {
  const f = file || path.join(home, '.ssh', 'id_ed25519.pub');
  if (!file && !fs.existsSync(f)) throw new Error('no ssh public key: pass --pubkey-file <path> (default ~/.ssh/id_ed25519.pub was not found)');
  let txt;
  try { txt = fs.readFileSync(f, 'utf8').trim(); } catch (e) { throw new Error(`cannot read public key ${f}: ${e.message}`); }
  if (!/^(ssh-|ecdsa-|sk-)/.test(txt)) throw new Error(`${f} does not look like an SSH public key (refusing to send it)`);
  return txt;
}

export async function poolLease(rest, { lessee, pubkey, cores, memoryGb, diskGb, ttlH, purpose, avx, node } = {}) {
  const input = { lessee: lessee || defaultLessee(), ssh_pubkey: pubkey };
  if (cores != null) input.cores = Number(cores);
  if (memoryGb != null) input.memory_gb = Number(memoryGb);
  if (diskGb != null) input.disk_gb = Number(diskGb);
  if (ttlH != null) input.ttl_h = Number(ttlH);
  if (purpose) input.purpose = purpose;
  if (avx) input.require_avx2 = true;   // hyp-07 is the only AVX2 node here; the server errors if no lane can take it
  if (node) input.node = node;
  return rest.lease(input);   // 201 {lease} when a warm VM fits, 202 {vmid,state:'building'} when built to order
}

/** Host key lines for a returned lease: the fingerprint to compare, and a ready known_hosts line. Never invents a key. */
export function poolHostKeyLines(p) {
  const l = p && p.lease;
  if (!l || typeof l !== 'object') return [];
  if (l.host_key_line && l.host_key_fingerprint) {
    return [`Host key ${l.host_key_fingerprint}`, 'known_hosts line:', `${l.ip} ${l.host_key_line}`];
  }
  return [`host key not read: ${l.host_key_error || 'the server returned none'}`];
}

export async function poolDone(rest, vmid) {
  if (!/^\d+$/.test(String(vmid ?? ''))) throw new Error('vmid must be a number');
  return rest.release(Number(vmid));
}

export async function poolConfig(rest, input = {}) {
  return rest.configure(input);
}

export async function nodePower(exec, action, node, { reason } = {}) {
  if (!NODE_ACTIONS.includes(action)) throw new Error(`node action must be one of ${NODE_ACTIONS.join(', ')}`);
  if (!node) throw new Error('a node name is required');
  // The proxmox_node_power tool is not built yet. Fail loudly instead of calling a missing tool.
  void exec; void reason;
  throw new Error('node power (reboot, shutdown) is not built yet; there is no proxmox_node_power tool');
}

/** Plain-text lines for a VM list. */
export function vmListLines(vms) {
  if (!vms.length) return ['No VMs found.'];
  return vms.map((v) => `${String(v.vmid).padEnd(6)} ${String(v.name).padEnd(28)} ${String(v.node || '?').padEnd(8)} ${String(v.type).padEnd(5)} ${v.status}`);
}

export function textOf(p) {
  if (p === undefined || p === null) return 'done';
  return typeof p === 'string' ? p : JSON.stringify(p, null, 2);
}

/**
 * VM Doctor (DEVFLEET-DOCTOR): read-only diagnosis. The server resolves the name or vmid itself
 * (proxmox_vm_doctor), so the target goes straight through. -> the report object.
 */
export async function vmDoctor(exec, target) {
  const t = String(target ?? '').trim();
  if (!t) throw new Error('a VM name or vmid is required');
  const p = payloadOf(await exec('proxmox_vm_doctor', { target: t }));
  if (!p || typeof p !== 'object' || !Array.isArray(p.findings)) throw new Error('proxmox_vm_doctor returned no report');
  return p;
}

const SEV_LABEL = { critical: 'CRITICAL', warning: 'WARNING', info: 'INFO' };
const showVal = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v));

/** Human lines for a doctor report: verdict, each finding (cause / evidence / fix), then gaps. */
export function doctorLines(report) {
  const vm = report.vm || {};
  const lines = [`VERDICT  ${String(report.verdict || 'unknown').toUpperCase()}  ${vm.name || vm.vmid} (vmid ${vm.vmid} on ${vm.node}, ${vm.status || 'unknown'})`];
  if (!report.findings.length) lines.push('No problems found in what could be read.');
  for (const f of report.findings) {
    lines.push('', `${SEV_LABEL[f.severity] || String(f.severity).toUpperCase()}  ${f.title}: ${f.cause}`);
    for (const e of f.evidence || []) {
      lines.push(`  evidence: ${e.metric} = ${showVal(e.value)} (threshold ${showVal(e.threshold)}, ${e.window}, ${e.source})`);
    }
    lines.push(`  fix: ${f.fix && f.fix.text}`);
    if (f.fix && f.fix.action) lines.push(`  gated action: ${f.fix.action.tool} ${JSON.stringify(f.fix.action.input)} (asks for approval; not run)`);
  }
  if (report.gaps && report.gaps.length) {
    lines.push('', 'Could not check:');
    for (const g of report.gaps) lines.push(`  ${g}`);
  }
  if (report.report_id) lines.push('', `report ${report.report_id}`);
  return lines;
}
