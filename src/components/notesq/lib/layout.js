/**
 * NotesQ pane layout. Pure reducer + derivation.
 *
 * State holds only what the USER chose: filters/list are null (no opinion),
 * true (collapsed) or false (open). The effective layout is derived, so an
 * auto-collapse (narrow container + note open) can never override or undo an
 * explicit choice. `focus` hides both panes and is never persisted.
 */
export const INITIAL_LAYOUT = Object.freeze({ filters: null, list: null, focus: false })
// v2: v1 states could persist a dead-end (list collapsed with only an editor-header restore). Dropped on purpose.
const KEY = 'quox.notesq.layout.v2'

export function layoutReducer(state, action) {
  switch (action.type) {
    case 'TOGGLE_FILTERS': return { ...state, filters: !action.current }
    case 'TOGGLE_LIST': return { ...state, list: !action.current }
    case 'TOGGLE_FOCUS': return { ...state, focus: !state.focus }
    case 'ESCAPE': return state.focus ? { ...state, focus: false } : state
    // Closing/deselecting/deleting the note: focus has nothing to show, so it ends.
    case 'NOTE_CLOSED': return state.focus ? { ...state, focus: false } : state
    default: return state
  }
}

/**
 * Derive what is actually rendered. Invariants (tested over the full matrix):
 *  a. no note open: list is never collapsed and focus is off (the list is the only way to pick a note).
 *  b. focus implies a note is open; in focus both panes are hidden and an "Exit focus" control renders.
 *  c. outside focus every collapsed pane renders as a rail (never display:none), see visibleRestoreControls.
 *  d. stacked (container <= 820px) ignores collapse and focus entirely: the stacked list/editor flow applies.
 * `narrow` (container < 1100px) auto-collapses the list only when a note is open and the user has no opinion.
 */
export function effectiveLayout(state, { narrow = false, noteOpen = false, stacked = false } = {}) {
  if (stacked) return { filtersCollapsed: false, listCollapsed: false, focus: false }
  const focus = !!state.focus && noteOpen
  const autoList = narrow && noteOpen
  return {
    filtersCollapsed: focus || (state.filters ?? false),
    listCollapsed: noteOpen && (focus || (state.list ?? autoList)),
    focus,
  }
}

/** Which restore affordances must be on screen for this effective layout. */
export function visibleRestoreControls(effective) {
  if (effective.focus) return ['exit-focus']
  const out = []
  if (effective.filtersCollapsed) out.push('filters-rail')
  if (effective.listCollapsed) out.push('list-rail')
  return out
}

/**
 * `?layout=` deep link, read once on mount and applied as explicit user state for
 * this load only (never persisted). Comma list of COLLAPSED panes: filters, list,
 * focus, plus `agent` (opens the agent dock) and `details` (opens the Details rail of the open note). e.g. `?layout=filters,list`. Panes not named are explicitly open.
 * Returns null when absent/empty/unrecognised. Invariants still apply afterwards
 * (list is ignored with no note open, focus needs a note).
 */
export function parseLayoutParam(value) {
  if (typeof value !== 'string') return null
  const parts = value.split(',').map((x) => x.trim().toLowerCase()).filter((x) => ['filters', 'list', 'focus', 'agent', 'details'].includes(x))
  if (!parts.length) return null
  // `agent` is the one token meaning OPEN (the dock is closed by default); only present when named.
  return { filters: parts.includes('filters'), list: parts.includes('list'), focus: parts.includes('focus'), ...(parts.includes('agent') ? { agent: true } : {}), ...(parts.includes('details') ? { details: true } : {}) }
}

export function loadLayout() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!v || typeof v !== 'object') return INITIAL_LAYOUT
    const t = (x) => (typeof x === 'boolean' ? x : null)
    return { filters: t(v.filters), list: t(v.list), focus: false }
  } catch { return INITIAL_LAYOUT }
}

/** localStorage is a convenience cache only; failures are silent by design. */
export function saveLayout(state) {
  try { localStorage.setItem(KEY, JSON.stringify({ filters: state.filters, list: state.list })) } catch { /* cache only */ }
}

const MODE_KEY = 'quox.notesq.mode.v1'
export const MODES = ['rich', 'markdown', 'read']

/** Last editing mode the user chose. Default is Rich; localStorage is a convenience only. */
export function loadMode() {
  try { const m = localStorage.getItem(MODE_KEY); return MODES.includes(m) ? m : 'rich' } catch { return 'rich' }
}
export function saveMode(m) {
  try { localStorage.setItem(MODE_KEY, m) } catch { /* cache only */ }
}

// Agent dock. Widths mirror notesq.css (filters 220, list 320, rail 48, agent 340, doc min 300, gap 16),
// taking the larger pane widths so the check is conservative.
export const AGENT_W = 340
const DOC_MIN = 300
const GAP = 16
const AGENT_KEY = 'quox.notesq.agent.v1'

/**
 * Where the agent dock renders. Invariants (tested):
 *  a. closed stays closed.
 *  b. stacked (container <= 820px) always uses an overlay panel, never a column.
 *  c. 'docked' only when the editor keeps its DOC_MIN width beside the agent column; otherwise 'overlay'.
 *  d. unknown width (no ResizeObserver) docks, since the CSS grid still holds the editor minimum.
 */
export function agentPlacement({ open, stacked = false, width = null, filtersCollapsed = false, listCollapsed = false, focus = false } = {}) {
  if (!open) return 'closed'
  if (stacked) return 'overlay'
  if (width == null || width <= 0) return 'docked'
  const panes = focus ? 0 : (filtersCollapsed ? 48 : 220) + (listCollapsed ? 48 : 320)
  const cols = focus ? 2 : 4
  const needed = panes + DOC_MIN + AGENT_W + GAP * (cols - 1)
  return needed <= width ? 'docked' : 'overlay'
}

/** Remembered open/closed state for the agent dock; localStorage is a convenience only. */
/** null when the viewer has never chosen, so the view can apply its default (open where it docks). */
export function loadAgentOpen() {
  try {
    const v = localStorage.getItem(AGENT_KEY)
    return v === null ? null : v === '1'
  } catch { return null }
}
export function saveAgentOpen(open) {
  try { localStorage.setItem(AGENT_KEY, open ? '1' : '0') } catch { /* cache only */ }
}
