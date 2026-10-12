/**
 * Correlation Engine - Multi-Agent Trace Correlation
 *
 * Links traces across agent handoffs for end-to-end visibility
 * in multi-agent workflows.
 *
 * TRV-1: Server-side cache via collector /traces/correlations endpoints.
 * No in-memory Map as primary store. Server cache with 24h TTL.
 *
 * Part of AOCL Compliance Suite (Enterprise)
 */

import { queryEnvelopes, getConversation } from '../../lib/aee'

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

function generateId() {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `CORR_${ts}_${rand}`.toUpperCase()
}

// ============================================================================
// Server Cache Helpers
// ============================================================================

async function getCachedCorrelation(runId) {
  try {
    const { correlation } = await fetchJson(`/traces/correlations/${encodeURIComponent(runId)}`)
    return correlation?.tree ? (typeof correlation.tree === 'string' ? JSON.parse(correlation.tree) : correlation.tree) : null
  } catch {
    return null // 404 = cache miss
  }
}

async function cacheCorrelation(runId, correlationId, correlation) {
  try {
    await fetchJson('/traces/correlations', {
      method: 'POST',
      body: JSON.stringify({
        id: generateId(),
        root_run_id: runId,
        correlation_id: correlationId,
        tree: correlation,
        stats: {
          totalDuration: correlation.totalDuration,
          participantCount: correlation.participants?.length || 0
        },
        agent_count: correlation.participants?.length || 0,
        handoff_count: correlation.handoffCount || 0
      })
    })
  } catch (err) {
    console.warn('[Correlation] Failed to cache correlation:', err)
  }
}

/**
 * Find correlated traces for a given run
 * Follows parent/child links across agents
 */
export async function findCorrelatedTraces(runId) {
  try {
    // Check server cache first
    const cached = await getCachedCorrelation(runId)
    if (cached) {
      return cached
    }

    // Get the original conversation
    const originalMessages = await getConversation(runId)

    if (!originalMessages || originalMessages.length === 0) {
      return null
    }

    // Extract correlation metadata from messages
    const firstMsg = originalMessages[0]
    const correlationId = firstMsg.payload?.correlationId || `CORR_${runId}`

    // Find all related traces by looking for:
    // 1. Same correlationId in payload
    // 2. References to this runId as parent
    // 3. Child traces spawned from this run

    const relatedTraces = await findRelatedTraces(runId, originalMessages)

    // Build the correlation result
    const participants = extractParticipants(originalMessages, relatedTraces)
    const runs = buildRunsList(originalMessages, relatedTraces)
    const handoffs = identifyHandoffs(runs)

    // Calculate total duration
    const startTime = Math.min(...runs.map(r => new Date(r.startTime).getTime()))
    const endTime = Math.max(...runs.map(r => new Date(r.endTime).getTime()))
    const totalDuration = endTime - startTime

    const correlation = {
      correlationId,
      initiator: firstMsg.from || 'unknown',
      participants,
      runs,
      handoffs,
      totalDuration,
      handoffCount: handoffs.length,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString()
    }

    // Cache to server (24h TTL)
    await cacheCorrelation(runId, correlationId, correlation)

    return correlation
  } catch (err) {
    console.error('[Correlation] Failed to find correlated traces:', err)
    return null
  }
}

/**
 * Find traces related to the given run
 */
async function findRelatedTraces(runId, originalMessages) {
  const relatedTraces = []

  // Look for delegate events (L7) that spawned child runs
  const delegateEvents = originalMessages.filter(
    m => m.intent === 'aocl.layer.complete' && m.payload?.layer === 'L7'
  )

  for (const event of delegateEvents) {
    if (event.payload?.childRunId) {
      try {
        const childMessages = await getConversation(event.payload.childRunId)
        if (childMessages && childMessages.length > 0) {
          relatedTraces.push({
            runId: event.payload.childRunId,
            parentRunId: runId,
            messages: childMessages,
            handoffType: 'delegate'
          })
        }
      } catch (err) {
        console.warn('[Correlation] Failed to load child trace:', err)
      }
    }
  }

  // Look for parent references in the original messages
  const parentRef = originalMessages.find(m => m.payload?.parentRunId)
  if (parentRef?.payload?.parentRunId) {
    try {
      const parentMessages = await getConversation(parentRef.payload.parentRunId)
      if (parentMessages && parentMessages.length > 0) {
        relatedTraces.push({
          runId: parentRef.payload.parentRunId,
          childRunId: runId,
          messages: parentMessages,
          handoffType: 'parent'
        })
      }
    } catch (err) {
      console.warn('[Correlation] Failed to load parent trace:', err)
    }
  }

  // Query for traces with matching correlationId — no artificial limit
  const correlationId = originalMessages[0]?.payload?.correlationId
  if (correlationId) {
    try {
      const correlatedEnvelopes = await queryEnvelopes({
        limit: 1000 // TRV-1: removed 100 limit that silently truncated results
      })

      // Filter to those with matching correlationId
      const matchingEnvelopes = correlatedEnvelopes.filter(
        e => e.payload?.correlationId === correlationId && e.corr !== runId
      )

      // Group by corr to get unique runs
      const corrGroups = new Map()
      for (const env of matchingEnvelopes) {
        if (!corrGroups.has(env.corr)) {
          corrGroups.set(env.corr, [])
        }
        corrGroups.get(env.corr).push(env)
      }

      for (const [corr, messages] of corrGroups) {
        if (!relatedTraces.some(t => t.runId === corr)) {
          relatedTraces.push({
            runId: corr,
            messages,
            handoffType: 'correlated'
          })
        }
      }
    } catch (err) {
      console.warn('[Correlation] Failed to query correlated traces:', err)
    }
  }

  return relatedTraces
}

/**
 * Extract unique participants from all traces
 */
function extractParticipants(originalMessages, relatedTraces) {
  const participants = new Set()

  // From original messages
  for (const msg of originalMessages) {
    if (msg.from) participants.add(msg.from)
    if (msg.to) participants.add(msg.to)
  }

  // From related traces
  for (const trace of relatedTraces) {
    for (const msg of trace.messages || []) {
      if (msg.from) participants.add(msg.from)
      if (msg.to) participants.add(msg.to)
    }
  }

  return Array.from(participants)
}

/**
 * Build list of runs with metadata
 */
function buildRunsList(originalMessages, relatedTraces) {
  const runs = []

  // Original run
  const origStartMsg = originalMessages.find(m => m.intent === 'aocl.run.start')
  const origCompleteMsg = originalMessages.find(m => m.intent === 'aocl.run.complete')
  const origFirstMsg = originalMessages[0]
  const origLastMsg = originalMessages[originalMessages.length - 1]

  runs.push({
    runId: origFirstMsg?.corr || 'unknown',
    agent: extractAgentName(originalMessages),
    startTime: origStartMsg?.ts || origFirstMsg?.ts,
    endTime: origCompleteMsg?.ts || origLastMsg?.ts,
    duration: origCompleteMsg?.payload?.duration_ms || calculateDuration(origFirstMsg?.ts, origLastMsg?.ts),
    status: origCompleteMsg?.payload?.status || 'complete',
    messageCount: originalMessages.length,
    isRoot: true,
    depth: 0
  })

  // Related runs
  for (const trace of relatedTraces) {
    const startMsg = trace.messages.find(m => m.intent === 'aocl.run.start')
    const completeMsg = trace.messages.find(m => m.intent === 'aocl.run.complete')
    const firstMsg = trace.messages[0]
    const lastMsg = trace.messages[trace.messages.length - 1]

    runs.push({
      runId: trace.runId,
      parentRunId: trace.parentRunId,
      agent: extractAgentName(trace.messages),
      startTime: startMsg?.ts || firstMsg?.ts,
      endTime: completeMsg?.ts || lastMsg?.ts,
      duration: completeMsg?.payload?.duration_ms || calculateDuration(firstMsg?.ts, lastMsg?.ts),
      status: completeMsg?.payload?.status || 'complete',
      messageCount: trace.messages.length,
      handoffType: trace.handoffType,
      isRoot: false,
      depth: trace.parentRunId ? 1 : 0
    })
  }

  // Sort by start time
  runs.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  return runs
}

/**
 * Identify handoffs between agents
 */
function identifyHandoffs(runs) {
  const handoffs = []

  for (let i = 0; i < runs.length - 1; i++) {
    const currentRun = runs[i]
    const nextRun = runs[i + 1]

    // Check if there's a direct parent-child relationship
    if (nextRun.parentRunId === currentRun.runId) {
      handoffs.push({
        id: `HO_${currentRun.runId}_${nextRun.runId}`,
        fromRunId: currentRun.runId,
        toRunId: nextRun.runId,
        fromAgent: currentRun.agent,
        toAgent: nextRun.agent,
        timestamp: nextRun.startTime,
        type: 'delegate',
        latency: calculateLatency(currentRun, nextRun)
      })
    } else {
      // Check for sequential handoffs (same correlation)
      const overlapOrGap = calculateLatency(currentRun, nextRun)
      if (Math.abs(overlapOrGap) < 5000) { // Within 5 seconds
        handoffs.push({
          id: `HO_${currentRun.runId}_${nextRun.runId}`,
          fromRunId: currentRun.runId,
          toRunId: nextRun.runId,
          fromAgent: currentRun.agent,
          toAgent: nextRun.agent,
          timestamp: nextRun.startTime,
          type: 'sequential',
          latency: Math.max(0, overlapOrGap)
        })
      }
    }
  }

  return handoffs
}

/**
 * Extract agent name from messages
 */
function extractAgentName(messages) {
  for (const msg of messages) {
    // Check 'to' field for agent destinations
    if (msg.to?.startsWith('agent.')) {
      return msg.to.replace('agent.', '')
    }
    // Check 'from' field for agent sources
    if (msg.from?.startsWith('agent.')) {
      return msg.from.replace('agent.', '')
    }
    // Check payload for agent info
    if (msg.payload?.agent) {
      return msg.payload.agent
    }
  }
  return 'unknown'
}

/**
 * Calculate duration between two timestamps
 */
function calculateDuration(start, end) {
  if (!start || !end) return 0
  return new Date(end) - new Date(start)
}

/**
 * Calculate latency between two runs
 */
function calculateLatency(fromRun, toRun) {
  if (!fromRun.endTime || !toRun.startTime) return 0
  return new Date(toRun.startTime) - new Date(fromRun.endTime)
}

/**
 * Get correlation tree for visualization
 */
export async function getCorrelationTree(correlationId) {
  // Check server cache
  let correlation = await getCachedCorrelation(correlationId)

  if (!correlation) {
    // Try to find and build correlation from runId
    correlation = await findCorrelatedTraces(correlationId)
  }

  if (!correlation) {
    return null
  }

  // Build tree structure
  const tree = buildTree(correlation.runs)

  return {
    correlationId: correlation.correlationId,
    tree,
    summary: {
      totalDuration: correlation.totalDuration,
      participantCount: correlation.participants.length,
      runCount: correlation.runs.length,
      handoffCount: correlation.handoffCount
    }
  }
}

/**
 * Build hierarchical tree from flat runs list
 */
function buildTree(runs) {
  const rootRuns = runs.filter(r => r.isRoot || !r.parentRunId)

  function buildNode(run) {
    const children = runs.filter(r => r.parentRunId === run.runId)

    return {
      id: run.runId,
      agent: run.agent,
      duration: run.duration,
      status: run.status,
      startTime: run.startTime,
      endTime: run.endTime,
      children: children.map(buildNode)
    }
  }

  return rootRuns.map(buildNode)
}

/**
 * Get agent handoffs for a specific run
 */
export async function getAgentHandoffs(runId) {
  const correlation = await findCorrelatedTraces(runId)

  if (!correlation) {
    return []
  }

  return correlation.handoffs
}

/**
 * Aggregate statistics across a correlation
 */
export async function aggregateCorrelationStats(correlationId) {
  // Check server cache
  let correlation = await getCachedCorrelation(correlationId)

  if (!correlation) {
    correlation = await findCorrelatedTraces(correlationId)
  }

  if (!correlation) {
    return null
  }

  // Calculate per-agent stats
  const agentStats = {}
  for (const run of correlation.runs) {
    const agent = run.agent
    if (!agentStats[agent]) {
      agentStats[agent] = {
        agent,
        runCount: 0,
        totalDuration: 0,
        avgDuration: 0,
        messageCount: 0
      }
    }
    agentStats[agent].runCount++
    agentStats[agent].totalDuration += run.duration
    agentStats[agent].messageCount += run.messageCount
  }

  // Calculate averages
  for (const stat of Object.values(agentStats)) {
    stat.avgDuration = stat.runCount > 0 ? Math.round(stat.totalDuration / stat.runCount) : 0
  }

  // Calculate handoff latency stats
  const latencies = correlation.handoffs.map(h => h.latency).filter(l => l > 0)
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0

  return {
    correlationId: correlation.correlationId,
    totalDuration: correlation.totalDuration,
    totalRuns: correlation.runs.length,
    totalHandoffs: correlation.handoffCount,
    participants: correlation.participants,
    agentStats: Object.values(agentStats),
    latencyStats: {
      avg: avgLatency,
      max: maxLatency,
      total: latencies.reduce((a, b) => a + b, 0)
    },
    timeline: {
      start: correlation.startTime,
      end: correlation.endTime
    }
  }
}

/**
 * Check if a conversation has multi-agent traces
 */
export async function hasMultiAgentTraces(runId) {
  try {
    const messages = await getConversation(runId)

    if (!messages || messages.length === 0) {
      return false
    }

    // Check for multiple agents
    const agents = new Set()
    for (const msg of messages) {
      if (msg.from?.startsWith('agent.')) {
        agents.add(msg.from)
      }
      if (msg.to?.startsWith('agent.')) {
        agents.add(msg.to)
      }
    }

    // Check for delegate events
    const hasDelegates = messages.some(
      m => m.intent === 'aocl.layer.complete' &&
           m.payload?.layer === 'L7' &&
           m.payload?.childRunId
    )

    // Check for correlation ID (indicates multi-agent workflow)
    const hasCorrelationId = messages.some(
      m => m.payload?.correlationId
    )

    return agents.size > 1 || hasDelegates || hasCorrelationId
  } catch (err) {
    console.warn('[Correlation] Failed to check multi-agent traces:', err)
    return false
  }
}

/**
 * Get saved correlations from server
 */
export async function getSavedCorrelations() {
  try {
    const { correlations } = await fetchJson('/traces/correlations?limit=200')
    return correlations || []
  } catch (err) {
    console.error('[Correlation] Failed to load correlations:', err)
    return []
  }
}

/**
 * Clear correlation cache on server
 */
export async function clearCorrelationCache() {
  try {
    // Loop until all cleared (200 per batch)
    let hasMore = true
    while (hasMore) {
      const { correlations } = await fetchJson('/traces/correlations?limit=200')
      if (!correlations || correlations.length === 0) { hasMore = false; break }
      for (const corr of correlations) {
        await fetchJson(`/traces/correlations/${encodeURIComponent(corr.root_run_id)}`, { method: 'DELETE' }).catch(() => {})
      }
    }
  } catch (err) {
    console.error('[Correlation] Failed to clear cache:', err)
  }
}
