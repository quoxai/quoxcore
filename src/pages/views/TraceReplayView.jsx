/**
 * TRV-5: TraceReplayView — /traces/:runId/replay page
 * Step-through replay with optional What-If simulation panel.
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { TraceWaterfall } from '../../components/traces'
import TraceReplayController from '../../components/traces/TraceReplayController'
import WhatIfPanel from '../../components/traces/WhatIfPanel'
import { GlassPanel, GlassSkeleton, GlassError, GlassPill, M, F, COLORS } from '../../components/compliance/glass-primitives'

export default function TraceReplayView() {
  const { runId } = useParams()
  const [trace, setTrace] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Replay state
  const [currentStep, setCurrentStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [showWhatIf, setShowWhatIf] = useState(false)

  useEffect(() => {
    if (!runId) return
    setLoading(true)
    fetch(`/collector/traces/${encodeURIComponent(runId)}?include_raw=true`)
      .then(r => {
        if (!r.ok) throw new Error(`Trace not found (${r.status})`)
        return r.json()
      })
      .then(data => { setTrace(data); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [runId])

  const handlePlayPause = useCallback(() => {
    setPlaying(p => !p)
  }, [])

  const handleSimulate = useCallback(async (modifications) => {
    const res = await fetch(`/collector/traces/${encodeURIComponent(runId)}/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modifications),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Simulation failed')
    }
    return res.json()
  }, [runId])

  return (
    <div style={{ padding: 20, maxWidth: 1400 }}>
      {/* Breadcrumb */}
      <div style={{
        fontFamily: F, fontSize: 13, color: COLORS.dimText,
        marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Link to="/traces" style={{ color: COLORS.cyan, textDecoration: 'none' }}>Traces</Link>
        <span style={{ color: COLORS.subtleText }}>/</span>
        <Link to={`/traces/${runId}`} style={{ color: COLORS.cyan, textDecoration: 'none', fontFamily: M, fontSize: 12 }}>
          {runId?.slice(0, 25)}
        </Link>
        <span style={{ color: COLORS.subtleText }}>/</span>
        <span style={{ color: COLORS.white }}>Replay</span>
      </div>

      {loading && <GlassSkeleton height={400} />}
      {error && <GlassError message={error} onRetry={() => window.location.reload()} />}

      {trace && (
        <div style={{ display: 'flex', gap: 16 }}>
          {/* Main column: controller + waterfall */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Replay controller */}
            <div style={{ marginBottom: 12 }}>
              <TraceReplayController
                trace={trace}
                currentStep={currentStep}
                onStepChange={setCurrentStep}
                playing={playing}
                onPlayPause={handlePlayPause}
                playbackSpeed={playbackSpeed}
                onSpeedChange={setPlaybackSpeed}
              />
            </div>

            {/* What-If toggle */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                onClick={() => setShowWhatIf(s => !s)}
                style={{
                  background: showWhatIf ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${showWhatIf ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 6, padding: '6px 14px',
                  fontFamily: M, fontSize: 11,
                  color: showWhatIf ? COLORS.amber : COLORS.dimText,
                  cursor: 'pointer',
                }}
              >
                {showWhatIf ? 'Hide What-If' : 'What-If...'}
              </button>
            </div>

            {/* Narration — what this layer did */}
            {trace.layers[currentStep] && (
              <div style={{
                padding: '10px 14px', marginBottom: 12, borderRadius: 8,
                background: 'rgba(168,85,247,0.06)',
                border: '1px solid rgba(168,85,247,0.15)',
              }}>
                <div style={{ fontFamily: F, fontSize: 12, color: COLORS.white, marginBottom: 2 }}>
                  <strong>{trace.layers[currentStep].layer_label}</strong>
                  {' '}
                  <span style={{ color: COLORS.subtleText }}>({trace.layers[currentStep].layer_id})</span>
                </div>
                <div style={{ fontFamily: F, fontSize: 11, color: COLORS.dimText, lineHeight: 1.5 }}>
                  {describeLayer(trace.layers[currentStep])}
                </div>
              </div>
            )}

            {/* Waterfall with step highlight + auto-open current step's detail */}
            <TraceWaterfall
              trace={trace}
              highlightStep={trace.layers[currentStep]?.layer_number ?? null}
              selectedLayerId={trace.layers[currentStep]?.layer_id}
              onSelectLayer={() => {}}
            />
          </div>

          {/* What-If panel (right side) */}
          {showWhatIf && (
            <div style={{ width: 380, flexShrink: 0 }}>
              <WhatIfPanel
                trace={trace}
                onSimulate={handleSimulate}
                onClose={() => setShowWhatIf(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Human-readable description of what a layer did during this trace.
 */
function describeLayer(layer) {
  if (!layer) return ''

  const rp = layer.raw_payload || {}
  const summary = layer.layer_summary?.text || ''

  switch (layer.layer_id) {
    case 'L0':
      return `Normalised the query (${rp.queryLength || '?'} chars). ` +
        `Selected ${rp.model || 'model'} via ${rp.provider || 'provider'} (${rp.selectionMode || 'auto'} mode). ` +
        `Capability: ${rp.capabilityLabel || rp.capability || 'general'}.`
    case 'L1':
      return `Identity and scope verification. ${rp.scope || 'Default scope applied.'}`
    case 'L2':
      if (rp.handled) {
        return `Smart Router matched this query. Delegated to ${rp.delegatedTo || 'specialist'} agent ` +
          `(score: ${rp.delegationScore || '?'}, reason: ${rp.reason || 'pattern match'}).`
      }
      return `Smart Router found no pattern match. Query continues through the full pipeline.`
    case 'L3': {
      const checks = rp.checksRun || 0
      const warnings = rp.warningCount || 0
      const matched = (rp.matchedPolicies || []).length
      if (layer.outcome === 'deny') {
        return `Policy gate DENIED this request. Reason: ${rp.reason || 'policy violation'}. ` +
          `${checks} checks evaluated, ${matched} policies matched.`
      }
      return `Policy gate passed. ${checks} checks evaluated, ${warnings} warnings, ${matched} policies matched. ` +
        `Request is allowed to proceed.`
    }
    case 'L4':
      return `Decomposed the query into execution plan. ${rp.steps || ''}`
    case 'L5': {
      const items = rp.memoryItemCount || 0
      return `Retrieved ${items} memory items. ` +
        `${rp.hasQuoxContext ? 'QuoxContext injected. ' : ''}` +
        `${rp.hasDynamicContext ? 'Dynamic context added. ' : ''}` +
        `This context is now available to the model.`
    }
    case 'L6': {
      const len = rp.systemPromptLength || 0
      return `Shaped the system prompt (${len} chars). ` +
        `${rp.contextInjected ? 'Memory and context were injected into the prompt.' : 'No additional context injected.'}`
    }
    case 'L7': {
      const model = rp.model || 'unknown model'
      const cost = rp.cost_usd != null ? `$${rp.cost_usd.toFixed(4)}` : 'unknown cost'
      const dur = layer.duration_ms ? `${(layer.duration_ms / 1000).toFixed(1)}s` : '?'
      return `Executed via ${model} (${rp.provider || 'provider'}). ` +
        `Took ${dur}, cost ${cost}. ` +
        `${rp.toolsUsed ? `Used ${rp.toolsUsed} tools. ` : ''}` +
        `${rp.success === false ? 'Execution FAILED.' : 'Completed successfully.'}`
    }
    case 'L8': {
      const checks = rp.checksRun || 0
      const warnings = rp.warningCount || 0
      const formats = (rp.formats || []).join(', ') || 'text'
      return `Verified the response. ${checks} checks run, ${warnings} warnings. ` +
        `Format: ${formats}. Response length: ${rp.responseLength || '?'} chars.`
    }
    case 'L9': {
      return `Assembled the final response (${rp.responseLength || '?'} chars) and delivered to the user.`
    }
    case 'L10':
      return `Wrote audit trail to the evidence store.`
    default:
      return summary || `Layer ${layer.layer_id} completed.`
  }
}
