/**
 * RetrievalDegradedBanner: admin warning when dense (semantic) retrieval failed
 * for recent turns and answers fell back to keyword search only
 * (widget.retrieval_degraded_count = turns in the last hour, from persisted grounding).
 */
function reasonFor(last) {
  const status = Number(last?.status)
  const provider = last?.provider ? String(last.provider) : 'embedding provider'
  if (status === 429) return `the ${provider} embedding provider returned 429 (billing/quota)`
  if (status === 401 || status === 403) return `the ${provider} embedding provider returned ${status} (check the API key)`
  if (Number.isFinite(status) && status > 0) return `the ${provider} embedding provider returned ${status}`
  return `the ${provider} embedding provider could not be reached`
}

export default function RetrievalDegradedBanner({ widget }) {
  const n = Number(widget?.retrieval_degraded_count) || 0
  if (n <= 0) return null
  return (
    <div
      role="alert"
      className="wr-retrieval-degraded"
      style={{ margin: '8px 0', padding: '10px 14px', borderRadius: 8, border: '1px solid #ffb84d', background: 'rgba(255,184,77,0.12)', color: '#ffd08a', fontSize: 13 }}
    >
      Semantic search is unavailable: {reasonFor(widget.retrieval_degraded_last)}. Answers are using keyword search only ({n} {n === 1 ? 'reply' : 'replies'} in the last hour). Check the provider account.
    </div>
  )
}
