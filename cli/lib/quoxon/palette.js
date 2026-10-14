/**
 * The semantic palette (QUOXON-FW11). One role per MEANING, so a reader can see where prose stops and a thing
 * they can type starts:
 *
 *   prose    default text. White on dark, ink on light. Never grey.
 *   command  anything the user can type: /slash commands, `quox ...`, !bang, flags and args INCLUDED. The whole
 *            command is ONE span in ONE colour (never split into differently coloured parts).
 *   value    ids, names, numbers, paths, URLs (theme role `id`; theme's `value` stays the near-white card text).
 *   ok / warn / error   state. Carried by a glyph or label ("⚠"), never by tinting the sentence, so commands and
 *            values inside keep their own colours.
 *   brand    Quox purple: chrome only (logo, status-bar labels, headers). Never a command inside prose.
 *   quiet    secondary text and rules: a tinted, readable shade (never a mid-grey).
 *
 * Both tables: [truecolor hex, ansi256 index]. DARK >= 4.5:1 on #000, LIGHT >= 4.5:1 on #fff (tests).
 */
export const SEMANTIC_DARK = {
  prose: ['#f1f5f9', 255], command: ['#2dd4bf', 80], value: ['#93c5fd', 117],
  ok: ['#4ade80', 78], warn: ['#f59e0b', 214], error: ['#f87171', 210],
  brand: ['#a855f7', 135], quiet: ['#bcc8e8', 189], rule: ['#7c8fe0', 105]
};
export const SEMANTIC_LIGHT = {
  prose: ['#0f172a', 234], command: ['#0f766e', 30], value: ['#1d4ed8', 26],
  ok: ['#15803d', 28], warn: ['#b45309', 130], error: ['#b91c1c', 124],
  brand: ['#7e22ce', 91], quiet: ['#3b4f87', 60], rule: ['#7280c8', 104]
};
export const SEMANTIC_ROLES = Object.keys(SEMANTIC_DARK);

/** Is this hex a mid-grey? Low saturation in the middle of the lightness range (white and ink are allowed). */
export function isGrey(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return s < 0.25 && l > 0.2 && l < 0.85;
}

// ---- inline markup used by every notice producer --------------------------------------------------
// ⟦text⟧ = a command (one span, markers dropped on screen). ⟪text⟫ = a value. Helpers build them. (Not backticks:
// plain backticks already appear literally in notices.)
export const cmd = (s) => `⟦${s}⟧`;
export const val = (s) => `⟪${s}⟫`;
export const MARK = /⟦([^⟧\n]+)⟧|⟪([^⟫\n]+)⟫/g;
/** The on-screen characters of marked-up text (markers dropped). Use for width and wrapping. */
export const stripMarks = (s) => String(s ?? '').replace(MARK, (_, a, b) => a ?? b);
