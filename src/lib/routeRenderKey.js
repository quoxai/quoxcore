/**
 * The AppShell remounts the routed view when its key changes. A link that
 * changes the query must still remount (many views read the URL once, at
 * mount). But a view that writes its OWN state into the URL (the open note,
 * the list view) must not be torn down by that write: NotesQ and Qortex did
 * a full remount, refetching everything, on every note click (speed audit
 * 2026-10-10). Such writes pass IN_PLACE_NAV_STATE as the navigation state.
 */
export const IN_PLACE_NAV_STATE = Object.freeze({ quoxInPlace: true })

/** prev: the previous result (or null). Returns { key, pathname }. */
export function nextRouteRenderKey(prev, location) {
  const { pathname = '', search = '', hash = '', state } = location || {}
  if (prev && state?.quoxInPlace && prev.pathname === pathname) return prev
  return { key: `${pathname}${search}${hash}`, pathname }
}
