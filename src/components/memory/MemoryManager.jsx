/**
 * QuoxCORE Memory Manager UI
 *
 * Comprehensive interface for browsing, searching, editing, and managing memories.
 * Part of Wave 4 Memory Overhaul - "giggly-seeking-beacon"
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { getMemoryManager } from '../../services/memoryManager'
import { getDashboardMetrics, runHealthChecks } from '../../services/memoryMetrics'
import './memory.css'

// Memory types with icons and colors
const MEMORY_TYPES = {
  fact: { icon: '📚', color: '#4a9eff', label: 'Fact' },
  preference: { icon: '⭐', color: '#ffd700', label: 'Preference' },
  constraint: { icon: '🚫', color: '#67e8f9', label: 'Constraint' },
  decision: { icon: '🎯', color: '#0ea5e9', label: 'Decision' },
  error: { icon: '⚠️', color: '#e74c3c', label: 'Error' },
  reflection: { icon: '🔮', color: '#1abc9c', label: 'Reflection' },
  intent: { icon: '🎪', color: '#3498db', label: 'Intent' }
}

// Stability badges
const STABILITY_BADGES = {
  volatile: { label: 'Volatile', color: '#e74c3c' },
  stable: { label: 'Stable', color: '#f39c12' },
  permanent: { label: 'Permanent', color: '#27ae60' }
}

/**
 * Memory Manager Panel
 */
export function MemoryManager({ onClose }) {
  const [memories, setMemories] = useState([])
  const [selectedType, setSelectedType] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMemory, setSelectedMemory] = useState(null)
  const [editingMemory, setEditingMemory] = useState(null)
  const [metrics, setMetrics] = useState(null)
  const [healthChecks, setHealthChecks] = useState(null)
  const [view, setView] = useState('list') // list | metrics | health
  const [sortBy, setSortBy] = useState('created') // created | confidence | type
  const [sortOrder, setSortOrder] = useState('desc')

  // Load memories
  useEffect(() => {
    loadMemories()
  }, [selectedType])

  // Load metrics periodically
  useEffect(() => {
    loadMetrics()
    const interval = setInterval(loadMetrics, 30000)
    return () => clearInterval(interval)
  }, [])

  const loadMemories = useCallback(() => {
    const mm = getMemoryManager()
    const types = selectedType === 'all'
      ? Object.keys(MEMORY_TYPES)
      : [selectedType]

    const allMemories = []
    for (const type of types) {
      const items = mm.getLearnedItemsByType(type)
      allMemories.push(...items.map(item => ({ ...item, type })))
    }

    setMemories(allMemories)
  }, [selectedType])

  const loadMetrics = useCallback(() => {
    try {
      setMetrics(getDashboardMetrics())
      setHealthChecks(runHealthChecks())
    } catch (err) {
      console.error('Failed to load metrics:', err)
    }
  }, [])

  // Filter and sort memories
  const filteredMemories = useMemo(() => {
    let result = [...memories]

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(m =>
        m.content?.toLowerCase().includes(query) ||
        m.id?.toLowerCase().includes(query) ||
        m.provenance?.createdBy?.toLowerCase().includes(query)
      )
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0
      switch (sortBy) {
        case 'created':
          comparison = new Date(b.provenance?.createdAt || 0) - new Date(a.provenance?.createdAt || 0)
          break
        case 'confidence':
          comparison = (b.confidence?.score || 0) - (a.confidence?.score || 0)
          break
        case 'type':
          comparison = (a.type || '').localeCompare(b.type || '')
          break
      }
      return sortOrder === 'desc' ? comparison : -comparison
    })

    return result
  }, [memories, searchQuery, sortBy, sortOrder])

  // Delete memory
  const handleDelete = useCallback((memoryId) => {
    if (!confirm('Delete this memory? This cannot be undone.')) return

    const mm = getMemoryManager()
    mm.deleteLearnedItem(memoryId)
    loadMemories()
    setSelectedMemory(null)
  }, [loadMemories])

  // Update memory
  const handleUpdate = useCallback((memoryId, updates) => {
    const mm = getMemoryManager()
    mm.updateLearnedItem(memoryId, updates)
    loadMemories()
    setEditingMemory(null)
  }, [loadMemories])

  // Export memories
  const handleExport = useCallback(() => {
    const data = JSON.stringify(filteredMemories, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `quox-memories-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [filteredMemories])

  return (
    <div className="memory-manager">
      {/* Header */}
      <div className="memory-manager-header">
        <h2>Memory Manager</h2>
        <div className="header-actions">
          <div className="view-tabs">
            <button
              className={view === 'list' ? 'active' : ''}
              onClick={() => setView('list')}
            >
              Memories
            </button>
            <button
              className={view === 'metrics' ? 'active' : ''}
              onClick={() => setView('metrics')}
            >
              Metrics
            </button>
            <button
              className={view === 'health' ? 'active' : ''}
              onClick={() => setView('health')}
            >
              Health
            </button>
          </div>
          {onClose && (
            <button className="close-btn" onClick={onClose}>×</button>
          )}
        </div>
      </div>

      {/* List View */}
      {view === 'list' && (
        <>
          {/* Filters */}
          <div className="memory-filters">
            <div className="search-box">
              <input
                type="text"
                placeholder="Search memories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="type-filter">
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
              >
                <option value="all">All Types</option>
                {Object.entries(MEMORY_TYPES).map(([type, config]) => (
                  <option key={type} value={type}>
                    {config.icon} {config.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sort-controls">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="created">Created</option>
                <option value="confidence">Confidence</option>
                <option value="type">Type</option>
              </select>
              <button
                className="sort-order"
                onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')}
              >
                {sortOrder === 'desc' ? '↓' : '↑'}
              </button>
            </div>

            <button className="export-btn" onClick={handleExport}>
              Export
            </button>
          </div>

          {/* Memory List */}
          <div className="memory-list-container">
            <div className="memory-list">
              {filteredMemories.length === 0 ? (
                <div className="no-memories">
                  No memories found
                </div>
              ) : (
                filteredMemories.map(memory => (
                  <MemoryCard
                    key={memory.id}
                    memory={memory}
                    isSelected={selectedMemory?.id === memory.id}
                    onClick={() => setSelectedMemory(memory)}
                    onDelete={() => handleDelete(memory.id)}
                    onEdit={() => setEditingMemory(memory)}
                  />
                ))
              )}
            </div>

            {/* Detail Panel */}
            {selectedMemory && !editingMemory && (
              <MemoryDetail
                memory={selectedMemory}
                onClose={() => setSelectedMemory(null)}
                onEdit={() => setEditingMemory(selectedMemory)}
                onDelete={() => handleDelete(selectedMemory.id)}
              />
            )}

            {/* Edit Panel */}
            {editingMemory && (
              <MemoryEditor
                memory={editingMemory}
                onSave={(updates) => handleUpdate(editingMemory.id, updates)}
                onCancel={() => setEditingMemory(null)}
              />
            )}
          </div>

          {/* Stats Bar */}
          <div className="memory-stats-bar">
            <span>{filteredMemories.length} memories</span>
            {Object.entries(MEMORY_TYPES).map(([type, config]) => {
              const count = filteredMemories.filter(m => m.type === type).length
              return count > 0 ? (
                <span key={type} style={{ color: config.color }}>
                  {config.icon} {count}
                </span>
              ) : null
            })}
          </div>
        </>
      )}

      {/* Metrics View */}
      {view === 'metrics' && metrics && (
        <MetricsDashboard metrics={metrics} />
      )}

      {/* Health View */}
      {view === 'health' && healthChecks && (
        <HealthDashboard health={healthChecks} />
      )}
    </div>
  )
}

/**
 * Memory Card Component
 */
function MemoryCard({ memory, isSelected, onClick, onDelete, onEdit }) {
  const typeConfig = MEMORY_TYPES[memory.type] || MEMORY_TYPES.fact
  const stability = memory.confidence?.stability
  const stabilityConfig = stability ? STABILITY_BADGES[stability] : null

  return (
    <div
      className={`memory-card ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className="memory-card-header">
        <span className="memory-type" style={{ color: typeConfig.color }}>
          {typeConfig.icon} {typeConfig.label}
        </span>
        {stabilityConfig && (
          <span
            className="stability-badge"
            style={{ backgroundColor: stabilityConfig.color }}
          >
            {stabilityConfig.label}
          </span>
        )}
        {memory.confidence?.score !== undefined && (
          <span className="confidence-badge">
            {Math.round(memory.confidence.score * 100)}%
          </span>
        )}
      </div>

      <div className="memory-content">
        {memory.content?.substring(0, 150)}
        {memory.content?.length > 150 ? '...' : ''}
      </div>

      <div className="memory-card-footer">
        <span className="memory-date">
          {memory.provenance?.createdAt
            ? new Date(memory.provenance.createdAt).toLocaleDateString()
            : 'Unknown date'}
        </span>
        <span className="memory-source">
          {memory.provenance?.createdBy || 'Unknown'}
        </span>
      </div>

      <div className="memory-card-actions" onClick={(e) => e.stopPropagation()}>
        <button onClick={onEdit} title="Edit">✏️</button>
        <button onClick={onDelete} title="Delete">🗑️</button>
      </div>
    </div>
  )
}

/**
 * Memory Detail Panel
 */
function MemoryDetail({ memory, onClose, onEdit, onDelete }) {
  const typeConfig = MEMORY_TYPES[memory.type] || MEMORY_TYPES.fact

  return (
    <div className="memory-detail">
      <div className="detail-header">
        <h3>
          <span style={{ color: typeConfig.color }}>{typeConfig.icon}</span>
          {' '}Memory Detail
        </h3>
        <button onClick={onClose}>×</button>
      </div>

      <div className="detail-content">
        <div className="detail-section">
          <label>ID</label>
          <code>{memory.id}</code>
        </div>

        <div className="detail-section">
          <label>Content</label>
          <p>{memory.content}</p>
        </div>

        <div className="detail-section">
          <label>Type</label>
          <span style={{ color: typeConfig.color }}>
            {typeConfig.icon} {typeConfig.label}
          </span>
        </div>

        {memory.confidence && (
          <div className="detail-section">
            <label>Confidence</label>
            <div className="confidence-detail">
              <div className="confidence-bar">
                <div
                  className="confidence-fill"
                  style={{ width: `${memory.confidence.score * 100}%` }}
                />
              </div>
              <span>{Math.round(memory.confidence.score * 100)}%</span>
              {memory.confidence.stability && (
                <span className="stability-tag">
                  {memory.confidence.stability}
                </span>
              )}
            </div>
          </div>
        )}

        {memory.provenance && (
          <div className="detail-section">
            <label>Provenance</label>
            <div className="provenance-detail">
              <p><strong>Source:</strong> {memory.provenance.source}</p>
              <p><strong>Created by:</strong> {memory.provenance.createdBy}</p>
              <p><strong>Created:</strong> {new Date(memory.provenance.createdAt).toLocaleString()}</p>
              {memory.provenance.modifiedAt && (
                <p><strong>Modified:</strong> {new Date(memory.provenance.modifiedAt).toLocaleString()}</p>
              )}
              {memory.provenance.supersedes && (
                <p><strong>Supersedes:</strong> {memory.provenance.supersedes}</p>
              )}
            </div>
          </div>
        )}

        {memory.conflicts && memory.conflicts.conflictsWith?.length > 0 && (
          <div className="detail-section warning">
            <label>Conflicts</label>
            <p>This memory conflicts with {memory.conflicts.conflictsWith.length} other memories</p>
            <p>Status: {memory.conflicts.resolution || 'pending'}</p>
          </div>
        )}
      </div>

      <div className="detail-actions">
        <button className="edit-btn" onClick={onEdit}>Edit</button>
        <button className="delete-btn" onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

/**
 * Memory Editor Panel
 */
function MemoryEditor({ memory, onSave, onCancel }) {
  const [content, setContent] = useState(memory.content || '')
  const [confidence, setConfidence] = useState(memory.confidence?.score || 0.5)
  const [stability, setStability] = useState(memory.confidence?.stability || 'stable')

  const handleSave = () => {
    onSave({
      content,
      confidence: {
        ...memory.confidence,
        score: confidence,
        stability
      },
      provenance: {
        ...memory.provenance,
        modifiedAt: new Date().toISOString(),
        modifiedBy: 'human.user'
      }
    })
  }

  return (
    <div className="memory-editor">
      <div className="editor-header">
        <h3>Edit Memory</h3>
        <button onClick={onCancel}>×</button>
      </div>

      <div className="editor-content">
        <div className="editor-field">
          <label>Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={5}
          />
        </div>

        <div className="editor-field">
          <label>Confidence: {Math.round(confidence * 100)}%</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={confidence}
            onChange={(e) => setConfidence(parseFloat(e.target.value))}
          />
        </div>

        <div className="editor-field">
          <label>Stability</label>
          <select
            value={stability}
            onChange={(e) => setStability(e.target.value)}
          >
            <option value="volatile">Volatile</option>
            <option value="stable">Stable</option>
            <option value="permanent">Permanent</option>
          </select>
        </div>
      </div>

      <div className="editor-actions">
        <button className="cancel-btn" onClick={onCancel}>Cancel</button>
        <button className="save-btn" onClick={handleSave}>Save</button>
      </div>
    </div>
  )
}

/**
 * Metrics Dashboard
 */
function MetricsDashboard({ metrics }) {
  return (
    <div className="metrics-dashboard">
      {/* Summary Cards */}
      <div className="metrics-cards">
        {metrics.cards.map(card => (
          <div key={card.id} className={`metric-card ${card.status}`}>
            <div className="metric-title">{card.title}</div>
            <div className="metric-value">{card.value}</div>
            <div className="metric-target">Target: {card.target}</div>
          </div>
        ))}
      </div>

      {/* Health Score */}
      <div className="health-score-card">
        <h3>System Health</h3>
        <div className="health-score">
          {metrics.summary.health !== null ? (
            <>
              <div
                className="score-circle"
                style={{
                  '--score': metrics.summary.health,
                  borderColor: metrics.summary.health > 80 ? '#27ae60' :
                               metrics.summary.health > 60 ? '#f39c12' : '#e74c3c'
                }}
              >
                {metrics.summary.health}
              </div>
              <span>/ 100</span>
            </>
          ) : (
            <span className="no-data">Collecting data...</span>
          )}
        </div>
      </div>

      {/* Memory Distribution */}
      <div className="distribution-card">
        <h3>Memory Distribution</h3>
        <div className="distribution-bars">
          {metrics.charts.memoryDistribution.map(item => {
            const config = MEMORY_TYPES[item.name] || MEMORY_TYPES.fact
            const maxValue = Math.max(...metrics.charts.memoryDistribution.map(i => i.value))
            const width = maxValue > 0 ? (item.value / maxValue) * 100 : 0

            return (
              <div key={item.name} className="distribution-row">
                <span className="dist-label">
                  {config.icon} {config.label}
                </span>
                <div className="dist-bar-container">
                  <div
                    className="dist-bar"
                    style={{ width: `${width}%`, backgroundColor: config.color }}
                  />
                </div>
                <span className="dist-value">{item.value}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Quick Stats */}
      <div className="quick-stats">
        <div className="stat">
          <span className="stat-value">{metrics.summary.totalMemories}</span>
          <span className="stat-label">Total Memories</span>
        </div>
        <div className="stat">
          <span className="stat-value">{metrics.summary.queriesProcessed}</span>
          <span className="stat-label">Queries (24h)</span>
        </div>
        <div className="stat">
          <span className="stat-value">{metrics.summary.contradictionsFound}</span>
          <span className="stat-label">Conflicts</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Health Dashboard
 */
function HealthDashboard({ health }) {
  const statusColors = {
    pass: '#27ae60',
    fail: '#e74c3c',
    warn: '#f39c12',
    info: '#3498db'
  }

  return (
    <div className="health-dashboard">
      {/* Overall Status */}
      <div className={`overall-status ${health.overall}`}>
        <div className="status-icon">
          {health.overall === 'healthy' ? '✅' :
           health.overall === 'degraded' ? '⚠️' : '❌'}
        </div>
        <div className="status-text">
          <h3>System Status: {health.overall.toUpperCase()}</h3>
          <p>
            {health.passed} passed, {health.warnings} warnings, {health.failed} failed
          </p>
        </div>
      </div>

      {/* Health Checks */}
      <div className="health-checks">
        {health.checks.map((check, idx) => (
          <div key={idx} className={`health-check ${check.status}`}>
            <span
              className="check-status"
              style={{ backgroundColor: statusColors[check.status] }}
            >
              {check.status === 'pass' ? '✓' :
               check.status === 'fail' ? '✗' :
               check.status === 'warn' ? '!' : 'i'}
            </span>
            <div className="check-info">
              <span className="check-name">{check.name}</span>
              <span className="check-message">{check.message}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default MemoryManager
