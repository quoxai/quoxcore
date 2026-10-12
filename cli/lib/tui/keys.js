/**
 * QuoxCLI TUI Keybindings
 *
 * Defines keyboard shortcuts for the TUI and help overlay entries.
 * Vim-style navigation (h/j/k/l) plus standard arrow keys.
 *
 * Exports:
 *   KEYS     - action name → key arrays (for useInput matching)
 *   KEY_HELP - ordered list of { keys, desc } for the help overlay
 */

// ── Key mappings ──────────────────────────────────────────────────────
export const KEYS = {
  up:       ['up', 'k'],
  down:     ['down', 'j'],
  left:     ['left', 'h'],
  right:    ['right', 'l'],
  select:   ['return'],
  back:     ['escape'],
  tab:      ['tab'],
  search:   ['/'],
  help:     ['?'],
  quit:     ['q'],
  refresh:  ['r'],
  delete:   ['d'],
  edit:     ['e'],
  create:   ['c'],
  nextPage: ['n'],
  prevPage: ['p'],
  // Command palette. Ctrl+K can't be expressed as a plain input string
  // (matchKey's default case only compares `input === binding`), so the
  // Ctrl+K half is detected directly in app.jsx via `key.ctrl && input
  // === 'k'`. ':' works here since it's a normal single character.
  palette:  [':'],
};

// ── Help overlay entries ──────────────────────────────────────────────
export const KEY_HELP = [
  { keys: '\u2191/k  \u2193/j',  desc: 'Navigate' },
  { keys: 'Enter',               desc: 'Select' },
  { keys: 'Esc',                 desc: 'Back' },
  { keys: 'Tab',                 desc: 'Switch panel' },
  { keys: '/',                   desc: 'Search' },
  { keys: '?',                   desc: 'Help' },
  { keys: 'q',                   desc: 'Quit' },
  { keys: 'r',                   desc: 'Refresh' },
  { keys: 'n / p',               desc: 'Next / prev page' },
  { keys: 'c',                   desc: 'Create' },
  { keys: 'd',                   desc: 'Delete' },
  { keys: 'e',                   desc: 'Edit' },
  { keys: 'Ctrl+K / :',          desc: 'Command palette' },
  { keys: '1-0 o i v g h',       desc: 'Jump to screen (anywhere)' },
];

/**
 * Check whether a key + input flags match a named action.
 *
 * Usage with ink's useInput:
 *   useInput((input, key) => {
 *     if (matchKey('up', input, key)) { ... }
 *   });
 *
 * @param {string} action - key from KEYS (e.g. 'up', 'quit')
 * @param {string} input  - the raw character from useInput
 * @param {Object} key    - the key flags from useInput ({ return, escape, tab, upArrow, downArrow, leftArrow, rightArrow })
 * @returns {boolean}
 */
export function matchKey(action, input, key) {
  const bindings = KEYS[action];
  if (!bindings) return false;

  for (const binding of bindings) {
    switch (binding) {
      case 'up':     if (key.upArrow)    return true; break;
      case 'down':   if (key.downArrow)  return true; break;
      case 'left':   if (key.leftArrow)  return true; break;
      case 'right':  if (key.rightArrow) return true; break;
      case 'return': if (key.return)     return true; break;
      case 'escape': if (key.escape)     return true; break;
      case 'tab':    if (key.tab)        return true; break;
      default:
        if (input === binding) return true;
    }
  }

  return false;
}
