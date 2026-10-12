/**
 * Proxmox Tool Executor
 *
 * Native executor for proxmox_vms, proxmox_containers, proxmox_cluster_status,
 * proxmox_storage, and proxmox_vm_action tools.
 * Replaces proxmox-*.json n8n workflows.
 * All operations go through bastion SSH (direct Proxmox API is CORS-blocked).
 */

/**
 * proxmox_vms — list QEMU virtual machines across the cluster
 */
async function proxmoxVms(callBastion, input) {
  const host = input.host || 'hyp-01';
  const cmd = `pvesh get /cluster/resources --type vm --output-format json 2>/dev/null || echo '[]'`;

  const result = await callBastion(host, cmd);
  // AGENT-OVERHAUL TDD Wave C fix (error-body-as-data): a failed bastion
  // call must never be treated as data just because .output/.stdout happens
  // to be non-empty (or even valid JSON, e.g. "[]"). Check result.success
  // alone — matches the honest pattern in toolExecutors/security.js /
  // toolExecutors/system.js. See proxmoxReadTools.test.js.
  if (!result.success) {
    return result;
  }

  const raw = result.output || result.stdout || '[]';
  let vms;
  try {
    vms = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Failed to parse Proxmox VM data', raw: raw.substring(0, 500) };
  }

  const formattedVMs = vms
    .filter(vm => vm.type === 'qemu')
    .map(vm => ({
      vmid: vm.vmid,
      name: vm.name || `VM ${vm.vmid}`,
      node: vm.node,
      status: vm.status,
      cpu: vm.cpu ? (vm.cpu * 100).toFixed(1) : '0',
      mem: vm.mem && vm.maxmem ? ((vm.mem / vm.maxmem) * 100).toFixed(1) : '0',
      maxmem: vm.maxmem,
      disk: vm.disk,
      maxdisk: vm.maxdisk,
      uptime: vm.uptime || 0,
      type: 'qemu'
    }))
    .sort((a, b) => a.vmid - b.vmid);

  return {
    success: true,
    host,
    vms: formattedVMs,
    count: formattedVMs.length
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
async function proxmoxTemplatesList(callBastion, input) {
  const host = input.host || input.node || 'hyp-01';
  const cmd = `pvesh get /cluster/resources --type vm --output-format json 2>/dev/null || echo '[]'`;

  const result = await callBastion(host, cmd);
  // AGENT-OVERHAUL TDD Wave C fix (error-body-as-data) — see proxmoxVms() above.
  if (!result.success) {
    return result;
  }

  const raw = result.output || result.stdout || '[]';
  let vms;
  try {
    vms = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Failed to parse Proxmox VM data', raw: raw.substring(0, 500) };
  }

  const templateVms = vms.filter(vm => vm.type === 'qemu' && (vm.template === 1 || vm.template === true));

  // Best-effort per-template description lookup (cluster/resources doesn't
  // carry notes/description — that lives on the VM's own config). A failed
  // lookup for one template must never drop it from the catalogue.
  const templates = await Promise.all(templateVms.map(async (vm) => {
    let description = '';
    try {
      const cfgCmd = `pvesh get /nodes/${vm.node}/qemu/${vm.vmid}/config --output-format json 2>/dev/null || echo '{}'`;
      const cfgResult = await callBastion(vm.node, cfgCmd);
      const cfgRaw = cfgResult.output || cfgResult.stdout || '{}';
      const cfg = JSON.parse(cfgRaw);
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
    host,
    templates,
    count: templates.length
  };
}

/**
 * proxmox_containers — list LXC containers across the cluster
 */
async function proxmoxContainers(callBastion, input) {
  const host = input.host || 'hyp-01';
  const cmd = `pvesh get /cluster/resources --type lxc --output-format json 2>/dev/null || echo '[]'`;

  const result = await callBastion(host, cmd);
  // AGENT-OVERHAUL TDD Wave C fix (error-body-as-data) — see proxmoxVms() above.
  if (!result.success) {
    return result;
  }

  const raw = result.output || result.stdout || '[]';
  let containers;
  try {
    containers = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Failed to parse Proxmox container data', raw: raw.substring(0, 500) };
  }

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
    host,
    containers: formattedCTs,
    count: formattedCTs.length
  };
}

/**
 * proxmox_cluster_status — cluster overview with node states
 */
async function proxmoxCluster(callBastion, input) {
  const host = input.host || 'hyp-01';
  const cmd = `pvesh get /cluster/status --output-format json 2>/dev/null || echo '[]'`;

  const result = await callBastion(host, cmd);
  // AGENT-OVERHAUL TDD Wave C fix (error-body-as-data) — see proxmoxVms() above.
  if (!result.success) {
    return result;
  }

  const raw = result.output || result.stdout || '[]';
  let statusArray;
  try {
    statusArray = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Failed to parse Proxmox cluster data', raw: raw.substring(0, 500) };
  }

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
async function proxmoxStorage(callBastion, input) {
  const host = input.host || 'hyp-01';
  const cmd = `pvesh get /cluster/resources --type storage --output-format json 2>/dev/null || echo '[]'`;

  const result = await callBastion(host, cmd);
  // AGENT-OVERHAUL TDD Wave C fix (error-body-as-data) — see proxmoxVms() above.
  if (!result.success) {
    return result;
  }

  const raw = result.output || result.stdout || '[]';
  let storages;
  try {
    storages = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Failed to parse Proxmox storage data', raw: raw.substring(0, 500) };
  }

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
async function proxmoxVmClone(callBastion, input) {
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
  const lookupCmd = `pvesh get /cluster/resources --type vm --output-format json 2>/dev/null || echo '[]'`;
  const lookupResult = await callBastion('hyp-01', lookupCmd);
  if (!lookupResult.success && !lookupResult.output && !lookupResult.stdout) {
    return { success: false, error: `Failed to look up source VM ${templateVmid}: ${lookupResult.error || 'bastion unreachable'}` };
  }

  const raw = lookupResult.output || lookupResult.stdout || '[]';
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

module.exports = {
  proxmoxVms,
  proxmoxTemplatesList,
  proxmoxContainers,
  proxmoxCluster,
  proxmoxStorage,
  proxmoxVmAction,
  proxmoxVmSnapshot,
  proxmoxVmClone
};
