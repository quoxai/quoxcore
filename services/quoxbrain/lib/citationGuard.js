// citationGuard.js — P1b citation-integrity invariant
// (docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §3: "no uncited text, ever").
//
// Every chunk-shaped row leaving the brain via POST /brain/search or
// POST /brain/context comes from a real note_chunks row (joined to notes),
// so it always carries a resolvable {noteId, chunkId} pair by construction —
// this is a cheap belt-and-braces invariant, not a real defensive path. It
// also gives the P1d eval harness's citation-integrity check (§3, §5) a
// concrete foothold: any row that somehow lost its identifiers is logged
// and dropped rather than emitted as uncited text.

/**
 * Filters a list of chunk-shaped rows (search results or context
 * candidates), dropping — and logging — any row missing a resolvable
 * `chunkId`/`noteId` pair.
 *
 * @param {Array<{chunkId?:string, noteId?:string}>} rows
 * @param {{context?:string}} [opts] - label used in the dropped-row log line
 * @returns {Array} the subset of rows with both ids present
 */
export function filterCitable(rows, { context = 'unknown' } = {}) {
  if (!Array.isArray(rows)) return []
  return rows.filter((row) => {
    if (row && row.chunkId && row.noteId) return true
    console.error(`[Brain] citation-guard: dropping uncited row in ${context} (chunkId=${row?.chunkId}, noteId=${row?.noteId})`)
    return false
  })
}

export default { filterCitable }
