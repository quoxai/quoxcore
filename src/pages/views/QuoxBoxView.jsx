/**
 * QuoxBoxView — QuoxBox Mac-mini governed gateway
 *
 * Surfaces the governed Mac-mini agent: live status, HITL pending approvals
 * (approve/deny inline), a live evidence/activity feed, a workflow launcher
 * ("Run a task"), and mode control (readonly/propose/actuate).
 *
 * Data path: collector proxy at /collector/api/quoxbox/* via useQuoxBoxData.
 * No browser-only persistence — all state comes from the proxy.
 *
 * Route: /quoxbox
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import useQuoxBoxData from '../../hooks/useQuoxBoxData'
import '../../styles/glass.css'

const MODES = [
  { value: 'readonly', label: 'Read-only', hint: 'Observe only — no actions are taken.' },
  { value: 'propose', label: 'Propose', hint: 'Every action is held for your approval.' },
  { value: 'actuate', label: 'Actuate', hint: 'Runs automatically within policy.' },
]

const STEP_BADGE = {
  done: { label: 'done', color: 'var(--q-green)' },
  failed: { label: 'failed', color: 'var(--q-red)' },
  awaiting_approval: { label: 'awaiting approval', color: 'var(--q-amber)' },
  denied: { label: 'denied', color: 'var(--q-red)' },
}

const EVENT_COLOR = e => ({
  allow: 'var(--q-green)',
  deny: 'var(--q-red)',
  deny_approval: 'var(--q-red)',
  propose_created: 'var(--q-cyan)',
  approve: 'var(--q-cyan)',
  capture_locked: 'var(--q-amber)',
  approval_expired: 'var(--q-amber)',
}[e] || 'rgba(255,255,255,0.6)')

const TASK_POLL_MS = 1500

function StatusChip({ label, value, color }) {
  return (
    <div className="glass-btn" style={{ cursor: 'default', gap: 8 }}>
      <span className="glass-dot" style={{ background: color, color }} />
      <span style={{ color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '.08em' }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}

function StepRow({ step }) {
  const badge = STEP_BADGE[step.status] || { label: step.status || 'pending', color: 'rgba(255,255,255,0.5)' }
  return (
    <div className="qx-row qx-row--apart" style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{step.label || step.tool}</span>
        {step.tool && <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>({step.tool})</span>}
        {step.verified === true && <span style={{ color: 'var(--q-green)', fontSize: 11 }}>✓ verified</span>}
        {step.verified === false && <span style={{ color: 'var(--q-red)', fontSize: 11 }}>✗ unverified</span>}
      </div>
      <span style={{ color: badge.color, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
        {badge.label}
      </span>
    </div>
  )
}

export default function QuoxBoxView() {
  const { live, loading, error, refresh, listWorkflows, runTask, getTask, approve, deny, setMode } = useQuoxBoxData()

  const [workflows, setWorkflows] = useState([])
  const [selectedWorkflow, setSelectedWorkflow] = useState('')
  const [paramValues, setParamValues] = useState({})
  const [runError, setRunError] = useState(null)
  const [runLoading, setRunLoading] = useState(false)
  const [activeTask, setActiveTask] = useState(null)
  const [modeLoading, setModeLoading] = useState(false)
  const taskTimerRef = useRef(null)

  // Load available workflows once
  useEffect(() => {
    listWorkflows().then(wfs => {
      setWorkflows(wfs)
      if (wfs.length > 0) setSelectedWorkflow(wfs[0].id)
    }).catch(() => setWorkflows([]))
  }, [listWorkflows])

  const currentWorkflow = workflows.find(w => w.id === selectedWorkflow) || null

  // Reset param values when workflow selection changes
  useEffect(() => {
    if (!currentWorkflow) return
    const defaults = {}
    for (const p of currentWorkflow.params || []) {
      defaults[p.name] = p.default ?? ''
    }
    setParamValues(defaults)
  }, [selectedWorkflow]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the active task while it's running or awaiting approval
  useEffect(() => {
    clearInterval(taskTimerRef.current)
    if (!activeTask || !['running', 'awaiting_approval'].includes(activeTask.status)) return
    taskTimerRef.current = setInterval(async () => {
      try {
        const t = await getTask(activeTask.id)
        if (t) setActiveTask(t)
      } catch (_) { /* transient poll failure — try again next tick */ }
    }, TASK_POLL_MS)
    return () => clearInterval(taskTimerRef.current)
  }, [activeTask?.id, activeTask?.status, getTask]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRunTask = useCallback(async () => {
    if (!currentWorkflow) return
    setRunLoading(true)
    setRunError(null)
    try {
      const task = await runTask(currentWorkflow.id, paramValues)
      setActiveTask(task)
    } catch (err) {
      setRunError(err.message)
    } finally {
      setRunLoading(false)
    }
  }, [currentWorkflow, paramValues, runTask])

  const handleModeChange = useCallback(async (mode) => {
    setModeLoading(true)
    try {
      await setMode(mode)
    } catch (err) {
      setRunError(err.message)
    } finally {
      setModeLoading(false)
    }
  }, [setMode])

  const handleDecide = useCallback(async (pendingId, verb) => {
    try {
      await (verb === 'approve' ? approve(pendingId) : deny(pendingId))
      if (activeTask) {
        const t = await getTask(activeTask.id)
        if (t) setActiveTask(t)
      }
    } catch (err) {
      setRunError(err.message)
    }
  }, [approve, deny, activeTask, getTask])

  if (error) {
    return (
      <div className="qx-view qx-pad">
        <div className="glass-card" style={{ borderColor: 'var(--q-red)' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>QuoxBox gateway unreachable</h2>
          <p style={{ color: 'rgba(255,255,255,0.6)' }}>{error}</p>
          <button className="glass-btn" onClick={refresh}>Retry</button>
        </div>
      </div>
    )
  }

  if (loading && !live) {
    return (
      <div className="qx-view qx-pad">
        <div style={{ color: 'rgba(255,255,255,0.6)' }}>Connecting to QuoxBox…</div>
      </div>
    )
  }

  const d = live || {}
  const pending = d.pending || []
  const events = d.events || []

  return (
    <div className="qx-view qx-pad qx-stack">
      <div>
        <h1 style={{ fontSize: 20, margin: 0 }}>QuoxBox — Mac mini</h1>
        <p style={{ color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
          Governed, verifiable control of the always-on Mac. Watch it work; approve high-risk actions.
        </p>
      </div>

      {/* ── Live status chips ── */}
      <div className="qx-row qx-row--wrap qx-row--tight">
        <StatusChip label="mode" value={d.mode || '—'} color={d.mode === 'actuate' ? 'var(--q-amber)' : d.mode === 'propose' ? 'var(--q-cyan)' : 'var(--q-green)'} />
        <StatusChip label="screen" value={d.screenLocked ? 'LOCKED' : 'unlocked'} color={d.screenLocked ? 'var(--q-amber)' : 'var(--q-green)'} />
        <StatusChip label="capture" value={d.captureAvailable ? 'ready' : 'blocked'} color={d.captureAvailable ? 'var(--q-green)' : 'var(--q-amber)'} />
        <StatusChip label="kill-switch" value={d.halt ? 'HALT' : 'clear'} color={d.halt ? 'var(--q-red)' : 'rgba(255,255,255,0.6)'} />
        <StatusChip label="breaker" value={d.breakerTripped ? 'tripped' : 'closed'} color={d.breakerTripped ? 'var(--q-red)' : 'var(--q-green)'} />
        <StatusChip label="pending" value={pending.length} color={pending.length ? 'var(--q-amber)' : 'rgba(255,255,255,0.6)'} />
        <StatusChip label="evidence" value={`${d.chain?.entries ?? 0} linked`} color={d.chain?.entries ? 'var(--q-cyan)' : 'rgba(255,255,255,0.6)'} />
      </div>

      <div className="qx-grid-2">
        {/* ── Run a task ── */}
        <div className="glass-card qx-stack qx-stack--compact">
          <h2 style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
            Run a task
          </h2>

          <select
            className="glass-input"
            value={selectedWorkflow}
            onChange={e => setSelectedWorkflow(e.target.value)}
          >
            {workflows.length === 0 && <option value="">No workflows available</option>}
            {workflows.map(wf => (
              <option key={wf.id} value={wf.id}>{wf.desc || wf.id}</option>
            ))}
          </select>

          {currentWorkflow && (currentWorkflow.params || []).map(p => (
            <input
              key={p.name}
              className="glass-input"
              placeholder={`${p.name}${p.required ? ' (required)' : ''}`}
              value={paramValues[p.name] ?? ''}
              onChange={e => setParamValues(prev => ({ ...prev, [p.name]: e.target.value }))}
            />
          ))}

          <button className="glass-btn" onClick={handleRunTask} disabled={runLoading || !currentWorkflow}>
            {runLoading ? 'Starting…' : 'Run'}
          </button>

          {runError && <div style={{ color: 'var(--q-red)', fontSize: 12 }}>{runError}</div>}

          {/* Mode selector */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12, marginTop: 4 }}>
            <div style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
              Mode
            </div>
            <div className="qx-row qx-row--tight qx-row--wrap">
              {MODES.map(m => (
                <button
                  key={m.value}
                  className={`glass-btn${d.mode === m.value ? ' glass-active' : ''}`}
                  disabled={modeLoading}
                  onClick={() => handleModeChange(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 6 }}>
              propose = every action is held for your approval.
            </div>
          </div>
        </div>

        {/* ── Live task panel ── */}
        <div className="glass-card qx-stack qx-stack--compact">
          <h2 style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
            Task
          </h2>
          {!activeTask ? (
            <div style={{ color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', fontSize: 13 }}>
              No task running. Launch one from the panel on the left.
            </div>
          ) : (
            <>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                {activeTask.workflow} <span style={{ color: 'rgba(255,255,255,0.5)' }}>{activeTask.desc}</span>
              </div>
              {typeof activeTask.total === 'number' && activeTask.total > 0 && (
                <div className="glass-bar">
                  <div style={{
                    width: `${Math.min(100, ((activeTask.cursor || 0) / activeTask.total) * 100)}%`,
                    background: 'linear-gradient(90deg, var(--q-cyan), var(--q-purple))',
                  }} />
                </div>
              )}
              <div>
                {(activeTask.steps || []).map((step, i) => (
                  <StepRow key={i} step={step} />
                ))}
              </div>
              {(activeTask.steps || []).some(s => s.status === 'awaiting_approval') && (
                <div className="qx-row qx-row--tight">
                  {(activeTask.steps || [])
                    .filter(s => s.status === 'awaiting_approval' && s.pendingId)
                    .map(s => (
                      <div key={s.pendingId} className="qx-row qx-row--tight">
                        <button className="glass-btn" onClick={() => handleDecide(s.pendingId, 'approve')}>Approve</button>
                        <button className="glass-btn" onClick={() => handleDecide(s.pendingId, 'deny')}>Deny</button>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── HITL pending approvals ── */}
      <div className="glass-card qx-stack qx-stack--compact">
        <h2 style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
          Pending approvals (HITL)
        </h2>
        {pending.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', fontSize: 13 }}>nothing awaiting approval</div>
        ) : (
          pending.map(p => (
            <div key={p.id} className="glass-card" style={{ borderColor: 'var(--q-amber)', padding: 12 }}>
              <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--q-amber)', fontWeight: 600 }}>
                {p.tool} <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>{p.id}</span>
              </div>
              <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 4 }}>impact: {p.impact}</div>
              <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>reasoning: {p.reasoning} · rollback: {p.rollback}</div>
              <div className="qx-row qx-row--tight" style={{ marginTop: 8 }}>
                <button className="glass-btn" onClick={() => handleDecide(p.id, 'approve')}>Approve</button>
                <button className="glass-btn" onClick={() => handleDecide(p.id, 'deny')}>Deny</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Live activity / evidence feed ── */}
      <div className="glass-card qx-stack qx-stack--compact">
        <h2 style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
          Live activity
        </h2>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, maxHeight: 420, overflowY: 'auto' }}>
          {events.map((e, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '58px 140px 1fr', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>{(e.ts || '').slice(11, 19)}</span>
              <span style={{ color: EVENT_COLOR(e.event), fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>
                {(e.event || '').replace(/_/g, ' ')}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.tool ? e.tool + ' — ' : ''}{e.reason || e.mode || e.id || ''}
                {e.verified === true && <span style={{ color: 'var(--q-green)' }}> ✓ verified</span>}
                {e.verified === false && <span style={{ color: 'var(--q-red)' }}> ✗ unverified</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
