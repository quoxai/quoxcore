/**
 * Is a dev observer wired to this install? /observe and /note exist only for the developer whose
 * window a QUOXON observer session watches; a customer has no observer, so for them these commands
 * are hidden (help, palette, autocomplete) and refuse with a plain line.
 *
 * The switch is config driven, in the same style as the dev-transcripts flag: QUOX_DEV_OBSERVER=1
 * turns it on for one shell, QUOX_DEV_OBSERVER=0 forces it off, otherwise the flag file
 * ~/.config/quox/dev-observer decides (touch it on a dev box; it survives new shells).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEV_OBSERVER_REFUSAL = 'No dev observer is set up on this install, so there is nothing to send this to.';

export function devObserverOn(env = process.env, { home = homedir(), exists = existsSync } = {}) {
  if (env.QUOX_DEV_OBSERVER === '0') return false;
  if (env.QUOX_DEV_OBSERVER === '1') return true;
  try { return exists(join(home, '.config', 'quox', 'dev-observer')); } catch { return false; }
}
