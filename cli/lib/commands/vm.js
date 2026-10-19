/**
 * `quox vm` : drive the HYPERION (agent id atlas) Proxmox tools from the CLI.
 *
 *   quox vm list [--node n] [--type qemu|lxc]
 *   quox vm info <name|vmid>
 *   quox vm start|stop|reboot|shutdown <name|vmid> [--reason t]
 *   quox vm doctor <name|vmid>             why is it slow or unhealthy? ranked findings with evidence (read only)
 *   quox vm snapshot <name|vmid> [--name s] [--reason t]
 *   quox vm rehearse <name|vmid> [--check url:..|unit:..|cmd:..] [--keep-twin] [--no-wait] -- <command>
 *   quox vm pool status|lease|done <vmid>|config
 *
 * Every action goes through the governed tool route (POST /api/v1/tools/execute).
 * A held call prints its approval id and the `quox approvals result <id>` hint
 * and is never re-submitted. Engine shared with the QUOXON /vm command: lib/core/vm.js.
 */

import { Option } from 'commander';
import { resolveOrgId } from './helpers.js';
import { formatOutput, printInfo, printWarning } from '../core/output.js';
import {
  VM_ACTIONS, VmPendingError, pendingHint, makeExec, makePoolRest,
  listVms, vmInfo, vmDoctor, doctorLines, vmAction, vmSnapshot, vmRehearse, waitRehearsal, poolStatus, poolLease, poolDone, poolConfig, poolHostKeyLines,
  readPubkey, textOf, payloadOf,
} from '../core/vm.js';

export function registerVmCommands(program, ctx) {
  const { client, auth } = ctx;
  const json = () => program.opts().output === 'json';

  const vm = program
    .command('vm')
    .description('Proxmox VMs via the HYPERION agent tools (governed: held calls wait for approval)');

  /** Run one verb: auth, exec, and turn a held call into the approval hint (exit 0, no re-submit). */
  const run = (fn) => async (...args) => {
    auth.requireAuth();
    const exec = makeExec({ client, orgId: resolveOrgId(auth, program) });
    try { await fn(exec, ...args); }
    catch (e) {
      if (!(e instanceof VmPendingError)) throw e;
      if (json()) console.log(JSON.stringify({ pending: true, tool: e.tool, approvalId: e.approvalId, inbox_item_id: e.inboxItemId }));
      else printWarning(pendingHint(e));
    }
  };
  const emit = (data, human) => {
    if (json()) console.log(JSON.stringify(data, null, 2));
    else human();
  };

  // Read-only cluster views (HYPERION read tools; REST first, Bastion pvesh-read fallback).
  vm.command('cluster')
    .description('Proxmox cluster health: quorum and nodes (read only)')
    .action(run(async (exec) => {
      const p = payloadOf(await exec('proxmox_cluster_status', {}));
      emit(p, () => console.log(textOf(p)));
    }));

  vm.command('ha')
    .description('Proxmox HA status (read only)')
    .action(run(async (exec) => {
      const p = payloadOf(await exec('proxmox_ha_status', {}));
      emit(p, () => console.log(textOf(p)));
    }));

  vm.command('templates')
    .description('Golden templates you can clone from (read only)')
    .action(run(async (exec) => { const p = payloadOf(await exec('proxmox_templates_list', {})); emit(p, () => console.log(textOf(p))); }));

  vm.command('storage')
    .description('Proxmox storage pools and usage (read only)')
    .action(run(async (exec) => { const p = payloadOf(await exec('proxmox_storage', {})); emit(p, () => console.log(textOf(p))); }));

  vm.command('node <name>')
    .description('CPU, memory and storage of one Proxmox node (read only)')
    .action(run(async (exec, name) => {
      if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error('node name must be lowercase letters, digits or -');
      const p = payloadOf(await exec('proxmox_node_resources', { node: name })); emit(p, () => console.log(textOf(p)));
    }));

  vm.command('resolve <name>')
    .description('Find which node and VMID a VM name lives on (read only)')
    .action(run(async (exec, name) => {
      const p = payloadOf(await exec('proxmox_vm_resolve', /^\d+$/.test(name) ? { vmid: Number(name) } : { name }));
      emit(p, () => console.log(textOf(p)));
    }));

  vm.command('list')
    .description('List VMs (--type lxc lists containers)')
    .option('--node <name>', 'only this Proxmox node')
    .option('--type <kind>', 'qemu | lxc', undefined)
    .action(run(async (exec, options) => {
      const vms = await listVms(exec, { node: options.node, type: options.type });
      if (json()) { console.log(JSON.stringify(vms.map((v) => v.raw), null, 2)); return; }
      formatOutput(
        { columns: ['vmid', 'name', 'node', 'type', 'status'], rows: vms.map(({ raw, ...r }) => r) },
        { emptyMessage: 'No VMs found.' },
      );
    }));

  vm.command('agents')
    .description('Which running VMs answer on the QEMU guest agent: counts and the VMs that do not (read only)')
    .option('--node <name>', 'only this Proxmox node')
    .option('--limit <n>', 'how many gaps to list (default 25, max 50)')
    .action(run(async (exec, options) => {
      const p = payloadOf(await exec('proxmox_vms', { guest: true, ...(options.node ? { node: options.node } : {}), ...(options.limit ? { limit: Number(options.limit) } : {}) }));
      emit(p, () => {
        printInfo(`Guest agent: ${p.agent_running} of ${p.probed} running VMs answer (${p.not_enabled} not enabled, ${p.not_running} not running, ${p.unknown} unknown; ${p.stopped} stopped VMs not checked)`);
        formatOutput({ columns: ['vmid', 'name', 'node', 'agent'], rows: p.gaps || [] }, { emptyMessage: 'Every running VM answers on the guest agent.' });
        if (p.gaps_truncated) printWarning(`${p.gaps_truncated} more not shown (--limit)`);
      });
    }));

  vm.command('info <target>')
    .description('Resources and state of one VM (name or vmid)')
    .action(run(async (exec, target) => {
      const { vm: v, resources } = await vmInfo(exec, target);
      emit({ vm: v, resources }, () => {
        printInfo(`${v.name || v.vmid}  vmid ${v.vmid}  node ${v.node}  ${v.type}`);
        console.log(textOf(resources));
      });
    }));

  vm.command('doctor <target>')
    .description('Why is this VM slow or unhealthy? Verdict and ranked findings with evidence and a suggested fix (read only; name or vmid)')
    .action(run(async (exec, target) => {
      const report = await vmDoctor(exec, target);
      emit(report, () => { for (const l of doctorLines(report)) console.log(l); });
    }));

  for (const action of VM_ACTIONS) {
    vm.command(`${action} <target>`)
      .description(`${action[0].toUpperCase()}${action.slice(1)} a VM (name or vmid); write, may need approval`)
      .option('--reason <text>', 'why (recorded as _reason on the call)')
      .action(run(async (exec, target, options) => {
        const { vm: v, result } = await vmAction(exec, action, target, { reason: options.reason });
        emit({ vm: v, action, result }, () => {
          printInfo(`${action} ${v.name || v.vmid} (vmid ${v.vmid} on ${v.node})`);
          console.log(textOf(result));
        });
      }));
  }

  vm.command('snapshot <target>')
    .description('Snapshot a VM (name or vmid); write, may need approval')
    .option('--name <snapshot>', 'snapshot name')
    .option('--reason <text>', 'why (recorded as _reason on the call)')
    .action(run(async (exec, target, options) => {
      const { vm: v, result } = await vmSnapshot(exec, target, { name: options.name, reason: options.reason });
      emit({ vm: v, result }, () => { printInfo(`snapshot ${v.name || v.vmid} (vmid ${v.vmid})`); console.log(textOf(result)); });
    }));

  vm.command('rehearse <target> <command...>')
    .description('Rehearse a command on a network-isolated twin of a VM (snapshot, full clone, health checks); slow, writes a snapshot and a VM. Put the command after --')
    .option('--check <spec>', 'health check before/after: url:http://127.0.0.1:PORT/path | unit:NAME | cmd:COMMAND (repeatable)', (v, acc) => [...acc, v], [])
    .option('--keep-twin', 'leave the stopped, isolated twin in place')
    .addOption(new Option('--poll-ms <ms>', 'status poll interval in milliseconds (default 10000)').hideHelp())
    .option('--no-wait', 'print the rehearsal id and return; do not wait for the verdict')
    .action(run(async (exec, target, commandWords, options) => {
      const { vm: v, result: started } = await vmRehearse(exec, target, commandWords.join(' '), { checks: options.check, keepTwin: !!options.keepTwin });
      const id = started?.rehearsal_id;
      if (options.wait === false || !id) {
        emit({ vm: v, result: started }, () => { printInfo(`rehearsal of ${v.name || v.vmid} started${id ? `: ${id}` : ''}`); console.log(textOf(started)); });
        return;
      }
      if (started?.state === 'awaiting_approval') {
        if (!json()) printWarning(`${started.hint} The approval card lists every host command; approving it starts the run.`);
        if (!json()) printInfo(`waiting for approval and the run (rehearsal ${id}); Ctrl-C is safe, check later with the proxmox_rehearsal_status tool`);
      } else if (!json()) printInfo(`rehearsal ${id} of ${v.name || v.vmid} (vmid ${v.vmid} on ${v.node}) running; this takes minutes (a full disk copy)`);
      const result = await waitRehearsal(exec, id, { intervalMs: Number(options.pollMs) || undefined });
      emit({ vm: v, result }, () => {
        printInfo(`rehearsal of ${v.name || v.vmid} (vmid ${v.vmid} on ${v.node}): ${String(result?.verdict || 'unknown').toUpperCase()}  id ${id}`);
        if (result?.error) printWarning(result.error);
        console.log(textOf(result));
      });
    }));

  const pool = vm.command('pool').description('VM pool: status, lease, done, config');

  pool.command('status')
    .description('Pool capacity and current leases')
    .action(run(async (exec) => {
      const p = await poolStatus(makePoolRest({ client }));
      emit(p, () => {
        console.log(textOf(p));
        for (const v of (p && Array.isArray(p.vms) ? p.vms : [])) if (v.ip_stale) console.log(`vmid ${v.vmid}: ${v.ip} (ip may be stale)`);
      });
    }));

  pool.command('lease')
    .description('Lease a pool VM as you (needs your SSH public key); a warm VM returns at once, a bigger one is built to order (poll pool status)')
    .option('--lessee <name>', 'who is leasing (default $QUOX_SESSION or hostname)')
    .option('--pubkey-file <path>', 'SSH public key file (default ~/.ssh/id_ed25519.pub if present)')
    .option('--cores <n>', 'vCPU cores')
    .option('--memory-gb <n>', 'memory in GB')
    .option('--disk-gb <n>', 'disk in GB')
    .option('--ttl-h <n>', 'hours until the lease expires and the VM is destroyed (default and maximum: the pool lease_ttl_h)')
    .option('--purpose <text>', 'what the VM is for')
    .option('--avx', 'place only on an AVX2 lane (needed for local LLM chat); errors if no lane has avx2, never falls back')
    .option('--node <name>', 'pin the VM to this pool lane (an active, non-denied lane host)')
    .action(run(async (exec, options) => {
      const pubkey = readPubkey(options.pubkeyFile);
      const p = await poolLease(makePoolRest({ client }), {
        lessee: options.lessee, pubkey, cores: options.cores, memoryGb: options.memoryGb,
        diskGb: options.diskGb, ttlH: options.ttlH, purpose: options.purpose, avx: options.avx, node: options.node,
      });
      emit(p, () => { console.log(textOf(p)); for (const line of poolHostKeyLines(p)) console.log(line); });
    }));

  pool.command('done <vmid>')
    .description('Release a leased pool VM as you; it stops being leasable at once, then is destroyed and the pool re-warms')
    .action(run(async (exec, vmid, options) => {
      const p = await poolDone(makePoolRest({ client }), vmid);
      emit(p, () => console.log(poolDoneLine(p, vmid)));
    }));

  pool.command('config')
    .description('Configure the pool (JSON settings via --set); org admins only, acting directly')
    .option('--set <json>', 'settings as a JSON object, e.g. {"admin_keys":["ssh-ed25519 AAAA... owner"],"lanes":[{"node":"hyp-07","template_vmid":7630,"avx2":true}]} (omit to send an empty configure)')
    .action(run(async (exec, options) => {
      let input = {};
      if (options.set) {
        try { input = JSON.parse(options.set); } catch { throw new Error('--set must be a JSON object'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('--set must be a JSON object');
      }
      const p = await poolConfig(makePoolRest({ client }), input);
      emit(p, () => console.log(textOf(p)));
    }));
  // `quox vm node reboot|shutdown` is intentionally not registered: the
  // proxmox_node_power tool is not built yet, so the CLI must not advertise it.
}

/** One plain line for `vm pool done`: 202 {state:'recycling'} (current servers) or {released:{destroyed}} (older ones). */
export function poolDoneLine(p, vmid) {
  if (p && p.state === 'recycling') return `VM ${p.vmid ?? vmid} is recycling: nobody can lease it now. Destroy and re-warm finish in the background; check with quox vm pool status.`;
  if (p && p.released && p.released.destroyed) return `VM ${p.released.vmid ?? vmid} destroyed; the pool re-warms.`;
  return textOf(p);
}
