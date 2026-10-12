import { useState, useEffect } from 'react'
import { getSuggestions, dismissSuggestion, getRequestStats } from '../../services/patternDetector'
import './intelligence.css'

/**
 * AutomationSuggestions - Shows patterns detected and suggests automation
 */
export function AutomationSuggestions({ compact = false }) {
  const [suggestions, setSuggestions] = useState([])
  const [stats, setStats] = useState(null)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    const loadData = () => {
      setSuggestions(getSuggestions())
      setStats(getRequestStats())
    }
    loadData()

    // Refresh periodically
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleDismiss = (id) => {
    dismissSuggestion(id)
    setSuggestions(getSuggestions())
  }

  if (suggestions.length === 0) {
    if (compact) return null
    return (
      <div className="automation-empty">
        <p>No automation suggestions yet</p>
        <span>Patterns will be detected as you use QuoxCORE</span>
      </div>
    )
  }

  if (compact) {
    return (
      <div className="automation-compact">
        <div className="automation-badge" title={`${suggestions.length} automation opportunities detected`}>
          <span className="automation-icon">⚡</span>
          <span className="automation-count">{suggestions.length}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="automation-suggestions">
      <div className="automation-header">
        <h3>
          <span className="automation-icon">⚡</span>
          Automation Opportunities
        </h3>
        {stats && (
          <div className="automation-stats">
            <span>{stats.total} requests tracked</span>
            <span>${stats.totalCost.toFixed(2)} spent</span>
          </div>
        )}
      </div>

      <div className="automation-list">
        {suggestions.map(suggestion => (
          <div
            key={suggestion.id}
            className={`automation-item ${expanded === suggestion.id ? 'expanded' : ''}`}
          >
            <div
              className="automation-item-header"
              onClick={() => setExpanded(expanded === suggestion.id ? null : suggestion.id)}
            >
              <div className="automation-item-main">
                <span className="automation-item-title">{suggestion.suggestion.title}</span>
                <span className="automation-item-pattern">"{suggestion.pattern}"</span>
              </div>
              <div className="automation-item-meta">
                <span className="automation-occurrences">{suggestion.occurrences}x</span>
                <span className="automation-savings">
                  Save ~${suggestion.potentialSavings.toFixed(2)}
                </span>
                <button
                  className="automation-dismiss"
                  onClick={(e) => { e.stopPropagation(); handleDismiss(suggestion.id) }}
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>

            {expanded === suggestion.id && (
              <div className="automation-item-details">
                <p className="automation-description">{suggestion.suggestion.description}</p>

                {suggestion.suggestion.workflow && (
                  <div className="automation-workflow">
                    <h4>Suggested Workflow</h4>
                    <pre>{suggestion.suggestion.workflow}</pre>
                  </div>
                )}

                {suggestion.suggestion.script && (
                  <div className="automation-script">
                    <h4>Quick Script</h4>
                    <pre>{suggestion.suggestion.script}</pre>
                    <button
                      className="automation-copy"
                      onClick={() => navigator.clipboard.writeText(suggestion.suggestion.script)}
                    >
                      Copy Script
                    </button>
                  </div>
                )}

                <div className="automation-actions">
                  <button className="automation-create">
                    Create Workflow
                  </button>
                  <button
                    className="automation-later"
                    onClick={() => handleDismiss(suggestion.id)}
                  >
                    Maybe Later
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default AutomationSuggestions
