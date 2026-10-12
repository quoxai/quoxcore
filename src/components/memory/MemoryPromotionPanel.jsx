/**
 * QuoxCORE Memory Promotion Pipeline Panel
 *
 * UI for managing the cold-to-warm memory promotion pipeline.
 * Review, validate, promote, or reject imported memories.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getColdStorageSummary,
  searchColdStorage,
  validateForPromotion,
  promoteItem,
  rejectItem,
  archiveItem,
  batchPromote,
  getPromotionRules,
  updatePromotionRules,
  getPromotionLog,
  getImportStats,
  cleanupColdStorage,
  STORAGE_TIER,
  PROMOTION_REASON,
  IMPORT_SOURCE
} from '../../services/memoryPromotion'
import './memory.css'

// Tier colors
const TIER_COLORS = {
  [STORAGE_TIER.COLD]: '#4a9eff',
  [STORAGE_TIER.WARM]: '#f39c12',
  [STORAGE_TIER.HOT]: '#e74c3c',
  [STORAGE_TIER.ARCHIVED]: '#95a5a6',
  [STORAGE_TIER.REJECTED]: '#e74c3c'
}

// Source icons
const SOURCE_ICONS = {
  [IMPORT_SOURCE.CHATGPT]: 'C',
  [IMPORT_SOURCE.CLAUDE]: 'CL',
  [IMPORT_SOURCE.MANUAL]: 'M',
  [IMPORT_SOURCE.TOOL]: 'T',
  [IMPORT_SOURCE.REFLECTION]: 'R',
  [IMPORT_SOURCE.MIGRATION]: 'MIG',
  [IMPORT_SOURCE.OTHER]: '?'
}

/**
 * Memory Promotion Panel
 */
export function MemoryPromotionPanel({ onClose }) {
  const [summary, setSummary] = useState(null)
  const [items, setItems] = useState([])
  const [activeTab, setActiveTab] = useState('pending')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedItems, setSelectedItems] = useState(new Set())
  const [selectedItem, setSelectedItem] = useState(null)
  const [validation, setValidation] = useState(null)
  const [rules, setRules] = useState(null)
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)

  // Load data
  useEffect(() => {
    loadData()
  }, [activeTab, searchQuery])

  const loadData = useCallback(() => {
    try {
      setSummary(getColdStorageSummary())
      setRules(getPromotionRules())

      if (searchQuery) {
        const results = searchColdStorage(searchQuery, { limit: 50 })
        setItems(results)
      } else {
        // Use searchColdStorage with empty query to get all items matching tier
        const results = searchColdStorage('', { limit: 100 })
          .filter(item => {
            switch (activeTab) {
              case 'pending':
                return item.tier === STORAGE_TIER.COLD && !item.promotionBlocked
              case 'blocked':
                return item.tier === STORAGE_TIER.COLD && item.promotionBlocked
              case 'promoted':
                return item.tier === STORAGE_TIER.WARM || item.tier === STORAGE_TIER.HOT
              case 'rejected':
                return item.tier === STORAGE_TIER.REJECTED
              case 'archived':
                return item.tier === STORAGE_TIER.ARCHIVED
              default:
                return true
            }
          })
        setItems(results)
      }

      setLoading(false)
    } catch (err) {
      console.error('Failed to load promotion data:', err)
      setLoading(false)
    }
  }, [activeTab, searchQuery])

  // Handle single item promotion
  const handlePromote = async (itemId) => {
    setProcessing(true)
    try {
      const result = await promoteItem(itemId, {
        reason: PROMOTION_REASON.MANUAL
      })
      if (!result.success) {
        alert(`Promotion failed: ${result.error}`)
      }
    } catch (err) {
      alert(`Error: ${err.message}`)
    }
    setProcessing(false)
    loadData()
    setSelectedItem(null)
    setSelectedItems(new Set())
  }

  // Handle reject
  const handleReject = (itemId, reason = 'Manually rejected') => {
    rejectItem(itemId, reason)
    loadData()
    setSelectedItem(null)
    setSelectedItems(prev => {
      const next = new Set(prev)
      next.delete(itemId)
      return next
    })
  }

  // Handle archive
  const handleArchive = (itemId, reason = 'Manually archived') => {
    archiveItem(itemId, reason)
    loadData()
    setSelectedItem(null)
    setSelectedItems(prev => {
      const next = new Set(prev)
      next.delete(itemId)
      return next
    })
  }

  // Handle bulk promote
  const handleBulkPromote = async () => {
    if (selectedItems.size === 0) return

    setProcessing(true)
    let promoted = 0
    let failed = 0

    for (const itemId of selectedItems) {
      try {
        const result = await promoteItem(itemId, {
          reason: PROMOTION_REASON.BATCH
        })
        if (result.success) promoted++
        else failed++
      } catch {
        failed++
      }
    }

    setProcessing(false)
    alert(`Promoted: ${promoted}, Failed: ${failed}`)
    setSelectedItems(new Set())
    loadData()
  }

  // Handle bulk reject
  const handleBulkReject = () => {
    if (selectedItems.size === 0) return

    for (const itemId of selectedItems) {
      rejectItem(itemId, 'Bulk rejection')
    }

    setSelectedItems(new Set())
    loadData()
  }

  // Handle validate
  const handleValidate = async (itemId) => {
    setValidation({ loading: true, itemId })
    try {
      const result = await validateForPromotion(itemId)
      setValidation({ loading: false, itemId, result })
    } catch (err) {
      setValidation({ loading: false, itemId, error: err.message })
    }
  }

  // Toggle item selection
  const toggleSelection = (itemId) => {
    setSelectedItems(prev => {
      const next = new Set(prev)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }

  // Select all visible
  const selectAll = () => {
    setSelectedItems(new Set(items.map(i => i.id)))
  }

  // Clear selection
  const clearSelection = () => {
    setSelectedItems(new Set())
  }

  if (loading) {
    return (
      <div className="promotion-panel">
        <div className="promotion-loading">Loading promotion pipeline...</div>
      </div>
    )
  }

  return (
    <div className="promotion-panel">
      {/* Header */}
      <div className="promotion-header">
        <div className="promotion-title">
          <span className="promotion-icon">^</span>
          <h2>Memory Promotion Pipeline</h2>
        </div>
        <div className="promotion-header-actions">
          {onClose && (
            <button className="promotion-close-btn" onClick={onClose}>X</button>
          )}
        </div>
      </div>

      <p className="panel-intro">Imported memories start in cold storage (quarantine). Review and promote to active use, or reject. Auto-promote rules can handle high-confidence items automatically.</p>

      {/* Summary Stats */}
      {summary && (
        <div className="promotion-summary-bar">
          <div className="summary-stat">
            <span className="stat-value" style={{ color: TIER_COLORS[STORAGE_TIER.COLD] }}>
              {summary.byTier?.cold || 0}
            </span>
            <span className="stat-label">Cold (Pending)</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value" style={{ color: TIER_COLORS[STORAGE_TIER.WARM] }}>
              {summary.byTier?.warm || 0}
            </span>
            <span className="stat-label">Warm (Active)</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value">{summary.pendingPromotion || 0}</span>
            <span className="stat-label">Ready</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value" style={{ color: '#e74c3c' }}>
              {summary.blockedPromotion || 0}
            </span>
            <span className="stat-label">Blocked</span>
          </div>
          <div className="summary-stat">
            <span className="stat-value">{summary.total || 0}</span>
            <span className="stat-label">Total</span>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="promotion-tabs">
        <button
          className={activeTab === 'pending' ? 'active' : ''}
          onClick={() => setActiveTab('pending')}
        >
          Pending
          <span className="tab-badge">{summary?.pendingPromotion || 0}</span>
        </button>
        <button
          className={activeTab === 'blocked' ? 'active' : ''}
          onClick={() => setActiveTab('blocked')}
        >
          Blocked
          <span className="tab-badge">{summary?.blockedPromotion || 0}</span>
        </button>
        <button
          className={activeTab === 'promoted' ? 'active' : ''}
          onClick={() => setActiveTab('promoted')}
        >
          Promoted
        </button>
        <button
          className={activeTab === 'rejected' ? 'active' : ''}
          onClick={() => setActiveTab('rejected')}
        >
          Rejected
        </button>
        <button
          className={activeTab === 'rules' ? 'active' : ''}
          onClick={() => setActiveTab('rules')}
        >
          Rules
        </button>
      </div>

      {/* Search */}
      {activeTab !== 'rules' && (
        <div className="promotion-search">
          <input
            type="text"
            placeholder="Search cold storage..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {selectedItems.size > 0 && (
            <div className="bulk-actions">
              <span className="selection-count">{selectedItems.size} selected</span>
              <button
                className="bulk-btn promote"
                onClick={handleBulkPromote}
                disabled={processing}
              >
                {processing ? 'Processing...' : 'Promote All'}
              </button>
              <button
                className="bulk-btn reject"
                onClick={handleBulkReject}
              >
                Reject All
              </button>
              <button className="bulk-btn clear" onClick={clearSelection}>
                Clear
              </button>
            </div>
          )}
          {selectedItems.size === 0 && items.length > 0 && (
            <button className="select-all-btn" onClick={selectAll}>
              Select All
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="promotion-content">
        {activeTab === 'rules' ? (
          <RulesView rules={rules} onUpdate={(updated) => {
            updatePromotionRules(updated)
            setRules(getPromotionRules())
          }} />
        ) : (
          <ItemsList
            items={items}
            selectedItems={selectedItems}
            onToggleSelect={toggleSelection}
            onSelect={setSelectedItem}
            onPromote={handlePromote}
            onReject={handleReject}
            onArchive={handleArchive}
            onValidate={handleValidate}
            activeTab={activeTab}
          />
        )}
      </div>

      {/* Detail Panel */}
      {selectedItem && (
        <ItemDetailPanel
          item={selectedItem}
          validation={validation?.itemId === selectedItem.id ? validation : null}
          onClose={() => {
            setSelectedItem(null)
            setValidation(null)
          }}
          onPromote={handlePromote}
          onReject={handleReject}
          onArchive={handleArchive}
          onValidate={handleValidate}
        />
      )}
    </div>
  )
}

/**
 * Items List
 */
function ItemsList({ items, selectedItems, onToggleSelect, onSelect, onPromote, onReject, onArchive, onValidate, activeTab }) {
  return (
    <div className="items-list">
      {items.length > 0 ? (
        items.map((item) => (
          <div
            key={item.id}
            className={`promotion-item ${selectedItems.has(item.id) ? 'selected' : ''}`}
            onClick={() => onSelect(item)}
          >
            <div
              className="item-checkbox"
              onClick={(e) => {
                e.stopPropagation()
                onToggleSelect(item.id)
              }}
            >
              {selectedItems.has(item.id) ? '[X]' : '[ ]'}
            </div>

            <div className="item-main">
              <div className="item-header">
                <span
                  className="item-source"
                  title={item.source}
                >
                  {SOURCE_ICONS[item.source] || '?'}
                </span>
                <span className="item-type">{item.type}</span>
                <span className="item-confidence">
                  {Math.round((item.confidence || 0) * 100)}%
                </span>
                {item.promotionBlocked && (
                  <span className="item-blocked" title={item.promotionBlocked.reason}>
                    BLOCKED
                  </span>
                )}
              </div>

              <div className="item-content">
                {item.content?.substring(0, 150)}
                {item.content?.length > 150 ? '...' : ''}
              </div>

              <div className="item-footer">
                {item.topics?.length > 0 && (
                  <span className="item-topics">
                    {item.topics.slice(0, 3).join(', ')}
                  </span>
                )}
                <span className="item-date">
                  {new Date(item.importedAt).toLocaleDateString()}
                </span>
              </div>
            </div>

            <div className="item-actions" onClick={(e) => e.stopPropagation()}>
              {activeTab === 'pending' && (
                <>
                  <button
                    className="item-action-btn promote"
                    onClick={() => onPromote(item.id)}
                    title="Promote"
                  >
                    ^
                  </button>
                  <button
                    className="item-action-btn reject"
                    onClick={() => onReject(item.id)}
                    title="Reject"
                  >
                    X
                  </button>
                </>
              )}
              {activeTab === 'blocked' && (
                <>
                  <button
                    className="item-action-btn promote"
                    onClick={() => onPromote(item.id)}
                    title="Force Promote"
                  >
                    ^!
                  </button>
                  <button
                    className="item-action-btn archive"
                    onClick={() => onArchive(item.id)}
                    title="Archive"
                  >
                    A
                  </button>
                </>
              )}
            </div>
          </div>
        ))
      ) : (
        <div className="items-empty">
          {activeTab === 'pending' && 'No items pending promotion'}
          {activeTab === 'blocked' && 'No blocked items'}
          {activeTab === 'promoted' && 'No promoted items yet'}
          {activeTab === 'rejected' && 'No rejected items'}
        </div>
      )}
    </div>
  )
}

/**
 * Item Detail Panel
 */
function ItemDetailPanel({ item, validation, onClose, onPromote, onReject, onArchive, onValidate }) {
  return (
    <div className="promotion-detail-overlay" onClick={onClose}>
      <div className="promotion-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <h3>Item Details</h3>
          <button className="detail-close" onClick={onClose}>X</button>
        </div>

        <div className="detail-content">
          <div className="detail-section">
            <label>ID</label>
            <code>{item.id}</code>
          </div>

          <div className="detail-section">
            <label>Content</label>
            <p>{item.content}</p>
          </div>

          <div className="detail-section">
            <label>Status</label>
            <span
              className="tier-badge"
              style={{ backgroundColor: TIER_COLORS[item.tier] }}
            >
              {item.tier}
            </span>
          </div>

          <div className="detail-row">
            <div className="detail-section">
              <label>Type</label>
              <span>{item.type}</span>
            </div>
            <div className="detail-section">
              <label>Source</label>
              <span>{item.source}</span>
            </div>
            <div className="detail-section">
              <label>Confidence</label>
              <span>{Math.round((item.confidence || 0) * 100)}%</span>
            </div>
          </div>

          {item.topics?.length > 0 && (
            <div className="detail-section">
              <label>Topics</label>
              <div className="topic-tags">
                {item.topics.map((topic, idx) => (
                  <span key={idx} className="topic-tag">{topic}</span>
                ))}
              </div>
            </div>
          )}

          {item.entities?.length > 0 && (
            <div className="detail-section">
              <label>Entities</label>
              <div className="entity-tags">
                {item.entities.map((entity, idx) => (
                  <span key={idx} className="entity-tag">{entity}</span>
                ))}
              </div>
            </div>
          )}

          <div className="detail-row">
            <div className="detail-section">
              <label>Imported</label>
              <span>{new Date(item.importedAt).toLocaleString()}</span>
            </div>
            {item.originalTimestamp && (
              <div className="detail-section">
                <label>Original Date</label>
                <span>{new Date(item.originalTimestamp).toLocaleString()}</span>
              </div>
            )}
          </div>

          <div className="detail-section">
            <label>Access Count</label>
            <span>{item.accessCount || 0}</span>
          </div>

          {item.promotionBlocked && (
            <div className="detail-section blocked-info">
              <label>Blocked Reason</label>
              <p>{item.promotionBlocked.reason}</p>
              <span className="blocked-time">
                Blocked: {new Date(item.promotionBlocked.timestamp).toLocaleString()}
              </span>
            </div>
          )}

          {/* Validation Result */}
          {validation && (
            <div className="detail-section validation-result">
              <label>Validation</label>
              {validation.loading ? (
                <div className="validation-loading">Validating...</div>
              ) : validation.error ? (
                <div className="validation-error">{validation.error}</div>
              ) : (
                <div className={`validation-status ${validation.result?.valid ? 'valid' : 'invalid'}`}>
                  <div className="validation-header">
                    {validation.result?.valid ? 'VALID for Promotion' : 'INVALID'}
                    {validation.result?.canAutoPromote && (
                      <span className="auto-promote-badge">Auto-Promotable</span>
                    )}
                  </div>
                  {validation.result?.issues?.length > 0 && (
                    <div className="validation-issues">
                      <strong>Issues:</strong>
                      <ul>
                        {validation.result.issues.map((issue, idx) => (
                          <li key={idx} className="issue">{issue}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {validation.result?.warnings?.length > 0 && (
                    <div className="validation-warnings">
                      <strong>Warnings:</strong>
                      <ul>
                        {validation.result.warnings.map((warning, idx) => (
                          <li key={idx} className="warning">{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="detail-actions">
          <button
            className="detail-btn validate"
            onClick={() => onValidate(item.id)}
          >
            Validate
          </button>
          {item.tier === STORAGE_TIER.COLD && (
            <>
              <button
                className="detail-btn promote"
                onClick={() => onPromote(item.id)}
              >
                Promote
              </button>
              <button
                className="detail-btn archive"
                onClick={() => onArchive(item.id)}
              >
                Archive
              </button>
              <button
                className="detail-btn reject"
                onClick={() => onReject(item.id)}
              >
                Reject
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Rules View
 */
function RulesView({ rules, onUpdate }) {
  const [localRules, setLocalRules] = useState(rules)

  const handleSave = () => {
    onUpdate(localRules)
    alert('Rules saved')
  }

  return (
    <div className="rules-view">
      <div className="rules-section">
        <h3>Auto-Promote Rules</h3>
        <div className="rule-item">
          <label>
            <input
              type="checkbox"
              checked={localRules?.autoPromote?.enabled || false}
              onChange={(e) => setLocalRules({
                ...localRules,
                autoPromote: { ...localRules.autoPromote, enabled: e.target.checked }
              })}
            />
            Enable auto-promotion
          </label>
        </div>
        <div className="rule-item">
          <label>Minimum Confidence</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={localRules?.autoPromote?.minConfidence || 0.85}
            onChange={(e) => setLocalRules({
              ...localRules,
              autoPromote: { ...localRules.autoPromote, minConfidence: parseFloat(e.target.value) }
            })}
          />
          <span>{Math.round((localRules?.autoPromote?.minConfidence || 0.85) * 100)}%</span>
        </div>
        <div className="rule-item">
          <label>
            <input
              type="checkbox"
              checked={localRules?.autoPromote?.requireNoConflicts || false}
              onChange={(e) => setLocalRules({
                ...localRules,
                autoPromote: { ...localRules.autoPromote, requireNoConflicts: e.target.checked }
              })}
            />
            Require no conflicts
          </label>
        </div>
        <div className="rule-item">
          <label>Max Age (days)</label>
          <input
            type="number"
            min="1"
            max="3650"
            value={localRules?.autoPromote?.maxAge || 365}
            onChange={(e) => setLocalRules({
              ...localRules,
              autoPromote: { ...localRules.autoPromote, maxAge: parseInt(e.target.value) }
            })}
          />
        </div>
      </div>

      <div className="rules-section">
        <h3>Auto-Reject Rules</h3>
        <div className="rule-item">
          <label>
            <input
              type="checkbox"
              checked={localRules?.autoReject?.enabled || false}
              onChange={(e) => setLocalRules({
                ...localRules,
                autoReject: { ...localRules.autoReject, enabled: e.target.checked }
              })}
            />
            Enable auto-rejection
          </label>
        </div>
        <div className="rule-item">
          <label>Min Age for Rejection (days)</label>
          <input
            type="number"
            min="1"
            max="3650"
            value={localRules?.autoReject?.minAge || 730}
            onChange={(e) => setLocalRules({
              ...localRules,
              autoReject: { ...localRules.autoReject, minAge: parseInt(e.target.value) }
            })}
          />
        </div>
      </div>

      <div className="rules-section">
        <h3>Relevance Promotion</h3>
        <div className="rule-item">
          <label>
            <input
              type="checkbox"
              checked={localRules?.relevancePromotion?.enabled || false}
              onChange={(e) => setLocalRules({
                ...localRules,
                relevancePromotion: { ...localRules.relevancePromotion, enabled: e.target.checked }
              })}
            />
            Enable relevance-based promotion
          </label>
        </div>
        <div className="rule-item">
          <label>Access Count Threshold</label>
          <input
            type="number"
            min="1"
            max="100"
            value={localRules?.relevancePromotion?.accessCountThreshold || 3}
            onChange={(e) => setLocalRules({
              ...localRules,
              relevancePromotion: { ...localRules.relevancePromotion, accessCountThreshold: parseInt(e.target.value) }
            })}
          />
        </div>
        <div className="rule-item">
          <label>Time Window (days)</label>
          <input
            type="number"
            min="1"
            max="365"
            value={localRules?.relevancePromotion?.timeWindowDays || 30}
            onChange={(e) => setLocalRules({
              ...localRules,
              relevancePromotion: { ...localRules.relevancePromotion, timeWindowDays: parseInt(e.target.value) }
            })}
          />
        </div>
      </div>

      <div className="rules-actions">
        <button className="rules-btn save" onClick={handleSave}>
          Save Rules
        </button>
      </div>
    </div>
  )
}

export default MemoryPromotionPanel
