/**
 * Camera Bookmarks — Save and recall named camera positions.
 *
 * V2-NAV-4: Camera bookmarks.
 * Ctrl+1-9 saves current position. 1-9 (no modifier) recalls.
 * Stored in localStorage, separate from layout slots.
 *
 * Each bookmark stores: position (camera), target (orbit centre), name.
 */

const STORAGE_KEY = 'cc3d_camera_bookmarks'

// Default bookmarks pre-loaded on first use
const DEFAULT_BOOKMARKS = {
  1: { position: [0, 12, 60],   target: [0, 0, 0],    name: 'Overview' },
  2: { position: [12, -15, 18], target: [0, -10, 0],   name: 'Infra' },
  3: { position: [0, 16, 115],  target: [0, 0, 105],   name: 'Memory' },
  4: { position: [0, 20, 140],  target: [0, 0, 130],   name: 'Shell' },
}

/**
 * Load bookmarks from localStorage. Returns defaults on first use.
 * @returns {Object} — { 1: { position, target, name }, ... }
 */
export function loadBookmarks() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return JSON.parse(stored)
  } catch {}
  // First use — return defaults
  saveBookmarks(DEFAULT_BOOKMARKS)
  return { ...DEFAULT_BOOKMARKS }
}

/**
 * Save bookmarks to localStorage.
 * @param {Object} bookmarks
 */
export function saveBookmarks(bookmarks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks))
  } catch {}
}

/**
 * Save a single bookmark at a slot.
 * @param {number} slot — 1-9
 * @param {number[]} position — camera position [x, y, z]
 * @param {number[]} target — orbit target [x, y, z]
 * @param {string} [name] — auto-generated if not provided
 */
export function saveBookmark(slot, position, target, name) {
  const bookmarks = loadBookmarks()
  const autoName = name || `Pos ${slot} (${position.map(v => Math.round(v)).join(',')})`
  bookmarks[slot] = { position, target, name: autoName, savedAt: Date.now() }
  saveBookmarks(bookmarks)
  return bookmarks[slot]
}

/**
 * Load a single bookmark.
 * @param {number} slot — 1-9
 * @returns {{ position: number[], target: number[], name: string } | null}
 */
export function loadBookmark(slot) {
  const bookmarks = loadBookmarks()
  return bookmarks[slot] || null
}

/**
 * Get all bookmark slots as array for display.
 * @returns {Array<{ slot: number, position: number[], target: number[], name: string } | null>}
 */
export function getAllBookmarks() {
  const bookmarks = loadBookmarks()
  return Array.from({ length: 9 }, (_, i) => {
    const bm = bookmarks[i + 1]
    return bm ? { slot: i + 1, ...bm } : null
  })
}

export { DEFAULT_BOOKMARKS }
