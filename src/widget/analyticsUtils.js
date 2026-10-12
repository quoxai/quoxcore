/**
 * Analytics Utilities (CW-8.8)
 */

export function computeStats(conversations = []) {
  if (conversations.length === 0) {
    return { totalConversations: 0, totalMessages: 0, resolvedCount: 0, abandonedCount: 0, handedOffCount: 0, closedCount: 0, activeCount: 0, satisfactionRatio: 0, avgMessages: 0 }
  }

  const total = conversations.length
  const totalMessages = conversations.reduce((s, c) => s + (c.message_count || 0), 0)
  const resolved = conversations.filter(c => c.status === 'resolved').length
  const abandoned = conversations.filter(c => c.status === 'abandoned').length
  // Statuses the product actually sets: active, handed_off, closed.
  const handedOff = conversations.filter(c => c.status === 'handed_off').length
  const closed = conversations.filter(c => c.status === 'closed').length
  const active = conversations.filter(c => c.status === 'active').length

  const rated = conversations.filter(c => c.visitor_rating !== undefined && c.visitor_rating !== null)
  const thumbsUp = rated.filter(c => c.visitor_rating === 1).length
  const satisfactionRatio = rated.length > 0 ? thumbsUp / rated.length : 0

  return {
    totalConversations: total,
    totalMessages,
    resolvedCount: resolved,
    abandonedCount: abandoned,
    handedOffCount: handedOff,
    closedCount: closed,
    activeCount: active,
    satisfactionRatio: Math.round(satisfactionRatio * 100) / 100,
    avgMessages: Math.round(totalMessages / total),
  }
}

export function computeCoverageScore({ totalChunks = 0, totalSources = 0, hasQA = false }) {
  if (totalChunks === 0 && totalSources === 0) return 0

  let score = 0
  score += Math.min(40, totalChunks * 0.2) // up to 40 from chunks (200 chunks = max)
  score += Math.min(20, totalSources * 4)   // up to 20 from sources (5 sources = max)
  if (hasQA) score += 20                     // 20 bonus for FAQ pairs
  score += Math.min(20, totalChunks > 50 ? 20 : totalChunks > 20 ? 10 : 0) // depth bonus

  return Math.min(100, Math.round(score))
}
