/**
 * Engine for `quox offload`: run a heavy command on a pool worker VM as if it were local.
 * Every side effect (REST, ssh, rsync, ssh-keygen, fs, sleep) is injected through `deps`
 * so the whole flow is unit-testable without a network or a VM.
 *
 * Security: the worker is reached with a DEDICATED keypair (~/.config/quox/offload_ed25519),
 * generated on first use. Nothing under ~/.ssh is ever read, and key material is never printed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { poolStatus, poolLease, poolDone } from './vm.js';

export const REMOTE_USER = 'hyp';
export const REMOTE_ROOT = '/home/hyp/offload';
export const RSYNC_EXCLUDES = ['node_modules', '.git', 'dist', '.env*', '*.pem', '*.key', 'coverage', '.offload-busy'];
// Documented example env files carry no secrets and tests read them: rsync takes the first matching rule, so these
// includes go before the '.env*' exclude (BRAIN2 triage 2026-10-15: .env.example never reached the worker).
export const RSYNC_INCLUDES = ['.env.example', '.env.sample', '.env.template', '*.env.example'];
export function rsyncFilterArgs() {
  return [...RSYNC_INCLUDES.flatMap((e) => ['--include', e]), ...RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e])];
}
export const NO_ROUTE_RE = /no route to host|network is unreachable|connection timed out|operation timed out|could not resolve/i;
export const NOT_READY_RE = /connection refused|connection reset|connection closed|kex_exchange_identification/i;

export class OffloadError extends Error {}

export function configDir(home = os.homedir()) { return path.join(home, '.config', 'quox'); }
export function keyPath(home) { return path.join(configDir(home), 'offload_ed25519'); }
// A named worker (--worker / QUOX_OFFLOAD_WORKER) keeps its own state, lease and size; unnamed = the shared one.
export const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function statePath(home, worker) { return path.join(configDir(home), worker ? `offload-${worker}.json` : 'offload.json'); }

export function defaultLessee(env = process.env) {
  return env.QUOX_SESSION || `${env.USER || os.userInfo().username}@${os.hostname()}`;
}

/** Single-quote a string for a POSIX shell. */
export function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

export function loadState(deps) {
  try { return JSON.parse(deps.fs.readFileSync(statePath(deps.home, deps.worker), 'utf8')) || {}; } catch { return {}; }
}
export function saveState(deps, st) {
  deps.fs.mkdirSync(configDir(deps.home), { recursive: true, mode: 0o700 });
  deps.fs.writeFileSync(statePath(deps.home, deps.worker), JSON.stringify(st, null, 2), { mode: 0o600 });
}

/** Create the dedicated keypair once; returns the PUBLIC key text only. */
export async function ensureKey(deps) {
  const key = keyPath(deps.home);
  if (!deps.fs.existsSync(key) || !deps.fs.existsSync(`${key}.pub`)) {
    deps.fs.mkdirSync(configDir(deps.home), { recursive: true, mode: 0o700 });
    const r = await deps.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'quox-offload', '-f', key]);
    if (r.status !== 0) throw new OffloadError(`ssh-keygen failed (exit ${r.status}): ssh-keygen -q -t ed25519 -N '' -C quox-offload -f ${key}`);
    try { deps.fs.chmodSync(key, 0o600); } catch { /* best effort */ }
  }
  return String(deps.fs.readFileSync(`${key}.pub`, 'utf8')).trim();
}

export function sshOpts(deps) {
  return [
    '-i', keyPath(deps.home), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30',
  ];
}
export function sshArgs(deps, ip, extra = [], remoteCmd) {
  const a = [...sshOpts(deps), ...extra, `${REMOTE_USER}@${ip}`];
  if (remoteCmd !== undefined) a.push(remoteCmd);
  return a;
}
const fmtCmd = (cmd, args) => `${cmd} ${args.map((x) => (/[^\w@%+=:,./-]/.test(x) ? shq(x) : x)).join(' ')}`;

async function ssh(deps, ip, remoteCmd, extra) {
  const args = sshArgs(deps, ip, extra, remoteCmd);
  const r = await deps.run('ssh', args);
  return { ...r, cmdline: fmtCmd('ssh', args) };
}

function vmOf(status, vmid) {
  return (status?.vms || []).find((v) => Number(v.vmid) === Number(vmid)) || null;
}

export const HUMAN_LEASE_MSG = 'Leasing a new worker needs a human profile: run `quox -p <human-profile> offload ...` once to create the shared worker; agent sessions then reuse it.';

function poolError(e) {
  const msg = String(e?.message || e);
  if (/pool.*(disabled|not enabled)|disabled/i.test(msg)) return new OffloadError(`the VM pool is disabled for this org (enable it with: quox vm pool config --set '{"enabled":1}'): ${msg}`);
  if (/capacity|max_pool|no_capacity|exhaust/i.test(msg)) return new OffloadError(`the VM pool has no capacity right now: ${msg}`);
  return new OffloadError(`pool request failed${e?.status ? ` (HTTP ${e.status})` : ''}: ${msg}`);
}

function leaseError(e) {
  if (e?.status === 403) return new OffloadError(`${HUMAN_LEASE_MSG} (HTTP 403: ${String(e.message || e)})`);
  return poolError(e);
}

async function waitLeased(deps, vmid, { timeoutMs = 20 * 60 * 1000, intervalMs = 5000 } = {}) {
  const t0 = deps.now();
  for (;;) {
    const st = await poolStatus(deps.rest);
    const v = vmOf(st, vmid);
    if (v?.state === 'leased' && v.ip) return v;
    if (v?.state === 'failed') throw new OffloadError(`pool VM ${vmid} failed to build: ${v.last_error || 'unknown error'}`);
    if (deps.now() - t0 > timeoutMs) throw new OffloadError(`pool VM ${vmid} is still ${v?.state || 'missing'} after ${Math.round(timeoutMs / 60000)} minutes; check: quox vm pool status`);
    await deps.sleep(intervalMs);
  }
}

/** Reuse this user's warm worker when it is still leased by us, else lease one. Returns {vmid, ip, lessee, expires, reused}. */
export async function ensureWorker(deps, { cores, memoryGb, diskGb, fresh = false } = {}) {
  const lessee = defaultLessee(deps.env);
  const st = loadState(deps);
  // --fresh: keep the old worker until a NEW lease succeeds (an agent identity cannot lease/release;
  // releasing first would strand it with no worker).
  const oldVmid = st.worker && fresh ? st.worker.vmid : null;
  if (st.worker && !fresh) {
    let status;
    try { status = await poolStatus(deps.rest); } catch (e) { throw poolError(e); }
    const v = vmOf(status, st.worker.vmid);
    // Reuse is judged against the lessee recorded when the worker was leased: the state file is
    // shared by every session of this unix user, but QUOX_SESSION differs per session.
    const owner = st.worker.lessee || lessee;
    const live = v && v.state === 'leased' && v.lessee === owner && v.ip
      && (!v.lease_expires_at || Date.parse(v.lease_expires_at) > deps.now());
    if (live) {
      const w = { vmid: v.vmid, ip: v.ip, lessee: owner, expires: v.lease_expires_at || null };
      st.worker = { ...st.worker, ...w }; saveState(deps, st);
      return { ...w, reused: true };
    }
    delete st.worker; st.dirs = {}; saveState(deps, st);   // stale: a new VM has a clean disk
  }
  const pubkey = await ensureKey(deps);
  let res;
  try {
    res = await poolLease(deps.rest, { lessee, pubkey, cores, memoryGb, diskGb, purpose: 'quox offload' });
  } catch (e) { throw leaseError(e); }
  let vm = res?.lease || null;
  if (!vm && res?.vmid != null) {
    deps.log(`building a worker VM ${res.vmid} (this takes a few minutes)...`);
    try { vm = await waitLeased(deps, res.vmid); } catch (e) { throw e instanceof OffloadError ? e : poolError(e); }
  }
  if (!vm?.vmid) throw new OffloadError(`unexpected lease response from the pool: ${JSON.stringify(res)}`);
  const w = { vmid: vm.vmid, ip: vm.ip || null, lessee, expires: vm.lease_expires_at || vm.expires || null };
  const next = { ...loadState(deps), worker: w, dirs: {} };
  saveState(deps, next);
  if (oldVmid != null && Number(oldVmid) !== Number(vm.vmid)) {
    try { await poolDone(deps.rest, oldVmid); } catch { /* old worker already gone or not releasable */ }
  }
  return { ...w, reused: false };
}

async function refreshIp(deps, w) {
  const v = vmOf(await poolStatus(deps.rest), w.vmid);
  if (!v || v.state !== 'leased') throw new OffloadError(`worker VM ${w.vmid} is no longer leased; run again to lease a new one`);
  if (v.ip) {
    w.ip = v.ip;
    const st = loadState(deps);
    if (st.worker) { st.worker.ip = v.ip; saveState(deps, st); }
  }
  return w.ip;
}

/**
 * Make sure ssh reaches the worker. Always re-reads the current IP first; on a no-route style
 * failure refreshes once more. A freshly built VM may refuse connections while sshd starts, so
 * those are retried for up to ~2 minutes.
 */
export async function connect(deps, w) {
  await refreshIp(deps, w);
  let refreshed = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const r = await ssh(deps, w.ip, 'true');
    if (r.status === 0) return w;
    const err = `${r.stderr || ''}${r.stdout || ''}`;
    if (NO_ROUTE_RE.test(err) && !refreshed) {
      refreshed = true;
      const old = w.ip;
      await refreshIp(deps, w);
      if (w.ip !== old) continue;
    }
    if (NOT_READY_RE.test(err) && attempt < 23) { await deps.sleep(5000); continue; }
    throw new OffloadError(`ssh to the worker failed (exit ${r.status}): ${r.cmdline}\n${err.trim()}`);
  }
  throw new OffloadError(`ssh to the worker never became ready: ssh ${REMOTE_USER}@${w.ip}`);
}

export function setupScript(nodeMajor, { docker = false } = {}) {
  return [
    'set -e',
    'SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"',
    `NEED=${Number(nodeMajor)}`,
    'export DEBIAN_FRONTEND=noninteractive',
    'MISSING=""',
    'for p in git rsync build-essential python3 curl ca-certificates; do dpkg -s $p >/dev/null 2>&1 || MISSING="$MISSING $p"; done',
    'if [ -n "$MISSING" ]; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $MISSING; fi',
    'HAVE=$(node -p "process.versions.node.split(\'.\')[0]" 2>/dev/null || echo none)',
    'if [ "$HAVE" != "$NEED" ]; then curl -fsSL https://deb.nodesource.com/setup_$NEED.x | $SUDO -E bash - && $SUDO apt-get install -y -qq nodejs; fi',
    ...(docker ? [
      // --docker: the daemon plus buildx (the sandbox Dockerfiles use COPY --chmod, which needs BuildKit)
      'DMISSING=""',
      'for p in docker.io docker-buildx; do dpkg -s $p >/dev/null 2>&1 || DMISSING="$DMISSING $p"; done',
      'if [ -n "$DMISSING" ]; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $DMISSING; fi',
      '$SUDO systemctl enable --now docker >/dev/null 2>&1 || true',
      `id -nG ${REMOTE_USER} | grep -qw docker || $SUDO usermod -aG docker ${REMOTE_USER}`,
    ] : []),
    `mkdir -p ${REMOTE_ROOT}`,
  ].join('\n');
}

/**
 * --docker: build quox-sandbox:restricted and :standard from <root>/services/sandbox when missing or when the
 * Dockerfile or its build context changed (content hash kept in the image label quox.src). No sandbox dir: no-op.
 * `docker` is the command prefix (`sudo -n docker` on the worker: the group joined this run is not in this session).
 */
export function sandboxImagesScript(root, sudo = 'sudo -n') {
  const d = `${root}/services/sandbox`;
  const docker = `${sudo ? `${sudo} ` : ''}docker`;
  return [
    `D=${shq(d)}`,
    '[ -f "$D/Dockerfile.restricted" ] || exit 0',
    'H=$(cd "$D" && find . -type f -not -name "Dockerfile.*" | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)',
    'for v in restricted standard; do',
    '  [ -f "$D/Dockerfile.$v" ] || continue',
    '  S=$H-$(sha256sum "$D/Dockerfile.$v" | cut -c1-16)',
    `  CUR=$(${docker} image inspect --format "{{index .Config.Labels \"quox.src\"}}" quox-sandbox:$v 2>/dev/null || true)`,
    '  if [ "$CUR" != "$S" ]; then',
    '    echo "building quox-sandbox:$v"',
    `    ${docker} build -q -t quox-sandbox:$v --label quox.src=$S -f "$D/Dockerfile.$v" "$D" >/dev/null || { echo "build of quox-sandbox:$v failed"; exit 1; }`,
    '  fi',
    'done',
  ].join('\n');
}

export async function ensureTooling(deps, w, { docker = false } = {}) {
  const st = loadState(deps);
  const major = String(deps.nodeVersion).replace(/^v/, '').split('.')[0];
  const done = String(st.worker?.setup || '');
  // setup is recorded as "<node major>" or "<node major>+docker"; a docker run needs the +docker form
  if (st.worker?.vmid === w.vmid && done.split('+')[0] === major && (!docker || done.endsWith('+docker'))) return false;
  const withDocker = docker || done.endsWith('+docker');
  deps.log(`preparing the worker (node, git, rsync, build tools${withDocker ? ', docker' : ''})...`);
  const r = await ssh(deps, w.ip, `bash -c ${shq(setupScript(major, { docker: withDocker }))}`);
  if (r.status !== 0) throw new OffloadError(`worker setup failed (exit ${r.status}): ${r.cmdline}\n${(r.stderr || '').trim()}`);
  const st2 = loadState(deps);
  if (st2.worker) { st2.worker.setup = withDocker ? `${major}+docker` : major; saveState(deps, st2); }
  return true;
}

// Each synced worktree carries its own node_modules (~2G); dozens of them filled the worker's disk (ENOSPC, 2026-10-15).
// Before a sync, drop synced dirs idle longer than the limit (dir mtime = last use, touched at every sync), never the
// one being synced and never one a run is busy in (.offload-busy younger than 6h; an older one is a crashed run).
export const PRUNE_IDLE_MIN = 120;
export function pruneScript(root, keep, maxIdleMin = PRUNE_IDLE_MIN) {
  return [
    `cd ${shq(root)} 2>/dev/null || exit 0`,
    'for d in */; do d=${d%/}; [ -d "$d" ] || continue',
    `  [ "$d" = ${shq(keep)} ] && continue`,
    '  [ -e "$d/.offload-busy" ] && [ -n "$(find "$d/.offload-busy" -mmin -360 2>/dev/null)" ] && continue',
    `  [ -n "$(find "$d" -maxdepth 0 -mmin +${Number(maxIdleMin)} 2>/dev/null)" ] && rm -rf -- "$d"`,
    'done',
    // cache entries nobody has used for a day go too (each worktree's copy is only hard links into these)
    `find ${shq(`${root}/.nm-cache`)} -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null; true`,
  ].join('\n');
}

export async function syncDir(deps, w, dir) {
  const remote = `${REMOTE_ROOT}/${path.basename(dir)}`;
  const pr = await ssh(deps, w.ip, `bash -c ${shq(pruneScript(REMOTE_ROOT, path.basename(dir)))}`);
  if (pr.status !== 0) deps.log(`could not prune idle synced dirs on the worker (exit ${pr.status}); continuing`);
  const args = [
    '-az', '--delete', ...rsyncFilterArgs(),
    '-e', fmtCmd('ssh', sshOpts(deps)),
    `${dir.replace(/\/+$/, '')}/`, `${REMOTE_USER}@${w.ip}:${remote}/`,
  ];
  const mk = await ssh(deps, w.ip, `mkdir -p ${shq(remote)} && touch ${shq(remote)} && date +%s > ${shq(`${remote}/.offload-busy`)}`);
  if (mk.status !== 0) throw new OffloadError(`could not create ${remote} on the worker: ${mk.cmdline}\n${(mk.stderr || '').trim()}`);
  const r = await deps.run('rsync', args);
  if (r.status !== 0) throw new OffloadError(`rsync failed (exit ${r.status}): ${fmtCmd('rsync', args)}\n${(r.stderr || '').trim()}`);
  return remote;
}

// A repo may name sibling checkouts its tests read (skillrights next to the repo, the dev skill pack sources) in
// .offload-siblings.json: {"siblings":[{"name":"skillrights","path":"~/skillrights"}]}. Each lands at
// <offload root>/<name>, next to the synced checkout, and only its git-TRACKED files travel (never untracked keys
// or local state); the usual secret excludes still apply. A missing or non-git sibling is skipped with a log line.
// A name is one or more '/'-separated segments (claude-root/metron), each a plain file name: no '..', no absolute path.
const SIBLING_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const siblingNameOk = (name) => name.split('/').every((seg) => SIBLING_SEGMENT_RE.test(seg) && !seg.includes('..'));
export function readSiblings(root, home = os.homedir()) {
  const f = path.join(root, '.offload-siblings.json');
  if (!fs.existsSync(f)) return [];
  const list = JSON.parse(fs.readFileSync(f, 'utf8')).siblings || [];
  return list.map((s) => {
    const name = String(s?.name ?? '');
    if (!siblingNameOk(name)) throw new OffloadError(`bad sibling name in ${f}: ${JSON.stringify(name)}`);
    const p = String(s.path || '').replace(/^~(?=$|\/)/, home);
    return { name, path: path.resolve(p) };
  });
}

export async function syncSiblings(deps, w, root) {
  const done = [];
  for (const sib of readSiblings(root, deps.home)) {
    if (!fs.existsSync(sib.path)) { deps.log(`sibling ${sib.name} skipped: ${sib.path} does not exist here`); continue; }
    // git ls-files run in the dir lists its tracked files relative to it, so a repo's subdir works too
    const ls = await deps.run('git', ['-C', sib.path, 'ls-files', '-z']);
    if (ls.status !== 0) { deps.log(`sibling ${sib.name} skipped: ${sib.path} is not in a git checkout (exit ${ls.status})`); continue; }
    const listFile = path.join(os.tmpdir(), `quox-offload-sib-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(listFile, ls.stdout || '');
    const remote = `${REMOTE_ROOT}/${sib.name}`;
    try {
      // touch the top-level dir too: the idle prune (pruneScript) judges <offload root>/<first segment> by its mtime
      const top = `${REMOTE_ROOT}/${sib.name.split('/')[0]}`;
      const mk = await ssh(deps, w.ip, `mkdir -p ${shq(remote)} && touch ${shq(remote)} ${shq(top)}`);
      if (mk.status !== 0) throw new OffloadError(`could not create ${remote} on the worker: ${mk.cmdline}\n${(mk.stderr || '').trim()}`);
      const args = ['-az', '--from0', `--files-from=${listFile}`, ...rsyncFilterArgs(), '-e', fmtCmd('ssh', sshOpts(deps)),
        `${sib.path.replace(/\/+$/, '')}/`, `${REMOTE_USER}@${w.ip}:${remote}/`];
      const r = await deps.run('rsync', args);
      if (r.status !== 0) throw new OffloadError(`rsync of sibling ${sib.name} failed (exit ${r.status})\n${(r.stderr || '').trim()}`);
    } finally {
      try { fs.unlinkSync(listFile); } catch { /* best effort */ }
    }
    done.push(sib.name);
  }
  return done;
}

// One node_modules per distinct lockfile (+ node major), hard-linked into each synced worktree: dozens of worktrees
// at ~2G each filled the worker's disk twice on 2026-10-15. npm ci runs only on a cache miss and then fills the
// cache atomically (tmp + rename, so a racing run never sees a half-copied entry).
export const NM_CACHE_DIR = `${REMOTE_ROOT}/.nm-cache`;
export function depsInstallScript(dirPath, cacheRoot, key) {
  const c = `${cacheRoot}/${key}`;
  return [
    'set -e',
    `cd ${shq(dirPath)}`,
    `C=${shq(c)}`,
    'if [ -d "$C/node_modules" ]; then',
    '  rm -rf node_modules; cp -al "$C/node_modules" node_modules; touch "$C"; echo NM_CACHE_HIT',
    'else',
    '  npm ci --no-audit --no-fund',
    `  mkdir -p ${shq(cacheRoot)}; T="$C.tmp.$$"; rm -rf "$T"; mkdir -p "$T"`,
    '  if cp -al node_modules "$T/node_modules" && mv -T "$T" "$C" 2>/dev/null; then echo NM_CACHE_FILLED; else rm -rf "$T"; echo NM_CACHE_SKIPPED; fi',
    'fi',
  ].join('\n');
}

/** package.json dirs that also have a package-lock.json, up to depth 3, relative to root ('.' for root). */
export function findLockDirs(deps, root, maxDepth = 3) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
  const walk = (rel, depth) => {
    const abs = path.join(root, rel);
    if (deps.fs.existsSync(path.join(abs, 'package.json')) && deps.fs.existsSync(path.join(abs, 'package-lock.json'))) out.push(rel || '.');
    if (depth >= maxDepth) return;
    let ents = [];
    try { ents = deps.fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(rel, e.name), depth + 1);
  };
  walk('', 0);
  return out;
}

export const hashFile = (deps, f) => crypto.createHash('sha256').update(deps.fs.readFileSync(f)).digest('hex');

/** npm ci only where package-lock.json changed since the last sync, or node_modules is missing remotely. */
export async function installDeps(deps, w, dir, remote, { fresh = false } = {}) {
  const dirs = findLockDirs(deps, dir);
  if (!dirs.length) return [];
  const st = loadState(deps);
  const rec = (st.dirs ||= {})[dir] ||= { remote, hashes: {} };
  const hashes = rec.hashes ||= {};
  const probe = dirs.map((d) => `[ -d ${shq(`${remote}/${d}/node_modules`)} ] || echo ${shq(d)}`).join('; ');
  const pr = await ssh(deps, w.ip, probe);
  const missing = new Set(String(pr.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
  const ran = [];
  for (const d of dirs) {
    const h = hashFile(deps, path.join(dir, d, 'package-lock.json'));
    if (!fresh && hashes[d] === h && !missing.has(d)) continue;
    deps.log(`npm ci in ${d}`);
    const major = String(deps.nodeVersion || '').replace(/^v/, '').split('.')[0] || 'x';
    const key = `${String(h).replace(/[^a-f0-9]/gi, '').slice(0, 32)}-node${major}`;
    const r = await ssh(deps, w.ip, `bash -c ${shq(depsInstallScript(`${remote}/${d}`, NM_CACHE_DIR, key))}`);
    if (r.status !== 0) throw new OffloadError(`npm ci failed in ${d} (exit ${r.status}): ${r.cmdline}\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-15).join('\n')}`);
    hashes[d] = h; ran.push(d);
    saveState(deps, st);   // persist per dir so an interrupted install resumes
  }
  rec.remote = remote; rec.synced_at = new Date(deps.now()).toISOString();
  saveState(deps, st);
  return ran;
}

// Pool default timeouts (SITE-CLI ruling 2026-10-16, policy rule C: fix the harness, never an assertion). On a
// shared pool worker vitest's 5 s test / 10 s hook defaults turned ~55 slow-but-green collector tests red per run.
// A vitest command gets 30 s defaults unless the caller set its own; per-test timeouts still win, no assertion moves.
const POOL_VITEST_TIMEOUTS = [['--testTimeout', '30000'], ['--hookTimeout', '30000']];
export function withPoolTimeouts(command) {
  if (!command.some((a) => /(^|\/)vitest(\.m?js)?$/.test(String(a)))) return command;
  const add = POOL_VITEST_TIMEOUTS.filter(([flag]) => !command.some((a) => String(a) === flag || String(a).startsWith(`${flag}=`)))
    .map(([flag, ms]) => `${flag}=${ms}`);
  return [...command, ...add];
}

/** Full flow. Returns the remote command's exit code. */
export async function runOffload(deps, { dir, cwd, command, fresh, cores, memoryGb, diskGb, docker = false }) {
  if (!command?.length) throw new OffloadError('no command given: quox offload [options] -- <command...>');
  const root = path.resolve(dir);
  const w = await ensureWorker(deps, { cores, memoryGb, diskGb, fresh });
  deps.log(w.reused ? `reusing worker VM ${w.vmid}` : `leased worker VM ${w.vmid}`);
  await connect(deps, w);
  await ensureTooling(deps, w, { docker });
  const sibs = await syncSiblings(deps, w, root);
  if (sibs.length) deps.log(`synced sibling repos: ${sibs.join(', ')}`);
  const remote = await syncDir(deps, w, root);
  await installDeps(deps, w, root, remote, { fresh });
  if (docker) {
    const r = await ssh(deps, w.ip, `bash -c ${shq(sandboxImagesScript(remote))}`);
    if (r.status !== 0) throw new OffloadError(`sandbox image build failed (exit ${r.status}): ${r.cmdline}\n${((r.stdout || '') + (r.stderr || '')).trim()}`);
    if ((r.stdout || '').trim()) deps.log(r.stdout.trim());
  }
  const rel = path.relative(root, path.resolve(cwd || root));
  const workdir = rel && !rel.startsWith('..') ? `${remote}/${rel}` : remote;
  const envPrefix = deps.env.FORCE_COLOR ? `FORCE_COLOR=${shq(deps.env.FORCE_COLOR)} ` : '';
  const user = withPoolTimeouts(command).map(shq).join(' ');
  const tty = !!deps.isTTY;
  let remoteCmd; let pidFile = null;
  if (tty) {
    remoteCmd = `cd ${shq(workdir)} && ${envPrefix}${user}`;
  } else {
    pidFile = `/tmp/quox-offload-${crypto.randomBytes(4).toString('hex')}.pid`;
    // setsid makes the command its own process group (pgid = pid) so Ctrl-C can kill the whole group.
    remoteCmd = `cd ${shq(workdir)} && exec setsid -w bash -c ${shq(`echo $$ > ${pidFile}; ${envPrefix}exec "$@"`)} _ ${user}`;
  }
  const args = sshArgs(deps, w.ip, tty ? ['-t'] : [], remoteCmd);
  const off = deps.onSigint(async () => {
    if (pidFile) await ssh(deps, w.ip, `kill -INT -- -$(cat ${pidFile}) 2>/dev/null; true`);
  });
  try {
    return await deps.runLive('ssh', args);
  } finally {
    off();
    try { await ssh(deps, w.ip, `rm -f ${pidFile ? `${pidFile} ` : ''}${shq(`${remote}/.offload-busy`)}`); } catch { /* best effort */ }
  }
}

export async function releaseWorker(deps) {
  const st = loadState(deps);
  if (!st.worker) return null;
  const vmid = st.worker.vmid;
  await poolDone(deps.rest, vmid);
  delete st.worker; st.dirs = {};
  saveState(deps, st);
  return vmid;
}

export async function workerStatus(deps) {
  const st = loadState(deps);
  if (!st.worker) return { worker: null };
  let live = null;
  try { live = vmOf(await poolStatus(deps.rest), st.worker.vmid); } catch { /* report cached */ }
  return {
    worker: {
      vmid: st.worker.vmid, ip: live?.ip || st.worker.ip, state: live?.state || 'unknown',
      lessee: st.worker.lessee, lease_expires_at: live?.lease_expires_at || st.worker.expires,
    },
    dirs: Object.entries(st.dirs || {}).map(([local, r]) => ({ local, remote: r.remote, synced_at: r.synced_at || null })),
  };
}

/** Real side effects. */
export function realDeps({ rest, env = process.env, log = (m) => process.stderr.write(`offload: ${m}\n`) }) {
  return {
    rest, env, log, fs, home: os.homedir(), nodeVersion: process.version, isTTY: !!process.stdout.isTTY,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    run: (cmd, args) => new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', (e) => resolve({ status: 127, stdout, stderr: `${stderr}${e.message}` }));
      p.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }));
    }),
    runLive: (cmd, args) => new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: 'inherit' });
      p.on('error', (e) => reject(new OffloadError(`${cmd} failed to start: ${e.message}`)));
      p.on('close', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
    }),
    onSigint: (fn) => {
      const h = () => { Promise.resolve(fn()).catch(() => {}); };
      process.on('SIGINT', h);
      return () => process.off('SIGINT', h);
    },
  };
}

export function gitToplevel(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : cwd;
}
