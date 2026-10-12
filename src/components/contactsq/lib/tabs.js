/** ContactsQ tab keys and the deep-link/remembered-tab rules. Pure, unit tested. */
export const TAB_KEYS = ['book', 'history', 'compliance', 'dnc', 'grants', 'settings']
/** Old keys that may still be in a bookmark or localStorage. */
const ALIASES = { people: 'book', suppressions: 'dnc' }

/** A tab key (new or old) to the current key, or null when it is not a tab. */
export function normaliseTab(value) {
  if (typeof value !== 'string') return null
  const key = ALIASES[value] || value
  return TAB_KEYS.includes(key) ? key : null
}

/**
 * Which tab opens first: an explicit ?tab= wins; a ?contact= link means the address book (whatever was
 * remembered); then the remembered tab; then the address book.
 */
export function initialTab({ search = '', stored = null } = {}) {
  let params
  try { params = new URLSearchParams(search) } catch { params = new URLSearchParams() }
  return normaliseTab(params.get('tab')) || (params.get('contact') ? 'book' : null) || normaliseTab(stored) || 'book'
}
