/**
 * DecisionComparison - Routing and policy decision comparison
 *
 * Shows differences in decision paths across traces.
 * Part of AOCL Compliance Suite.
 */

import './comparison.css'

export default function DecisionComparison({ data, traces }) {
  if (!data) return null

  const { routing, policy, differences } = data

  return (
    <div className="decision-comparison">
      {/* Differences Alert */}
      {differences.length > 0 && (
        <div className="decision-differences-alert">
          <h4>Decision Differences Detected</h4>
          <div className="decision-differences-list">
            {differences.map((diff, idx) => (
              <div key={idx} className="decision-difference-item">
                <span className="decision-diff-type">{diff.type}</span>
                <span className="decision-diff-desc">{diff.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Routing Decisions (L2) */}
      <div className="decision-section">
        <h4>Routing Decisions (L2 - Smart Router)</h4>
        <div className="decision-table">
          <div className="decision-table-header">
            <span>Trace</span>
            <span>Handled</span>
            <span>Pattern</span>
            <span>Confidence</span>
            <span>Reason</span>
          </div>
          {routing.map((r, idx) => (
            <div key={r.corr} className={`decision-table-row ${r.handled ? 'handled' : 'bypassed'}`}>
              <span className="decision-trace-num">#{idx + 1}</span>
              <span className={`decision-handled ${r.handled ? 'yes' : 'no'}`}>
                {r.handled ? 'Yes' : 'No'}
              </span>
              <span className="decision-pattern">
                {r.pattern || '-'}
              </span>
              <span className="decision-confidence">
                {r.confidence ? `${(r.confidence * 100).toFixed(0)}%` : '-'}
              </span>
              <span className="decision-reason">{r.reason}</span>
            </div>
          ))}
        </div>

        {/* Visual Comparison */}
        <div className="decision-visual">
          {routing.map((r, idx) => (
            <div key={r.corr} className="decision-visual-item">
              <span className="decision-visual-label">Trace {idx + 1}</span>
              <div className={`decision-visual-box ${r.handled ? 'handled' : 'bypassed'}`}>
                {r.handled ? (
                  <>
                    <span className="decision-visual-icon">→</span>
                    <span>Smart Router handled</span>
                    <span className="decision-visual-pattern">{r.pattern}</span>
                  </>
                ) : (
                  <>
                    <span className="decision-visual-icon">↓</span>
                    <span>Bypassed to LLM</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Policy Decisions (L3) */}
      <div className="decision-section">
        <h4>Policy Decisions (L3 - Policy Gate)</h4>
        <div className="decision-table">
          <div className="decision-table-header">
            <span>Trace</span>
            <span>Allowed</span>
            <span>Reason</span>
            <span>Checks</span>
          </div>
          {policy.map((p, idx) => (
            <div key={p.corr} className={`decision-table-row ${p.allowed ? 'allowed' : 'rejected'}`}>
              <span className="decision-trace-num">#{idx + 1}</span>
              <span className={`decision-allowed ${p.allowed ? 'yes' : 'no'}`}>
                {p.allowed ? 'Allowed' : 'Rejected'}
              </span>
              <span className="decision-reason">{p.reason}</span>
              <span className="decision-checks">
                {p.checks.length > 0 ? p.checks.join(', ') : '-'}
              </span>
            </div>
          ))}
        </div>

        {/* Visual Comparison */}
        <div className="decision-visual">
          {policy.map((p, idx) => (
            <div key={p.corr} className="decision-visual-item">
              <span className="decision-visual-label">Trace {idx + 1}</span>
              <div className={`decision-visual-box ${p.allowed ? 'allowed' : 'rejected'}`}>
                {p.allowed ? (
                  <>
                    <span className="decision-visual-icon">✓</span>
                    <span>Policy passed</span>
                  </>
                ) : (
                  <>
                    <span className="decision-visual-icon">✗</span>
                    <span>Policy rejected</span>
                    <span className="decision-visual-reason">{p.reason}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Decision Path Summary */}
      <div className="decision-path-summary">
        <h4>Decision Path Comparison</h4>
        <div className="decision-paths">
          {traces.map((trace, idx) => {
            const r = routing[idx]
            const p = policy[idx]

            return (
              <div key={trace.corr} className="decision-path">
                <span className="decision-path-label">Trace {idx + 1}</span>
                <div className="decision-path-flow">
                  <span className="decision-path-node start">Query</span>
                  <span className="decision-path-arrow">→</span>
                  <span className={`decision-path-node ${r?.handled ? 'handled' : 'bypassed'}`}>
                    L2: {r?.handled ? 'Handled' : 'Bypass'}
                  </span>
                  <span className="decision-path-arrow">→</span>
                  <span className={`decision-path-node ${p?.allowed ? 'allowed' : 'rejected'}`}>
                    L3: {p?.allowed ? 'Pass' : 'Reject'}
                  </span>
                  <span className="decision-path-arrow">→</span>
                  <span className="decision-path-node end">
                    {r?.handled ? 'Direct Response' : 'LLM'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
