/** Address book list logic: saved views, counts, filters, and the list <-> record layout state. Pure, unit tested. */
export const RECENT_DAYS = 30
export const DNC_FLAGS = ['do_not_call', 'do_not_sms', 'do_not_email', 'do_not_market', 'human_only', 'deceased']

const isArchived = (c) => c.status === 'archived'
const hasFlag = (c, set) => (c.flags || []).some((f) => set.includes(f))
const touchedMs = (c) => { const t = c.last_touchpoint_at ? new Date(c.last_touchpoint_at).getTime() : NaN; return Number.isNaN(t) ? null : t }

/** Quick filters in the left column. `test` decides membership; `sort` (optional) reorders the view. */
export const SAVED_VIEWS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'vip', label: 'VIPs', test: (c) => (c.flags || []).includes('vip') },
  { key: 'review', label: 'To review', test: (c) => c.status === 'candidate' },
  { key: 'dnc', label: 'Do-not-contact', test: (c) => hasFlag(c, DNC_FLAGS) },
  { key: 'recent', label: 'Recently contacted', test: (c, now) => { const t = touchedMs(c); return t != null && now - t <= RECENT_DAYS * 86400000 }, sort: (a, b) => touchedMs(b) - touchedMs(a) },
]
export const isViewKey = (k) => SAVED_VIEWS.some((v) => v.key === k)

/** Client-side filters for what the list endpoint does not filter. */
export function filterCards(cards, { relationship, flag, status }) {
  return cards.filter((c) => {
    if (status && c.status !== status) return false
    if (!status && isArchived(c)) return false
    if (relationship && c.relationship_primary !== relationship && !(c.relationships || []).includes(relationship)) return false
    if (flag && !(c.flags || []).includes(flag)) return false
    return true
  })
}

/** Cards in a saved view (after the select filters). */
export function applyView(cards, view = 'all', now = Date.now()) {
  const v = SAVED_VIEWS.find((x) => x.key === view) || SAVED_VIEWS[0]
  const out = cards.filter((c) => v.test(c, now))
  return v.sort ? out.sort(v.sort) : out
}

/** { all, vip, review, dnc, recent } counts over the non-archived cards (the number next to each view). */
export function viewCounts(cards, now = Date.now()) {
  const live = cards.filter((c) => !isArchived(c))
  const out = {}
  for (const v of SAVED_VIEWS) out[v.key] = live.filter((c) => v.test(c, now)).length
  return out
}

/** The layout state machine: a selected contact replaces the list with the record. */
export const layoutOf = (selectedId) => (selectedId ? 'record' : 'list')

/** Should Esc leave the record? Not while typing, and not when something else already handled the key. */
export function escLeavesRecord({ key, defaultPrevented = false, targetTag = '', editable = false }) {
  if (key !== 'Escape' || defaultPrevented || editable) return false
  return !['INPUT', 'TEXTAREA', 'SELECT'].includes(String(targetTag).toUpperCase())
}
