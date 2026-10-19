/**
 * SLOT-RUN B (owner 2026-10-16: "if its a request to run the command, let me just say yes"). A slot message may
 * carry ONE command for the human to run here (`quox slot say <slot> --run '<command>' "<why>"`, stored by the
 * collector as the message's `run` field, never executed server-side).
 *
 * The TUI shows it with the shared ask: "▶ SENDER asks you to run this here: why", the FULL command in a code
 * block (wrapped, never truncated: this is a confirm-what-you-see boundary), then "Run it? y/N/c". y hands the
 * terminal over (like /restart: the user's own shell, stdio inherited, so OTP and login prompts work), then
 * the TUI resumes and prints the exit code.
 *
 * Rules (non-negotiable): never auto-run; only from a verified sender (author_identity) in this org, otherwise
 * shown but refused; one command; the ask expires after RUN_TTL_MS; never through the model (no turn, never a
 * terminal_suggest_command offer); secret-shaped or destructive commands need "run" typed instead of y.
 */
import { spawnSync } from 'node:child_process';
import { askText, askAnswer } from './ask.js';
import { looksLikeKey } from './connect.js';
import { resolveCliSlash } from './slash/cliCommand.js';
import { tokenize } from './bang.js';
import { codeRows } from './slotFormat.js';
import { graphemes } from './textBuffer.js';
import { TERMINAL_RESTORE } from './slash/restart.js';
import { PASTE_ON } from './keys.js';

export const RUN_TTL_MS = 10 * 60 * 1000;
export const RUN_MAX_LEN = 2000;
// Same rule as the collector (devSlotMessagesStore validateRunCommand): one line, nothing that can make the
// screen differ from what runs (control/ESC/CR, bidi overrides, zero-width, line separators).
const RUN_BAD_RE = /[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

/** -> null (no run request) | { id, cmd, why, who, runnable, refuse, danger, expiresAt }. */
export function runRequest(m, { orgId = null, now = Date.now() } = {}) {
  if (!m || m.run === undefined || m.run === null || m.run === '') return null;
  const cmd = String(m.run);
  const who = String(m.from || m.author_identity || 'someone').replace(/\s*\(.*$/, '').trim() || 'someone';
  let refuse = null;
  if (!m.author_identity) refuse = `${who} is not a verified sender, so this window will not run it`;
  else if (orgId && m.org_id && m.org_id !== orgId) refuse = `it came from another org, so this window will not run it`;
  else if (cmd.length > RUN_MAX_LEN || !cmd.trim() || RUN_BAD_RE.test(cmd)) refuse = 'it is not one plain command on one line, so this window will not run it';
  return { id: m.id || null, cmd, why: String(m.text ?? '').trim(), who, runnable: !refuse, refuse, danger: refuse ? null : runDanger(cmd), expiresAt: now + RUN_TTL_MS };
}

// Destructive shell shapes (the bang runner has no shell danger list of its own; these are the ones that cost
// real work to undo). Matching one means "type run", never a refusal: it is the human's machine.
const DESTRUCTIVE = [
  /(^|[\s;&|(])rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*-[a-zA-Z]*[rRf]/, /(^|[\s;&|(])sudo\s/, /(^|[\s;&|(])doas\s/,
  /(^|[\s;&|(])mkfs(\.\w+)?\s/, /(^|[\s;&|(])dd\s+[^|;&]*\bof=/, />\s*\/dev\/(sd|nvme|hd|vd|disk)/,
  /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, /\bgit\s+push\b[^|;&]*\s(--force\b|-f\b|--force-with-lease\b|--delete\b)/,
  /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[a-zA-Z]*f/, /\bchmod\s+-R\b/, /\bchown\s+-R\b/,
  /:\(\)\s*\{/, /(^|[\s;&|(])(shutdown|reboot|halt|poweroff)\b/, /\bdrop\s+(table|database)\b/i, /\bdocker\s+(system\s+prune|volume\s+rm)\b/,
];

/** null when y is enough; otherwise the reason "run" must be typed. Reuses the bang secret check and the quox CLI leaf policy. */
export function runDanger(cmd) {
  const c = String(cmd || '');
  if (looksLikeKey(c)) return 'It contains something that looks like a key or token';
  const words = tokenize(c);
  if (words[0] === 'quox' || words[0] === 'q') {
    const hit = resolveCliSlash(`/${words[1] || ''}`, words.slice(2).map(w => (/[\s"']/.test(w) ? JSON.stringify(w) : w)).join(' '));
    if (hit?.cls === 'never') return `${hit.display} is a never-from-chat quox command`;
  }
  if (DESTRUCTIVE.some(re => re.test(c))) return /(^|[\s;&|(])(sudo|doas)\s/.test(c) ? 'It runs as root' : 'It looks destructive';
  return null;
}

/** 'run' | 'needs-run' (y on a dangerous one) | 'no' | 'chat' | 'command'. */
export function runAnswer(text, req) {
  const t = String(text ?? '').trim();
  if (/^run$/i.test(t)) return 'run';
  const a = askAnswer(t);
  if (a === 'yes') return req?.danger ? 'needs-run' : 'run';
  return a;
}

const len = (s) => graphemes(String(s)).length;
function wrapWords(text, width) {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (line && len(line) + 1 + len(w) > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/** The ask as rows of segments (render.js paints them; slotFormat rows shape). */
export function runAskRows(req, width) {
  const w = Math.max(20, width);
  const head = askText(`${req.who} asks you to run this here:`, { keys: '' }) + (req.why ? ` ${req.why}` : '');
  const rows = wrapWords(head, w).map((l, i) => [{ t: i ? `  ${l}` : l, role: 'ask', bold: true }]);
  // wrapWords may push an indented continuation over the width: re-wrap continuations at w - 2
  const fixed = [];
  for (const r of rows) { if (len(r[0].t) <= w) fixed.push(r); else for (const p of wrapWords(r[0].t, w - 2)) fixed.push([{ t: `  ${p}`, role: 'ask', bold: true }]); }
  fixed.push(...codeRows([req.cmd], w));
  let last;
  if (!req.runnable) last = { t: `✖ Not offered: ${req.refuse}. Copy it yourself only if you trust it.`, role: 'warn' };
  else if (req.danger) last = { t: askText('Type run to run it, n to skip?', { keys: 'run/N/c', reason: req.danger }), role: 'ask', bold: true };
  else last = { t: askText('Run it?'), role: 'ask', bold: true };
  for (const l of wrapWords(last.t, w)) fixed.push([{ ...last, t: l }]);
  return fixed;
}

/**
 * Run the command in the user's own shell with the terminal handed over (stdio inherited), then take it back.
 * The live frame is cleared first and padded after, so the TUI redraws below the command's output instead of
 * over it. -> { code, signal, ms } | { error, ms }.
 */
export function handOverRun({ cmd, file = null, args = null, env = process.env, cwd = process.cwd(), stdout = null, setRawMode = null, spawn = spawnSync, shell, now = Date.now, resume = '' }) {
  const tty = Boolean(stdout?.isTTY);
  const rows = tty ? Math.max(0, Number(stdout.frameRows) || 0) : 0;
  const put = (s) => { try { stdout.write(Buffer.from(s)); } catch { /* closed */ } };
  if (tty) put(`\r${rows ? `\x1b[${rows}A` : ''}\x1b[J${TERMINAL_RESTORE}`);
  try { setRawMode?.(false); } catch { /* not a tty */ }
  const t0 = now();
  let r;
  try { // file + args (BANG-TTY: !quox runs this binary's argv) or a shell command line
    r = file ? spawn(file, args || [], { stdio: 'inherit', cwd, env }) : spawn(shell || env.SHELL || '/bin/sh', ['-lc', cmd], { stdio: 'inherit', cwd, env });
  } catch (e) { r = { error: e }; }
  const ms = now() - t0;
  try { setRawMode?.(true); } catch { /* not a tty */ }
  if (tty) put(`\n${'\n'.repeat(rows)}${PASTE_ON}${resume}`); // resume: mouse tracking back on when /mouse on (QUOXON-MOUSE)
  if (r?.error) return { error: `${r.error.code || 'failed'}: ${r.error.message}`, ms };
  return { code: r?.status ?? null, signal: r?.signal || null, ms };
}

/** The footer after a hand-over run. */
export function runFooter(r) {
  const secs = `${(r.ms / 1000).toFixed(1)}s`;
  if (r.error) return `Could not start it: ${r.error}`;
  if (r.signal) return `killed by ${r.signal} · ${secs}`;
  return `exit ${r.code} · ${secs}`;
}
