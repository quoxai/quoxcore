/**
 * BACKUP #727: run the backup script in a DETACHED one-shot container so an
 * auth rebuild or restart cannot kill a run that takes ~44 minutes.
 *
 * Before this, backup-quox.sh was a child process of the auth container, so any
 * `quox-build auth` (the build queue rebuilds auth constantly) killed the run
 * mid-compression. Now auth only STARTS and MONITORS:
 *
 *   start    docker run -d --name quox-backup-<id> <auth image> backup-quox.sh
 *            (same image, same bind mounts resolved from auth's own inspect,
 *            same user and group_add, env passed by NAME so no secret lands in argv)
 *   monitor  poll `docker inspect` with bounded backoff; at exit read the exit
 *            code, the status file the wrapper writes, and `docker logs`
 *   adopt    after an auth restart, re-attach to any running quox-backup-*
 *            container (see services/backupAdoption.js)
 *   timeout  docker stop then rm once the deadline label passes
 *   reap     orphans older than 24h are stopped and removed
 *
 * Every docker call goes through an injectable runner so tests never need docker.
 */

import { hostHome } from '../utils/hostPaths.js';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as fsp from 'fs/promises';
import { EventEmitter } from 'events';

export const BACKUP_CONTAINER_PREFIX = 'quox-backup-';
export const BACKUP_LABEL = 'quox.backup';
export const DOCKER_SOCKET = '/var/run/docker.sock';
const MAX_OUTPUT = 100 * 1024;
const ENV_PASSTHROUGH = /^(BACKUP_|QUOX_|QUOXBRAIN_|SQLITE_BACKUP_|CONTAINER_PREFIX$|TZ$)/;

export function containerNameFor(backupId) {
    return `${BACKUP_CONTAINER_PREFIX}${backupId}`;
}

export function statusFileFor(backupRoot, backupId) {
    return `${backupRoot}/.quox-backup-${backupId}.status`;
}

/** Real docker runner. Resolves {code, stdout, stderr}; never rejects. */
export function defaultDocker(args, opts = {}) {
    const { timeoutMs = 60000, env } = opts;
    return new Promise((resolve) => {
        execFile('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: env || process.env }, (err, stdout, stderr) => {
            resolve({
                code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
                stdout: String(stdout || ''),
                stderr: String(stderr || (err && err.message) || ''),
            });
        });
    });
}

function realDeps(deps = {}) {
    return {
        docker: deps.docker || defaultDocker,
        socketExists: deps.socketExists || (() => existsSync(DOCKER_SOCKET)),
        readFile: deps.readFile || ((p) => fsp.readFile(p, 'utf8')),
        removeFile: deps.removeFile || ((p) => fsp.unlink(p).catch(() => {})),
        sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
        now: deps.now || (() => Date.now()),
        env: deps.env || process.env,
        log: deps.log || console,
    };
}

/** Detached mode is on by default when the docker socket is present. */
export function detachedBackupsEnabled(deps = {}, override) {
    const d = realDeps(deps);
    // override: a stored platform setting ('true'/'false') wins over the env value
    const flag = String(override ?? d.env.BACKUP_DETACHED ?? 'true').toLowerCase();
    if (['false', '0', 'off', 'no'].includes(flag)) return { enabled: false, reason: 'BACKUP_DETACHED is off' };
    if (!d.socketExists()) return { enabled: false, reason: `docker socket ${DOCKER_SOCKET} not present` };
    return { enabled: true };
}

function safeLabel(v) {
    return String(v ?? '').replace(/[^\w@.+:-]/g, '_').slice(0, 200);
}

/** Inspect auth's own container to learn image, bind mounts, user, groups. */
async function inspectSelf(d) {
    const candidates = [d.env.HOSTNAME, 'quox-auth'].filter(Boolean);
    let lastErr = 'no candidate';
    for (const ref of candidates) {
        const r = await d.docker(['inspect', ref]);
        if (r.code === 0) {
            try {
                const info = JSON.parse(r.stdout)[0];
                if (info) return info;
            } catch (e) { lastErr = `bad inspect json: ${e.message}`; continue; }
        }
        lastErr = r.stderr.trim() || `exit ${r.code}`;
    }
    throw new Error(`cannot inspect auth container: ${lastErr}`);
}

/**
 * Start the detached backup container. Returns {containerId, name, startedAt, deadline}.
 * Throws on any docker failure (caller falls back to the child-process path).
 */
export async function startBackupContainer(opts, deps = {}) {
    const d = realDeps(deps);
    const { backupId, mode, orgId, origin, scheduleId, operator, operatorId, timeoutMs, backupScript, backupRoot } = opts;
    const name = containerNameFor(backupId);
    const self = await inspectSelf(d);
    const startedAt = d.now();
    const deadline = startedAt + timeoutMs;

    const args = ['run', '-d', '--name', name,
        '--label', `${BACKUP_LABEL}=1`,
        '--label', `${BACKUP_LABEL}.id=${safeLabel(backupId)}`,
        '--label', `${BACKUP_LABEL}.org=${safeLabel(orgId)}`,
        '--label', `${BACKUP_LABEL}.origin=${safeLabel(origin || 'route')}`,
        '--label', `${BACKUP_LABEL}.schedule=${safeLabel(scheduleId || '')}`,
        '--label', `${BACKUP_LABEL}.operator=${safeLabel(operator || '')}`,
        '--label', `${BACKUP_LABEL}.operator_id=${safeLabel(operatorId || '')}`,
        '--label', `${BACKUP_LABEL}.mode=${safeLabel(mode)}`,
        '--label', `${BACKUP_LABEL}.started=${startedAt}`,
        '--label', `${BACKUP_LABEL}.deadline=${deadline}`,
        '-w', hostHome(),
    ];
    const user = self.Config && self.Config.User;
    if (user) args.push('--user', user);
    for (const g of (self.HostConfig && self.HostConfig.GroupAdd) || []) args.push('--group-add', String(g));
    // Bind mounts only (docker.sock, ~, backups dir, project root), by
    // the real host Source docker reports, so symlinked host paths resolve. Named
    // volumes are deliberately NOT mounted: the script reaches databases via docker exec/cp.
    for (const m of self.Mounts || []) {
        if (m.Type !== 'bind') continue;
        args.push('-v', `${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
    }
    // Env by NAME only: the value comes from the docker CLI's own environment.
    const runEnv = { ...d.env, BACKUP_ID: backupId };
    const names = new Set(['BACKUP_ID']);
    for (const k of Object.keys(runEnv)) if (ENV_PASSTHROUGH.test(k)) names.add(k);
    for (const k of names) args.push('-e', k);

    const statusFile = statusFileFor(backupRoot, backupId);
    args.push('--entrypoint', '/bin/bash', self.Image, '-c',
        'rc=0; "$1" "$2" || rc=$?; printf \'{"exit_code":%s,"finished_at":%s}\' "$rc" "$(date +%s)" > "$3"; exit "$rc"',
        'backup-wrapper', backupScript, mode, statusFile);

    const r = await d.docker(args, { env: runEnv });
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    const containerId = r.stdout.trim().split('\n').pop().trim();
    return { containerId, name, startedAt, deadline, statusFile };
}

function tail(s) {
    s = String(s || '');
    return s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s;
}

async function inspectState(d, name) {
    const r = await d.docker(['inspect', '--format', '{{json .State}}', name]);
    if (r.code !== 0) {
        const gone = /no such (object|container)/i.test(r.stderr);
        return { gone, error: r.stderr.trim() || `exit ${r.code}` };
    }
    try { return { state: JSON.parse(r.stdout.trim()) }; } catch (e) { return { error: `bad state json: ${e.message}` }; }
}

/** Stop (then force-remove) a backup container. Never throws. */
export async function stopAndRemove(name, deps = {}) {
    const d = realDeps(deps);
    await d.docker(['stop', '-t', '30', name], { timeoutMs: 90000 });
    await d.docker(['rm', '-f', name]);
}

/**
 * Poll until the container exits (or its deadline passes), then return
 * {code, stdout, stderr, timedOut} and remove the container.
 * Docker errors back off 5s -> 30s (capped) and never end the monitor early
 * until deadline + 10 min.
 */
export async function monitorBackupContainer(opts, deps = {}) {
    const d = realDeps(deps);
    const { name, deadline, statusFile, pollMs = 5000, maxPollMs = 30000 } = opts;
    let delay = pollMs;
    let consecutiveErrors = 0;
    let timedOut = false;

    for (;;) {
        const st = await inspectState(d, name);
        if (st.state) {
            consecutiveErrors = 0; delay = pollMs;
            if (!st.state.Running) {
                return finish(d, name, statusFile, st.state, false);
            }
            if (deadline && d.now() > deadline) {
                d.log.error(`[Backup] container ${name} exceeded its deadline, stopping it`);
                await stopAndRemoveKeepingLogs(d, name);
                timedOut = true;
                const st2 = await inspectState(d, name);
                return finish(d, name, statusFile, st2.state || { ExitCode: 137 }, timedOut);
            }
        } else if (st.gone) {
            // Container vanished (someone rm'd it). The status file is the last witness.
            const code = await readStatusExit(d, statusFile);
            return { code: code ?? -1, stdout: '', stderr: code == null ? `backup container ${name} disappeared without a status file` : '', timedOut: false };
        } else {
            consecutiveErrors++;
            delay = Math.min(maxPollMs, delay * 2);
            d.log.error(`[Backup] docker inspect ${name} failed (${consecutiveErrors}x): ${st.error}`);
            if (deadline && d.now() > deadline + 10 * 60 * 1000) {
                return { code: -1, stdout: '', stderr: `lost contact with docker while monitoring ${name}: ${st.error}`, timedOut: false };
            }
        }
        await d.sleep(delay);
    }
}

// Stop but leave the container so `docker logs` still works; finish() removes it.
async function stopAndRemoveKeepingLogs(d, name) {
    await d.docker(['stop', '-t', '30', name], { timeoutMs: 90000 });
}

async function readStatusExit(d, statusFile) {
    if (!statusFile) return null;
    try {
        const j = JSON.parse(await d.readFile(statusFile));
        return Number.isInteger(j.exit_code) ? j.exit_code : null;
    } catch { return null; }
}

async function finish(d, name, statusFile, state, timedOut) {
    const logs = await d.docker(['logs', '--tail', '5000', name], { timeoutMs: 60000 });
    const fileCode = await readStatusExit(d, statusFile);
    const code = timedOut ? 137 : (fileCode ?? (Number.isInteger(state.ExitCode) ? state.ExitCode : -1));
    let stderr = tail(logs.stderr);
    if (timedOut) stderr = `Backup timed out and its container was stopped\n${stderr}`;
    else if (state.OOMKilled) stderr = `Backup container was OOM killed\n${stderr}`;
    // Do NOT remove the container or the status file here. They are the only
    // witnesses that the run finished, and finalising (hashing a multi-GB
    // archive) takes minutes; if auth dies in that window the next boot must
    // still find the exited container to adopt. On 2026-10-09 removing them
    // first lost a finished backup to the stale sweep. Callers release() once
    // the backup row is saved.
    const release = () => releaseWitnesses(d, name, statusFile);
    return { code, stdout: tail(logs.stdout), stderr, timedOut, release };
}

/** Remove an exited backup container and its status file. Never throws. */
async function releaseWitnesses(d, name, statusFile) {
    const rm = await d.docker(['rm', '-f', name]);
    if (rm.code !== 0) d.log.error(`[Backup] could not remove container ${name}: ${rm.stderr.trim()} (the orphan reaper will retry)`);
    if (statusFile) await d.removeFile(statusFile);
}
export function releaseBackupWitnesses(name, statusFile, deps = {}) {
    return releaseWitnesses(realDeps(deps), name, statusFile);
}

/**
 * Start + monitor, returned as a ChildProcess-shaped emitter so the existing
 * close/error handlers keep working unchanged: stdout/stderr emit one 'data'
 * then 'close'(code); start failure emits 'error'; kill() stops the container.
 * Returns {proc, container}. Throws if the container could not be started.
 */
export async function launchDetachedBackup(opts, deps = {}) {
    const d = realDeps(deps);
    const container = await startBackupContainer(opts, deps);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { stopAndRemoveKeepingLogs(d, container.name).catch(() => {}); };
    proc.containerName = container.name;
    attachMonitor(proc, container, deps);
    return { proc, container };
}

/** Run the monitor and translate its result into proc events. Also used on adoption. */
export function attachMonitor(proc, container, deps = {}, monitorOpts = {}) {
    monitorBackupContainer({ name: container.name, deadline: container.deadline, statusFile: container.statusFile, ...monitorOpts }, deps)
        .then((res) => {
            if (res.stdout) proc.stdout.emit('data', res.stdout);
            if (res.stderr) proc.stderr.emit('data', res.stderr);
            // close handlers call proc.release() after the row is saved
            proc.release = res.release || (async () => {});
            proc.emit('close', res.code, res);
        })
        .catch((err) => proc.emit('error', err));
    return proc;
}

/** List backup containers: [{name, running, labels, createdAt, startedAt, deadline}] */
export async function listBackupContainers(deps = {}) {
    const d = realDeps(deps);
    const ls = await d.docker(['ps', '-a', '--filter', `label=${BACKUP_LABEL}=1`, '--format', '{{.Names}}']);
    if (ls.code !== 0) throw new Error(`docker ps failed: ${ls.stderr.trim() || ls.code}`);
    const out = [];
    for (const name of ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const r = await d.docker(['inspect', name]);
        if (r.code !== 0) continue;
        let info; try { info = JSON.parse(r.stdout)[0]; } catch { continue; }
        if (!info) continue;
        const labels = (info.Config && info.Config.Labels) || {};
        out.push({
            name,
            running: !!(info.State && info.State.Running),
            labels,
            backupId: labels[`${BACKUP_LABEL}.id`],
            createdAt: info.Created ? Date.parse(info.Created) : null,
            startedAt: Number(labels[`${BACKUP_LABEL}.started`]) || null,
            deadline: Number(labels[`${BACKUP_LABEL}.deadline`]) || null,
        });
    }
    return out;
}

/** True when a quox-backup container for this backup is currently running. Docker errors count as "unknown" (null). */
export async function isBackupContainerRunning(backupId, deps = {}) {
    const d = realDeps(deps);
    const st = await inspectState(d, containerNameFor(backupId));
    if (st.state) return !!st.state.Running;
    if (st.gone) return false;
    return null;
}

/**
 * Stop and remove backup containers older than maxAgeMs. `rowIsRunning(backupId)`
 * lets a caller spare young-but-legit runs; anything past maxAgeMs is reaped regardless
 * (no backup legitimately runs for 24h). Returns the names reaped.
 */
export async function reapOrphanBackupContainers({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}, deps = {}) {
    const d = realDeps(deps);
    const reaped = [];
    for (const c of await listBackupContainers(deps)) {
        const born = c.startedAt || c.createdAt;
        if (!born || d.now() - born < maxAgeMs) continue;
        d.log.warn(`[Backup] reaping orphan backup container ${c.name} (age ${Math.round((d.now() - born) / 3600000)}h)`);
        await stopAndRemove(c.name, deps);
        reaped.push(c.name);
    }
    return reaped;
}
