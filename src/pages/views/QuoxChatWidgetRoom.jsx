/**
 * QuoxChatWidgetRoom — 10-tab management environment for a single widget
 *
 * CW-2: The Widget Room — a Data Room-style management interface.
 * Tabs: Knowledge, Training, Style, Actions, Simulation, Availability,
 * Logs, Analytics, Settings, Compliance
 */

import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import KnowledgeTab from '../../components/assistant-editor/tabs/chatbot/KnowledgeTab'
import TrainingTab from '../../components/assistant-editor/tabs/chatbot/TrainingTab'
import LogsTab from '../../components/assistant-editor/tabs/chatbot/LogsTab'
import AnalyticsTab from '../../components/assistant-editor/tabs/chatbot/AnalyticsTab'
import SettingsTab from '../../components/assistant-editor/tabs/chatbot/SettingsTab'
import ActionsTab from '../../components/assistant-editor/tabs/chatbot/ActionsTab'
import SimulationTab from '../../components/assistant-editor/tabs/chatbot/SimulationTab'
import StyleTab from '../../components/assistant-editor/tabs/chatbot/StyleTab'
import ComplianceTab from '../../components/assistant-editor/tabs/chatbot/ComplianceTab'
import AvailabilityTab from '../../components/assistant-editor/tabs/chatbot/AvailabilityTab'
import GoLiveControl from '../../components/assistant-editor/tabs/chatbot/GoLiveControl'
import NotificationFailedBanner from '../../components/assistant-editor/tabs/chatbot/NotificationFailedBanner'
import RetrievalDegradedBanner from '../../components/assistant-editor/tabs/chatbot/RetrievalDegradedBanner'
import OnboardingWizard from '../../components/assistant-editor/tabs/chatbot/OnboardingWizard'
import ModeToggle from '../../components/assistant-editor/tabs/chatbot/ModeToggle'
import { computeCompletion, resolveDefaultMode, wizardStepToTab } from '../../widget/completionUtils'
import { publishBreadcrumbLeaf } from '../../components/layout/breadcrumbLeaf'
import { alertsUnconfigured, WIDGET_ROOM_TABS, resolveTabParam, withTabParam, fullEditorState } from './widgetRoomTabs'
// Tab blurbs live here, not in widgetRoomTabs.js: that module is reached from
// the free build (OnboardingWizard via completionUtils), and these strings are
// the plugin's dist-scan markers (scripts/strip-markers.mjs).
const TAB_DESC = {
  knowledge: 'Train on your content',
  training: 'Tune personality & test',
  style: 'Customise appearance',
  actions: 'Connect tools & webhooks',
  simulation: 'Scenario arena + publish gate',
  availability: 'Operator status, office hours, alerts',
  logs: 'Conversation archive',
  analytics: 'Performance metrics',
  settings: 'Domains, LLM, budget',
  compliance: 'Risk tier, retention, DPIA',
}
import './quoxchat.css'

function TabPlaceholder({ tab }) {
  return (
    <div className="wr-placeholder">
      <div className="wr-placeholder__icon">{tab.icon}</div>
      <h3 className="wr-placeholder__title">{tab.label}</h3>
      <p className="wr-placeholder__desc">{TAB_DESC[tab.id]}</p>
      <p className="wr-placeholder__note">Coming in a future CW phase</p>
    </div>
  )
}

export default function QuoxChatWidgetRoom() {
  const { widgetId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { authFetch, user } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id

  const [widget, setWidget] = useState(null)
  const [stats, setStats] = useState({})
  const [loading, setLoading] = useState(true)
  // W12: non-OK load (429/5xx) or network failure shows an error + Retry
  // instead of a permanent "Widget not found" / "Loading..." state.
  const [loadError, setLoadError] = useState(null)
  const [reloadTick, setReloadTick] = useState(0)
  // Tab state lives in the URL (?tab=logs) so tabs are linkable and survive reload.
  const activeTab = resolveTabParam(searchParams.get('tab'))
  const setActiveTab = (id) => setSearchParams(withTabParam(searchParams, id), { replace: false })
  const [mode, setMode] = useState(null) // resolved after widget loads
  // QUOXCHAT-PRO P3: live handoff surfacing. Currently handed-off
  // conversations (status = handed_off) polled every 60s so the header can
  // show a one-click jump to the live Matrix room(s).
  const [liveConvs, setLiveConvs] = useState([])
  const [alertNudgeDismissed, setAlertNudgeDismissed] = useState(() => {
    try { return window.sessionStorage?.getItem(`quoxchat.alertNudge.${widgetId}`) === '1' } catch { return false }
  })

  // CW quick-win B6: the room historically only accepted the internal ULID.
  // Pasting the public wid_ id (the one shown in the embed snippet) gave
  // "Widget not found". Resolve wid_ ids client-side via the widgets list
  // search filter (matches public_key), then replace the URL with the
  // internal id so every other effect below keeps working unmodified.
  useEffect(() => {
    if (!authFetch || !orgId || !widgetId || !widgetId.startsWith('wid_')) return
    let cancelled = false
    authFetch(`/api/orgs/${orgId}/widgets?search=${encodeURIComponent(widgetId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled) return
        const items = Array.isArray(data?.items) ? data.items : []
        const match = items.find(w => w.public_key === widgetId)
        if (match?.id) {
          const qs = searchParams.toString()
          navigate(`/quoxchat/${match.id}${qs ? `?${qs}` : ''}`, { replace: true })
        } else {
          setLoading(false)
        }
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [authFetch, orgId, widgetId, searchParams, navigate])

  const resolvingPublicId = !!(widgetId && widgetId.startsWith('wid_'))

  // Load widget data
  useEffect(() => {
    if (!authFetch || !orgId || !widgetId || resolvingPublicId) return
    setLoading(true)
    setLoadError(null)
    authFetch(`/api/orgs/${orgId}/widgets/${widgetId}`)
      .then(async r => {
        if (r.ok) {
          const data = await r.json()
          setWidget(data?.widget || null)
        } else if (r.status === 404) {
          setWidget(null)
        } else {
          setWidget(null)
          setLoadError(`Could not load this widget (HTTP ${r.status}).`)
        }
      })
      .catch((err) => { setWidget(null); setLoadError(`Could not load this widget (${err?.message || 'network error'}).`) })
      .finally(() => setLoading(false))
  }, [authFetch, orgId, widgetId, resolvingPublicId, reloadTick])

  // Load stats for completion calc
  useEffect(() => {
    if (!authFetch || !orgId || !widgetId || resolvingPublicId) return
    authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/knowledge/stats`)
      .then(r => r.ok ? r.json() : {})
      .then(d => setStats(d || {}))
      .catch(() => setStats({}))
  }, [authFetch, orgId, widgetId, resolvingPublicId])

  // Poll currently handed-off conversations (60s) for the header live pill.
  useEffect(() => {
    if (!authFetch || !orgId || !widgetId || resolvingPublicId) return
    let cancelled = false
    const load = () => {
      authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/conversations?status=handed_off&limit=100&exclude_test=1`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled || !data) return
          const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
          setLiveConvs(rows)
        })
        .catch(() => { /* non-fatal: pill just stays hidden */ })
    }
    load()
    const t = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [authFetch, orgId, widgetId, resolvingPublicId])

  // Breadcrumb shows the widget name, not the ULID in the URL.
  useEffect(() => {
    if (!widget?.name || !widget?.id) return
    const path = `/quoxchat/${widgetId}`
    publishBreadcrumbLeaf(path, widget.name)
    return () => publishBreadcrumbLeaf(path, null)
  }, [widget?.name, widget?.id, widgetId])

  const completion = useMemo(() => computeCompletion(widget || {}, stats), [widget, stats])

  // One click from the header to the live operator room(s) in Matrix Rooms.
  // A single live conversation with a provisioned room deep-links straight to
  // it; anything else lands on the Rooms QuoxChat tab.
  const handleOpenLiveRooms = () => {
    const withRoom = liveConvs.filter(c => c.matrix_room_id)
    if (liveConvs.length === 1 && withRoom.length === 1) {
      navigate('/matrix-comms', { state: { quoxchatRoomId: withRoom[0].matrix_room_id, conversationId: withRoom[0].id } })
    } else {
      navigate('/matrix-comms', { state: { quoxchatTab: true } })
    }
  }

  // "Handoff is on but nobody gets alerted" — handoff tool active, yet the
  // handoff_requested event has no enabled delivery channel. Recomputes when
  // AvailabilityTab saves (onWidgetChange merges the PATCHed widget back).
  const handoffAlertsUnconfigured = useMemo(() => {
    if (!widget) return false
    return alertsUnconfigured(widget.notification_settings_json ?? widget.notification_settings)
  }, [widget])

  const dismissAlertNudge = () => {
    setAlertNudgeDismissed(true)
    try { window.sessionStorage?.setItem(`quoxchat.alertNudge.${widgetId}`, '1') } catch {}
  }

  const goToAlertsSection = () => {
    changeMode('advanced')
    setActiveTab('availability')
    // Panel renders on the next frame; then bring the alerts section into view.
    setTimeout(() => {
      document.getElementById('wr-alerts-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }

  // Resolve default mode once widget + stats settle
  useEffect(() => {
    if (!widget || mode !== null) return
    const storageKey = `quoxchat.mode.${widgetId}`
    const stored = typeof window !== 'undefined' ? window.sessionStorage?.getItem(storageKey) : null
    const urlParam = searchParams.get('mode')
    setMode(resolveDefaultMode({ widget, completion, urlParam, stored, tabParam: searchParams.get('tab') }))
  }, [widget, completion, widgetId, searchParams, mode])

  const changeMode = (next) => {
    setMode(next)
    try { window.sessionStorage?.setItem(`quoxchat.mode.${widgetId}`, next) } catch {}
  }

  // Every tab that PATCHes the widget reports the server response here so the
  // shared state never goes stale (cross-tab config overwrite fix).
  const handleWidgetChange = (w) => setWidget(prev => ({ ...(prev || {}), ...(w || {}) }))

  const handleWizardComplete = (id, lastStepId) => {
    changeMode('advanced')
    if (lastStepId) setActiveTab(wizardStepToTab(lastStepId))
  }

  if (loading) {
    return (
      <div className="quoxchat-view">
        <div className="quoxchat-loading">Loading widget...</div>
      </div>
    )
  }

  if (!widget && loadError) {
    return (
      <div className="quoxchat-view">
        <div className="quoxchat-empty" role="alert">
          <div className="quoxchat-empty__icon">⚠️</div>
          <h2>Widget unavailable</h2>
          <p>{loadError}</p>
          <button className="quoxchat-btn quoxchat-btn--primary glass-btn" onClick={() => setReloadTick(t => t + 1)}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!widget) {
    return (
      <div className="quoxchat-view">
        <div className="quoxchat-empty">
          <div className="quoxchat-empty__icon">❌</div>
          <h2>Widget not found</h2>
          <p>This widget may have been deleted or you don't have access.</p>
          <button className="quoxchat-btn quoxchat-btn--primary" onClick={() => navigate('/quoxchat')}>
            Back to Widgets
          </button>
        </div>
      </div>
    )
  }

  const persona = widget.persona || JSON.parse(widget.persona_json || '{}')
  const config = widget.embed_config || JSON.parse(widget.embed_config_json || '{}')
  const domains = widget.allowed_domains || JSON.parse(widget.allowed_domains_json || '[]')
  const activeTabDef = WIDGET_ROOM_TABS.find(t => t.id === activeTab)

  return (
    <div className="quoxchat-view">
      {/* Widget Room Header */}
      <div className="wr-header">
        <button className="quoxchat-btn quoxchat-btn--ghost wr-back" onClick={() => navigate('/quoxchat')}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back
        </button>
        <div className="wr-header__avatar" style={{ borderColor: persona.color || '#30ff90' }}>
          {persona.shortName || widget.name?.slice(0, 2) || '💬'}
        </div>
        <div className="wr-header__info">
          <h1 className="wr-header__name">{widget.name}</h1>
          <span className="wr-header__domain">{domains[0] || 'No domain'}</span>
          <GoLiveControl
            widget={widget}
            authFetch={authFetch}
            orgId={orgId}
            onWidgetChange={(w) => setWidget(prev => ({ ...(prev || {}), ...(w || {}) }))}
          />
          {/* QUOXCHAT-PRO P1: live operator status, one click from anywhere
              in the room to the go-offline override on the Availability tab. */}
          {(() => {
            const operatorOnline = widget.operator_online === undefined || widget.operator_online === null
              ? true
              : !!Number(widget.operator_online)
            return (
              <button
                type="button"
                className={`wr-header__operator ${operatorOnline ? 'wr-header__operator--online' : 'wr-header__operator--offline'}`}
                onClick={() => { changeMode('advanced'); setActiveTab('availability') }}
                title="Operator availability. Click to manage status, office hours and alerts."
              >
                <span className="wr-header__operator-dot" aria-hidden="true" />
                {operatorOnline ? 'Operator online' : 'Operator offline'}
              </button>
            )
          })()}
          {/* QUOXCHAT-PRO P3: prominent live-handoff surface. Visible from
              every tab; one click to the live Matrix room (single) or the
              Rooms QuoxChat tab (several). */}
          {liveConvs.length > 0 && (
            <button
              type="button"
              className="wr-header__live"
              onClick={handleOpenLiveRooms}
              title={liveConvs.length === 1
                ? 'A visitor is waiting in a live handoff. Open the operator room in Matrix Rooms.'
                : `${liveConvs.length} conversations are handed off to your team. Open the Rooms QuoxChat tab.`}
            >
              <span className="wr-header__live-dot" aria-hidden="true" />
              {liveConvs.length === 1 ? '1 live conversation' : `${liveConvs.length} live conversations`}
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
            </button>
          )}
        </div>
        <div className="wr-header__actions" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ModeToggle mode={mode || 'advanced'} onChange={changeMode} completion={completion} />
          <button
            className="quoxchat-btn quoxchat-btn--ghost"
            onClick={() => navigate(`/settings`, { state: fullEditorState(widget) })}
            title="Open the backing assistant in the full Settings editor"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
            Full Editor
          </button>
        </div>
      </div>

      <NotificationFailedBanner widget={widget} />
      <RetrievalDegradedBanner widget={widget} />

      {mode === 'wizard' ? (
        <div className="wr-content">
          <OnboardingWizard
            existingWidget={widget}
            completion={completion}
            authFetch={authFetch}
            orgId={orgId}
            onComplete={(id) => handleWizardComplete(id, 'embed')}
          />
        </div>
      ) : (
        <>
      {/* Tab Navigation */}
      <div className="wr-tabs">
        {WIDGET_ROOM_TABS.map(tab => (
          <button
            key={tab.id}
            className={`wr-tab ${activeTab === tab.id ? 'wr-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            title={TAB_DESC[tab.id]}
          >
            <span className="wr-tab__icon">{tab.icon}</span>
            <span className="wr-tab__label">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="wr-content">
        {/* Alerts-discoverability nudge: handoff tool is live but the
            handoff_requested event has no delivery channel, so a visitor
            asking for a human alerts nobody. Shown on the two tabs where an
            operator would look for live traffic (Logs, Availability). */}
        {handoffAlertsUnconfigured && !alertNudgeDismissed && (
          <div className="wr-nudge" role="note">
            <span className="wr-nudge__icon" aria-hidden="true">🔔</span>
            <div className="wr-nudge__body">
              <strong>Handoffs and leads land in the inbox but nobody is alerted: set up alerts.</strong>
              <span>
                No email or webhook is set for "Human handoff requested" or "New conversation",
                so requests can sit unnoticed.
              </span>
            </div>
            <button type="button" className="quoxchat-btn quoxchat-btn--primary wr-nudge__cta" onClick={goToAlertsSection}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              Set up alerts
            </button>
            <button type="button" className="wr-nudge__dismiss" onClick={dismissAlertNudge} title="Dismiss for this session" aria-label="Dismiss">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        )}
        {activeTab === 'knowledge' ? (
          <KnowledgeTab widget={widget} authFetch={authFetch} orgId={orgId} onWidgetChange={handleWidgetChange} />
        ) : activeTab === 'training' ? (
          <TrainingTab widget={widget} authFetch={authFetch} orgId={orgId} onWidgetChange={handleWidgetChange} correctedBy={user?.email || user?.primary_email || null} />
        ) : activeTab === 'logs' ? (
          <LogsTab widget={widget} authFetch={authFetch} orgId={orgId} correctedBy={user?.email || user?.primary_email || null} />
        ) : activeTab === 'analytics' ? (
          <AnalyticsTab widget={widget} authFetch={authFetch} orgId={orgId} />
        ) : activeTab === 'settings' ? (
          <SettingsTab
            widget={widget}
            authFetch={authFetch}
            orgId={orgId}
            onWidgetChange={(w) => setWidget(prev => ({ ...(prev || {}), ...(w || {}) }))}
            onDeleted={() => navigate('/quoxchat')}
          />
        ) : activeTab === 'actions' ? (
          <ActionsTab widget={widget} authFetch={authFetch} orgId={orgId} onWidgetChange={handleWidgetChange} />
        ) : activeTab === 'simulation' ? (
          <SimulationTab widget={widget} authFetch={authFetch} orgId={orgId} onWidgetChange={handleWidgetChange} />
        ) : activeTab === 'style' ? (
          <StyleTab widget={widget} authFetch={authFetch} orgId={orgId} onWidgetChange={handleWidgetChange} />
        ) : activeTab === 'compliance' ? (
          <ComplianceTab widget={widget} authFetch={authFetch} orgId={orgId} onWidgetChange={handleWidgetChange} />
        ) : activeTab === 'availability' ? (
          <AvailabilityTab
            widget={widget}
            authFetch={authFetch}
            orgId={orgId}
            // PATCH responses omit the assistant-join fields (persona_json,
            // assistant_name), so merge instead of replacing room state.
            onWidgetChange={(w) => setWidget(prev => ({ ...(prev || {}), ...(w || {}) }))}
          />
        ) : activeTabDef ? (
          <TabPlaceholder tab={activeTabDef} />
        ) : null}
      </div>
        </>
      )}
    </div>
  )
}
