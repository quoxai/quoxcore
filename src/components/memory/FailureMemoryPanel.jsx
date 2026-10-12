/**
 * QuoxCORE Failure Memory Panel
 *
 * UI for viewing and managing recorded failures.
 * Shows what didn't work, why, and prevents repeated mistakes.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getAllFailures,
  getRecentFailures,
  getFrequentFailures,
  getFailuresByEntity,
  resolveFailure,
  addWorkaround,
  addLessonsLearned,
  getFailureSummary,
  FAILURE_TYPES,
  FAILURE_SEVERITY,
  FAILURE_STATUS
} from '../../services/failureMemory'
import './memory.css'

// Severity colors
const SEVERITY_COLORS = {
  [FAILURE_SEVERITY.CRITICAL]: '#e74c3c',
  [FAILURE_SEVERITY.HIGH]: '#f39c12',
  [FAILURE_SEVERITY.MEDIUM]: '#4a9eff',
  [FAILURE_SEVERITY.LOW]: '#27ae60',
  [FAILURE_SEVERITY.INFORMATIONAL]: '#95a5a6'
}

// Severity icons
const SEVERITY_ICONS = {
  [FAILURE_SEVERITY.CRITICAL]: '!!!',
  [FAILURE_SEVERITY.HIGH]: '!!',
  [FAILURE_SEVERITY.MEDIUM]: '!',
  [FAILURE_SEVERITY.LOW]: 'i',
  [FAILURE_SEVERITY.INFORMATIONAL]: '-'
}

// Type icons
const TYPE_ICONS = {
  [FAILURE_TYPES.COMMAND]: '>_',
  [FAILURE_TYPES.APPROACH]: '~>',
  [FAILURE_TYPES.CONFIGURATION]: '{}',
  [FAILURE_TYPES.INTEGRATION]: '<>',
  [FAILURE_TYPES.PERFORMANCE]: '%',
  [FAILURE_TYPES.COMPATIBILITY]: '!=',
  [FAILURE_TYPES.SECURITY]: '#',
  [FAILURE_TYPES.USER_REJECTED]: 'X',
  [FAILURE_TYPES.TIMEOUT]: '...',
  [FAILURE_TYPES.DEPENDENCY]: '@',
  [FAILURE_TYPES.PERMISSION]: '!@',
  [FAILURE_TYPES.OTHER]: '?'
}

/**
 * Failure Memory Panel
 */
export function FailureMemoryPanel({ onClose }) {
  const [failures, setFailures] = useState([])
  const [summary, setSummary] = useState(null)
  const [activeTab, setActiveTab] = useState('all')
  const [filterType, setFilterType] = useState('all')
  const [filterSeverity, setFilterSeverity] = useState('all')
  const [selectedFailure, setSelectedFailure] = useState(null)
  const [loading, setLoading] = useState(true)

  // Load data
  useEffect(() => {
    loadData()
  }, [activeTab, filterType, filterSeverity])

  const loadData = useCallback(() => {
    try {
      let failureList = []

      switch (activeTab) {
        case 'all':
          failureList = getAllFailures({
            includeResolved: false,
            type: filterType !== 'all' ? filterType : null,
            severity: filterSeverity !== 'all' ? filterSeverity : null
          })
          break
        case 'recent':
          failureList = getRecentFailures({ hours: 72, limit: 50 })
          break
        case 'frequent':
          failureList = getFrequentFailures({ minOccurrences: 2, limit: 50 })
          break
        case 'resolved':
          failureList = getAllFailures({ includeResolved: true })
            .filter(f => f.status === FAILURE_STATUS.RESOLVED || f.status === FAILURE_STATUS.WORKAROUND)
          break
        default:
          failureList = getAllFailures({ includeResolved: false })
      }

      setFailures(failureList)
      setSummary(getFailureSummary())
      setLoading(false)
    } catch (err) {
      console.error('Failed to load failure data:', err)
      setLoading(false)
    }
  }, [activeTab, filterType, filterSeverity])

  // Handle resolve
  const handleResolve = (failureId, resolution) => {
    resolveFailure(failureId, { resolution })
    loadData()
    setSelectedFailure(null)
  }

  // Handle add workaround
  const handleAddWorkaround = (failureId, workaround) => {
    addWorkaround(failureId, { workaround })
    loadData()
  }

  if (loading) {
    return (
      <div className="failure-panel">
        <div className="failure-loading">Loading failure memory...</div>
      </div>
    )
  }

  return (
    <div className="failure-panel">
      {/* Header */}
      <div className="failure-header">
        <div className="failure-title">
          <span className="failure-icon">X</span>
          <h2>Failure Memory</h2>
        </div>
        <div className="failure-header-actions">
          {onClose && (
            <button className="failure-close-btn" onClick={onClose}>X</button>
          )}
        </div>
      </div>

      <p className="panel-intro">Record what went wrong and why. Pattern detection prevents repeating the same mistakes. Workarounds are surfaced automatically when similar issues arise.</p>

      {/* Summary Stats */}
      {summary && (
        <div className="failure-summary-bar">
          <div className="summary-stat">
            <span className="stat-value" style={{ color: SEVERITY_COLORS[FAILURE_SEVERITY.CRITICAL] }}>
              {summary.bySeverity?.[FAILURE_SEVERITY.CRITICAL] || 0}
            </span>
            <span className="stat-label">Critical</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value" style={{ color: SEVERITY_COLORS[FAILURE_SEVERITY.HIGH] }}>
              {summary.bySeverity?.[FAILURE_SEVERITY.HIGH] || 0}
            </span>
            <span className="stat-label">High</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value">{summary.active || 0}</span>
            <span className="stat-label">Active</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value">{summary.withWorkaround || 0}</span>
            <span className="stat-label">Workarounds</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value">{summary.recentFailures || 0}</span>
            <span className="stat-label">Last 24h</span>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="failure-tabs">
        <button
          className={activeTab === 'all' ? 'active' : ''}
          onClick={() => setActiveTab('all')}
        >
          All Active
        </button>
        <button
          className={activeTab === 'recent' ? 'active' : ''}
          onClick={() => setActiveTab('recent')}
        >
          Recent
        </button>
        <button
          className={activeTab === 'frequent' ? 'active' : ''}
          onClick={() => setActiveTab('frequent')}
        >
          Recurring
        </button>
        <button
          className={activeTab === 'resolved' ? 'active' : ''}
          onClick={() => setActiveTab('resolved')}
        >
          Resolved
        </button>
      </div>

      {/* Filters */}
      {activeTab === 'all' && (
        <div className="failure-filters">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="all">All Types</option>
            {Object.values(FAILURE_TYPES).map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
          >
            <option value="all">All Severities</option>
            {Object.values(FAILURE_SEVERITY).map(sev => (
              <option key={sev} value={sev}>{sev}</option>
            ))}
          </select>
        </div>
      )}

      {/* Content */}
      <div className="failure-content">
        <FailuresList
          failures={failures}
          onSelect={setSelectedFailure}
          onResolve={handleResolve}
        />
      </div>

      {/* Detail Panel */}
      {selectedFailure && (
        <FailureDetailPanel
          failure={selectedFailure}
          onClose={() => setSelectedFailure(null)}
          onResolve={handleResolve}
          onAddWorkaround={handleAddWorkaround}
        />
      )}
    </div>
  )
}

/**
 * Failures List
 */
function FailuresList({ failures, onSelect, onResolve }) {
  return (
    <div className="failures-list">
      {failures.length > 0 ? (
        failures.map((failure) => (
          <div
            key={failure.id}
            className={`failure-card severity-${failure.severity} status-${failure.status}`}
            onClick={() => onSelect(failure)}
          >
            <div className="failure-card-header">
              <span
                className="failure-severity-badge"
                style={{ backgroundColor: SEVERITY_COLORS[failure.severity] }}
              >
                {SEVERITY_ICONS[failure.severity]} {failure.severity}
              </span>
              <span className="failure-type">
                {TYPE_ICONS[failure.type] || '?'} {failure.type}
              </span>
              {failure.occurrenceCount > 1 && (
                <span className="failure-count">{failure.occurrenceCount}x</span>
              )}
              <span className={`failure-status-badge status-${failure.status}`}>
                {failure.status}
              </span>
            </div>

            <div className="failure-card-content">
              <div className="failure-what">{failure.whatFailed}</div>
              {failure.whyItFailed && (
                <div className="failure-why">Why: {failure.whyItFailed}</div>
              )}
            </div>

            {failure.avoidanceAdvice && (
              <div className="failure-advice">
                <span className="advice-icon">!</span>
                {failure.avoidanceAdvice}
              </div>
            )}

            {failure.workaround && (
              <div className="failure-workaround">
                <span className="workaround-icon">~</span>
                Workaround: {failure.workaround.description}
              </div>
            )}

            <div className="failure-card-footer">
              {failure.affectedEntities?.length > 0 && (
                <span className="failure-entities">
                  Affects: {failure.affectedEntities.slice(0, 3).join(', ')}
                  {failure.affectedEntities.length > 3 && '...'}
                </span>
              )}
              <span className="failure-date">
                Last: {new Date(failure.lastOccurrence).toLocaleDateString()}
              </span>
            </div>

            <div className="failure-card-actions" onClick={(e) => e.stopPropagation()}>
              {failure.status === FAILURE_STATUS.ACTIVE && (
                <>
                  <button
                    className="failure-action-btn resolve"
                    onClick={() => onResolve(failure.id, 'Manually resolved')}
                    title="Mark as Resolved"
                  >
                    V
                  </button>
                </>
              )}
            </div>
          </div>
        ))
      ) : (
        <div className="failure-empty-state">
          <div className="empty-icon">OK</div>
          <p>No failures recorded - system is healthy</p>
        </div>
      )}
    </div>
  )
}

/**
 * Failure Detail Panel
 */
function FailureDetailPanel({ failure, onClose, onResolve, onAddWorkaround }) {
  const [workaroundInput, setWorkaroundInput] = useState('')
  const [resolutionInput, setResolutionInput] = useState('')
  const [showResolveForm, setShowResolveForm] = useState(false)
  const [showWorkaroundForm, setShowWorkaroundForm] = useState(false)

  return (
    <div className="failure-detail-overlay" onClick={onClose}>
      <div className="failure-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <div className="detail-title-row">
            <span
              className="detail-severity"
              style={{ backgroundColor: SEVERITY_COLORS[failure.severity] }}
            >
              {failure.severity}
            </span>
            <h3>{failure.type} Failure</h3>
          </div>
          <button className="detail-close" onClick={onClose}>X</button>
        </div>

        <div className="detail-content">
          {/* What Failed */}
          <div className="detail-section">
            <label>What Failed</label>
            <p className="what-failed">{failure.whatFailed}</p>
          </div>

          {/* Why It Failed */}
          {failure.whyItFailed && (
            <div className="detail-section">
              <label>Why It Failed</label>
              <p>{failure.whyItFailed}</p>
            </div>
          )}

          {/* Error Details */}
          {failure.errorMessage && (
            <div className="detail-section">
              <label>Error Message</label>
              <pre className="error-message">{failure.errorMessage}</pre>
            </div>
          )}

          {failure.errorCode && (
            <div className="detail-section">
              <label>Error Code</label>
              <code>{failure.errorCode}</code>
            </div>
          )}

          {/* Reproduction Steps */}
          {failure.reproductionSteps?.length > 0 && (
            <div className="detail-section">
              <label>Reproduction Steps</label>
              <ol className="reproduction-steps">
                {failure.reproductionSteps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ol>
            </div>
          )}

          {/* Affected Entities */}
          {failure.affectedEntities?.length > 0 && (
            <div className="detail-section">
              <label>Affected Entities</label>
              <div className="affected-entities">
                {failure.affectedEntities.map((entity, idx) => (
                  <span key={idx} className="entity-tag">{entity}</span>
                ))}
              </div>
            </div>
          )}

          {/* Avoidance Advice */}
          {failure.avoidanceAdvice && (
            <div className="detail-section advice-section">
              <label>Avoidance Advice</label>
              <div className="advice-box">{failure.avoidanceAdvice}</div>
            </div>
          )}

          {/* Suggested Alternatives */}
          {failure.suggestedAlternatives?.length > 0 && (
            <div className="detail-section">
              <label>Suggested Alternatives</label>
              <ul className="alternatives-list">
                {failure.suggestedAlternatives.map((alt, idx) => (
                  <li key={idx}>{alt}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Current Workaround */}
          {failure.workaround && (
            <div className="detail-section workaround-section">
              <label>Current Workaround</label>
              <div className="workaround-box">
                <p>{failure.workaround.description}</p>
                {failure.workaround.caveats?.length > 0 && (
                  <div className="workaround-caveats">
                    <span>Caveats: </span>
                    {failure.workaround.caveats.join(', ')}
                  </div>
                )}
                {failure.workaround.temporary && (
                  <span className="temporary-badge">Temporary</span>
                )}
              </div>
            </div>
          )}

          {/* Lessons Learned */}
          {failure.lessonsLearned?.length > 0 && (
            <div className="detail-section">
              <label>Lessons Learned</label>
              <ul className="lessons-list">
                {failure.lessonsLearned.map((lesson, idx) => (
                  <li key={idx}>{lesson.content}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Occurrence Stats */}
          <div className="detail-section">
            <label>Statistics</label>
            <div className="stats-grid">
              <div className="stat-item">
                <span className="stat-value">{failure.occurrenceCount || 1}</span>
                <span className="stat-label">Occurrences</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">
                  {new Date(failure.firstOccurrence).toLocaleDateString()}
                </span>
                <span className="stat-label">First</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">
                  {new Date(failure.lastOccurrence).toLocaleDateString()}
                </span>
                <span className="stat-label">Last</span>
              </div>
            </div>
          </div>
        </div>

        {/* Action Forms */}
        {showResolveForm && (
          <div className="action-form">
            <h4>Mark as Resolved</h4>
            <textarea
              value={resolutionInput}
              onChange={(e) => setResolutionInput(e.target.value)}
              placeholder="Describe how this was resolved..."
              rows={3}
            />
            <div className="form-actions">
              <button
                className="form-btn primary"
                onClick={() => {
                  onResolve(failure.id, resolutionInput || 'Resolved')
                  setShowResolveForm(false)
                }}
              >
                Resolve
              </button>
              <button
                className="form-btn"
                onClick={() => setShowResolveForm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {showWorkaroundForm && (
          <div className="action-form">
            <h4>Add Workaround</h4>
            <textarea
              value={workaroundInput}
              onChange={(e) => setWorkaroundInput(e.target.value)}
              placeholder="Describe the workaround..."
              rows={3}
            />
            <div className="form-actions">
              <button
                className="form-btn primary"
                onClick={() => {
                  onAddWorkaround(failure.id, workaroundInput)
                  setShowWorkaroundForm(false)
                  setWorkaroundInput('')
                }}
              >
                Add Workaround
              </button>
              <button
                className="form-btn"
                onClick={() => setShowWorkaroundForm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        {!showResolveForm && !showWorkaroundForm && (
          <div className="detail-actions">
            {failure.status === FAILURE_STATUS.ACTIVE && (
              <>
                <button
                  className="detail-btn resolve"
                  onClick={() => setShowResolveForm(true)}
                >
                  Mark Resolved
                </button>
                <button
                  className="detail-btn workaround"
                  onClick={() => setShowWorkaroundForm(true)}
                >
                  Add Workaround
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default FailureMemoryPanel
