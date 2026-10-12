/**
 * useAoclLayerSteps — server-emitted AOCL layer envelopes → trace steps.
 *
 * AOCL-DISPATCH-B15 rewrite. Two distinct modes:
 *
 *   LIVE (isProcessing=true): always emit ALL 11 canonical layer slots
 *   from the start so the waterfall renders as a complete skeleton, then
 *   each row fills in as its envelope arrives. The first incomplete layer
 *   is marked status:'active' and gets a live-ticking duration so the
 *   user can see exactly which layer is currently working.
 *
 *   POST-MORTEM (isProcessing=false, e.g. MessageTrace on a past
 *   conversation): emit only the layers that actually have envelopes,
 *   in canonical order. Pending/active states don't apply.
 *
 * Each step shape:
 *   { id, layer, agent, agentColor, message, stage, ts, elapsed,
 *     computedDuration, outcome, status }
 *
 *   status: 'pending' | 'active' | 'complete' | 'bypass' | 'reject'
 */
import { useEffect, useState, useRef } from 'react'
import { getConversationFromServer } from '../lib/aee/store.js'
import { AOCL_LAYERS } from '../lib/aee/envelope.js'

const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']
const LAYER_INDEX = Object.fromEntries(LAYER_ORDER.map((id, i) => [id, i]))

const OUTCOME_PRECEDENCE = { complete: 3, bypass: 2, reject: 1, start: 0 }

const LAYER_MESSAGES = {
    L0:  'Normalizing request',
    L1:  'Verifying identity',
    L2:  'Smart router check',
    L3:  'Safety + compliance',
    L4:  'Planning orchestration',
    L5:  'Retrieving context',
    L6:  'Shaping prompt',
    L7:  'Calling model',
    L8:  'Verifying response',
    L9:  'Composing reply',
    L10: 'Writing audit record',
}

function pickBestEnvelopeForLayer(envelopes) {
    return envelopes.sort((a, b) => {
        const aServer = a.from === 'system.aocl' ? 1 : 0
        const bServer = b.from === 'system.aocl' ? 1 : 0
        if (aServer !== bServer) return bServer - aServer
        const aOutcome = OUTCOME_PRECEDENCE[a._outcome] ?? -1
        const bOutcome = OUTCOME_PRECEDENCE[b._outcome] ?? -1
        if (aOutcome !== bOutcome) return bOutcome - aOutcome
        const aTs = a.ts ? new Date(a.ts).getTime() : 0
        const bTs = b.ts ? new Date(b.ts).getTime() : 0
        return bTs - aTs
    })[0]
}

function buildStepFromEnvelope(layer, env, cumTs) {
    const meta = AOCL_LAYERS[layer] || { label: layer, color: '#8b5cf6' }
    const baseMessage = LAYER_MESSAGES[layer] || env.intent
    const outcome = env._outcome
    const message = outcome === 'bypass'
        ? `${baseMessage} (bypassed)`
        : outcome === 'reject'
            ? `${baseMessage} — denied`
            : baseMessage
    const dur = typeof env.payload?.duration_ms === 'number' ? env.payload.duration_ms : 0
    return {
        id: `aocl-${layer}-${env.id || env._outcome}`,
        layer,
        agent: meta.label.toUpperCase(),
        agentColor: meta.color,
        message,
        stage: outcome === 'reject' ? 'error'
            : outcome === 'bypass' ? 'routing_detail'
            : 'processing',
        ts: cumTs,
        elapsed: dur,
        computedDuration: dur,
        outcome,
        status: outcome,
    }
}

function buildPendingStep(layer, cumTs, isActive) {
    const meta = AOCL_LAYERS[layer] || { label: layer, color: '#8b5cf6' }
    const baseMessage = LAYER_MESSAGES[layer] || layer
    return {
        id: `aocl-${layer}-${isActive ? 'active' : 'pending'}`,
        layer,
        agent: meta.label.toUpperCase(),
        agentColor: meta.color,
        message: isActive ? `${baseMessage}…` : baseMessage,
        stage: isActive ? 'processing' : 'pending',
        ts: cumTs,
        elapsed: null,
        computedDuration: null,
        outcome: isActive ? 'active' : 'pending',
        status: isActive ? 'active' : 'pending',
    }
}

export function useAoclLayerSteps(corr, isProcessing, { pollMs = 500, turnStart, turnEnd } = {}) {
    const [steps, setSteps] = useState(() =>
        isProcessing
            ? LAYER_ORDER.map((layer, i) => buildPendingStep(layer, Date.now() + i, i === 0))
            : []
    )
    const startRef = useRef(null)
    const prevProcessingRef = useRef(isProcessing)

    // AOCL-DISPATCH-B16: reset to skeleton when processing transitions
    // false → true so follow-up turns don't render with the previous
    // turn's stale rows. Conversation corr is shared across turns; the
    // turn boundary is detected client-side via this transition.
    useEffect(() => {
        const prev = prevProcessingRef.current
        prevProcessingRef.current = isProcessing
        if (isProcessing && !prev) {
            startRef.current = Date.now()
            setSteps(LAYER_ORDER.map((layer, i) => buildPendingStep(layer, Date.now() + i, i === 0)))
        }
        if (!isProcessing && prev) {
            startRef.current = null
        }
    }, [isProcessing])

    useEffect(() => {
        if (!corr) {
            if (isProcessing && steps.length === 0) {
                setSteps(LAYER_ORDER.map((layer, i) => buildPendingStep(layer, Date.now() + i, i === 0)))
            }
            return
        }

        if (isProcessing && !startRef.current) {
            startRef.current = Date.now()
        }

        const tsFrom = turnStart ? new Date(turnStart).getTime() : -Infinity
        const tsTo = turnEnd ? new Date(turnEnd).getTime() : Infinity

        const fetchAndBuild = async () => {
            try {
                const envelopes = await getConversationFromServer(corr)
                const list = Array.isArray(envelopes) ? envelopes : []

                // AOCL-DISPATCH-B16: in LIVE mode, the conversation corr is
                // shared across turns, so the AEE DB returns envelopes from
                // every prior turn too. Identify the CURRENT turn by the
                // latest aocl.run.start envelope and only consider envelopes
                // whose ts is on/after that. Falls back to startRef.current
                // (with a small clock-skew buffer) if no run.start is yet
                // visible.
                let liveTurnStart = -Infinity
                if (isProcessing && !turnStart) {
                    let latestRunStartTs = null
                    for (const env of list) {
                        if (env?.intent !== 'aocl.run.start') continue
                        const t = env.ts ? new Date(env.ts).getTime() : null
                        if (t != null && (latestRunStartTs == null || t > latestRunStartTs)) {
                            latestRunStartTs = t
                        }
                    }
                    if (latestRunStartTs != null) {
                        liveTurnStart = latestRunStartTs
                    } else if (startRef.current) {
                        liveTurnStart = startRef.current - 2000
                    }
                }
                const liveTsFrom = isProcessing && !turnStart ? liveTurnStart : tsFrom

                // Bucket envelopes by layer (turn-scoped in LIVE mode)
                const byLayer = {}
                for (const env of list) {
                    if (!env?.intent?.startsWith('aocl.layer.')) continue
                    const parts = env.intent.split('.')
                    if (parts.length !== 4) continue
                    const layer = parts[2]
                    const outcome = parts[3]
                    if (!LAYER_INDEX.hasOwnProperty(layer)) continue
                    if (outcome === 'start') continue

                    const envTs = env.ts ? new Date(env.ts).getTime() : NaN
                    if (Number.isFinite(envTs) && (envTs < liveTsFrom || envTs > tsTo)) continue

                    const tagged = { ...env, _outcome: outcome }
                    if (!byLayer[layer]) byLayer[layer] = []
                    byLayer[layer].push(tagged)
                }

                const nextSteps = []
                let cumTs = startRef.current || Date.now()

                if (isProcessing) {
                    // LIVE mode: walk all 11 canonical layers. Fill envelope
                    // data for completed layers, mark the first incomplete
                    // layer as 'active', remaining as 'pending'.
                    let activeAssigned = false
                    for (const layer of LAYER_ORDER) {
                        const bucket = byLayer[layer]
                        if (bucket && bucket.length > 0) {
                            const env = pickBestEnvelopeForLayer(bucket)
                            const step = buildStepFromEnvelope(layer, env, cumTs)
                            nextSteps.push(step)
                            cumTs += Math.max(step.elapsed || 0, 1)
                        } else if (!activeAssigned) {
                            nextSteps.push(buildPendingStep(layer, cumTs, true))
                            activeAssigned = true
                        } else {
                            nextSteps.push(buildPendingStep(layer, cumTs, false))
                        }
                    }
                } else {
                    // POST-MORTEM mode: only render layers that have envelopes
                    for (const layer of LAYER_ORDER) {
                        const bucket = byLayer[layer]
                        if (!bucket || bucket.length === 0) continue
                        const env = pickBestEnvelopeForLayer(bucket)
                        const step = buildStepFromEnvelope(layer, env, cumTs)
                        nextSteps.push(step)
                        cumTs += Math.max(step.elapsed || 0, 1)
                    }
                }

                // Skip state update when nothing meaningful changed
                setSteps(prev => {
                    if (prev.length === nextSteps.length) {
                        let changed = false
                        for (let i = 0; i < prev.length; i++) {
                            const a = prev[i], b = nextSteps[i]
                            if (a.id !== b.id || a.elapsed !== b.elapsed
                                || a.status !== b.status || a.outcome !== b.outcome) {
                                changed = true
                                break
                            }
                        }
                        if (!changed) return prev
                    }
                    return nextSteps
                })
            } catch (err) {
                if (process.env.NODE_ENV !== 'production') {
                    console.debug('[useAoclLayerSteps] fetch failed:', err.message)
                }
            }
        }

        fetchAndBuild()
        if (!isProcessing) return

        const interval = setInterval(fetchAndBuild, pollMs)
        return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [corr, isProcessing, pollMs, turnStart, turnEnd])

    return steps
}

export default useAoclLayerSteps
