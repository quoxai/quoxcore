import { IN_PLACE_NAV_STATE } from '../../lib/routeRenderKey'
// Deep-link helpers for /brain2?note=<noteId> ("Open in Brain" from NotesQ etc).
const MAX_ID_LEN = 512

/** Read a valid note id from a URLSearchParams / query string, else null. */
export function readNoteParam(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search || '')
  const raw = params.get('note')
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  if (!id || id.length > MAX_ID_LEN || /[\u0000-\u001f]/.test(id)) return null
  return id
}

/**
 * Return a new URLSearchParams with `note` set (or removed when id is falsy),
 * other params preserved. Returns null when nothing would change.
 */
export function syncNoteParam(search, noteId) {
  const params = new URLSearchParams(search instanceof URLSearchParams ? search.toString() : (search || ''))
  const current = params.get('note')
  if (noteId) {
    if (current === noteId) return null
    params.set('note', noteId)
  } else {
    if (current === null) return null
    params.delete('note')
  }
  return params
}

/** Options for react-router setSearchParams: always replace so Back is not spammed, and in place so the shell does not remount the view. */
export const NOTE_SYNC_OPTIONS = Object.freeze({ replace: true, state: IN_PLACE_NAV_STATE })
