/**
 * C4: `quox server uninstall`. Lists exactly what goes first; two-step confirmation (the command layer);
 * keeps backups unless --purge, and takes a final snapshot first unless --no-backup or --purge.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SIBLINGS } from './install.js';
import { compose, composeServices } from './status.js';
import { createSnapshot, listSnapshots, stackVolumes } from './snapshot.js';
import { readInstalled } from './install.js';
import { gate } from './sys.js';

const DANGEROUS = (p, home) => {
  const r = resolve(p);
  return r === '/' || r === resolve(home) || r.split('/').filter(Boolean).length < 2;
};

/** Everything that will be removed and kept. Read-only. */
export async function planUninstall({ install, sys, backups, purge = false, journeyFile = join(homedir(), '.config', 'quox', 'onboarding.json'), home = homedir() }) {
  const svc = await composeServices(install, sys);
  const vols = await stackVolumes(install, (c, a, o) => sys.run(c, a, o));
  const imgs = await sys.run('docker', compose(install, ['config', '--images']), { cwd: install.repoDir });
  const dirs = [install.repoDir, ...SIBLINGS.map((s) => join(install.root, s)).filter((d) => existsSync(d))];
  const refused = dirs.filter((d) => DANGEROUS(d, home));
  let rootToo = false;
  try { rootToo = !DANGEROUS(install.root, home) && readdirSync(install.root).every((f) => dirs.includes(join(install.root, f))); } catch { /* unreadable */ }
  const snaps = listSnapshots(backups);
  const backupsInside = dirs.some((d) => resolve(backups).startsWith(resolve(d) + '/')) || (rootToo && resolve(backups).startsWith(resolve(install.root) + '/'));
  return {
    backupsInside,
    containers: svc.ok ? svc.services.map((s) => s.name) : [],
    containersError: svc.ok ? null : svc.error,
    volumes: vols.volumes,
    images: imgs.code === 0 ? [...new Set(imgs.stdout.split('\n').map((s) => s.trim()).filter(Boolean))] : [],
    networks: `the ${install.project} compose networks`,
    dirs: dirs.filter((d) => !refused.includes(d)),
    root: rootToo ? install.root : null,
    refused,
    journeyFile: existsSync(journeyFile) ? journeyFile : null,
    backups: { dir: backups, count: snaps.length, removed: purge }
  };
}

/** Executes the plan. Confirmation is the caller's job and must have happened already. */
export async function runUninstall({ install, sys, backups, purge = false, noBackup = false, dryRun = false, log = () => {}, plan, now }) {
  const g = gate(sys, { dryRun, log });
  if (plan.backupsInside && !purge) return { ok: false, step: 'plan', error: `the backups directory ${backups} sits inside the install, so removing the install would delete them. Set QUOX_SERVER_BACKUPS to a path outside it, or pass --purge.` };
  let finalSnapshot = null;
  if (!noBackup && !purge) {
    const installed = await readInstalled(install, sys);
    const snap = await createSnapshot({ install, installed, backups, g, reason: 'before uninstall', now, log });
    if (!snap.ok) return { ok: false, step: 'backup', error: `${snap.error}. Nothing was removed; pass --no-backup to uninstall without a final snapshot.` };
    finalSnapshot = snap.dir;
  }
  const r = await g.mut('docker', compose(install, ['down', '--volumes', '--rmi', 'local', '--remove-orphans']), { cwd: install.repoDir });
  if (r.code !== 0) return { ok: false, step: 'down', error: `docker compose down failed (exit ${r.code}); the install directory was left in place` };
  for (const d of plan.dirs) await g.fx(`remove ${d}`, () => rmSync(d, { recursive: true, force: true }));
  if (plan.root) await g.fx(`remove ${plan.root} (now empty)`, () => rmSync(plan.root, { recursive: true, force: true }));
  if (plan.journeyFile) await g.fx(`remove ${plan.journeyFile}`, () => rmSync(plan.journeyFile, { force: true }));
  if (purge) await g.fx(`remove every backup in ${backups}`, () => rmSync(backups, { recursive: true, force: true }));
  return { ok: true, dryRun, finalSnapshot, planned: g.planned };
}
