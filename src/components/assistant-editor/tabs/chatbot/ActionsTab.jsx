/**
 * ActionsTab — Widget Room Actions management (CW-9.7)
 *
 * Surfaces the widget's connectors and tools. Flat-panel grid matching the
 * Knowledge/Logs/Analytics/Training layout introduced in CW-STYLE-2/3.
 *
 * Scope (CW-9.7):
 *   - List + delete tools (connector + builtin)
 *   - List + delete connectors (REST/webhook/database)
 *   - Quick-create for the three builtins (lead_capture, human_handoff, redirect_url)
 *   - Enable/disable toggle per tool
 *   - Usage counters (use_count, error_count, last_used_at)
 *
 * Out of scope (CW-9.7): full connector/tool builder wizard with per-type
 * forms — parking that for a dedicated builder modal in a follow-on.
 * Connector creation surfaces a "Use API" link pointing at the docs so the
 * mechanism is discoverable.
 */

import { useState, useEffect, useCallback } from 'react'
import ConnectorBuilderModal from './ConnectorBuilderModal'
import ToolBuilderModal from './ToolBuilderModal'
import TestToolModal from './TestToolModal'
import ConnectorGalleryModal from './ConnectorGalleryModal'
import EmailNotConnectedNotice from '../../../settings/EmailNotConnectedNotice.jsx'
import { diffEmbedConfig } from './embedConfigPatch'

const BUILTIN_PRESETS = [
  {
    id: 'lead_capture',
    name: 'capture_lead',
    description: 'Capture a visitor\'s contact details for sales follow-up',
    label: 'Capture lead',
    desc: 'Collect name, email, phone, company from the conversation',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Visitor email address' },
        name: { type: 'string', description: 'Visitor full name' },
        intent: { type: 'string', description: 'What the visitor wants: pricing, demo, support, integration question, etc.' },
        phone: { type: 'string', description: 'Visitor phone number' },
        company: { type: 'string', description: 'Visitor company name' },
        notes: { type: 'string', description: 'Additional context worth noting' },
      },
      required: ['email'],
    },
  },
  {
    id: 'human_handoff',
    name: 'hand_off_to_human',
    description: 'Mark the conversation for human follow-up when the assistant can\'t help',
    label: 'Human handoff',
    desc: 'Escalates to a teammate. Visitor sees a holding message.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the handoff is needed' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Urgency' },
      },
    },
  },
  {
    id: 'redirect_url',
    name: 'redirect_visitor',
    description: 'Offer the visitor a link to a relevant page',
    label: 'Redirect URL',
    desc: 'Opens in a new tab. Validated against the widget\'s allowed domains.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute or relative URL to offer' },
        label: { type: 'string', description: 'Button label' },
      },
      required: ['url'],
    },
  },
]

function formatRelative(iso) {
  if (!iso) return 'unknown'
  try {
    const d = new Date(iso)
    const diff = Date.now() - d.getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return d.toLocaleDateString()
  } catch { return 'unknown' }
}

// Human display labels for known builtin_kind values. Covers the quick-add
// presets above plus the PRO-2/PRO-3 system builtins (email_transcript,
// book_appointment, schedule_demo, leave_message) that aren't creatable from
// this tab's quick-add tiles but can still show up in the tools list.
const BUILTIN_LABELS = {
  lead_capture: 'Capture lead',
  human_handoff: 'Human handoff',
  redirect_url: 'Redirect URL',
  email_transcript: 'Email transcript',
  leave_message: 'Leave a message',
  book_appointment: 'Book appointment',
  schedule_demo: 'Schedule demo',
  book_demo: 'Book a demo',
  create_ticket: 'Create ticket',
  send_resource: 'Send resource',
}

function titleiseName(name) {
  const s = String(name || '').replace(/[_-]+/g, ' ').trim()
  if (!s) return 'Untitled tool'
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

// Primary label to show for a tool row: prefer a future display_name field,
// then the builtin labels map, then a short description, then a titleised
// fallback of the machine name for custom (connector-backed) tools.
function toolDisplayLabel(tool) {
  if (tool.display_name) return tool.display_name
  if (tool.tool_type === 'builtin' && BUILTIN_LABELS[tool.builtin_kind]) return BUILTIN_LABELS[tool.builtin_kind]
  if (tool.description && tool.description.length <= 40) return tool.description
  return titleiseName(tool.name)
}

// #129 — mirrors isSideEffectingTool() in services/collector/lib/quoxchatToolExecutors.js.
// Kept in sync manually (no shared module between frontend/collector today).
const SIDE_EFFECT_BUILTIN_RE = /email|send|pay/i

function isSideEffectingTool(tool, connectors) {
  if (!tool) return false
  if (tool.tool_type === 'connector') {
    const connectorType = connectors.find(c => c.id === tool.connector_id)?.connector_type
    if (connectorType === 'webhook') return true
    if (connectorType === 'rest_api') {
      const method = String(tool.config?.method || 'GET').toUpperCase()
      return method !== 'GET'
    }
    return false
  }
  if (tool.tool_type === 'builtin') {
    return SIDE_EFFECT_BUILTIN_RE.test(String(tool.builtin_kind || tool.name || ''))
  }
  return false
}

function TypeBadge({ kind, subtype, label }) {
  const colours = {
    builtin: { bg: 'rgba(48,255,144,0.12)', fg: '#30ff90' },
    rest_api: { bg: 'rgba(168,85,247,0.14)', fg: '#a855f7' },
    webhook: { bg: 'rgba(56,189,248,0.14)', fg: '#38bdf8' },
    database: { bg: 'rgba(245,158,11,0.14)', fg: '#f59e0b' },
    quoxflow: { bg: 'rgba(239,68,68,0.14)', fg: '#ef4444' },
  }
  const c = colours[subtype] || colours[kind] || { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.65)' }
  return (
    <span style={{ padding: '2px 8px', borderRadius: 4, background: c.bg, color: c.fg, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {label || subtype || kind}
    </span>
  )
}

// #P2 Actions unification: one Enabled/Disabled representation, rendered
// once per row (a status pill), paired with exactly one toggle control.
// Used for both real tool rows and not-yet-added builtin preset rows.
function StatusPill({ enabled }) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
      background: enabled ? 'rgba(48,255,144,0.12)' : 'rgba(255,255,255,0.06)',
      color: enabled ? '#30ff90' : 'rgba(255,255,255,0.72)',
    }}>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke={enabled ? '#30ff90' : 'rgba(255,255,255,0.72)'} strokeWidth="3">
        <circle cx="12" cy="12" r="9" fill={enabled ? '#30ff90' : 'none'} />
      </svg>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  )
}

export default function ActionsTab({ widget, authFetch, orgId, onWidgetChange }) {
  const widgetId = widget?.id
  const [tools, setTools] = useState([])
  const [connectors, setConnectors] = useState([])
  const [loading, setLoading] = useState(false)
  // First-paint honesty: the tools list is unknown until the request resolves.
  // toolsLoaded flips true only on a 2xx; toolsError holds a failed load.
  const [toolsLoaded, setToolsLoaded] = useState(false)
  const [toolsError, setToolsError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [showConnectorModal, setShowConnectorModal] = useState(false)
  const [showToolModal, setShowToolModal] = useState(false)
  const [testToolTarget, setTestToolTarget] = useState(null) // QCX-1.4
  const [showGallery, setShowGallery] = useState(false) // QCX-1.5

  // CAPTCHA #127 — Bot protection card state. OFF BY DEFAULT: an
  // unconfigured widget has no embed_config.bot_protection at all, so every
  // field below defaults to the safe/off value.
  const initialBotProtection = widget?.embed_config?.bot_protection
    || JSON.parse(widget?.embed_config_json || '{}')?.bot_protection
    || {}
  const [botEnabled, setBotEnabled] = useState(initialBotProtection.enabled === true)
  const [botProvider, setBotProvider] = useState(initialBotProtection.provider === 'turnstile' ? 'turnstile' : 'recaptcha_v3')
  const [botSiteKey, setBotSiteKey] = useState(initialBotProtection.site_key || '')
  const [botMinScore, setBotMinScore] = useState(Number.isFinite(initialBotProtection.min_score) ? initialBotProtection.min_score : 0.5)
  const [botGuard, setBotGuard] = useState(initialBotProtection.guard === 'all' ? 'all' : 'side_effecting')
  const [botSecretInput, setBotSecretInput] = useState('') // write-only — never pre-filled from the server
  const [botSecretSet, setBotSecretSet] = useState(widget?.captcha_secret_set === true)
  const [botSaving, setBotSaving] = useState(false)
  const [botSaveMsg, setBotSaveMsg] = useState(null)

  // #129 — Tool & action safety card state. OFF BY DEFAULT: a widget with no
  // embed_config.tool_policies has an empty allow-list, blank cap (backend
  // falls back to DEFAULT_DAILY_SIDE_EFFECT_CAP=100), and unverified
  // side-effects denied — i.e. today's evaluateToolPolicy() deny-by-default
  // behaviour is unchanged until an admin explicitly allow-lists a tool here.
  const initialToolPolicies = widget?.embed_config?.tool_policies
    || JSON.parse(widget?.embed_config_json || '{}')?.tool_policies
    || {}
  const [safetyAllowList, setSafetyAllowList] = useState(
    new Set(Array.isArray(initialToolPolicies.side_effect_allow_list) ? initialToolPolicies.side_effect_allow_list : [])
  )
  const [safetyDailyCap, setSafetyDailyCap] = useState(
    Number.isFinite(initialToolPolicies.daily_side_effect_cap) ? String(initialToolPolicies.daily_side_effect_cap) : ''
  )
  const [safetyAllowUnverified, setSafetyAllowUnverified] = useState(initialToolPolicies.allow_unverified_side_effects === true)
  // Signup-nudge text shown to unverified visitors instead of the default
  // denial message. Blank = backend default.
  const [safetyUnverifiedMessage, setSafetyUnverifiedMessage] = useState(
    typeof initialToolPolicies.unverified_message === 'string' ? initialToolPolicies.unverified_message : ''
  )
  // Per-visitor monthly action quota. Absent action_quota = off.
  const initialActionQuota = (initialToolPolicies.action_quota && typeof initialToolPolicies.action_quota === 'object')
    ? initialToolPolicies.action_quota
    : {}
  const [safetyQuotaCap, setSafetyQuotaCap] = useState(
    Number.isFinite(initialActionQuota.per_visitor_monthly_cap) ? String(initialActionQuota.per_visitor_monthly_cap) : ''
  )
  const [safetyQuotaCount, setSafetyQuotaCount] = useState(initialActionQuota.count === 'all' ? 'all' : 'side_effecting')
  const [safetyQuotaMessage, setSafetyQuotaMessage] = useState(
    typeof initialActionQuota.exhausted_message === 'string' ? initialActionQuota.exhausted_message : ''
  )
  const [safetySaving, setSafetySaving] = useState(false)
  const [safetySaveMsg, setSafetySaveMsg] = useState(null)
  const [recipientBusyId, setRecipientBusyId] = useState(null)
  // P2 Actions unification: inline "Remove this tool? Confirm / Cancel"
  // affordance, replacing window.confirm. Holds the id of the tool row
  // currently awaiting confirmation (or null).
  const [confirmRemoveId, setConfirmRemoveId] = useState(null)

  const flash = (setter, text) => { setter(text); setTimeout(() => setter(null), 3000) }

  const toggleAllowListed = (name) => {
    setSafetyAllowList(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const saveToolSafety = async () => {
    if (!authFetch || !orgId || !widgetId) return
    setSafetySaving(true)
    setSafetySaveMsg(null)
    try {
      // Merge into the FULL existing embed_config — same wholesale-replace
      // contract as saveBotProtection above.
      const existingConfig = widget?.embed_config || JSON.parse(widget?.embed_config_json || '{}') || {}
      const existingPolicies = (existingConfig.tool_policies && typeof existingConfig.tool_policies === 'object') ? existingConfig.tool_policies : {}
      const nextPolicies = {
        ...existingPolicies,
        side_effect_allow_list: Array.from(safetyAllowList),
        allow_unverified_side_effects: safetyAllowUnverified,
      }
      const capNum = safetyDailyCap.trim() === '' ? undefined : Number(safetyDailyCap)
      if (Number.isFinite(capNum) && capNum >= 0) nextPolicies.daily_side_effect_cap = capNum
      else nextPolicies.daily_side_effect_cap = null // blank = backend default (100)
      const unverifiedMsg = safetyUnverifiedMessage.trim()
      if (unverifiedMsg) nextPolicies.unverified_message = unverifiedMsg
      else nextPolicies.unverified_message = null // blank = backend default denial text
      const quotaCapNum = safetyQuotaCap.trim() === '' ? undefined : Number(safetyQuotaCap)
      if (Number.isFinite(quotaCapNum) && quotaCapNum > 0) {
        const quotaMsg = safetyQuotaMessage.trim()
        nextPolicies.action_quota = {
          per_visitor_monthly_cap: quotaCapNum,
          ...(safetyQuotaCount === 'all' ? { count: 'all' } : {}),
          ...(quotaMsg ? { exhausted_message: quotaMsg } : {}),
        }
      } else {
        nextPolicies.action_quota = null // blank cap = quota off
      }
      const nextConfig = { ...existingConfig, tool_policies: nextPolicies }
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_config_json: JSON.stringify(diffEmbedConfig(existingConfig, nextConfig)) }),
      })
      if (resp.ok) {
        try { const d = await resp.clone().json(); if (d?.widget && onWidgetChange) onWidgetChange(d.widget) } catch {}
        flash(setSafetySaveMsg, { type: 'success', text: 'Tool safety settings saved' })
      } else {
        const err = await resp.json().catch(() => ({}))
        flash(setSafetySaveMsg, { type: 'error', text: err.error || `Save failed (${resp.status})` })
      }
    } catch (err) {
      flash(setSafetySaveMsg, { type: 'error', text: err.message || 'Save failed' })
    } finally {
      setSafetySaving(false)
    }
  }

  // Per-tool recipient_policy: 'self_only' — lives on the tool's own config
  // (services/collector/lib/quoxchatToolExecutors.js reads
  // tool.tool_config.recipient_policy), not the widget-level policy object,
  // so this PATCHes /tools/:id directly. Merges into the tool's existing
  // config so unrelated fields (e.g. rest_api method/path) aren't clobbered.
  const toggleRecipientPolicy = async (tool) => {
    if (!authFetch || !orgId || !widgetId) return
    setRecipientBusyId(tool.id)
    try {
      const nextConfig = { ...(tool.config || {}) }
      if (nextConfig.recipient_policy === 'self_only') delete nextConfig.recipient_policy
      else nextConfig.recipient_policy = 'self_only'
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/tools/${tool.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: nextConfig }),
      })
      if (resp.ok) load()
      else flash(setError, `Update failed (${resp.status})`)
    } catch (err) {
      flash(setError, err.message)
    } finally {
      setRecipientBusyId(null)
    }
  }

  const saveBotProtection = async () => {
    if (!authFetch || !orgId || !widgetId) return
    setBotSaving(true)
    setBotSaveMsg(null)
    try {
      // Merge into the FULL existing embed_config — the PATCH endpoint
      // replaces embed_config_json wholesale, so a partial object here
      // would silently clobber every other widget setting (theme, greeting,
      // tool_policies, etc.).
      const existingConfig = widget?.embed_config || JSON.parse(widget?.embed_config_json || '{}') || {}
      const nextConfig = {
        ...existingConfig,
        bot_protection: {
          enabled: botEnabled,
          provider: botProvider,
          site_key: botSiteKey.trim(),
          min_score: Number.isFinite(Number(botMinScore)) ? Number(botMinScore) : 0.5,
          guard: botGuard,
        },
      }
      const body = { embed_config_json: JSON.stringify(diffEmbedConfig(existingConfig, nextConfig)) }
      // Secret is write-only: only sent when the admin actually typed a new
      // value. Never pre-filled, never echoed back by the server.
      if (botSecretInput.trim()) body.captcha_secret = botSecretInput.trim()
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}))
        if (data?.widget && onWidgetChange) onWidgetChange(data.widget)
        if (botSecretInput.trim()) setBotSecretSet(true)
        if (typeof data?.widget?.captcha_secret_set === 'boolean') setBotSecretSet(data.widget.captcha_secret_set)
        setBotSecretInput('')
        flash(setBotSaveMsg, { type: 'success', text: 'Bot protection settings saved' })
      } else {
        const err = await resp.json().catch(() => ({}))
        flash(setBotSaveMsg, { type: 'error', text: err.error || `Save failed (${resp.status})` })
      }
    } catch (err) {
      flash(setBotSaveMsg, { type: 'error', text: err.message || 'Save failed' })
    } finally {
      setBotSaving(false)
    }
  }

  const load = useCallback(async () => {
    if (!authFetch || !orgId || !widgetId) return
    setLoading(true)
    setError(null)
    setToolsError(null)
    try {
      const [toolsResp, connResp] = await Promise.all([
        authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/tools`),
        authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/connectors`),
      ])
      if (toolsResp.ok) {
        const data = await toolsResp.json().catch(() => ({}))
        setTools(Array.isArray(data?.items) ? data.items : [])
        setToolsLoaded(true)
      } else {
        setToolsError(`Could not load tools (HTTP ${toolsResp.status})`)
      }
      if (connResp.ok) {
        const data = await connResp.json().catch(() => ({}))
        setConnectors(Array.isArray(data?.items) ? data.items : [])
      }
    } catch (err) {
      setToolsError(err.message || 'Could not load tools')
    } finally {
      setLoading(false)
    }
  }, [authFetch, orgId, widgetId])

  useEffect(() => { load() }, [load])

  const addBuiltin = async (preset) => {
    if (!authFetch || !orgId || !widgetId) return
    if (tools.some(t => t.builtin_kind === preset.id)) {
      flash(setInfo, `${preset.label} is already enabled`)
      return
    }
    setBusyId(`add:${preset.id}`)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: preset.name,
          description: preset.description,
          tool_type: 'builtin',
          builtin_kind: preset.id,
          parameters: preset.parameters,
          config: {},
          status: 'active',
        }),
      })
      if (resp.ok) {
        flash(setInfo, `${preset.label} enabled`)
        load()
      } else {
        const body = await resp.json().catch(() => ({}))
        flash(setError, body.error || `Create failed (${resp.status})`)
      }
    } catch (err) {
      flash(setError, err.message || 'Create failed')
    } finally {
      setBusyId(null)
    }
  }

  const toggleTool = async (tool) => {
    setBusyId(`toggle:${tool.id}`)
    try {
      const next = tool.status === 'active' ? 'disabled' : 'active'
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/tools/${tool.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (resp.ok) load()
      else flash(setError, `Toggle failed (${resp.status})`)
    } catch (err) {
      flash(setError, err.message)
    } finally {
      setBusyId(null)
    }
  }

  // Confirmation now happens inline in the row (see confirmRemoveId); this
  // fires the actual delete once the operator has confirmed.
  const deleteTool = async (tool) => {
    setConfirmRemoveId(null)
    setBusyId(`del:${tool.id}`)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/tools/${tool.id}`, { method: 'DELETE' })
      if (resp.ok || resp.status === 204) load()
      else flash(setError, `Delete failed (${resp.status})`)
    } catch (err) {
      flash(setError, err.message)
    } finally {
      setBusyId(null)
    }
  }

  const deleteConnector = async (conn) => {
    const bound = tools.filter(t => t.connector_id === conn.id)
    const msg = bound.length > 0
      ? `Remove connector "${conn.name}"? This will also remove ${bound.length} linked tool(s).`
      : `Remove connector "${conn.name}"?`
    if (!window.confirm(msg)) return
    setBusyId(`del:${conn.id}`)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/connectors/${conn.id}`, { method: 'DELETE' })
      if (resp.ok || resp.status === 204) load()
      else flash(setError, `Delete failed (${resp.status})`)
    } catch (err) {
      flash(setError, err.message)
    } finally {
      setBusyId(null)
    }
  }

  const sideEffectingTools = tools.filter(t => isSideEffectingTool(t, connectors))

  // P2 Actions unification: one inventory instead of two. Built-in presets
  // that already have a tool record render as ordinary rows in the Tools
  // table (carrying a Built-in badge). Presets with no record yet render as
  // a Disabled placeholder row whose single toggle control creates + enables
  // the tool (same addBuiltin handler the old quick-add cards used). Other
  // builtin tools not covered by a quick-add preset (email_transcript,
  // book_appointment, etc.) sit alongside connector-backed tools; they are
  // still marked Built-in and still forbid Remove.
  const builtinToolsByKind = new Map(
    tools.filter(t => t.tool_type === 'builtin').map(t => [t.builtin_kind, t])
  )
  const presetKinds = new Set(BUILTIN_PRESETS.map(p => p.id))
  const toolRows = [
    ...BUILTIN_PRESETS.map(preset => ({ key: `preset:${preset.id}`, preset, tool: builtinToolsByKind.get(preset.id) || null })),
    ...tools.filter(t => !(t.tool_type === 'builtin' && presetKinds.has(t.builtin_kind))).map(t => ({ key: t.id, tool: t })),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 400 }}>
        {(error || info) && (
          <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: error ? 'rgba(239,68,68,0.14)' : 'rgba(48,255,144,0.14)', color: error ? '#ef4444' : '#30ff90' }}>
            {error || info}
          </div>
        )}

        {/* Tools list: one inventory. Built-in and connector-backed tools
            together; each row shows its Enabled/Disabled state once, via a
            single status pill, plus exactly one toggle control. */}
        <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{toolsLoaded ? `Tools (${tools.length})` : 'Tools'}</span>
            <button type="button" onClick={() => setShowToolModal(true)} style={{ padding: '5px 12px', fontSize: 11, fontWeight: 700, background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 6, color: '#a855f7', cursor: 'pointer' }}>+ New tool</button>
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.72)' }}>
            Built-in tools need no setup, just enable them below. For custom REST, webhook, or database tools, create a connector below, then a tool that uses it.
          </div>
          <EmailNotConnectedNotice featureLabel="transcript email" />
          {!toolsLoaded && !toolsError && (
            <div data-testid="tools-skeleton" aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ height: 44, borderRadius: 6, background: 'rgba(255,255,255,0.06)' }} />
              ))}
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.72)' }}>Loading tools...</div>
            </div>
          )}
          {toolsError && !toolsLoaded && (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: '#ef4444' }}>
              <span>{toolsError}</span>
              <button type="button" onClick={load} style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#ef4444', cursor: 'pointer' }}>Retry</button>
            </div>
          )}
          {toolsLoaded && toolRows.map(({ key, tool, preset }) => {
            const isBuiltin = tool ? tool.tool_type === 'builtin' : true
            const label = tool ? toolDisplayLabel(tool) : preset.label
            const machineName = tool ? tool.name : preset.name
            const description = tool ? tool.description : preset.desc
            const enabled = tool ? tool.status === 'active' : false
            const calls = tool?.use_count || 0
            const errors = tool?.error_count || 0
            const connectorSubtype = tool && tool.tool_type === 'connector'
              ? (connectors.find(c => c.id === tool.connector_id)?.connector_type || 'connector')
              : undefined
            const toggleBusy = tool ? busyId === `toggle:${tool.id}` : busyId === `add:${preset?.id}`
            const isConfirmingRemove = Boolean(tool) && confirmRemoveId === tool.id

            return (
              <div key={key} style={{ padding: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{label}</span>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.72)', fontFamily: "'JetBrains Mono', monospace", background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 4 }}>{machineName}</span>
                    {isBuiltin
                      ? <TypeBadge kind="builtin" label="Built-in" />
                      : <TypeBadge kind={tool.tool_type} subtype={connectorSubtype} />}
                  </div>
                  {description && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.72)', marginBottom: 2 }}>{description}</div>}
                  {tool && (
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.72)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {calls} call{calls === 1 ? '' : 's'} · {errors} error{errors === 1 ? '' : 's'} · {tool.last_used_at ? `last ${formatRelative(tool.last_used_at)}` : 'never used'}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <StatusPill enabled={enabled} />

                  {tool && (
                    <button
                      type="button"
                      onClick={() => setTestToolTarget(tool)}
                      title="Run this tool in isolation with sample input"
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 10, fontWeight: 600, background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 6, color: '#c084fc', cursor: 'pointer' }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="#c084fc" stroke="none"><polygon points="6 4 20 12 6 20" /></svg>
                      Test
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => (tool ? toggleTool(tool) : addBuiltin(preset))}
                    disabled={toggleBusy}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 10, fontWeight: 600, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#fff', cursor: toggleBusy ? 'default' : 'pointer' }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={enabled ? 'rgba(255,255,255,0.75)' : '#30ff90'} strokeWidth="2">
                      {enabled ? <><path d="M12 3v6" /><path d="M6.2 6.2a8 8 0 1 0 11.6 0" /></> : <path d="M20 6 9 17l-5-5" />}
                    </svg>
                    {toggleBusy ? (tool ? 'Working...' : 'Adding...') : enabled ? 'Disable' : 'Enable'}
                  </button>

                  {tool && !isBuiltin && (
                    isConfirmingRemove ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)' }}>Remove this tool?</span>
                        <button
                          type="button"
                          onClick={() => deleteTool(tool)}
                          disabled={busyId === `del:${tool.id}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 10, fontWeight: 700, background: '#ef4444', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer' }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(null)}
                          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 10, fontWeight: 600, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'rgba(255,255,255,0.75)', cursor: 'pointer' }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(tool.id)}
                        disabled={busyId === `del:${tool.id}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 10, fontWeight: 600, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, color: '#ef4444', cursor: 'pointer' }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" /></svg>
                        Remove
                      </button>
                    )
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Connectors list */}
        <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Connectors ({connectors.length})</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => setShowGallery(true)} title="Browse 15 pre-built integrations" style={{ padding: '5px 12px', fontSize: 11, fontWeight: 700, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.25)', borderRadius: 6, color: '#30ff90', cursor: 'pointer' }}>★ Browse gallery</button>
              <button type="button" onClick={() => setShowConnectorModal(true)} style={{ padding: '5px 12px', fontSize: 11, fontWeight: 700, background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 6, color: '#a855f7', cursor: 'pointer' }}>+ New connector</button>
            </div>
          </div>
          {toolsLoaded && !loading && connectors.length === 0 && (
            <div className="qx-flat-panel--ghost" style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', textAlign: 'center' }}>
              No connectors yet. Connectors let one REST API, webhook, or database power multiple tools.
            </div>
          )}
          {connectors.map(c => {
            const bound = tools.filter(t => t.connector_id === c.id)
            return (
              <div key={c.id} style={{ padding: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{c.name}</span>
                    <TypeBadge kind="connector" subtype={c.connector_type} />
                    {c.status !== 'active' && <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 700, textTransform: 'uppercase' }}>disabled</span>}
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', fontFamily: "'JetBrains Mono', monospace" }}>
                    {c.connector_type} · {c.use_count || 0} calls · {c.error_count || 0} errors · {bound.length} tool{bound.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => deleteConnector(c)}
                  disabled={busyId === `del:${c.id}`}
                  style={{ padding: '4px 10px', fontSize: 10, fontWeight: 600, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, color: '#ef4444', cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>

        {/* #129 — Tool & action safety card. OFF BY DEFAULT: an unconfigured
            widget has no embed_config.tool_policies, so the allow-list is
            empty and side-effecting tools stay denied (P1-5 backend default). */}
        <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#f59e0b' }}>
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Tool & action safety</span>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', lineHeight: 1.4 }}>
            Side-effecting tools (webhooks, non-GET REST calls, and email/send/pay actions) are denied by default. Permit them explicitly below.
          </div>

          {sideEffectingTools.length === 0 ? (
            <div className="qx-flat-panel--ghost" style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', textAlign: 'center' }}>
              This widget has no side-effecting tools yet. Safety settings below apply automatically once one is added.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>Allow-listed side-effecting tools</label>
              {sideEffectingTools.map(t => (
                <div key={t.id} style={{ padding: 8, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      aria-label={`Allow ${t.name}`}
                      checked={safetyAllowList.has(t.name)}
                      onChange={() => toggleAllowListed(t.name)}
                    />
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', fontFamily: "'JetBrains Mono', monospace" }}>{t.name}</span>
                    <TypeBadge kind={t.tool_type} subtype={t.tool_type === 'builtin' ? t.builtin_kind : (connectors.find(c => c.id === t.connector_id)?.connector_type || 'connector')} />
                  </label>
                  <button
                    type="button"
                    onClick={() => toggleRecipientPolicy(t)}
                    disabled={recipientBusyId === t.id}
                    title="When on, this tool's recipient/target must match the visitor's own verified email"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: 10, fontWeight: 600,
                      background: t.config?.recipient_policy === 'self_only' ? 'rgba(48,255,144,0.12)' : 'rgba(255,255,255,0.05)',
                      border: t.config?.recipient_policy === 'self_only' ? '1px solid rgba(48,255,144,0.3)' : '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 6, color: t.config?.recipient_policy === 'self_only' ? '#30ff90' : 'rgba(255,255,255,0.65)', cursor: 'pointer',
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a8 8 0 0 1 16 0v1" /></svg>
                    {t.config?.recipient_policy === 'self_only' ? "Recipient locked to visitor's own email" : "Restrict recipient to visitor's own email"}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Daily side-effect cap</label>
              <input
                type="number" min="0" step="1"
                aria-label="Daily side-effect cap"
                value={safetyDailyCap}
                onChange={e => setSafetyDailyCap(e.target.value)}
                placeholder="Blank = default (100)"
                style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Unverified visitors</label>
              <button
                type="button"
                onClick={() => setSafetyAllowUnverified(v => !v)}
                title={safetyAllowUnverified ? 'Unverified visitors may trigger side-effecting tools' : 'Side-effecting tools require a verified visitor identity (default)'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 11, fontWeight: 700, width: '100%', justifyContent: 'center',
                  background: safetyAllowUnverified ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.05)',
                  border: safetyAllowUnverified ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 6, color: safetyAllowUnverified ? '#ef4444' : 'rgba(255,255,255,0.65)', cursor: 'pointer',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {safetyAllowUnverified ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M20 6 9 17l-5-5" />}
                </svg>
                {safetyAllowUnverified ? 'Allow unverified visitors' : 'Verified visitors only'}
              </button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Sign-in nudge message</label>
            <input
              aria-label="Unverified visitor message"
              value={safetyUnverifiedMessage}
              onChange={e => setSafetyUnverifiedMessage(e.target.value)}
              maxLength={500}
              placeholder="Message shown when a signed-out visitor asks for an account action, e.g. Sign in at your portal to manage servers from chat."
              style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>Per-visitor action quota</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Per-visitor monthly action cap</label>
                <input
                  type="number" min="1" step="1"
                  aria-label="Per-visitor monthly action cap"
                  value={safetyQuotaCap}
                  onChange={e => setSafetyQuotaCap(e.target.value)}
                  placeholder="Blank = off"
                  style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Count</label>
                <select
                  aria-label="Action quota counting mode"
                  value={safetyQuotaCount}
                  onChange={e => setSafetyQuotaCount(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
                >
                  <option value="side_effecting">Side-effecting actions only</option>
                  <option value="all">All tool calls</option>
                </select>
              </div>
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Quota exhausted message</label>
              <input
                aria-label="Quota exhausted message"
                value={safetyQuotaMessage}
                onChange={e => setSafetyQuotaMessage(e.target.value)}
                maxLength={500}
                placeholder="Blank = default"
                style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', lineHeight: 1.4 }}>
              A per-user override can be set by your site's identify() payload (action_quota_monthly) only when your backend signs it (allowance_sig + allowance_exp, see the identity verification docs). Unsigned values are ignored.
            </div>
          </div>

          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', lineHeight: 1.4 }}>
            Per-tool "restrict recipient" toggles above set <code>recipient_policy: 'self_only'</code> on that tool directly.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              type="button"
              onClick={saveToolSafety}
              disabled={safetySaving}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', fontSize: 11, fontWeight: 700,
                background: safetySaving ? 'rgba(48,255,144,0.5)' : '#30ff90',
                border: 'none', borderRadius: 6, cursor: safetySaving ? 'not-allowed' : 'pointer', color: '#000',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>
              {safetySaving ? 'Saving...' : 'Save tool safety'}
            </button>
            {safetySaveMsg && (
              <span style={{ fontSize: 11, fontWeight: 600, color: safetySaveMsg.type === 'success' ? '#30ff90' : '#ef4444' }}>
                {safetySaveMsg.text}
              </span>
            )}
          </div>
        </div>

        {/* CAPTCHA #127 — Bot protection card. OFF BY DEFAULT. */}
        <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: botEnabled ? '#30ff90' : 'rgba(255,255,255,0.5)' }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Bot protection</span>
            </div>
            <button
              type="button"
              onClick={() => setBotEnabled(v => !v)}
              title={botEnabled ? 'Disable bot protection' : 'Enable bot protection'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', fontSize: 11, fontWeight: 700,
                background: botEnabled ? 'rgba(48,255,144,0.12)' : 'rgba(255,255,255,0.05)',
                border: botEnabled ? '1px solid rgba(48,255,144,0.3)' : '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6, color: botEnabled ? '#30ff90' : 'rgba(255,255,255,0.65)', cursor: 'pointer',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {botEnabled ? <path d="M20 6 9 17l-5-5" /> : <path d="M18 6 6 18M6 6l12 12" />}
              </svg>
              {botEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', lineHeight: 1.4 }}>
            Requires a passed invisible CAPTCHA check before side-effecting actions (or every action, if scoped to "all") run. Off by default, so existing widgets are unaffected until you enable this.
          </div>

          {botEnabled && (
            <>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Provider</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[{ id: 'recaptcha_v3', label: 'Google reCAPTCHA v3' }, { id: 'turnstile', label: 'Cloudflare Turnstile' }].map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setBotProvider(p.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 11, fontWeight: botProvider === p.id ? 700 : 500,
                        background: botProvider === p.id ? 'rgba(168,85,247,0.12)' : 'rgba(0,0,0,0.12)',
                        border: botProvider === p.id ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)',
                        borderRadius: 6, cursor: 'pointer', color: botProvider === p.id ? '#fff' : 'rgba(255,255,255,0.65)', fontFamily: 'inherit',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9 12l2 2 4-4" /></svg>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Site key (public)</label>
                  <input
                    value={botSiteKey}
                    onChange={e => setBotSiteKey(e.target.value)}
                    placeholder="6Lc... / 0x4AAAAAAA..."
                    style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>
                    Secret key {botSecretSet && <span style={{ color: '#30ff90', fontWeight: 700 }}>&#9679;&#9679;&#9679;&#9679; set</span>}
                  </label>
                  <input
                    type="password"
                    value={botSecretInput}
                    onChange={e => setBotSecretInput(e.target.value)}
                    placeholder={botSecretSet ? 'Enter a new secret to replace it' : 'Provider secret key'}
                    style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", boxSizing: 'border-box' }}
                  />
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', display: 'block', marginTop: 3 }}>
                    Write-only. Stored server-side, never shown again once saved.
                  </span>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>
                    Min score {botProvider === 'turnstile' && <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.4)' }}>(reCAPTCHA v3 only)</span>}
                  </label>
                  <input
                    type="number" min="0" max="1" step="0.05"
                    value={botMinScore}
                    onChange={e => setBotMinScore(e.target.value)}
                    disabled={botProvider === 'turnstile'}
                    style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box', opacity: botProvider === 'turnstile' ? 0.5 : 1 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>Guard scope</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {[{ id: 'side_effecting', label: 'Side-effecting only' }, { id: 'all', label: 'Every action' }].map(g => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => setBotGuard(g.id)}
                        style={{
                          padding: '6px 10px', fontSize: 10, fontWeight: botGuard === g.id ? 700 : 500,
                          background: botGuard === g.id ? 'rgba(168,85,247,0.12)' : 'rgba(0,0,0,0.12)',
                          border: botGuard === g.id ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)',
                          borderRadius: 6, cursor: 'pointer', color: botGuard === g.id ? '#fff' : 'rgba(255,255,255,0.65)', fontFamily: 'inherit',
                        }}
                      >
                        {g.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              type="button"
              onClick={saveBotProtection}
              disabled={botSaving || (botEnabled && !botSiteKey.trim())}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', fontSize: 11, fontWeight: 700,
                background: botSaving ? 'rgba(48,255,144,0.5)' : '#30ff90',
                border: 'none', borderRadius: 6, cursor: botSaving ? 'not-allowed' : 'pointer', color: '#000',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>
              {botSaving ? 'Saving...' : 'Save bot protection'}
            </button>
            {botSaveMsg && (
              <span style={{ fontSize: 11, fontWeight: 600, color: botSaveMsg.type === 'success' ? '#30ff90' : '#ef4444' }}>
                {botSaveMsg.text}
              </span>
            )}
          </div>
        </div>

      {showConnectorModal && (
        <ConnectorBuilderModal
          widget={widget}
          authFetch={authFetch}
          orgId={orgId}
          onClose={() => setShowConnectorModal(false)}
          onCreated={() => { flash(setInfo, 'Connector created'); load() }}
        />
      )}
      {showToolModal && (
        <ToolBuilderModal
          widget={widget}
          connectors={connectors}
          authFetch={authFetch}
          orgId={orgId}
          onClose={() => setShowToolModal(false)}
          onCreated={() => { flash(setInfo, 'Tool created'); load() }}
          onCreateConnector={() => { setShowToolModal(false); setShowConnectorModal(true) }}
        />
      )}
      {testToolTarget && (
        <TestToolModal
          tool={testToolTarget}
          widget={widget}
          orgId={orgId}
          authFetch={authFetch}
          onClose={() => setTestToolTarget(null)}
        />
      )}
      {showGallery && (
        <ConnectorGalleryModal
          widget={widget}
          authFetch={authFetch}
          orgId={orgId}
          onClose={() => setShowGallery(false)}
          onAdded={() => { flash(setInfo, 'Connector + tool added from gallery'); load() }}
        />
      )}
    </div>
  )
}
