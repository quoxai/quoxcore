import { useState, useEffect } from 'react'
import {
  getAlertRules,
  toggleAlertRule,
  deleteAlertRule,
  resetToDefaultRules,
  addAlertRule,
  updateAlertRule
} from '../../services/alertRules'
import { getAlertStats, clearResolvedAlerts } from '../../services/alertService'
import './settings.css'

/**
 * AlertRulesPanel - Manage alert rules for service monitoring
 */
export function AlertRulesPanel() {
  const [rules, setRules] = useState([])
  const [stats, setStats] = useState(null)
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    priority: 'normal',
    conditionType: 'status',
    conditionValue: 'down',
    threshold: '',
    criticalOnly: false,
    duration: 0,
    cooldown: 300
  })

  useEffect(() => {
    loadData()
  }, [])

  const loadData = () => {
    setRules(getAlertRules())
    setStats(getAlertStats())
  }

  const handleToggle = (ruleId, enabled) => {
    toggleAlertRule(ruleId, enabled)
    loadData()
  }

  const handleDelete = (ruleId) => {
    if (confirm('Delete this alert rule?')) {
      deleteAlertRule(ruleId)
      loadData()
    }
  }

  const handleReset = () => {
    if (confirm('Reset to default alert rules? Custom rules will be lost.')) {
      resetToDefaultRules()
      loadData()
    }
  }

  const handleClearResolved = () => {
    clearResolvedAlerts()
    loadData()
  }

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      priority: 'normal',
      conditionType: 'status',
      conditionValue: 'down',
      threshold: '',
      criticalOnly: false,
      duration: 0,
      cooldown: 300
    })
    setIsAdding(false)
    setEditingId(null)
  }

  const handleEdit = (rule) => {
    setEditingId(rule.id)
    setFormData({
      name: rule.name,
      description: rule.description || '',
      priority: rule.priority || 'normal',
      conditionType: rule.conditions.type,
      conditionValue: rule.conditions.status || '',
      threshold: rule.conditions.threshold || '',
      criticalOnly: rule.conditions.criticalOnly || false,
      duration: rule.duration || 0,
      cooldown: rule.cooldown || 300
    })
    setIsAdding(true)
  }

  const handleSubmit = (e) => {
    e.preventDefault()

    const conditions = {
      type: formData.conditionType,
      criticalOnly: formData.criticalOnly
    }

    if (formData.conditionType === 'status') {
      conditions.status = formData.conditionValue
    } else if (formData.conditionType === 'response_time') {
      conditions.threshold = parseInt(formData.threshold, 10)
    } else if (formData.conditionType === 'uptime') {
      conditions.threshold = parseInt(formData.threshold, 10)
      conditions.hours = 24
    } else if (formData.conditionType === 'consecutive_failures') {
      conditions.count = parseInt(formData.threshold, 10) || 3
    }

    const ruleData = {
      name: formData.name,
      description: formData.description,
      priority: formData.priority,
      conditions,
      duration: parseInt(formData.duration, 10) || 0,
      cooldown: parseInt(formData.cooldown, 10) || 300,
      enabled: true
    }

    if (editingId) {
      updateAlertRule(editingId, ruleData)
    } else {
      addAlertRule(ruleData)
    }

    resetForm()
    loadData()
  }

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'urgent': return '#ef4444'
      case 'high': return '#f59e0b'
      case 'normal': return '#38bdf8'
      case 'low': return '#6b7280'
      default: return '#6b7280'
    }
  }

  const getConditionLabel = (conditions) => {
    switch (conditions.type) {
      case 'status':
        return `Status = ${conditions.status}`
      case 'response_time':
        return `Response > ${conditions.threshold}ms`
      case 'uptime':
        return `Uptime < ${conditions.threshold}%`
      case 'consecutive_failures':
        return `${conditions.count} failures`
      default:
        return conditions.type
    }
  }

  return (
    <div className="alert-rules-panel">
      <div className="alert-rules-panel__header">
        <div className="alert-rules-panel__title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span>Alert Rules</span>
        </div>
        <div className="alert-rules-panel__actions">
          <button className="alert-rules-panel__reset" onClick={handleReset} title="Reset to defaults">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          {!isAdding && (
            <button className="alert-rules-panel__add-btn" onClick={() => setIsAdding(true)}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Rule
            </button>
          )}
        </div>
      </div>

      {/* Stats Summary */}
      {stats && (
        <div className="alert-rules-stats">
          <div className="alert-rules-stat">
            <span className="alert-rules-stat__value">{stats.open}</span>
            <span className="alert-rules-stat__label">Open</span>
          </div>
          <div className="alert-rules-stat">
            <span className="alert-rules-stat__value">{stats.lastHour}</span>
            <span className="alert-rules-stat__label">Last Hour</span>
          </div>
          <div className="alert-rules-stat">
            <span className="alert-rules-stat__value">{stats.lastDay}</span>
            <span className="alert-rules-stat__label">Last 24h</span>
          </div>
          <div className="alert-rules-stat">
            <span className="alert-rules-stat__value">{stats.resolved}</span>
            <span className="alert-rules-stat__label">Resolved</span>
          </div>
          {stats.resolved > 0 && (
            <button className="alert-rules-clear" onClick={handleClearResolved}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
              Clear
            </button>
          )}
        </div>
      )}

      <p className="alert-rules-panel__desc">
        Configure when alerts are sent to the HITL inbox. Alerts help you catch issues before they become outages.
      </p>

      {/* Add/Edit Form */}
      {isAdding && (
        <form className="alert-rules-form" onSubmit={handleSubmit}>
          <div className="alert-rules-form__header">
            <h4>{editingId ? 'Edit Rule' : 'New Alert Rule'}</h4>
            <button type="button" className="alert-rules-form__close" onClick={resetForm}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="alert-rules-form__row">
            <div className="alert-rules-form__field">
              <label>Rule Name *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Database Slow Response"
                required
              />
            </div>
            <div className="alert-rules-form__field alert-rules-form__field--small">
              <label>Priority</label>
              <select
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
              >
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <div className="alert-rules-form__field">
            <label>Description</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="What this rule monitors..."
            />
          </div>

          <div className="alert-rules-form__row">
            <div className="alert-rules-form__field">
              <label>Condition Type</label>
              <select
                value={formData.conditionType}
                onChange={(e) => setFormData({ ...formData, conditionType: e.target.value })}
              >
                <option value="status">Service Status</option>
                <option value="response_time">Response Time</option>
                <option value="uptime">Uptime Percentage</option>
                <option value="consecutive_failures">Consecutive Failures</option>
              </select>
            </div>

            {formData.conditionType === 'status' && (
              <div className="alert-rules-form__field">
                <label>Status</label>
                <select
                  value={formData.conditionValue}
                  onChange={(e) => setFormData({ ...formData, conditionValue: e.target.value })}
                >
                  <option value="down">Down</option>
                  <option value="degraded">Degraded</option>
                </select>
              </div>
            )}

            {formData.conditionType === 'response_time' && (
              <div className="alert-rules-form__field">
                <label>Threshold (ms)</label>
                <input
                  type="number"
                  value={formData.threshold}
                  onChange={(e) => setFormData({ ...formData, threshold: e.target.value })}
                  placeholder="2000"
                  min="0"
                />
              </div>
            )}

            {formData.conditionType === 'uptime' && (
              <div className="alert-rules-form__field">
                <label>Minimum Uptime %</label>
                <input
                  type="number"
                  value={formData.threshold}
                  onChange={(e) => setFormData({ ...formData, threshold: e.target.value })}
                  placeholder="95"
                  min="0"
                  max="100"
                />
              </div>
            )}

            {formData.conditionType === 'consecutive_failures' && (
              <div className="alert-rules-form__field">
                <label>Failure Count</label>
                <input
                  type="number"
                  value={formData.threshold}
                  onChange={(e) => setFormData({ ...formData, threshold: e.target.value })}
                  placeholder="3"
                  min="1"
                />
              </div>
            )}
          </div>

          <div className="alert-rules-form__row">
            <div className="alert-rules-form__field">
              <label>Duration (seconds)</label>
              <input
                type="number"
                value={formData.duration}
                onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
                placeholder="0 = immediate"
                min="0"
              />
              <span className="alert-rules-form__hint">How long condition must persist</span>
            </div>
            <div className="alert-rules-form__field">
              <label>Cooldown (seconds)</label>
              <input
                type="number"
                value={formData.cooldown}
                onChange={(e) => setFormData({ ...formData, cooldown: e.target.value })}
                placeholder="300"
                min="0"
              />
              <span className="alert-rules-form__hint">Time before re-alerting</span>
            </div>
          </div>

          <div className="alert-rules-form__field alert-rules-form__field--checkbox">
            <label>
              <input
                type="checkbox"
                checked={formData.criticalOnly}
                onChange={(e) => setFormData({ ...formData, criticalOnly: e.target.checked })}
              />
              <span>Critical services only</span>
            </label>
          </div>

          <div className="alert-rules-form__actions">
            <button type="button" className="alert-rules-form__cancel" onClick={resetForm}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              Cancel
            </button>
            <button type="submit" className="alert-rules-form__submit">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {editingId ? 'Update' : 'Create'} Rule
            </button>
          </div>
        </form>
      )}

      {/* Rules List */}
      <div className="alert-rules-list">
        {rules.map(rule => (
          <div key={rule.id} className={`alert-rules-item ${!rule.enabled ? 'alert-rules-item--disabled' : ''}`}>
            <div className="alert-rules-item__toggle">
              <label className="alert-rules-toggle">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => handleToggle(rule.id, e.target.checked)}
                />
                <span className="alert-rules-toggle__slider" />
              </label>
            </div>
            <div className="alert-rules-item__info">
              <div className="alert-rules-item__header">
                <span className="alert-rules-item__name">{rule.name}</span>
                <span
                  className="alert-rules-item__priority"
                  style={{ color: getPriorityColor(rule.priority) }}
                >
                  {rule.priority}
                </span>
              </div>
              <div className="alert-rules-item__condition">
                {getConditionLabel(rule.conditions)}
                {rule.conditions.criticalOnly && ' (critical only)'}
                {rule.duration > 0 && ` for ${rule.duration}s`}
              </div>
              {rule.description && (
                <div className="alert-rules-item__desc">{rule.description}</div>
              )}
            </div>
            <div className="alert-rules-item__actions">
              <button onClick={() => handleEdit(rule)} title="Edit rule">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              <button onClick={() => handleDelete(rule.id)} title="Delete rule">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default AlertRulesPanel
