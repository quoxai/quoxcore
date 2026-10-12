/** Last note the user saved or created, per org, in this browser (convenience only; the server owns the data). */
const key = (orgId) => `quox.notesq.lastNote.v1:${orgId || 'none'}`

export function loadLastNote(orgId) {
  try { const v = localStorage.getItem(key(orgId)); return v && v.length < 200 ? v : null } catch { return null }
}
export function saveLastNote(orgId, id) {
  if (!id) return
  try { localStorage.setItem(key(orgId), String(id)) } catch { /* cache only */ }
}
export function clearLastNote(orgId) {
  try { localStorage.removeItem(key(orgId)) } catch { /* cache only */ }
}

/**
 * Resolve the note to open when none was requested. An explicit id always wins; otherwise the stored id
 * if it still resolves. Any failure (404, network) returns null so the caller shows today's empty state.
 */
export async function resolveInitialNote({ orgId, explicit, getNote }) {
  if (explicit) return explicit
  const id = loadLastNote(orgId)
  if (!id) return null
  try {
    const res = await getNote(id)
    if (res?.note?.id) return id
  } catch { /* stale or gone */ }
  clearLastNote(orgId)
  return null
}
