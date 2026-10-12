/**
 * Pure logic for the NotesQ property projections (table, cards, timeline).
 * A projection is a display of the notes already loaded for the list; nothing here fetches.
 */

export const VIEWS = ['list', 'table', 'cards', 'timeline']
export const BASE_COLUMNS = ['title', 'collection', 'type', 'status', 'tags', 'updated']
export const COLUMN_LABELS = { title: 'Title', collection: 'Collection', type: 'Type', status: 'Status', tags: 'Tags', updated: 'Updated' }
export const GROUP_KEYS = ['none', 'collection', 'type', 'status']
// Properties that are already a base column or are list-pane flags, so never offered as extra columns.
const RESERVED_PROPS = new Set(['collection', 'type', 'status', 'tags', 'pinned', 'archived', 'title'])

const VIEW_KEY = 'quox.notesq.view.v1'

export function parseViewParam(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VIEWS.includes(v) ? v : null
}

/** Per-viewer display preference; localStorage is a convenience only. */
export function loadView() {
  try { return parseViewParam(localStorage.getItem(VIEW_KEY)) || 'list' } catch { return 'list' }
}
export function saveView(view) {
  try { localStorage.setItem(VIEW_KEY, view) } catch { /* cache only */ }
}

/** Return URLSearchParams with `view` set (omitted for the default list view). Other params are kept. */
export function serializeViewParam(searchParams, view) {
  const next = new URLSearchParams(searchParams)
  if (!view || view === 'list') next.delete('view')
  else next.set('view', view)
  return next
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isScalar = (v) => ['string', 'number', 'boolean'].includes(typeof v)

/** Property keys found across notes (excluding base columns), scalar or array-of-scalar values only, sorted. */
export function discoverColumns(notes) {
  const seen = new Set()
  for (const n of notes || []) {
    const props = n?.properties
    if (!isPlainObject(props)) continue
    for (const [k, v] of Object.entries(props)) {
      if (RESERVED_PROPS.has(k.toLowerCase())) continue
      if (v === null || v === undefined || v === '') continue
      seen.add(k)
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** Display text for a property value: scalars as text, arrays joined with commas, objects as "...". */
export function formatValue(v) {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map((x) => (isScalar(x) ? String(x) : isPlainObject(x) || Array.isArray(x) ? '...' : '')).filter(Boolean).join(', ')
  if (isPlainObject(v)) return '...'
  return String(v)
}

/** Raw value for a column key on a note (base columns map onto note fields, others onto properties). */
export function cellValue(note, key) {
  const props = note?.properties || {}
  switch (key) {
    case 'title': return note?.title || 'Untitled'
    case 'tags': return Array.isArray(note?.tags) ? note.tags : (Array.isArray(props.tags) ? props.tags : [])
    case 'updated': return note?.updated_at ?? ''
    default: return props[key]
  }
}

export function cellText(note, key) { return formatValue(cellValue(note, key)) }

function sortKey(note, key) {
  const raw = cellValue(note, key)
  if (key === 'updated') { const t = Date.parse(raw); return Number.isFinite(t) ? t : null }
  if (typeof raw === 'number') return raw
  const text = formatValue(raw).trim()
  if (!text) return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text.toLowerCase()
}

/** Stable sort by a column. Empty values always sort last, in both directions. dir: 'asc' | 'desc'. */
export function sortNotes(notes, key, dir = 'asc') {
  if (!key) return [...notes]
  const sign = dir === 'desc' ? -1 : 1
  return notes
    .map((n, i) => ({ n, i, k: sortKey(n, key) }))
    .sort((a, b) => {
      if (a.k === null && b.k === null) return a.i - b.i
      if (a.k === null) return 1
      if (b.k === null) return -1
      let c
      if (typeof a.k === 'number' && typeof b.k === 'number') c = a.k - b.k
      else c = String(a.k).localeCompare(String(b.k), undefined, { numeric: true })
      return c !== 0 ? c * sign : a.i - b.i
    })
    .map((x) => x.n)
}

/** Next sort state when a header is clicked: new column starts asc, same column toggles. */
export function nextSort(current, key) {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: 'asc' }
}

/** Group notes by collection/type/status. Returns [{key,label,notes}], named groups A-Z, empty group last. */
export function groupNotes(notes, by) {
  if (!by || by === 'none') return [{ key: '', label: '', notes: [...notes] }]
  const map = new Map()
  for (const n of notes) {
    const label = cellText(n, by).trim()
    if (!map.has(label)) map.set(label, [])
    map.get(label).push(n)
  }
  const groups = [...map.entries()].map(([label, list]) => ({ key: label || '__none', label: label || `No ${by}`, notes: list, empty: !label }))
  groups.sort((a, b) => (a.empty - b.empty) || a.label.localeCompare(b.label))
  return groups.map(({ empty, ...g }) => g)
}

function parseIso(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return null
  const t = Date.parse(v.trim())
  return Number.isFinite(t) ? t : null
}

/** Property keys where at least one note has an ISO-date string value (candidates for the Date select). */
export function discoverDateKeys(notes) {
  const out = new Set()
  for (const n of notes || []) {
    const props = n?.properties
    if (!isPlainObject(props)) continue
    for (const [k, v] of Object.entries(props)) if (parseIso(v) !== null) out.add(k)
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

const pad = (n) => String(n).padStart(2, '0')
/** Local calendar day key (YYYY-MM-DD) for a timestamp. */
export function dayKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Date-only ISO strings are calendar days, not instants: keep them on their own day in any timezone. */
function dayKeyFor(raw) {
  const s = String(raw).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return dayKey(Date.parse(s))
}

export function dayLabel(key, now = Date.now()) {
  const today = dayKey(now)
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (key === today) return 'Today'
  if (key === dayKey(y.getTime())) return 'Yesterday'
  return key
}

/**
 * Bucket notes by day of the chosen date source ('updated' or a property key), newest day first.
 * Notes inside a day keep newest-first order. Notes lacking a parseable date go to a trailing `undated` bucket.
 * Returns { days: [{key,label,notes}], undated: [] }.
 */
export function bucketTimeline(notes, source = 'updated', now = Date.now()) {
  const dated = []
  const undated = []
  notes.forEach((n, i) => {
    const raw = source === 'updated' ? n?.updated_at : n?.properties?.[source]
    const t = source === 'updated' ? (Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null) : parseIso(raw)
    if (t === null || raw === undefined || raw === null) undated.push(n)
    else dated.push({ n, i, t, key: dayKeyFor(raw) })
  })
  dated.sort((a, b) => (b.t - a.t) || (a.i - b.i))
  const days = []
  for (const d of dated) {
    let last = days[days.length - 1]
    if (!last || last.key !== d.key) { last = { key: d.key, label: dayLabel(d.key, now), notes: [] }; days.push(last) }
    last.notes.push(d.n)
  }
  days.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  return { days, undated }
}
