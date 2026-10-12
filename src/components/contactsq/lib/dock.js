/** Where the agent chat dock renders in the address book, and its remembered open state (convenience only; the server holds the data). */
// v2: the owner made OPEN the default (2026-10-10); a choice remembered under the old key does not carry over.
export const DOCK_KEY = 'contactsq.agent.open.v2'
export const DOCK_W = 300
/** Left column (260) + split gap (20) + the list/record column (at least 360) + card padding (40) must fit beside the dock. */
export const LEFT_W = 260
export const DOCK_MIN_MAIN = LEFT_W + 20 + 360 + 40
const GAP = 16

/** 'closed' | 'docked' | 'overlay'. Unknown width (no ResizeObserver) docks; a narrow container floats the dock over the page. */
export function dockPlacement({ open, width = null } = {}) {
  if (!open) return 'closed'
  if (width == null || width <= 0) return 'docked'
  return width >= DOCK_MIN_MAIN + DOCK_W + GAP ? 'docked' : 'overlay'
}

/** Open by default (the agent is part of the address book); a person's choice is remembered. */
export function loadDockOpen(width = null) {
  // Owner 2026-10-10: open by default. Never START as an overlay over the contact detail (it hid the
  // detail at a laptop width), so with no remembered choice it opens wherever it can dock (1280px screens can).
  // Phone width: never start open, whatever was remembered on a desktop (it would cover the search field).
  if ((width != null && width > 0 && width < 900) || (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 900)) return false
  try {
    const v = window.localStorage.getItem(DOCK_KEY)
    if (v !== null) return v === '1'
  } catch { /* fall through */ }
  return width == null || width <= 0 || width >= DOCK_MIN_MAIN + DOCK_W + GAP
}
export function saveDockOpen(open) {
  try { window.localStorage.setItem(DOCK_KEY, open ? '1' : '0') } catch { /* cache only */ }
}
