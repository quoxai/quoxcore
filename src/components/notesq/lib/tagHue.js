/**
 * Stable hue for a NotesQ tag, so a tag has the same colour in the list, cards, table, sidebar and
 * details rail. FNV-1a over the lowercased tag. Slate is excluded (it reads as "no colour").
 * HUES and chipClass are copied from contactsq/lib/chips.js to keep the plugin boundary clean.
 */
export const HUES = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'slate']
const TAG_HUES = HUES.filter((h) => h !== 'slate')

export function tagHue(tag) {
  const s = String(tag || '').trim().replace(/^#/, '').toLowerCase()
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return TAG_HUES[h % TAG_HUES.length]
}

/** className for a glassy hue chip (global classes in src/styles/qx-components.css). */
export function chipClass(hue, { size = 'xs', variant = 'static' } = {}) {
  return ['qx-chip', size ? `qx-chip--${size}` : '', `qx-chip--${variant}`, `qx-chip--hue-${HUES.includes(hue) ? hue : 'slate'}`].filter(Boolean).join(' ')
}

/** Static tag chip class for a tag. */
export const tagChipClass = (tag) => chipClass(tagHue(tag))
