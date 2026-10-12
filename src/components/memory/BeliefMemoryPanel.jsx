/**
 * QuoxCORE Belief Memory Panel
 *
 * UI for managing beliefs, rationales, assumptions, and hypotheses.
 * Tracks epistemic state - what we know vs believe vs assume.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getBeliefsByStatus,
  getBeliefsByDomain,
  getBeliefsNeedingVerification,
  updateBeliefStatus,
  getActiveAssumptions,
  getCriticalAssumptions,
  verifyAssumption,
  getActiveHypotheses,
  addHypothesisEvidence,
  resolveHypothesis,
  getRationalesByDomain,
  getEpistemicSummary,
  BELIEF_STATUS,
  EVIDENCE_TYPES
} from '../../services/beliefMemory'
import './memory.css'

// Status colors
const STATUS_COLORS = {
  [BELIEF_STATUS.FACT]: '#27ae60',
  [BELIEF_STATUS.BELIEF]: '#4a9eff',
  [BELIEF_STATUS.ASSUMPTION]: '#f39c12',
  [BELIEF_STATUS.HYPOTHESIS]: '#0ea5e9',
  [BELIEF_STATUS.UNCERTAIN]: '#95a5a6',
  [BELIEF_STATUS.DISPROVEN]: '#e74c3c'
}

// Status icons
const STATUS_ICONS = {
  [BELIEF_STATUS.FACT]: 'F',
  [BELIEF_STATUS.BELIEF]: 'B',
  [BELIEF_STATUS.ASSUMPTION]: 'A',
  [BELIEF_STATUS.HYPOTHESIS]: 'H',
  [BELIEF_STATUS.UNCERTAIN]: '?',
  [BELIEF_STATUS.DISPROVEN]: 'X'
}

/**
 * Belief Memory Panel
 */
export function BeliefMemoryPanel({ onClose }) {
  const [activeTab, setActiveTab] = useState('beliefs')
  const [beliefs, setBeliefs] = useState([])
  const [assumptions, setAssumptions] = useState([])
  const [hypotheses, setHypotheses] = useState([])
  const [summary, setSummary] = useState(null)
  const [selectedItem, setSelectedItem] = useState(null)
  const [filterStatus, setFilterStatus] = useState('all')
  const [loading, setLoading] = useState(true)

  // Load data
  useEffect(() => {
    loadData()
  }, [filterStatus])

  const loadData = useCallback(() => {
    try {
      // Load beliefs
      let beliefList = []
      if (filterStatus === 'all') {
        Object.values(BELIEF_STATUS).forEach(status => {
          beliefList.push(...getBeliefsByStatus(status))
        })
      } else if (filterStatus === 'verification') {
        beliefList = getBeliefsNeedingVerification()
      } else {
        beliefList = getBeliefsByStatus(filterStatus)
      }
      setBeliefs(beliefList)

      // Load assumptions
      setAssumptions(getActiveAssumptions())

      // Load hypotheses
      setHypotheses(getActiveHypotheses())

      // Load summary
      setSummary(getEpistemicSummary())

      setLoading(false)
    } catch (err) {
      console.error('Failed to load belief data:', err)
      setLoading(false)
    }
  }, [filterStatus])

  // Handle status update
  const handleUpdateStatus = (beliefId, newStatus) => {
    updateBeliefStatus(beliefId, {
      newStatus,
      reason: 'Manual status update'
    })
    loadData()
    setSelectedItem(null)
  }

  // Handle assumption verification
  const handleVerifyAssumption = (assumptionId, verified) => {
    verifyAssumption(assumptionId, { verified })
    loadData()
    setSelectedItem(null)
  }

  // Handle hypothesis resolution
  const handleResolveHypothesis = (hypothesisId, confirmed) => {
    resolveHypothesis(hypothesisId, {
      confirmed,
      conclusion: confirmed ? 'Confirmed by user' : 'Refuted by user'
    })
    loadData()
    setSelectedItem(null)
  }

  if (loading) {
    return (
      <div className="belief-panel">
        <div className="belief-loading">Loading belief memory...</div>
      </div>
    )
  }

  return (
    <div className="belief-panel">
      {/* Header */}
      <div className="belief-header">
        <div className="belief-title">
          <span className="belief-icon">&lt;/&gt;</span>
          <h2>Belief Memory</h2>
        </div>
        <div className="belief-header-actions">
          {onClose && (
            <button className="belief-close-btn" onClick={onClose}>X</button>
          )}
        </div>
      </div>

      <p className="panel-intro">Track what you know vs. believe vs. assume. Facts are verified, beliefs are confident, hypotheses need testing. Confidence levels help the AI weigh information correctly.</p>

      {/* Summary Stats */}
      {summary && (
        <div className="belief-summary-bar">
          <div className="summary-stat">
            <span className="stat-value" style={{ color: STATUS_COLORS[BELIEF_STATUS.FACT] }}>
              {summary.beliefs.byStatus.facts}
            </span>
            <span className="stat-label">Facts</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value" style={{ color: STATUS_COLORS[BELIEF_STATUS.BELIEF] }}>
              {summary.beliefs.byStatus.beliefs}
            </span>
            <span className="stat-label">Beliefs</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value" style={{ color: STATUS_COLORS[BELIEF_STATUS.HYPOTHESIS] }}>
              {summary.hypotheses.investigating}
            </span>
            <span className="stat-label">Hypotheses</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value" style={{ color: STATUS_COLORS[BELIEF_STATUS.ASSUMPTION] }}>
              {summary.assumptions.active}
            </span>
            <span className="stat-label">Assumptions</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value" style={{ color: '#e74c3c' }}>
              {summary.beliefs.needingVerification}
            </span>
            <span className="stat-label">Need Verify</span>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="belief-tabs">
        <button
          className={activeTab === 'beliefs' ? 'active' : ''}
          onClick={() => setActiveTab('beliefs')}
        >
          Beliefs
          <span className="tab-badge">{beliefs.length}</span>
        </button>
        <button
          className={activeTab === 'assumptions' ? 'active' : ''}
          onClick={() => setActiveTab('assumptions')}
        >
          Assumptions
          <span className="tab-badge">{assumptions.length}</span>
        </button>
        <button
          className={activeTab === 'hypotheses' ? 'active' : ''}
          onClick={() => setActiveTab('hypotheses')}
        >
          Hypotheses
          <span className="tab-badge">{hypotheses.length}</span>
        </button>
      </div>

      {/* Content */}
      <div className="belief-content">
        {activeTab === 'beliefs' && (
          <BeliefsView
            beliefs={beliefs}
            filterStatus={filterStatus}
            onFilterChange={setFilterStatus}
            onSelect={setSelectedItem}
            onUpdateStatus={handleUpdateStatus}
          />
        )}

        {activeTab === 'assumptions' && (
          <AssumptionsView
            assumptions={assumptions}
            criticalAssumptions={getCriticalAssumptions()}
            onSelect={setSelectedItem}
            onVerify={handleVerifyAssumption}
          />
        )}

        {activeTab === 'hypotheses' && (
          <HypothesesView
            hypotheses={hypotheses}
            onSelect={setSelectedItem}
            onResolve={handleResolveHypothesis}
          />
        )}
      </div>

      {/* Detail Panel */}
      {selectedItem && (
        <ItemDetailPanel
          item={selectedItem}
          type={activeTab}
          onClose={() => setSelectedItem(null)}
          onUpdateStatus={handleUpdateStatus}
          onVerify={handleVerifyAssumption}
          onResolve={handleResolveHypothesis}
        />
      )}
    </div>
  )
}

/**
 * Beliefs View
 */
function BeliefsView({ beliefs, filterStatus, onFilterChange, onSelect, onUpdateStatus }) {
  return (
    <div className="beliefs-view">
      {/* Filter */}
      <div className="belief-filter">
        <select value={filterStatus} onChange={(e) => onFilterChange(e.target.value)}>
          <option value="all">All Statuses</option>
          <option value="verification">Needs Verification</option>
          <option value={BELIEF_STATUS.FACT}>Facts</option>
          <option value={BELIEF_STATUS.BELIEF}>Beliefs</option>
          <option value={BELIEF_STATUS.ASSUMPTION}>Assumptions</option>
          <option value={BELIEF_STATUS.HYPOTHESIS}>Hypotheses</option>
          <option value={BELIEF_STATUS.UNCERTAIN}>Uncertain</option>
          <option value={BELIEF_STATUS.DISPROVEN}>Disproven</option>
        </select>
      </div>

      {/* Beliefs List */}
      <div className="beliefs-list">
        {beliefs.length > 0 ? (
          beliefs.map((belief) => (
            <div
              key={belief.id}
              className="belief-card"
              onClick={() => onSelect(belief)}
            >
              <div className="belief-card-header">
                <span
                  className="belief-status-badge"
                  style={{ backgroundColor: STATUS_COLORS[belief.status] }}
                >
                  {STATUS_ICONS[belief.status]} {belief.status}
                </span>
                <span className="belief-confidence">
                  {Math.round(belief.confidence * 100)}%
                </span>
              </div>
              <div className="belief-card-content">{belief.content}</div>
              <div className="belief-card-footer">
                <span className="belief-domain">{belief.domain}</span>
                <span className="belief-date">
                  {new Date(belief.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="belief-card-actions" onClick={(e) => e.stopPropagation()}>
                {belief.status !== BELIEF_STATUS.FACT && (
                  <button
                    className="belief-action-btn promote"
                    onClick={() => onUpdateStatus(belief.id, BELIEF_STATUS.FACT)}
                    title="Promote to Fact"
                  >
                    +
                  </button>
                )}
                {belief.status !== BELIEF_STATUS.DISPROVEN && (
                  <button
                    className="belief-action-btn demote"
                    onClick={() => onUpdateStatus(belief.id, BELIEF_STATUS.DISPROVEN)}
                    title="Mark as Disproven"
                  >
                    X
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="belief-empty">No beliefs found</div>
        )}
      </div>
    </div>
  )
}

/**
 * Assumptions View
 */
function AssumptionsView({ assumptions, criticalAssumptions, onSelect, onVerify }) {
  return (
    <div className="assumptions-view">
      {/* Critical Assumptions Warning */}
      {criticalAssumptions.length > 0 && (
        <div className="critical-warning">
          <span className="warning-icon">!</span>
          <span>{criticalAssumptions.length} critical assumption(s) need attention</span>
        </div>
      )}

      {/* Assumptions List */}
      <div className="assumptions-list">
        {assumptions.length > 0 ? (
          assumptions.map((assumption) => (
            <div
              key={assumption.id}
              className={`assumption-card ${assumption.critical ? 'critical' : ''}`}
              onClick={() => onSelect(assumption)}
            >
              <div className="assumption-card-header">
                {assumption.critical && (
                  <span className="critical-badge">CRITICAL</span>
                )}
                <span className="assumption-domain">{assumption.domain}</span>
              </div>
              <div className="assumption-card-content">{assumption.content}</div>
              {assumption.basis && (
                <div className="assumption-basis">Basis: {assumption.basis}</div>
              )}
              <div className="assumption-card-footer">
                {assumption.verificationMethod && (
                  <span className="verification-method">
                    Verify: {assumption.verificationMethod}
                  </span>
                )}
                <span className="assumption-date">
                  {new Date(assumption.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="assumption-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="assumption-action-btn verify"
                  onClick={() => onVerify(assumption.id, true)}
                  title="Verify as True"
                >
                  V
                </button>
                <button
                  className="assumption-action-btn invalidate"
                  onClick={() => onVerify(assumption.id, false)}
                  title="Invalidate"
                >
                  X
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="assumption-empty">No active assumptions</div>
        )}
      </div>
    </div>
  )
}

/**
 * Hypotheses View
 */
function HypothesesView({ hypotheses, onSelect, onResolve }) {
  return (
    <div className="hypotheses-view">
      <div className="hypotheses-list">
        {hypotheses.length > 0 ? (
          hypotheses.map((hypothesis) => {
            const supporting = hypothesis.evidenceCollected?.filter(e => e.supports).length || 0
            const refuting = hypothesis.evidenceCollected?.filter(e => !e.supports).length || 0

            return (
              <div
                key={hypothesis.id}
                className="hypothesis-card"
                onClick={() => onSelect(hypothesis)}
              >
                <div className="hypothesis-card-header">
                  <span className={`priority-badge priority-${hypothesis.priority}`}>
                    {hypothesis.priority}
                  </span>
                  <span className="hypothesis-status">{hypothesis.status}</span>
                </div>
                <div className="hypothesis-statement">{hypothesis.statement}</div>
                {hypothesis.motivation && (
                  <div className="hypothesis-motivation">Why: {hypothesis.motivation}</div>
                )}
                <div className="hypothesis-evidence-summary">
                  <span className="evidence-supporting">+{supporting} supporting</span>
                  <span className="evidence-refuting">-{refuting} refuting</span>
                </div>
                <div className="hypothesis-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="hypothesis-action-btn confirm"
                    onClick={() => onResolve(hypothesis.id, true)}
                    title="Confirm Hypothesis"
                  >
                    +
                  </button>
                  <button
                    className="hypothesis-action-btn refute"
                    onClick={() => onResolve(hypothesis.id, false)}
                    title="Refute Hypothesis"
                  >
                    -
                  </button>
                </div>
              </div>
            )
          })
        ) : (
          <div className="hypothesis-empty">No active hypotheses</div>
        )}
      </div>
    </div>
  )
}

/**
 * Item Detail Panel
 */
function ItemDetailPanel({ item, type, onClose, onUpdateStatus, onVerify, onResolve }) {
  return (
    <div className="belief-detail-overlay" onClick={onClose}>
      <div className="belief-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <h3>
            {type === 'beliefs' && 'Belief Details'}
            {type === 'assumptions' && 'Assumption Details'}
            {type === 'hypotheses' && 'Hypothesis Details'}
          </h3>
          <button className="detail-close" onClick={onClose}>X</button>
        </div>

        <div className="detail-content">
          <div className="detail-section">
            <label>ID</label>
            <code>{item.id}</code>
          </div>

          <div className="detail-section">
            <label>{type === 'hypotheses' ? 'Statement' : 'Content'}</label>
            <p>{item.content || item.statement}</p>
          </div>

          {type === 'beliefs' && (
            <>
              <div className="detail-section">
                <label>Status</label>
                <span
                  className="status-pill"
                  style={{ backgroundColor: STATUS_COLORS[item.status] }}
                >
                  {item.status}
                </span>
              </div>

              <div className="detail-section">
                <label>Confidence</label>
                <div className="confidence-display">
                  <div className="confidence-bar">
                    <div
                      className="confidence-fill"
                      style={{ width: `${item.confidence * 100}%` }}
                    />
                  </div>
                  <span>{Math.round(item.confidence * 100)}%</span>
                </div>
              </div>

              {item.evidence?.length > 0 && (
                <div className="detail-section">
                  <label>Evidence ({item.evidence.length})</label>
                  <div className="evidence-list">
                    {item.evidence.map((e, idx) => (
                      <div key={idx} className="evidence-item">
                        <span className="evidence-type">{e.type}</span>
                        <span className="evidence-content">{e.content}</span>
                        <span className="evidence-weight">w:{e.weight}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {item.history?.length > 0 && (
                <div className="detail-section">
                  <label>Status History</label>
                  <div className="history-list">
                    {item.history.slice(-5).reverse().map((h, idx) => (
                      <div key={idx} className="history-item">
                        <span className="history-change">
                          {h.previousStatus} - {h.newStatus}
                        </span>
                        <span className="history-reason">{h.reason}</span>
                        <span className="history-time">
                          {new Date(h.timestamp).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {type === 'hypotheses' && (
            <>
              {item.testPlan?.length > 0 && (
                <div className="detail-section">
                  <label>Test Plan</label>
                  <ul className="test-plan-list">
                    {item.testPlan.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ul>
                </div>
              )}

              {item.evidenceCollected?.length > 0 && (
                <div className="detail-section">
                  <label>Evidence Collected</label>
                  <div className="evidence-collected-list">
                    {item.evidenceCollected.map((e, idx) => (
                      <div
                        key={idx}
                        className={`evidence-collected-item ${e.supports ? 'supports' : 'refutes'}`}
                      >
                        <span className="evidence-indicator">
                          {e.supports ? '+' : '-'}
                        </span>
                        <span className="evidence-text">{e.content}</span>
                        <span className="evidence-strength">{e.strength}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="detail-actions">
          {type === 'beliefs' && (
            <>
              <button
                className="detail-btn promote"
                onClick={() => onUpdateStatus(item.id, BELIEF_STATUS.FACT)}
                disabled={item.status === BELIEF_STATUS.FACT}
              >
                Promote to Fact
              </button>
              <button
                className="detail-btn uncertain"
                onClick={() => onUpdateStatus(item.id, BELIEF_STATUS.UNCERTAIN)}
              >
                Mark Uncertain
              </button>
              <button
                className="detail-btn disprove"
                onClick={() => onUpdateStatus(item.id, BELIEF_STATUS.DISPROVEN)}
              >
                Disprove
              </button>
            </>
          )}

          {type === 'assumptions' && (
            <>
              <button
                className="detail-btn verify"
                onClick={() => onVerify(item.id, true)}
              >
                Verify as True
              </button>
              <button
                className="detail-btn invalidate"
                onClick={() => onVerify(item.id, false)}
              >
                Invalidate
              </button>
            </>
          )}

          {type === 'hypotheses' && (
            <>
              <button
                className="detail-btn confirm"
                onClick={() => onResolve(item.id, true)}
              >
                Confirm
              </button>
              <button
                className="detail-btn refute"
                onClick={() => onResolve(item.id, false)}
              >
                Refute
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default BeliefMemoryPanel
