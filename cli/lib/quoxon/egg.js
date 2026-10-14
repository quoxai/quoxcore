/**
 * The launch Easter egg (CLI-QUOX). On launch the v8 dragon greets you (googly eyes open, blink, smile), rarely:
 * 1 in EGG_ODDS launches, never twice in a row, never in --print, under reduced motion or off a TTY.
 * /dragon plays it on demand, and the cinematic motion level always may.
 *
 * pickLaunchEgg is pure; launchEgg adds the one bit of persistence (did the last launch show the eye?) in
 * ~/.config/quox/motion.json. QUOX_EGG=eye forces it (demos, captures); QUOX_EGG=off disables it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const EGG_ODDS = 20;

/** Pure decision. */
export function pickLaunchEgg({ rand = Math.random, lastWasEye = false, print = false, reduced = false, tty = true, force = null } = {}) {
  if (print || reduced || !tty) return false;
  if (force === 'off') return false;
  if (force === 'eye') return true;
  if (lastWasEye) return false;
  return rand() < 1 / EGG_ODDS;
}

export const eggStatePath = (env = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'quox', 'motion.json');

/** Decide once for this launch and remember the outcome. Never throws: an unreadable file means "no eye last time". */
export function launchEgg({ env = process.env, tty = Boolean(process.stdout?.isTTY), print = false, rand = Math.random, path = eggStatePath(env) } = {}) {
  let last = false;
  try { last = Boolean(JSON.parse(readFileSync(path, 'utf8')).lastEye); } catch { /* first launch */ }
  const reduced = env.QUOX_REDUCED_MOTION === '1' || Boolean(env.QUOX_TUI_LITE);
  const eye = pickLaunchEgg({ rand, lastWasEye: last, print, reduced, tty, force: env.QUOX_EGG || null });
  if (!print && tty) {
    try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ lastEye: eye }) + '\n'); } catch { /* read-only home: fine */ }
  }
  return eye;
}
