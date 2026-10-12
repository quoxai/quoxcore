/**
 * terminalConfig.js — Centralized terminal constants
 *
 * Single source of truth for keyboard shortcuts and architecture limits.
 * All terminal modules import from here instead of using magic numbers.
 */

// ── Architecture Limits ─────────────────────────────────────────────────────
export const TERMINAL_LIMITS = {
  MAX_PANES: 4,
  MAX_WORKSPACES: 8,
  MAX_SCROLLBACK: 5000,
  WORKSPACE_WARN_THRESHOLD: 7,
};

// ── Keyboard Shortcuts ──────────────────────────────────────────────────────
// Each shortcut defines the key combo and an action id dispatched by the handler.
// `ctrl`, `shift`, `key` map to KeyboardEvent properties.

export const TERMINAL_SHORTCUTS = [
  {
    category: 'Pane Focus',
    items: [
      { keys: ['Ctrl', '1'], ctrl: true, shift: false, key: '1', action: 'focusPane0', description: 'Focus pane 1' },
      { keys: ['Ctrl', '2'], ctrl: true, shift: false, key: '2', action: 'focusPane1', description: 'Focus pane 2' },
      { keys: ['Ctrl', '3'], ctrl: true, shift: false, key: '3', action: 'focusPane2', description: 'Focus pane 3' },
      { keys: ['Ctrl', '4'], ctrl: true, shift: false, key: '4', action: 'focusPane3', description: 'Focus pane 4' },
    ],
  },
  {
    category: 'Terminal',
    items: [
      { keys: ['Ctrl', '\\'], ctrl: true, shift: false, key: '\\', action: 'toggleChat', description: 'Toggle AI chat' },
      { keys: ['Ctrl', 'Shift', 'L'], ctrl: true, shift: true, key: 'L', action: 'clearTerminal', description: 'Clear focused terminal' },
    ],
  },
  {
    category: 'Workspaces',
    items: [
      { keys: ['Ctrl', 'Shift', 'N'], ctrl: true, shift: true, key: 'N', action: 'newWorkspace', description: 'New workspace tab' },
      { keys: ['Ctrl', 'Shift', 'W'], ctrl: true, shift: true, key: 'W', action: 'closeWorkspace', description: 'Close current workspace' },
    ],
  },
  {
    category: 'Vim',
    items: [
      { keys: ['Ctrl', 'Shift', 'V'], ctrl: true, shift: true, key: 'V', action: 'toggleVim', description: 'Toggle vim keybindings' },
    ],
  },
  {
    category: 'Help',
    items: [
      { keys: ['Ctrl', '?'], ctrl: true, shift: false, key: '?', action: 'showShortcuts', description: 'Show keyboard shortcuts' },
    ],
  },
];

/**
 * Match a KeyboardEvent against the shortcut definitions.
 * Returns the action string if matched, null otherwise.
 */
export function matchShortcut(event) {
  // Normalize: Shift changes the key for some chars (/ → ?)
  const key = event.key;
  const ctrl = event.ctrlKey || event.metaKey;
  const shift = event.shiftKey;

  for (const category of TERMINAL_SHORTCUTS) {
    for (const shortcut of category.items) {
      if (
        ctrl === shortcut.ctrl &&
        shift === shortcut.shift &&
        key === shortcut.key
      ) {
        return shortcut.action;
      }
    }
  }
  return null;
}

// ── Vim Keybindings ─────────────────────────────────────────────────────────
// Supported commands in NORMAL mode. INSERT mode passes all keys to xterm.

export const VIM_BINDINGS = {
  // Keys that switch to INSERT mode (all keys pass to shell)
  INSERT_KEYS: ['i', 'a'],
  // Scroll navigation
  SCROLL_LINE_DOWN: 'j',
  SCROLL_LINE_UP: 'k',
  SCROLL_HALF_PAGE_DOWN: 'd',   // Ctrl+d in NORMAL mode
  SCROLL_HALF_PAGE_UP: 'u',     // Ctrl+u in NORMAL mode
  SCROLL_TO_BOTTOM: 'G',
  SCROLL_TO_TOP_TRIGGER: 'g',   // gg = double-tap g
  // Timing
  GG_TIMEOUT_MS: 1000,          // Max gap between g presses for gg
};
