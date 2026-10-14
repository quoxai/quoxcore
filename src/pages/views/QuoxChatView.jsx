/**
 * QuoxChatView — Widget list + create wizard
 *
 * CW-2: Main entry point for QuoxChat plugin.
 * Shows all widgets for the current org with create button.
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import EvolutionStagePill from '../../components/automation/EvolutionStagePill'
import OnboardingWizard from '../../components/assistant-editor/tabs/chatbot/OnboardingWizard'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import './quoxchat.css'

function validateWidget(widget) {
  const errors = []
  if (!widget.name?.trim()) errors.push('Name is required')
  if (widget.name?.length > 50) errors.push('Name must be 50 characters or less')
  if (!widget.greeting?.trim()) errors.push('Greeting message is required')
  if (!widget.domain?.trim()) errors.push('At least one domain is required')
  return errors
}

export default function QuoxChatView() {
  const navigate = useNavigate()
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id

  const [widgets, setWidgets] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', greeting: 'Hi! How can I help?', domain: '' })
  const [createErrors, setCreateErrors] = useState([])
  const [creating, setCreating] = useState(false)

  // Load widgets
  useEffect(() => {
    if (!authFetch || !orgId) return
    setLoading(true)
    authFetch(`/api/orgs/${orgId}/widgets`)
      .then(r => r.ok ? r.json() : { items: [] })
      .then(data => {
        setWidgets(data.items || data.widgets || [])
      })
      .catch(() => setWidgets([]))
      .finally(() => setLoading(false))
  }, [authFetch, orgId])

  const handleCreate = async () => {
    const errors = validateWidget(createForm)
    if (errors.length > 0) { setCreateErrors(errors); return }

    setCreating(true)
    setCreateErrors([])
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createForm.name,
          greeting: createForm.greeting,
          domain: createForm.domain,
        })
      })
      if (resp.ok) {
        const data = await resp.json()
        const newId = data.widget?.id || data.id
        if (newId) {
          navigate(`/quoxchat/${newId}`)
        } else {
          setShowCreate(false)
          setCreateForm({ name: '', greeting: 'Hi! How can I help?', domain: '' })
          // Reload list
          window.location.reload()
        }
      } else {
        const err = await resp.json().catch(() => ({}))
        setCreateErrors([err.error || 'Failed to create widget'])
      }
    } catch (err) {
      setCreateErrors([err.message])
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="quoxchat-view">
      {/* Header */}
      <div className="quoxchat-header">
        <div className="quoxchat-header__info">
          <h1 className="quoxchat-header__title">
            <span className="quoxchat-header__icon">💬</span>
            QuoxChat
          </h1>
          <p className="quoxchat-header__subtitle">AI chat widgets for your websites</p>
          <EvolutionStagePill currentStage="chat" style={{ marginTop: 8 }} />
        </div>
        <button className="quoxchat-btn quoxchat-btn--primary" onClick={() => setShowCreate(true)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Widget
        </button>
      </div>

      {/* Create wizard */}
      {showCreate && (
        <div className="quoxchat-create">
          <div className="quoxchat-create__header">
            <h2>Create Chat Widget</h2>
            <button className="quoxchat-btn quoxchat-btn--ghost" onClick={() => { setShowCreate(false); setCreateErrors([]) }}>×</button>
          </div>

          {createErrors.length > 0 && (
            <div className="quoxchat-errors">
              {createErrors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          <div className="quoxchat-form">
            <div className="quoxchat-field">
              <label>Widget Name</label>
              <input type="text" value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g., Support Assistant" maxLength={50} />
            </div>
            <div className="quoxchat-field">
              <label>Greeting Message</label>
              <input type="text" value={createForm.greeting} onChange={e => setCreateForm(f => ({ ...f, greeting: e.target.value }))} placeholder="Hi! How can I help?" />
            </div>
            <div className="quoxchat-field">
              <label>Website Domain</label>
              <input type="text" value={createForm.domain} onChange={e => setCreateForm(f => ({ ...f, domain: e.target.value }))} placeholder="e.g., acme.com" />
              <span className="quoxchat-hint">The domain where this widget will be embedded</span>
            </div>
          </div>

          <div className="quoxchat-create__actions">
            <button className="quoxchat-btn quoxchat-btn--ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="quoxchat-btn quoxchat-btn--primary" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Widget'}
            </button>
          </div>
        </div>
      )}

      {/* Widget list */}
      {loading ? (
        <div className="quoxchat-loading">Loading widgets...</div>
      ) : widgets.length === 0 && !showCreate ? (
        <OnboardingWizard
          authFetch={authFetch}
          orgId={orgId}
          onComplete={(newId) => { if (newId) navigate(`/quoxchat/${newId}`) }}
        />
      ) : (
        <div className="quoxchat-grid">
          {widgets.map(w => {
            const config = w.embed_config || JSON.parse(w.embed_config_json || '{}')
            const domains = w.allowed_domains || JSON.parse(w.allowed_domains_json || '[]')
            const persona = w.persona || JSON.parse(w.persona_json || '{}')
            return (
              <div key={w.id} className="quoxchat-card" onClick={() => navigate(`/quoxchat/${w.id}`)}>
                <div className="quoxchat-card__header">
                  <div className="quoxchat-card__avatar" style={{ borderColor: persona.color || '#30ff90' }}>
                    {w.name?.slice(0, 2) || '💬'}
                  </div>
                  <div className="quoxchat-card__info">
                    <div className="quoxchat-card__name">{w.name}</div>
                    <div className="quoxchat-card__domain">{domains[0] || 'No domain set'}</div>
                  </div>
                  <span className={`quoxchat-card__status quoxchat-card__status--${w.status || 'draft'}`}>
                    {w.status || 'draft'}
                  </span>
                </div>
                <div className="quoxchat-card__meta">
                  <span>Conversations: {w.conversation_count != null && Number.isFinite(Number(w.conversation_count)) ? Number(w.conversation_count) : '–'}</span>
                  {w.notification_failed_count > 0 && <span style={{ color: '#ff8a8a' }}>{w.notification_failed_count} failed notification{w.notification_failed_count === 1 ? '' : 's'}</span>}
                  <span>Created {new Date(w.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
