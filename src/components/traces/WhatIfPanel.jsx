/**
 * TRV-5: WhatIfPanel — policy override simulation
 *
 * Lets users toggle policy decisions, enable/disable layers, modify queries,
 * then simulate the projected trace outcome.
 */

import { useState } from 'react'
import { GlassPanel, GlassPill, M, F, COLORS } from '../compliance/glass-primitives'

export default function WhatIfPanel({ trace, onSimulate, onClose }) {
  const [modifications, setModifications] = useState({
    policy_overrides: {},
    layer_toggles: {},
    query_override: null,
  })
  const [simulating, setSimulating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  if (!trace) return null

  // Find layers with decisions (policy-relevant)
  const policyLayers = trace.layers.filter(l => l.decisions?.length > 0)
  const allLayers = trace.layers

  // Determine if modifications touch L7+
  const touchesL7 = Object.entries(modifications.layer_toggles).some(
    ([id, enabled]) => !enabled && parseInt(id.replace('L', '')) >= 7
  ) || Object.keys(modifications.policy_overrides).some(
    id => parseInt(id.replace('L', '')) >= 7
  )

  const handleSimulate = async () => {
    setSimulating(true)
    setError(null)
    try {
      const res = await onSimulate(modifications)
      setResult(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setSimulating(false)
    }
  }

  const hasModifications = Object.keys(modifications.policy_overrides).length > 0 ||
    Object.keys(modifications.layer_toggles).length > 0 ||
    modifications.query_override

  return (
    <GlassPanel highlight={COLORS.amber} style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ fontFamily: F, fontSize: 14, fontWeight: 600, color: COLORS.white }}>
          What if...
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: COLORS.dimText, cursor: 'pointer', fontSize: 14,
        }}>x</button>
      </div>

      {/* Policy Overrides */}
      {policyLayers.length > 0 && (
        <Section title="Policy Decisions">
          <p style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, margin: '0 0 8px' }}>
            Toggle decisions to see projected impact.
          </p>
          {policyLayers.map(layer => (
            <div key={layer.layer_id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 6, marginBottom: 4,
              background: 'rgba(255,255,255,0.02)',
            }}>
              <GlassPill color={COLORS.purple} style={{ fontSize: 8 }}>{layer.layer_id}</GlassPill>
              <span style={{ fontFamily: F, fontSize: 11, color: COLORS.white, flex: 1 }}>
                {layer.layer_label}
              </span>
              {/* Current outcome */}
              <GlassPill
                color={layer.outcome === 'allow' ? COLORS.green : COLORS.red}
                style={{ fontSize: 8, opacity: modifications.policy_overrides[layer.layer_id] ? 0.4 : 1 }}
              >
                {layer.outcome?.toUpperCase()}
              </GlassPill>
              {/* Override toggle */}
              <button
                onClick={() => {
                  const current = modifications.policy_overrides[layer.layer_id]
                  const newOverrides = { ...modifications.policy_overrides }
                  if (current) {
                    delete newOverrides[layer.layer_id]
                  } else {
                    newOverrides[layer.layer_id] = {
                      action: layer.outcome === 'allow' ? 'deny' : 'allow'
                    }
                  }
                  setModifications(m => ({ ...m, policy_overrides: newOverrides }))
                  setResult(null) // Clear previous result
                }}
                style={{
                  background: modifications.policy_overrides[layer.layer_id]
                    ? `${COLORS.amber}20` : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${modifications.policy_overrides[layer.layer_id]
                    ? COLORS.amber + '60' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 4, padding: '2px 8px',
                  fontFamily: M, fontSize: 9, cursor: 'pointer',
                  color: modifications.policy_overrides[layer.layer_id]
                    ? COLORS.amber : COLORS.dimText,
                }}
              >
                {modifications.policy_overrides[layer.layer_id]
                  ? `→ ${modifications.policy_overrides[layer.layer_id].action.toUpperCase()}`
                  : 'Override'}
              </button>
            </div>
          ))}
        </Section>
      )}

      {/* Layer Toggles */}
      <Section title="Layer Toggles">
        <p style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, margin: '0 0 8px' }}>
          Disable layers to simulate bypass.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {allLayers.map(layer => {
            const disabled = modifications.layer_toggles[layer.layer_id] === false
            return (
              <button
                key={layer.layer_id}
                onClick={() => {
                  const newToggles = { ...modifications.layer_toggles }
                  if (disabled) {
                    delete newToggles[layer.layer_id]
                  } else {
                    newToggles[layer.layer_id] = false
                  }
                  setModifications(m => ({ ...m, layer_toggles: newToggles }))
                  setResult(null)
                }}
                style={{
                  background: disabled ? `${COLORS.red}15` : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${disabled ? COLORS.red + '40' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 4, padding: '3px 8px',
                  fontFamily: M, fontSize: 9, cursor: 'pointer',
                  color: disabled ? COLORS.red : COLORS.dimText,
                  textDecoration: disabled ? 'line-through' : 'none',
                }}
              >
                {layer.layer_id}
              </button>
            )
          })}
        </div>
      </Section>

      {/* Query Override */}
      <Section title="Query Override">
        <textarea
          placeholder={trace.query || 'Original query...'}
          value={modifications.query_override || ''}
          onChange={e => {
            setModifications(m => ({ ...m, query_override: e.target.value || null }))
            setResult(null)
          }}
          style={{
            width: '100%', boxSizing: 'border-box', minHeight: 60,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6, padding: 8,
            fontFamily: F, fontSize: 11, color: COLORS.white,
            resize: 'vertical', outline: 'none',
          }}
        />
      </Section>

      {/* Simulation boundary warning */}
      {touchesL7 && (
        <GlassPill color={COLORS.amber} style={{ fontSize: 9, marginBottom: 12, display: 'block', textAlign: 'center' }}>
          Simulation boundary: LLM response is non-deterministic. Results from L7 onwards are illustrative projections.
        </GlassPill>
      )}

      {/* Simulate button */}
      <button
        onClick={handleSimulate}
        disabled={!hasModifications || simulating}
        style={{
          width: '100%', padding: '10px 16px',
          background: hasModifications ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.03)',
          border: `1px solid ${hasModifications ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: 8,
          fontFamily: M, fontSize: 12, fontWeight: 600,
          color: hasModifications ? COLORS.purple : COLORS.subtleText,
          cursor: hasModifications && !simulating ? 'pointer' : 'default',
          opacity: simulating ? 0.6 : 1,
        }}
      >
        {simulating ? 'Simulating...' : 'Simulate'}
      </button>

      {/* Error */}
      {error && (
        <div style={{
          marginTop: 8, padding: '6px 10px', borderRadius: 6,
          background: `${COLORS.red}10`, border: `1px solid ${COLORS.red}30`,
          fontFamily: F, fontSize: 11, color: COLORS.red,
        }}>
          {error}
        </div>
      )}

      {/* Simulation Results */}
      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, color: COLORS.white, marginBottom: 8 }}>
            Simulation Result
          </div>

          {/* Confidence indicator */}
          <GlassPill
            color={result.confidence === 'high' ? COLORS.green : result.confidence === 'medium' ? COLORS.amber : COLORS.dimText}
            style={{ fontSize: 9, marginBottom: 8 }}
          >
            Confidence: {result.confidence || 'illustrative'}
          </GlassPill>

          {/* Diff summary */}
          {result.diffs?.length > 0 && (
            <div style={{
              padding: 8, borderRadius: 6, background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              {result.diffs.map((diff, i) => (
                <div key={i} style={{
                  fontFamily: M, fontSize: 10, color: COLORS.dimText,
                  padding: '2px 0',
                }}>
                  <span style={{ color: COLORS.cyan }}>{diff.layer_id}</span>
                  {': '}
                  <span style={{ color: COLORS.red }}>{diff.original_outcome}</span>
                  {' → '}
                  <span style={{ color: COLORS.green }}>{diff.simulated_outcome}</span>
                </div>
              ))}
            </div>
          )}

          {/* Projected outcome */}
          <div style={{
            marginTop: 8, fontFamily: M, fontSize: 11,
            color: result.simulated?.outcome === 'complete' ? COLORS.green :
              result.simulated?.outcome === 'policy_deny' ? COLORS.red : COLORS.amber,
          }}>
            Projected outcome: {result.simulated?.outcome?.toUpperCase() || 'UNKNOWN'}
          </div>
        </div>
      )}
    </GlassPanel>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontFamily: F, fontSize: 10, fontWeight: 600,
        color: COLORS.subtleText, textTransform: 'uppercase',
        letterSpacing: '0.05em', marginBottom: 6,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}
