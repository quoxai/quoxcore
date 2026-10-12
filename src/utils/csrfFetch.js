/**
 * CSRF-aware fetch wrapper
 *
 * Drop-in replacement for fetch() that automatically:
 * 1. Reads the csrf_token cookie
 * 2. Adds X-CSRF-Token header to state-changing requests (POST/PUT/PATCH/DELETE)
 * 3. Sets credentials: 'include' so auth cookies are sent
 * 4. Auto-retries once on CSRF failure after refreshing the token
 *
 * Usage:
 *   import { csrfFetch } from '../utils/csrfFetch'
 *   const res = await csrfFetch('/api/some-endpoint', { method: 'POST', body: ... })
 */

export function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
  return match ? match[1] : null
}

const STATE_CHANGING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

/**
 * Refresh the CSRF cookie by making a lightweight GET to the auth service.
 * The CSRF middleware auto-sets the cookie on any request.
 */
async function refreshCsrfCookie() {
  try {
    await fetch('/api/auth/me', { credentials: 'include' })
  } catch {
    // Best effort — the main request will fail with a clear error if this doesn't work
  }
}

export async function csrfFetch(url, options = {}, _retried = false) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = { ...options.headers }

  if (STATE_CHANGING_METHODS.includes(method)) {
    let token = getCsrfToken()

    // If no CSRF cookie exists, try to get one before the request
    if (!token && !_retried) {
      await refreshCsrfCookie()
      token = getCsrfToken()
    }

    if (token) {
      headers['X-CSRF-Token'] = token
    }
  }

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers
  })

  // Auto-retry once on CSRF validation failure
  if (!_retried && response.status === 403) {
    const body = await response.clone().json().catch(() => null)
    if (body?.error === 'csrf_validation_failed') {
      await refreshCsrfCookie()
      return csrfFetch(url, options, true)
    }
  }

  return response
}

export default csrfFetch
