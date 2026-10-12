import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { listObjectives, approvePlan, rejectPlan, cancelObjective, startObjective } from '../../services/objectivesClient'

const POLL_MS = 30000

function timeAgo(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function PlansAwaitingApproval() {
  const { authFetch } = useAuth()
  const [items, setItems] = useState([])
  const [busyIds, setBusyIds] = useState(() => new Set())
  const [error, setError] = useState(null)
  const mounted = useRef(true)

  const fetchPlans = useCallback(async () => {
    if (!authFetch) return
    try {
      const res = await listObjectives(authFetch, { status: 'decomposed', limit: 20 })
      if (!mounted.current) return
      setItems(Array.isArray(res?.objectives) ? res.objectives : Array.isArray(res) ? res : [])
      setError(null)
    } catch (err) {
      if (!mounted.current) return
      setError(err?.message || 'Failed to load plans')
    }
  }, [authFetch])

  useEffect(() => {
    mounted.current = true
    fetchPlans()
    const id = setInterval(fetchPlans, POLL_MS)
    return () => { mounted.current = false; clearInterval(id) }
  }, [fetchPlans])

  const runAction = useCallback(async (objectiveId, label, fn) => {
    setBusyIds(prev => new Set(prev).add(objectiveId))
    setItems(prev => prev.filter(o => o.id !== objectiveId))
    try {
      await fn()
    } catch (err) {
      console.error(`[PlansAwaitingApproval] ${label} failed:`, err)
      setError(err?.message || `${label} failed`)
      fetchPlans()
    } finally {
      setBusyIds(prev => { const n = new Set(prev); n.delete(objectiveId); return n })
    }
  }, [fetchPlans])

  const handleApprove = useCallback((objectiveId) =>
    runAction(objectiveId, 'approve', async () => {
      // approvePlan already transitions decomposed -> running server-side
      // (via dispatchObjective). Do NOT also call startObjective here — the
      // /start endpoint requires status === 'pending' and will 400 on an
      // already-approved (running) objective, throwing a spurious error
      // toast on an approve that actually succeeded.
      await approvePlan(authFetch, objectiveId)
    }), [authFetch, runAction])

  const handleReject = useCallback((objectiveId) =>
    runAction(objectiveId, 'reject', async () => {
      await rejectPlan(authFetch, objectiveId)
      await startObjective(authFetch, objectiveId)
    }), [authFetch, runAction])

  const handleCancel = useCallback((objectiveId) =>
    runAction(objectiveId, 'cancel', async () => {
      await cancelObjective(authFetch, objectiveId)
    }), [authFetch, runAction])

  if (!items.length && !error) return null

  return (
    <div style={{
      padding: '8px 20px',
      borderBottom: '1px solid rgba(168,85,247,0.18)',
      background: 'rgba(168,85,247,0.06)',
      flexShrink: 0,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: items.length ? 6 : 0 }}>
        <span style={{ color: '#c084fc', fontWeight: 600, fontSize: 11, letterSpacing: 0.4 }}>
          {items.length} plan{items.length !== 1 ? 's' : ''} awaiting approval
        </span>
        {error && (
          <span style={{ color: '#f87171', fontSize: 10 }}>{error}</span>
        )}
      </div>
      {items.map(obj => {
        const busy = busyIds.has(obj.id)
        const taskCount = obj.task_count ?? obj.tasks?.length ?? 0
        return (
          <div key={obj.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '4px 0',
            color: 'rgba(255,255,255,0.78)',
          }}>
            <Link
              to={`/mission-control?tab=objectives&objective=${obj.id}`}
              style={{
                color: 'rgba(255,255,255,0.85)',
                textDecoration: 'none',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
              title={obj.title || obj.id}
            >
              {obj.title || obj.id}
            </Link>
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, whiteSpace: 'nowrap' }}>
              {taskCount} task{taskCount !== 1 ? 's' : ''}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, whiteSpace: 'nowrap' }}>
              {timeAgo(obj.decomposed_at || obj.updated_at || obj.created_at)}
            </span>
            <button
              type="button"
              onClick={() => handleCancel(obj.id)}
              disabled={busy}
              title="Cancel this objective entirely"
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid rgba(239,68,68,0.4)',
                background: 'transparent',
                color: '#fca5a5',
                fontSize: 11,
                fontWeight: 500,
                cursor: busy ? 'wait' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleReject(obj.id)}
              disabled={busy}
              title="Reject this plan and trigger re-decomposition"
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid rgba(251,191,36,0.4)',
                background: 'transparent',
                color: '#fbbf24',
                fontSize: 11,
                fontWeight: 500,
                cursor: busy ? 'wait' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Re-plan
            </button>
            <button
              type="button"
              onClick={() => handleApprove(obj.id)}
              disabled={busy}
              title="Approve this plan and start execution"
              style={{
                padding: '4px 12px',
                borderRadius: 4,
                border: '1px solid rgba(168,85,247,0.5)',
                background: busy ? 'rgba(168,85,247,0.1)' : 'rgba(168,85,247,0.18)',
                color: '#e9d5ff',
                fontSize: 11,
                fontWeight: 600,
                cursor: busy ? 'wait' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {busy ? 'Working…' : 'Approve plan'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
