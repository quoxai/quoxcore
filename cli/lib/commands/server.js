/**
 * quox server: lifecycle of a local self-hosted install (plan C4).
 *
 *   status     version, health per service, disk, ports, last update (read-only)
 *   update     current -> latest public quoxcore tag; backup first; fetch, build, migrate, health;
 *              auto-rollback on failure; resumable; --dry-run prints the plan and runs nothing
 *   rollback   previous snapshot + previous version; --dry-run
 *   uninstall  lists exactly what goes, two-step confirmation, keeps backups unless --purge; --dry-run
 *   doctor     the quox doctor checks + server-side checks (read-only)
 *   diag       a redacted support bundle written locally (allowlist redaction), never uploaded
 *
 * Every mutating host command goes through lib/server/sys.js gate(): in a dry run it is printed, never run.
 * The install is the one Getting started recorded (or --dir / QUOX_INSTALL_DIR / the running containers).
 */
import chalk from 'chalk';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { resolveEndpoint } from '../api/endpoints.js';
import { createSys } from '../server/sys.js';
import { resolveInstall, backupsRoot, readInstalled, fetchAvailable, cmpSemver, vtag, compareUrl, releaseNotesUrl } from '../server/install.js';
import { gatherStatus, statusRows, defaultUrls } from '../server/status.js';
import { runUpdate, runRollback, UPDATE_STEPS } from '../server/update.js';
import { planUninstall, runUninstall } from '../server/uninstall.js';
import { serverChecks } from '../server/doctor.js';
import { writeDiagBundle } from '../server/diag.js';
import { latestSnapshot, listSnapshots } from '../server/snapshot.js';

const icon = (s) => (s === 'pass' ? chalk.green('✔') : s === 'warn' ? chalk.yellow('⚠') : s === 'skip' ? chalk.dim('·') : chalk.red('✖'));

/** Pure: is the two-step uninstall confirmation satisfied? */
export function uninstallConfirmed({ word, path, root }) {
  return String(word || '').trim() === 'uninstall' && resolve(String(path || '').trim() || '/nonexistent') === resolve(root);
}

function printRows(rows, out = console.log) {
  for (const r of rows) {
    if (r.kind === 'head') out(chalk.bold(`\n ${r.text}`));
    else if (r.kind === 'gap') out('');
    else if (r.kind === 'dim') out(chalk.dim(` ${r.key ? `${String(r.key).padEnd(16)} ` : ''}${r.text}`));
    else out(` ${String(r.key).padEnd(16)} ${r.text}`);
  }
  out('');
}

export function registerServerCommands(program, ctx = {}) {
  const deps = ctx.serverDeps || {};
  const env = deps.env || process.env;
  const sys = deps.sys || createSys();
  const fetchImpl = deps.fetchImpl || ((...a) => globalThis.fetch(...a));
  const backups = deps.backups || backupsRoot(env);
  const log = deps.log || ((l) => console.log(chalk.dim(`  ${l}`)));
  const ask = deps.ask || (async (message) => {
    const { default: inquirer } = await import('inquirer');
    const a = await inquirer.prompt([{ type: 'input', name: 'v', message }]);
    return a.v;
  });
  const isTTY = deps.isTTY ?? (() => Boolean(process.stdin.isTTY));
  const urls = () => deps.urls || defaultUrls(ctx.config);
  const json = () => program.opts().output === 'json' || program.opts().json;
  const dry = (o) => Boolean(o.dryRun || program.opts().dryRun);
  const yes = (o) => Boolean(o.yes || program.opts().yes);

  async function install(o) {
    const i = await resolveInstall({ dir: o.dir, env, sys, journey: deps.journey });
    if (i.error) { const e = new Error(i.error); e.exitCode = 2; throw e; }
    return i;
  }

  const server = program.command('server').description('Your self-hosted Quox install: status, update, rollback, uninstall, doctor, diag');
  const withDir = (c) => c.option('--dir <path>', 'the install directory (default: the one Getting started recorded)');

  withDir(server.command('status').description('Version, health per service, disk, ports and the last update (read-only)'))
    .action(async (o) => {
      const i = await install(o);
      const st = await gatherStatus({ install: i, sys, fetchImpl, urls: urls(), backups });
      if (json()) { console.log(JSON.stringify(st, null, 2)); return; }
      printRows(statusRows(st));
      if (!st.http.every((h) => h.ok) || (st.services.ok && st.services.services.some((s) => s.state !== 'running'))) process.exitCode = 1;
    });

  withDir(server.command('update').description('Update to the latest release: backup first, then fetch, build, migrate, health; rolls back on failure'))
    .option('--dry-run', 'print the plan and run nothing')
    .option('--to <version>', 'a specific release (default: the latest quoxcore tag)')
    .option('--force', 'proceed despite local changes or low disk, or re-apply the same version')
    .option('--restart', 'abandon a stopped update to a different version and start this one')
    .option('--no-rollback', 'on failure, stop where it failed instead of rolling back')
    .option('-y, --yes', 'skip the confirmation')
    .action(async (o) => {
      const i = await install(o);
      const dryRun = dry(o);
      if (!dryRun && !yes(o)) {
        const installed = await readInstalled(i, sys);
        let target = o.to ? vtag(o.to) : null;
        if (!target) { const av = await fetchAvailable({ fetchImpl }); if (!av.ok) throw new Error(`could not read the available versions: ${av.error}`); target = av.latest; }
        const cur = installed.release ? vtag(installed.release) : '?';
        if (cmpSemver(target, cur) !== null && cmpSemver(target, cur) <= 0 && !o.force) { console.log(`Already on ${cur} (latest is ${target}). Nothing to do.`); return; }
        console.log(`\n Update ${cur} -> ${chalk.bold(target)} at ${i.repoDir}`);
        console.log(` Changes: ${installed.release ? compareUrl(cur, target) : releaseNotesUrl(target)}`);
        console.log(` A backup (database + config) is taken first, into ${backups}. The stack stops briefly while volumes are archived.`);
        console.log(' Preview every command first with: quox server update --dry-run\n');
        if (!isTTY()) throw new Error('quox server update needs confirmation; re-run with --yes in a non-interactive shell');
        const a = await ask(`Type "update" to update to ${target}`);
        if (String(a).trim() !== 'update') { console.log('Not updated. Nothing was changed.'); return; }
      }
      const r = await runUpdate({ install: i, sys, backups, urls: urls(), fetchImpl, dryRun, to: o.to, force: o.force, restart: o.restart, noRollback: o.rollback === false, log });
      if (json()) { console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 2; return; }
      const p = r.plan || {};
      if (r.upToDate) { console.log(`Already on ${p.current} (latest is ${p.target}). Nothing to do.`); return; }
      if (dryRun && r.ok) {
        console.log(chalk.bold(`\n Plan: ${p.current || '?'} (${p.currentCommit || '?'}) -> ${p.target}${p.targetCommit ? ` (${p.targetCommit})` : ''}`));
        if (p.changes) console.log(` What changes: ${p.changes}`);
        console.log(` Release notes: ${p.releaseNotes} (if published for this tag)`);
        if (p.resumedAfter) console.log(` Resumes after: ${p.resumedAfter}`);
        console.log(` Steps: ${UPDATE_STEPS.join(' -> ')}; on failure it rolls back automatically.`);
        if (p.problems?.length) for (const x of p.problems) console.log(chalk.yellow(` ⚠ ${x}`));
        console.log(chalk.dim(`\n Dry run: ${r.planned.length} changes listed above, none made. Re-run without --dry-run to update.\n`));
        return;
      }
      if (r.ok) { console.log(chalk.green(`\n ✔ Updated to ${p.target}. Backup: ${p.snapshot}\n`)); return; }
      process.exitCode = 2;
      console.log(chalk.red(`\n ✖ Update failed at ${r.failedStep}: ${r.error}`));
      if (r.rollback) console.log(r.rolledBack ? chalk.yellow(` Rolled back (${r.rollback.scope}); you are on ${p.current} again.`) : chalk.red(` Rollback did not complete: ${r.rollback.error}. Backup: ${p.snapshot}. Run quox server rollback.`));
      else if (r.failedStep !== 'preflight' && r.failedStep !== 'backup') console.log(` Not rolled back. Re-run quox server update to resume, or quox server rollback.`);
      console.log('');
    });

  withDir(server.command('rollback').description('Restore the previous snapshot and version (database, config, code)'))
    .option('--dry-run', 'print the plan and run nothing')
    .option('--snapshot <dir>', 'a specific snapshot (default: the latest)')
    .option('--list', 'list the snapshots and exit')
    .option('-y, --yes', 'skip the confirmation')
    .action(async (o) => {
      if (o.list) {
        const s = listSnapshots(backups);
        if (json()) { console.log(JSON.stringify(s, null, 2)); return; }
        if (!s.length) { console.log(`No snapshots in ${backups}.`); return; }
        for (const x of s) console.log(` ${x.createdAt}  ${String(x.release || '?').padEnd(8)} ${String(x.commit || '?').padEnd(10)} ${x.reason}  ${x.dir}`);
        return;
      }
      const i = await install(o);
      const dryRun = dry(o);
      const snap = o.snapshot ? listSnapshots(backups).find((s) => s.dir === o.snapshot || s.dir.endsWith(`/${o.snapshot}`)) : latestSnapshot(backups);
      if (!snap) throw new Error(o.snapshot ? `no complete snapshot at ${o.snapshot}` : `no snapshot in ${backups}; nothing to roll back to`);
      if (!dryRun && !yes(o)) {
        console.log(`\n Roll back to ${snap.release || '?'} (${snap.commit}) from ${snap.createdAt}.`);
        console.log(chalk.yellow(' This REPLACES the current database and config with the snapshot; anything since then is lost.'));
        console.log(' Preview first with: quox server rollback --dry-run\n');
        if (!isTTY()) throw new Error('quox server rollback needs confirmation; re-run with --yes in a non-interactive shell');
        const a = await ask('Type "rollback" to continue');
        if (String(a).trim() !== 'rollback') { console.log('Not rolled back. Nothing was changed.'); return; }
      }
      const r = await runRollback({ install: i, sys, backups, urls: urls(), fetchImpl, dryRun, snapshotDir: snap.dir, log });
      if (json()) { console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 2; return; }
      if (r.ok && dryRun) { console.log(chalk.dim(`\n Dry run: rollback to ${snap.release || snap.commit} from ${snap.dir}; ${r.planned.length} changes listed above, none made.\n`)); return; }
      if (r.ok) { console.log(chalk.green(`\n ✔ Rolled back to ${snap.release || snap.commit}.\n`)); return; }
      process.exitCode = 2;
      console.log(chalk.red(`\n ✖ Rollback failed at ${r.step}: ${r.error}\n`));
    });

  withDir(server.command('uninstall').description('Remove this install (lists everything first; keeps backups unless --purge)'))
    .option('--dry-run', 'list what would be removed and run nothing')
    .option('--purge', 'also delete every backup')
    .option('--no-backup', 'skip the final snapshot')
    .option('-y, --yes', 'non-interactive: confirm step one (needs --confirm too)')
    .option('--confirm <path>', 'non-interactive: confirm step two by naming the install directory')
    .action(async (o) => {
      const i = await install(o);
      const dryRun = dry(o);
      const plan = await planUninstall({ install: i, sys, backups, purge: Boolean(o.purge), home: deps.home || homedir() });
      if (json() && dryRun) { console.log(JSON.stringify({ plan }, null, 2)); return; }
      console.log(chalk.bold('\n This removes:'));
      console.log(` Containers (${plan.containers.length}): ${plan.containers.join(', ') || plan.containersError || 'none'}`);
      console.log(` Volumes, with ALL their data (${plan.volumes.length}): ${plan.volumes.join(', ') || 'none'}`);
      console.log(` Images built for this install (${plan.images.length}): ${plan.images.join(', ') || 'none'}`);
      console.log(` Networks: ${plan.networks}`);
      console.log(` Directories: ${[...plan.dirs, ...(plan.root ? [plan.root] : [])].join(', ')}`);
      if (plan.journeyFile) console.log(` Getting started state: ${plan.journeyFile}`);
      if (plan.refused.length) console.log(chalk.yellow(` Refusing to remove (too broad): ${plan.refused.join(', ')}`));
      console.log(chalk.bold(' It keeps:'));
      console.log(plan.backups.removed ? chalk.red(` Nothing: --purge also deletes ${plan.backups.count} backup(s) in ${plan.backups.dir}`)
        : ` Backups in ${plan.backups.dir} (${plan.backups.count} now${o.backup === false ? '' : ', plus a final snapshot taken first'})`);
      console.log('');
      if (!dryRun) {
        let ok;
        if (isTTY() && !(yes(o) && o.confirm)) {
          const w = await ask('Step 1 of 2: type "uninstall" to continue');
          if (String(w).trim() !== 'uninstall') { console.log('Not uninstalled. Nothing was changed.'); return; }
          const p = await ask(`Step 2 of 2: type the install directory (${i.root}) to confirm`);
          ok = uninstallConfirmed({ word: 'uninstall', path: p, root: i.root });
        } else ok = yes(o) && uninstallConfirmed({ word: 'uninstall', path: o.confirm, root: i.root });
        if (!ok) {
          if (!isTTY()) throw new Error(`quox server uninstall needs two confirmations; in a non-interactive shell pass --yes and --confirm ${i.root}`);
          console.log('The directory did not match. Not uninstalled. Nothing was changed.');
          return;
        }
      }
      const r = await runUninstall({ install: i, sys, backups, purge: Boolean(o.purge), noBackup: o.backup === false, dryRun, log, plan });
      if (json()) { console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 2; return; }
      if (!r.ok) { process.exitCode = 2; console.log(chalk.red(` ✖ Uninstall stopped at ${r.step}: ${r.error}\n`)); return; }
      if (dryRun) { console.log(chalk.dim(` Dry run: ${r.planned.length} changes listed above, none made.\n`)); return; }
      console.log(chalk.green(` ✔ Uninstalled.${r.finalSnapshot ? ` Final snapshot: ${r.finalSnapshot}` : ''}\n`));
    });

  withDir(server.command('doctor').description('The quox doctor checks plus server-side checks (read-only)'))
    .action(async (o) => {
      const i = await install(o);
      const { runDoctorChecks } = await import('./doctor.js');
      const platform = deps.platformChecks ? await deps.platformChecks() : await runDoctorChecks({ config: ctx.config });
      const srv = await serverChecks({ install: i, sys, fetchImpl, urls: urls(), backups });
      const all = [...platform, ...srv];
      const failed = all.filter((c) => c.status === 'fail' || c.status === 'error').length;
      const warned = all.filter((c) => c.status === 'warn').length;
      if (json()) { console.log(JSON.stringify({ platform, server: srv, summary: { failed, warnings: warned } }, null, 2)); }
      else {
        console.log(chalk.bold('\n Platform'));
        for (const c of platform) console.log(` ${icon(c.status)} ${String(c.name).padEnd(20)} ${chalk.dim(c.detail || '')}`);
        console.log(chalk.bold('\n Server'));
        for (const c of srv) console.log(` ${icon(c.status)} ${String(c.name).padEnd(20)} ${chalk.dim(c.detail || '')}`);
        console.log(`\n ${all.length - failed - warned} passed · ${warned} warnings · ${failed} failed\n`);
      }
      process.exitCode = failed ? 2 : warned ? 1 : 0;
    });

  withDir(server.command('diag').description('Write a redacted support bundle locally (never uploaded)'))
    .option('--out <dir>', 'where to write it (default: the current directory)')
    .action(async (o) => {
      const i = await install(o);
      const { runDoctorChecks } = await import('./doctor.js');
      const { resolveCliVersion } = await import('../core/version.js');
      const st = await gatherStatus({ install: i, sys, fetchImpl, urls: urls(), backups });
      const platform = deps.platformChecks ? await deps.platformChecks() : await runDoctorChecks({ config: ctx.config }).catch(() => []);
      const srv = await serverChecks({ install: i, sys, fetchImpl, urls: urls(), backups });
      const r = await writeDiagBundle({
        install: i, sys, out: resolve(o.out || process.cwd()),
        data: { versions: { cli: resolveCliVersion(), installed: st.installed, running: st.running }, status: st, doctor: [...platform, ...srv] }
      });
      if (json()) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(chalk.green(`\n ✔ Support bundle written: ${r.file}`));
      console.log(chalk.dim(' Nothing was uploaded. Secrets are kept out by an allowlist; look through it before you share it.\n'));
    });

  // `quox server config app-url [url]`: read or set the public app URL (instance_config app_base_url).
  // Server-side source of truth, the same value Settings > General > App URL edits.
  const cfg = server.command('config').description('Instance settings stored on the server');
  cfg.command('app-url')
    .description('Show or set the public app URL (used in sign-in links and emails). Pass a URL to set it, or --clear to fall back to the environment value')
    .argument('[url]', 'the new public app URL, e.g. https://quox.example.com')
    .option('--clear', 'remove the stored value')
    .action(async (url, o) => {
      const { client, auth } = ctx;
      auth?.requireAuth?.();
      const get = resolveEndpoint('admin.instance.basics.get');
      const set = resolveEndpoint('admin.instance.basics.set');
      if (url && o.clear) { const e = new Error('give a URL or --clear, not both'); e.exitCode = 2; throw e; }
      if (url || o.clear) {
        const r = await client.put(set.path, { service: set.service, body: { appBaseUrl: o.clear ? null : url } });
        if (json()) { console.log(JSON.stringify(r, null, 2)); return; }
        console.log(chalk.green(o.clear ? ' ✔ App URL cleared; using the environment value.' : ` ✔ App URL set to ${url}`));
        console.log(chalk.dim(` Effective now: ${r.effective?.appBaseUrl}\n`));
        return;
      }
      const r = await client.get(get.path, { service: get.service });
      if (json()) { console.log(JSON.stringify(r, null, 2)); return; }
      const src = r.effective?.appBaseUrlSource === 'instance_config' ? 'set on this server' : 'from the environment (not set in Settings)';
      console.log(`${r.effective?.appBaseUrl} ${chalk.dim(`(${src})`)}`);
    });

  // `quox server config lan-targets [on|off]`: let integrations (Ollama, LM Studio, vLLM, Grafana ...)
  // point at private-network addresses. Default off. Loopback and link-local stay blocked either way.
  cfg.command('lan-targets')
    .description('Show or set whether AI servers and integrations on your own private network are allowed (default off)')
    .argument('[state]', 'on or off')
    .action(async (state) => {
      const { client, auth } = ctx;
      auth?.requireAuth?.();
      const get = resolveEndpoint('admin.instance.lan_targets.get');
      const set = resolveEndpoint('admin.instance.lan_targets.set');
      if (state !== undefined && !['on', 'off'].includes(String(state).toLowerCase())) { const e = new Error('give on or off'); e.exitCode = 2; throw e; }
      if (state !== undefined) {
        const r = await client.put(set.path, { service: set.service, body: { enabled: String(state).toLowerCase() === 'on' } });
        if (json()) { console.log(JSON.stringify(r, null, 2)); return; }
        console.log(chalk.green(r.enabled ? ' ✔ Private-network targets are ON: integrations may use addresses on your own network.' : ' ✔ Private-network targets are OFF.'));
        console.log(chalk.dim(' Loopback (localhost) and link-local addresses stay blocked either way.\n'));
        return;
      }
      const r = await client.get(get.path, { service: get.service });
      if (json()) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`Private-network targets: ${r.enabled ? 'on' : 'off'} ${chalk.dim('(quox server config lan-targets on|off)')}`);
    });

  return server;
}
