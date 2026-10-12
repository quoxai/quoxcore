/**
 * TRV-2: Trace Assembler
 *
 * Joins AEE envelopes + VOLT events into a QuoxTrace view model.
 * Called by the collector /traces/:id endpoint.
 *
 * Input: raw AEE envelopes for a conversation + optional VOLT run/events
 * Output: QuoxTrace — a single assembled object ready for the waterfall component
 */

const LAYER_NAMES = {
  L0: { name: 'ingress.normalize', label: 'Normalize', number: 0 },
  L1: { name: 'identity.scope', label: 'Scope', number: 1 },
  L2: { name: 'route.smart', label: 'Route', number: 2 },
  L3: { name: 'policy.gate', label: 'Policy', number: 3 },
  L4: { name: 'plan.decompose', label: 'Plan', number: 4 },
  L5: { name: 'context.retrieve', label: 'Context', number: 5 },
  L6: { name: 'shape.rewrite', label: 'Shape', number: 6 },
  L7: { name: 'delegate.execute', label: 'Execute', number: 7 },
  L8: { name: 'verify.check', label: 'Verify', number: 8 },
  L9: { name: 'assemble.respond', label: 'Respond', number: 9 },
  L10: { name: 'audit.writeback', label: 'Audit', number: 10 }
}

/**
 * Build LayerSpan array from AOCL layer events.
 *
 * @param {Object[]} aoclEvents - Envelopes with intent starting with 'aocl.layer.'
 * @param {number} traceStartMs - Epoch ms of the trace start (for offset calculations)
 * @returns {Object[]} Array of LayerSpan objects ordered by layer number
 */
function buildLayerSpans(aoclEvents, traceStartMs) {
  if (!aoclEvents || aoclEvents.length === 0) return []

  // Group events by layer ID
  const layerMap = new Map()

  for (const env of aoclEvents) {
    const payload = typeof env.payload === 'string' ? JSON.parse(env.payload) : (env.payload || {})
    const layerId = payload.layer
    if (!layerId) continue

    if (!layerMap.has(layerId)) {
      layerMap.set(layerId, { starts: [], completes: [], bypasses: [], rejects: [] })
    }

    const group = layerMap.get(layerId)
    const intent = env.intent

    if (intent === 'aocl.layer.start') {
      group.starts.push({ ts: env.ts, payload })
    } else if (intent === 'aocl.layer.complete') {
      group.completes.push({ ts: env.ts, payload })
    } else if (intent === 'aocl.layer.bypass') {
      group.bypasses.push({ ts: env.ts, payload })
    } else if (intent === 'aocl.layer.reject') {
      group.rejects.push({ ts: env.ts, payload })
    }
  }

  // Build spans
  const spans = []

  for (const [layerId, events] of layerMap) {
    const meta = LAYER_NAMES[layerId] || { name: layerId, label: layerId, number: 99 }
    const startEvent = events.starts[0]
    const completeEvent = events.completes[0]
    const bypassEvent = events.bypasses[0]
    const rejectEvent = events.rejects[0]

    // Determine terminal event (complete, bypass, or reject)
    const terminalEvent = rejectEvent || completeEvent || bypassEvent
    const terminalPayload = terminalEvent?.payload || {}

    // Timing
    const startTs = startEvent?.ts || terminalEvent?.ts
    const endTs = terminalEvent?.ts || startEvent?.ts
    const startedAtMs = startTs ? new Date(startTs).getTime() : traceStartMs
    const endedAtMs = endTs ? new Date(endTs).getTime() : startedAtMs
    const duration_ms = terminalPayload.duration_ms ?? (endedAtMs - startedAtMs)
    const started_ms = startedAtMs - traceStartMs
    const ended_ms = started_ms + duration_ms

    // Status and outcome
    let status = 'executed'
    let outcome = 'complete'

    if (rejectEvent) {
      status = 'halted'
      outcome = 'deny'
    } else if (bypassEvent) {
      status = 'bypassed'
      outcome = 'bypass'
    } else if (terminalPayload.allowed === false) {
      status = 'halted'
      outcome = 'deny'
    } else if (terminalPayload.allowed === true) {
      outcome = 'allow'
    } else if (terminalPayload.hitl) {
      outcome = 'hitl'
    }

    // Decisions
    const decisions = []
    if (terminalPayload.allowed !== undefined) {
      decisions.push({
        code: terminalPayload.allowed ? 'ALLOW' : 'DENY',
        reason: terminalPayload.reason || '',
        policy_id: null,
        confidence: terminalPayload.confidence ?? null
      })
    }
    if (rejectEvent) {
      // Ensure we have a DENY decision for reject events
      if (!decisions.some(d => d.code === 'DENY')) {
        decisions.push({
          code: 'DENY',
          reason: terminalPayload.reason || 'Rejected by layer',
          policy_id: null,
          confidence: null
        })
      }
    }

    // Matched policies (L3)
    const matched_policies = terminalPayload.matched_policies || null

    spans.push({
      layer_id: layerId,
      layer_name: meta.name,
      layer_label: meta.label,
      layer_number: meta.number,
      status,
      outcome,
      started_at: startTs || new Date(traceStartMs).toISOString(),
      ended_at: endTs || new Date(traceStartMs).toISOString(),
      started_ms,
      ended_ms,
      duration_ms,
      decisions,
      context_delta: null, // Populated in TRV-3 when we have context tracking
      volt_event_ids: [],
      delegations: null,
      matched_policies,
      layer_summary: extractLayerSummary(layerId, terminalPayload),
      raw_payload: terminalPayload
    })
  }

  // Sort by layer number
  spans.sort((a, b) => a.layer_number - b.layer_number)

  return spans
}

/**
 * Extract a human-readable summary from a layer's raw payload.
 * Returns { text: string, details: { key: value } } for inline display.
 */
function extractLayerSummary(layerId, payload) {
  if (!payload || typeof payload !== 'object') return { text: '', details: {} }

  switch (layerId) {
    case 'L0': {
      // Normalize: model selection, target
      const model = payload.model || ''
      const provider = payload.provider || payload.target || ''
      const mode = payload.selectionMode || ''
      const text = [model, mode ? `(${mode})` : ''].filter(Boolean).join(' ')
      return {
        text: text || 'normalized',
        details: {
          ...(model && { model }),
          ...(provider && { provider }),
          ...(payload.targetType && { type: payload.targetType }),
          ...(payload.queryLength && { queryLength: payload.queryLength }),
        }
      }
    }
    case 'L1': {
      // Identity/Scope
      return { text: payload.scope || 'scoped', details: {} }
    }
    case 'L2': {
      // Smart Router
      if (payload.handled) {
        const target = payload.delegatedTo || payload.pattern || 'handled'
        const score = payload.delegationScore || payload.confidence
        return {
          text: `→ ${target}${score ? ` (score: ${score})` : ''}`,
          details: {
            handled: true,
            ...(payload.delegatedTo && { delegatedTo: payload.delegatedTo }),
            ...(payload.reason && { reason: payload.reason }),
          }
        }
      }
      return { text: payload.reason || 'no match', details: { handled: false } }
    }
    case 'L3': {
      // Policy Gate
      const checks = payload.checksRun || 0
      const warnings = payload.warningCount || 0
      const policies = (payload.matchedPolicies || []).length
      const parts = [`${checks} checks`]
      if (warnings > 0) parts.push(`${warnings} warnings`)
      if (policies > 0) parts.push(`${policies} policies matched`)
      return {
        text: parts.join(', '),
        details: {
          checksRun: checks,
          warningCount: warnings,
          ...(policies > 0 && { matchedPolicies: payload.matchedPolicies }),
        }
      }
    }
    case 'L4': {
      // Plan/Decompose
      return { text: payload.plan || 'decomposed', details: {} }
    }
    case 'L5': {
      // Context Retrieve
      const items = payload.memoryItemCount || 0
      const parts = [`${items} memories`]
      if (payload.hasQuoxContext) parts.push('QuoxContext')
      if (payload.hasDynamicContext) parts.push('dynamic')
      return {
        text: parts.join(', '),
        details: {
          memoryItemCount: items,
          memoryUsed: !!payload.memoryUsed,
          ...(payload.contextLength && { contextLength: payload.contextLength }),
        }
      }
    }
    case 'L6': {
      // Shape/Rewrite
      const len = payload.systemPromptLength || 0
      return {
        text: len > 0 ? `${len} char prompt` : 'no prompt',
        details: {
          systemPromptLength: len,
          contextInjected: !!payload.contextInjected,
        }
      }
    }
    case 'L7': {
      // Execute (the big one)
      const model = payload.model || ''
      const cost = payload.cost_usd
      const parts = []
      if (model) parts.push(model)
      if (cost != null) parts.push(`$${cost.toFixed(4)}`)
      if (payload.toolsUsed) parts.push(`${payload.toolsUsed} tools`)
      return {
        text: parts.join(', ') || 'executed',
        details: {
          ...(model && { model }),
          ...(cost != null && { cost_usd: cost }),
          ...(payload.provider && { provider: payload.provider }),
          ...(payload.capability && { capability: payload.capability }),
          success: payload.success !== false,
        }
      }
    }
    case 'L8': {
      // Verify
      const checks = payload.checksRun || 0
      const warnings = payload.warningCount || 0
      const formats = (payload.formats || []).join(', ')
      const parts = [`${checks} checks`]
      if (warnings > 0) parts.push(`${warnings} warnings`)
      if (formats) parts.push(formats)
      return {
        text: parts.join(', '),
        details: {
          valid: payload.valid !== false,
          checksRun: checks,
          warningCount: warnings,
          ...(payload.responseLength && { responseLength: payload.responseLength }),
        }
      }
    }
    case 'L9': {
      // Respond
      const len = payload.responseLength || 0
      return {
        text: len > 0 ? `${len} chars` : 'assembled',
        details: { responseLength: len }
      }
    }
    case 'L10': {
      // Audit/Writeback
      return { text: payload.written ? 'written' : 'audit', details: {} }
    }
    default:
      return { text: '', details: {} }
  }
}

/**
 * Generate a human-readable narrative for the trace.
 */
function generateNarrative(trace) {
  if (!trace || !trace.layers || trace.layers.length === 0) return ''

  const parts = []

  // Model + provider
  const execLayer = trace.layers.find(l => l.layer_id === 'L7')
  if (execLayer?.layer_summary?.details?.model) {
    parts.push(`Used ${execLayer.layer_summary.details.model}`)
    if (execLayer.layer_summary.details.provider) {
      parts.push(`via ${execLayer.layer_summary.details.provider}`)
    }
  }

  // Routing
  const routeLayer = trace.layers.find(l => l.layer_id === 'L2')
  if (routeLayer?.raw_payload?.handled && routeLayer?.raw_payload?.delegatedTo) {
    parts.push(`Delegated to ${routeLayer.raw_payload.delegatedTo}`)
  }

  // Policy
  const policyLayer = trace.layers.find(l => l.layer_id === 'L3')
  if (policyLayer) {
    const checks = policyLayer.raw_payload?.checksRun || 0
    const warnings = policyLayer.raw_payload?.warningCount || 0
    if (policyLayer.outcome === 'deny') {
      parts.push(`Blocked by policy (${policyLayer.raw_payload?.reason || 'denied'})`)
    } else if (warnings > 0) {
      parts.push(`${checks} policy checks (${warnings} warnings)`)
    } else {
      parts.push(`${checks} policy checks passed`)
    }
  }

  // Memory
  const ctxLayer = trace.layers.find(l => l.layer_id === 'L5')
  if (ctxLayer?.raw_payload?.memoryItemCount > 0) {
    parts.push(`${ctxLayer.raw_payload.memoryItemCount} memories retrieved`)
  }

  // Cost
  if (execLayer?.raw_payload?.cost_usd != null) {
    parts.push(`Cost $${execLayer.raw_payload.cost_usd.toFixed(4)}`)
  }

  // Verification
  const verifyLayer = trace.layers.find(l => l.layer_id === 'L8')
  if (verifyLayer) {
    const fmt = (verifyLayer.raw_payload?.formats || []).join(', ')
    const len = verifyLayer.raw_payload?.responseLength || 0
    if (fmt && len) parts.push(`Response verified (${fmt}, ${len} chars)`)
  }

  return parts.join('. ') + (parts.length > 0 ? '.' : '')
}

/**
 * Determine the overall trace outcome.
 *
 * @param {Object|null} runCompleteEnvelope - The aocl.run.complete envelope
 * @param {Object[]} layers - Built LayerSpan array
 * @returns {string} 'complete' | 'policy_deny' | 'hitl_pending' | 'halt' | 'error'
 */
function determineOutcome(runCompleteEnvelope, layers) {
  // Check for policy denials in layers
  const hasDenial = layers.some(l => l.outcome === 'deny')
  if (hasDenial) return 'policy_deny'

  // Check for HITL
  const hasHitl = layers.some(l => l.outcome === 'hitl')
  if (hasHitl) return 'hitl_pending'

  // Check run complete status
  if (runCompleteEnvelope) {
    const payload = typeof runCompleteEnvelope.payload === 'string'
      ? JSON.parse(runCompleteEnvelope.payload)
      : (runCompleteEnvelope.payload || {})
    if (payload.success === false) return 'error'
  }

  return 'complete'
}

/**
 * Assemble a full QuoxTrace from raw envelopes + optional VOLT data.
 *
 * @param {Object[]} envelopes - All AEE envelopes for this conversation
 * @param {Object|null} voltRun - VOLT run record (from volt_runs table)
 * @param {Object[]|null} voltEvents - VOLT events for this run
 * @returns {Object|null} QuoxTrace view model, or null if no data
 */
function assembleTrace(envelopes, voltRun, voltEvents) {
  if (!envelopes || envelopes.length === 0) return null

  // Parse payloads that are still strings
  const parsed = envelopes.map(e => ({
    ...e,
    payload: typeof e.payload === 'string' ? safeJsonParse(e.payload) : (e.payload || {})
  }))

  // Find key envelopes
  const taskEnvelope = parsed.find(e => e.type === 'task')
  const resultEnvelope = parsed.find(e => e.type === 'result')
  const runStartEnvelope = parsed.find(e => e.intent === 'aocl.run.start')
  const runCompleteEnvelope = parsed.find(e => e.intent === 'aocl.run.complete')
  const aoclLayerEvents = parsed.filter(e => e.intent?.startsWith('aocl.layer.'))

  // Determine corr and run_id
  const corr = parsed[0].corr
  const run_id = runStartEnvelope?.payload?.runId || runCompleteEnvelope?.payload?.runId || corr

  // Timing
  const started_at = runStartEnvelope?.ts || taskEnvelope?.ts || parsed[0].ts
  const ended_at = runCompleteEnvelope?.ts || resultEnvelope?.ts || parsed[parsed.length - 1].ts
  const traceStartMs = new Date(started_at).getTime()

  const runPayload = runCompleteEnvelope?.payload || {}
  const duration_ms = runPayload.duration_ms || (new Date(ended_at).getTime() - traceStartMs)

  // Actor
  const actorId = taskEnvelope?.from || parsed[0].from || 'unknown'
  const actor = {
    type: actorId.startsWith('human.') ? 'human' : actorId.startsWith('agent.') ? 'agent' : 'system',
    id: actorId,
    display_name: actorId.split('.').pop() || actorId
  }

  // Query and response
  const query = taskEnvelope?.payload?.text || ''
  const responseText = resultEnvelope?.payload?.text || ''
  const response_summary = responseText.slice(0, 200)

  // Build layers
  const layers = buildLayerSpans(aoclLayerEvents, traceStartMs)

  // Outcome
  const outcome = determineOutcome(runCompleteEnvelope, layers)

  // VOLT
  let volt = null
  if (voltRun) {
    volt = {
      run_id: voltRun.run_id,
      event_count: voltEvents?.length || 0,
      head_hash: voltRun.head_hash || null,
      bundle_id: voltRun.bundle_id || null,
      verified: voltRun.status === 'completed' && !!voltRun.head_hash
    }
  }

  // Derived
  const has_denial = layers.some(l => l.outcome === 'deny')
  const has_hitl = layers.some(l => l.outcome === 'hitl')
  const decision_count = layers.reduce((sum, l) => sum + l.decisions.length, 0)

  const trace = {
    run_id,
    corr,
    started_at,
    ended_at,
    duration_ms,
    actor,
    query,
    response_summary,
    outcome,
    layers,
    delegations: [],
    volt,
    ward: null, // Populated when WARD integration is wired
    layer_count: layers.length,
    decision_count,
    has_denial,
    has_hitl,
    compliance_tags: deriveComplianceTags(outcome, layers),
    narrative: '', // Populated below
    most_interesting_layer: null, // Layer ID to auto-open
  }

  // Generate narrative summary
  trace.narrative = generateNarrative(trace)

  // Determine most interesting layer to auto-open
  // Priority: denied > HITL > warnings > delegated > slowest
  const denied = layers.find(l => l.outcome === 'deny')
  const hitl = layers.find(l => l.outcome === 'hitl')
  const withWarnings = layers.find(l => (l.raw_payload?.warningCount || 0) > 0)
  const delegated = layers.find(l => l.raw_payload?.handled && l.raw_payload?.delegatedTo)
  const slowest = layers.length > 0 ? layers.reduce((a, b) => a.duration_ms > b.duration_ms ? a : b) : null

  trace.most_interesting_layer = (denied || hitl || withWarnings || delegated || slowest)?.layer_id || null

  return trace
}

/**
 * Create a lighter QuoxTraceSummary for list views.
 */
function assembleTraceSummary(trace) {
  if (!trace) return null
  return {
    run_id: trace.run_id,
    corr: trace.corr,
    started_at: trace.started_at,
    duration_ms: trace.duration_ms,
    actor: trace.actor,
    query_preview: (trace.query || '').slice(0, 100),
    outcome: trace.outcome,
    layer_count: trace.layer_count,
    decision_count: trace.decision_count,
    has_denial: trace.has_denial,
    has_hitl: trace.has_hitl,
    volt_verified: trace.volt?.verified ?? null
  }
}

/**
 * Derive compliance framework tags from trace outcome.
 */
function deriveComplianceTags(outcome, layers) {
  const tags = []
  if (layers.some(l => l.layer_id === 'L3' && l.decisions.length > 0)) {
    tags.push('SOC2-CC6.1') // Access control policy evaluation
  }
  if (outcome === 'policy_deny') {
    tags.push('ISO27001-A.12.1.2') // Access control enforcement
  }
  if (layers.some(l => l.layer_id === 'L10')) {
    tags.push('SOC2-CC7.2') // Change monitoring
  }
  return tags
}

function safeJsonParse(str) {
  try { return JSON.parse(str) } catch { return {} }
}

module.exports = { assembleTrace, assembleTraceSummary, buildLayerSpans, determineOutcome }
