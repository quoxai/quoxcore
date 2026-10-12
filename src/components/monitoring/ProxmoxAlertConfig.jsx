/**
 * ProxmoxAlertConfig — Alert rules management panel for Proxmox.
 *
 * Renders inside the ProxmoxActions sidebar. Shows active rules with
 * toggle/delete, and a simple form to add new threshold rules.
 */

import { useState, useEffect } from 'react'
import {
  getProxmoxAlertRules,
  addProxmoxAlertRule,
  toggleProxmoxAlertRule,
  deleteProxmoxAlertRule,
  resetToDefaults,
} from '../../services/proxmoxAlertRules'
import './proxmox-alert-config.css'

export function ProxmoxAlertConfig({ collapsed, onToggleCollapsed }) {
  const [rules, setRules] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({
    name: '',
    metric: 'cpu',
    threshold: 90,
    duration: 300,
    priority: 'high',
  })

  useEffect(() => {
    setRules(getProxmoxAlertRules())
  }, [])

  const reload = () => setRules(getProxmoxAlertRules())

  const handleToggle = (id, enabled) => {
    toggleProxmoxAlertRule(id, enabled)
    reload()
  }

  const handleDelete = (id) => {
    deleteProxmoxAlertRule(id)
    reload()
  }

  const handleAdd = () => {
    addProxmoxAlertRule({
      name: form.name || `${form.metric.toUpperCase()} > ${form.threshold}%`,
      description: `Alert when ${form.metric} exceeds ${form.threshold}% for ${Math.floor(form.duration / 60)}m`,
      metric: form.metric,
      operator: '>',
      threshold: form.threshold / 100,
      duration: form.duration,
      cooldown: 600,
      priority: form.priority,
      enabled: true,
      scope: 'all',
    })
    setShowAdd(false)
    setForm({ name: '', metric: 'cpu', threshold: 90, duration: 300, priority: 'high' })
    reload()
  }

  const handleReset = () => {
    resetToDefaults()
    reload()
  }

  const enabledCount = rules.filter(r => r.enabled).length

  return (
    <div className="pxac">
      <button className="pxac-toggle" onClick={onToggleCollapsed}>
        <span className="pxac-toggle__icon">⚠</span>
        <span className="pxac-toggle__label">Alerts</span>
        <span className="pxac-toggle__count">{enabledCount}</span>
        <span className="pxac-toggle__arrow">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="pxac-body">
          {/* Rules list */}
          {rules.map(rule => (
            <div key={rule.id} className={`pxac-rule ${rule.enabled ? '' : 'pxac-rule--disabled'}`}>
              <div className="pxac-rule__main">
                <button
                  className={`pxac-rule__toggle ${rule.enabled ? 'pxac-rule__toggle--on' : ''}`}
                  onClick={() => handleToggle(rule.id, !rule.enabled)}
                  title={rule.enabled ? 'Disable' : 'Enable'}
                >
                  <span className="pxac-rule__toggle-knob" />
                </button>
                <div className="pxac-rule__info">
                  <span className="pxac-rule__name">{rule.name}</span>
                  <span className="pxac-rule__desc">
                    {rule.metric === 'status_change'
                      ? 'On status change'
                      : `${rule.metric} ${rule.operator} ${(rule.threshold * 100).toFixed(0)}% for ${Math.floor(rule.duration / 60)}m`
                    }
                  </span>
                </div>
                <span className={`pxac-rule__priority pxac-rule__priority--${rule.priority}`}>
                  {rule.priority}
                </span>
                <button className="pxac-rule__delete" onClick={() => handleDelete(rule.id)} title="Delete rule">✕</button>
              </div>
            </div>
          ))}

          {/* Add rule form */}
          {showAdd ? (
            <div className="pxac-form">
              <input
                className="pxac-form__input"
                placeholder="Rule name (optional)"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
              <div className="pxac-form__row">
                <select
                  className="pxac-form__select"
                  value={form.metric}
                  onChange={e => setForm(f => ({ ...f, metric: e.target.value }))}
                >
                  <option value="cpu">CPU</option>
                  <option value="memory">Memory</option>
                </select>
                <span className="pxac-form__label">{'>'}</span>
                <input
                  className="pxac-form__input pxac-form__input--small"
                  type="number"
                  min="1"
                  max="100"
                  value={form.threshold}
                  onChange={e => setForm(f => ({ ...f, threshold: parseInt(e.target.value) || 0 }))}
                />
                <span className="pxac-form__label">%</span>
              </div>
              <div className="pxac-form__row">
                <span className="pxac-form__label">for</span>
                <select
                  className="pxac-form__select"
                  value={form.duration}
                  onChange={e => setForm(f => ({ ...f, duration: parseInt(e.target.value) }))}
                >
                  <option value="0">Immediate</option>
                  <option value="60">1 min</option>
                  <option value="300">5 min</option>
                  <option value="600">10 min</option>
                  <option value="900">15 min</option>
                </select>
                <select
                  className="pxac-form__select"
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div className="pxac-form__actions">
                <button className="pxac-form__btn pxac-form__btn--save" onClick={handleAdd}>Add Rule</button>
                <button className="pxac-form__btn" onClick={() => setShowAdd(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="pxac-actions">
              <button className="pxac-add" onClick={() => setShowAdd(true)}>+ Add Rule</button>
              <button className="pxac-reset" onClick={handleReset} title="Reset to defaults">Reset</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ProxmoxAlertConfig
