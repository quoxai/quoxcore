'use strict';

/**
 * VM Doctor (DEVFLEET-DOCTOR): "why is VM X slow or unhealthy?"
 *
 * READ ONLY. Gathers evidence from the Proxmox read path (REST first, Bastion pvesh-read fallback,
 * both through toolExecutors/proxmox.js readJson) and runs a fixed set of PURE rules over it. No
 * LLM, no guessing: every finding carries the metric, the value, the threshold, the window and the
 * source it came from, so the reader can check it. Nothing here writes to a VM.
 *
 * Every source is optional. A source that cannot be read becomes a `gaps[]` entry ("could not
 * read guest agent: <reason>"), never a silent drop and never fatal. Only a VM that cannot be
 * resolved fails the diagnosis.
 *
 * Rule contract: rule(ctx) -> null | { id, severity, title, cause, evidence[], fix{text, action?}, strength }.
 * A rule whose data is missing returns null (the gap is already reported by the gatherer).
 */

const crypto = require('crypto');
const px = require('./toolExecutors/proxmox.js');

/**
 * THRESHOLDS: the single place every number lives. Ratios are fractions (0.85 = 85%).
 *  cpu_sustained        guest CPU hour average at or above this = under-provisioned
 *  cpu_critical         ... and at or above this = critical
 *  node_cpu             host node CPU hour average at or above this = contention (noisy neighbour)
 *  node_cpu_critical    ... critical
 *  mem_pressure         guest memory (mem/maxmem) hour average at or above this
 *  mem_critical         ... critical
 *  balloon_ratio        balloon target below this fraction of maxmem = host is reclaiming memory
 *  guest_fs_full        a guest filesystem used/total at or above this (per mount, from the agent)
 *  fs_critical          ... critical
 *  storage_full         a storage pool backing the VM used/total at or above this
 *  storage_critical     ... critical
 *  io_spike_factor      disk read+write hour average more than this many times the day average
 *  io_min_bytes_per_s   ... and at least this many bytes/s (a spike from near zero is noise)
 *  net_spike_factor     network in+out hour average more than this many times the day average
 *  net_min_bytes_per_s  ... and at least this many bytes/s
 *  snapshot_count       more snapshots than this = sprawl
 *  snapshot_age_days    oldest snapshot older than this many days = sprawl
 *  recent_change_hours  tasks on this vmid within this many hours are listed as recent changes
 *  recently_rebooted_s  uptime below this many seconds = recently rebooted
 *  min_samples          a rrddata window needs at least this many non-null points to be judged
 */
const THRESHOLDS = Object.freeze({
  cpu_sustained: 0.85,
  cpu_critical: 0.95,
  node_cpu: 0.85,
  node_cpu_critical: 0.95,
  mem_pressure: 0.90,
  mem_critical: 0.97,
  balloon_ratio: 0.98,
  guest_fs_full: 0.90,
  fs_critical: 0.97,
  storage_full: 0.90,
  storage_critical: 0.97,
  io_spike_factor: 3,
  io_min_bytes_per_s: 5 * 1024 * 1024,
  net_spike_factor: 3,
  net_min_bytes_per_s: 1024 * 1024,
  snapshot_count: 5,
  snapshot_age_days: 30,
  recent_change_hours: 24,
  recently_rebooted_s: 3600,
  min_samples: 5,
});

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const round = (n, d = 3) => { const f = 10 ** d; return Math.round(n * f) / f; };
const pct = (r) => `${round(r * 100, 1)}%`;
const mib = (b) => `${round(b / (1024 * 1024), 1)} MiB/s`;

/** Average of a numeric field over rrddata points, ignoring nulls. -> { avg, n } or null. */
function rrdAvg(points, field, minSamples = THRESHOLDS.min_samples) {
  if (!Array.isArray(points)) return null;
  const vals = points.map((p) => num(p && p[field])).filter((v) => v !== null);
  if (vals.length < minSamples) return null;
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length };
}

/** Per-point ratio average (mem/maxmem), ignoring points missing either side. */
function rrdRatioAvg(points, numField, denField, minSamples = THRESHOLDS.min_samples) {
  if (!Array.isArray(points)) return null;
  const vals = [];
  for (const p of points) {
    const a = num(p && p[numField]); const b = num(p && p[denField]);
    if (a !== null && b !== null && b > 0) vals.push(a / b);
  }
  if (vals.length < minSamples) return null;
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length };
}

function finding(id, severity, title, cause, evidence, fix, strength) {
  return { id, severity, title, cause, evidence, fix, strength: round(Math.min(Math.max(strength, 0), 10), 3) };
}

const ev = (metric, value, threshold, window, source) => ({ metric, value, threshold, window, source });

function isRunning(ctx) {
  const st = (ctx.status && ctx.status.status) || (ctx.vm && ctx.vm.status);
  return st === 'running';
}

/** Is the qemu guest agent enabled in the VM config? (`agent: 1` or `agent: enabled=1,...`) */
function agentEnabled(config) {
  if (!config || config.agent === undefined || config.agent === null) return false;
  const v = String(config.agent);
  if (/enabled=0/.test(v)) return false;
  if (/^0$/.test(v)) return false;
  return true;
}

/** Storage ids that back this VM's disks, from its config (cdrom and none excluded). */
function diskStorages(config) {
  const out = new Set();
  if (!config || typeof config !== 'object') return [];
  for (const [k, v] of Object.entries(config)) {
    if (!/^(scsi|virtio|sata|ide|efidisk|tpmstate|nvme)\d+$/.test(k)) continue;
    const s = String(v);
    if (/media=cdrom/.test(s)) continue;
    const m = s.match(/^([^:,]+):/);
    if (m && m[1] !== 'none') out.add(m[1]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
function ruleVmNotRunning(ctx) {
  const st = (ctx.status && ctx.status.status) || (ctx.vm && ctx.vm.status);
  if (!st || st === 'running') return null;
  const vm = ctx.vm;
  return finding('vm_not_running', 'critical', `VM is ${st}`,
    `The VM is not running (status ${st}), so nothing on it is serving.`,
    [ev('vm status', st, 'running', 'now', ctx.status ? 'status/current' : 'cluster/resources')],
    {
      text: 'Start the VM. Check the recent tasks below first if it was stopped on purpose.',
      action: { tool: 'proxmox_vm_action', input: { vmid: vm.vmid, node: vm.node, action: 'start' }, gated: true },
    }, 10);
}

function ruleGuestCpu(ctx) {
  if (!isRunning(ctx)) return null;
  const a = rrdAvg(ctx.rrdHour, 'cpu');
  if (!a || a.avg < ctx.T.cpu_sustained) return null;
  const sev = a.avg >= ctx.T.cpu_critical ? 'critical' : 'warning';
  const cpus = num(ctx.status && ctx.status.cpus) || num(ctx.config && ctx.config.cores);
  return finding('guest_cpu_sustained', sev, 'Guest CPU is saturated',
    `The guest has averaged ${pct(a.avg)} CPU over the last hour${cpus ? ` across ${cpus} vCPU${cpus === 1 ? '' : 's'}` : ''}, so it is under-provisioned for its workload (or something inside is spinning).`,
    [ev('guest cpu (average)', round(a.avg), ctx.T.cpu_sustained, 'last hour', 'rrddata?timeframe=hour')],
    { text: `Find the busy process inside the guest (top / pidstat). If the load is legitimate, add vCPUs${cpus ? ` (now ${cpus})` : ''}; a reboot may be needed to apply.` },
    a.avg / ctx.T.cpu_sustained);
}

function ruleHostCpu(ctx) {
  if (!isRunning(ctx)) return null;
  const evidence = []; let strength = 0; let crit = false;
  const a = rrdAvg(ctx.nodeRrdHour, 'cpu');
  if (a && a.avg >= ctx.T.node_cpu) {
    evidence.push(ev('node cpu (average)', round(a.avg), ctx.T.node_cpu, 'last hour', 'node rrddata?timeframe=hour'));
    strength = Math.max(strength, a.avg / ctx.T.node_cpu);
    if (a.avg >= ctx.T.node_cpu_critical) crit = true;
  }
  const load1 = ctx.nodeStatus && Array.isArray(ctx.nodeStatus.loadavg) ? num(ctx.nodeStatus.loadavg[0]) : null;
  const cores = ctx.nodeStatus && ctx.nodeStatus.cpuinfo ? num(ctx.nodeStatus.cpuinfo.cpus) : null;
  if (load1 !== null && cores && load1 > cores) {
    evidence.push(ev('node load average (1 min)', round(load1, 2), cores, 'now', 'node status'));
    strength = Math.max(strength, load1 / cores);
  }
  if (!evidence.length) return null;
  return finding('host_cpu_contention', crit ? 'critical' : 'warning', 'The host node is CPU-starved (noisy neighbour or steal)',
    `Node ${ctx.vm.node} has more runnable work than cores, so this VM's vCPUs wait for host time even when the guest looks idle.`,
    evidence,
    { text: `Find the heaviest VMs on ${ctx.vm.node} and move or throttle one, or migrate this VM to a quieter node.` },
    strength);
}

function ruleMemory(ctx) {
  if (!isRunning(ctx)) return null;
  const evidence = []; let strength = 0; let crit = false;
  const a = rrdRatioAvg(ctx.rrdHour, 'mem', 'maxmem');
  if (a && a.avg >= ctx.T.mem_pressure) {
    evidence.push(ev('guest memory used / max (average)', round(a.avg), ctx.T.mem_pressure, 'last hour', 'rrddata?timeframe=hour'));
    strength = Math.max(strength, a.avg / ctx.T.mem_pressure);
    if (a.avg >= ctx.T.mem_critical) crit = true;
  }
  const balloon = num(ctx.status && ctx.status.balloon); const maxmem = num(ctx.status && ctx.status.maxmem);
  if (balloon && maxmem && balloon < maxmem * ctx.T.balloon_ratio) {
    evidence.push(ev('balloon target / maxmem', round(balloon / maxmem), ctx.T.balloon_ratio, 'now', 'status/current'));
    strength = Math.max(strength, 1.2);
  }
  if (!evidence.length) return null;
  return finding('memory_pressure', crit ? 'critical' : 'warning', 'The guest is short of memory',
    'Memory use is at or near what the VM is allowed, or the host is ballooning memory away from it. Expect swapping and slow I/O inside the guest.',
    evidence,
    { text: 'Raise the VM memory (or lower the balloon minimum), or find the process that is growing. Check swap use inside the guest.' },
    strength);
}

function ruleGuestDiskFull(ctx) {
  const fs = ctx.fsinfo;
  if (!Array.isArray(fs)) return null;
  const hits = [];
  for (const f of fs) {
    const used = num(f['used-bytes']); const total = num(f['total-bytes']);
    if (used === null || !total) continue;
    const r = used / total;
    if (r >= ctx.T.guest_fs_full) hits.push({ mount: f.mountpoint || f.name || '?', r });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.r - a.r);
  const worst = hits[0].r;
  return finding('guest_disk_full', worst >= ctx.T.fs_critical ? 'critical' : 'warning', 'A guest filesystem is nearly full',
    `${hits.map((h) => `${h.mount} is ${pct(h.r)} used`).join(', ')}. A full filesystem stops writes, logs and databases first.`,
    hits.map((h) => ev(`filesystem ${h.mount} used / total`, round(h.r), ctx.T.guest_fs_full, 'now', 'guest agent get-fsinfo')),
    { text: 'Free space inside the guest (logs, caches, old kernels) or grow the virtual disk and then the filesystem.' },
    worst / ctx.T.guest_fs_full);
}

function ruleStorageFull(ctx) {
  if (!Array.isArray(ctx.storages)) return null;
  const backing = new Set(diskStorages(ctx.config));
  if (!backing.size) return null;
  const hits = [];
  for (const s of ctx.storages) {
    if (!s || !backing.has(s.storage)) continue;
    const used = num(s.used); const total = num(s.total);
    if (used === null || !total) continue;
    const r = used / total;
    if (r >= ctx.T.storage_full) hits.push({ name: s.storage, type: s.type, r });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.r - a.r);
  return finding('storage_pool_full', hits[0].r >= ctx.T.storage_critical ? 'critical' : 'warning', 'The storage pool behind this VM is nearly full',
    `${hits.map((h) => `${h.name}${h.type ? ` (${h.type})` : ''} is ${pct(h.r)} used`).join(', ')}. Thin-provisioned pools slow down and can freeze guests as they near full.`,
    hits.map((h) => ev(`storage ${h.name} used / total`, round(h.r), ctx.T.storage_full, 'now', 'node storage')),
    { text: 'Free space on the pool (old backups, unused disks, stale snapshots) or move this VM disk to a roomier storage.' },
    hits[0].r / ctx.T.storage_full);
}

function spike(ctx, fields, factorKey, minKey, id, title, cause, metric, fixText) {
  if (!isRunning(ctx)) return null;
  const sum = (points) => {
    const parts = fields.map((f) => rrdAvg(points, f));
    if (parts.some((p) => !p)) return null;
    return parts.reduce((a, p) => a + p.avg, 0);
  };
  const hour = sum(ctx.rrdHour); const day = sum(ctx.rrdDay);
  if (hour === null || day === null) return null;
  const factor = ctx.T[factorKey]; const floor = ctx.T[minKey];
  if (hour < floor) return null;
  const ratio = day > 0 ? hour / day : Infinity;
  if (ratio < factor) return null;
  return finding(id, 'warning', title, cause,
    [
      ev(`${metric} (hour average)`, mib(hour), `at least ${mib(floor)}`, 'last hour', 'rrddata?timeframe=hour'),
      ev(`${metric} (day average)`, mib(day), `hour must exceed ${factor}x this`, 'last day', 'rrddata?timeframe=day'),
    ],
    { text: fixText }, Number.isFinite(ratio) ? ratio / factor : 5);
}

function ruleDiskIo(ctx) {
  return spike(ctx, ['diskread', 'diskwrite'], 'io_spike_factor', 'io_min_bytes_per_s', 'disk_io_spike', 'Disk I/O is far above normal',
    'Disk read plus write in the last hour is several times this VM\'s daily average. A backup, a runaway job or a rebuild is likely hammering the disk.',
    'disk read+write', 'Find what is doing the I/O (iotop inside the guest, running backups on the host). Throttle it or move it off-peak.');
}

function ruleNetwork(ctx) {
  return spike(ctx, ['netin', 'netout'], 'net_spike_factor', 'net_min_bytes_per_s', 'network_spike', 'Network traffic is far above normal',
    'Network in plus out in the last hour is several times this VM\'s daily average: a transfer, a flood, or a misbehaving client.',
    'network in+out', 'Check which connections are busy inside the guest (ss, iftop). If it is unexpected traffic, treat it as a possible incident.');
}

function ruleSnapshots(ctx) {
  if (!Array.isArray(ctx.snapshots)) return null;
  const snaps = ctx.snapshots.filter((s) => s && s.name !== 'current');
  const nowSec = ctx.nowSec;
  const times = snaps.map((s) => num(s.snaptime)).filter((t) => t !== null);
  const oldest = times.length ? Math.min(...times) : null;
  const ageDays = oldest !== null ? (nowSec - oldest) / 86400 : null;
  const evidence = []; let strength = 0;
  if (snaps.length > ctx.T.snapshot_count) {
    evidence.push(ev('snapshot count', snaps.length, ctx.T.snapshot_count, 'now', 'snapshot'));
    strength = Math.max(strength, snaps.length / ctx.T.snapshot_count);
  }
  if (ageDays !== null && ageDays > ctx.T.snapshot_age_days) {
    evidence.push(ev('oldest snapshot age (days)', round(ageDays, 1), ctx.T.snapshot_age_days, 'now', 'snapshot'));
    strength = Math.max(strength, ageDays / ctx.T.snapshot_age_days);
  }
  if (!evidence.length) return null;
  const storages = diskStorages(ctx.config);
  return finding('snapshot_sprawl', 'warning', 'Too many or too old snapshots',
    `Every write copies on top of the snapshot chain, so a long or old chain slows I/O on LVM-thin and qcow2 storage${storages.length ? ` (disks on ${storages.join(', ')})` : ''} and holds space.`,
    evidence,
    { text: 'Delete the snapshots you no longer need, oldest first, one at a time. Keep a snapshot only while a change is being tested.' },
    strength);
}

function ruleAgent(ctx) {
  if (!isRunning(ctx)) return null;
  if (!ctx.src || ctx.src.agent_info === undefined) return null;
  if (ctx.src.agent_info === true) return null;
  const enabled = agentEnabled(ctx.config);
  if (ctx.config === null || ctx.config === undefined) return null;
  return finding('guest_agent_unresponsive', enabled ? 'warning' : 'info', enabled ? 'The guest agent is not answering' : 'The guest agent is not enabled',
    enabled
      ? 'The VM config enables the QEMU guest agent but it does not answer, so guest disk, OS and network checks are blind. The agent service may be stopped or the guest may be hung.'
      : 'The QEMU guest agent is off in the VM config, so Quox cannot see inside the guest (filesystem use, OS). This is a blind spot rather than a fault.',
    [ev('guest agent reachable', 'no', 'yes', 'now', 'agent/info'), ev('config agent', ctx.config && ctx.config.agent !== undefined ? String(ctx.config.agent) : 'unset', 'enabled', 'now', 'config')],
    { text: enabled ? 'Check the qemu-guest-agent service inside the guest (systemctl status qemu-guest-agent); if the guest is hung, look at its console.' : 'Install qemu-guest-agent in the guest and set agent: 1 on the VM, then restart it.' },
    enabled ? 1.5 : 0.5);
}

const ACTIVE_NOT_BACKUP_WARN = new Set(['qmigrate', 'qmrestore', 'qmclone', 'qmmove', 'qmrollback', 'qmsnapshot', 'qmdelsnapshot', 'qmresize', 'qmconfig']);

function describeTask(t, nowSec) {
  const start = num(t.starttime);
  const active = !t.endtime;
  return { type: t.type, user: t.user, status: active ? 'running' : (t.status || 'ok'), started: start !== null ? new Date(start * 1000).toISOString() : null, ago_min: start !== null ? Math.round((nowSec - start) / 60) : null };
}

function ruleRecentChange(ctx) {
  if (!Array.isArray(ctx.tasks)) return null;
  const cutoff = ctx.nowSec - ctx.T.recent_change_hours * 3600;
  const mine = ctx.tasks.filter((t) => t && String(t.id) === String(ctx.vm.vmid) && num(t.starttime) !== null && num(t.starttime) >= cutoff && t.type !== 'vzdump')
    .sort((a, b) => num(b.starttime) - num(a.starttime));
  if (!mine.length) return null;
  const top = mine.slice(0, 5);
  const activeHeavy = mine.some((t) => !t.endtime && ACTIVE_NOT_BACKUP_WARN.has(t.type));
  const failed = mine.filter((t) => t.endtime && t.status && t.status !== 'OK');
  const sev = activeHeavy || failed.length ? 'warning' : 'info';
  return finding('recent_change', sev, `${mine.length} task${mine.length === 1 ? '' : 's'} on this VM in the last ${ctx.T.recent_change_hours}h`,
    activeHeavy ? 'A disruptive task (migration, restore, clone, disk move or snapshot work) is running on this VM right now.'
      : failed.length ? 'A recent task on this VM did not finish OK; its effect may still be visible.'
        : 'Something changed on this VM recently. If the slowness started then, this is the first place to look.',
    top.map((t) => {
      const d = describeTask(t, ctx.nowSec);
      return ev(`task ${d.type} by ${d.user || '?'}`, `${d.status}${d.ago_min !== null ? `, ${d.ago_min} min ago` : ''}`, `within ${ctx.T.recent_change_hours}h`, `last ${ctx.T.recent_change_hours}h`, 'node tasks');
    }),
    { text: activeHeavy ? 'Let the running task finish before judging performance; check its progress in the Proxmox task log.' : 'Compare the time of these tasks with when the slowness began; roll back the one that lines up if it is yours.' },
    activeHeavy ? 2 : failed.length ? 1.2 : 0.6);
}

function ruleBackupRunning(ctx) {
  if (!Array.isArray(ctx.tasks)) return null;
  const active = ctx.tasks.filter((t) => t && String(t.id) === String(ctx.vm.vmid) && t.type === 'vzdump' && !t.endtime);
  if (!active.length) return null;
  return finding('backup_running', 'warning', 'A backup is running on this VM now',
    'vzdump reads the whole disk (and may hold a snapshot) while it runs, which competes with the guest for disk and CPU. Slowness should end when it finishes.',
    active.map((t) => ev(`task vzdump by ${t.user || '?'}`, 'running', 'finished', 'now', 'node tasks')),
    { text: 'Wait for the backup to finish, or move the backup window off business hours.' }, 1.5);
}

function ruleRecentReboot(ctx) {
  if (!isRunning(ctx)) return null;
  const up = num(ctx.status && ctx.status.uptime);
  if (up === null || up >= ctx.T.recently_rebooted_s) return null;
  return finding('recently_rebooted', 'info', 'The VM started recently',
    `Uptime is ${Math.round(up / 60)} minutes. Caches are cold and services may still be warming up, which can look like slowness.`,
    [ev('uptime (seconds)', up, `at least ${ctx.T.recently_rebooted_s}`, 'now', 'status/current')],
    { text: 'Give it a few minutes. If it rebooted unexpectedly, check the guest logs and the recent tasks for a crash or an HA restart.' }, 0.4);
}

const RULES = Object.freeze([
  { id: 'vm_not_running', fn: ruleVmNotRunning },
  { id: 'guest_cpu_sustained', fn: ruleGuestCpu },
  { id: 'host_cpu_contention', fn: ruleHostCpu },
  { id: 'memory_pressure', fn: ruleMemory },
  { id: 'guest_disk_full', fn: ruleGuestDiskFull },
  { id: 'storage_pool_full', fn: ruleStorageFull },
  { id: 'disk_io_spike', fn: ruleDiskIo },
  { id: 'network_spike', fn: ruleNetwork },
  { id: 'snapshot_sprawl', fn: ruleSnapshots },
  { id: 'guest_agent_unresponsive', fn: ruleAgent },
  { id: 'recent_change', fn: ruleRecentChange },
  { id: 'backup_running', fn: ruleBackupRunning },
  { id: 'recently_rebooted', fn: ruleRecentReboot },
]);

/** Run every rule, drop nulls, rank by severity then evidence strength then id. A throwing rule is a gap, not a crash. */
function runRules(ctx) {
  const findings = []; const ruleErrors = [];
  for (const r of RULES) {
    try { const f = r.fn(ctx); if (f) findings.push(f); } catch (e) { ruleErrors.push(`rule ${r.id} failed: ${e && e.message}`); }
  }
  findings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.strength - a.strength) || a.id.localeCompare(b.id));
  return { findings, ruleErrors };
}

function verdictOf(findings) {
  if (findings.some((f) => f.severity === 'critical')) return 'critical';
  if (findings.some((f) => f.severity === 'warning')) return 'degraded';
  return 'healthy';
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------
/** name or vmid -> { success, vmid, node, name, status, type } from a /cluster/resources?type=vm array. */
function resolveTarget(resources, target) {
  const t = String(target === undefined || target === null ? '' : target).trim();
  if (!t) return { success: false, error: 'missing_target', detail: 'target (VM name or vmid) is required' };
  const list = Array.isArray(resources) ? resources : [];
  if (/^[0-9]+$/.test(t)) {
    const m = list.find((r) => (r.type === 'qemu' || r.type === 'lxc') && Number(r.vmid) === Number(t));
    if (!m) return { success: false, error: 'not_found', detail: `no VM or container with vmid ${t}` };
    return { success: true, vmid: m.vmid, node: m.node, name: m.name || `VM ${m.vmid}`, status: m.status, type: m.type };
  }
  const r = px.resolveVmFromResources(list, t);
  if (!r.success) return r;
  const m = list.find((x) => Number(x.vmid) === Number(r.vmid)) || {};
  return { ...r, name: m.name || t };
}

// ---------------------------------------------------------------------------
// Gather + diagnose
// ---------------------------------------------------------------------------
let _emitter = () => {};
function setEmitter(fn) { _emitter = typeof fn === 'function' ? fn : () => {}; }

function defaultEmit(intent, orgId, payload, actor) {
  _emitter({
    type: 'event',
    from: actor && actor !== 'atlas' ? `human.${actor}` : 'agent.atlas',
    to: 'system.proxmox_doctor',
    intent,
    corr: `doctor:${payload.report_id}`,
    payload: { orgId, org_id: orgId, ...payload },
  });
}

const noRawBastion = async () => ({ success: false, error: 'raw Bastion fallback is not wired here; the pvesh-read builtin or the Proxmox API is required' });

function errText(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  const m = e.error || e.message || e.detail;
  return String(m || 'unknown error').slice(0, 240);
}

function checkedLabel(s, node) {
  return s.path.replace(`/nodes/${node}/`, '') + (s.q && s.q.timeframe ? `?timeframe=${s.q.timeframe}` : '');
}

/**
 * Read every source in parallel. Each is optional; a failure becomes a gap. -> { data, ok, gaps, via }
 */
async function gather(orgId, vm, deps) {
  const { node, vmid } = vm;
  const callBastion = deps.callBastion || noRawBastion;
  const opts = { orgId, pveGet: deps.pveGet, toolRun: deps.toolRun };
  const b = `/nodes/${node}`;
  const running = vm.status === 'running';
  const specs = [
    { key: 'status', label: 'VM status', path: `${b}/qemu/${vmid}/status/current` },
    { key: 'config', label: 'VM config', path: `${b}/qemu/${vmid}/config` },
    { key: 'snapshots', label: 'snapshots', path: `${b}/qemu/${vmid}/snapshot`, expect: 'array' },
    { key: 'rrdHour', label: 'VM performance history (hour)', path: `${b}/qemu/${vmid}/rrddata`, q: { timeframe: 'hour', cf: 'AVERAGE' }, expect: 'array', needsRunning: true },
    { key: 'rrdDay', label: 'VM performance history (day)', path: `${b}/qemu/${vmid}/rrddata`, q: { timeframe: 'day', cf: 'AVERAGE' }, expect: 'array', needsRunning: true },
    { key: 'nodeStatus', label: 'node status', path: `${b}/status` },
    { key: 'nodeRrdHour', label: 'node performance history (hour)', path: `${b}/rrddata`, q: { timeframe: 'hour', cf: 'AVERAGE' }, expect: 'array' },
    { key: 'storages', label: 'node storage', path: `${b}/storage`, expect: 'array' },
    { key: 'tasks', label: 'recent tasks', path: `${b}/tasks`, q: { vmid: String(vmid), limit: '50' }, expect: 'array' },
    { key: 'agentInfo', label: 'guest agent', path: `${b}/qemu/${vmid}/agent/info`, needsRunning: true },
    { key: 'agentFs', label: 'guest filesystems', path: `${b}/qemu/${vmid}/agent/get-fsinfo`, needsRunning: true },
    { key: 'agentOs', label: 'guest OS info', path: `${b}/qemu/${vmid}/agent/get-osinfo`, needsRunning: true },
  ];
  const todo = specs.filter((s) => !s.needsRunning || running);
  const results = await Promise.all(todo.map(async (s) => {
    const q = s.q || undefined;
    const bastionRead = { path: s.path, ...(q || {}) };
    const pveshArgs = q ? Object.entries(q).map(([k, v]) => ` --${k} ${v}`).join('') : '';
    try {
      const r = await px.readJson(callBastion, {
        host: node, opts, label: s.label, expect: s.expect,
        restPath: s.path, restQuery: q, bastionRead,
        pvesh: `pvesh get ${s.path}${pveshArgs} --output-format json`,
      });
      return { s, r };
    } catch (e) {
      return { s, r: { error: { error: e && e.message } } };
    }
  }));
  const data = {}; const ok = {}; const gaps = []; const checked = []; const via = new Set();
  for (const { s, r } of results) {
    if (r.error) { ok[s.key] = false; data[s.key] = null; data[`${s.key}Error`] = errText(r.error); continue; }
    ok[s.key] = true; data[s.key] = r.data; via.add(r.via); checked.push(checkedLabel(s, node));
  }
  // Gaps: one per failed source. Agent: report once (info), the other two only if info answered.
  const labelOf = Object.fromEntries(specs.map((s) => [s.key, s.label]));
  for (const s of todo) {
    if (ok[s.key]) continue;
    if ((s.key === 'agentFs' || s.key === 'agentOs') && ok.agentInfo === false) continue;
    const what = s.key === 'agentInfo' ? 'guest agent' : labelOf[s.key];
    gaps.push({ source: s.key, message: `could not read ${what}: ${data[`${s.key}Error`]}` });
  }
  if (!running) {
    for (const s of specs.filter((x) => x.needsRunning)) checked.push(`${checkedLabel(s, node)} (skipped: VM not running)`);
  }
  return { data, ok, gaps, checked, via: [...via] };
}

function fsList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.result)) return v.result;
  return null;
}

/**
 * diagnose(orgId, { target }, deps)
 * deps: { pveGet, callBastion, toolRun, store, emit, now, actor }  (all optional; tests inject)
 * -> { success:true, report } | { success:false, error, ... }
 */
async function diagnose(orgId, input = {}, deps = {}) {
  if (!orgId) return { success: false, error: 'org_required', detail: 'VM Doctor needs an org context' };
  const now = deps.now || (() => Date.now());
  const T = { ...THRESHOLDS, ...(deps.thresholds || {}) };
  const callBastion = deps.callBastion || noRawBastion;
  const opts = { orgId, pveGet: deps.pveGet, toolRun: deps.toolRun };

  // 1. Resolve the VM. The only fatal step.
  let resolved;
  try {
    const src = await px.readJson(callBastion, {
      host: 'hyp-01', opts, expect: 'array', label: 'Proxmox VM data',
      restPath: '/cluster/resources', restQuery: { type: 'vm' },
      bastionRead: { path: '/cluster/resources', type: 'vm' },
      pvesh: 'pvesh get /cluster/resources --type vm --output-format json',
    });
    if (src.error) return { success: false, error: 'unresolved', detail: `could not list VMs: ${errText(src.error)}`, code: src.error.code };
    resolved = resolveTarget(src.data, input.target);
  } catch (e) {
    return { success: false, error: 'unresolved', detail: `could not list VMs: ${errText(e)}` };
  }
  if (!resolved.success) return { success: false, error: resolved.error, detail: resolved.detail, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) };
  if (resolved.type !== 'qemu') return { success: false, error: 'unsupported_type', detail: `${resolved.name} is a ${resolved.type} container; VM Doctor diagnoses QEMU VMs` };
  if (!NODE_RE.test(String(resolved.node || ''))) return { success: false, error: 'unresolved', detail: 'resolved node name is not a valid Proxmox node name' };

  const vm = { vmid: Number(resolved.vmid), name: resolved.name, node: resolved.node, status: resolved.status };

  // 2. Gather everything else in parallel.
  const g = await gather(orgId, vm, deps);
  const status = g.data.status;
  if (status && status.status) vm.status = status.status;
  if (!vm.status) vm.status = resolved.status;

  // 3. Rules.
  const ctx = {
    T, vm, nowSec: Math.floor(now() / 1000),
    status: status || null, config: g.data.config || null,
    snapshots: Array.isArray(g.data.snapshots) ? g.data.snapshots : null,
    rrdHour: g.data.rrdHour, rrdDay: g.data.rrdDay,
    nodeStatus: g.data.nodeStatus || null, nodeRrdHour: g.data.nodeRrdHour,
    storages: Array.isArray(g.data.storages) ? g.data.storages : null,
    tasks: Array.isArray(g.data.tasks) ? g.data.tasks : null,
    fsinfo: fsList(g.data.agentFs),
    src: { agent_info: g.ok.agentInfo },
  };
  const { findings, ruleErrors } = runRules(ctx);
  const gaps = [...g.gaps.map((x) => x.message), ...ruleErrors];

  const report = {
    report_id: null,
    vm: { vmid: vm.vmid, name: vm.name, node: vm.node, status: vm.status },
    verdict: verdictOf(findings),
    findings,
    gaps,
    checked: g.checked,
    generated_at: new Date(now()).toISOString(),
  };

  // 4. Store (org-scoped) and emit evidence. A storage failure never hides the diagnosis.
  const store = deps.store || (() => { try { return require('./proxmoxDoctorStore.js'); } catch { return null; } })();
  report.report_id = store && store.newId ? store.newId() : `DR_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  report.stored = false;
  try { store.save(orgId, report); report.stored = true; } catch (e) { report.gaps.push(`report was not stored: ${errText(e)}`); }
  try {
    (deps.emit || defaultEmit)('quox.proxmox.doctor', orgId, { report_id: report.report_id, vmid: vm.vmid, verdict: report.verdict, finding_ids: findings.map((f) => f.id) }, deps.actor);
  } catch { /* evidence never blocks a read */ }

  return { success: true, report };
}

module.exports = {
  THRESHOLDS, RULES, runRules, verdictOf, resolveTarget, diagnose, gather,
  rrdAvg, rrdRatioAvg, diskStorages, agentEnabled, setEmitter, defaultEmit,
};
