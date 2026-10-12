/**
 * Widget Communication Utilities (CW-8.1)
 *
 * Handles the widget's communication with the collector backend.
 * Used by QuoxChatWidget.jsx for real LLM-powered conversations.
 */

/**
 * Generate a unique visitor ID.
 * Persisted in sessionStorage so it survives page navigation.
 */
export function generateVisitorId() {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Get or create a visitor ID from sessionStorage.
 */
export function getOrCreateVisitorId(widgetId) {
  const key = `quoxchat_visitor_${widgetId || 'default'}`
  if (typeof sessionStorage !== 'undefined') {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const id = generateVisitorId()
    sessionStorage.setItem(key, id)
    return id
  }
  return generateVisitorId()
}

/**
 * Build the message payload for POST /collector/quoxchat/message
 */
export function buildMessagePayload({ message, widgetId, visitorId, conversationHistory = [], pageUrl, pageContext }) {
  return {
    message,
    widget_id: widgetId || 'demo',
    visitor_id: visitorId || 'anon',
    conversation_history: conversationHistory.slice(-10),
    page_url: pageUrl || (typeof window !== 'undefined' ? window.location.pathname : ''),
    page_context: pageContext || null,
  }
}

/**
 * Parse the collector's message response into a format the widget UI can render.
 */
export function parseMessageResponse(data) {
  if (!data || (!data.success && !data.response)) {
    return { text: 'No response received.', sources: [], meta: {}, error: true }
  }

  return {
    text: data.response || 'No response received.',
    sources: data.sources || [],
    meta: {
      model: data.model || '',
      tokens: data.tokens ? `${data.tokens.input}+${data.tokens.output}` : '',
      latency: data.duration_ms ? `${data.duration_ms}ms` : '',
      injectionScore: data.injection_score || 0,
    },
    error: data.success === false,
  }
}

/**
 * Send a message to the collector and parse the response.
 *
 * @param {string} endpoint — base URL (e.g., 'https://core.acme.com')
 * @param {object} payload — from buildMessagePayload()
 * @returns {Promise<{text, sources, meta, error}>}
 */
export async function sendMessage(endpoint, payload) {
  const url = `${(endpoint || '').replace(/\/+$/, '')}/collector/quoxchat/message`

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    })

    if (!resp.ok) {
      return { text: 'Connection error. Please try again.', sources: [], meta: {}, error: true }
    }

    const data = await resp.json()
    return parseMessageResponse(data)
  } catch (err) {
    return {
      text: err.name === 'TimeoutError'
        ? 'Response took too long. Please try again.'
        : `Connection error: ${err.message}`,
      sources: [],
      meta: {},
      error: true,
    }
  }
}

/**
 * Simple markdown-to-HTML converter for chat responses.
 * Handles: bold, italic, code, code blocks, lists, links, line breaks.
 */
export function renderMarkdown(text) {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/```([\s\S]*?)```/g, '<pre style="background:rgba(0,0,0,0.06);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;margin:6px 0;white-space:pre-wrap;">$1</pre>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^\*\s+(.+)$/gm, '<li style="margin-left:16px;">$1</li>')
    .replace(/\n/g, '<br>')
}
