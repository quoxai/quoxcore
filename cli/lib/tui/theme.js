/**
 * QuoxCLI TUI Theme
 *
 * Color palette matching QuoxCORE brand (blue/cyan/violet gradient).
 * Inspired by QuoxBastion's BubbleTea TUI theme.
 *
 * Exports:
 *   colors  - hex color values
 *   styles  - chalk formatting functions
 *   BORDERS - box-drawing characters for panels
 */

import chalk from 'chalk';

// ── Brand color palette ───────────────────────────────────────────────
export const colors = {
  // Brand gradient
  primary:    '#3B82F6',   // electric blue
  secondary:  '#6366F1',   // indigo
  accent:     '#C084FC',   // lilac

  // Status
  success:    '#22C55E',
  error:      '#EF4444',
  warning:    '#FBBF24',

  // Highlights
  cyberBlue:  '#38BDF8',
  info:       '#38BDF8',

  // Text hierarchy
  text:       '#E4E4E7',
  textMuted:  '#A1A1AA',
  dim:        '#71717A',
  subtle:     '#3F3F46',

  // Backgrounds
  bgPanel:    '#111827',
  bgHighlight:'#1E293B',
};

// ── Chalk-based style functions ───────────────────────────────────────
export const styles = {
  // Headings
  title:      (t) => chalk.hex(colors.primary).bold(t),
  subtitle:   (t) => chalk.hex(colors.secondary)(t),
  heading:    (t) => chalk.hex(colors.accent).bold(t),

  // Text
  text:       (t) => chalk.hex(colors.text)(t),
  muted:      (t) => chalk.hex(colors.textMuted)(t),
  dim:        (t) => chalk.hex(colors.dim)(t),
  subtle:     (t) => chalk.hex(colors.subtle)(t),

  // Status
  success:    (t) => chalk.hex(colors.success)(t),
  error:      (t) => chalk.hex(colors.error).bold(t),
  warning:    (t) => chalk.hex(colors.warning)(t),
  info:       (t) => chalk.hex(colors.cyberBlue)(t),

  // Brand
  primary:    (t) => chalk.hex(colors.primary)(t),
  secondary:  (t) => chalk.hex(colors.secondary)(t),
  accent:     (t) => chalk.hex(colors.accent)(t),
  cyber:      (t) => chalk.hex(colors.cyberBlue).bold(t),

  // Compound
  label:      (t) => chalk.hex(colors.textMuted).bold(t),
  key:        (t) => chalk.hex(colors.cyberBlue).bold(t),
  value:      (t) => chalk.hex(colors.text)(t),
  badge:      (t) => chalk.hex(colors.bgPanel).bgHex(colors.primary).bold(` ${t} `),
  badgeAccent:(t) => chalk.hex(colors.bgPanel).bgHex(colors.accent).bold(` ${t} `),

  // Inline status indicators
  statusDot: (status) => {
    const map = {
      online:  chalk.hex(colors.success)('\u25CF'),
      healthy: chalk.hex(colors.success)('\u25CF'),
      active:  chalk.hex(colors.success)('\u25CF'),
      warning: chalk.hex(colors.warning)('\u25CF'),
      degraded:chalk.hex(colors.warning)('\u25CF'),
      error:   chalk.hex(colors.error)('\u25CF'),
      offline: chalk.hex(colors.error)('\u25CF'),
      unknown: chalk.hex(colors.dim)('\u25CB'),
    };
    return map[status] || map.unknown;
  },
};

// ── Box-drawing border characters ─────────────────────────────────────
export const BORDERS = {
  topLeft:     '\u256D',   // ╭
  topRight:    '\u256E',   // ╮
  bottomLeft:  '\u2570',   // ╰
  bottomRight: '\u256F',   // ╯
  horizontal:  '\u2500',   // ─
  vertical:    '\u2502',   // │
  teeRight:    '\u251C',   // ├
  teeLeft:     '\u2524',   // ┤
  teeDown:     '\u252C',   // ┬
  teeUp:       '\u2534',   // ┴
  cross:       '\u253C',   // ┼
};
