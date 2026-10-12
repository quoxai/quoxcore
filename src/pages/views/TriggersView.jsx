/**
 * TriggersView — STUDY-REV-2 P8.A
 *
 * Unified trigger management surface. Four tabs:
 *   Webhooks   — registered webhook paths from WebhookRegistry
 *   Schedules  — cron schedules (owned by tasks or quoxflow), pausable/editable here
 *   Events     — EventBus subscriptions per workflow
 *   Costs      — per-workflow execution cost roll-up
 *
 * Manage-and-inspect surface: triggers are CREATED and DELETED in the workflow
 * builder (deep-linked from each tab); here you pause/resume/edit and inspect.
 * Structural chrome uses the glass design system (qx-* classes); a few
 * interactive bits (calendar grid, toolbar, toast) still carry inline styling.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import {
  listWebhookTriggers,
  listEventTriggers,
  testFireWebhook,
} from '../../services/triggersClient'
import { listBudgets, getUsage } from '../../services/budgetClient'
import { listSchedules, listWorkflows, summarizeWorkflow, pauseSchedule, resumeSchedule, updateSchedule } from '../../services/workflowEngine'
import { cronToHuman, formatCountdown, getScheduledDays } from '../../services/cronHelper'
import { ScheduleEditModal } from '../../components/workflow'
import './views.css'

// ── Icons ─────────────────────────────────────────────────────────────────────

const Icons = {
  copy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  play: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  link: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  edit: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
  webhook: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  clock: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  event: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  dollar: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  refresh: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  ),
  list: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  ),
  calendar: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  ),
  pause: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
    </svg>
  ),
  resume: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  ),
  chevronLeft: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  ),
  chevronRight: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  ),
}

// ── Utility ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return '—' }
}

function buildFullUrl(path) {
  // Webhooks are served at /webhooks/<path> on the quoxflow service.
  // In production this is proxied. We construct a relative display URL.
  return `/webhooks/${path.replace(/^\//, '')}`
}

// ── CopyButton ─────────────────────────────────────────────────────────────────

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <button
      className="qx-row-action"
      onClick={handleCopy}
      title="Copy URL"
      type="button"
      style={{ padding: 0, background: 'none', border: 'none' }}
    >
      {copied ? Icons.check : Icons.copy}
    </button>
  )
}

// ── TestFireButton ─────────────────────────────────────────────────────────────

function TestFireButton({ path, authFetch, onFired }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleFire = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await testFireWebhook({ authFetch, path })
      onFired?.(result)
    } catch (err) {
      setError(err?.message || 'Fire failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <span>
      <button
        className="qx-row-action"
        onClick={handleFire}
        disabled={loading}
        title="Test fire this webhook"
        type="button"
        style={{ padding: 0, background: 'none', border: 'none', opacity: loading ? 0.5 : 1 }}
      >
        {Icons.play}
      </button>
      {error && (
        <span style={{ color: 'var(--m-danger, #f87171)', fontSize: 11, marginLeft: 4 }}>{error}</span>
      )}
    </span>
  )
}

// ── LastFiredDrawer ─────────────────────────────────────────────────────────────

function LastFiredDrawer({ execution, onClose }) {
  if (!execution) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      }}
    >
      <div
        className="qx-card"
        onClick={e => e.stopPropagation()}
        style={{ width: 360, height: '100%', borderRadius: 0, overflowY: 'auto', padding: 24 }}
      >
        <div className="qx-row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontWeight: 700, color: 'var(--m-text-primary)' }}>Test Fire Result</span>
          <button className="qx-row-action" onClick={onClose} type="button" style={{ padding: 0, background: 'none', border: 'none' }}>×</button>
        </div>
        <div className="qx-stack" style={{ gap: 8 }}>
          <div>
            <span style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>Execution ID</span>
            <div style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--m-text-primary)' }}>
              {execution.executionId || '—'}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>Status</span>
            <div>
              <span className="qx-pill" style={{ fontSize: 11 }}>{execution.status || '—'}</span>
            </div>
          </div>
          {execution.executionId && (
            <Link
              to={`/executions/${execution.executionId}`}
              style={{ color: 'var(--m-accent-cyan, #4ecdc4)', fontSize: 13 }}
            >
              View execution details {Icons.link}
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// ── WebhooksTab ────────────────────────────────────────────────────────────────

// Auto-generated webhooks attached to objective workflows (paths start with
// `objective/<ULID>` and the owning workflow id starts with `wf-obj-`). These
// are infrastructure plumbing for the OBJ_ flow, not user-built triggers, so
// hide them by default to keep the table about user intent.
function isObjectiveWebhook(wh) {
  const path = (wh.path || '').replace(/^\//, '')
  const wfid = wh.workflowId || ''
  return path.startsWith('objective/') || wfid.startsWith('wf-obj-')
}

function WebhooksTab({ authFetch }) {
  const [webhooks, setWebhooks] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastFired, setLastFired] = useState(null)
  const [showSystem, setShowSystem] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    listWebhookTriggers({ authFetch })
      .then(data => setWebhooks(data.webhooks || []))
      .catch(err => setError(err?.message || 'Failed to load webhooks'))
      .finally(() => setLoading(false))
  }, [authFetch])

  useEffect(() => { load() }, [load])

  if (loading) {
    return <div className="qx-empty"><p>Loading webhook triggers…</p></div>
  }
  if (error) {
    return <div className="qx-banner qx-banner--error">{error}</div>
  }

  const allWebhooks = webhooks || []
  const systemCount = allWebhooks.filter(isObjectiveWebhook).length
  const visibleWebhooks = showSystem ? allWebhooks : allWebhooks.filter(wh => !isObjectiveWebhook(wh))

  if (allWebhooks.length === 0) {
    return (
      <div className="qx-empty">
        <p>No webhook triggers registered.</p>
        <p style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }}>
          Add a <code>trigger:webhook</code> node in the{' '}
          <Link to="/workflows-hub?tab=build" style={{ color: 'var(--m-accent-cyan, #4ecdc4)' }}>
            Workflow Builder
          </Link>{' '}
          and activate the workflow.
        </p>
      </div>
    )
  }

  return (
    <>
      {lastFired && <LastFiredDrawer execution={lastFired} onClose={() => setLastFired(null)} />}
      {systemCount > 0 && (
        <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, fontSize: 12, color: 'var(--m-text-tertiary)' }}>
          <span>
            {showSystem
              ? `Showing all ${allWebhooks.length} webhooks (${systemCount} system / objective-owned)`
              : `${visibleWebhooks.length} user webhook${visibleWebhooks.length === 1 ? '' : 's'} · ${systemCount} system webhook${systemCount === 1 ? '' : 's'} hidden`}
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            Show system webhooks
          </label>
        </div>
      )}
      {visibleWebhooks.length === 0 && (
        <div className="qx-empty">
          <p>No user-created webhook triggers yet.</p>
          <p style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }}>
            Add a <code>trigger:webhook</code> node in the{' '}
            <Link to="/workflows-hub?tab=build" style={{ color: 'var(--m-accent-cyan, #4ecdc4)' }}>
              Workflow Builder
            </Link>{' '}
            and activate the workflow. Toggle "Show system webhooks" above to see auto-generated objective webhooks.
          </p>
        </div>
      )}
      {visibleWebhooks.length > 0 && (
      <div style={{ overflowX: 'auto' }}>
        <table className="qx-table">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Method</th>
              <th>URL</th>
              <th>Last Fired</th>
              <th>Fire Count</th>
              <th style={{ width: 80 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleWebhooks.map(wh => {
              const fullUrl = buildFullUrl(wh.path)
              return (
                <tr key={`${wh.workflowId}:${wh.path}`}>
                  <td>
                    <Link
                      to={`/workflows-hub?tab=build&id=${encodeURIComponent(wh.workflowId)}`}
                      style={{ color: 'var(--m-accent-cyan, #4ecdc4)', textDecoration: 'none' }}
                    >
                      {wh.workflowId}
                    </Link>
                  </td>
                  <td>
                    <span className="qx-pill" style={{ fontSize: 11 }}>{wh.method}</span>
                  </td>
                  <td>
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{fullUrl}</span>
                    {' '}
                    <CopyButton text={`${window.location.origin}${fullUrl}`} />
                  </td>
                  <td style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>{formatDate(wh.lastFiredAt)}</td>
                  <td style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>
                    {wh.fireCount != null ? wh.fireCount : '—'}
                  </td>
                  <td>
                    <TestFireButton
                      path={wh.path}
                      authFetch={authFetch}
                      onFired={result => setLastFired(result)}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      )}
    </>
  )
}

// ── SchedulesTab ────────────────────────────────────────────────────────────────
// Enriched variant: calendar↔list toggle, workflow name enrichment, pause/resume,
// search/filter/sort, agent attribution. Layout leaves room for a future CalendarQ
// right-rail (flex-column parent, no locked width).

const STATUS_COLORS_SCH = {
  active: 'var(--color-success, #4ade80)',
  paused: 'var(--color-warning, #fbbf24)',
}

function formatWorkflowId(id) {
  if (!id) return 'Unnamed Schedule'
  let name = id.replace(/^wf-/, '').replace(/-[a-z0-9]{6,}$/i, '')
  name = name.replace(/[-_]+/g, ' ').trim()
  if (!name || name.length < 3) return 'Schedule ' + (id.slice(-6) || id)
  return name.replace(/\b\w/g, c => c.toUpperCase())
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

function SchedulesTab({ authFetch }) {
  const [schedules, setSchedules] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [feedback, setFeedback] = useState(null)

  // View mode
  const [viewMode, setViewMode] = useState('list') // 'list' | 'calendar'

  // Search / filter / sort
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortBy, setSortBy] = useState('nextRun')

  // Calendar state
  const now = new Date()
  const [calendarMonth, setCalendarMonth] = useState(now.getMonth())
  const [calendarYear, setCalendarYear] = useState(now.getFullYear())
  const [selectedDay, setSelectedDay] = useState(null)

  // Edit / detail modals
  const [selectedSchedule, setSelectedSchedule] = useState(null)
  const [editSchedule, setEditSchedule] = useState(null)
  const [editLoading, setEditLoading] = useState(false)

  const refreshTimerRef = useRef(null)

  // Auto-dismiss feedback
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 5000)
    return () => clearTimeout(t)
  }, [feedback])

  const loadSchedules = useCallback(async () => {
    try {
      const [scheduleData, workflowData] = await Promise.allSettled([
        listSchedules(),
        listWorkflows({ limit: 100 }),
      ])

      const rawSchedules = scheduleData.status === 'fulfilled'
        ? (Array.isArray(scheduleData.value) ? scheduleData.value : [])
        : []

      const workflowMap = {}
      if (workflowData.status === 'fulfilled') {
        const wfs = workflowData.value?.workflows || []
        for (const w of wfs) {
          const summary = summarizeWorkflow(w)
          workflowMap[w.id] = summary
          if (w.externalId) workflowMap[w.externalId] = summary
          const stripped = (w.id || '').replace(/^wf-/, '')
          if (stripped !== w.id) workflowMap[stripped] = summary
        }
      }

      const lookupWorkflow = (wfId) => {
        if (!wfId) return null
        if (workflowMap[wfId]) return workflowMap[wfId]
        const stripped = wfId.replace(/^wf-/, '')
        if (workflowMap[stripped]) return workflowMap[stripped]
        for (const [key, val] of Object.entries(workflowMap)) {
          if (wfId.includes(key) || key.includes(wfId)) return val
        }
        return null
      }

      const enriched = rawSchedules.map(s => {
        const wf = lookupWorkflow(s.workflowId)
        const cronExpression = s.cronExpression || s.expression || s.cron || ''
        return {
          ...s,
          cronExpression,
          workflowName: s.workflowName || s.name || wf?.name || formatWorkflowId(s.workflowId),
          workflowDescription: s.workflowDescription || wf?.description,
          workflowNodeCount: s.workflowNodeCount || wf?.nodeCount,
          nextRun: s.nextRun || s.nextFireAt,
        }
      })

      setSchedules(enriched)
      setError(null)
    } catch (err) {
      setError(err?.message || 'Failed to load schedules')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSchedules()
    refreshTimerRef.current = setInterval(loadSchedules, 30000)
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current) }
  }, [loadSchedules])

  const togglePause = async (schedule) => {
    try {
      if (schedule.active !== false) {
        await pauseSchedule(schedule.workflowId, schedule.nodeId)
        setFeedback({ message: `Paused: ${schedule.workflowName || schedule.workflowId}`, type: 'warning' })
      } else {
        await resumeSchedule(schedule.workflowId, schedule.nodeId)
        setFeedback({ message: `Resumed: ${schedule.workflowName || schedule.workflowId}`, type: 'success' })
      }
      loadSchedules()
    } catch (err) {
      setError(`Failed to toggle schedule: ${err?.message}`)
    }
  }

  const submitEditSchedule = async (updates) => {
    setEditLoading(true)
    try {
      await updateSchedule(updates.workflowId, updates.nodeId, {
        expression: updates.expression,
        timezone: updates.timezone,
        paused: updates.paused,
      })
      setEditSchedule(null)
      setFeedback({ message: 'Schedule updated', type: 'success' })
      loadSchedules()
    } catch (err) {
      throw new Error(err?.message || 'Failed to update schedule')
    } finally {
      setEditLoading(false)
    }
  }

  const filteredSchedules = useMemo(() => {
    let result = [...schedules]
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase()
      result = result.filter(s => {
        const name = (s.workflowName || s.workflowId || '').toLowerCase()
        const cron = cronToHuman(s.cronExpression || '').toLowerCase()
        const tz = (s.timezone || '').toLowerCase()
        const desc = (s.workflowDescription || '').toLowerCase()
        return name.includes(q) || cron.includes(q) || tz.includes(q) || desc.includes(q)
      })
    }
    if (statusFilter === 'active') result = result.filter(s => s.active !== false)
    else if (statusFilter === 'paused') result = result.filter(s => s.active === false)
    result.sort((a, b) => {
      if (sortBy === 'nextRun') {
        const aT = a.nextRun ? new Date(a.nextRun).getTime() : Infinity
        const bT = b.nextRun ? new Date(b.nextRun).getTime() : Infinity
        return aT - bT
      }
      if (sortBy === 'name') return (a.workflowName || '').localeCompare(b.workflowName || '')
      if (sortBy === 'expression') return (a.cronExpression || '').localeCompare(b.cronExpression || '')
      return 0
    })
    return result
  }, [schedules, searchTerm, statusFilter, sortBy])

  const calendarData = useMemo(() => {
    if (viewMode !== 'calendar') return {}
    const dayMap = {}
    for (const s of filteredSchedules) {
      const expr = s.cronExpression || ''
      if (!expr) continue
      const days = getScheduledDays(expr, calendarYear, calendarMonth)
      for (const d of days) {
        if (!dayMap[d]) dayMap[d] = []
        dayMap[d].push(s)
      }
    }
    return dayMap
  }, [filteredSchedules, calendarYear, calendarMonth, viewMode])

  const dayFilteredSchedules = useMemo(() => {
    if (selectedDay === null || viewMode !== 'calendar') return filteredSchedules
    return calendarData[selectedDay] || []
  }, [selectedDay, filteredSchedules, calendarData, viewMode])

  const activeCount = schedules.filter(s => s.active !== false).length
  const pausedCount = schedules.filter(s => s.active === false).length
  const nextExecution = schedules.filter(s => s.nextRun).sort((a, b) => new Date(a.nextRun) - new Date(b.nextRun))[0]

  const navigateMonth = (delta) => {
    let m = calendarMonth + delta
    let y = calendarYear
    if (m < 0) { m = 11; y-- }
    if (m > 11) { m = 0; y++ }
    setCalendarMonth(m); setCalendarYear(y); setSelectedDay(null)
  }

  if (loading) return <div className="qx-empty"><p>Loading schedule triggers…</p></div>
  if (error) return <div className="qx-banner qx-banner--error">{error}</div>

  return (
    // Flex-column parent — leaves room for a future CalendarQ right-rail
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 12 }}>
      {/* Toolbar: search + filters + view toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 120 }}>
          <input
            type="text"
            placeholder="Search schedules…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '5px 8px 5px 28px',
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6, color: 'var(--m-text-primary)', fontSize: 12,
            }}
          />
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>

        {/* Status filter pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[['all', `All (${schedules.length})`], ['active', `Active (${activeCount})`], ['paused', `Paused (${pausedCount})`]].map(([val, label]) => (
            <button key={val} onClick={() => setStatusFilter(val)} type="button"
              className={`qx-tab${statusFilter === val ? ' qx-tab--active' : ''}`}
              style={{ fontSize: 11, padding: '3px 8px' }}
            >{label}</button>
          ))}
        </div>

        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ fontSize: 11, padding: '4px 6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: 'var(--m-text-primary)' }}>
          <option value="nextRun">Sort: Next Run</option>
          <option value="name">Sort: Name</option>
          <option value="expression">Sort: Expression</option>
        </select>

        {/* View toggle */}
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          <button type="button" title="List view" onClick={() => { setViewMode('list'); setSelectedDay(null) }}
            className={`qx-row-action${viewMode === 'list' ? ' qx-tab--active' : ''}`}
            style={{ padding: '4px 6px', background: viewMode === 'list' ? 'rgba(78,205,196,0.15)' : 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5 }}>
            {Icons.list}
          </button>
          <button type="button" title="Calendar view" onClick={() => setViewMode('calendar')}
            className={`qx-row-action${viewMode === 'calendar' ? ' qx-tab--active' : ''}`}
            style={{ padding: '4px 6px', background: viewMode === 'calendar' ? 'rgba(78,205,196,0.15)' : 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5 }}>
            {Icons.calendar}
          </button>
          <button type="button" title="Refresh" onClick={() => { setLoading(true); loadSchedules() }}
            className="qx-row-action"
            style={{ padding: '4px 6px', background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5, marginLeft: 4 }}>
            {Icons.refresh}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      {schedules.length > 0 && (
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          <span style={{ color: 'var(--color-success, #4ade80)' }}>{activeCount} active</span>
          {pausedCount > 0 && <span style={{ color: 'var(--color-warning, #fbbf24)' }}>{pausedCount} paused</span>}
          {nextExecution && (
            <span style={{ color: 'var(--m-text-tertiary)' }}>
              Next: <strong>{nextExecution.workflowName || nextExecution.workflowId}</strong>{' '}
              in {formatCountdown(nextExecution.nextRun)}
            </span>
          )}
        </div>
      )}

      {/* Calendar view */}
      {viewMode === 'calendar' && (
        <div>
          {/* Calendar nav */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <button type="button" className="qx-row-action" style={{ padding: '4px 6px', background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5 }} onClick={() => navigateMonth(-1)}>
              {Icons.chevronLeft}
            </button>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-text-primary)' }}>
              {MONTH_NAMES[calendarMonth]} {calendarYear}
            </span>
            <button type="button" className="qx-row-action" style={{ padding: '4px 6px', background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5 }} onClick={() => navigateMonth(1)}>
              {Icons.chevronRight}
            </button>
            <button type="button" className="qx-row-action" style={{ padding: '4px 8px', fontSize: 11, background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5, marginLeft: 4 }} onClick={() => { const t = new Date(); setCalendarMonth(t.getMonth()); setCalendarYear(t.getFullYear()); setSelectedDay(null) }}>
              Today
            </button>
            {selectedDay !== null && (
              <button type="button" className="qx-row-action" style={{ padding: '4px 8px', fontSize: 11, background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5 }} onClick={() => setSelectedDay(null)}>
                Clear day filter
              </button>
            )}
          </div>

          {/* Calendar grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 12 }}>
            {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 10, color: 'var(--m-text-tertiary)', padding: '4px 0', fontWeight: 600 }}>{d}</div>
            ))}
            {(() => {
              const firstDay = new Date(calendarYear, calendarMonth, 1).getDay()
              const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate()
              const today = new Date()
              const isCurrentMonth = today.getMonth() === calendarMonth && today.getFullYear() === calendarYear
              const todayDate = today.getDate()
              const cells = []
              for (let i = 0; i < firstDay; i++) cells.push(<div key={`e-${i}`} />)
              for (let day = 1; day <= daysInMonth; day++) {
                const events = calendarData[day] || []
                const hasEvents = events.length > 0
                const isToday = isCurrentMonth && day === todayDate
                const isSelected = selectedDay === day
                cells.push(
                  <div key={day}
                    onClick={() => hasEvents ? setSelectedDay(isSelected ? null : day) : null}
                    role={hasEvents ? 'button' : undefined}
                    tabIndex={hasEvents ? 0 : undefined}
                    onKeyDown={hasEvents ? (e) => e.key === 'Enter' && setSelectedDay(isSelected ? null : day) : undefined}
                    style={{
                      textAlign: 'center', padding: '6px 2px', borderRadius: 6,
                      fontSize: 11, minHeight: 40,
                      background: isSelected ? 'rgba(78,205,196,0.2)' : isToday ? 'rgba(78,205,196,0.08)' : hasEvents ? 'rgba(255,255,255,0.04)' : 'transparent',
                      border: isToday ? '1px solid rgba(78,205,196,0.4)' : '1px solid transparent',
                      cursor: hasEvents ? 'pointer' : 'default',
                      color: 'var(--m-text-primary)',
                    }}
                  >
                    <div>{day}</div>
                    {hasEvents && (
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 2, flexWrap: 'wrap', marginTop: 2 }}>
                        {events.slice(0, 4).map((ev, i) => (
                          <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: ev.active !== false ? STATUS_COLORS_SCH.active : STATUS_COLORS_SCH.paused, display: 'inline-block' }} title={ev.workflowName || ev.workflowId} />
                        ))}
                        {events.length > 4 && <span style={{ fontSize: 9, color: 'var(--m-text-tertiary)' }}>+{events.length - 4}</span>}
                      </div>
                    )}
                  </div>
                )
              }
              return cells
            })()}
          </div>

          {/* Day detail list */}
          {selectedDay !== null && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--m-text-tertiary)', marginBottom: 6 }}>
                {MONTH_NAMES[calendarMonth]} {selectedDay}, {calendarYear} — {dayFilteredSchedules.length} schedule{dayFilteredSchedules.length !== 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Schedule table */}
      {filteredSchedules.length === 0 && viewMode === 'list' && (
        <div className="qx-empty">
          <p>{searchTerm || statusFilter !== 'all' ? 'No matching schedules.' : 'No active schedules. Add a schedule trigger node to a workflow.'}</p>
          {(searchTerm || statusFilter !== 'all') && (
            <button type="button" className="qx-row-action" style={{ fontSize: 12, padding: '4px 10px', marginTop: 4, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6 }} onClick={() => { setSearchTerm(''); setStatusFilter('all') }}>Clear Filters</button>
          )}
        </div>
      )}
      {(viewMode === 'list' ? filteredSchedules : dayFilteredSchedules).length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="qx-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Workflow</th>
                <th>Schedule</th>
                <th>Next Run</th>
                <th>Timezone</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(viewMode === 'list' ? filteredSchedules : dayFilteredSchedules).map(s => {
                const status = s.active !== false ? 'active' : 'paused'
                const humanCron = cronToHuman(s.cronExpression || '')
                return (
                  <tr key={`${s.workflowId}:${s.nodeId || s.id}`} onClick={() => setSelectedSchedule(s)} style={{ cursor: 'pointer' }}>
                    <td>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS_SCH[status], marginRight: 4 }} />
                      <span className={`qx-pill${status === 'paused' ? ' qx-pill--muted' : ''}`} style={{ fontSize: 10 }}>{status}</span>
                    </td>
                    <td>
                      <Link
                        to={`/workflows-hub?tab=build&id=${encodeURIComponent(s.workflowId)}`}
                        onClick={e => e.stopPropagation()}
                        style={{ color: 'var(--m-accent-cyan, #4ecdc4)', textDecoration: 'none', fontWeight: 500 }}
                      >
                        {s.workflowName || s.workflowId}
                      </Link>
                      {s.workflowDescription && (
                        <div style={{ fontSize: 11, color: 'var(--m-text-tertiary)', marginTop: 2, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.workflowDescription}</div>
                      )}
                    </td>
                    <td>
                      <div style={{ fontSize: 12 }}>{humanCron}</div>
                      {s.cronExpression && <code style={{ fontSize: 10, color: 'var(--m-text-tertiary)' }}>{s.cronExpression}</code>}
                    </td>
                    <td style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>
                      {s.nextRun ? formatCountdown(s.nextRun) : '—'}
                    </td>
                    <td style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>{s.timezone || 'UTC'}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button type="button" className="qx-row-action" title={status === 'active' ? 'Pause' : 'Resume'} onClick={() => togglePause(s)}
                          style={{ padding: 0, background: 'none', border: 'none' }}>
                          {status === 'active' ? Icons.pause : Icons.resume}
                        </button>
                        <button type="button" className="qx-row-action" title="Edit" onClick={() => setEditSchedule(s)}
                          style={{ padding: 0, background: 'none', border: 'none' }}>
                          {Icons.edit}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Schedule Edit Modal */}
      <ScheduleEditModal
        isOpen={!!editSchedule}
        onClose={() => !editLoading && setEditSchedule(null)}
        onSubmit={submitEditSchedule}
        schedule={editSchedule}
        loading={editLoading}
      />

      {/* Feedback toast */}
      {feedback && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 100, padding: '12px 20px', borderRadius: 8,
          background: feedback.type === 'success' ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
          border: `1px solid ${feedback.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}`,
          color: feedback.type === 'success' ? '#22c55e' : '#f59e0b',
          fontSize: '0.85rem', fontWeight: 500, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          {feedback.message}
        </div>
      )}
    </div>
  )
}

// ── EventsTab ──────────────────────────────────────────────────────────────────

function EventsTab({ authFetch }) {
  const [subs, setSubs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    listEventTriggers({ authFetch })
      .then(d => setSubs(d.subscriptions || []))
      .catch(err => setError(err?.message || 'Failed to load event subscriptions'))
      .finally(() => setLoading(false))
  }, [authFetch])

  if (loading) return <div className="qx-empty"><p>Loading event triggers…</p></div>
  if (error) return <div className="qx-banner qx-banner--error">{error}</div>
  if (!subs || subs.length === 0) {
    return (
      <div className="qx-empty">
        <p>No event trigger subscriptions registered.</p>
        <p style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }}>
          Add a <code>trigger:event</code> node in the{' '}
          <Link to="/workflows-hub?tab=build" style={{ color: 'var(--m-accent-cyan, #4ecdc4)' }}>
            Workflow Builder
          </Link>{' '}
          and activate the workflow.
        </p>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="qx-table">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Workflow</th>
            <th>Last Match</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {subs.map(sub => (
            <tr key={sub.id}>
              <td><code style={{ fontSize: 12 }}>{sub.pattern}</code></td>
              <td>
                {sub.workflowId ? (
                  <Link
                    to={`/workflows-hub?tab=build&id=${encodeURIComponent(sub.workflowId)}`}
                    style={{ color: 'var(--m-accent-cyan, #4ecdc4)', textDecoration: 'none' }}
                  >
                    {sub.workflowId}
                  </Link>
                ) : (
                  <span style={{ color: 'var(--m-text-tertiary)' }}>—</span>
                )}
              </td>
              <td style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>{formatDate(sub.lastMatchAt)}</td>
              <td>
                {sub.once ? (
                  <span className="qx-pill qx-pill--muted" style={{ fontSize: 11 }}>one-shot</span>
                ) : (
                  <span className="qx-pill" style={{ fontSize: 11 }}>persistent</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── CostsTab ───────────────────────────────────────────────────────────────────

function formatUsd(micro) {
  if (!micro) return '$0.0000'
  return `$${(micro / 1e6).toFixed(4)}`
}

function Sparkline({ daily = [] }) {
  // Simple inline sparkline — 7 bars from the last 7 days
  const vals = daily.slice(-7).map(d => d.cost_usd_micro || 0)
  if (vals.length === 0) return <span style={{ color: 'var(--m-text-tertiary)', fontSize: 11 }}>—</span>
  const max = Math.max(...vals, 1)
  return (
    <span className="qx-spark" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 20 }}>
      {vals.map((v, i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: 4,
            height: `${Math.max(2, Math.round((v / max) * 18))}px`,
            background: 'var(--m-accent-cyan, #4ecdc4)',
            borderRadius: 1,
            opacity: 0.75,
          }}
        />
      ))}
    </span>
  )
}

function CostsTab({ authFetch }) {
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    listBudgets({ authFetch, scope: 'execution' })
      .then(async budgets => {
        if (cancelled) return
        if (!budgets || budgets.length === 0) {
          setRows([])
          return
        }

        // Fetch usage for each execution-scope budget (last 30 days)
        const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
        const usageResults = await Promise.allSettled(
          budgets.map(b => getUsage({ authFetch, id: b.id, since }))
        )

        const result = budgets.map((b, i) => {
          const usageData = usageResults[i].status === 'fulfilled' ? usageResults[i].value : null
          const usage = usageData?.usage || {}
          const daily = usageData?.daily || []
          return {
            scopeId: b.scope_id,
            tokensIn: usage.tokens_in || 0,
            tokensOut: usage.tokens_out || 0,
            costMicro: usage.cost_usd_micro || 0,
            toolCalls: usage.tool_calls || 0,
            daily,
          }
        })

        if (!cancelled) setRows(result)
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'Failed to load costs') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [authFetch])

  if (loading) return <div className="qx-empty"><p>Loading cost data…</p></div>
  if (error) return <div className="qx-banner qx-banner--error">{error}</div>
  if (!rows || rows.length === 0) {
    return (
      <div className="qx-empty">
        <p>No cost data yet — runs are tracked once a workflow executes.</p>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <p style={{ fontSize: 11, color: 'var(--m-text-tertiary)', margin: '0 0 12px' }}>
        Cost is aggregated per workflow (execution-scope budgets, last 30 days), not per individual trigger.
      </p>
      <table className="qx-table">
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Tokens In</th>
            <th>Tokens Out</th>
            <th>Tool Calls</th>
            <th>Cost (USD)</th>
            <th>7d Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.scopeId}>
              <td>
                <Link
                  to={`/workflows-hub?tab=build&id=${encodeURIComponent(row.scopeId)}`}
                  style={{ color: 'var(--m-accent-cyan, #4ecdc4)', textDecoration: 'none' }}
                >
                  {row.scopeId}
                </Link>
              </td>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.tokensIn.toLocaleString()}</td>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.tokensOut.toLocaleString()}</td>
              <td style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>{row.toolCalls}</td>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{formatUsd(row.costMicro)}</td>
              <td><Sparkline daily={row.daily} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── TriggersView ───────────────────────────────────────────────────────────────

const VALID_TABS = ['webhooks', 'schedules', 'events', 'costs']

export default function TriggersView() {
  const { authFetch } = useAuth()
  const [params, setParams] = useSearchParams()

  // Deep-linkable tab via ?tab= param. Default = webhooks.
  const rawTab = params.get('tab')
  const tab = VALID_TABS.includes(rawTab) ? rawTab : 'webhooks'

  function switchTab(newTab) {
    // Preserve all existing params, only update tab.
    const next = new URLSearchParams(params)
    next.set('tab', newTab)
    setParams(next, { replace: true })
  }

  const tabs = [
    { id: 'webhooks', label: 'Webhooks', icon: Icons.webhook },
    { id: 'schedules', label: 'Schedules', icon: Icons.clock },
    { id: 'events', label: 'Events', icon: Icons.event },
    { id: 'costs', label: 'Costs', icon: Icons.dollar },
  ]

  return (
    <div className="qx-view" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--m-text-primary)' }}>
          Trigger Management
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--m-text-tertiary)' }}>
          Unified view of every trigger across your workflows: webhook URLs, scheduled crons, event subscriptions, and per-workflow cost roll-up. Schedules and webhooks live here regardless of which workflow they belong to.
        </p>
      </div>

      {/* Tab row */}
      <div className="qx-tabs" role="tablist" aria-label="Trigger type tabs" style={{ marginBottom: 16 }}>
        {tabs.map(t => (
          <button
            key={t.id}
            className={`qx-tab${tab === t.id ? ' qx-tab--active' : ''}`}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => switchTab(t.id)}
            type="button"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t.icon}{t.label}
            </span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="qx-card" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
        {tab === 'webhooks' && <WebhooksTab authFetch={authFetch} />}
        {tab === 'schedules' && <SchedulesTab authFetch={authFetch} />}
        {tab === 'events' && <EventsTab authFetch={authFetch} />}
        {tab === 'costs' && <CostsTab authFetch={authFetch} />}
      </div>
    </div>
  )
}
