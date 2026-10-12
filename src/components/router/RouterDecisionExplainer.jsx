/**
 * RouterDecisionExplainer - In-chat routing decision display
 *
 * Shows why a response was routed by the Smart Router,
 * including pattern matched, confidence score, and layer.
 * Provides actions to report incorrect routing or ask Claude instead.
 */

import { useState } from 'react'
import { logEscalation } from '../../services/quoxRouter'
import './router.css'

/**
 * RouterDecisionExplainer Component
 *
 * @param {Object} props
 * @param {string} props.pattern - The pattern that matched
 * @param {number} props.confidence - Confidence score (0-1)
 * @param {string} props.layer - Classification layer (regex/semantic)
 * @param {string} props.matchedText - The text that matched
 * @param {string} props.query - The original query
 * @param {Function} props.onAskClaude - Handler for "Ask Claude" action
 * @param {Function} props.onReportIncorrect - Handler for reporting incorrect routing
 * @param {boolean} props.expanded - Whether details are expanded by default
 * @param {boolean} props.compact - Compact mode for minimal display
 */
export function RouterDecisionExplainer({
  pattern,
  confidence,
  layer = 'regex',
  matchedText,
  query,
  onAskClaude,
  onReportIncorrect,
  expanded: defaultExpanded = false,
  compact = false
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [reported, setReported] = useState(false)

  const confidencePercent = Math.round((confidence || 0) * 100)
  const confidenceLevel = confidence >= 0.9 ? 'high' : confidence >= 0.7 ? 'medium' : 'low'

  const handleAskClaude = () => {
    // Log the escalation for telemetry
    if (query && pattern) {
      logEscalation(query, pattern)
    }
    onAskClaude?.()
  }

  const handleReportIncorrect = () => {
    setReported(true)
    // Log as escalation for telemetry tracking
    if (query && pattern) {
      logEscalation(query, pattern)
    }
    onReportIncorrect?.()
  }

  if (compact) {
    return (
      <div className="router-decision-explainer router-decision-explainer--compact">
        <span className="router-decision-explainer-badge">
          Routed via Smart Router
        </span>
        <button
          className="router-decision-explainer-btn"
          onClick={() => setExpanded(!expanded)}
          title="Show routing details"
        >
          {expanded ? 'Hide' : 'Details'}
        </button>
        {expanded && (
          <div className="router-decision-explainer-inline">
            <span>{pattern?.replace(/_/g, ' ')} ({confidencePercent}%)</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="router-decision-explainer">
      <div className="router-decision-explainer-header">
        <span className="router-decision-explainer-badge">
          Routed via Smart Router
        </span>
        <div className="router-decision-explainer-actions">
          <button
            className="router-decision-explainer-btn"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Hide details' : 'Show why this was routed'}
          >
            {expanded ? 'Hide' : 'Why?'}
          </button>
          {onAskClaude && (
            <button
              className="router-decision-explainer-btn"
              onClick={handleAskClaude}
              title="Ask Claude instead"
            >
              Ask Claude
            </button>
          )}
          {onReportIncorrect && !reported && (
            <button
              className="router-decision-explainer-btn router-decision-explainer-btn--report"
              onClick={handleReportIncorrect}
              title="Report this as incorrect routing"
            >
              Report
            </button>
          )}
          {reported && (
            <span className="router-decision-explainer-reported">
              Reported
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="router-decision-explainer-content">
          <div className="router-decision-explainer-item">
            <span className="router-decision-explainer-label">Pattern</span>
            <span className="router-decision-explainer-value">
              {pattern?.replace(/_/g, ' ') || 'unknown'}
            </span>
          </div>
          <div className="router-decision-explainer-item">
            <span className="router-decision-explainer-label">Confidence</span>
            <span className="router-decision-explainer-value">
              <span className="router-decision-explainer-confidence">
                {confidencePercent}%
                <span className="router-decision-explainer-confidence-bar">
                  <span
                    className="router-decision-explainer-confidence-fill"
                    style={{
                      width: `${confidencePercent}%`,
                      background: confidenceLevel === 'high' ? '#22c55e' :
                                  confidenceLevel === 'medium' ? '#f59e0b' : '#ef4444'
                    }}
                  />
                </span>
              </span>
            </span>
          </div>
          <div className="router-decision-explainer-item">
            <span className="router-decision-explainer-label">Layer</span>
            <span className="router-decision-explainer-value">
              {layer === 'regex' ? 'Pattern Match' : 'Semantic'}
            </span>
          </div>
          {matchedText && (
            <div className="router-decision-explainer-item router-decision-explainer-item--full">
              <span className="router-decision-explainer-label">Matched</span>
              <span className="router-decision-explainer-value router-decision-explainer-value--mono">
                "{matchedText}"
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Minimal inline badge for routed responses
 */
export function RouterBadge({ pattern, confidence, onClick }) {
  const confidencePercent = Math.round((confidence || 0) * 100)

  return (
    <span
      className="router-badge"
      onClick={onClick}
      role="button"
      tabIndex={0}
      title={`Routed by Smart Router: ${pattern} (${confidencePercent}% confidence)`}
    >
      <span className="router-badge-icon">&#9889;</span>
      <span className="router-badge-text">Routed</span>
    </span>
  )
}

export default RouterDecisionExplainer
