/**
 * In-memory note cache + prefetch (speed audit 2026-10-10). A CACHE only: the
 * server stays the source of truth. The editor paints from here instantly and
 * always revalidates against the server; a different content_hash wins.
 * Memory only (never storage), cleared on org change, bounded.
 */
const MAX = 60
const cache = new Map()   // id -> note
const inflight = new Map() // id -> Promise<note>
let org = null

export function setNoteCacheOrg(orgId) {
  if (orgId !== org) { cache.clear(); inflight.clear(); org = orgId }
}

export function getCachedNote(id) { return id ? cache.get(id) || null : null }

export function putNote(note) {
  if (!note?.id) return
  cache.delete(note.id)
  cache.set(note.id, note)
  while (cache.size > MAX) cache.delete(cache.keys().next().value)
}

export function forgetNote(id) { cache.delete(id); inflight.delete(id) }

/** Fetch once, share the promise with anyone asking meanwhile, cache the result. */
export function fetchNote(id, getNote) {
  if (inflight.has(id)) return inflight.get(id)
  const atOrg = org
  const p = Promise.resolve(getNote(id))
    .then((res) => { const n = res?.note; if (n && org === atOrg) putNote(n); return n })
    .finally(() => { inflight.delete(id) })
  inflight.set(id, p)
  return p
}

/** Warm notes not yet cached, a few at a time, never failing loudly. */
export function prefetchNotes(ids, getNote, { limit = 6 } = {}) {
  const todo = (ids || []).filter((id) => id && !cache.has(id) && !inflight.has(id)).slice(0, limit)
  return todo.reduce((chain, id) => chain.then(() => fetchNote(id, getNote).catch(() => null)), Promise.resolve())
}

export function _resetNoteCache() { cache.clear(); inflight.clear(); org = null }
