/**
 * RoutingRulesPanel — CRUD interface for routing rules.
 * Sortable list by priority, match condition badges, target user/role badges,
 * create/edit/delete, enable/disable toggle.
 */

import { useState, useCallback } from 'react'
import { useRoutingRules } from '../../hooks/useRoutingRules'
import RoutingRuleEditor from './RoutingRuleEditor'
import './comms-layout.css'

const KIND_COLORS = {
  approval: '#f59e0b',
  question: '#3b82f6',
  task: '#10b981',
  incident: '#ef4444',
  info: '#8b5cf6',
  override_required: '#ec4899',
}

function MatchBadges({ match }) {
  if (!match) return <span className="comms-badge comms-badge--neutral">Catch-all</span>

  const badges = []

  if (match.kind) {
    const kinds = Array.isArray(match.kind) ? match.kind : [match.kind]
    kinds.forEach(k => {
      badges.push(
        <span key={`kind-${k}`} className="comms-badge" style={{ background: `${KIND_COLORS[k] || '#666'}22`, color: KIND_COLORS[k] || '#666' }}>
          {k}
        </span>
      )
    })
  }

  if (match.priority) {
    const priorities = Array.isArray(match.priority) ? match.priority : [match.priority]
    priorities.forEach(p => {
      badges.push(
        <span key={`pri-${p}`} className="comms-badge comms-badge--warning">{p}</span>
      )
    })
  }

  if (match.tags?.length) {
    match.tags.forEach(t => {
      badges.push(
        <span key={`tag-${t}`} className="comms-badge comms-badge--info">{t}</span>
      )
    })
  }

  return badges.length > 0 ? <>{badges}</> : <span className="comms-badge comms-badge--neutral">Catch-all</span>
}

function TargetBadges({ route }) {
  if (!route) return null

  const badges = []

  if (route.role) {
    badges.push(
      <span key="role" className="comms-badge comms-badge--info">{route.role}</span>
    )
  }

  if (route.team_id) {
    badges.push(
      <span key="team" className="comms-badge comms-badge--neutral">Team</span>
    )
  }

  if (route.user_ids?.length) {
    badges.push(
      <span key="users" className="comms-badge comms-badge--neutral">
        {route.user_ids.length} user{route.user_ids.length !== 1 ? 's' : ''}
      </span>
    )
  }

  return badges.length > 0 ? <>{badges}</> : null
}

export default function RoutingRulesPanel() {
  const { rules, loading, error, createRule, updateRule, deleteRule, toggleEnabled, refresh } = useRoutingRules()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRule, setEditingRule] = useState(null)

  const handleCreate = useCallback(() => {
    setEditingRule(null)
    setEditorOpen(true)
  }, [])

  const handleEdit = useCallback((rule) => {
    setEditingRule(rule)
    setEditorOpen(true)
  }, [])

  const handleSave = useCallback(async (ruleData) => {
    if (editingRule) {
      const ok = await updateRule(editingRule.id, ruleData)
      if (ok) setEditorOpen(false)
    } else {
      const created = await createRule(ruleData)
      if (created) setEditorOpen(false)
    }
  }, [editingRule, updateRule, createRule])

  const handleDelete = useCallback(async (ruleId) => {
    if (!confirm('Delete this routing rule?')) return
    await deleteRule(ruleId)
  }, [deleteRule])

  const handleToggle = useCallback(async (rule) => {
    await toggleEnabled(rule.id, !rule.enabled)
  }, [toggleEnabled])

  const parseJson = (val) => {
    if (!val) return null
    if (typeof val === 'object') return val
    try { return JSON.parse(val) } catch { return null }
  }

  return (
    <div>
      <div className="comms-content__header">
        <h2 className="comms-content__title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
            <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
            <line x1="4" y1="4" x2="9" y2="9"/>
          </svg>
          Routing Rules
        </h2>
        <button className="comms-btn comms-btn--primary" onClick={handleCreate}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Create Rule
        </button>
      </div>

      {error && (
        <div className="comms-badge comms-badge--error" style={{ marginBottom: 12, padding: '8px 12px' }}>{error}</div>
      )}

      {loading ? (
        <div className="comms-loading">
          <svg className="corecomms-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20"/>
          </svg>
          Loading rules...
        </div>
      ) : rules.length === 0 ? (
        <div className="comms-empty">
          <div className="comms-empty__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
              <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
            </svg>
          </div>
          <p>No routing rules configured. Create a rule to control who receives notifications.</p>
          <button className="comms-btn comms-btn--primary" onClick={handleCreate}>Create First Rule</button>
        </div>
      ) : (
        <div className="comms-rules-list">
          {rules.map(rule => {
            const match = parseJson(rule.match_json)
            const route = parseJson(rule.route_json)
            return (
              <div key={rule.id} className="comms-rule-row" onClick={() => handleEdit(rule)}>
                <div className="comms-rule-row__priority">#{rule.priority || 100}</div>
                <div className="comms-rule-row__name">{rule.name || 'Unnamed Rule'}</div>
                <div className="comms-rule-row__conditions">
                  <MatchBadges match={match} />
                </div>
                <div className="comms-rule-row__targets">
                  <TargetBadges route={route} />
                </div>
                <div className="comms-rule-row__actions" onClick={e => e.stopPropagation()}>
                  <label className="corecomms-toggle">
                    <input
                      type="checkbox"
                      checked={!!rule.enabled}
                      onChange={() => handleToggle(rule)}
                    />
                    <span className="corecomms-toggle__slider"></span>
                  </label>
                  <button
                    className="comms-btn comms-btn--ghost comms-btn--sm comms-btn--danger"
                    onClick={() => handleDelete(rule.id)}
                    title="Delete rule"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editorOpen && (
        <RoutingRuleEditor
          rule={editingRule}
          onSave={handleSave}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  )
}
