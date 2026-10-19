/**
 * DiscordProView: the install/settings surface for the Discord Pro daemon.
 *
 * DISCORD-PRO: the daemon itself lives in its own repo
 * (~/quox-discord-pro) and runs as a loopback-bound process; this
 * view is a status window onto it, the same shape as TelegramProView is for
 * Telegram Pro. A daemon status card, a bindings table, and an open-support-
 * gaps count. No wizard, no chat surface here.
 *
 * QDIS-NEXT phase 6: binding add/edit/delete. Writes go through the
 * collector's /api/discord-pro/bindings/:channelId proxy (services/collector/
 * routes/discord-pro.js), which relays straight to the daemon's own control
 * API (quox-discord-pro's src/controlApi.js) and applies live, no restart.
 *
 * Built with .qx-* globals only (glass-design-system): no per-view CSS.
 */

import { useEffect, useState, useCallback } from 'react'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import PluginLicenseNotice from '../plugins/PluginLicenseNotice'

// Browser -> collector goes through the /collector/ nginx door (the same
// convention chat, ws and QuoxSignal use). The bare /api/* space is proxied
// to the auth service, so /api/discord-pro/status 404s there; the collector
// mounts the route at /api/discord-pro, reached via /collector/api/discord-pro.
const STATUS_URL = '/collector/api/discord-pro/status'
const bindingsUrl = (channelId) => `/collector/api/discord-pro/bindings/${encodeURIComponent(channelId)}`

// Modes reachable from the add/edit form. `feed` is daemon/CLI-only for now
// (no dedicated field set defined for it yet) so it stays out of the select;
// it can still be seen (read-only, via ModePill) in the table if bound
// elsewhere.
const EDITABLE_MODES = ['echo', 'support', 'quoxchat', 'team', 'roundtable', 'bridge']

// Modes with no dedicated field set below fall back to a raw key=value
// textarea so nothing the daemon accepts is unreachable from this form.
const RAW_FALLBACK_MODES = new Set(['echo', 'quoxchat'])

function parseRawFields(text) {
  const out = {}
  String(text || '').split('\n').forEach((line) => {
    const idx = line.indexOf('=')
    if (idx <= 0) return
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  })
  return out
}

// Each binding mode gets its own label + colour, driven inline so the pills
// render identically wherever they appear (legend, table) without depending on
// a global pill class existing for every mode.
const MODE_META = {
  echo:       { label: 'Echo',       color: '#94a3b8' },
  support:    { label: 'Support',    color: '#34d399' },
  quoxchat:   { label: 'QuoxChat',   color: '#38bdf8' },
  team:       { label: 'Team',       color: '#60a5fa' },
  roundtable: { label: 'Roundtable', color: '#c084fc' },
  feed:       { label: 'Feed',       color: '#fbbf24' },
  bridge:     { label: 'Bridge',     color: '#fb7185' },
}

function ModePill({ mode }) {
  const m = MODE_META[mode] || { label: mode || 'unknown', color: '#94a3b8' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase',
      color: m.color, background: `${m.color}1f`, border: `1px solid ${m.color}40`,
    }}>{m.label}</span>
  )
}

function StatusCard({ loading, data }) {
  const online = data?.ok === true && data?.health?.status !== 'offline'
  const dotClass = loading ? 'qx-dot--idle' : online ? 'qx-dot--online' : 'qx-dot--offline'
  const pillClass = loading ? 'qx-pill--ghost' : online ? 'qx-pill--online' : 'qx-pill--offline'
  const bot = data?.health?.bot
  const guilds = data?.health?.guilds || []
  const pillText = loading ? 'checking...' : online ? (bot ? `active · ${bot}` : 'active') : 'daemon offline'

  return (
    <div className="qx-card qx-card--bar qx-row qx-row--apart">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <strong>Quox Discord Pro</strong>
        <span className={`qx-dot ${dotClass}`} aria-hidden="true" />
        <span className={`qx-pill ${pillClass} qx-pill--xs`}>{pillText}</span>
        <span className="qx-hint qx-hint--sm" title="What this surface is for">
          Server management, build/GitHub feeds, AutoMod baseline, and governed grounded support.
        </span>
      </div>
      {!loading && online && guilds.length > 0 && (
        <span className="qx-pill qx-pill--ghost qx-pill--xs" title="Discord server(s) this daemon bridges">
          {guilds.join(', ')}
        </span>
      )}
    </div>
  )
}

function StatTiles({ bindings, guilds, gaps }) {
  const modes = new Set(bindings.map((b) => b.mode).filter(Boolean))
  const servers = guilds.length || (bindings.some((b) => b.guild) ? 1 : 0)
  const tiles = [
    { label: 'Channels bound', value: bindings.length },
    { label: 'Modes active', value: modes.size },
    { label: 'Servers', value: servers },
    { label: 'Open gaps', value: gaps.length },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
      {tiles.map((t) => (
        <div key={t.label} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{t.value}</span>
          <span className="qx-hint qx-hint--sm">{t.label}</span>
        </div>
      ))}
    </div>
  )
}

function ModeLegend() {
  return (
    <div className="qx-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="qx-hint qx-hint--sm">Modes:</span>
      {Object.keys(MODE_META).map((k) => <ModePill key={k} mode={k} />)}
    </div>
  )
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display: 'block' }} aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display: 'block' }} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display: 'block' }} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

// Add/edit form for a single binding. `initial` set (with a channel_id) means
// edit mode: channel id is locked and the PUT upserts over the existing row.
// No initial means add mode: channel id is a free text field.
function BindingForm({ initial, onCancel, onSaved }) {
  const isEdit = Boolean(initial?.channel_id)
  const [channelId, setChannelId] = useState(initial?.channel_id || '')
  const [mode, setMode] = useState(initial?.mode && EDITABLE_MODES.includes(initial.mode) ? initial.mode : EDITABLE_MODES[0])
  const [agentId, setAgentId] = useState(initial?.agent_id || '')
  const [persona, setPersona] = useState(initial?.persona || '')
  const [cooldownS, setCooldownS] = useState(initial?.cooldown_s ?? 30)
  const [hitlPolicy, setHitlPolicy] = useState(initial?.hitl_policy || 'all')
  const [requireMention, setRequireMention] = useState(initial?.require_mention !== 0)
  // config.json values may arrive as the string "0" (CLI key=value or
  // hand-edited JSON), which is truthy under Boolean() — coerce numerically.
  const [bridgeTwoWay, setBridgeTwoWay] = useState(Number(initial?.bridge_two_way) === 1)
  const [bridgeRemoteHost, setBridgeRemoteHost] = useState(initial?.bridge_remote_host || '')
  const [bridgeRemoteInbox, setBridgeRemoteInbox] = useState(initial?.bridge_remote_inbox || '')
  const [rawText, setRawText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const usesRawFallback = RAW_FALLBACK_MODES.has(mode)

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmedChannelId = channelId.trim()
    if (!trimmedChannelId || submitting) return
    setSubmitting(true)
    setError(null)

    let body = { mode }
    if (mode === 'team' || mode === 'roundtable') {
      body = { ...body, agent_id: agentId, persona, cooldown_s: Number(cooldownS) || 30 }
    } else if (mode === 'support') {
      body = { ...body, hitl_policy: hitlPolicy, require_mention: requireMention ? 1 : 0 }
    } else if (mode === 'bridge') {
      body = { ...body, agent_id: agentId, bridge_two_way: bridgeTwoWay ? 1 : 0, bridge_remote_host: bridgeRemoteHost, bridge_remote_inbox: bridgeRemoteInbox }
    } else if (usesRawFallback) {
      body = { ...body, ...parseRawFields(rawText) }
    }

    try {
      const res = await fetch(bindingsUrl(trimmedChannelId), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) throw new Error(payload?.error || `save failed (HTTP ${res.status})`)
      onSaved?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="qx-card qx-card--compact qx-stack qx-stack--tight" onSubmit={handleSubmit} data-testid="binding-form">
      <div className="qx-row qx-row--apart">
        <span className="qx-section-title">{isEdit ? `Edit #${initial.channel_name || initial.channel_id}` : 'Add binding'}</span>
      </div>

      <div className="qx-row qx-row--tight qx-row--wrap">
        <input
          type="text"
          className="qx-input qx-input--mono qx-input--grow"
          placeholder="Channel ID"
          aria-label="Channel ID"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          disabled={isEdit}
        />
        <select className="qx-select qx-select--auto" aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          {EDITABLE_MODES.map((m) => <option key={m} value={m}>{MODE_META[m]?.label || m}</option>)}
        </select>
      </div>

      {(mode === 'team' || mode === 'roundtable') && (
        <div className="qx-row qx-row--tight qx-row--wrap">
          <input type="text" className="qx-input qx-input--grow" placeholder="Agent ID" aria-label="Agent ID" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
          <input type="text" className="qx-input qx-input--grow" placeholder="Persona" aria-label="Persona" value={persona} onChange={(e) => setPersona(e.target.value)} />
          <input type="number" min="0" className="qx-input" style={{ width: 120 }} placeholder="Cooldown (s)" aria-label="Cooldown seconds" value={cooldownS} onChange={(e) => setCooldownS(e.target.value)} />
        </div>
      )}

      {mode === 'support' && (
        <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
          <select className="qx-select qx-select--auto" aria-label="HITL policy" value={hitlPolicy} onChange={(e) => setHitlPolicy(e.target.value)}>
            <option value="all">Require approval (all)</option>
            <option value="none">Auto-post (none)</option>
          </select>
          <label className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={requireMention} onChange={(e) => setRequireMention(e.target.checked)} />
            <span className="qx-hint qx-hint--sm">Require @mention</span>
          </label>
        </div>
      )}

      {mode === 'bridge' && (
        <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
          <input type="text" className="qx-input qx-input--grow" placeholder="Agent ID" aria-label="Agent ID" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
          <label className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={bridgeTwoWay} onChange={(e) => setBridgeTwoWay(e.target.checked)} />
            <span className="qx-hint qx-hint--sm">Two-way</span>
          </label>
          <input type="text" className="qx-input qx-input--grow" placeholder="Remote host" aria-label="Bridge remote host" value={bridgeRemoteHost} onChange={(e) => setBridgeRemoteHost(e.target.value)} />
          <input type="text" className="qx-input qx-input--grow" placeholder="Remote inbox" aria-label="Bridge remote inbox" value={bridgeRemoteInbox} onChange={(e) => setBridgeRemoteInbox(e.target.value)} />
        </div>
      )}

      {usesRawFallback && (
        <div className="qx-stack qx-stack--tight">
          <span className="qx-hint qx-hint--sm">No dedicated fields for {MODE_META[mode]?.label || mode} yet, one key=value per line, sent straight to the daemon.</span>
          <textarea
            className="qx-textarea qx-textarea--mono"
            rows={4}
            placeholder={'provider=openai\nmodel=gpt-4o'}
            aria-label="Additional fields"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
        </div>
      )}

      {error && <div className="qx-banner qx-banner--error">{error}</div>}

      <div className="qx-row qx-row--end" style={{ gap: 8 }}>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="qx-btn qx-btn--sm qx-btn--primary" disabled={!channelId.trim() || submitting}>
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add binding'}
        </button>
      </div>
    </form>
  )
}

function BindingsTable({ bindings, onEdit, onDelete }) {
  if (bindings.length === 0) {
    return (
      <div className="qx-card qx-card--compact">
        <span className="qx-hint">No channels bound yet. Add one above, or bind on the daemon (quox-discord-pro CLI or config.json).</span>
      </div>
    )
  }

  return (
    <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
      <table className="qx-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Mode</th>
            <th>Instance</th>
            <th>Persona</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bindings.map((b) => (
            <tr key={b.channel_id}>
              <td>
                {b.channel_name
                  ? <span style={{ fontWeight: 600 }}>#{b.channel_name}</span>
                  : <span className="qx-mono qx-hint">{b.channel_id}</span>}
              </td>
              <td><ModePill mode={b.mode} /></td>
              <td>{b.instance || 'default'}</td>
              <td>{b.persona || b.agent_id || <span className="qx-hint">—</span>}</td>
              <td>
                <div className="qx-row qx-row--tight" style={{ justifyContent: 'flex-end' }}>
                  <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => onEdit(b)} aria-label={`Edit ${b.channel_id}`} title="Edit binding">
                    <EditIcon />
                  </button>
                  <button type="button" className="qx-btn qx-btn--sm qx-btn--danger" onClick={() => onDelete(b)} aria-label={`Delete ${b.channel_id}`} title="Delete binding">
                    <TrashIcon />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SupportGaps({ gaps }) {
  return (
    <div className="qx-stack" style={{ gap: 8 }}>
      <div className="qx-row qx-row--apart">
        <span className="qx-hint">Open support gaps</span>
        <span className={`qx-pill qx-pill--xs ${gaps.length > 0 ? 'qx-pill--info' : 'qx-pill--ghost'}`}>{gaps.length}</span>
      </div>
      {gaps.length > 0 && (
        <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {gaps.map((g, i) => (
              <li key={g.id || i} style={{ fontSize: 13, lineHeight: 1.6 }}>{g.question || g.text || JSON.stringify(g)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function DiscordProContent() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingBinding, setEditingBinding] = useState(null)
  const [deleteError, setDeleteError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(STATUS_URL, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : { ok: false, health: { status: 'offline' }, bindings: [], gaps: [] }))
      .then((body) => setData(body))
      .catch(() => setData({ ok: false, health: { status: 'offline' }, bindings: [], gaps: [] }))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const bindings = data?.bindings || []
  const gaps = data?.gaps || []

  const handleFormSaved = useCallback(() => {
    setShowAddForm(false)
    setEditingBinding(null)
    load()
  }, [load])

  const handleDelete = useCallback((binding) => {
    if (!window.confirm(`Unbind #${binding.channel_name || binding.channel_id}? This stops the daemon acting in this channel immediately.`)) return
    setDeleteError(null)
    fetch(bindingsUrl(binding.channel_id), { method: 'DELETE', credentials: 'include' })
      .then(async (res) => {
        const payload = await res.json().catch(() => null)
        if (!res.ok) throw new Error(payload?.error || `delete failed (HTTP ${res.status})`)
        load()
      })
      .catch((err) => setDeleteError(err.message))
  }, [load])

  return (
    <div className="qx-view" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="qx-stack" style={{ padding: 16, overflow: 'auto', flex: 1, minHeight: 0 }}>
        <StatusCard loading={loading} data={data} />

        {!loading && data?.ok === false && (
          <div className="qx-card qx-card--compact">
            <span className="qx-hint">
              The Discord Pro daemon is not reachable. Check that the quox-discord-pro process is running and its control API config is correct.
            </span>
          </div>
        )}

        {!loading && data?.ok !== false && (
          <>
            <StatTiles bindings={bindings} guilds={data?.health?.guilds || []} gaps={gaps} />
            <ModeLegend />
          </>
        )}

        <div className="qx-stack" style={{ gap: 6 }}>
          <div className="qx-row qx-row--apart">
            <span className="qx-hint">Channel bindings</span>
            {!showAddForm && !editingBinding && (
              <button
                type="button"
                className="qx-btn qx-btn--sm qx-btn--ghost"
                onClick={() => setShowAddForm(true)}
              >
                <PlusIcon /> Add binding
              </button>
            )}
          </div>

          {showAddForm && (
            <BindingForm onCancel={() => setShowAddForm(false)} onSaved={handleFormSaved} />
          )}
          {editingBinding && (
            <BindingForm initial={editingBinding} onCancel={() => setEditingBinding(null)} onSaved={handleFormSaved} />
          )}

          {deleteError && <div className="qx-banner qx-banner--error">{deleteError}</div>}

          <BindingsTable
            bindings={bindings}
            onEdit={(b) => { setEditingBinding(b); setShowAddForm(false) }}
            onDelete={handleDelete}
          />
        </div>

        <SupportGaps gaps={gaps} />
      </div>
    </div>
  )
}

export default function DiscordProView() {
  // DISCORD-PRO-GATING: unlicensed users get the reason, not the
  // status panel, same gating mechanism as every other paid plugin view
  // (usePluginLicenseDiagnosis reads the server-fetched entitlement cache).
  const diag = usePluginLicenseDiagnosis('discord-pro')

  if (!diag.licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Quox Discord Pro" accentColor="#5865F2" />
  }

  return <DiscordProContent />
}
