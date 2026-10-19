/**
 * /config settings, saved on the CLI config profile (profile.quoxon = { theme, motion, verbose }), so a
 * choice survives restarts and follows `-p`. Theme replaces the env-only QUOX_THEME: the saved value is
 * applied by setting the variable the theme module already reads, unless the user's shell set it, in
 * which case the shell wins and the card says so.
 */
import { PROFILE_IDS } from '../sound/mapping.js';
import { LEVELS, DEFAULT_LEVEL, normaliseLevel } from '../motion/level.js';

// Captured at import, before anything here writes it: what the user's shell set.
const SHELL = {
  theme: process.env.QUOX_THEME || null,
  motion: process.env.QUOX_REDUCED_MOTION === '1' ? 'quiet' : (normaliseLevel(process.env.QUOX_MOTION) || null),
  motionVar: process.env.QUOX_REDUCED_MOTION === '1' ? 'QUOX_REDUCED_MOTION' : 'QUOX_MOTION',
};


/** The settings this build can honour. Sound is the /sound controller's own profile (server-side soundProfile). */
export function settingsList({ sound = true } = {}) {
  return [
    { id: 'theme', label: 'Theme', values: ['auto', 'dark', 'light'], def: 'auto', help: 'auto follows your terminal background' },
    { id: 'motion', label: 'Motion', values: LEVELS, def: DEFAULT_LEVEL, help: 'quiet stills it all; expressive adds glows; cinematic adds the dragon' },
    ...(sound ? [{ id: 'sound', label: 'Sound', values: PROFILE_IDS, def: 'minimal', help: 'same as /sound; saved to your account' }] : []),
    { id: 'verbose', label: 'Verbose', values: ['off', 'on', 'full'], def: 'on', help: 'protocol lines in turns' },
    { id: 'slotBell', label: 'Slot bell', values: ['off', 'on'], def: 'on', help: 'a terminal bell when a slot message arrives' },
    { id: 'model', label: 'Model', action: 'model', help: 'Enter opens /model' }
  ];
}

/** Apply saved look settings to this process. -> { themeFromShell, motionFromShell }. */
export function applySettings(s = {}, env = process.env, shell = SHELL) {
  if (!shell.theme) {
    if (s.theme === 'dark' || s.theme === 'light') env.QUOX_THEME = s.theme; else delete env.QUOX_THEME;
  }
  if (!shell.motion) {
    const level = normaliseLevel(s.motion) || DEFAULT_LEVEL; // pre-levels profiles saved full / reduced
    if (level === DEFAULT_LEVEL) delete env.QUOX_MOTION; else env.QUOX_MOTION = level;
    if (level === 'quiet') env.QUOX_REDUCED_MOTION = '1'; else delete env.QUOX_REDUCED_MOTION; // every older reader agrees
  }
  return { themeFromShell: Boolean(shell.theme), motionFromShell: Boolean(shell.motion) };
}

export const shellOverrides = () => ({ ...SHELL });

/** The card rows. `values` = current settings, `extra` = { model: label, verbose: current }. */
export function configRows(list, values, { shell = SHELL, model = 'auto' } = {}) {
  return list.map(it => {
    if (it.action === 'model') return { key: it.label, text: model, note: it.help };
    const v = it.id === 'motion' ? (normaliseLevel(values.motion) || it.def) : (values[it.id] ?? it.def);
    const motionVar = shell.motionVar || 'QUOX_MOTION';
    const forced = (it.id === 'theme' && shell.theme) ? `QUOX_THEME=${shell.theme} in your shell wins`
      : (it.id === 'motion' && shell.motion) ? (motionVar === 'QUOX_MOTION' ? `QUOX_MOTION=${shell.motion} in your shell wins` : `${motionVar} in your shell wins`) : null;
    return { key: it.label, text: it.values.map(x => (x === v ? `[${x}]` : x)).join('  '), note: forced || it.help };
  });
}

export const cycle = (it, cur, dir = 1) => {
  const i = it.values.indexOf((it.id === 'motion' ? normaliseLevel(cur) : cur) ?? it.def);
  return it.values[(i + dir + it.values.length) % it.values.length];
};
