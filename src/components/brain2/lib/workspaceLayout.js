/**
 * Qortex workspace pane layout. Pure reducer + derivation (the NotesQ pattern,
 * see components/notesq/lib/layout.js).
 *
 * State holds only what the USER chose: library/dock are null (no opinion),
 * true (collapsed) or false (open). The effective layout is derived, so an
 * auto-collapse (narrow container, empty dock) can never override or undo an
 * explicit choice. `focus` hides both side panes (the graph takes the whole
 * workspace); `wide` is its mirror for reading and chat: the dock fills the
 * workspace beside a compact graph and the library folds. Neither is persisted,
 * and they are mutually exclusive.
 */
export const INITIAL_LAYOUT = Object.freeze({ library: null, dock: null, focus: false, wide: false })

// Container widths (the workspace, not the viewport: the nav rail and a docked
// chat narrow us too). Mirrors brain-workspace.css data-attribute rules.
export const NARROW_PX = 1100  // an empty dock auto-collapses below this
export const STACKED_PX = 760  // dock drops below the stage at or below this
export const DRAWER_PX = 680   // library becomes an off-canvas drawer at or below this

export function layoutReducer(state, action) {
  switch (action.type) {
    // Opening the library from wide ends wide (wide keeps the library folded).
    case 'TOGGLE_LIBRARY': return { ...state, library: !action.current, wide: action.current ? false : state.wide }
    // Hiding the dock ends wide: there is nothing left to be wide.
    case 'TOGGLE_DOCK': return { ...state, dock: !action.current, wide: action.current ? state.wide : false }
    case 'TOGGLE_FOCUS': return { ...state, focus: !state.focus, wide: false }
    case 'TOGGLE_WIDE': return state.wide ? { ...state, wide: false } : { ...state, wide: true, focus: false, dock: false }
    case 'ESCAPE': return state.focus ? { ...state, focus: false } : state.wide ? { ...state, wide: false } : state
    // The user asked for the dock itself (a citation, "Ask about this note",
    // a dock tab): a collapsed dock opens and focus ends.
    case 'REVEAL_DOCK': return { ...state, dock: false, focus: false }
    // A node was picked. Outside focus an explicitly hidden dock opens (picking a
    // note must never visibly do nothing); an auto-collapsed one opens by itself
    // because it now has content. In focus the graph's own note popup shows it.
    case 'NOTE_SELECTED': return !state.focus && state.dock === true ? { ...state, dock: false } : state
    // Late-arriving durable prefs apply only where the user has no opinion yet.
    case 'HYDRATE': return {
      ...state,
      library: state.library ?? (typeof action.library === 'boolean' ? action.library : null),
      dock: state.dock ?? (typeof action.dock === 'boolean' ? action.dock : null),
      wide: !!state.wide,
    }
    default: return state
  }
}

/**
 * Derive what is actually rendered. Invariants (tested over the full matrix):
 *  a. focus hides both side panes and an "Exit focus" control renders.
 *  b. outside focus every collapsed pane renders as a labelled rail (never display:none).
 *  c. drawer (container <= DRAWER_PX) ignores library collapse: the library is a drawer.
 *  d. an explicit choice always wins. With no opinion, on a narrow container:
 *     the dock collapses when it has nothing to show (no note, Note tab), and the
 *     library collapses when the dock is open (the NotesQ list rule: the graph
 *     keeps its room when a note is being read).
 *  e. wide implies the dock is open and the library is folded (or a drawer).
 */
export function effectiveLayout(state, { narrow = false, stacked = false, drawer = false, dockHasContent = false } = {}) {
  const focus = !!state.focus
  const wide = !!state.wide && !focus
  const dockCollapsed = !wide && (focus || (state.dock ?? (narrow && !dockHasContent)))
  const libraryCollapsed = !drawer && (focus || wide || (state.library ?? (narrow && !dockCollapsed)))
  return {
    wide,
    libraryCollapsed,
    libraryHidden: focus,
    dockCollapsed,
    dockHidden: focus,
    focus,
    stacked,
    drawer,
  }
}

// Pane widths, mirroring brain-workspace.css (library 240, rail 48, gap 16).
const LIBRARY_W = 240
const RAIL_W = 48
const GAP = 16
export const STAGE_MIN = 360
export const STAGE_COMPACT = 300 // the graph beside a wide dock
export const DOCK_MIN = 320

/**
 * Whether an OPEN dock sits beside the stage or drops below it. Side only when
 * the stage keeps STAGE_MIN beside the library slot and the dock; at or below
 * STACKED_PX it always stacks. Unknown width (0) sits beside, as before.
 */
export function dockPlacement({ width = 0, libraryCollapsed = false, drawer = false, focus = false, wide = false, dockWidth = 440 } = {}) {
  if (!width) return 'side'
  if (width <= STACKED_PX) return 'stacked'
  const lib = focus || drawer ? 0 : (libraryCollapsed ? RAIL_W : LIBRARY_W) + GAP
  if (wide) return lib + STAGE_COMPACT + GAP + DOCK_MIN <= width ? 'side' : 'stacked'
  return lib + STAGE_MIN + GAP + dockWidth <= width ? 'side' : 'stacked'
}

/**
 * Widest the user may drag the dock: whatever leaves the graph STAGE_MIN beside
 * the library slot (was a fixed 720px, too small for long notes and chat).
 * Unknown width falls back to 720.
 */
export function dockMaxWidth({ width = 0, libraryCollapsed = false, drawer = false } = {}) {
  if (!width) return 720
  const lib = drawer ? 0 : (libraryCollapsed ? RAIL_W : LIBRARY_W) + GAP
  return Math.max(DOCK_MIN, width - lib - STAGE_MIN - GAP)
}

/** Which restore affordances must be on screen for this effective layout. */
export function visibleRestoreControls(effective) {
  if (effective.focus) return ['exit-focus']
  const out = effective.wide ? ['exit-wide'] : []
  if (effective.drawer) out.push('library-drawer-trigger')
  else if (effective.libraryCollapsed) out.push('library-rail')
  if (effective.dockCollapsed) out.push('dock-rail')
  return out
}

/**
 * `?layout=` deep link, read once on mount and applied as explicit user state
 * for this load only (never persisted). Comma list of COLLAPSED panes:
 * library, dock, focus; plus `cortex` (opens the dock on the Cortex tab) and
 * `wide` (the dock fills the workspace). e.g. `?layout=library` or `?layout=cortex,wide`. Panes not named are explicitly open.
 * Returns null when absent/empty/unrecognised.
 */
export function parseLayoutParam(value) {
  if (typeof value !== 'string') return null
  const parts = value.split(',').map((x) => x.trim().toLowerCase()).filter((x) => ['library', 'dock', 'focus', 'cortex', 'wide'].includes(x))
  if (!parts.length) return null
  const wide = parts.includes('wide') && !parts.includes('focus')
  return {
    library: parts.includes('library'),
    dock: parts.includes('dock') && !parts.includes('cortex') && !wide,
    focus: parts.includes('focus'),
    wide,
    ...(parts.includes('cortex') ? { cortex: true } : {}),
  }
}

// Layout prefs format. v1 blobs (no layoutV) stored railCollapsed:false as a
// DEFAULT on every save, so false there means "never touched", not "keep open".
export const LAYOUT_PREFS_VERSION = 2

/** Fields written to the durable brain_workspace identity blob. Focus is never stored. */
export function persistable(state) {
  return { layoutV: LAYOUT_PREFS_VERSION, railCollapsed: state.library, dockCollapsed: state.dock }
}

/** Read a stored blob into HYDRATE fields. A v1 blob keeps only a real collapse (true). */
export function hydrateFromPrefs(blob) {
  if (!blob || typeof blob !== 'object') return { library: null, dock: null }
  if (blob.layoutV === LAYOUT_PREFS_VERSION) return { library: blob.railCollapsed, dock: blob.dockCollapsed }
  return { library: blob.railCollapsed === true ? true : null, dock: null }
}
