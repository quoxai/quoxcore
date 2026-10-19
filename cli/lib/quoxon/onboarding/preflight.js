/**
 * Preflight for Getting started: real checks, each bounded by a timeout, never sudo, never a write.
 * Thresholds and ports are the installer's own (read from the repo, keep in step):
 *   scripts/preflight.sh  MIN_RAM_GB=4, MIN_DISK_GB=10
 *   README (public mirror) "Plan for 8 GB of RAM and 30 GB of free disk"
 *   scripts/setup.sh      needs docker (daemon reachable), docker compose v2, openssl; get.quox.ai needs git
 *   docker-compose.yml    host ports below
 */
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { totalmem, homedir, userInfo } from 'node:os';
import { createConnection } from 'node:net';
import { CHECK } from './copy.js';

export const MIN_DISK_GB = 10;
export const REC_DISK_GB = 30;
export const MIN_RAM_GB = 4;
export const REC_RAM_GB = 8;
/** Every host port docker-compose.yml publishes (80, 3000 and 9848 on all interfaces, the rest on loopback). */
export const PORTS = [80, 3000, 9848, 3100, 3101, 3102, 3103, 3104, 3105, 3106, 3107, 3108, 3110, 3200, 5432, 6333, 9849];
export const CHECK_IDS = ['docker', 'compose', 'tools', 'disk', 'ram', 'ports'];

/** execFile with a hard timeout; never throws. -> { code, stdout, stderr, missing } */
export function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: err?.code === 'ENOENT', timedOut: Boolean(err?.killed) });
      });
    } catch (e) { resolve({ code: 1, stdout: '', stderr: String(e?.message || e), missing: e?.code === 'ENOENT' }); }
    child?.stdin?.end?.();
  });
}

/** Is something listening on 127.0.0.1:port? A connect, not a bind: needs no privileges, works for port 80. */
export function portInUse(port, timeout = 400) {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export const defaultDeps = () => ({
  run,
  portInUse,
  statfs: (p) => statfs(p),
  totalmem,
  home: homedir()
});

const gb = (bytes) => Math.floor(bytes / 1024 ** 3);
const row = (id, status, body, extra = {}) => ({ id, name: CHECK[id].name, status, body, ...extra });

const safeUser = () => { try { return userInfo().username; } catch { return ''; } };

export async function checkDocker(d) {
  const v = await d.run('docker', ['--version'], 5000);
  const linux = (d.platform || process.platform) === 'linux'; // FIRSTRUN: the guide can fix these itself (dockerOffer.js)
  const offer = (kind) => (linux ? { offer: kind } : {});
  if (v.missing || v.code !== 0) return row('docker', 'fail', CHECK.docker.missing, { fix: CHECK.docker.missingFix, link: CHECK.docker.missingLink, ...offer('install') });
  const ver = (/version\s+([0-9][\w.\-+]*)/i.exec(v.stdout) || [])[1] || '';
  const info = await d.run('docker', ['info', '--format', '{{.ServerVersion}}'], 10000);
  if (info.code === 0 && info.stdout.trim()) return row('docker', 'ok', CHECK.docker.ok(ver || info.stdout.trim()));
  if (/permission denied/i.test(info.stderr)) {
    // Z2H-R5 D: the group was added after this terminal started. `id -nG` shows the groups of THIS process,
    // `id -nG <user>` the account database; in the second but not the first, "press r" can never pass.
    const user = d.user || safeUser();
    if (user) {
      const [mine, db] = await Promise.all([d.run('id', ['-nG'], 3000), d.run('id', ['-nG', user], 3000)]);
      const has = (r) => r.code === 0 && r.stdout.trim().split(/\s+/).includes('docker');
      if (has(db) && !has(mine)) return row('docker', 'fail', CHECK.docker.permStale, { fix: CHECK.docker.permStaleFix, link: CHECK.docker.link, stale: true, ...offer('relaunch') });
    }
    return row('docker', 'fail', CHECK.docker.perm, { fix: CHECK.docker.permFix, link: CHECK.docker.link, ...offer('group') });
  }
  return row('docker', 'fail', CHECK.docker.down, { fix: CHECK.docker.downFix, link: CHECK.docker.link });
}

export async function checkCompose(d) {
  const r = await d.run('docker', ['compose', 'version', '--short'], 6000);
  const v = r.stdout.trim();
  if (r.code !== 0 || !v) return row('compose', 'fail', CHECK.compose.missing, { fix: CHECK.compose.missingFix, link: CHECK.compose.link });
  const major = Number((/^v?(\d+)/.exec(v) || [])[1]);
  if (major < 2) return row('compose', 'fail', CHECK.compose.old(v), { fix: CHECK.compose.missingFix, link: CHECK.compose.link });
  return row('compose', 'ok', CHECK.compose.ok(v));
}

export async function checkTools(d) {
  const [git, ssl] = await Promise.all([d.run('git', ['--version'], 4000), d.run('openssl', ['version'], 4000)]);
  const missing = [git.code === 0 ? null : 'git', ssl.code === 0 ? null : 'openssl'].filter(Boolean);
  if (missing.length) return row('tools', 'fail', CHECK.tools.missing(missing), { fix: CHECK.tools.fix(missing), link: CHECK.tools.link });
  return row('tools', 'ok', CHECK.tools.ok);
}

export async function checkDisk(d) {
  try {
    const s = await d.statfs(d.home);
    const free = gb(Number(s.bavail) * Number(s.bsize));
    if (free < MIN_DISK_GB) return row('disk', 'fail', CHECK.disk.fail(free, MIN_DISK_GB), { fix: CHECK.disk.fix(MIN_DISK_GB), link: CHECK.disk.link });
    if (free < REC_DISK_GB) return row('disk', 'warn', CHECK.disk.low(free, REC_DISK_GB));
    return row('disk', 'ok', CHECK.disk.ok(free));
  } catch (e) {
    return row('disk', 'warn', `could not measure free space (${e?.code || 'error'})`);
  }
}

export async function checkRam(d) {
  const total = Math.round(d.totalmem() / 1024 ** 3);
  if (total < MIN_RAM_GB) return row('ram', 'fail', CHECK.ram.fail(total, MIN_RAM_GB), { fix: CHECK.ram.fix(MIN_RAM_GB), link: CHECK.ram.link });
  if (total < REC_RAM_GB) return row('ram', 'warn', CHECK.ram.low(total, REC_RAM_GB));
  return row('ram', 'ok', CHECK.ram.ok(total));
}

export async function checkPorts(d, ports = PORTS) {
  const used = [];
  await Promise.all(ports.map(async (p) => { if (await d.portInUse(p)) used.push(p); }));
  used.sort((a, b) => a - b);
  const quox = used.includes(3000) && used.includes(9848); // the dashboard and collector ports: most likely Quox itself
  // Resuming an install this guide started: Quox's own ports being busy is expected, not a blocker.
  if (used.length && quox && d.ownInstall) return row('ports', 'warn', CHECK.ports.ownInstall);
  if (used.length) return row('ports', 'fail', CHECK.ports.busy(used), { fix: quox ? CHECK.ports.quoxFix : CHECK.ports.fix(used[0]), link: CHECK.ports.link });
  return row('ports', 'ok', CHECK.ports.ok(ports.length));
}

const CHECKS = { docker: checkDocker, compose: checkCompose, tools: checkTools, disk: checkDisk, ram: checkRam, ports: checkPorts };

/** Rows in their running state, before any result. */
export const pendingRows = () => CHECK_IDS.map(id => row(id, 'running', CHECK.running));

/** Run every check in parallel; onRow(row) fires as each finishes. -> rows in CHECK_IDS order. */
export async function runPreflight(deps = defaultDeps(), onRow = () => {}) {
  const rows = await Promise.all(CHECK_IDS.map(async (id) => {
    let r;
    try { r = await CHECKS[id](deps); } catch (e) { r = row(id, 'fail', `check failed: ${e?.message || e}`, { fix: 'Press r to check again.', link: 'https://quox.ai/docs/setup' }); }
    onRow(r);
    return r;
  }));
  return rows;
}

export const preflightPassed = (rows) => rows.length > 0 && rows.every(r => r.status === 'ok' || r.status === 'warn');

/** Ollama on this machine? A 1 s GET of its model list; never throws. */
export async function detectOllama({ fetchImpl = globalThis.fetch, timeout = 1000 } = {}) {
  if (!fetchImpl) return false;
  const ac = new AbortController();
  let t;
  const late = new Promise((res) => { t = setTimeout(() => { ac.abort(); res(null); }, timeout); });
  try {
    const r = await Promise.race([fetchImpl('http://127.0.0.1:11434/api/tags', { signal: ac.signal }), late]);
    return Boolean(r?.ok);
  } catch { return false; } finally { clearTimeout(t); }
}
