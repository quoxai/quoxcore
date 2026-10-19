/**
 * Proxmox Tool Executor
 *
 * Native executor for proxmox_vms, proxmox_containers, proxmox_cluster_status,
 * proxmox_storage, and proxmox_vm_action tools.
 * Replaces proxmox-*.json n8n workflows.
 *
 * DEVFLEET-A2: READ executors go over the Proxmox REST API first
 * (lib/proxmoxApi.js, vault token), because raw Bastion `pvesh` always 403s
 * with approval_required. Only when the REST API is NOT configured do they
 * fall back to the original Bastion `pvesh` path (unchanged). Any other REST
 * failure (HTTP status, TLS mismatch, timeout, lease block) is reported as an
 * error, never silently retried over Bastion and never treated as data.
 * Write operations (action/snapshot/clone) stay on Bastion behind approval.
 */

const proxmoxApi = require('../proxmoxApi.js');
const PVE_VMS_MEM_NOTE = 'mem_incl_cache_pct is a percent of allocated RAM as Proxmox measures it (host-side, or total minus MemFree with a balloon): it includes the guest page cache, so it is NOT memory in use and NOT pressure; never multiply it by maxmem as GB used. Proxmox has no in-use figure for a guest (a balloon report is total minus MemFree, also cache-inclusive; proxmox_read view=vm says the same): check inside the guest before calling a VM hot or at risk.';
const { runSafeRead } = require('../bastionSafeRead.js');

/**
 * Read a JSON document: REST first, Bastion `pvesh` fallback on not_configured or a refused token (401/403).
 * @param {Function} callBastion
 * @param {object} o { host, restPath, restQuery, pvesh (bastion command), label, opts }
 *   opts: { orgId, pveGet } (pveGet injectable for tests)
 * @returns {Promise<{data:any, via:'rest'|'bastion', rest_error?:string}|{error:object}>}
 */
async function readJson(callBastion, o) {
  const pveGet = (o.opts && o.opts.pveGet) || proxmoxApi.pveGet;
  let restError = null;
  try {
    const data = await pveGet(o.restPath, o.restQuery, { orgId: o.opts && o.opts.orgId });
    if (o.expect === 'array' && !Array.isArray(data)) {
      return { error: { success: false, error: `Proxmox API returned an unexpected shape for ${o.label}`, code: 'bad_response' } };
    }
    return { data, via: 'rest' };
  } catch (err) {
    if (!proxmoxApi.restFallsBack(err)) {
      return { error: {
        success: false,
        error: `Proxmox API read failed: ${(err && err.message) || 'unknown error'}`,
        code: (err && err.code) || 'pve_error',
        ...(err && err.status ? { status: err.status } : {}),
      } };
    }
    restError = proxmoxApi.restFallbackNote(err);
    if (restError) console.warn(`[ProxmoxApi] REST read ${o.label || o.restPath} refused (HTTP ${err.status}); falling back to Bastion`);
  }
  const tag = (r) => (restError && r && r.data !== undefined ? { ...r, rest_error: restError } : r);
  // Not configured (or token refused): Bastion. DEVFLEET-BUILTINS: the pvesh-read builtin first (RiskTier safe,
  // never hits the approval gate); the raw `pvesh get` runs only if Bastion does not know the
  // tool. No `|| echo '[]'` fold: a pvesh failure is an error, never an empty list.
  const result = o.bastionRead
    ? await runSafeRead('pvesh-read', o.host, o.bastionRead, () => callBastion(o.host, o.pvesh), { toolRun: o.opts && o.opts.toolRun })
    : await callBastion(o.host, o.pvesh);
  // AGENT-OVERHAUL TDD Wave C fix (error-body-as-data): a failed bastion
  // call must never be treated as data just because .output/.stdout happens
  // to be non-empty (or even valid JSON, e.g. "[]"). Check result.success
  // alone. See proxmoxReadTools.test.js.
  if (!result.success) return { error: result };
  const raw = result.output || result.stdout || o.emptyJson;
  if (!raw || !String(raw).trim()) {
    // A SUCCESSFUL pvesh (exit 0) on a list endpoint prints nothing when there is nothing to list
    // (seen live 2026-10-15: /cluster/resources --type lxc on a cluster with no containers). That is
    // an honest empty list. A failed call never reaches here (checked above), so this is not a fold.
    if (o.expect === 'array' && (result.exit_code === 0 || result.exit_code === undefined)) return tag({ data: [], via: 'bastion' });
    return { error: { success: false, error: `Empty response from Bastion pvesh for ${o.label}` } };
  }
  try {
    return tag({ data: JSON.parse(raw), via: 'bastion' });
  } catch {
    return { error: { success: false, error: `Failed to parse ${o.label}`, raw: raw.substring(0, 500) } };
  }
}

/**
 * proxmox_vms — list QEMU virtual machines across the cluster
 */
async function proxmoxVms(callBastion, input, opts = {}) {
  const host = input.host || 'hyp-01';
  const src = await readJson(callBastion, {
    host, opts, expect: 'array', label: 'Proxmox VM data',
    restPath: '/cluster/resources', restQuery: { type: 'vm' },
    bastionRead: { path: '/cluster/resources', type: 'vm' },
    pvesh: `pvesh get /cluster/resources --type vm --output-format json`,
  });
  if (src.error) return src.error;
  const vms = src.data;

  const formattedVMs = vms
    .filter(vm => vm.type === 'qemu')
    .map(vm => ({
      vmid: vm.vmid,
      name: vm.name || `VM ${vm.vmid}`,
      node: vm.node,
      status: vm.status,
      cpu: vm.cpu ? (vm.cpu * 100).toFixed(1) : '0',
      // QUOXON 2026-10-17 live: a bare `mem` percent was multiplied by maxmem and read back as GB "in use".
      // The field name says what it is: Proxmox's figure, which includes the guest page cache.
      mem_incl_cache_pct: vm.mem && vm.maxmem ? ((vm.mem / vm.maxmem) * 100).toFixed(1) : '0',
      maxmem: vm.maxmem,
      disk: vm.disk,
      maxdisk: vm.maxdisk,
      maxcpu: vm.maxcpu,
      uptime: vm.uptime || 0,
      type: 'qemu'
    }))
    .sort((a, b) => a.vmid - b.vmid);

  return {
    success: true,
    ...(src.rest_error ? { rest_error: src.rest_error } : {}),
    host,
    vms: formattedVMs,
    count: formattedVMs.length,
    // QUOXON 2026-10-17: mem here is the /cluster/resources figure. For a VM without a balloon report
    // it is host-side (the QEMU process) and counts the guest's page cache: a dev VM read 97% while
    // `free -g` inside it said 45 of 191 GB used. Say so, so it is never presented as pressure.
    mem_note: PVE_VMS_MEM_NOTE
  };
}

/**
 * proxmox_templates_list — read-only golden-clone catalogue.
 *
 * Product model (AGENT-OVERHAUL-3, QuoxPlan notes #2332/#2333): the template
 * catalogue IS a live read of Proxmox VMs flagged template:1 in Proxmox
 * itself (the operator marks a VM a template, e.g. `qm template <vmid>`).
 * Quox never creates templates — it only reads the flag and provisions FROM
 * them via proxmox_vm_clone. Reuses the exact same callBastion/pvesh egress
 * path as proxmoxVms() above — no new egress path introduced.
 */
async function proxmoxTemplatesList(callBastion, input, opts = {}) {
  const host = input.host || input.node || 'hyp-01';
  const src = await readJson(callBastion, {
    host, opts, expect: 'array', label: 'Proxmox VM data',
    restPath: '/cluster/resources', restQuery: { type: 'vm' },
    bastionRead: { path: '/cluster/resources', type: 'vm' },
    pvesh: `pvesh get /cluster/resources --type vm --output-format json`,
  });
  if (src.error) return src.error;
  const vms = src.data;

  const templateVms = vms.filter(vm => vm.type === 'qemu' && (vm.template === 1 || vm.template === true));

  // Best-effort per-template description lookup (cluster/resources doesn't
  // carry notes/description — that lives on the VM's own config). A failed
  // lookup for one template must never drop it from the catalogue.
  const templates = await Promise.all(templateVms.map(async (vm) => {
    let description = '';
    try {
      let cfg;
      if (src.via === 'rest') {
        const pveGet = opts.pveGet || proxmoxApi.pveGet;
        cfg = await pveGet(`/nodes/${vm.node}/qemu/${vm.vmid}/config`, undefined, { orgId: opts.orgId });
      } else {
        const cfgCmd = `pvesh get /nodes/${vm.node}/qemu/${vm.vmid}/config --output-format json`;
        const cfgResult = await runSafeRead('pvesh-read', vm.node, { path: `/nodes/${vm.node}/qemu/${vm.vmid}/config` },
          () => callBastion(vm.node, cfgCmd), { toolRun: opts.toolRun });
        // best-effort: a failed lookup yields '' via the surrounding catch, never a dropped template
        if (cfgResult.success === false) throw new Error('config lookup failed');
        const cfgRaw = cfgResult.output || cfgResult.stdout || '{}';
        cfg = JSON.parse(cfgRaw);
      }
      description = cfg.description || cfg.notes || '';
    } catch {
      description = '';
    }
    return {
      vmid: vm.vmid,
      name: vm.name || `Template ${vm.vmid}`,
      node: vm.node,
      description,
      cores: vm.maxcpu != null ? vm.maxcpu : null,
      memory: vm.maxmem != null ? vm.maxmem : null
    };
  }));

  return {
    success: true,
    ...(src.rest_error ? { rest_error: src.rest_error } : {}),
    host,
    templates,
    count: templates.length
  };
}

/**
 * proxmox_containers — list LXC containers across the cluster
 */
async function proxmoxContainers(callBastion, input, opts = {}) {
  const host = input.host || 'hyp-01';
  const src = await readJson(callBastion, {
    host, opts, expect: 'array', label: 'Proxmox container data',
    restPath: '/cluster/resources', restQuery: { type: 'vm' },
    bastionRead: { path: '/cluster/resources', type: 'lxc' },
    pvesh: `pvesh get /cluster/resources --type lxc --output-format json`,
  });
  if (src.error) return src.error;
  const containers = src.data;

  const formattedCTs = containers
    .filter(ct => ct.type === 'lxc')
    .map(ct => ({
      vmid: ct.vmid,
      name: ct.name || `CT ${ct.vmid}`,
      node: ct.node,
      status: ct.status,
      cpu: ct.cpu ? (ct.cpu * 100).toFixed(1) : '0',
      mem: ct.mem && ct.maxmem ? ((ct.mem / ct.maxmem) * 100).toFixed(1) : '0',
      maxmem: ct.maxmem,
      disk: ct.disk,
      maxdisk: ct.maxdisk,
      uptime: ct.uptime || 0,
      type: 'lxc'
    }))
    .sort((a, b) => a.vmid - b.vmid);

  return {
    success: true,
    ...(src.rest_error ? { rest_error: src.rest_error } : {}),
    host,
    containers: formattedCTs,
    count: formattedCTs.length
  };
}

/**
 * proxmox_cluster_status — cluster overview with node states
 */
async function proxmoxCluster(callBastion, input, opts = {}) {
  const host = input.host || 'hyp-01';
  const src = await readJson(callBastion, {
    host, opts, expect: 'array', label: 'Proxmox cluster data',
    restPath: '/cluster/status',
    bastionRead: { path: '/cluster/status' },
    pvesh: `pvesh get /cluster/status --output-format json`,
  });
  if (src.error) return src.error;
  const statusArray = src.data;

  const clusterInfo = statusArray.find(s => s.type === 'cluster') || {};
  const nodes = statusArray.filter(s => s.type === 'node').map(n => ({
    name: n.name,
    id: n.nodeid,
    ip: n.ip,
    online: n.online,
    level: n.level,
    local: n.local
  }));

  return {
    success: true,
    ...(src.rest_error ? { rest_error: src.rest_error } : {}),
    host,
    status: {
      name: clusterInfo.name || 'Proxmox Cluster',
      version: clusterInfo.version,
      quorate: clusterInfo.quorate,
      nodes
    }
  };
}

/**
 * proxmox_storage — cluster storage resources with usage percentages
 */
async function proxmoxStorage(callBastion, input, opts = {}) {
  const host = input.host || 'hyp-01';
  const src = await readJson(callBastion, {
    host, opts, expect: 'array', label: 'Proxmox storage data',
    restPath: '/cluster/resources', restQuery: { type: 'storage' },
    bastionRead: { path: '/cluster/resources', type: 'storage' },
    pvesh: `pvesh get /cluster/resources --type storage --output-format json`,
  });
  if (src.error) return src.error;
  const storages = src.data;

  const formattedStorages = storages
    .filter(s => s.type === 'storage')
    .map(s => ({
      storage: s.storage,
      node: s.node,
      status: s.status,
      type: s.plugintype,
      used: s.disk || 0,
      total: s.maxdisk || 0,
      usedPercent: s.maxdisk > 0 ? ((s.disk / s.maxdisk) * 100).toFixed(1) : '0',
      shared: s.shared || 0,
      content: s.content
    }))
    .sort((a, b) => parseFloat(b.usedPercent) - parseFloat(a.usedPercent));

  return {
    success: true,
    ...(src.rest_error ? { rest_error: src.rest_error } : {}),
    host,
    storages: formattedStorages,
    count: formattedStorages.length
  };
}

const { isSafeShellArg } = require('../shellSafe.js');

/**
 * Escape a value for safe interpolation inside a single-quoted shell string.
 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * proxmox_vm_snapshot — create a point-in-time snapshot of an existing VM.
 * Approval-gated (AMBER) at the entity tool layer (see entityToolLoader.js);
 * this function is the executor invoked only AFTER approval resolves.
 */
async function proxmoxVmSnapshot(callBastion, input) {
  const vmid = input.vmid;
  const node = input.node;
  const snapname = input.snapname;
  const description = input.description || '';

  if (!vmid || !node || !snapname) {
    return { success: false, error: 'Missing required fields: vmid, node, snapname' };
  }
  // QUOXTRUST FND_..SHGH (shell-injection): node + vmid are interpolated raw into the pvesh URL
  // (snapname/description are shQuote'd). Validate them too and REFUSE on any shell metachar.
  if (!isSafeShellArg('host', node)) {
    return { success: false, error: 'invalid_node', detail: 'node must be a valid pve node name (injection guard)' };
  }
  if (!isSafeShellArg('vmid', String(vmid))) {
    return { success: false, error: 'invalid_vmid', detail: 'vmid must be numeric (injection guard)' };
  }

  let cmd = `pvesh create /nodes/${node}/qemu/${vmid}/snapshot --snapname ${shQuote(snapname)}`;
  if (description) {
    cmd += ` --description ${shQuote(description)}`;
  }

  const result = await callBastion(node, cmd);
  const output = result.output || result.stdout || '';
  const succeeded = result.success !== false;

  return {
    success: succeeded,
    message: succeeded
      ? `Snapshot '${snapname}' created for VM ${vmid} on ${node}`
      : `Snapshot failed: ${result.error || result.stderr || 'unknown error'}`,
    vmid: Number(vmid),
    node,
    snapname,
    task: output.trim(),
    ...(result.error && !succeeded ? { error: result.error } : {})
  };
}

/**
 * proxmox_vm_clone — clone a new VM FROM an existing golden template.
 * Approval-gated (YELLOW) at the entity tool layer. Product model
 * (AGENT-OVERHAUL-3): Quox never creates templates — it only provisions FROM
 * a VM the operator has already flagged template:1 in Proxmox. This
 * executor verifies that flag itself, before ever calling clone, so an
 * approved clone request can never target a non-template source.
 */
async function proxmoxVmClone(callBastion, input, opts = {}) {
  const templateVmid = input.template_vmid;
  const newid = input.newid;
  const name = input.name;
  const targetNode = input.node;
  const storage = input.storage;
  const full = input.full !== false; // default true (full clone)

  if (!templateVmid || !newid || !name) {
    return { success: false, error: 'Missing required fields: template_vmid, newid, name' };
  }
  // QUOXTRUST FND_..SHGH (shell-injection): newid + template_vmid are interpolated raw into the
  // pvesh URL / --newid flag (name/storage/target are shQuote'd; sourceNode comes from cluster
  // data, not model input). Validate the two numeric ids and REFUSE on any non-numeric input.
  if (!isSafeShellArg('vmid', String(newid))) {
    return { success: false, error: 'invalid_newid', detail: 'newid must be numeric (injection guard)' };
  }
  if (!isSafeShellArg('vmid', String(templateVmid))) {
    return { success: false, error: 'invalid_template_vmid', detail: 'template_vmid must be numeric (injection guard)' };
  }

  // Resolve the template's home node + verify the source is actually
  // flagged as a template — reuses the same cluster/resources read
  // proxmoxTemplatesList() uses, no new egress path.
  // DEVFLEET-BUILTINS: pvesh-read builtin first, raw `pvesh get` only if Bastion lacks the tool.
  // No `|| echo '[]'` fold: a failed lookup is an error, not "source VM not found".
  const lookupCmd = `pvesh get /cluster/resources --type vm --output-format json`;
  const lookupResult = await runSafeRead('pvesh-read', 'hyp-01', { path: '/cluster/resources', type: 'vm' },
    () => callBastion('hyp-01', lookupCmd), { toolRun: opts.toolRun });
  if (lookupResult.success === false) {
    return { success: false, ...(lookupResult.refused ? { refused: true, error_code: lookupResult.error_code } : {}), error: `Failed to look up source VM ${templateVmid}: ${lookupResult.error || 'bastion unreachable'}` };
  }

  const raw = lookupResult.output || lookupResult.stdout || '';
  if (!String(raw).trim()) {
    return { success: false, error: `Failed to look up source VM ${templateVmid}: empty response from Bastion` };
  }
  let vms;
  try {
    vms = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Failed to parse Proxmox VM data while resolving clone source' };
  }

  const source = vms.find(vm => vm.type === 'qemu' && Number(vm.vmid) === Number(templateVmid));
  if (!source) {
    return { success: false, error: `Source VM ${templateVmid} not found in the cluster` };
  }
  if (!(source.template === 1 || source.template === true)) {
    return {
      success: false,
      error: `VM ${templateVmid} (${source.name || 'unnamed'}) is not flagged as a template in Proxmox. ` +
        `Quox only clones from VMs the operator has marked template:1 — mark it a template first ` +
        `(qm template ${templateVmid}), or choose a source from proxmox_templates_list.`
    };
  }

  const sourceNode = source.node;

  let cloneCmd = `pvesh create /nodes/${sourceNode}/qemu/${templateVmid}/clone --newid ${newid} ` +
    `--name ${shQuote(name)} --full ${full ? 1 : 0}`;
  if (storage) cloneCmd += ` --storage ${shQuote(storage)}`;
  if (targetNode && targetNode !== sourceNode) cloneCmd += ` --target ${shQuote(targetNode)}`;

  const cloneResult = await callBastion(sourceNode, cloneCmd);
  const output = cloneResult.output || cloneResult.stdout || '';
  const succeeded = cloneResult.success !== false;

  return {
    success: succeeded,
    message: succeeded
      ? `Cloned template ${templateVmid} -> new VM ${newid} (${name})`
      : `Clone failed: ${cloneResult.error || cloneResult.stderr || 'unknown error'}`,
    template_vmid: Number(templateVmid),
    newid: Number(newid),
    name,
    source_node: sourceNode,
    target_node: targetNode || sourceNode,
    full,
    task: output.trim(),
    ...(cloneResult.error && !succeeded ? { error: cloneResult.error } : {})
  };
}

/**
 * proxmox_vm_action — start/stop/reboot/shutdown/suspend/resume a VM or container
 */
async function proxmoxVmAction(callBastion, input) {
  const node = input.node;
  const type = input.type || 'qemu';
  const vmid = input.vmid;
  const action = input.action;

  // Validate required fields
  if (!node || !vmid || !action) {
    return { success: false, error: 'Missing required fields: node, vmid, action' };
  }

  const validActions = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume'];
  if (!validActions.includes(action)) {
    return { success: false, error: `Invalid action: ${action}. Valid: ${validActions.join(', ')}` };
  }

  if (!['qemu', 'lxc'].includes(type)) {
    return { success: false, error: `Invalid type: ${type}. Must be qemu or lxc` };
  }

  const numVmid = parseInt(vmid);
  if (isNaN(numVmid) || numVmid < 100) {
    return { success: false, error: `Invalid vmid: ${vmid}. Must be numeric >= 100` };
  }

  // Build command — qm for QEMU, pct for LXC
  const cmd = type === 'qemu' ? `qm ${action} ${numVmid}` : `pct ${action} ${numVmid}`;

  const result = await callBastion(node, cmd);
  // AGENT-OVERHAUL TDD Wave C fix (error-body-as-data) — see proxmoxVms()
  // above. Semi-destructive tool: a failed bastion call or a Proxmox
  // rejection (e.g. permission denied, VM locked) must never be reported as
  // success:true just because stderr happened to be non-empty text.
  if (!result.success) {
    return result;
  }

  const output = result.output || result.stdout || '';

  return {
    success: true,
    message: `${action} action sent to ${type}/${numVmid}`,
    node,
    vmid: numVmid,
    action,
    output: output.trim()
  };
}

/**
 * proxmox_ha_status — HA manager state (/cluster/ha/status/current).
 */
async function proxmoxHaStatus(callBastion, input, opts = {}) {
  const host = input.host || 'hyp-01';
  const src = await readJson(callBastion, {
    host, opts, expect: 'array', label: 'Proxmox HA data',
    restPath: '/cluster/ha/status/current',
    bastionRead: { path: '/cluster/ha/status/current' },
    pvesh: `pvesh get /cluster/ha/status/current --output-format json`,
  });
  if (src.error) return src.error;
  const items = src.data.map(i => ({
    id: i.id, type: i.type, status: i.status, node: i.node,
    state: i.state, sid: i.sid, quorate: i.quorate, crm_state: i.crm_state, request_state: i.request_state,
  }));
  return {
    success: true,
    ...(src.rest_error ? { rest_error: src.rest_error } : {}),
    host,
    ha: {
      quorate: (src.data.find(i => i.type === 'quorum') || {}).quorate,
      manager: (src.data.find(i => i.type === 'master') || {}).node || null,
      items,
    },
    count: items.length,
  };
}

/**
 * proxmox_node_resources — CPU / memory / rootfs for one node.
 */
async function proxmoxNodeResources(callBastion, input, opts = {}) {
  const node = input.node || input.host || 'hyp-01';
  if (!isSafeShellArg('host', node)) {
    return { success: false, error: 'invalid_node', detail: 'node must be a valid pve node name (injection guard)' };
  }
  const src = await readJson(callBastion, {
    host: node, opts, label: 'Proxmox node data',
    restPath: `/nodes/${node}/status`,
    bastionRead: { path: `/nodes/${node}/status` },
    pvesh: `pvesh get /nodes/${node}/status --output-format json`,
  });
  if (src.error) return src.error;
  const n = src.data || {};
  const pct = (used, total) => (total > 0 ? ((used / total) * 100).toFixed(1) : '0');
  return {
    success: true,
    ...(src.rest_error ? { rest_error: src.rest_error } : {}),
    node,
    cpu: n.cpu ? (n.cpu * 100).toFixed(1) : '0',
    cores: n.cpuinfo ? n.cpuinfo.cpus : null,
    memory: { used: (n.memory || {}).used || 0, total: (n.memory || {}).total || 0, usedPercent: pct((n.memory || {}).used, (n.memory || {}).total) },
    rootfs: { used: (n.rootfs || {}).used || 0, total: (n.rootfs || {}).total || 0, usedPercent: pct((n.rootfs || {}).used, (n.rootfs || {}).total) },
    uptime: n.uptime || 0,
    loadavg: n.loadavg || null,
    pveversion: n.pveversion || null,
  };
}

/**
 * Pure name resolution over a /cluster/resources?type=vm array.
 * Exact name match, case-insensitive. Returns the outcome object.
 */
function resolveVmFromResources(resources, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return { success: false, error: 'missing_name', detail: 'name is required' };
  const matches = (Array.isArray(resources) ? resources : [])
    .filter(r => (r.type === 'qemu' || r.type === 'lxc') && typeof r.name === 'string' && r.name.toLowerCase() === wanted)
    .map(r => ({ vmid: r.vmid, node: r.node, type: r.type, status: r.status, name: r.name }));
  if (matches.length === 0) return { success: false, error: 'not_found', detail: `no VM or container named '${name}'` };
  if (matches.length > 1) {
    return { success: false, error: 'ambiguous', detail: `${matches.length} guests are named '${name}'; use the vmid`, candidates: matches.sort((a, b) => a.vmid - b.vmid) };
  }
  const m = matches[0];
  return { success: true, vmid: m.vmid, node: m.node, type: m.type, status: m.status };
}

/**
 * proxmox_vm_resolve — name -> {vmid,node,type,status}.
 */
async function proxmoxVmResolve(callBastion, input, opts = {}) {
  const host = input.host || 'hyp-01';
  const src = await readJson(callBastion, {
    host, opts, expect: 'array', label: 'Proxmox VM data',
    restPath: '/cluster/resources', restQuery: { type: 'vm' },
    bastionRead: { path: '/cluster/resources', type: 'vm' },
    pvesh: `pvesh get /cluster/resources --type vm --output-format json`,
  });
  if (src.error) return src.error;
  if (input.vmid !== undefined && input.vmid !== null && input.vmid !== '' && !input.name) return resolveVmByVmid(src.data, input.vmid);
  return resolveVmFromResources(src.data, input.name);
}

/** vmid -> {vmid,node,type,status,name} over the same /cluster/resources array (vmids are cluster-unique). */
function resolveVmByVmid(resources, vmid) {
  const s = String(vmid).trim();
  if (!/^\d{1,9}$/.test(s)) return { success: false, error: 'invalid_vmid', detail: 'vmid must be a number' };
  const id = Number(s);
  const m = (Array.isArray(resources) ? resources : []).find(r => (r.type === 'qemu' || r.type === 'lxc') && Number(r.vmid) === id);
  if (!m) return { success: false, error: 'not_found', detail: `no VM or container with vmid ${id}` };
  return { success: true, vmid: Number(m.vmid), node: m.node, type: m.type, status: m.status, name: m.name };
}

/**
 * REST-first handler for the proxmox-extended entity read tools
 * (proxmox.storage.usage / snapshots.list / vm.resources / node.resources /
 * backup.status / ha.status), used by bastionSshExecutor before it builds a
 * pvesh command. Returns null when the REST API is not configured (caller
 * then runs the unchanged Bastion path); a result object otherwise.
 */
async function proxmoxExtRest(toolId, input, opts = {}) {
  const pveGet = opts.pveGet || proxmoxApi.pveGet;
  const o = { orgId: opts.orgId };
  const fail = (err) => ({ success: false, tool: toolId, error: `Proxmox API read failed: ${(err && err.message) || 'unknown error'}`, code: (err && err.code) || 'pve_error' });
  const ok = (body) => ({ success: true, host: 'proxmox-api', tool: toolId, output: body, stderr: '', via: 'rest' });
  try {
    switch (toolId) {
      case 'proxmox.storage.usage':
        return ok(JSON.stringify(await pveGet('/cluster/resources', { type: 'storage' }, o)));
      case 'proxmox.vm.resources':
        return ok(JSON.stringify(await pveGet('/cluster/resources', { type: 'vm' }, o)));
      case 'proxmox.node.resources': {
        const node = input.node || 'hyp-01';
        return ok(JSON.stringify(await pveGet(`/nodes/${node}/status`, undefined, o)));
      }
      case 'proxmox.ha.status':
        return ok(JSON.stringify(await pveGet('/cluster/ha/status/current', undefined, o)));
      case 'proxmox.backup.status': {
        const node = input.node || 'hyp-01';
        const tasks = await pveGet(`/nodes/${node}/tasks`, { typefilter: 'vzdump', limit: 20 }, o);
        return ok(JSON.stringify(tasks));
      }
      case 'proxmox.snapshots.list': {
        const vms = await pveGet('/cluster/resources', { type: 'vm' }, o);
        // #1042: templates have no snapshots worth listing; read 8 VMs at a time (a serial
        // walk timed out on a real cluster), keeping the output in VM order.
        const targets = (Array.isArray(vms) ? vms : []).filter(v => v.type === 'qemu' && !v.template && (!input.vmid || Number(v.vmid) === Number(input.vmid)));
        const parts = new Array(targets.length);
        let next = 0;
        const worker = async () => {
          while (next < targets.length) {
            const i = next++;
            const v = targets[i];
            const snaps = await pveGet(`/nodes/${v.node}/qemu/${v.vmid}/snapshot`, undefined, o);
            parts[i] = `=== VM ${v.vmid} ===\n${JSON.stringify(snaps)}`;
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
        return ok(parts.join('\n'));
      }
      default:
        return null;
    }
  } catch (err) {
    if (proxmoxApi.restFallsBack(err)) {
      const note = proxmoxApi.restFallbackNote(err);
      if (note) {
        console.warn(`[ProxmoxApi] REST read ${toolId} refused (HTTP ${err.status}); falling back to Bastion`);
        if (typeof opts.onFallback === 'function') opts.onFallback(note);
      }
      return null;
    }
    return fail(err);
  }
}

module.exports = {
  readJson, // VM Doctor (lib/proxmoxDoctor.js) reads through the same REST-first path
  proxmoxHaStatus,
  proxmoxNodeResources,
  proxmoxVmResolve,
  resolveVmFromResources,
  proxmoxExtRest,
  proxmoxVms,
  proxmoxTemplatesList,
  proxmoxContainers,
  proxmoxCluster,
  proxmoxStorage,
  proxmoxVmAction,
  proxmoxVmSnapshot,
  proxmoxVmClone
};
