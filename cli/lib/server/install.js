/**
 * C4 lifecycle: which install are we talking about, what version is it, what is available.
 *
 * Layout (get.quox.ai -> install.sh -> scripts/setup.sh): $QUOX_DIR/{quox,quoxflow,quoxmcp}; the quox
 * checkout holds docker-compose.yml, VERSION, .env and ssl/. Compose project = the checkout's dir name
 * (setup.sh runs `docker compose` there), unless the running containers say otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';

export const PUBLIC_REPO = 'quoxai/quoxcore';
export const SIBLINGS = ['quoxflow', 'quoxmcp'];

export function backupsRoot(env = process.env, home = homedir()) {
  if (env.QUOX_SERVER_BACKUPS) return resolve(env.QUOX_SERVER_BACKUPS);
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'quox', 'server-backups');
}

function normalize(p) {
  if (!p) return null;
  const abs = resolve(p);
  if (existsSync(join(abs, 'docker-compose.yml'))) return { repoDir: abs, root: dirname(abs) };
  if (existsSync(join(abs, 'quox', 'docker-compose.yml'))) return { repoDir: join(abs, 'quox'), root: abs };
  return null;
}

/** install.json that scripts/setup.sh writes: { dir } (the install root or the quox checkout). */
export function installRecordPath(env = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'quox', 'install.json');
}
function readRecordedDir(env, home) {
  try { const d = JSON.parse(readFileSync(installRecordPath(env, home), 'utf8'))?.dir; return typeof d === 'string' && d.startsWith('/') ? d : null; } catch { return null; }
}

/**
 * Where the install lives: --dir, then QUOX_INSTALL_DIR, then the Getting started journey
 * (~/.config/quox/onboarding.json installDir), then ~/.config/quox/install.json (written by setup.sh), then
 * the running containers' compose label, then the installer's default ~/quox-install.
 * -> { repoDir, root, project, source } | { error }
 */
export async function resolveInstall({ dir, env = process.env, sys, journey = null, home = homedir() } = {}) {
  if (dir) {
    const n = normalize(dir);
    if (!n) return { error: `${dir} is not a Quox install (no docker-compose.yml there or in ${join(dir, 'quox')})` };
    return { ...n, project: await projectFor(n.repoDir, sys), source: '--dir' };
  }
  if (env.QUOX_INSTALL_DIR) {
    const n = normalize(env.QUOX_INSTALL_DIR);
    if (n) return { ...n, project: await projectFor(n.repoDir, sys), source: 'QUOX_INSTALL_DIR' };
  }
  let j = journey;
  if (j === null) { try { const { loadJourney } = await import('../quoxon/onboarding/journey.js'); j = loadJourney(); } catch { j = null; } }
  if (j?.installDir) {
    const n = normalize(j.installDir);
    if (n) return { ...n, project: await projectFor(n.repoDir, sys), source: 'Getting started' };
  }
  const rec = normalize(readRecordedDir(env, home));
  if (rec) return { ...rec, project: await projectFor(rec.repoDir, sys), source: 'install.json' };
  if (sys) {
    const r = await sys.run('docker', ['inspect', 'quox-auth', '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project"}}']);
    if (r.code === 0) {
      const [wd, project] = r.stdout.trim().split('|');
      const n = normalize(wd);
      if (n) return { ...n, project: project || basename(n.repoDir), source: 'running containers' };
    }
  }
  const def = normalize(join(home, 'quox-install'));
  if (def) return { ...def, project: await projectFor(def.repoDir, sys), source: 'default ~/quox-install' };
  return { error: 'no Quox install found here. Pass --dir <path>, or set QUOX_INSTALL_DIR (setup.sh records it in ~/.config/quox/install.json).' };
}

async function projectFor(repoDir, sys) {
  if (sys) {
    const r = await sys.run('docker', ['inspect', 'quox-auth', '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project"}}']);
    if (r.code === 0) {
      const [wd, project] = r.stdout.trim().split('|');
      if (wd && resolve(wd) === repoDir && project) return project;
    }
  }
  return basename(repoDir);
}

/** Read named keys from .env. ALLOWLIST: only the keys asked for come back; nothing else is parsed out. */
export function readEnvKeys(repoDir, keys) {
  const out = {};
  let text = '';
  try { text = readFileSync(join(repoDir, '.env'), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && keys.includes(m[1])) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** Names only (never values) of every key in .env. */
export function envKeyNames(repoDir) {
  try {
    return readFileSync(join(repoDir, '.env'), 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=/.exec(l.trim())?.[1]).filter(Boolean);
  } catch { return null; }
}

/** -> { release, commit, tag, dirty, siblings: { quoxflow: commit|null, ... } } (read-only git). */
export async function readInstalled({ repoDir, root }, sys) {
  let release = null;
  try { release = readFileSync(join(repoDir, 'VERSION'), 'utf8').trim() || null; } catch { /* no VERSION */ }
  const git = async (dir, args) => { const r = await sys.run('git', ['-C', dir, ...args]); return r.code === 0 ? r.stdout.trim() : null; };
  const commit = await git(repoDir, ['rev-parse', '--short', 'HEAD']);
  const tag = await git(repoDir, ['describe', '--tags', '--exact-match', 'HEAD']);
  const porcelain = await git(repoDir, ['status', '--porcelain', '--untracked-files=no']);
  const siblings = {};
  for (const s of SIBLINGS) {
    const d = join(root, s);
    siblings[s] = existsSync(join(d, '.git')) ? await git(d, ['rev-parse', '--short', 'HEAD']) : null;
  }
  return { release, commit, tag, dirty: porcelain === null ? null : porcelain.length > 0, siblings };
}

export function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function cmpSemver(a, b) {
  const x = parseSemver(a); const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * Tags on the public repo (read-only, unauthenticated GitHub API). Status checked before parsing.
 * -> { ok: true, latest, tags } | { ok: false, error }
 */
export async function fetchAvailable({ fetchImpl = globalThis.fetch, repo = PUBLIC_REPO, timeoutMs = 8000 } = {}) {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
  let r;
  try { r = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'quox-cli' }, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { return { ok: false, error: `could not reach ${url}: ${e?.message || e}` }; }
  if (!r.ok) return { ok: false, error: `${url} answered HTTP ${r.status}` };
  let body;
  try { body = await r.json(); } catch { return { ok: false, error: `${url} did not return JSON` }; }
  if (!Array.isArray(body)) return { ok: false, error: `${url} returned an unexpected shape` };
  const tags = body.map((t) => t?.name).filter((n) => parseSemver(n)).sort((a, b) => cmpSemver(b, a));
  if (!tags.length) return { ok: false, error: `no release tags on ${repo}` };
  return { ok: true, latest: tags[0], tags };
}

export const releaseNotesUrl = (tag, repo = PUBLIC_REPO) => `https://github.com/${repo}/releases/tag/${tag}`;
export const compareUrl = (from, to, repo = PUBLIC_REPO) => `https://github.com/${repo}/compare/${from}...${to}`;
export const vtag = (v) => (String(v).startsWith('v') ? String(v) : `v${v}`);
