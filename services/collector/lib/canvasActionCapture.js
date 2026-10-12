/**
 * Per-session capture for canvas actions emitted via wb_emit tool.
 * Actions are pulled by the chat dispatcher when assembling the response,
 * then attached as `canvas_actions` so the frontend can apply them directly
 * (bypassing markdown-fence parsing).
 *
 * Capture lives in-memory per collector process. Sessions clean up
 * automatically after pull. Stale entries TTL out after 5 minutes.
 *
 * SESSION ID PROBLEM (P10.7.1 fix):
 *   wb_emit is invoked via /api/v1/tools/execute by quoxmcp. quoxmcp passes
 *   ITS session_id (the MCP bridge session), which doesn't match the chat
 *   dispatcher's session_id (the user's chat session). Result: capture
 *   writes under one key, pull reads from another, actions stranded.
 *
 *   Fix: chat dispatcher calls setActiveChatSession(chatSessionId) before
 *   spawning the CLI, clears it after. wb_emit's execute falls back to the
 *   active session when ctx.session_id doesn't yield a hit. Both ends now
 *   converge on the chat session key.
 *
 *   Concurrency note: single _activeChatSessionId per collector process. If
 *   two CLI dispatches overlap in flight, last-set wins. Acceptable for the
 *   current single-tenant per-collector scale; revisit with AsyncLocalStorage
 *   if/when multi-tenant load becomes a concern.
 */

const _captures = new Map()
const TTL_MS = 5 * 60 * 1000

let _activeChatSessionId = null

function setActiveChatSession(id) {
  _activeChatSessionId = id || null
}

function clearActiveChatSession() {
  _activeChatSessionId = null
}

function getActiveChatSession() {
  return _activeChatSessionId
}

function captureCanvasActions(sessionId, actions) {
  if (!Array.isArray(actions)) return
  // The chat dispatcher's active session ALWAYS wins when one is set —
  // quoxmcp passes its own bridge session_id which doesn't match the chat
  // session, so honoring caller-passed sessionId would strand the actions.
  // Only fall back to the caller's sessionId when no chat is active (e.g.
  // out-of-band tool calls).
  const key = _activeChatSessionId || sessionId || 'default'
  const existing = _captures.get(key) || { actions: [], capturedAt: Date.now() }
  existing.actions.push(...actions)
  existing.capturedAt = Date.now()
  _captures.set(key, existing)
  // Diagnostic — always log so future drift is visible without code-spelunking.
  console.log(`[canvasActionCapture] captured ${actions.length} actions under key=${key} (caller-passed=${sessionId || 'none'}, active=${_activeChatSessionId || 'none'}, total-keys=${_captures.size})`)
}

function pullCanvasActions(sessionId) {
  if (!sessionId) {
    // No session given — pull from the active chat session if one is set.
    sessionId = _activeChatSessionId || 'default'
  }
  // Try the requested key first
  let entry = _captures.get(sessionId)
  // Fall back to the active chat session, then 'default', so capture/pull
  // mismatches don't strand the actions
  if (!entry && _activeChatSessionId && _activeChatSessionId !== sessionId) {
    entry = _captures.get(_activeChatSessionId)
    if (entry) {
      console.log(`[canvasActionCapture] pull(${sessionId}) miss; recovered from active=${_activeChatSessionId}`)
      _captures.delete(_activeChatSessionId)
      return entry.actions
    }
  }
  if (!entry) {
    entry = _captures.get('default')
    if (entry) {
      console.log(`[canvasActionCapture] pull(${sessionId}) miss; recovered from default`)
      _captures.delete('default')
      return entry.actions
    }
  }
  if (!entry) {
    console.log(`[canvasActionCapture] pull(${sessionId}) miss; no actions captured (active=${_activeChatSessionId || 'none'}, keys=${[..._captures.keys()].join(',') || 'none'})`)
    return []
  }
  _captures.delete(sessionId)
  return entry.actions
}

// Periodic cleanup of stale entries
setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of _captures.entries()) {
    if (now - entry.capturedAt > TTL_MS) _captures.delete(id)
  }
}, 60 * 1000).unref()

module.exports = {
  captureCanvasActions,
  pullCanvasActions,
  setActiveChatSession,
  clearActiveChatSession,
  getActiveChatSession,
}
