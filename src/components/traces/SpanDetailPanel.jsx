/**
 * TRV-3: SpanDetailPanel — right drawer showing full layer details
 * Decisions, context delta, delegations, VOLT events, raw payload
 */

import { GlassPanel, GlassPill, M, F, COLORS, PROTOCOL_COLORS } from '../compliance/glass-primitives'

export default function SpanDetailPanel({ layer, trace, mode = 'compliance', onClose }) {
  if (!layer) return null

  return (
    <div style={{
      width: 340,
      minHeight: 0,
      overflow: 'auto',
      borderLeft: '1px solid rgba(255,255,255,0.06)',
      padding: 16,
      background: 'rgba(0,0,0,0.2)',
      animation: 'slideInRight 0.2s ease',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <GlassPill color={outcomeColor(layer.outcome)} style={{ fontSize: 10 }}>
          {layer.layer_id}
        </GlassPill>
        <span style={{ fontFamily: F, fontSize: 13, color: COLORS.white, flex: 1 }}>
          {layer.layer_label}
        </span>
        <span style={{ fontFamily: M, fontSize: 11, color: COLORS.cyan }}>
          {formatDuration(layer.duration_ms)}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: COLORS.dimText, fontSize: 16, padding: '2px 6px',
          }}
        >
          x
        </button>
      </div>

      {/* Status */}
      <Section title="Status">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <GlassPill color={outcomeColor(layer.outcome)}>{layer.outcome?.toUpperCase()}</GlassPill>
          <GlassPill color={COLORS.dimText}>{layer.status}</GlassPill>
        </div>
      </Section>

      {/* Decisions */}
      {layer.decisions?.length > 0 && (
        <Section title="Decisions">
          {layer.decisions.map((d, i) => (
            <div key={i} style={{
              padding: '6px 10px', borderRadius: 6, marginBottom: 4,
              background: d.code === 'ALLOW' ? `${COLORS.green}0D` : `${COLORS.red}0D`,
              border: `1px solid ${d.code === 'ALLOW' ? COLORS.green : COLORS.red}20`,
            }}>
              <div style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: d.code === 'ALLOW' ? COLORS.green : COLORS.red }}>
                {d.code}
              </div>
              {d.reason && (
                <div style={{ fontFamily: F, fontSize: 11, color: COLORS.dimText, marginTop: 2 }}>
                  {d.reason}
                </div>
              )}
              {d.confidence !== null && d.confidence !== undefined && (
                <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 2 }}>
                  Confidence: {(d.confidence * 100).toFixed(0)}%
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* Matched Policies (L3) */}
      {layer.matched_policies?.length > 0 && (
        <Section title="Matched Policies">
          {layer.matched_policies.map((p, i) => (
            <GlassPill key={i} color={COLORS.purple} style={{ marginRight: 4, marginBottom: 4 }}>
              {p}
            </GlassPill>
          ))}
        </Section>
      )}

      {/* Timing detail */}
      <Section title="Timing">
        <Row label="Started" value={`+${layer.started_ms}ms`} />
        <Row label="Duration" value={formatDuration(layer.duration_ms)} />
        <Row label="Ended" value={`+${layer.ended_ms}ms`} />
      </Section>

      {/* VOLT Events */}
      {layer.volt_event_ids?.length > 0 && (
        <Section title="VOLT Events">
          {layer.volt_event_ids.map((id, i) => (
            <div key={i} style={{ fontFamily: M, fontSize: 9, color: COLORS.dimText }}>
              {id}
            </div>
          ))}
        </Section>
      )}

      {/* Context Delta */}
      {layer.context_delta?.length > 0 && (
        <Section title="Context Changes">
          {layer.context_delta.map((c, i) => (
            <div key={i} style={{
              padding: '4px 8px', borderRadius: 4, marginBottom: 3,
              background: 'rgba(255,255,255,0.02)',
              fontFamily: M, fontSize: 10,
            }}>
              <span style={{ color: COLORS.cyan }}>{c.partition}</span>
              <span style={{ color: COLORS.dimText }}>.{c.key}: </span>
              {c.redacted ? (
                <span style={{ color: COLORS.amber }}>[REDACTED]</span>
              ) : (
                <>
                  <span style={{ color: COLORS.red }}>{JSON.stringify(c.before)}</span>
                  <span style={{ color: COLORS.dimText }}> → </span>
                  <span style={{ color: COLORS.green }}>{JSON.stringify(c.after)}</span>
                </>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* Raw Payload (engineer mode only) */}
      {mode === 'engineer' && layer.raw_payload && (
        <Section title="Raw Payload">
          <pre style={{
            fontFamily: M, fontSize: 9, color: COLORS.dimText,
            background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: 10,
            overflow: 'auto', maxHeight: 300,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {JSON.stringify(layer.raw_payload, null, 2)}
          </pre>
        </Section>
      )}
    </div>
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

function Row({ label, value }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      fontFamily: M, fontSize: 10, padding: '2px 0',
    }}>
      <span style={{ color: COLORS.subtleText }}>{label}</span>
      <span style={{ color: COLORS.white }}>{value}</span>
    </div>
  )
}

function outcomeColor(outcome) {
  const map = {
    allow: COLORS.green, deny: COLORS.red, hitl: COLORS.amber,
    bypass: COLORS.dimText, halt: COLORS.red, complete: COLORS.cyan,
  }
  return map[outcome] || COLORS.dimText
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
