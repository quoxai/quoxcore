/**
 * C4: snapshots = DB + config, taken before every update, restored by rollback.
 *
 * <backups>/<stamp>-<release>-<commit>/
 *   manifest.json     written LAST with complete:true; a dir without it is not a snapshot
 *   postgres.sql      pg_dumpall from the running postgres service
 *   volumes/<v>.tgz   every other compose volume (the SQLite stores), tarred with the stack stopped
 *   config/.env, config/ssl/, config/docker-compose.override.yml (mode 0600 / as found)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readEnvKeys } from './install.js';
import { compose } from './status.js';

export const HELPER_IMAGE = 'alpine:3.20';
const CONFIG_ITEMS = ['.env', 'ssl', 'docker-compose.override.yml'];

export function listSnapshots(backups) {
  let names = [];
  try { names = readdirSync(backups); } catch { return []; }
  return names.map((n) => {
    const dir = join(backups, n);
    try { const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); return m?.complete ? { ...m, dir } : null; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
export const latestSnapshot = (backups) => listSnapshots(backups)[0] || null;

const stampOf = (d) => d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');

/**
 * The stack's volumes, from the containers' own mounts (compose volumes carry fixed `name:`s whose project
 * label depends on who created them first, so a label filter misses some, postgres included, on real boxes).
 * -> { volumes: [names], pgVolume: name|null }
 */
export async function stackVolumes(install, run) {
  const ids = await run('docker', compose(install, ['ps', '-a', '-q']), { cwd: install.repoDir });
  const list = ids.code === 0 ? ids.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (!list.length) return { volumes: [], pgVolume: null };
  const r = await run('docker', ['inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}>{{.Destination}};{{end}}{{end}}', ...list]);
  if (r.code !== 0) return { volumes: [], pgVolume: null };
  const seen = new Map();
  for (const part of r.stdout.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const [name, dest] = part.split('>');
    if (name && !seen.has(name)) seen.set(name, dest || '');
  }
  const volumes = [...seen.keys()].sort();
  return { volumes, pgVolume: volumes.find((v) => seen.get(v) === '/var/lib/postgresql/data') || null };
}

/**
 * -> { ok, dir, manifest } | { ok:false, error }. g = gate(sys, { dryRun }).
 * Order: dump postgres live, stop the stack, tar the other volumes, start the stack again.
 */
export async function createSnapshot({ install, installed, backups, g, reason = 'manual', now = () => new Date(), log = () => {} }) {
  const createdAt = now();
  const dir = join(backups, `${stampOf(createdAt)}-${installed.release || 'unknown'}-${installed.commit || 'nocommit'}`);
  const pgUser = readEnvKeys(install.repoDir, ['POSTGRES_USER']).POSTGRES_USER || 'quoxflow';
  const { volumes, pgVolume } = await stackVolumes(install, g.ro);
  const tarVolumes = volumes.filter((v) => v !== pgVolume);
  const cfg = CONFIG_ITEMS.filter((f) => existsSync(join(install.repoDir, f)));

  await g.fx(`create ${dir}`, () => mkdirSync(join(dir, 'volumes'), { recursive: true, mode: 0o700 }));
  await g.fx(`copy config (${cfg.join(', ') || 'nothing found'}) to ${join(dir, 'config')}`, () => {
    mkdirSync(join(dir, 'config'), { recursive: true, mode: 0o700 });
    for (const f of cfg) cpSync(join(install.repoDir, f), join(dir, 'config', f), { recursive: true, preserveTimestamps: true });
  });
  let postgres = null;
  if (pgVolume) {
    const r = await g.mut('docker', compose(install, ['exec', '-T', 'postgres', 'pg_dumpall', '-U', pgUser]), { cwd: install.repoDir, stdoutFile: join(dir, 'postgres.sql') });
    if (r.code !== 0) return { ok: false, error: `pg_dumpall failed (exit ${r.code}): ${(r.stderr || '').trim().split('\n').pop()}` };
    postgres = 'postgres.sql';
  }
  if (tarVolumes.length) {
    const s = await g.mut('docker', compose(install, ['stop']), { cwd: install.repoDir });
    if (s.code !== 0) return { ok: false, error: `docker compose stop failed (exit ${s.code})` };
    try {
      for (const v of tarVolumes) {
        const r = await g.mut('docker', ['run', '--rm', '-v', `${v}:/v:ro`, '-v', `${join(dir, 'volumes')}:/b`, HELPER_IMAGE, 'tar', 'czf', `/b/${v}.tgz`, '-C', '/v', '.']);
        if (r.code !== 0) return { ok: false, error: `could not archive volume ${v} (exit ${r.code})` };
      }
    } finally {
      await g.mut('docker', compose(install, ['start']), { cwd: install.repoDir });
    }
  }
  const manifest = {
    version: 1, complete: true, createdAt: createdAt.toISOString(), reason,
    release: installed.release, commit: installed.commit, tag: installed.tag || null, siblings: installed.siblings || {},
    project: install.project, repoDir: install.repoDir, root: install.root,
    config: cfg, postgres, postgresUser: pgUser, pgVolume, volumes: tarVolumes
  };
  await g.fx(`write ${join(dir, 'manifest.json')} (marks the snapshot complete)`, () => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }));
  return { ok: true, dir, manifest };
}

/** Restore data + config from a snapshot into the install. Caller has already checked out the code and built. */
export async function restoreSnapshot({ install, snap, g, pgReadyTries = 30, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const dc = (args, opts = {}) => g.mut('docker', compose(install, args), { cwd: install.repoDir, ...opts });
  await g.fx(`restore config (${(snap.config || []).join(', ') || 'none'}) from ${snap.dir}`, () => {
    for (const f of snap.config || []) cpSync(join(snap.dir, 'config', f), join(install.repoDir, f), { recursive: true, force: true, preserveTimestamps: true });
  });
  let r = await dc(['down', '--remove-orphans']);
  if (r.code !== 0) return { ok: false, error: `docker compose down failed (exit ${r.code})` };
  for (const v of snap.volumes || []) {
    r = await g.mut('docker', ['run', '--rm', '-v', `${v}:/v`, '-v', `${join(snap.dir, 'volumes')}:/b:ro`, HELPER_IMAGE, 'sh', '-c', `find /v -mindepth 1 -delete && tar xzf /b/${basename(v)}.tgz -C /v`]);
    if (r.code !== 0) return { ok: false, error: `could not restore volume ${v} (exit ${r.code})` };
  }
  if (snap.postgres && snap.pgVolume) {
    r = await g.mut('docker', ['volume', 'rm', snap.pgVolume]);
    if (r.code !== 0) return { ok: false, error: `could not reset ${snap.pgVolume} (exit ${r.code})` };
    r = await dc(['up', '-d', 'postgres']);
    if (r.code !== 0) return { ok: false, error: `could not start postgres (exit ${r.code})` };
    if (!g.dryRun) {
      let ready = false;
      for (let i = 0; i < pgReadyTries && !ready; i++) {
        const p = await g.ro('docker', compose(install, ['exec', '-T', 'postgres', 'pg_isready', '-U', snap.postgresUser || 'quoxflow']), { cwd: install.repoDir });
        ready = p.code === 0; if (!ready) await sleep(2000);
      }
      if (!ready) return { ok: false, error: 'postgres did not become ready to restore into' };
    }
    r = await dc(['exec', '-T', 'postgres', 'psql', '-q', '-U', snap.postgresUser || 'quoxflow', '-d', 'postgres'], { stdinFile: join(snap.dir, snap.postgres) });
    if (r.code !== 0) return { ok: false, error: `psql restore failed (exit ${r.code})` };
  }
  return { ok: true };
}

export function snapshotSize(dir) {
  let n = 0;
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else n += s.size; } };
  try { walk(dir); } catch { /* best effort */ }
  return n;
}
