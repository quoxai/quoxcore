/**
 * CostComparison - Token usage and cost comparison
 *
 * Shows token usage across traces.
 * Part of AOCL Compliance Suite.
 */

import './comparison.css'

export default function CostComparison({ data, traces }) {
  if (!data) return null

  const { traces: costTraces, summary } = data

  // Get max for scaling
  const maxTokens = Math.max(...costTraces.map(t => t.totalTokens), 1)

  return (
    <div className="cost-comparison">
      {/* Summary */}
      <div className="cost-summary">
        <div className="cost-summary-card">
          <span className="cost-summary-value">{summary.avgTokens}</span>
          <span className="cost-summary-label">Avg Tokens</span>
        </div>
        <div className="cost-summary-card">
          <span className="cost-summary-value">{summary.minTokens}</span>
          <span className="cost-summary-label">Min Tokens</span>
        </div>
        <div className="cost-summary-card">
          <span className="cost-summary-value">{summary.maxTokens}</span>
          <span className="cost-summary-label">Max Tokens</span>
        </div>
        <div className="cost-summary-card">
          <span className="cost-summary-value">{summary.tokenSpread}</span>
          <span className="cost-summary-label">Spread</span>
        </div>
      </div>

      {/* Token Bars */}
      <div className="cost-bars">
        <h4>Token Usage by Trace</h4>
        {costTraces.map((t, idx) => (
          <div key={t.corr} className="cost-bar-row">
            <span className="cost-bar-label">Trace {idx + 1}</span>
            <div className="cost-bar-container">
              <div className="cost-bar-stack">
                <div
                  className="cost-bar input"
                  style={{
                    width: `${(t.inputTokens / maxTokens) * 100}%`
                  }}
                  title={`Input: ${t.inputTokens}`}
                />
                <div
                  className="cost-bar output"
                  style={{
                    width: `${(t.outputTokens / maxTokens) * 100}%`
                  }}
                  title={`Output: ${t.outputTokens}`}
                />
              </div>
              <span className="cost-bar-value">{t.totalTokens} tokens</span>
            </div>
          </div>
        ))}
      </div>

      {/* Detailed Table */}
      <div className="cost-table">
        <h4>Detailed Breakdown</h4>
        <div className="cost-table-header">
          <span>Trace</span>
          <span>Model</span>
          <span>Input Tokens</span>
          <span>Output Tokens</span>
          <span>Total</span>
        </div>
        {costTraces.map((t, idx) => (
          <div key={t.corr} className="cost-table-row">
            <span className="cost-trace-num">#{idx + 1}</span>
            <span className="cost-model">{t.model}</span>
            <span className="cost-tokens input">{t.inputTokens}</span>
            <span className="cost-tokens output">{t.outputTokens}</span>
            <span className="cost-tokens total">{t.totalTokens}</span>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="cost-legend">
        <div className="cost-legend-item">
          <span className="cost-legend-color input" />
          <span>Input Tokens</span>
        </div>
        <div className="cost-legend-item">
          <span className="cost-legend-color output" />
          <span>Output Tokens</span>
        </div>
      </div>

      {/* Cost Estimation Note */}
      <div className="cost-note">
        <p>
          Token counts are based on recorded usage data. Actual costs depend on
          your API pricing tier and model selection.
        </p>
      </div>
    </div>
  )
}
