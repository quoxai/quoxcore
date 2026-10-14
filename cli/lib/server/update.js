/**
 * C4: `quox server update` and `quox server rollback`.
 *
 * update:  preflight -> backup -> fetch -> build -> migrate -> health, with the state written after every
 *          step (resumable: a re-run continues after the last completed step). A failure from fetch on
 *          rolls back automatically: before `migrate` only the code moves back (data was never touched);
 *          from `migrate` on, the full rollback restores the pre-update snapshot.
 * rollback: previous snapshot + previous version: checkout, build, restore DB + config, start, health.
 *
 * Migrations run on service boot (each service applies its own on start), so `migrate` = `up -d`, and
 * `health` proves they finished: every service answers and the collector's /version is the new commit.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readInstalled, readEnvKeys, fetchAvailable, cmpSemver, parseSemver, vtag, compareUrl, releaseNotesUrl, PUBLIC_REPO, SIBLINGS } from './install.js';
import { readState, writeState, appendHistory, compose, diskFree, runningVersion, probeHttp } from './status.js';
import { createSnapshot, restoreSnapshot, latestSnapshot, listSnapshots } from './snapshot.js';
import { gate } from './sys.js';

export const UPDATE_STEPS = ['preflight', 'backup', 'fetch', 'build', 'migrate', 'health'];
export const MIN_FREE_GB = 5;

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLine = (s) => String(s || '').trim().split('\n').pop();

/** Poll auth + collector /health, and (when known) the collector /version == expectCommit. */
export async function waitHealthy({ urls, fetchImpl, expectCommit = null, tries = 40, intervalMs = 3000, sleep = sleepDefault, log = () => {} }) {
  let last = '';
  for (let i = 0; i < Math.max(1, tries); i++) {
    const http = await probeHttp(urls, fetchImpl);
    const bad = http.filter((h) => !h.ok);
    if (!bad.length) {
      if (!expectCommit) return { ok: true };
      const v = await runningVersion(urls.collector, fetchImpl);
      if (v.ok && v.commit && (String(v.commit).startsWith(expectCommit) || String(expectCommit).startsWith(v.commit))) return { ok: true, commit: v.commit };
      last = v.ok ? `collector reports ${v.commit}, expected ${expectCommit}` : `collector /version: ${v.error}`;
    } else last = bad.map((h) => `${h.name}: ${h.detail}`).join(', ');
    log(`waiting for health: ${last}`);
    if (i + 1 < tries) await sleep(intervalMs);
  }
  return { ok: false, error: last || 'not healthy' };
}

async function checkoutCode({ install, g, ref, siblings = {}, pullSiblings = false, log }) {
  const r = await g.mut('git', ['-C', install.repoDir, 'checkout', '--detach', ref]);
  if (r.code !== 0) return { ok: false, error: `git checkout ${ref} failed: ${lastLine(r.stderr)}` };
  for (const s of SIBLINGS) {
    const d = join(install.root, s);
    if (!existsSync(join(d, '.git'))) continue;
    const sr = pullSiblings ? await g.mut('git', ['-C', d, 'pull', '--ff-only'])
      : siblings[s] ? await g.mut('git', ['-C', d, 'checkout', '--detach', siblings[s]]) : { code: 0 };
    if (sr.code !== 0) log(`warning: ${s} did not move (${lastLine(sr.stderr) || `exit ${sr.code}`}); it stays where it was`);
  }
  return { ok: true };
}

async function composeBuild({ install, g, commit }) {
  const gid = readEnvKeys(install.repoDir, ['DOCKER_GID']).DOCKER_GID;
  const r = await g.mut('docker', compose(install, ['build']), { cwd: install.repoDir, env: { QUOXCORE_VERSION: commit, ...(gid ? { DOCKER_GID: gid } : {}) } });
  return r.code === 0 ? { ok: true } : { ok: false, error: `docker compose build failed (exit ${r.code}): ${lastLine(r.stderr)}` };
}

async function composeUp({ install, g }) {
  const r = await g.mut('docker', compose(install, ['up', '-d', '--remove-orphans']), { cwd: install.repoDir });
  return r.code === 0 ? { ok: true } : { ok: false, error: `docker compose up -d failed (exit ${r.code}): ${lastLine(r.stderr)}` };
}

/**
 * Plan + run an update. opts: { install, sys, backups, urls, fetchImpl, dryRun, to, force, restart, noRollback,
 * log, now, healthTries, healthIntervalMs, sleep, repo }
 * -> { ok, upToDate?, dryRun?, plan, planned?, failedStep?, error?, rolledBack?, rollback? }
 */
export async function runUpdate(opts) {
  const { install, sys, backups, urls, fetchImpl = globalThis.fetch, dryRun = false, force = false, restart = false, noRollback = false,
    log = () => {}, now = () => new Date(), healthTries = 40, healthIntervalMs = 3000, sleep = sleepDefault, repo = PUBLIC_REPO } = opts;
  const g = gate(sys, { dryRun, log });

  // ---- preflight (read-only) ----------------------------------------------------------------------
  const installed = await readInstalled(install, sys);
  let target = opts.to ? vtag(opts.to) : null;
  if (!target) {
    const av = await fetchAvailable({ fetchImpl, repo });
    if (!av.ok) return { ok: false, failedStep: 'preflight', error: `could not read the available versions: ${av.error}` };
    target = av.latest;
  } else if (!parseSemver(target)) return { ok: false, failedStep: 'preflight', error: `--to ${opts.to} is not a version like 4.3.0` };
  const current = installed.release ? vtag(installed.release) : null;
  const plan = {
    current, currentCommit: installed.commit, target,
    changes: current ? compareUrl(current, target, repo) : null, releaseNotes: releaseNotesUrl(target, repo),
    backups, steps: UPDATE_STEPS
  };
  const cmp = current ? cmpSemver(target, current) : 1;
  if (cmp !== null && cmp <= 0 && !force) return { ok: true, upToDate: true, plan };

  const problems = [];
  const forceable = [];
  if (installed.dirty) forceable.push(`the checkout at ${install.repoDir} has local changes (git status); commit or discard them, or pass --force`);
  if (installed.dirty === null) problems.push(`${install.repoDir} is not a git checkout, so it cannot be moved to ${target}`);
  const disk = await diskFree(install.root, sys);
  if (disk.ok && disk.freeGB < MIN_FREE_GB) forceable.push(`only ${disk.freeGB} GB free at ${install.root}; an update needs at least ${MIN_FREE_GB} GB (backup + images)`);
  const dv = await sys.run('docker', ['compose', 'version', '--short']);
  if (dv.code !== 0) problems.push('docker compose is not available to this user');
  plan.problems = [...problems, ...forceable];
  if (problems.length || (forceable.length && !force)) return { ok: false, failedStep: 'preflight', error: plan.problems.join('; '), plan };

  // ---- resume -------------------------------------------------------------------------------------
  const prev = readState(backups);
  let state = null;
  if (prev && prev.op === 'update' && prev.status === 'running') {
    if (prev.target !== target && !restart) {
      return { ok: false, failedStep: 'preflight', error: `an update to ${prev.target} stopped after ${prev.done.slice(-1)[0] || 'preflight'}. Re-run without --to to resume it, or pass --restart to abandon it.`, plan };
    }
    if (prev.target === target) {
      state = prev;
      plan.resumedAfter = state.done.slice(-1)[0] || 'preflight';
      log(`resuming the update to ${target} after ${plan.resumedAfter}`);
    }
  }
  if (!state) state = { op: 'update', status: 'running', target, from: { release: installed.release, commit: installed.commit, siblings: installed.siblings }, done: ['preflight'], snapshot: null, startedAt: now().toISOString() };
  const save = () => { if (!dryRun) writeState(backups, { ...state, updatedAt: now().toISOString() }); };
  const mark = (s) => { if (!state.done.includes(s)) state.done.push(s); save(); };
  const doneStep = (s) => state.done.includes(s);
  const finish = (status, extra = {}) => {
    state.status = status; save();
    if (!dryRun) appendHistory(backups, { op: 'update', status, at: now().toISOString(), from: state.from.release || state.from.commit, to: target, snapshot: state.snapshot, ...extra });
  };
  save();

  const fail = async (step, error) => {
    log(`✖ ${step}: ${error}`);
    if (noRollback || dryRun) { finish('failed', { failedStep: step, error }); return { ok: false, failedStep: step, error, plan, rolledBack: false }; }
    log('rolling back automatically');
    let rb;
    if (['fetch', 'build'].includes(step)) {
      const c = await checkoutCode({ install, g, ref: state.from.commit, siblings: state.from.siblings, log });
      const h = c.ok ? await waitHealthy({ urls, fetchImpl, tries: healthTries, intervalMs: healthIntervalMs, sleep, log }) : c;
      rb = { ok: c.ok && h.ok, scope: 'code only (data was never touched)', error: c.ok ? h.error : c.error };
    } else {
      rb = await runRollback({ ...opts, snapshotDir: state.snapshot, fromUpdate: true });
      rb.scope = 'code + data from the pre-update snapshot';
    }
    finish(rb.ok ? 'rolled-back' : 'rollback-failed', { failedStep: step, error });
    return { ok: false, failedStep: step, error, plan, rolledBack: rb.ok, rollback: rb };
  };

  // ---- backup -------------------------------------------------------------------------------------
  if (!doneStep('backup')) {
    const snap = await createSnapshot({ install, installed, backups, g, reason: `before update to ${target}`, now, log });
    if (!snap.ok) {
      finish('failed', { failedStep: 'backup', error: snap.error });
      return { ok: false, failedStep: 'backup', error: `${snap.error}. Nothing was changed.`, plan, rolledBack: false };
    }
    state.snapshot = snap.dir; mark('backup');
  }
  plan.snapshot = state.snapshot;

  // ---- fetch --------------------------------------------------------------------------------------
  if (!doneStep('fetch')) {
    const tagRef = `refs/tags/${target}`;
    const has = await g.ro('git', ['-C', install.repoDir, 'rev-parse', '-q', '--verify', tagRef]);
    if (has.code !== 0) {
      const f1 = await g.mut('git', ['-C', install.repoDir, 'fetch', '--tags', 'origin']);
      const again = dryRun ? { code: 1 } : await g.ro('git', ['-C', install.repoDir, 'rev-parse', '-q', '--verify', tagRef]);
      if (f1.code !== 0 || again.code !== 0) {
        const f2 = await g.mut('git', ['-C', install.repoDir, 'fetch', `https://github.com/${repo}.git`, `+${tagRef}:${tagRef}`]);
        if (f2.code !== 0) return fail('fetch', `could not fetch ${target} from origin or ${repo}`);
      }
    }
    const c = await checkoutCode({ install, g, ref: target, pullSiblings: true, log });
    if (!c.ok) return fail('fetch', c.error);
    mark('fetch');
  }

  // ---- build --------------------------------------------------------------------------------------
  const rc = await g.ro('git', ['-C', install.repoDir, 'rev-parse', '--short', `${target}^{commit}`]);
  const newCommit = rc.code === 0 && rc.stdout.trim() ? rc.stdout.trim() : null;
  plan.targetCommit = newCommit;
  if (!doneStep('build')) {
    const b = await composeBuild({ install, g, commit: newCommit || target });
    if (!b.ok) return fail('build', b.error);
    mark('build');
  }

  // ---- migrate (on boot) --------------------------------------------------------------------------
  if (!doneStep('migrate')) {
    const u = await composeUp({ install, g });
    if (!u.ok) return fail('migrate', u.error);
    mark('migrate');
  }

  // ---- health -------------------------------------------------------------------------------------
  if (dryRun) {
    log(`[dry run] would wait for auth + collector /health and the collector /version to report ${newCommit || target}`);
    return { ok: true, dryRun: true, plan, planned: g.planned };
  }
  const h = await waitHealthy({ urls, fetchImpl, expectCommit: newCommit, tries: healthTries, intervalMs: healthIntervalMs, sleep, log });
  if (!h.ok) return fail('health', h.error);
  mark('health');
  finish('ok');
  return { ok: true, plan };
}

/** opts: { install, sys, backups, urls, fetchImpl, dryRun, snapshotDir, log, healthTries, ... } */
export async function runRollback(opts) {
  const { install, sys, backups, urls, fetchImpl = globalThis.fetch, dryRun = false, log = () => {}, now = () => new Date(),
    healthTries = 40, healthIntervalMs = 3000, sleep = sleepDefault, fromUpdate = false } = opts;
  const g = gate(sys, { dryRun, log });
  const snaps = listSnapshots(backups);
  const snap = opts.snapshotDir ? snaps.find((s) => s.dir === opts.snapshotDir || s.dir.endsWith(`/${opts.snapshotDir}`)) : latestSnapshot(backups);
  if (!snap) return { ok: false, error: opts.snapshotDir ? `no complete snapshot at ${opts.snapshotDir}` : `no snapshot in ${backups}; nothing to roll back to` };
  const plan = { snapshot: snap.dir, release: snap.release, commit: snap.commit, createdAt: snap.createdAt };
  const record = (status, extra = {}) => {
    if (!dryRun && !fromUpdate) appendHistory(backups, { op: 'rollback', status, at: now().toISOString(), to: snap.release || snap.commit, snapshot: snap.dir, ...extra });
  };
  if (!snap.commit) return { ok: false, error: 'the snapshot does not record which commit it came from', plan };

  const c = await checkoutCode({ install, g, ref: snap.commit, siblings: snap.siblings, log });
  if (!c.ok) { record('failed', { error: c.error }); return { ok: false, step: 'checkout', error: c.error, plan }; }
  const b = await composeBuild({ install, g, commit: snap.commit });
  if (!b.ok) { record('failed', { error: b.error }); return { ok: false, step: 'build', error: b.error, plan }; }
  const r = await restoreSnapshot({ install, snap, g, sleep });
  if (!r.ok) { record('failed', { error: r.error }); return { ok: false, step: 'restore', error: r.error, plan }; }
  const u = await composeUp({ install, g });
  if (!u.ok) { record('failed', { error: u.error }); return { ok: false, step: 'start', error: u.error, plan }; }
  if (dryRun) {
    log(`[dry run] would wait for health and the collector /version to report ${snap.commit}`);
    return { ok: true, dryRun: true, plan, planned: g.planned };
  }
  const h = await waitHealthy({ urls, fetchImpl, expectCommit: snap.commit, tries: healthTries, intervalMs: healthIntervalMs, sleep, log });
  if (!h.ok) { record('failed', { error: h.error }); return { ok: false, step: 'health', error: h.error, plan }; }
  if (!fromUpdate) writeState(backups, { op: 'rollback', status: 'ok', snapshot: snap.dir, at: now().toISOString() });
  record('ok');
  return { ok: true, plan };
}
