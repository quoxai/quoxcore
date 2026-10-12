/**
 * Chip hues: ONE hue per meaning, so a glance tells relationship from severity from status from channel.
 * The classes are global (`.qx-chip--hue-<name>` in src/styles/qx-components.css); this file only decides
 * which hue a ContactsQ value gets. Pure, unit tested.
 */
import { FLAG_GROUPS, FLAGS, flagSeverity } from './reasonCodes'

export const HUES = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'slate']

/** Twelve relationships, twelve distinct hues. */
export const RELATIONSHIP_HUE = {
  customer: 'green', prospect: 'cyan', lead: 'sky', supplier: 'orange', partner: 'violet', employee: 'blue',
  contractor: 'teal', investor: 'yellow', press: 'pink', advisor: 'indigo', personal: 'rose', unknown: 'slate',
}
export const relationshipHue = (key) => RELATIONSHIP_HUE[key] || 'slate'

/** Flags by severity: blocks = red, needs a person's approval = amber, labels = blue or purple. */
const FLAG_LABEL_HUE = { vip: 'purple', legal_hold: 'blue' }
export const FLAG_SEVERITY_HUE = { high: 'red', medium: 'amber', info: 'blue' }
export const flagHue = (key) => FLAG_LABEL_HUE[key] || FLAG_SEVERITY_HUE[flagSeverity(key)] || 'blue'

export const STATUS_HUE = { active: 'green', candidate: 'amber', archived: 'slate', erased: 'red', merged: 'violet' }
export const statusHue = (key) => STATUS_HUE[key] || 'slate'

/** Identifier channels and consent channels share one map so a channel keeps its colour everywhere. */
export const CHANNEL_HUE = {
  phone: 'teal', email: 'sky', social: 'violet', url: 'indigo', address: 'orange',
  voice: 'teal', sms: 'cyan', post: 'orange', messaging: 'blue', any: 'slate',
}
export const channelHue = (key) => CHANNEL_HUE[key] || 'slate'

/** className string for a hue chip. `variant`: 'static' (default, label only) or 'toggle'. */
export function chipClass(hue, { size = 'xs', variant = 'static' } = {}) {
  return ['qx-chip', size ? `qx-chip--${size}` : '', `qx-chip--${variant}`, `qx-chip--hue-${HUES.includes(hue) ? hue : 'slate'}`].filter(Boolean).join(' ')
}

/** Flags grouped for the picker: [{ severity, label, flags: [{key,label,help}] }], loudest group first, none empty. */
export function groupFlags() {
  return FLAG_GROUPS.map((g) => ({ ...g, flags: FLAGS.filter((f) => flagSeverity(f.key) === g.severity) })).filter((g) => g.flags.length)
}

/** Stable 0 to 359 hue from an id (FNV-1a), so a person keeps their avatar colour on every device. */
export function avatarHue(id) {
  let h = 2166136261
  const s = String(id || '')
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h % 360
}
