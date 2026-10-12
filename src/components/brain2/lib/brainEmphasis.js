// Search-visual coupling (BRAIN2-PRODUCT P1e) and ego-focus neighbor logic,
// extracted verbatim (as pure functions) from QuoxbrainView.jsx's useMemo
// bodies (Phase 0 refactor, behavior-preserving). See the component for the
// TDZ declaration-order note these two hooks must respect — this module only
// carries the pure computation, not the memoization or ordering.

// Set of matched note ids (String) from search results, or null when none.
export function computeSearchMatchIds(searchResults) {
  if (!searchResults || searchResults.length === 0) return null
  const set = new Set()
  for (const r of searchResults) if (r.noteId != null) set.add(String(r.noteId))
  return set.size > 0 ? set : null
}

// Neighbor set of the focused node (focusId included), or null when no focus.
// linkEndId is the same helper QuoxbrainView uses to normalize a link endpoint to an id.
export function computeNeighborIds(focusId, links, linkEndId) {
  if (!focusId) return null
  const set = new Set([focusId])
  for (const l of links) {
    const s = linkEndId(l.source)
    const t = linkEndId(l.target)
    if (s === focusId) set.add(t)
    if (t === focusId) set.add(s)
  }
  return set
}
