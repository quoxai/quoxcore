/**
 * MON-GOV Phase 2: Governance Incidents tab
 *
 * Runtime violation triage surface: open incidents, drill-in detail with
 * linked AEE envelopes, inline resolution, and live updates via the
 * collector's EventStreamHub. Composes the Compliance tab's glass
 * primitives so it visually belongs with its siblings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GlassPanel,
  GlassPill,
  SectionHeader,
  GlassButton,
  GlassSkeleton,
  GlassError,
  COLORS,
  M,
  F,
} from './glass-primitives'
import {
  listIncidents,
  getIncident,
  updateIncident,
  witnessIncident,
  subscribeToIncidents,
  listBaselines,
} from '../../services/governanceIncidentsClient'

const RANGE_OPTIONS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: 'All', hours: null },
]

const SEVERITY_COLORS = {
  critical: COLORS.red,
  high: '#fb923c',
  medium: COLORS.amber,
  low: COLORS.cyan,
  info: COLORS.subtleText,
}

const STATUS_COLORS = {
  open: COLORS.red,
  investigating: COLORS.amber,
  resolved: COLORS.green,
  closed: COLORS.subtleText,
  false_positive: COLORS.subtleText,
}

const STATUS_OPTIONS = ['open', 'investigating', 'resolved', 'closed', 'false_positive']

const RESOLVE_STATUSES = new Set(['resolved', 'closed', 'false_positive'])

function formatAge(iso) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return '—'
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

function sinceFor(range) {
  if (!range?.hours) return null
  const since = new Date(Date.now() - range.hours * 60 * 60 * 1000)
  return since.toISOString()
}

// ─────────────────────────────────────────────────────────────────────────

function SeverityDot({ severity }) {
  const colour = SEVERITY_COLORS[severity] || COLORS.subtleText
  return (
    <span
      aria-label={severity}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: colour,
        boxShadow: `0 0 8px ${colour}80`,
        flexShrink: 0,
      }}
    />
  )
}

function IncidentRow({ incident, selected, onSelect }) {
  const severityColour = SEVERITY_COLORS[incident.severity] || COLORS.subtleText
  const statusColour = STATUS_COLORS[incident.status] || COLORS.subtleText

  return (
    <button
      type="button"
      onClick={() => onSelect(incident)}
      aria-pressed={selected}
      data-testid={`incident-row-${incident.id}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '18px 1fr auto auto auto',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        border: '1px solid rgba(255,255,255,0.08)',
        borderLeft: `3px solid ${severityColour}`,
        borderRadius: 8,
        background: selected
          ? 'linear-gradient(145deg, rgba(168,85,247,0.12), rgba(56,189,248,0.04))'
          : 'rgba(255,255,255,0.03)',
        color: '#fff',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        width: '100%',
        textAlign: 'left',
        fontFamily: F,
      }}
    >
      <SeverityDot severity={incident.severity} />
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: '#fff',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {incident.title}
        </div>
        <div style={{
          fontFamily: M,
          fontSize: 10,
          color: COLORS.subtleText,
          letterSpacing: 0.4,
          marginTop: 2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {incident.agent_id || '—'} · {incident.layer || 'pipeline'} · {incident.policy_name || incident.incident_type}
        </div>
      </div>
      <GlassPill color={severityColour}>{incident.severity}</GlassPill>
      <GlassPill color={statusColour}>{incident.status.replace('_', ' ')}</GlassPill>
      <span style={{
        fontFamily: M,
        fontSize: 10,
        color: COLORS.subtleText,
        minWidth: 36,
        textAlign: 'right',
      }}>
        {formatAge(incident.created_at)}
      </span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────

function IncidentDetail({ incident, envelopes, onPatch, onWitness, busy }) {
  const [resolution, setResolution] = useState(incident.resolution || '')
  const [nextStatus, setNextStatus] = useState(incident.status)

  useEffect(() => {
    setResolution(incident.resolution || '')
    setNextStatus(incident.status)
  }, [incident.id, incident.status, incident.resolution])

  const canSave = useMemo(() => {
    if (busy) return false
    if (nextStatus === incident.status && resolution === (incident.resolution || '')) return false
    return true
  }, [busy, nextStatus, incident.status, resolution, incident.resolution])

  const severityColour = SEVERITY_COLORS[incident.severity] || COLORS.subtleText

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <GlassPanel highlight={severityColour}>
        <SectionHeader title="Incident" subtitle={incident.id} />
        <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 8 }}>
          {incident.title}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          <GlassPill color={severityColour}>{incident.severity}</GlassPill>
          <GlassPill color={STATUS_COLORS[incident.status]}>{incident.status.replace('_', ' ')}</GlassPill>
          <GlassPill color={COLORS.cyan}>{incident.incident_type}</GlassPill>
          {incident.layer && <GlassPill color={COLORS.purple}>{incident.layer}</GlassPill>}
          {incident.witnessed_by_ward && (
            <GlassPill color={COLORS.green}>WARD ✓</GlassPill>
          )}
        </div>
        {incident.description && (
          <div style={{
            fontFamily: F,
            fontSize: 12,
            color: COLORS.subtleText,
            lineHeight: 1.6,
            marginBottom: 10,
          }}>
            {incident.description}
          </div>
        )}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          fontFamily: M,
          fontSize: 10,
          color: COLORS.subtleText,
        }}>
          <div><span style={{ opacity: 0.7 }}>agent</span> · <span style={{ color: '#fff' }}>{incident.agent_id || '—'}</span></div>
          <div><span style={{ opacity: 0.7 }}>user</span> · <span style={{ color: '#fff' }}>{incident.user_id || '—'}</span></div>
          <div><span style={{ opacity: 0.7 }}>corr</span> · <span style={{ color: '#fff' }}>{incident.corr}</span></div>
          <div><span style={{ opacity: 0.7 }}>age</span> · <span style={{ color: '#fff' }}>{formatAge(incident.created_at)}</span></div>
        </div>
        {incident.framework_mapping?.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {incident.framework_mapping.map((fw) => (
              <GlassPill key={fw} color={COLORS.purple}>{fw}</GlassPill>
            ))}
          </div>
        )}
      </GlassPanel>

      <GlassPanel>
        <SectionHeader title="Resolve" subtitle="Update status + resolution notes" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, letterSpacing: 1 }}>
            STATUS
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STATUS_OPTIONS.map((opt) => {
              const active = nextStatus === opt
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setNextStatus(opt)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: active
                      ? `1px solid ${STATUS_COLORS[opt]}80`
                      : '1px solid rgba(255,255,255,0.12)',
                    background: active
                      ? `${STATUS_COLORS[opt]}22`
                      : 'rgba(255,255,255,0.03)',
                    color: active ? '#fff' : COLORS.subtleText,
                    fontFamily: M,
                    fontSize: 10,
                    fontWeight: active ? 700 : 500,
                    letterSpacing: 0.5,
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >
                  {opt.replace('_', ' ')}
                </button>
              )
            })}
          </div>

          <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, letterSpacing: 1 }}>
            RESOLUTION NOTES
          </label>
          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            rows={3}
            placeholder="Describe the remediation or why this is closing…"
            style={{
              padding: 10,
              borderRadius: 8,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: '#fff',
              fontFamily: F,
              fontSize: 12,
              resize: 'vertical',
              outline: 'none',
            }}
          />

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <GlassButton
              onClick={() => onWitness(incident)}
              disabled={busy || incident.witnessed_by_ward}
            >
              {incident.witnessed_by_ward ? 'WARD witnessed' : 'Witness via WARD'}
            </GlassButton>
            <GlassButton
              variant="primary"
              onClick={() => onPatch({
                status: nextStatus,
                resolution,
              })}
              disabled={!canSave}
            >
              Save
            </GlassButton>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel>
        <SectionHeader
          title="Linked envelopes"
          subtitle={`${envelopes.length} envelope${envelopes.length === 1 ? '' : 's'} on corr ${incident.corr}`}
        />
        {envelopes.length === 0 ? (
          <div style={{
            fontFamily: F,
            fontSize: 12,
            color: COLORS.subtleText,
            padding: '12px 4px',
          }}>
            No envelopes recorded for this correlation id.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {envelopes.map((env) => (
              <div
                key={env.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '90px 1fr 80px',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'rgba(255,255,255,0.02)',
                  fontFamily: M,
                  fontSize: 10,
                  color: '#fff',
                }}
              >
                <span style={{ color: COLORS.subtleText }}>{new Date(env.ts).toISOString().slice(11, 19)}</span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{env.intent}</span>
                <span style={{ color: COLORS.subtleText, textAlign: 'right' }}>{env.type}</span>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      {RESOLVE_STATUSES.has(incident.status) && incident.resolved_at && (
        <GlassPanel>
          <SectionHeader
            title="Closed"
            subtitle={new Date(incident.resolved_at).toLocaleString()}
          />
          {incident.resolution && (
            <div style={{ fontFamily: F, fontSize: 12, color: '#fff', lineHeight: 1.6 }}>
              {incident.resolution}
            </div>
          )}
        </GlassPanel>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────

export default function GovernanceIncidents() {
  const [range, setRange] = useState(RANGE_OPTIONS[2]) // default 7d
  const [severityFilter, setSeverityFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('open')
  const [incidents, setIncidents] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [envelopes, setEnvelopes] = useState([])
  const [busy, setBusy] = useState(false)
  const [wsStatus, setWsStatus] = useState('idle')

  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const reload = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const { data, total } = await listIncidents({
        severity: severityFilter || undefined,
        status: statusFilter || undefined,
        since: sinceFor(range) || undefined,
        limit: 100,
      })
      if (!mountedRef.current) return
      setIncidents(data)
      setTotal(total)
      // Keep the selected incident in sync — if it still exists, refresh;
      // otherwise drop it.
      if (selected) {
        const next = data.find((i) => i.id === selected.id)
        if (next) setSelected(next)
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message || 'Failed to load incidents')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severityFilter, statusFilter, range])

  useEffect(() => { reload() }, [reload])

  // Live updates
  useEffect(() => {
    const dispose = subscribeToIncidents(
      () => { reload() },
      {
        onStatus: (s) => mountedRef.current && setWsStatus(s),
      },
    )
    return dispose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload])

  // Load envelopes for the selected incident
  useEffect(() => {
    if (!selected) { setEnvelopes([]); return }
    let cancelled = false
    getIncident(selected.id)
      .then(({ incident, envelopes }) => {
        if (cancelled) return
        setSelected(incident)
        setEnvelopes(envelopes || [])
      })
      .catch((err) => {
        if (!cancelled) console.warn('[MON-GOV] fetch detail failed:', err.message)
      })
    return () => { cancelled = true }
  }, [selected?.id])

  const onPatch = useCallback(async (patch) => {
    if (!selected) return
    try {
      setBusy(true)
      const { incident } = await updateIncident(selected.id, patch)
      setSelected(incident)
      // Refresh list in background — live stream will also fire.
      reload()
    } catch (err) {
      setError(err.message || 'Failed to update incident')
    } finally {
      setBusy(false)
    }
  }, [selected, reload])

  const onWitness = useCallback(async (incident) => {
    try {
      setBusy(true)
      const { incident: next } = await witnessIncident(incident.id)
      setSelected(next)
      reload()
    } catch (err) {
      setError(err.message || 'Failed to witness incident')
    } finally {
      setBusy(false)
    }
  }, [reload])

  const headerRight = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: wsStatus === 'open' ? COLORS.green : COLORS.subtleText,
        boxShadow: wsStatus === 'open' ? `0 0 6px ${COLORS.green}80` : 'none',
      }} />
      <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 1 }}>
        {wsStatus === 'open' ? 'LIVE' : 'OFFLINE'}
      </span>
    </div>
  )

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(340px, 1.2fr) minmax(360px, 1fr)',
      gap: 16,
      alignItems: 'stretch',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <GlassPanel>
          <SectionHeader
            title="Governance incidents"
            subtitle={`${total} total${incidents.length < total ? ` · showing ${incidents.length}` : ''}`}
            action={headerRight}
          />

          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 10,
          }}>
            <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              {RANGE_OPTIONS.map((opt) => {
                const active = range.label === opt.label
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setRange(opt)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: active ? 'rgba(56,189,248,0.18)' : 'transparent',
                      color: active ? '#fff' : COLORS.subtleText,
                      fontFamily: M,
                      fontSize: 10,
                      fontWeight: active ? 700 : 500,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>

            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                fontFamily: M,
                fontSize: 10,
                outline: 'none',
              }}
              aria-label="Filter by severity"
            >
              <option value="">all severity</option>
              <option value="critical">critical</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
              <option value="info">info</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                fontFamily: M,
                fontSize: 10,
                outline: 'none',
              }}
              aria-label="Filter by status"
            >
              <option value="">all status</option>
              <option value="open">open</option>
              <option value="investigating">investigating</option>
              <option value="resolved">resolved</option>
              <option value="closed">closed</option>
              <option value="false_positive">false positive</option>
            </select>

            <button
              type="button"
              onClick={() => reload()}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                fontFamily: M,
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: 0.5,
              }}
            >
              REFRESH
            </button>
          </div>

          {error ? (
            <GlassError message={error} onRetry={reload} />
          ) : loading ? (
            <GlassSkeleton height={220} />
          ) : incidents.length === 0 ? (
            <div style={{
              padding: 32,
              textAlign: 'center',
              fontFamily: F,
              color: COLORS.subtleText,
              fontSize: 13,
            }}>
              <div style={{ fontSize: 28, opacity: 0.4, marginBottom: 8 }}>○</div>
              No incidents in the selected window. This is the happy path —
              your policies are holding.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {incidents.map((inc) => (
                <IncidentRow
                  key={inc.id}
                  incident={inc}
                  selected={selected?.id === inc.id}
                  onSelect={setSelected}
                />
              ))}
            </div>
          )}
        </GlassPanel>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        {selected ? (
          <IncidentDetail
            incident={selected}
            envelopes={envelopes}
            onPatch={onPatch}
            onWitness={onWitness}
            busy={busy}
          />
        ) : (
          <GlassPanel style={{ minHeight: 240 }}>
            <div style={{
              padding: 32,
              textAlign: 'center',
              fontFamily: F,
              color: COLORS.subtleText,
              fontSize: 13,
            }}>
              <div style={{ fontSize: 28, opacity: 0.4, marginBottom: 8 }}>◐</div>
              Select an incident to see context, linked envelopes, and
              resolution controls.
            </div>
          </GlassPanel>
        )}
        <AgentHealthPanel />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Agent Health sub-panel — per-agent baselines + deviation indicator.
// Pure read-only view; anomalies flow into the main incident list via
// the backend detector, so clicks on a row just scroll the incident
// list filter. Refreshes hourly with a manual button for faster
// turnarounds.

function AgentHealthPanel() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const { data } = await listBaselines()
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'Failed to load baselines')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
    const iv = setInterval(reload, 60 * 60 * 1000) // hourly
    return () => clearInterval(iv)
  }, [reload])

  const grouped = useMemo(() => {
    const byAgent = new Map()
    for (const r of rows) {
      if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, new Map())
      byAgent.get(r.agent_id).set(r.metric, r)
    }
    return [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  return (
    <GlassPanel>
      <SectionHeader
        title="Agent Health"
        subtitle="Rolling 7-day behavioural baselines per agent"
        action={
          <button
            type="button"
            onClick={reload}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: '#fff',
              fontFamily: M,
              fontSize: 9,
              cursor: 'pointer',
              letterSpacing: 0.5,
              fontWeight: 600,
            }}
          >
            REFRESH
          </button>
        }
      />
      {error ? (
        <div style={{ fontFamily: F, fontSize: 12, color: COLORS.red }}>{error}</div>
      ) : loading ? (
        <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>Loading baselines…</div>
      ) : grouped.length === 0 ? (
        <div style={{
          fontFamily: F, fontSize: 12, color: COLORS.subtleText,
          padding: '12px 4px',
        }}>
          No baselines computed yet. The collector recomputes hourly — check
          back after a chat request has fired at least once.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1.2fr 1fr 1fr 1fr 0.8fr',
            gap: 8,
            padding: '4px 8px',
            fontFamily: M,
            fontSize: 9,
            color: COLORS.subtleText,
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}>
            <span>agent</span>
            <span>metric</span>
            <span>baseline</span>
            <span>σ</span>
            <span style={{ textAlign: 'right' }}>samples</span>
          </div>
          {grouped.map(([agent, byMetric]) => (
            [...byMetric.entries()].map(([metric, baseline]) => (
              <div
                key={`${agent}/${metric}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.2fr 1fr 1fr 1fr 0.8fr',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'rgba(255,255,255,0.02)',
                  fontFamily: M,
                  fontSize: 10,
                  color: '#fff',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontWeight: 600 }}>{agent}</span>
                <span style={{ color: COLORS.subtleText }}>{metric}</span>
                <span>{Number(baseline.baseline_value).toFixed(2)}</span>
                <span>{Number(baseline.stddev).toFixed(2)}</span>
                <span style={{ textAlign: 'right', color: COLORS.subtleText }}>
                  {baseline.sample_count}
                </span>
              </div>
            ))
          ))}
        </div>
      )}
    </GlassPanel>
  )
}
