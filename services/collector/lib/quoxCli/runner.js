'use strict';
/**
 * QUOXON-ASK lane J: run one quox CLI leaf as the CALLER.
 *
 *  - Never a shell: node is spawned with an argv array.
 *  - Identity: a private temp HOME (0700) holds a one-profile config (0600) with ONLY the
 *    caller's bearer and org. It is deleted when the call ends, on every exit path; a
 *    reaper removes any a crash left behind.
 *  - Environment is an ALLOWLIST (PATH, HOME, XDG dirs, NO_COLOR, CI, NODE_ENV). The
 *    collector's own env (INTERNAL_SERVICE_KEY, QUOX_SERVICE_KEY, provider keys) never
 *    reaches the child, so the CLI cannot fall back to a service key.
 *  - Bounded: stdout capped (default 64 KB; reading stops and the child is killed at the
 *    cap), stderr capped at 8 KB, a hard timeout (default 60 s) that SIGKILLs the whole
 *    process group, stdin closed so a prompt can never hang the turn.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const STDERR_MAX = 8 * 1024;
const TMP_PREFIX = 'qx-cli-';
const STALE_MS = 5 * 60 * 1000;

function resolveCliBin() {
  const candidates = [
    '/opt/quox-cli/bin/quox.js', // baked into the collector image (Dockerfile CLI-OVER-MCP)
    path.resolve(__dirname, '..', '..', '..', '..', 'cli', 'bin', 'quox.js'), // repo checkout (dev, tests)
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** In-cluster addresses of the services the CLI calls, as the collector itself reaches them. */
function defaultServiceUrls() {
  const env = process.env;
  const collector = `http://127.0.0.1:${env.COLLECTOR_PORT || env.PORT || 9848}`;
  return {
    collector,
    orchestrator: collector,
    auth: `http://${env.AUTH_HOST || 'auth'}:${env.AUTH_PORT || '3101'}`,
    memory: env.MEMORY_SERVICE_URL || 'http://memory:3103',
    tasks: env.TASKS_SERVICE_URL || 'http://tasks:3104',
    files: env.FILES_SERVICE_URL || 'http://files:3102',
    quoxflow: env.QUOXFLOW_URL || 'http://quoxflow:3200',
    quoxbrain: env.QUOXBRAIN_URL || 'http://quoxbrain:3106',
  };
}

/** Remove temp profiles older than STALE_MS (a crash between create and cleanup). */
function reapStale(baseDir = os.tmpdir(), now = Date.now()) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(baseDir)) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const full = path.join(baseDir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > STALE_MS) { fs.rmSync(full, { recursive: true, force: true }); removed++; }
      } catch { /* raced with another cleanup */ }
    }
  } catch (err) {
    console.warn('[quox_cli] temp profile reaper could not scan:', err.message);
  }
  return removed;
}

function childEnv(home) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    NODE_ENV: 'production',
    QUOX_NO_SKEW_CHECK: '1',
  };
  return env;
}

function writeProfile(home, { token, orgId, serviceUrls }) {
  const dir = path.join(home, '.config', 'quox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = {
    version: 1,
    activeProfile: 'caller',
    profiles: {
      caller: {
        url: serviceUrls.collector,
        services: serviceUrls,
        auth: { access_token: token, org_id: orgId },
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
}

/**
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:string, stderr:string,
 *   truncated:boolean, timedOut:boolean, durationMs:number, error?:string}>}
 */
async function runCli({ argv, token, orgId, bin = resolveCliBin(), serviceUrls = defaultServiceUrls(), timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, tmpBase = os.tmpdir() } = {}) {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) throw new Error('runCli: argv must be an array of strings');
  if (!token || !orgId) throw new Error('runCli: the caller token and org are required');
  if (!bin) return { exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 0, error: 'the quox CLI is not installed on this server' };

  reapStale(tmpBase);
  const home = fs.mkdtempSync(path.join(tmpBase, TMP_PREFIX));
  fs.chmodSync(home, 0o700);
  const started = Date.now();
  try {
    writeProfile(home, { token, orgId, serviceUrls });
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath, [bin, ...argv], { cwd: home, env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        resolve({ exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: Date.now() - started, error: err.message });
        return;
      }
      const out = [];
      let outBytes = 0;
      let errText = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const killGroup = () => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
      child.stdout.on('data', (buf) => {
        if (truncated) return;
        const room = maxBytes - outBytes;
        if (buf.length > room) {
          out.push(buf.subarray(0, Math.max(0, room)));
          outBytes = maxBytes;
          truncated = true;
          killGroup();
          return;
        }
        out.push(buf);
        outBytes += buf.length;
      });
      child.stderr.on('data', (buf) => { if (errText.length < STDERR_MAX) errText += buf.toString('utf8').slice(0, STDERR_MAX - errText.length); });
      const finish = (exitCode, signal, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: errText,
          truncated, timedOut, durationMs: Date.now() - started, ...(error ? { error } : {}),
        });
      };
      child.on('error', (err) => finish(null, null, err.message));
      child.on('close', (code, signal) => finish(code, signal, null));
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { runCli, resolveCliBin, defaultServiceUrls, reapStale, childEnv, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, TMP_PREFIX };
