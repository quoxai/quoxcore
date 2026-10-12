/**
 * TraceComparisonView - Side-by-side Trace Comparison
 *
 * Main view for comparing two or more traces across multiple dimensions.
 * Part of AOCL Compliance Suite (Enterprise plugin).
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { createComparison, getSavedComparisons, deleteComparison } from '../../services/comparison'
import { useComplianceSuiteStatus } from '../../services/aoclPluginService'
import TimingComparison from './TimingComparison'
import DecisionComparison from './DecisionComparison'
import ContentDiff from './ContentDiff'
import CostComparison from './CostComparison'
import ComparisonSelector from './ComparisonSelector'
import './comparison.css'

export default function TraceComparisonView({ selectedTraces = [], onClose }) {
  const { licensed } = useComplianceSuiteStatus()
  const [comparison, setComparison] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [showSelector, setShowSelector] = useState(selectedTraces.length < 2)
  const [savedComparisons, setSavedComparisons] = useState([])

  // Load saved comparisons (async — migrated in TRV-1)
  useEffect(() => {
    getSavedComparisons()
      .then(comps => setSavedComparisons(comps))
      .catch(err => console.error('[Comparison] Failed to load saved comparisons:', err))
  }, [])

  // Auto-compare when traces are selected
  useEffect(() => {
    if (selectedTraces.length >= 2 && !comparison) {
      handleCompare(selectedTraces)
    }
  }, [selectedTraces])

  const handleCompare = async (corrIds) => {
    setLoading(true)
    setError(null)
    setShowSelector(false)

    try {
      const result = await createComparison(corrIds)
      setComparison(result)
      const comps = await getSavedComparisons()
      setSavedComparisons(comps)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleLoadComparison = (comp) => {
    setComparison(comp)
    setShowSelector(false)
  }

  const handleDeleteComparison = async (compId) => {
    if (confirm('Delete this comparison?')) {
      await deleteComparison(compId)
      const comps = await getSavedComparisons()
      setSavedComparisons(comps)
      if (comparison?.id === compId) {
        setComparison(null)
        setShowSelector(true)
      }
    }
  }

  const handleNewComparison = () => {
    setComparison(null)
    setShowSelector(true)
  }

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'timing', label: 'Timing' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'content', label: 'Content' },
    { id: 'costs', label: 'Costs' }
  ]

  if (!licensed) {
    return (
      <div className="comparison-view">
        <div className="comparison-warning">
          <strong>License Required</strong>
          <p>
            Trace Comparison requires AOCL Compliance Suite.
            <Link to="/settings#plugins" className="comparison-upgrade-link">Upgrade Now</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="comparison-view">
      <div className="comparison-header">
        <h2>Trace Comparison</h2>
        <div className="comparison-header-actions">
          {comparison && (
            <button className="comparison-btn-secondary" onClick={handleNewComparison}>
              New Comparison
            </button>
          )}
          {onClose && (
            <button className="comparison-btn-secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="comparison-error">{error}</div>
      )}

      {loading && (
        <div className="comparison-loading">
          <div className="comparison-spinner" />
          <span>Analyzing traces...</span>
        </div>
      )}

      {showSelector && !loading && (
        <ComparisonSelector
          savedComparisons={savedComparisons}
          onCompare={handleCompare}
          onLoadComparison={handleLoadComparison}
          onDeleteComparison={handleDeleteComparison}
        />
      )}

      {comparison && !loading && (
        <>
          {/* Similarity Score Banner */}
          <div className="comparison-similarity-banner">
            <div className="comparison-similarity-score">
              <span className="comparison-similarity-value">{comparison.similarity}%</span>
              <span className="comparison-similarity-label">Similarity</span>
            </div>
            <div className="comparison-traces-info">
              {comparison.traces.map((trace, idx) => (
                <div key={trace.corr} className="comparison-trace-badge">
                  <span className="comparison-trace-num">Trace {idx + 1}</span>
                  <code>{trace.corr.slice(0, 16)}...</code>
                </div>
              ))}
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="comparison-tabs">
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`comparison-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="comparison-content">
            {activeTab === 'overview' && (
              <OverviewTab comparison={comparison} />
            )}
            {activeTab === 'timing' && comparison.results.timing && (
              <TimingComparison data={comparison.results.timing} traces={comparison.traces} />
            )}
            {activeTab === 'decisions' && comparison.results.decisions && (
              <DecisionComparison data={comparison.results.decisions} traces={comparison.traces} />
            )}
            {activeTab === 'content' && comparison.results.content && (
              <ContentDiff data={comparison.results.content} traces={comparison.traces} />
            )}
            {activeTab === 'costs' && comparison.results.costs && (
              <CostComparison data={comparison.results.costs} traces={comparison.traces} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Overview Tab - High-level summary
 */
function OverviewTab({ comparison }) {
  const { timing, decisions, content, costs } = comparison.results

  return (
    <div className="comparison-overview">
      {/* Summary Cards */}
      <div className="comparison-summary-grid">
        {/* Timing Summary */}
        {timing && (
          <div className="comparison-summary-card">
            <h4>Timing</h4>
            <div className="comparison-summary-stat">
              <span className="stat-value">{timing.summary.avg.toFixed(0)}ms</span>
              <span className="stat-label">Avg Duration</span>
            </div>
            <div className="comparison-summary-detail">
              <span>Range: {timing.summary.min}ms - {timing.summary.max}ms</span>
              <span>Spread: {timing.summary.spreadPercent}%</span>
            </div>
          </div>
        )}

        {/* Decisions Summary */}
        {decisions && (
          <div className="comparison-summary-card">
            <h4>Decisions</h4>
            <div className="comparison-summary-stat">
              <span className="stat-value">{decisions.differences.length}</span>
              <span className="stat-label">Differences</span>
            </div>
            {decisions.differences.length > 0 ? (
              <div className="comparison-summary-detail warning">
                {decisions.differences.map((d, i) => (
                  <span key={i}>{d.type}: {d.description}</span>
                ))}
              </div>
            ) : (
              <div className="comparison-summary-detail success">
                All decisions match
              </div>
            )}
          </div>
        )}

        {/* Content Summary */}
        {content && (
          <div className="comparison-summary-card">
            <h4>Content</h4>
            <div className="comparison-summary-stat">
              <span className="stat-value">{content.similarity || 100}%</span>
              <span className="stat-label">Text Similarity</span>
            </div>
            <div className="comparison-summary-detail">
              {content.responsesIdentical ? (
                <span className="success">Responses identical</span>
              ) : (
                <span className="warning">{content.diff?.totalChanges || 0} line differences</span>
              )}
            </div>
          </div>
        )}

        {/* Costs Summary */}
        {costs && (
          <div className="comparison-summary-card">
            <h4>Costs</h4>
            <div className="comparison-summary-stat">
              <span className="stat-value">{costs.summary.avgTokens}</span>
              <span className="stat-label">Avg Tokens</span>
            </div>
            <div className="comparison-summary-detail">
              <span>Range: {costs.summary.minTokens} - {costs.summary.maxTokens}</span>
            </div>
          </div>
        )}
      </div>

      {/* Trace Details */}
      <div className="comparison-trace-details">
        <h4>Compared Traces</h4>
        <div className="comparison-trace-list">
          {comparison.traces.map((trace, idx) => (
            <div key={trace.corr} className="comparison-trace-item">
              <span className="comparison-trace-index">#{idx + 1}</span>
              <div className="comparison-trace-info">
                <code>{trace.corr}</code>
                <span className="comparison-trace-query">
                  {trace.query?.slice(0, 80)}{trace.query?.length > 80 ? '...' : ''}
                </span>
                <span className="comparison-trace-time">
                  {new Date(trace.timestamp).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Comparison Metadata */}
      <div className="comparison-meta">
        <span>ID: <code>{comparison.id}</code></span>
        <span>Created: {new Date(comparison.createdAt).toLocaleString()}</span>
      </div>
    </div>
  )
}
