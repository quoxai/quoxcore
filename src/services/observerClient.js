/**
 * observerClient — Frontend API client for terminal observer features.
 *
 * Creates observer URLs (via REST) and builds WebSocket URLs for connecting
 * to read-only terminal observer streams.
 */

const COLLECTOR_BASE = '/collector';

/**
 * Create an observer URL for a session (owner only).
 * POST /terminal/shell/sessions/:sessionId/observe
 * @param {string} sessionId — The shell session ID to share
 * @returns {Promise<{observeUrl: string, sessionId: string, observerCount: number, maxObservers: number}>}
 */
export async function createObserveUrl(sessionId) {
  const res = await fetch(`${COLLECTOR_BASE}/terminal/shell/sessions/${encodeURIComponent(sessionId)}/observe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'request_failed' }));
    throw new Error(err.message || err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Build a WebSocket URL for the observer endpoint.
 * @param {string} sessionId — The shell session to observe
 * @returns {string} Full WebSocket URL
 */
export function buildObserverWsUrl(sessionId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${COLLECTOR_BASE}/terminal/shell/observe?session=${encodeURIComponent(sessionId)}`;
}
