/**
 * `quox offload` : run a heavy command on a pool worker VM and behave like running it locally.
 *
 *   quox offload [--dir <path>] [--fresh] [--keep] [--cores N --memory-gb N --disk-gb N] -- <command...>
 *   quox offload status
 *   quox offload release
 *
 * Engine: lib/core/offload.js. The worker is leased through the human pool REST API
 * (same as `quox vm pool lease`) with a dedicated key at ~/.config/quox/offload_ed25519.
 */

import path from 'node:path';
import { printInfo } from '../core/output.js';
import { makePoolRest } from '../core/vm.js';
import { OffloadError, realDeps, runOffload, releaseWorker, workerStatus, gitToplevel, WORKER_NAME_RE } from '../core/offload.js';

export function registerOffloadCommands(program, ctx, { deps: injected } = {}) {
  const { client, auth } = ctx;
  const json = () => program.opts().output === 'json';
  const base = () => injected || realDeps({ rest: makePoolRest({ client }) });
  // --worker <name> / QUOX_OFFLOAD_WORKER: your own worker (state, lease, size), not the box's shared one.
  const mk = (options = {}) => {
    const d = base();
    const name = options.worker ?? d.env?.QUOX_OFFLOAD_WORKER;
    if (name !== undefined && name !== '' && !WORKER_NAME_RE.test(String(name))) {
      throw new OffloadError(`worker name must be lowercase letters, digits and dashes (up to 32), got ${JSON.stringify(name)}`);
    }
    return name ? Object.assign(Object.create(Object.getPrototypeOf(d)), d, { worker: String(name) }) : d;
  };
  const WORKER_HELP = 'use your own named worker (its own lease and size) instead of the shared one; or set QUOX_OFFLOAD_WORKER';

  const off = program
    .command('offload')
    .description('Run a heavy command on a pool worker VM (synced dir, cached npm ci, live output, same exit code)')
    .argument('[command...]', 'command to run remotely (put it after --)')
    .option('--dir <path>', 'directory to sync (default: git toplevel of the current directory)')
    .option('--fresh', 'release the current worker, lease a new one and reinstall dependencies')
    .option('--keep', 'leave the worker leased for reuse (the default; kept for compatibility)')
    .option('--cores <n>', 'vCPU cores for a newly leased worker')
    .option('--memory-gb <n>', 'memory in GB for a newly leased worker')
    .option('--disk-gb <n>', 'disk in GB for a newly leased worker')
    .option('--worker <name>', WORKER_HELP)
    .option('--docker', 'also give the worker Docker (user hyp in the docker group) and build the quox-sandbox images from the synced repo when they are missing or changed')
    .allowExcessArguments(true)
    .action(async (command, options) => {
      auth.requireAuth();
      const cwd = process.cwd();
      const dir = path.resolve(options.dir || gitToplevel(cwd));
      try {
        const code = await runOffload(mk(options), {
          dir, cwd, command, fresh: !!options.fresh, docker: !!options.docker,
          cores: options.cores, memoryGb: options.memoryGb, diskGb: options.diskGb,
        });
        process.exitCode = code;
      } catch (e) {
        if (!(e instanceof OffloadError)) throw e;
        process.stderr.write(`offload: ${e.message}\n`);
        process.exitCode = 1;
      }
    });

  off.command('status')
    .description('Show your offload worker: vmid, ip, lease expiry, synced dirs')
    .option('--worker <name>', WORKER_HELP)
    .action(async (options) => {
      auth.requireAuth();
      const s = await workerStatus(mk(options));
      if (json()) { console.log(JSON.stringify(s, null, 2)); return; }
      if (!s.worker) { printInfo('no offload worker leased (it is leased on the next `quox offload -- <command>`)'); return; }
      const w = s.worker;
      console.log(`worker ${w.vmid}  ${w.ip || '?'}  ${w.state}  lessee ${w.lessee}  lease expires ${w.lease_expires_at || '?'}`);
      for (const d of s.dirs) console.log(`  synced ${d.local} -> ${d.remote}  ${d.synced_at || ''}`);
    });

  off.command('release')
    .description('Release (destroy) your offload worker via the pool')
    .option('--worker <name>', WORKER_HELP)
    .action(async (options) => {
      auth.requireAuth();
      try {
        const vmid = await releaseWorker(mk(options));
        if (json()) console.log(JSON.stringify({ released: vmid }));
        else printInfo(vmid ? `released worker ${vmid}` : 'no offload worker to release');
      } catch (e) {
        process.stderr.write(`offload: release failed: ${e.message}\n`);
        process.exitCode = 1;
      }
    });
}
