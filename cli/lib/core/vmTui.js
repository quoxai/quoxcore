/**
 * QUOXON `/vm <verb> <target> [args]`: parse the words, call the shared engine
 * (lib/core/vm.js, same as `quox vm`), return { lines, tone } for say().
 * A held call becomes the approval hint (tone 'warn'); other failures throw.
 */
import {
  VM_ACTIONS, NODE_ACTIONS, VmPendingError, pendingHint, makeExec,
  listVms, vmInfo, vmDoctor, doctorLines, vmAction, vmSnapshot, poolStatus, poolLease, poolDone, poolConfig,
  nodePower, readPubkey, vmListLines, textOf,
} from './vm.js';

/** Split argv into positionals and --flag value pairs. */
export function splitFlags(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const asLines = (t) => String(t).split('\n');
export const VM_USAGE = 'Usage: /vm <list|info|doctor|start|stop|reboot|shutdown|snapshot|pool|node> <target> [args]';

export async function runVmCommand({ client, orgId, argv, exec: injected }) {
  const exec = injected || makeExec({ client, orgId });
  const { pos, flags } = splitFlags(argv || []);
  const [verb, ...rest] = pos;
  const reason = typeof flags.reason === 'string' ? flags.reason : undefined;
  const need = (v, what) => { if (!v) throw new Error(`${what} is required. ${VM_USAGE}`); return v; };
  try {
    if (!verb) return { lines: [VM_USAGE], tone: 'warn' };
    if (verb === 'list') {
      return { lines: vmListLines(await listVms(exec, { node: flags.node, type: flags.type })) };
    }
    if (verb === 'info') {
      const { vm, resources } = await vmInfo(exec, need(rest[0], 'a VM name or vmid'));
      return { lines: [`${vm.name || vm.vmid}  vmid ${vm.vmid}  node ${vm.node}  ${vm.type}`, ...asLines(textOf(resources))] };
    }
    if (verb === 'doctor') {
      const report = await vmDoctor(exec, need(rest[0], 'a VM name or vmid'));
      return { lines: doctorLines(report), tone: report.verdict === 'healthy' ? undefined : 'warn' };
    }
    if (VM_ACTIONS.includes(verb)) {
      const { vm, result } = await vmAction(exec, verb, need(rest[0], 'a VM name or vmid'), { reason });
      return { lines: [`${verb} ${vm.name || vm.vmid} (vmid ${vm.vmid} on ${vm.node})`, ...asLines(textOf(result))] };
    }
    if (verb === 'snapshot') {
      const { vm, result } = await vmSnapshot(exec, need(rest[0], 'a VM name or vmid'), { name: typeof flags.name === 'string' ? flags.name : undefined, reason });
      return { lines: [`snapshot ${vm.name || vm.vmid} (vmid ${vm.vmid})`, ...asLines(textOf(result))] };
    }
    if (verb === 'pool') {
      const sub = rest[0];
      if (sub === 'status') return { lines: asLines(textOf(await poolStatus(exec))) };
      if (sub === 'lease') {
        const pubkey = readPubkey(typeof flags['pubkey-file'] === 'string' ? flags['pubkey-file'] : undefined);
        const p = await poolLease(exec, {
          lessee: flags.lessee, pubkey, cores: flags.cores, memoryGb: flags['memory-gb'],
          diskGb: flags['disk-gb'], purpose: flags.purpose, reason,
        });
        return { lines: asLines(textOf(p)) };
      }
      if (sub === 'done') return { lines: asLines(textOf(await poolDone(exec, need(rest[1], 'a vmid'), { reason }))) };
      if (sub === 'config') {
        let input = {};
        if (flags.set) { try { input = JSON.parse(flags.set); } catch { throw new Error('--set must be a JSON object'); } }
        return { lines: asLines(textOf(await poolConfig(exec, input, { reason }))) };
      }
      return { lines: ['Usage: /vm pool <status|lease|done <vmid>|config>'], tone: 'warn' };
    }
    if (verb === 'node') {
      const [action, name] = rest;
      if (!NODE_ACTIONS.includes(action)) return { lines: ['Usage: /vm node <reboot|shutdown> <node>'], tone: 'warn' };
      return { lines: asLines(textOf(await nodePower(exec, action, need(name, 'a node name'), { reason }))) };
    }
    return { lines: [`Unknown /vm verb "${verb}". ${VM_USAGE}`], tone: 'warn' };
  } catch (e) {
    if (e instanceof VmPendingError) return { lines: [pendingHint(e)], tone: 'warn' };
    throw e;
  }
}
