/**
 * Logs Tab Utilities (CW-8.7)
 */

export function formatConversation(conv) {
  const rating = conv.visitor_rating === 1 ? '👍' : conv.visitor_rating === 0 ? '👎' : '—'
  // "date" is the LAST ACTIVITY time (what a "recent chats" list should show) —
  // falling back to start time. Previously showed started_at, so a conversation
  // that a visitor continued or resumed kept its old timestamp and never looked
  // recent. `startedAt` is kept separately for the conversation detail view.
  const activityTs = conv.last_message_at || conv.started_at
  return {
    id: conv.id,
    visitorId: conv.visitor_id || 'anon',
    status: conv.status || 'active',
    messageCount: conv.message_count || 0,
    date: activityTs ? new Date(activityTs).toLocaleString() : '—',
    startedAt: conv.started_at ? new Date(conv.started_at).toLocaleString() : null,
    resolvedAt: conv.resolved_at ? new Date(conv.resolved_at).toLocaleString() : null,
    rating,
  }
}

export function formatMessage(msg) {
  let sources = []
  try { sources = msg.sources_json ? JSON.parse(msg.sources_json) : [] } catch {}

  return {
    id: msg.id,
    role: msg.role,
    content: msg.content || '',
    sources,
    confidence: msg.confidence ?? null,
    injectionScore: msg.injection_score || 0,
    timestamp: msg.created_at ? new Date(msg.created_at).toLocaleTimeString() : '',
  }
}

function escapeCSV(str) {
  if (!str) return ''
  const s = String(str)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function exportToCSV(messages) {
  // sender_name column added (night audit B1): operator replies carry the
  // human's name and the export silently dropped it. CRLF row endings per
  // RFC 4180, matching the server-side conversations.csv export.
  const header = 'role,sender_name,content,timestamp'
  const rows = messages.map(m =>
    `${escapeCSV(m.role)},${escapeCSV(m.sender_name || '')},${escapeCSV(m.content)},${escapeCSV(m.created_at || '')}`
  )
  return [header, ...rows].join('\r\n')
}
