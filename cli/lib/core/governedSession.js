/**
 * Governed sessions: run any interactive program (claude, codex, the Quox TUI)
 * inside a tmux session `quox-...` that survives sleep and wifi drops and
 * reattaches with no context reload. argv arrays only; user input never reaches
 * a shell string.
 *
 * Session naming: claude keeps the legacy untagged form `quox-NAME`; other
 * programs carry a tag: `quox-codex-NAME`, `quox-tui-NAME`. `quox sessions ls`
 * derives the PROGRAM column from that tag.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { qArt, colorOn } from './banner.js';

const NAME_RE = /^[A-Za-z0-9._-]{1,48}$/;
export const PREFIX = 'quox-';
export const HELP_KEY = 'h';
export const HELP_COMMAND = 'quox sessions help --wait';

export const validateName = (n) => typeof n === 'string' && NAME_RE.test(n);

export function autoName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `s-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * Program registry. One entry per known CLI; adding the next one is one entry.
 * tag '' means legacy untagged (claude). resumeHint(bare, full) is the plain
 * words command that gets you back after a reboot. Unknown programs (quox wrap)
 * use GENERIC: the session carries the tag `run-<program>-` and the hint is
 * `quox sessions attach FULLNAME`.
 */
export const PROGRAMS = {
  claude: { tag: '', bin: 'claude', resumeHint: (n) => `quox claude --resume ${n}` },
  codex: { tag: 'codex-', bin: 'codex', resumeHint: (n) => `quox codex resume ${n}` },
  // gemini resumes by index or "latest" (--resume latest | --resume N), not by name.
  gemini: { tag: 'gemini-', bin: 'gemini', resumeHint: () => 'quox gemini --resume latest' },
  tui: { tag: 'tui-', bin: 'quox', resumeHint: (n) => `quox tui --governed --name ${n}` },
};

export const GENERIC_TAG = 'run-';
const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,47}$/;
export const validateProgram = (p) => typeof p === 'string' && PROGRAM_RE.test(p);
/** Tag segment for a generic program: no hyphens so the name parses back. */
export const programSeg = (bin) => String(bin).replace(/-/g, '_');

const TAGGED = Object.entries(PROGRAMS).filter(([, v]) => v.tag);

/** Resume hint for any program name (registry entry or generic). */
export function resumeHintFor(program, bare, full) {
  const e = PROGRAMS[program];
  return e ? e.resumeHint(bare) : `quox sessions attach ${full || bare}`;
}

/** Find an executable on PATH without a shell. Returns path or null. */
export function whichSync(bin, envPath = process.env.PATH || '') {
  if (!validateProgram(bin)) return null;
  for (const dir of String(envPath).split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, bin);
    try {
      if (!fs.statSync(f).isFile()) continue;
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Full session name (without the quox- prefix) for a program + user name. */
export const taggedName = (program, name, bin) =>
  (program === 'run' ? `${GENERIC_TAG}${programSeg(bin)}-` : PROGRAMS[program]?.tag || '') + name;

/** Program for a session name (without prefix). Untagged means claude. */
export function programOf(name) {
  const n = String(name);
  for (const [p, v] of TAGGED) if (n.startsWith(v.tag)) return p;
  const m = /^run-([^-]+)-/.exec(n);
  if (m) return m[1];
  return 'claude';
}

/** Name the user chose, with the program tag stripped. */
export const bareName = (name) => {
  const n = String(name);
  const p = programOf(n);
  if (PROGRAMS[p]) return PROGRAMS[p].tag ? n.slice(PROGRAMS[p].tag.length) : n;
  return n.replace(/^run-[^-]+-/, '');
};

/** argv for the program inside the session. */
export function programCmd(program, args, bin) {
  if (program === 'run') return [bin, ...args];
  const p = PROGRAMS[program];
  if (program === 'tui') return [p.bin, 'tui', ...args];
  return [p.bin, ...args];
}

/** Env vars (QUOX_PREATTACH_*) the SessionStart hook reads to attach/check out a slot. Empty when none requested. */
export function preattachEnv(pre) {
  const out = {};
  if (pre?.agent) out.QUOX_PREATTACH_AGENT = pre.agent;
  if (pre?.slot) out.QUOX_PREATTACH_SLOT = pre.slot;
  if ((pre?.agent || pre?.slot) && pre.session) out.QUOX_PREATTACH_SESSION = pre.session;
  return out;
}

const tmuxEnvArgs = (penv) => Object.entries(penv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

export function planLaunch({ name, args = [], env = {}, alive = false, resume = false, noTmux = false, program = 'claude', bin, preattach }) {
  const penv = preattachEnv(preattach);
  const tmuxSession = PREFIX + taggedName(program, name, bin);
  const cmdArgv = programCmd(program, args, bin);
  if (env.TMUX || noTmux) {
    return { mode: resume ? 'RESUME' : 'NEW', tmuxSession, cmd: cmdArgv, ...(Object.keys(penv).length ? { env: penv } : {}) };
  }
  if (alive) {
    return { mode: 'REATTACH', tmuxSession, cmd: ['tmux', 'attach-session', '-t', tmuxSession] };
  }
  return {
    mode: resume ? 'RESUME' : 'NEW',
    tmuxSession,
    cmd: ['tmux', 'new-session', ...tmuxEnvArgs(penv), '-s', tmuxSession, '--', ...cmdArgv],
    ...(Object.keys(penv).length ? { env: penv } : {}),
    ...(resume ? { note: 'A resume reloads the conversation context (costs tokens). Reattach is free.' } : {}),
  };
}

export function parseSessions(out) {
  return String(out || '')
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 4 && c[0].startsWith(PREFIX))
    .map((c) => {
      const name = c[0].slice(PREFIX.length);
      return {
        name,
        program: programOf(name),
        created: new Date(Number(c[1]) * 1000),
        attached: Number(c[2]) > 0,
        windows: Number(c[3]),
      };
    });
}

/** The plain-words cheat sheet, shared by the intro and the Ctrl-b h popup. */
export function howItWorksLines({ name, program = 'claude', bare }) {
  const b = bare || bareName(name);
  const full = name;
  return [
    ['Leave it running:', 'press Ctrl-b, then d'],
    ['Come back later:', `quox sessions attach ${name}`],
    ['See your sessions:', 'quox sessions ls'],
    ['Scroll back:', 'press Ctrl-b, then [   (q to stop)'],
    ['After a reboot:', resumeHintFor(program, b, full)],
    ['End it:', `quox sessions kill ${name}`],
    ['Help any time:', 'press Ctrl-b, then h'],
  ];
}

export function renderIntro({ name, host, mode, tmuxSession, note, program = 'claude', preattach }, { color = false } = {}) {
  const b = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const d = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const art = qArt(color);
  const modeText = {
    NEW: 'NEW',
    REATTACH: 'REATTACH (same process, no context reload)',
    RESUME: 'RESUME',
  }[mode] || mode;
  const text = [
    '',
    b('QUOX GOVERNED SESSION'),
    '',
    `${d('session     ')} ${name}`,
    `${d('program     ')} ${program}`,
    `${d('host        ')} ${host}`,
    `${d('mode        ')} ${modeText}`,
    `${d('tmux session')} ${tmuxSession}`,
    '',
    b('How this works'),
    ...howItWorksLines({ name, program }).map(([k, v]) => `${d(k.padEnd(19))}${v}`),
  ];
  const w = art[0] ? 14 : 0;
  const lines = [];
  for (let i = 0; i < Math.max(art.length, text.length); i++) {
    lines.push(`  ${art[i] || ' '.repeat(w)}   ${text[i] || ''}`);
  }
  let out = '\n' + lines.join('\n') + '\n';
  if (note) out += `  ${d(note)}\n`;
  if (mode !== 'REATTACH' && (preattach?.agent || preattach?.slot)) {
    const { agent, slot } = preattach;
    const what = agent ? `Attaching as ${agent}${slot ? ` \u00b7 slot ${slot}` : ''}` : `Holding slot ${slot}`;
    out += `  ${b(`${what} at session start`)}\n`;
    if (slot) out += `  ${d(`Talk to it from Discord in #${slot}`)}\n`;
  }
  return out + '\n';
}

/** Plain text for `quox sessions help` (no colour, no art). */
export function renderHelp({ name, program } = {}) {
  const n = name || '<name>';
  const p = program || (name ? programOf(name) : 'claude');
  const lines = howItWorksLines({ name: n, program: p, bare: name ? bareName(name) : '<name>' });
  return ['QUOX GOVERNED SESSION: How this works', '', ...lines.map(([k, v]) => `${k.padEnd(19)}${v}`), ''].join('\n');
}

function defaults(over = {}) {
  return {
    spawnSync: realSpawnSync,
    env: process.env,
    hostname: () => os.hostname(),
    now: () => new Date(),
    color: colorOn(),
    write: (s) => process.stdout.write(s),
    ...over,
  };
}

const tmuxMissing = (r) => r && r.error && r.error.code === 'ENOENT';

/** tmux -V output to [major, minor], or null if unknown. */
export function parseTmuxVersion(out) {
  const m = /(\d+)\.(\d+)/.exec(String(out || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const supportsPopup = (v) => !!v && (v[0] > 3 || (v[0] === 3 && v[1] >= 2));

/** argv (after `tmux`) that binds Ctrl-b h. Contains no user data. */
export function helpBindArgv(version) {
  if (supportsPopup(version)) {
    return ['bind-key', HELP_KEY, 'display-popup', '-E', '-w', '80%', '-h', '60%', HELP_COMMAND];
  }
  return ['bind-key', HELP_KEY, 'display-message',
    'Quox: Ctrl-b d leave it running | Ctrl-b [ scroll back | quox sessions ls | quox sessions help'];
}

/**
 * Bind Ctrl-b h idempotently (bind-key is tmux-server wide). Returns
 * 'cold' when no tmux server is running yet (nothing to bind into),
 * 'present' when already bound to the quox help, 'bound' otherwise, 'failed'.
 */
export function ensureHelpBinding(d) {
  const keys = d.spawnSync('tmux', ['list-keys', '-T', 'prefix'], { encoding: 'utf8' });
  if (!keys || keys.error || keys.status !== 0) return 'cold';
  if (String(keys.stdout || '').includes('quox sessions help')) return 'present';
  const v = d.spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  const r = d.spawnSync('tmux', helpBindArgv(parseTmuxVersion(v && v.stdout)), { stdio: 'ignore' });
  return r && r.status === 0 ? 'bound' : 'failed';
}

export function runGoverned({ program = 'claude', name, args = [], resume = false, noTmux = false, bin, preattach }, over) {
  const d = defaults(over);
  const n = name || autoName(d.now());
  if (program === 'run') {
    if (!validateProgram(bin)) {
      d.write(`Refusing program "${bin}": use a plain command name (letters, digits, dot, underscore, plus, hyphen), no paths or shell characters.\n`);
      return 2;
    }
    const found = (d.which || whichSync)(bin, d.env.PATH);
    if (!found) {
      d.write(`${bin} was not found on PATH.\n`);
      return 1;
    }
  }
  const full = taggedName(program, n, bin);
  if (!validateName(n) || !validateName(full)) {
    d.write(`Invalid session name "${n}". Use 1-48 characters: letters, digits, dot, underscore, hyphen.\n`);
    return 2;
  }
  let alive = false;
  if (!noTmux && !d.env.TMUX) {
    const r = d.spawnSync('tmux', ['has-session', '-t', '=' + PREFIX + full], { stdio: 'ignore' });
    if (tmuxMissing(r)) {
      d.write(`tmux is not installed. Install it (apt install tmux / brew install tmux), or run without it: quox ${program === 'tui' ? 'tui --governed' : program === 'run' ? `wrap ${bin}` : program} --no-tmux\n`);
      return 1;
    }
    alive = r.status === 0;
  }
  const plan = planLaunch({ name: n, args, env: d.env, alive, resume, noTmux, program, bin, preattach });
  const shown = program === 'run' ? bin : program;
  d.write(renderIntro({ name: full, host: d.hostname(), mode: plan.mode, tmuxSession: plan.tmuxSession, note: plan.note, program: shown, preattach }, { color: d.color }));
  let cmd = plan.cmd;
  const viaTmux = cmd[0] === 'tmux';
  if (viaTmux) {
    const state = ensureHelpBinding(d);
    if (state === 'cold' && plan.mode !== 'REATTACH') {
      // No tmux server yet: create the session detached so a server exists,
      // bind the help key into it, then attach.
      const created = d.spawnSync('tmux', ['new-session', '-d', ...tmuxEnvArgs(preattachEnv(preattach)), '-s', plan.tmuxSession, '--', ...programCmd(program, args, bin)], { stdio: 'ignore' });
      if (created && created.status !== 0) {
        d.write('Could not start the tmux session.\n');
        return 1;
      }
      ensureHelpBinding(d);
      cmd = ['tmux', 'attach-session', '-t', plan.tmuxSession];
    }
  }
  const [exe, ...exeArgs] = cmd;
  // Direct run (--no-tmux, or already inside tmux): the env rides the spawn.
  const r = d.spawnSync(exe, exeArgs, { stdio: 'inherit', ...(exe !== 'tmux' && plan.env ? { env: { ...d.env, ...plan.env } } : {}) });
  if (r && r.error) {
    d.write(`Could not run ${exe}: ${r.error.message || r.error.code}\n`);
    return 1;
  }
  return r && typeof r.status === 'number' ? r.status : 0;
}

function listSessions(d) {
  const r = d.spawnSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'], { encoding: 'utf8' });
  if (tmuxMissing(r)) return null;
  return r.status === 0 ? parseSessions(r.stdout) : [];
}

export function runLs(over) {
  const d = defaults(over);
  const s = listSessions(d);
  if (s === null) {
    d.write('tmux is not installed (apt install tmux / brew install tmux).\n');
    return 1;
  }
  if (!s.length) {
    d.write('No Quox sessions running. Start one with: quox claude (or quox codex, quox gemini, quox wrap <program>)\n');
    return 0;
  }
  const pad = (v, n) => String(v).padEnd(n);
  d.write(`${pad('NAME', 24)}${pad('PROGRAM', 12)}${pad('CREATED', 18)}${pad('ATTACHED', 10)}WINDOWS\n`);
  for (const x of s) {
    const c = x.created.toISOString().slice(0, 16).replace('T', ' ');
    d.write(`${pad(x.name, 24)}${pad(x.program, 12)}${pad(c, 18)}${pad(x.attached ? 'yes' : 'no', 10)}${x.windows}\n`);
  }
  return 0;
}

export function runKill(name, over) {
  const d = defaults(over);
  if (!validateName(name)) {
    d.write(`Invalid session name "${name}".\n`);
    return 2;
  }
  const has = d.spawnSync('tmux', ['has-session', '-t', '=' + PREFIX + name], { stdio: 'ignore' });
  if (has.status !== 0) {
    d.write(`No such session: ${name}. See: quox sessions ls\n`);
    return 1;
  }
  const r = d.spawnSync('tmux', ['kill-session', '-t', PREFIX + name], { stdio: 'ignore' });
  d.write(r.status === 0 ? `Killed ${name}.\n` : `Failed to kill ${name}.\n`);
  return r.status === 0 ? 0 : 1;
}

export function runAttach(name, over) {
  const d = defaults(over);
  if (!validateName(name)) {
    d.write(`Invalid session name "${name}".\n`);
    return 2;
  }
  const has = d.spawnSync('tmux', ['has-session', '-t', '=' + PREFIX + name], { stdio: 'ignore' });
  if (tmuxMissing(has)) {
    d.write('tmux is not installed (apt install tmux / brew install tmux).\n');
    return 1;
  }
  if (has.status !== 0) {
    d.write(`No such session: ${name}. See: quox sessions ls\n`);
    return 1;
  }
  const verb = d.env.TMUX ? 'switch-client' : 'attach-session';
  const r = d.spawnSync('tmux', [verb, '-t', PREFIX + name], { stdio: 'inherit' });
  return r && typeof r.status === 'number' ? r.status : 0;
}

/** `quox sessions help`: print the cheat sheet for the current (or given) session. */
export function runHelp({ wait = false } = {}, over) {
  const d = defaults(over);
  let name;
  if (d.env.TMUX) {
    const r = d.spawnSync('tmux', ['display-message', '-p', '#{session_name}'], { encoding: 'utf8' });
    const s = r && r.status === 0 ? String(r.stdout || '').trim() : '';
    if (s.startsWith(PREFIX) && validateName(s.slice(PREFIX.length))) name = s.slice(PREFIX.length);
  }
  d.write(renderHelp({ name }) + '\n');
  if (wait) {
    d.write('Press any key to close.\n');
    if (d.waitKey) d.waitKey();
    else if (process.stdin.isTTY) d.spawnSync('sh', ['-c', 'stty raw -echo; dd bs=1 count=1 >/dev/null 2>&1; stty sane'], { stdio: 'inherit' });
  }
  return 0;
}
