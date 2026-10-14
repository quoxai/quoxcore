/**
 * C4: `quox server doctor` = the `quox doctor` checks (runDoctorChecks, extracted in f491a2394) plus the
 * server-side checks only the box itself can answer. All read-only. Same row shape as runDoctorChecks:
 * { name, status: 'pass'|'warn'|'fail'|'skip', detail }.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { envKeyNames, readInstalled } from './install.js';
import { composeServices, diskFree, runningVersion } from './status.js';
import { latestSnapshot } from './snapshot.js';

export const REQUIRED_ENV = ['JWT_SECRET', 'POSTGRES_PASSWORD', 'INTERNAL_SERVICE_KEY'];

export async function serverChecks({ install, sys, fetchImpl = globalThis.fetch, urls, backups, now = () => Date.now() }) {
  const out = [];
  const add = (name, status, detail) => out.push({ name, status, detail });

  const dk = await sys.run('docker', ['info', '--format', '{{.ServerVersion}}']);
  add('Docker engine', dk.code === 0 ? 'pass' : 'fail', dk.code === 0 ? `server ${dk.stdout.trim()}` : 'docker info failed (is the daemon running, is this user in the docker group?)');

  const svc = await composeServices(install, sys);
  if (!svc.ok) add('Compose services', 'fail', svc.error);
  else {
    const down = svc.services.filter((s) => s.state !== 'running');
    const sick = svc.services.filter((s) => s.state === 'running' && s.health && s.health !== 'healthy');
    add('Compose services', down.length ? 'fail' : sick.length ? 'warn' : 'pass',
      `${svc.services.length - down.length} of ${svc.services.length} running${down.length ? `; not running: ${down.map((s) => s.service).join(', ')}` : ''}${sick.length ? `; unhealthy: ${sick.map((s) => `${s.service} (${s.health})`).join(', ')}` : ''}`);
  }

  const disk = await diskFree(install.root, sys);
  add('Disk space', !disk.ok ? 'warn' : disk.freeGB < 2 ? 'fail' : disk.freeGB < 5 ? 'warn' : 'pass', disk.ok ? `${disk.freeGB} GB free at ${disk.path}` : disk.error);

  const keys = envKeyNames(install.repoDir);
  if (!keys) add('Config (.env)', 'fail', `no .env in ${install.repoDir}`);
  else {
    const missing = REQUIRED_ENV.filter((k) => !keys.includes(k));
    add('Config (.env)', missing.length ? 'fail' : 'pass', missing.length ? `missing ${missing.join(', ')}` : `${keys.length} keys, required ones present (values not read)`);
  }

  const cert = join(install.repoDir, 'ssl', 'quox.crt');
  if (!existsSync(cert)) add('TLS certificate', 'warn', `no ${cert}`);
  else {
    const r = await sys.run('openssl', ['x509', '-enddate', '-noout', '-in', cert]);
    const end = r.code === 0 ? Date.parse(r.stdout.replace(/^notAfter=/, '').trim()) : NaN;
    if (!Number.isFinite(end)) add('TLS certificate', 'warn', 'could not read its expiry (openssl)');
    else {
      const days = Math.floor((end - now()) / 86400000);
      add('TLS certificate', days < 0 ? 'fail' : days < 14 ? 'warn' : 'pass', days < 0 ? `expired ${-days} days ago` : `expires in ${days} days`);
    }
  }

  const installed = await readInstalled(install, sys);
  add('Checkout', installed.dirty ? 'warn' : installed.dirty === null ? 'warn' : 'pass',
    installed.dirty === null ? 'not a git checkout; quox server update cannot move it' : `${installed.release || '?'} at ${installed.commit}${installed.dirty ? ', with local changes (update will refuse without --force)' : ', clean'}`);

  const rv = await runningVersion(urls.collector, fetchImpl);
  if (!rv.ok) add('Running build', 'warn', `collector /version: ${rv.error}`);
  else if (rv.stamped === false) add('Running build', 'warn', 'the collector build is unstamped (0.0.0); rebuild with QUOXCORE_VERSION set');
  else {
    const same = installed.commit && rv.commit && (String(rv.commit).startsWith(installed.commit) || String(installed.commit).startsWith(rv.commit));
    add('Running build', same || !installed.commit ? 'pass' : 'warn', same ? `${rv.commit}, matches the checkout` : `running ${rv.commit}, checkout is ${installed.commit} (rebuilt since? quox server update rebuilds)`);
  }

  const snap = backups ? latestSnapshot(backups) : null;
  if (!snap) add('Backups', 'warn', `no snapshot yet in ${backups}; quox server update takes one first`);
  else {
    const days = Math.floor((now() - Date.parse(snap.createdAt)) / 86400000);
    add('Backups', days > 30 ? 'warn' : 'pass', `latest ${snap.createdAt} (${days} days ago, ${snap.release || snap.commit})`);
  }
  return out;
}
