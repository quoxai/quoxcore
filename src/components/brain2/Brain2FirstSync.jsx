/**
 * Brain2FirstSync - onboarding "first sync" witness step (BRAIN2-V2 V2-6).
 *
 * Polls the existing GET /api/feed/status (brain2FeedClient.getStatus, the same
 * last_sync/last_status/last_count fields Brain2Settings shows) every 5s while
 * any enabled source has no server-recorded result, and stops on unmount. No
 * run-now endpoint exists, so a failure is retried by the scheduler, not here.
 * Status is server truth; nothing is persisted client-side.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getStatus } from '../../services/brain2FeedClient'
import { deriveFirstSync } from './lib/firstSync'

export const FIRST_SYNC_POLL_MS = 5000

const STATE_PILL = {
  waiting: ['qx-pill--info', 'Waiting for first run'],
  synced: ['qx-pill--online', 'Synced'],
  failed: ['qx-pill--danger', 'Failed'],
  skipped: ['qx-pill--degraded', 'Skipped']
}

function when(at) {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

export default function Brain2FirstSync({ authFetch, sources, onAskFirst }) {
  const [payload, setPayload] = useState(null)
  const [pollError, setPollError] = useState(null)
  const alive = useRef(true)
  const view = useMemo(() => deriveFirstSync(sources, payload), [sources, payload])
  const done = view.allTerminal

  useEffect(() => {
    alive.current = true
    if (!authFetch || sources.length === 0) return undefined
    let timer = null
    const tick = async () => {
      try {
        const next = await getStatus({ authFetch })
        if (!alive.current) return
        setPayload(next)
        setPollError(null)
      } catch (err) {
        if (alive.current) setPollError(err?.message || 'Status check failed')
      }
    }
    tick()
    if (!done) timer = setInterval(tick, FIRST_SYNC_POLL_MS)
    return () => { alive.current = false; if (timer) clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authFetch, done, sources.length])

  if (sources.length === 0) return null
  const anyFailed = view.rows.some((r) => r.state === 'failed')
  return (
    <div className="qx-stack" data-testid="onboarding-first-sync">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>First sync</h3>
        {!done && <span className="qx-dot qx-dot--info" aria-hidden="true" />}
      </div>
      {pollError && <div className="qx-banner qx-banner--error" role="alert">Could not read sync status: {pollError}</div>}
      <ul className="qx-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {view.rows.map((r) => {
          const [cls, label] = STATE_PILL[r.state]
          return (
            <li key={r.sourceType} className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center', fontSize: 12 }} data-testid={`first-sync-${r.sourceType}`} data-state={r.state}>
              <strong>{r.name}</strong>
              <span className={`qx-pill qx-pill--sm ${cls}`}>{label}</span>
              {r.state === 'synced' && <span style={{ color: 'rgba(255,255,255,0.7)' }}>{r.count.toLocaleString()} item{r.count === 1 ? '' : 's'} ({when(r.at)})</span>}
              {(r.state === 'failed' || r.state === 'skipped') && <span style={{ color: 'rgba(255,255,255,0.7)' }}>{r.error}</span>}
            </li>
          )
        })}
      </ul>
      {anyFailed && (
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }} role="status">
          Will retry on the next scheduled run (every 30 min). Fix the source in Settings if the error persists.
        </span>
      )}
      {view.anySynced && onAskFirst && (
        <div>
          <button className="glass-btn" type="button" onClick={onAskFirst}>Ask about your synced data</button>
        </div>
      )}
    </div>
  )
}
