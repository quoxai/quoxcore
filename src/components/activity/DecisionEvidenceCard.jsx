/**
 * DecisionEvidenceCard — Renders structured decision evidence from AEE envelope payloads
 *
 * When an envelope payload contains `decision_evidence`, this card displays:
 * - Decision + reason as headline
 * - Inputs and tools as badges
 * - Confidence as a visual bar
 * - Action taken
 * - Context refs (if present, full level)
 */

export default function DecisionEvidenceCard({ evidence }) {
  if (!evidence || !evidence.decision) return null

  const confidencePct = evidence.confidence != null
    ? Math.round(evidence.confidence * 100)
    : null

  const confidenceColor = confidencePct != null
    ? confidencePct >= 80 ? '#22c55e'
      : confidencePct >= 50 ? '#f97316'
      : '#ef4444'
    : null

  return (
    <div className="decision-evidence-card" style={{
      margin: '8px 0 4px',
      padding: '10px 12px',
      background: 'rgba(217, 119, 6, 0.08)',
      border: '1px solid rgba(217, 119, 6, 0.2)',
      borderRadius: '6px',
      fontSize: '0.82rem',
      lineHeight: 1.5
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
        <span style={{ color: '#d97706', fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.03em' }}>
          &#9878; DECISION EVIDENCE
        </span>
        {confidencePct != null && (
          <span style={{
            marginLeft: 'auto',
            fontSize: '0.72rem',
            color: confidenceColor,
            fontWeight: 600
          }}>
            {confidencePct}% confidence
          </span>
        )}
      </div>

      {/* Decision */}
      <div style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 500, marginBottom: '4px' }}>
        {evidence.decision}
      </div>

      {/* Reason summary */}
      {evidence.reason_summary && (
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.78rem', marginBottom: '6px' }}>
          {evidence.reason_summary}
        </div>
      )}

      {/* Action taken */}
      {evidence.action_taken && (
        <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.78rem', marginBottom: '6px' }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', marginRight: '4px' }}>Action:</span>
          {evidence.action_taken}
        </div>
      )}

      {/* Confidence bar */}
      {confidencePct != null && (
        <div style={{
          height: '3px',
          background: 'rgba(255,255,255,0.08)',
          borderRadius: '2px',
          marginBottom: '6px',
          overflow: 'hidden'
        }}>
          <div style={{
            width: `${confidencePct}%`,
            height: '100%',
            background: confidenceColor,
            borderRadius: '2px',
            transition: 'width 0.3s ease'
          }} />
        </div>
      )}

      {/* Inputs + Tools badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {(evidence.inputs_used || []).map((input, i) => (
          <span key={`in-${i}`} style={{
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: '0.7rem',
            borderRadius: '3px',
            background: 'rgba(56, 189, 248, 0.12)',
            color: 'rgba(56, 189, 248, 0.85)',
            border: '1px solid rgba(56, 189, 248, 0.15)'
          }}>
            {input}
          </span>
        ))}
        {(evidence.tools_used || []).map((tool, i) => (
          <span key={`tool-${i}`} style={{
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: '0.7rem',
            borderRadius: '3px',
            background: 'rgba(34, 197, 94, 0.12)',
            color: 'rgba(34, 197, 94, 0.85)',
            border: '1px solid rgba(34, 197, 94, 0.15)'
          }}>
            {tool}
          </span>
        ))}
      </div>

      {/* Context refs (full level only) */}
      {evidence.context_refs && evidence.context_refs.length > 0 && (
        <div style={{ marginTop: '6px', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>
          Refs: {evidence.context_refs.join(', ')}
        </div>
      )}
    </div>
  )
}
