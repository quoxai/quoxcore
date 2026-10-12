export const TASKS_BASE = '/tasks'

export const TASKS_CONNECTION_ERROR =
  'Cannot connect to the Tasks service. Start the service and verify the /tasks proxy.'

export const TASKS_HTML_RESPONSE_ERROR =
  'Task service returned HTML instead of JSON. The /tasks proxy may be missing or the service may be unavailable.'

export const TASKS_INVALID_JSON_ERROR =
  'Task service returned invalid JSON.'

function looksLikeHtml(text = '', contentType = '') {
  const normalizedType = String(contentType || '').toLowerCase()
  if (normalizedType.includes('text/html')) return true
  return /^\s*<(?:!doctype|html|head|body|script|div)\b/i.test(String(text || ''))
}

async function readBodyText(response) {
  if (typeof response?.text === 'function') {
    return response.text()
  }
  return ''
}

export async function readTaskServiceJson(response, errorMessage = 'Task service request failed', { fallback = null } = {}) {
  if (!response) {
    throw new Error(errorMessage)
  }

  const contentType = response?.headers?.get?.('content-type')
    || response?.headers?.get?.('Content-Type')
    || ''

  if (typeof response?.text !== 'function' && typeof response?.json === 'function') {
    const data = await response.json().catch(() => fallback)
    if (!response.ok) {
      throw new Error(data?.error || data?.message || errorMessage || response.statusText)
    }
    return data ?? fallback
  }

  const text = await readBodyText(response).catch(() => '')

  if (looksLikeHtml(text, contentType)) {
    throw new Error(TASKS_HTML_RESPONSE_ERROR)
  }

  if (!text || text.trim() === '') {
    if (!response.ok) {
      throw new Error(errorMessage || response.statusText)
    }
    return fallback
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(TASKS_INVALID_JSON_ERROR)
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || errorMessage || response.statusText)
  }

  return data
}

export async function requestTaskServiceJson(authFetch, path, options, errorMessage) {
  let response
  try {
    response = await authFetch(`${TASKS_BASE}${path}`, options)
  } catch (error) {
    const message = String(error?.message || error || '')
    if (
      message.includes('Failed to fetch')
      || message.includes('NetworkError')
      || message.includes('Load failed')
    ) {
      throw new Error(TASKS_CONNECTION_ERROR)
    }
    throw error
  }
  return readTaskServiceJson(response, errorMessage)
}
