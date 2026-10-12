/**
 * RoutingRuleEditor — Modal for creating/editing routing rules.
 * Match builder (kind, priority, tags) + target builder (user_ids, role, team_id).
 */

import { useState, useCallback } from 'react'
import './comms-layout.css'

const KINDS = ['approval', 'question', 'task', 'incident', 'info', 'override_required']
const PRIORITIES = ['urgent', 'high', 'normal', 'low']
const ROLES = ['owner', 'admin', 'member']

export default function RoutingRuleEditor({ rule, onSave, onClose }) {
  const parseJson = (val) => {
    if (!val) return {}
    if (typeof val === 'object') return val
    try { return JSON.parse(val) } catch { return {} }
  }

  const match = parseJson(rule?.match_json)
  const route = parseJson(rule?.route_json)

  const [name, setName] = useState(rule?.name || '')
  const [description, setDescription] = useState(rule?.description || '')
  const [priority, setPriority] = useState(rule?.priority || 100)
  const [selectedKinds, setSelectedKinds] = useState(
    match.kind ? (Array.isArray(match.kind) ? match.kind : [match.kind]) : []
  )
  const [selectedPriorities, setSelectedPriorities] = useState(
    match.priority ? (Array.isArray(match.priority) ? match.priority : [match.priority]) : []
  )
  const [tags, setTags] = useState(match.tags?.join(', ') || '')
  const [targetRole, setTargetRole] = useState(route.role || '')
  const [targetUserIds, setTargetUserIds] = useState(route.user_ids?.join(', ') || '')
  const [targetTeamId, setTargetTeamId] = useState(route.team_id || '')
  const [saving, setSaving] = useState(false)

  const toggleKind = useCallback((kind) => {
    setSelectedKinds(prev =>
      prev.includes(kind) ? prev.filter(k => k !== kind) : [...prev, kind]
    )
  }, [])

  const togglePriority = useCallback((pri) => {
    setSelectedPriorities(prev =>
      prev.includes(pri) ? prev.filter(p => p !== pri) : [...prev, pri]
    )
  }, [])

  const handleSave = useCallback(async () => {
    if (!name.trim()) return

    setSaving(true)

    const matchJson = {}
    if (selectedKinds.length > 0) matchJson.kind = selectedKinds
    if (selectedPriorities.length > 0) matchJson.priority = selectedPriorities
    const tagList = tags.split(',').map(t => t.trim()).filter(Boolean)
    if (tagList.length > 0) matchJson.tags = tagList

    const routeJson = {}
    if (targetRole) routeJson.role = targetRole
    if (targetTeamId.trim()) routeJson.team_id = targetTeamId.trim()
    const userIdList = targetUserIds.split(',').map(u => u.trim()).filter(Boolean)
    if (userIdList.length > 0) routeJson.user_ids = userIdList

    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        priority: parseInt(priority) || 100,
        match_json: matchJson,
        route_json: routeJson,
        enabled: rule?.enabled !== undefined ? rule.enabled : true
      })
    } finally {
      setSaving(false)
    }
  }, [name, description, priority, selectedKinds, selectedPriorities, tags, targetRole, targetUserIds, targetTeamId, rule, onSave])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'var(--glass-blur)'
    }} onClick={onClose}>
      <div className="glass" style={{
        padding: 24, width: '100%', maxWidth: 520, maxHeight: '80vh', overflowY: 'auto'
      }} onClick={e => e.stopPropagation()}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>{rule ? 'Edit Rule' : 'Create Routing Rule'}</h3>
          <button className="comms-btn comms-btn--ghost comms-btn--sm" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="comms-rule-editor">
          {/* Name */}
          <div className="corecomms-field">
            <label className="corecomms-field__label">Rule Name</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="e.g., Urgent incidents to admins"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="corecomms-field">
            <label className="corecomms-field__label">Description (optional)</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="Describe what this rule does"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          {/* Priority */}
          <div className="corecomms-field corecomms-field--small">
            <label className="corecomms-field__label">Rule Priority (lower = evaluated first)</label>
            <input
              type="number"
              className="corecomms-field__input"
              value={priority}
              onChange={e => setPriority(e.target.value)}
              min={1}
              max={999}
            />
          </div>

          {/* Match: Kind */}
          <div className="comms-rule-editor__section">
            <div className="comms-rule-editor__section-title">Match Conditions — Event Kind</div>
            <div className="comms-rule-editor__multi-select">
              {KINDS.map(k => (
                <button
                  key={k}
                  className={`comms-rule-editor__chip${selectedKinds.includes(k) ? ' comms-rule-editor__chip--selected' : ''}`}
                  onClick={() => toggleKind(k)}
                  type="button"
                >
                  {k}
                </button>
              ))}
            </div>
            <span className="corecomms-field__help">Leave empty to match all event kinds</span>
          </div>

          {/* Match: Priority */}
          <div className="comms-rule-editor__section">
            <div className="comms-rule-editor__section-title">Match Conditions — Priority</div>
            <div className="comms-rule-editor__multi-select">
              {PRIORITIES.map(p => (
                <button
                  key={p}
                  className={`comms-rule-editor__chip${selectedPriorities.includes(p) ? ' comms-rule-editor__chip--selected' : ''}`}
                  onClick={() => togglePriority(p)}
                  type="button"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Match: Tags */}
          <div className="corecomms-field">
            <label className="corecomms-field__label">Match Tags (comma-separated, optional)</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="e.g., production, critical-path"
              value={tags}
              onChange={e => setTags(e.target.value)}
            />
          </div>

          {/* Target: Role */}
          <div className="comms-rule-editor__section">
            <div className="comms-rule-editor__section-title">Target — Role</div>
            <div className="comms-rule-editor__multi-select">
              <button
                className={`comms-rule-editor__chip${!targetRole ? ' comms-rule-editor__chip--selected' : ''}`}
                onClick={() => setTargetRole('')}
                type="button"
              >
                None
              </button>
              {ROLES.map(r => (
                <button
                  key={r}
                  className={`comms-rule-editor__chip${targetRole === r ? ' comms-rule-editor__chip--selected' : ''}`}
                  onClick={() => setTargetRole(targetRole === r ? '' : r)}
                  type="button"
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Target: Team ID */}
          <div className="corecomms-field">
            <label className="corecomms-field__label">Target Team ID (optional)</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="Team ID"
              value={targetTeamId}
              onChange={e => setTargetTeamId(e.target.value)}
            />
          </div>

          {/* Target: User IDs */}
          <div className="corecomms-field">
            <label className="corecomms-field__label">Target User IDs (comma-separated, optional)</label>
            <input
              type="text"
              className="corecomms-field__input"
              placeholder="user-id-1, user-id-2"
              value={targetUserIds}
              onChange={e => setTargetUserIds(e.target.value)}
            />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="comms-btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="comms-btn comms-btn--primary" onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? 'Saving...' : (rule ? 'Update Rule' : 'Create Rule')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
