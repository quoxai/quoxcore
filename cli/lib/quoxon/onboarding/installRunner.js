/**
 * C2b: the real install runner (the runner interface in ./runner.js).
 *
 * Wraps the existing installer, never a second one: get.quox.ai serves install.sh (quox-website
 * public/install.sh), which clones quox, quoxflow and quoxmcp into $QUOX_DIR and runs
 * scripts/setup.sh --yes (non-interactive). We download it to a private temp file, show its
 * SHA256, run it with `sh`, and map its own step markers onto the five honest stages:
 *
 *   fetch      start .. "[setup] Step 2/7"     (install.sh clones; setup.sh step 1 preflight)
 *   configure  Step 2/7 .. Step 6/7            (.env secrets, SSL cert, deps, stale cleanup)
 *   build      Step 6/7 .. "Starting services" (docker compose build)
 *   start      "Starting services" .. Step 7/7 (docker compose up -d)
 *   health     Step 7/7 .. "full platform is ready" + our own probe of the auth service
 *
 * Re-running (setup.sh read, 2026-10-12): clone() pulls instead of re-cloning; an existing complete
 * .env and ssl/quox.crt are kept (so the Postgres password still matches its volume); the image
 * build is cached. Step 5 however REMOVES running quox-* containers (compose down, volumes kept)
 * before rebuilding. So: interrupted before `start` completed -> run the whole installer again;
 * `start` completed -> never re-run it, only check health.
 *
 * Never a fake percentage: elapsed time per stage, and the real log lines (`v` in the view).
 */
import { spawn as defaultSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGE_IDS, stageList } from './runner.js';

import { BUILD_LABELS } from './copy.js';
export const INSTALLER_URL = 'https://get.quox.ai';
export const defaultInstallDir = (home = homedir()) => join(home, 'quox-install');
/** Where the full install log lives: the user's quox state dir, ~/.local/state/quox/install-logs. */
export const defaultInstallLogDir = (home = homedir()) => join(home, '.local', 'state', 'quox', 'install-logs');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const RED = /^\x1b\[(0;)?31m/;
const MARKS = [
  [/^\[setup\] Step 2\/7\b/, 'configure'],
  [/^\[setup\] Step 6\/7\b/, 'build'],
  [/Starting services\.\.\./, 'start'],
  [/^\[setup\] Step 7\/7\b/, 'health']
];

/**
 * Line-by-line stage machine over the installer's output.
 * push(rawLine) -> { line: cleaned text | null, moves: [[stageId, 'ok'|'running']] }
 */
export function createStageParser() {
  const state = { current: 'fetch', buildMode: null, ready: false, degraded: false, dashboardUrl: null, lastError: null };
  return {
    state,
    push(raw, { stderr = false } = {}) {
      const text = String(raw ?? '').replace(ANSI, '').replace(/\s+$/, '');
      const moves = [];
      if (!text.trim()) return { line: null, moves };
      const line = text.replace(/^\s+/, (m) => (m.length > 2 ? '  ' : m));
      for (const [re, next] of MARKS) {
        if (!re.test(line.trim())) continue;
        const from = STAGE_IDS.indexOf(state.current); const to = STAGE_IDS.indexOf(next);
        if (to <= from) break;
        for (let i = from; i < to; i++) { moves.push([STAGE_IDS[i], 'ok']); if (i + 1 < to) moves.push([STAGE_IDS[i + 1], 'running']); }
        moves.push([next, 'running']);
        state.current = next;
        break;
      }
      // Z2H-IMAGES: setup.sh either downloads prebuilt images or builds them; the build stage says which.
      if (/Downloading prebuilt images/.test(line)) state.buildMode = 'download';
      else if (/Building images/.test(line)) state.buildMode = 'build';
      if (/QuoxCORE full platform is ready/.test(line)) state.ready = true;
      if (/core shell is up, but platform features are degraded/.test(line)) state.degraded = true;
      const open = /^\s*Open:\s+(https?:\/\/\S+)/.exec(line);
      if (open) state.dashboardUrl = open[1];
      if (stderr || RED.test(String(raw))) state.lastError = line.trim();
      return { line: line.trim(), moves };
    }
  };
}

/** GET <authUrl>/health once. -> { ok, error? } */
export async function probeAuthHealth(authUrl, { fetchImpl = globalThis.fetch, timeout = 3000 } = {}) {
  try {
    const r = await fetchImpl(`${authUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeout) });
    return r.ok ? { ok: true } : { ok: false, error: `auth /health answered HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: e?.cause?.code ? `${e.message} (${e.cause.code})` : (e?.message || 'no answer') }; }
}

const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); res(); }, { once: true });
});

export function createInstallRunner({
  env = process.env,
  url = env.QUOX_INSTALLER_URL || INSTALLER_URL,
  installDir = defaultInstallDir(),
  logDir = defaultInstallLogDir(),
  fetchImpl = globalThis.fetch,
  spawnImpl = defaultSpawn,
  tmpRoot = tmpdir(),
  probeHealth = async () => ({ ok: true }),
  healthTries = 20,
  healthIntervalMs = 3000,
  resumeFrom = null,
  resumeDashboardUrl = null,
  onCheckpoint = () => {},
  killGraceMs = 5000,
  now = () => Date.now()
} = {}) {
  async function checkHealth(emit, signal) {
    let last = null;
    for (let i = 0; i < Math.max(1, healthTries); i++) {
      if (signal?.aborted) return { ok: false, interrupted: true };
      last = await probeHealth();
      if (last?.ok) return { ok: true };
      emit({ type: 'log', line: `waiting for the auth service: ${last?.error || 'not ready'}` });
      if (i + 1 < healthTries) await sleep(healthIntervalMs, signal);
    }
    return { ok: false, error: last?.error || 'the auth service did not answer' };
  }

  return {
    kind: 'real',
    url,
    installDir,
    stages: stageList(),
    /** Per-run overrides (the view passes the journey's checkpoint): resumeFrom, resumeDashboardUrl, onCheckpoint. */
    /**
     * Every run also writes the full stage log (each line the installer printed) to a file under the
     * user's quox state dir; the result carries `logPath` so the UI can show it on failure and at the end.
     */
    async run(opts = {}) {
      const { onEvent = () => {} } = opts;
      let logPath = null;
      try {
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
        logPath = join(logDir, `install-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.log`);
        writeFileSync(logPath, `# quox install log, started ${new Date(now()).toISOString()}\n`, { mode: 0o600 });
      } catch { logPath = null; } // best effort: a log that cannot be written never fails the install
      const tee = (e) => {
        if (logPath) {
          try {
            if (e.type === 'log') appendFileSync(logPath, e.line + '\n');
            else if (e.type === 'stage') appendFileSync(logPath, `-- stage ${e.id} ${e.status}\n`);
          } catch { /* best effort */ }
        }
        onEvent(e);
      };
      const res = await runCore({ ...opts, onEvent: tee });
      if (!res.ok && !res.interrupted && logPath) {
        // Z2H-R2: a failed run always says where the full log is and what to do next.
        res.hint = `Full log: ${logPath}. It is safe to run the installer again; finished steps are kept and the build is cached.`;
      }
      if (logPath) { try { appendFileSync(logPath, `-- result ${res.ok ? 'ok' : `failed at ${res.failedStage || '?'}: ${res.error || ''}`}\n`); } catch { /* best effort */ } }
      return logPath ? { ...res, logPath } : res;
    }
  };
  async function runCore({ onEvent = () => {}, signal, resumeFrom: rf = resumeFrom, resumeDashboardUrl: rd = resumeDashboardUrl, onCheckpoint: oc = onCheckpoint } = {}) {
      const resumeAfterStart = rf === 'start' || rf === 'health';
      const started = {};
      const stage = (id, status) => {
        const at = now();
        if (status === 'running') started[id] = at;
        onEvent({ type: 'stage', id, status, at, ...(status !== 'running' ? { ms: started[id] != null ? at - started[id] : null } : {}) });
      };
      const emit = (e) => onEvent(e);

      if (resumeAfterStart) {
        for (const id of ['fetch', 'configure', 'build', 'start']) onEvent({ type: 'stage', id, status: 'ok', at: now(), ms: null, earlier: true });
        emit({ type: 'log', line: 'the services were already started; checking their health' });
        stage('health', 'running');
        const h = await checkHealth(emit, signal);
        if (h.interrupted) return { ok: false, interrupted: true };
        if (!h.ok) { stage('health', 'fail'); return { ok: false, failedStage: 'health', error: h.error, dashboardUrl: rd }; }
        stage('health', 'ok');
        oc('health', { dashboardUrl: rd });
        return { ok: true, dashboardUrl: rd, resumed: true };
      }

      // ---- fetch: download the installer, show what will run -------------------------------------
      stage('fetch', 'running');
      let body;
      try {
        const r = await fetchImpl(url, { signal });
        if (!r.ok) { stage('fetch', 'fail'); return { ok: false, failedStage: 'fetch', error: `${url} answered HTTP ${r.status}` }; }
        body = await r.text();
      } catch (e) {
        if (signal?.aborted) return { ok: false, interrupted: true };
        stage('fetch', 'fail');
        return { ok: false, failedStage: 'fetch', error: `could not download ${url}: ${e?.message || e}` };
      }
      if (!/^#!\s*\/bin\/(ba)?sh\b/.test(body)) { stage('fetch', 'fail'); return { ok: false, failedStage: 'fetch', error: `${url} did not return a shell script, so nothing was run` }; }
      const sha256 = createHash('sha256').update(body).digest('hex');
      emit({ type: 'script', url, sha256, bytes: Buffer.byteLength(body) });
      emit({ type: 'log', line: `installer ${url} sha256 ${sha256}` });

      const dir = mkdtempSync(join(tmpRoot, 'quox-installer-'));
      const file = join(dir, 'install.sh');
      writeFileSync(file, body, { mode: 0o600 });

      const parser = createStageParser();
      try {
        const code = await new Promise((resolve) => {
          const child = spawnImpl('sh', [file], {
            cwd: homedir(),
            env: { ...env, QUOX_DIR: installDir },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true // own process group: abort stops docker compose too
          });
          let killTimer = null;
          const onAbort = () => {
            try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
            killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, killGraceMs);
          };
          if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
          const feed = (stderr) => {
            let rest = '';
            return (chunk) => {
              const parts = (rest + chunk.toString('utf8')).split(/\r\n|\r|\n/);
              rest = parts.pop();
              for (const raw of parts) take(raw, stderr);
            };
          };
          const take = (raw, stderr) => {
            const modeBefore = parser.state.buildMode;
            const { line, moves } = parser.push(raw, { stderr });
            for (const [id, status] of moves) {
              if (status === 'ok') { stage(id, 'ok'); if (id !== 'health') oc(id, {}); }
              else stage(id, 'running');
            }
            if (parser.state.buildMode !== modeBefore) emit({ type: 'stage-label', id: 'build', label: BUILD_LABELS[parser.state.buildMode] });
            if (line) emit({ type: 'log', line });
          };
          child.stdout.on('data', feed(false));
          child.stderr.on('data', feed(true));
          child.on('error', (e) => { parser.state.lastError = `could not run sh: ${e.message}`; resolve(127); });
          child.on('close', (c, sig) => { clearTimeout(killTimer); signal?.removeEventListener?.('abort', onAbort); resolve(sig ? 128 : c); });
        });

        if (signal?.aborted) return { ok: false, interrupted: true };
        const at = parser.state.current;
        if (code !== 0) {
          stage(at, 'fail');
          return { ok: false, failedStage: at, error: parser.state.lastError || `the installer exited with code ${code}`, dashboardUrl: parser.state.dashboardUrl };
        }
        if (at !== 'health' || !parser.state.ready) {
          if (at !== 'health') stage(at, 'fail'); else stage('health', 'fail');
          return {
            ok: false, failedStage: at === 'health' ? 'health' : at, degraded: parser.state.degraded, dashboardUrl: parser.state.dashboardUrl,
            error: parser.state.degraded ? 'the core is up, but some services are not healthy yet' : 'the installer finished without saying the platform is ready'
          };
        }
        const h = await checkHealth(emit, signal);
        if (h.interrupted) return { ok: false, interrupted: true };
        if (!h.ok) { stage('health', 'fail'); return { ok: false, failedStage: 'health', error: h.error, dashboardUrl: parser.state.dashboardUrl }; }
        stage('health', 'ok');
        oc('health', { dashboardUrl: parser.state.dashboardUrl });
        return { ok: true, dashboardUrl: parser.state.dashboardUrl, sha256 };
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup only */ }
      }
  }
}
