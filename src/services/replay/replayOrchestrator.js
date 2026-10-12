/**
 * Replay Orchestrator Service
 *
 * Provides trace replay functionality for debugging and what-if analysis.
 * Part of AOCL Compliance Suite (Enterprise plugin).
 *
 * TRV-1: Server-side persistence via collector /traces/replay-sessions endpoints.
 * No localStorage. All sessions are durable across devices and browser clears.
 *
 * Features:
 * - Re-execute historical traces with modifications
 * - Mock layer responses for isolated testing
 * - Compare original vs replay results
 * - Persist replay sessions for later review
 */

import { prefixedUlid } from '../../lib/aee/ulid'
import {
  getConversation,
  queryEnvelopes,
  storeEnvelope
} from '../../lib/aee/store'
import { createRunEvent, createLayerEvent, AOCL_LAYERS } from '../../lib/aee/envelope'
import { getLayerMocks, clearAllMocks } from './layerMocker'

// ============================================================================
// Server Persistence Helpers
// ============================================================================

const COLLECTOR_BASE = '/collector'

async function fetchJson(path, options = {}) {
  const res = await fetch(`${COLLECTOR_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Server error: ${res.status}`)
  }
  return res.json()
}

// ============================================================================
// Session Management (server-backed)
// ============================================================================

/**
 * Get all replay sessions from server
 * @returns {Promise<Array>} Array of replay sessions
 */
export async function getReplaySessions() {
  try {
    const { sessions } = await fetchJson('/traces/replay-sessions?limit=200')
    return sessions || []
  } catch (err) {
    console.error('[Replay] Failed to load sessions:', err)
    return []
  }
}

/**
 * Save a replay session to server (create or update)
 * @param {Object} session - Session to save
 */
async function saveSession(session) {
  try {
    await fetchJson(`/traces/replay-sessions/${session.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        status: session.status,
        replay_result: JSON.stringify(session)
      })
    })
  } catch (err) {
    console.error('[Replay] Failed to save session:', err)
  }
}

/**
 * Creates a new replay session from an existing trace
 *
 * @param {string} runId - Original run ID or correlation ID to replay
 * @param {Object} [modifications] - Modifications to apply during replay
 * @param {string} [modifications.query] - Modified query text
 * @param {Object} [modifications.context] - Modified context
 * @param {Object} [modifications.layerConfig] - Layer enable/disable config
 * @param {Object} [modifications.mockResponses] - Mock responses for layers
 * @returns {Promise<Object>} Created replay session
 */
export async function createReplaySession(runId, modifications = {}) {
  // Load original trace data
  const originalTrace = await loadOriginalTrace(runId)

  if (!originalTrace) {
    throw new Error(`Could not find trace for run: ${runId}`)
  }

  const session = {
    id: prefixedUlid('REPLAY'),
    originalRunId: runId,
    originalCorr: originalTrace.corr,
    status: 'pending',
    createdAt: new Date().toISOString(),
    modifications: {
      query: modifications.query || originalTrace.query,
      context: modifications.context || originalTrace.context || {},
      layerConfig: modifications.layerConfig || {},
      mockResponses: modifications.mockResponses || {}
    },
    original: {
      query: originalTrace.query,
      response: originalTrace.response,
      layers: originalTrace.layers,
      duration_ms: originalTrace.duration_ms,
      success: originalTrace.success
    },
    replay: null,
    comparison: null
  }

  // Persist to server
  try {
    await fetchJson('/traces/replay-sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: session.id,
        run_id: runId,
        status: 'pending',
        query: session.modifications.query,
        layer_config: session.modifications.layerConfig,
        mock_config: session.modifications.mockResponses,
        original_trace: session.original
      })
    })
  } catch (err) {
    console.error('[Replay] Failed to persist session:', err)
  }

  return session
}

/**
 * Loads the original trace data from stored envelopes
 *
 * @param {string} runId - Run ID or correlation ID
 * @returns {Promise<Object|null>} Trace data or null
 */
async function loadOriginalTrace(runId) {
  try {
    // Try to find by correlation ID first
    let envelopes = await getConversation(runId)

    // If empty, try querying by intent pattern
    if (!envelopes || envelopes.length === 0) {
      envelopes = await queryEnvelopes({
        intent: 'aocl.run.start',
        limit: 500
      })
      // Find the run with matching ID
      const runEnvelope = envelopes.find(
        e => e.payload?.runId === runId || e.corr === runId
      )
      if (runEnvelope) {
        envelopes = await getConversation(runEnvelope.corr)
      }
    }

    if (!envelopes || envelopes.length === 0) {
      return null
    }

    // Extract trace data from envelopes
    const queryEnvelope = envelopes.find(e => e.intent === 'quox.chat.query')
    const responseEnvelope = envelopes.find(e => e.intent === 'quox.chat.response')
    const layerEnvelopes = envelopes.filter(e =>
      e.intent?.startsWith('aocl.layer.')
    )
    const runCompleteEnvelope = envelopes.find(e => e.intent === 'aocl.run.complete')

    // Parse layer events
    const layers = layerEnvelopes.reduce((acc, env) => {
      const layerId = env.payload?.layer
      if (!layerId) return acc

      if (!acc[layerId]) {
        acc[layerId] = {
          id: layerId,
          events: []
        }
      }
      acc[layerId].events.push({
        status: env.payload?.status,
        timestamp: env.ts,
        duration_ms: env.payload?.duration_ms,
        payload: env.payload
      })
      return acc
    }, {})

    return {
      corr: envelopes[0].corr,
      query: queryEnvelope?.payload?.text || '',
      response: responseEnvelope?.payload?.text || '',
      context: queryEnvelope?.payload?.context || {},
      layers,
      duration_ms: runCompleteEnvelope?.payload?.duration_ms || 0,
      success: runCompleteEnvelope?.payload?.success !== false,
      envelopes
    }
  } catch (err) {
    console.error('[Replay] Failed to load trace:', err)
    return null
  }
}

/**
 * Executes a replay session
 *
 * @param {string} sessionId - Replay session ID
 * @returns {Promise<Object>} Updated session with replay results
 */
export async function executeReplay(sessionId) {
  const session = await getReplaySession(sessionId)

  if (!session) {
    throw new Error(`Replay session not found: ${sessionId}`)
  }

  session.status = 'running'
  session.startedAt = new Date().toISOString()
  await saveSession(session)

  try {
    // Create new correlation for replay
    const replayCorr = prefixedUlid('REPLAY_RUN')
    const startTime = Date.now()

    // Emit replay run start
    const runStartEnvelope = createRunEvent('start', {
      originalRunId: session.originalRunId,
      replaySessionId: session.id,
      query: session.modifications.query,
      isReplay: true
    }, replayCorr)
    await storeEnvelope(runStartEnvelope).catch(() => {})

    // Execute through simulated layer pipeline
    const layerResults = await executeLayerPipeline(session, replayCorr)

    // Generate simulated response based on modifications
    const replayResponse = await generateReplayResponse(session, layerResults)

    const endTime = Date.now()
    const duration_ms = endTime - startTime

    // Emit replay run complete
    const runCompleteEnvelope = createRunEvent('complete', {
      originalRunId: session.originalRunId,
      replaySessionId: session.id,
      duration_ms,
      success: true,
      isReplay: true,
      layerResults: Object.keys(layerResults)
    }, replayCorr)
    await storeEnvelope(runCompleteEnvelope).catch(() => {})

    // Update session with results
    session.replay = {
      corr: replayCorr,
      response: replayResponse,
      layers: layerResults,
      duration_ms,
      success: true,
      completedAt: new Date().toISOString()
    }

    // Generate comparison
    session.comparison = compareResults(session.original, session.replay)
    session.status = 'completed'
    session.completedAt = new Date().toISOString()

    // Clear any mocks that were set
    clearAllMocks()

    // Save updated session to server
    await saveSession(session)

    return session
  } catch (err) {
    console.error('[Replay] Execution failed:', err)

    session.status = 'error'
    session.error = err.message
    await saveSession(session)

    throw err
  }
}

/**
 * Executes the simulated layer pipeline
 *
 * @param {Object} session - Replay session
 * @param {string} corr - Correlation ID
 * @returns {Promise<Object>} Layer results
 */
async function executeLayerPipeline(session, corr) {
  const results = {}
  const mocks = getLayerMocks()
  const layerConfig = session.modifications.layerConfig || {}

  // Process each layer in order
  const layerOrder = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']

  for (const layerId of layerOrder) {
    // Check if layer is disabled
    if (layerConfig[layerId]?.enabled === false) {
      results[layerId] = {
        status: 'bypass',
        reason: 'disabled',
        duration_ms: 0
      }

      // Emit bypass event
      const bypassEnvelope = createLayerEvent(layerId, 'bypass', {
        reason: 'disabled_in_replay',
        replaySessionId: session.id
      }, corr)
      await storeEnvelope(bypassEnvelope).catch(() => {})

      continue
    }

    const startTime = Date.now()

    // Emit layer start
    const startEnvelope = createLayerEvent(layerId, 'start', {
      replaySessionId: session.id
    }, corr)
    await storeEnvelope(startEnvelope).catch(() => {})

    // Check for mock response
    if (mocks[layerId] || session.modifications.mockResponses?.[layerId]) {
      const mockResponse = mocks[layerId] || session.modifications.mockResponses[layerId]
      const duration_ms = Date.now() - startTime

      results[layerId] = {
        status: 'complete',
        mocked: true,
        result: mockResponse,
        duration_ms
      }

      // Emit complete with mock indicator
      const completeEnvelope = createLayerEvent(layerId, 'complete', {
        replaySessionId: session.id,
        mocked: true,
        duration_ms,
        result: mockResponse
      }, corr)
      await storeEnvelope(completeEnvelope).catch(() => {})

      continue
    }

    // Simulate original layer behavior (use original timing as estimate)
    const originalLayer = session.original.layers?.[layerId]
    const simulatedDelay = Math.min(
      originalLayer?.events?.[0]?.duration_ms || 50,
      100 // Cap simulation delay
    )

    await new Promise(resolve => setTimeout(resolve, simulatedDelay))

    const duration_ms = Date.now() - startTime

    results[layerId] = {
      status: 'complete',
      simulated: true,
      duration_ms,
      originalDuration_ms: originalLayer?.events?.[0]?.duration_ms
    }

    // Emit complete
    const completeEnvelope = createLayerEvent(layerId, 'complete', {
      replaySessionId: session.id,
      simulated: true,
      duration_ms
    }, corr)
    await storeEnvelope(completeEnvelope).catch(() => {})
  }

  return results
}

/**
 * Generates the replay response based on modifications and mocks
 *
 * @param {Object} session - Replay session
 * @param {Object} layerResults - Layer execution results
 * @returns {Promise<string>} Generated response
 */
async function generateReplayResponse(session, layerResults) {
  // If L7 (Execute) has a mock, use that as the response
  if (layerResults.L7?.mocked && layerResults.L7?.result) {
    const mockResult = layerResults.L7.result
    if (typeof mockResult === 'string') {
      return mockResult
    }
    if (mockResult.response) {
      return mockResult.response
    }
    if (mockResult.text) {
      return mockResult.text
    }
  }

  // If query was modified, indicate this in the simulated response
  if (session.modifications.query !== session.original.query) {
    return `[REPLAY SIMULATION]\n\nOriginal query: "${session.original.query}"\nModified query: "${session.modifications.query}"\n\nOriginal response would need to be re-generated with actual LLM call.\nThis is a simulation showing the layer pipeline execution.\n\n---\n\nOriginal response:\n${session.original.response}`
  }

  // Return original response with replay indicator
  return `[REPLAY - Simulated]\n\n${session.original.response}`
}

/**
 * Compares original and replay results
 *
 * @param {Object} original - Original trace data
 * @param {Object} replay - Replay results
 * @returns {Object} Comparison results
 */
function compareResults(original, replay) {
  const comparison = {
    timing: {
      originalDuration_ms: original.duration_ms,
      replayDuration_ms: replay.duration_ms,
      difference_ms: replay.duration_ms - original.duration_ms,
      percentChange: original.duration_ms > 0
        ? ((replay.duration_ms - original.duration_ms) / original.duration_ms * 100).toFixed(1)
        : 0
    },
    layers: {},
    response: {
      originalLength: original.response?.length || 0,
      replayLength: replay.response?.length || 0,
      changed: original.response !== replay.response,
      contentDiff: generateContentDiff(original.response, replay.response)
    },
    summary: {
      layersExecuted: Object.keys(replay.layers || {}).length,
      layersBypassed: Object.values(replay.layers || {}).filter(l => l.status === 'bypass').length,
      layersMocked: Object.values(replay.layers || {}).filter(l => l.mocked).length
    }
  }

  // Compare layer timings
  const allLayerIds = new Set([
    ...Object.keys(original.layers || {}),
    ...Object.keys(replay.layers || {})
  ])

  for (const layerId of allLayerIds) {
    const origLayer = original.layers?.[layerId]
    const replayLayer = replay.layers?.[layerId]

    const origDuration = origLayer?.events?.[0]?.duration_ms || 0
    const replayDuration = replayLayer?.duration_ms || 0

    comparison.layers[layerId] = {
      originalDuration_ms: origDuration,
      replayDuration_ms: replayDuration,
      difference_ms: replayDuration - origDuration,
      originalStatus: origLayer?.events?.[origLayer.events.length - 1]?.status || 'unknown',
      replayStatus: replayLayer?.status || 'unknown',
      mocked: replayLayer?.mocked || false,
      bypassed: replayLayer?.status === 'bypass'
    }
  }

  return comparison
}

/**
 * Generates a simple content diff
 *
 * @param {string} original - Original text
 * @param {string} replay - Replay text
 * @returns {Object} Diff information
 */
function generateContentDiff(original = '', replay = '') {
  const originalLines = original.split('\n')
  const replayLines = replay.split('\n')

  const diff = {
    added: 0,
    removed: 0,
    unchanged: 0,
    changes: []
  }

  // Simple line-by-line comparison
  const maxLines = Math.max(originalLines.length, replayLines.length)

  for (let i = 0; i < maxLines; i++) {
    const origLine = originalLines[i]
    const replayLine = replayLines[i]

    if (origLine === replayLine) {
      diff.unchanged++
    } else if (origLine === undefined) {
      diff.added++
      diff.changes.push({ type: 'added', line: i + 1, content: replayLine })
    } else if (replayLine === undefined) {
      diff.removed++
      diff.changes.push({ type: 'removed', line: i + 1, content: origLine })
    } else {
      diff.removed++
      diff.added++
      diff.changes.push({ type: 'changed', line: i + 1, original: origLine, replay: replayLine })
    }
  }

  // Limit changes to first 20 for UI
  diff.changes = diff.changes.slice(0, 20)
  diff.totalChanges = diff.added + diff.removed

  return diff
}

/**
 * Gets a replay session by ID (from server)
 *
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object|null>} Replay session or null
 */
export async function getReplaySession(sessionId) {
  try {
    const { session } = await fetchJson(`/traces/replay-sessions/${sessionId}`)
    // The full session object is stored in replay_result
    if (session?.replay_result && typeof session.replay_result === 'object') {
      return session.replay_result
    }
    return session || null
  } catch {
    return null
  }
}

/**
 * Compares replay results between two sessions or original vs replay
 *
 * @param {string} sessionId - Replay session ID
 * @returns {Promise<Object|null>} Comparison results
 */
export async function compareReplayResults(sessionId) {
  const session = await getReplaySession(sessionId)
  if (!session || !session.comparison) {
    return null
  }
  return session.comparison
}

/**
 * Deletes a replay session from server
 *
 * @param {string} sessionId - Session ID to delete
 * @returns {Promise<boolean>} Whether deletion succeeded
 */
export async function deleteReplaySession(sessionId) {
  try {
    await fetchJson(`/traces/replay-sessions/${sessionId}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

/**
 * Clears all replay sessions from server
 */
export async function clearAllReplaySessions() {
  try {
    await fetchJson('/traces/replay-sessions', { method: 'DELETE' })
  } catch (err) {
    console.error('[Replay] Failed to clear sessions:', err)
  }
}

/**
 * Gets replay history for a specific trace
 *
 * @param {string} runId - Original run ID
 * @returns {Promise<Array>} Replay sessions for this run
 */
export async function getReplayHistoryForRun(runId) {
  const sessions = await getReplaySessions()
  return sessions.filter(s => s.run_id === runId || s.originalRunId === runId)
}
