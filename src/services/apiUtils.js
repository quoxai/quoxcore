/**
 * API Utilities - Safe response parsing with Content-Type validation
 */

/**
 * Safely parse API response as JSON with Content-Type validation
 * Handles cases where APIs return HTML error pages instead of JSON
 *
 * @param {Response} response - Fetch Response object
 * @param {Object} options - Options
 * @param {*} options.fallback - Value to return on parse failure (default: null)
 * @returns {Promise<*>} Parsed JSON or fallback value
 */
export async function safeJsonParse(response, options = {}) {
  const { fallback = null } = options

  const contentType = response.headers.get('Content-Type') || ''

  // Reject HTML responses (error pages from nginx/proxy)
  if (contentType.includes('text/html')) {
    console.warn('[API] Received HTML response instead of JSON')
    return fallback
  }

  try {
    const text = await response.text()
    if (!text || text.trim() === '') return fallback
    return JSON.parse(text)
  } catch (err) {
    console.warn('[API] JSON parse failed:', err.message)
    return fallback
  }
}
