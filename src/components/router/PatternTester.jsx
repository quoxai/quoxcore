/**
 * PatternTester - Smart Router Pattern Testing Sandbox
 *
 * Allows testing queries against router patterns without executing them.
 * Shows which patterns match, confidence scores, and routing decision.
 *
 * Part of the Smart Router visibility enhancement initiative.
 */

import { useState, useCallback } from 'react'
import { canRouteQueryAsync, getPatterns } from '../../services/quoxRouter'
import { getRouterConfig } from '../../services/routerConfig'
import './router.css'

/**
 * PatternTester Component
 *
 * @param {Object} props
 * @param {boolean} props.embedded - If true, uses compact styling
 */
export function PatternTester({ embedded = false }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState([])

  const handleTest = useCallback(async () => {
    if (!query.trim()) return

    setLoading(true)
    try {
      // Get the routing decision
      const routeResult = await canRouteQueryAsync(query.trim())
      const config = getRouterConfig()

      const testResult = {
        query: query.trim(),
        timestamp: Date.now(),
        ...routeResult,
        thresholds: config.thresholds
      }

      setResult(testResult)

      // Add to history (keep last 10)
      setHistory(prev => [testResult, ...prev.slice(0, 9)])
    } catch (err) {
      console.error('[PatternTester] Error:', err)
      setResult({
        query: query.trim(),
        error: err.message,
        handled: false
      })
    } finally {
      setLoading(false)
    }
  }, [query])

  const handleKeyPress = useCallback((e) => {
    if (e.key === 'Enter') {
      handleTest()
    }
  }, [handleTest])

  const getConfidenceClass = (confidence) => {
    if (confidence >= 0.9) return 'high'
    if (confidence >= 0.65) return 'medium'
    if (confidence >= 0.4) return 'low'
    return 'none'
  }

  const getDecisionText = (result) => {
    if (!result) return ''
    if (result.error) return 'Error'
    if (!result.classification?.intent) return 'No Match - Would pass to Claude'
    if (result.wouldRoute) return 'Would Route - Handler would execute'
    return 'Low Confidence - Would pass to Claude'
  }

  const getDecisionClass = (result) => {
    if (!result) return ''
    if (result.error) return 'error'
    if (!result.classification?.intent) return 'miss'
    if (result.wouldRoute) return 'route'
    return 'low'
  }

  return (
    <div className={`pattern-tester ${embedded ? 'pattern-tester--embedded' : ''}`}>
      {/* Input */}
      <div className="pattern-tester-input">
        <input
          type="text"
          className="pattern-tester-query"
          placeholder="Enter a test query..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyPress={handleKeyPress}
        />
        <button
          className="pattern-tester-btn"
          onClick={handleTest}
          disabled={loading || !query.trim()}
        >
          {loading ? 'Testing...' : 'Test'}
        </button>
      </div>

      {/* Quick Examples */}
      <div className="pattern-tester-examples">
        <span className="pattern-tester-examples-label">Try:</span>
        {[
          'fleet status',
          'check docker01',
          'what is quox',
          'check my understanding',
          'install quoxagent on kuma01'
        ].map(example => (
          <button
            key={example}
            className="pattern-tester-example"
            onClick={() => {
              setQuery(example)
              // Auto-test after a short delay
              setTimeout(() => {
                const btn = document.querySelector('.pattern-tester-btn')
                btn?.click()
              }, 50)
            }}
          >
            {example}
          </button>
        ))}
      </div>

      {/* Result */}
      {result && (
        <div className={`pattern-tester-result pattern-tester-result--${getDecisionClass(result)}`}>
          <div className="pattern-tester-result-header">
            <span className="pattern-tester-result-decision">
              {getDecisionText(result)}
            </span>
            <span className="pattern-tester-result-query">
              "{result.query}"
            </span>
          </div>

          {result.classification?.intent && (
            <div className="pattern-tester-result-details">
              <div className="pattern-tester-result-row">
                <span className="pattern-tester-label">Pattern:</span>
                <span className="pattern-tester-value">
                  {result.classification.intent.replace(/_/g, ' ')}
                </span>
              </div>

              <div className="pattern-tester-result-row">
                <span className="pattern-tester-label">Confidence:</span>
                <span className={`pattern-tester-value pattern-tester-confidence--${getConfidenceClass(result.classification.confidence)}`}>
                  {Math.round(result.classification.confidence * 100)}%
                  <span className="pattern-tester-confidence-bar">
                    <span
                      className="pattern-tester-confidence-fill"
                      style={{ width: `${result.classification.confidence * 100}%` }}
                    />
                  </span>
                </span>
              </div>

              <div className="pattern-tester-result-row">
                <span className="pattern-tester-label">Layer:</span>
                <span className="pattern-tester-value">
                  {result.classification.layer || 'regex'}
                </span>
              </div>

              <div className="pattern-tester-result-row">
                <span className="pattern-tester-label">Threshold:</span>
                <span className="pattern-tester-value">
                  {Math.round((result.thresholds?.confidence || 0.65) * 100)}% min
                </span>
              </div>

              {result.classification.metadata?.matchedText && (
                <div className="pattern-tester-result-row">
                  <span className="pattern-tester-label">Matched:</span>
                  <span className="pattern-tester-value pattern-tester-value--mono">
                    "{result.classification.metadata.matchedText}"
                  </span>
                </div>
              )}

              {result.classification.alternatives?.length > 0 && (
                <div className="pattern-tester-alternatives">
                  <span className="pattern-tester-label">Alternatives:</span>
                  <div className="pattern-tester-alt-list">
                    {result.classification.alternatives.map((alt, i) => (
                      <span key={i} className="pattern-tester-alt">
                        {alt.intent.replace(/_/g, ' ')} ({Math.round(alt.confidence * 100)}%)
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {result.error && (
            <div className="pattern-tester-error">
              {result.error}
            </div>
          )}
        </div>
      )}

      {/* History */}
      {history.length > 1 && !embedded && (
        <div className="pattern-tester-history">
          <h4 className="pattern-tester-history-title">Recent Tests</h4>
          <div className="pattern-tester-history-list">
            {history.slice(1).map((item, i) => (
              <div
                key={i}
                className={`pattern-tester-history-item pattern-tester-history-item--${getDecisionClass(item)}`}
                onClick={() => {
                  setQuery(item.query)
                  setResult(item)
                }}
              >
                <span className="pattern-tester-history-query">{item.query}</span>
                <span className="pattern-tester-history-result">
                  {item.classification?.intent
                    ? `${item.classification.intent.replace(/_/g, ' ')} (${Math.round(item.classification.confidence * 100)}%)`
                    : 'No match'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default PatternTester
