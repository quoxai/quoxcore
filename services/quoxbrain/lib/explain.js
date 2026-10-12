// explain.js — ONE-BRAIN CX6 ("brain why"): turns values the search pipeline
// already computed into an explanation. Nothing here re-runs retrieval; a
// reason that cannot be determined from pipeline data is reported 'unknown'.

const r6 = (n) => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null)

export function hasActiveFacets(f = {}) {
  return ['vaultIds', 'kinds', 'sources', 'scopes', 'languages'].some((k) => Array.isArray(f[k]) && f[k].length > 0) || Boolean(f.since || f.until)
}

/** Which notes ensureLegHeads pulled into the rerank window. */
export function guaranteedNoteIds(before, after, window) {
  const was = new Set(before.slice(0, window).map((r) => r.noteId))
  return new Set(after.slice(0, window).map((r) => r.noteId).filter((n) => n && !was.has(n)))
}

export function perResultExplain(results, { sink, chunkPool, retrieval, guaranteed, finalRanked, rerank }) {
  const poolAt = new Map((chunkPool || []).map((c, i) => [c.chunkId, i + 1]))
  const finalAt = new Map((finalRanked || []).map((r, i) => [r.noteId, i + 1]))
  return results.map((r) => {
    const c = sink?.chunks?.get(r.chunkId)
    const d = sink?.denseAt?.get(r.chunkId)
    const hybrid = Boolean(c)
    return {
      noteId: r.noteId ?? null,
      chunkId: r.chunkId ?? null,
      sparseRank: sink?.sparseAt ? (sink.sparseAt.get(r.chunkId) ?? null) : (retrieval === 'fts' ? (poolAt.get(r.chunkId) ?? null) : null),
      denseRank: d ? d.rank : null,
      denseCosine: d ? r6(d.cosine) : null,
      fusedScore: hybrid ? r6(c.fusedScore) : null,
      kindPrior: hybrid ? c.kindPrior : 1,
      recency: hybrid ? c.recency : 1,
      leggedHeadGuaranteed: Boolean(guaranteed?.has(r.noteId)),
      rerankPosition: rerank === 'llm' ? (finalAt.get(r.noteId) ?? null) : null,
    }
  })
}

/**
 * Where a requested note fell out (or sat). p = pipeline data:
 *  visible, facetsActive, anyChunkPassesFacets (bool|null), ranked (note-level,
 *  pre-rerank, citable), finalRanked (post-rerank), offset/limit, results,
 *  rerank, retrieval, sink, relevanceInsufficient.
 */
export function explainTarget(noteId, p) {
  const out = (status, reason, detail, extra = {}) => ({ noteId, status, reason, detail, ...(p.relevanceInsufficient ? { relevanceInsufficient: true } : {}), ...extra })
  const hitIdx = p.results.findIndex((r) => r.noteId === noteId)
  if (hitIdx >= 0) return out('in_results', 'in_results', `returned at rank ${p.offset + hitIdx + 1}`, { rank: p.offset + hitIdx + 1 })
  if (!p.visible) return out('not_returned', 'not_visible', 'not visible to the caller (scope), or no such note')
  if (p.facetsActive && p.anyChunkPassesFacets === false) return out('not_returned', 'filtered_by_facets', 'none of its passages match the vault/kind/source/scope/language/date filters')
  const fusedIdx = p.ranked.findIndex((r) => r.noteId === noteId)
  if (fusedIdx < 0) {
    const legs = p.sink?.sparseCandidates !== undefined
      ? `not in the ${p.sink.sparseCandidates} keyword candidates and not in the dense top ${p.sink.denseCandidates}`
      : `not in the keyword candidates${p.retrieval === 'fts' ? ' (vector leg did not run)' : ''}`
    return out('not_returned', 'not_in_candidates', legs)
  }
  const finalIdx = p.finalRanked.findIndex((r) => r.noteId === noteId)
  if (finalIdx < 0) return out('not_returned', 'unknown', 'candidate, but absent from the final list for a reason the pipeline did not record', { fusedRank: fusedIdx + 1 })
  const end = p.offset + p.limit
  if (finalIdx < p.offset) return out('not_returned', 'on_earlier_page', `ranked ${finalIdx + 1}, before offset ${p.offset}`, { rank: finalIdx + 1, fusedRank: fusedIdx + 1 })
  if (finalIdx >= end) {
    if (p.rerank === 'llm' && fusedIdx < end) return out('not_returned', 'dropped_by_reranker', `fused rank ${fusedIdx + 1} was inside the limit; the reranker moved it to ${finalIdx + 1}`, { rank: finalIdx + 1, fusedRank: fusedIdx + 1 })
    return out('not_returned', 'below_limit', `ranked ${finalIdx + 1}, below the limit of ${end}`, { rank: finalIdx + 1, fusedRank: fusedIdx + 1 })
  }
  return out('not_returned', 'unknown', `ranked ${finalIdx + 1}, inside the window, yet not returned`, { rank: finalIdx + 1, fusedRank: fusedIdx + 1 })
}
