/**
 * QUOXON-FW8: "!" commands. A line that starts with `!` runs on THIS machine, in the session cwd, and its output
 * is shown inline. It never reaches the model (no turn, no server call) and needs no approval card: it is the
 * user's own action on their own machine. Pure parsing plus one process runner; app.js owns the display.
 *
 *   !<shell command>        run via $SHELL -lc
 *   !quox <args> / !q <args> run THIS quox binary (not whatever is on PATH) with the current profile injected
 *   !!                       reserved (refused with a note)
 *
 * BANG-TTY (owner 2026-10-16): capture stays the default (so /share works), but a known interactive command
 * (needsTerminal, e.g. quox lucid deck, vim, top) or a captured run that failed for want of a terminal (ttyFailure)
 * is handed the terminal, the same way a slot run request is.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MAX_LINES = 2000;
export const MAX_BYTES = 256 * 1024;
export const SHARE_MAX_BYTES = 16 * 1024;
export const DEFAULT_TIMEOUT_MS = 120000;
export const KILL_GRACE_MS = 2000;
export const QUOX_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'quox.js');

/** -> null (not a bang line) | { kind: 'reserved' | 'empty' | 'shell' | 'quox', cmd?, args? } */
export function parseBang(line) {
  const t = String(line ?? '').replace(/^\s+/, '');
  if (!t.startsWith('!')) return null;
  if (t.startsWith('!!')) return { kind: 'reserved' };
  const rest = t.slice(1).trim();
  if (!rest) return { kind: 'empty' };
  const m = /^(quox|q)(?:\s+([\s\S]*))?$/.exec(rest);
  if (m) return { kind: 'quox', args: tokenize(m[2] || ''), cmd: rest };
  return { kind: 'shell', cmd: rest };
}

/** Minimal shell-ish word split: whitespace, 'single' and "double" quotes, backslash escapes outside single quotes. */
export function tokenize(s) {
  const out = []; let cur = ''; let has = false; let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

const hasProfile = (args) => args.some(a => a === '-p' || a === '--profile' || a.startsWith('--profile=') || /^-p.+/.test(a));
const INTERACTIVE = new Set(['tui', 'quoxon']);
// quox leaves that draw a full-screen view (first two positional words); `--interactive` anywhere also counts
const INTERACTIVE_QUOX = new Set(['lucid deck']);
const INTERACTIVE_FLAG = (a) => a === '--interactive'; // not -i: some leaves use it for other things
// shell programs that need a terminal whatever their arguments; ssh only when it has no remote command
const INTERACTIVE_SHELL = new Set(['vim', 'vi', 'nvim', 'nano', 'emacs', 'less', 'more', 'most', 'man', 'top', 'htop', 'btop', 'atop', 'watch', 'tmux', 'screen', 'mc', 'ranger']);
const SSH_VALUE_FLAGS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B']);

const quoxPositional = (args) => {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--profile') { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  return pos;
};

/** -> a short reason when this ! command needs a real terminal (hand it over), else null. */
export function needsTerminal(bang) {
  if (!bang || (bang.kind !== 'shell' && bang.kind !== 'quox')) return null;
  if (bang.kind === 'quox') {
    const args = bang.args || [];
    const pos = quoxPositional(args);
    const info = args.some(a => a === '--help' || a === '-h' || a === '--version' || a === '-V');
    if (!pos.length || info || INTERACTIVE.has(pos[0])) return null; // bare quox and tui stay refused (quoxArgv): this window IS that app
    if (INTERACTIVE_QUOX.has(pos.slice(0, 2).join(' '))) return `quox ${pos.slice(0, 2).join(' ')} is interactive`;
    if (args.some(INTERACTIVE_FLAG)) return 'it asked for --interactive';
    return null;
  }
  const words = tokenize(bang.cmd);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // FOO=1 less x
  if (/[|;&<>]/.test(bang.cmd)) return null; // a pipeline or redirect is the user's own plumbing: leave it captured
  const prog = (words[i] || '').split('/').pop();
  if (INTERACTIVE_SHELL.has(prog)) return `${prog} is interactive`;
  if (prog === 'ssh') {
    const rest = words.slice(i + 1); let host = -1;
    for (let k = 0; k < rest.length; k++) {
      if (SSH_VALUE_FLAGS.has(rest[k])) { k++; continue; }
      if (rest[k].startsWith('-')) continue;
      host = k; break;
    }
    if (host >= 0 && host === rest.length - 1) return 'ssh with no command opens a shell';
  }
  return null;
}

const TTY_FAIL = /needs an interactive terminal|not a tty|inappropriate ioctl|must be run (from|in) a terminal|(input|stdin|stdout) is not a terminal|requires a tty|no tty present/i;
/** -> true when a captured run failed because it had no terminal (re-run it handed over). */
export function ttyFailure(r) {
  if (!r || r.code === 0 || r.code == null || r.timedOut || r.killed) return false;
  return TTY_FAIL.test(String(r.text || '').slice(-2000));
}

/** -> { refuse: 'one-line hint' } | { argv: [...] } for process.execPath. */
export function quoxArgv(args, { profile, entry = QUOX_ENTRY } = {}) {
  // positional words: skip flags and the value that follows -p/--profile
  const pos = quoxPositional(args);
  const info = args.some(a => a === '--help' || a === '-h' || a === '--version' || a === '-V');
  const inject = profile && !hasProfile(args) ? ['-p', profile] : [];
  const argv = [entry, ...inject, ...args];
  // refuse = it cannot run captured inline; tty = the argv to hand the terminal to instead (BANG-TTY)
  if (!pos.length && !info) return { refuse: 'bare quox opens the full-screen app, which needs the terminal. Give it a subcommand, e.g. !quox inbox list (or !quox --help).' };
  if (INTERACTIVE.has(pos[0])) return { refuse: `quox ${pos[0]} is interactive and needs the terminal, so it cannot run inline. Open it in another terminal.` };
  if (needsTerminal({ kind: 'quox', args })) return { refuse: `quox ${pos.slice(0, 2).join(' ')} is interactive and needs the terminal, so it cannot run inline.`, tty: { argv } };
  return { argv };
}

const STDIN_HINT = /stdin|end of file|\bEOF\b|password|passphrase|\[y\/n\]|\(y\/n\)|continue\?|press (any )?key|enter .*:\s*$/i;

/**
 * Run one command. -> { kill(), done: Promise<result> }.
 * result: { code, signal, ms, timedOut, killed, lines, truncated, text, stdinNote }
 * onData(text) is called with accepted output only (capped at MAX_LINES / MAX_BYTES); `text` is the same capped capture.
 */
export function runBang(plan, { cwd = process.cwd(), env = process.env, timeoutMs, onData = () => {}, graceMs = KILL_GRACE_MS, now = Date.now, shell } = {}) {
  const tmo = Number(timeoutMs ?? env.QUOX_BANG_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const t0 = now();
  let file, args;
  if (plan.argv) { file = process.execPath; args = plan.argv; }
  else { file = shell || env.SHELL || '/bin/sh'; args = ['-lc', plan.cmd]; }
  const st = { timedOut: false, killed: false, lines: 0, acc: 0, bytes: 0, truncated: false, text: '', partial: false };
  let child, timer, killTimer;
  const done = new Promise((resolve) => {
    const finish = (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      const res = { code, signal, ms: now() - t0, timedOut: st.timedOut, killed: st.killed && !st.timedOut, lines: st.lines, truncated: st.truncated, text: st.text };
      if (code !== 0 && !st.timedOut && !st.killed && (!st.text.trim() || STDIN_HINT.test(st.text.slice(-400)))) res.stdinNote = 'This command got end-of-file on stdin (input is not available here), so it may have been waiting for input.';
      resolve(res);
    };
    try {
      child = spawn(file, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { st.text = String(e.message); return finish(127, null); }
    child.on('error', (e) => { st.text += `${e.message}\n`; onData(`${e.message}\n`); finish(127, null); });
    child.stdin.on('error', () => {});
    child.stdin.end(); // EOF immediately: nothing here can answer a prompt
    const take = (buf) => {
      let s = buf.toString('utf8');
      if (!s) return;
      for (const ch of s) if (ch === '\n') st.lines++;
      if (st.truncated) return;
      if (st.acc >= MAX_LINES) { st.truncated = true; return; }
      const room = MAX_BYTES - st.bytes;
      if (Buffer.byteLength(s) > room) { s = Buffer.from(s).subarray(0, Math.max(0, room)).toString('utf8'); st.truncated = true; }
      let nl = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\n' && st.acc + (++nl) >= MAX_LINES) { if (i + 1 < s.length) st.truncated = true; s = s.slice(0, i + 1); break; }
      }
      st.acc += (s.match(/\n/g) || []).length; st.bytes += Buffer.byteLength(s); st.text += s;
      if (s) onData(s);
    };
    const onOut = (b) => take(b);
    child.stdout.on('data', onOut); child.stderr.on('data', onOut);
    child.on('close', (code, signal) => finish(code, signal));
    timer = setTimeout(() => { st.timedOut = true; kill(); }, tmo);
  });
  function kill() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    st.killed = true;
    const sig = (s) => { try { process.kill(-child.pid, s); } catch { try { child.kill(s); } catch { /* gone */ } } };
    sig('SIGTERM');
    killTimer = setTimeout(() => sig('SIGKILL'), graceMs);
  }
  return { kill, done };
}

/** The "exit N · 1.2s" footer, plus the plain-words reasons. */
export function footer(r, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const secs = `${(r.ms / 1000).toFixed(1)}s`;
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)}s and was stopped · ${secs} (QUOX_BANG_TIMEOUT_MS changes the limit)`;
  if (r.killed) return `stopped (Ctrl+C) · ${secs}`;
  if (r.signal) return `killed by ${r.signal} · ${secs}`;
  return `exit ${r.code} · ${secs}`;
}

export const truncNote = (r) => `(output truncated, ${r.lines} lines)`;

/** Text to attach for /share: capped at SHARE_MAX_BYTES. -> { text, truncated } */
export function shareText(text, max = SHARE_MAX_BYTES) {
  const b = Buffer.from(String(text ?? ''), 'utf8');
  if (b.length <= max) return { text: String(text ?? ''), truncated: false };
  return { text: b.subarray(0, max).toString('utf8'), truncated: true };
}

/** The message sent to the model: the attached output, clearly framed, then the user's words. */
export function withShared(message, shared) {
  if (!shared?.length) return message;
  const blocks = shared.map(s => `[output of \`${s.cmd}\`${s.truncated ? ' (truncated)' : ''}]\n${s.text}`).join('\n\n');
  return `${message}\n\n${blocks}`;
}

/**
 * Make command output safe for Ink: keep SGR colour codes, drop every other escape sequence (cursor moves, OSC titles,
 * clears), resolve carriage-return rewrites (progress bars) to their last state, expand tabs, drop other control bytes.
 */
export function cleanOutput(s) {
  let t = String(s ?? '');
  t = t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, ''); // OSC
  t = t.replace(/\x1b\[([0-9;:]*)([\x20-\x2f]*)([\x40-\x7e])/g, (m, p, i, f) => (f === 'm' ? m : '')); // CSI: keep only colour
  t = t.replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, '').replace(/\x1b[@-Z\\-_]/g, '');
  t = t.replace(/\r\n/g, '\n').split('\n').map(l => { const i = l.lastIndexOf('\r'); return i >= 0 && i < l.length - 1 ? l.slice(i + 1) : l.replace(/\r/g, ''); }).join('\n');
  t = t.replace(/\t/g, '    ');
  return t.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');
}
