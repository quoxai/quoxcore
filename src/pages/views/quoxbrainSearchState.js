// BRAIN2-W5 140: Qortex marks weak matches `insufficient` (top-level or under
// `relevance`). The dashboard search must honour it: show "No relevant notes",
// not the weak hits as if they were an answer.
export function interpretSearchResponse(data) {
  const insufficient = data?.insufficient === true || data?.relevance?.insufficient === true
  const raw = Array.isArray(data?.results) ? data.results : []
  // BRAIN2-W11 B: 'llm' means the opt-in AI reranker ordered these results.
  return { insufficient, results: insufficient ? [] : raw, reranked: !insufficient && data?.rerank === 'llm' }
}
