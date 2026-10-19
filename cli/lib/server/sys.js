/**
 * C4 lifecycle: the one place that runs host commands (docker, docker compose, git, df, tar, openssl).
 *
 * Every lifecycle module takes a `sys` and never spawns on its own, so tests pass a stub and a dry run
 * can prove it never reached a mutating command. A call marked { ro: true } is read-only and still runs
 * in a dry run (it is how the plan learns what is there); anything else is recorded, never run, when
 * dry. That rule lives here, once, in `gate()`.
 */
import { spawn as defaultSpawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';

/** -> { run(cmd, args, opts) -> Promise<{ code, stdout, stderr }> } */
export function createSys({ spawnImpl = defaultSpawn } = {}) {
  return {
    kind: 'real',
    run(cmd, args = [], { cwd, env, stdoutFile, stdinFile, stdinText, timeoutMs = 0 } = {}) {
      return new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: [stdinFile || typeof stdinText === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        } catch (e) { resolve({ code: 127, stdout: '', stderr: e.message }); return; }
        let stdout = ''; let stderr = '';
        const sink = stdoutFile ? createWriteStream(stdoutFile, { mode: 0o600 }) : null;
        if (sink) child.stdout.pipe(sink); else child.stdout.on('data', (d) => { if (stdout.length < 4e6) stdout += d; });
        child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
        if (stdinFile) createReadStream(stdinFile).pipe(child.stdin);
        else if (typeof stdinText === 'string') child.stdin.end(stdinText); // secrets via stdin, never argv
        const timer = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs) : null;
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr || e.message }); });
        child.on('close', (code, sig) => {
          clearTimeout(timer);
          const done = () => resolve({ code: sig ? 128 : code, stdout, stderr });
          if (sink) sink.end(done); else done();
        });
      });
    }
  };
}

export const show = (cmd, args = []) => [cmd, ...args].map((a) => (/^[\w./:=@%+,-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ');

/**
 * A step runner over sys: ro calls always run; mutating calls run only when !dryRun, else they are
 * recorded in `planned` and answered { code: 0, dry: true }. log(line) receives every command shown.
 */
export function gate(sys, { dryRun = false, log = () => {} } = {}) {
  const planned = [];
  return {
    dryRun,
    planned,
    async ro(cmd, args, opts) { return sys.run(cmd, args, opts); },
    async mut(cmd, args, opts = {}) {
      const line = show(cmd, args) + (opts.stdoutFile ? ` > ${opts.stdoutFile}` : '') + (opts.stdinFile ? ` < ${opts.stdinFile}` : '');
      if (dryRun) { planned.push(line); log(`[dry run] ${line}`); return { code: 0, stdout: '', stderr: '', dry: true }; }
      log(`$ ${line}`);
      return sys.run(cmd, args, opts);
    },
    /** A filesystem change (or any non-command effect): described, and only performed when !dryRun. */
    async fx(desc, fn) {
      if (dryRun) { planned.push(desc); log(`[dry run] ${desc}`); return undefined; }
      log(desc);
      return fn();
    }
  };
}
