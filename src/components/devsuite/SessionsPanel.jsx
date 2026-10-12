/**
 * SessionsPanel: DEVSUITE phase 20, the read-only face of the sessions
 * register (phase 19, GET /api/v1/live-sessions). Answers the owner's
 * question "who is running, where, and how do I reach them", the same data
 * the Sesha switchboard reads.
 *
 * Read-only by design for now: actions (open the slot, read the pane, ring
 * the owner) come later and go through HITL where risky.
 *
 * Composition only: qx classes per the glass design system, zero bespoke CSS
 * (DoneEnginePanel is the sibling pattern).
 */

import { useState, useEffect, useCallback, useRef } from 'react'

function relativeAge(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return 'unknown'
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

// `quox claude --resume NAME` runs NAME in tmux session quox-NAME.
const displayName = (name) => String(name || '').replace(/^quox-/, '')

const SessionsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M7 9l3 2-3 2M12 13h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 20h8" strokeLinecap="round" />
  </svg>
)

export default function SessionsPanel() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const connectionIdRef = useRef(0)

  const fetchRows = useCallback(async () => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch('/collector/api/v1/live-sessions')
      const body = await res.json().catch(() => null)
      if (connectionIdRef.current !== currentId) return
      if (!res.ok) {
        setError({ status: res.status, message: body?.error || `HTTP ${res.status}` })
        setRows(null)
      } else {
        setRows(Array.isArray(body?.sessions) ? body.sessions : [])
        setError(null)
      }
    } catch (err) {
      if (connectionIdRef.current === currentId) setError({ status: 0, message: err.message })
    } finally {
      if (connectionIdRef.current === currentId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    connectionIdRef.current++
    fetchRows()
    const interval = setInterval(fetchRows, 30000) // hosts report every ~2 min
    return () => {
      connectionIdRef.current++
      clearInterval(interval)
    }
  }, [fetchRows])

  const live = (rows || []).filter((r) => r.live)
  const stale = (rows || []).filter((r) => !r.live)
  const unprotected = live.filter((r) => !r.tmux).length

  return (
    <div className="qx-card" data-testid="sessions-panel">
      <div className="qx-row qx-row--apart" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          {SessionsIcon}
          <h3 style={{ margin: 0 }}>Sessions</h3>
        </div>
        {rows && (
          <span className="qx-hint" data-testid="sessions-count">
            {live.length} running{stale.length ? ` · ${stale.length} not seen recently` : ''}
          </span>
        )}
      </div>

      <div className="qx-tip" style={{ marginBottom: 12 }} data-testid="sessions-explainer">
        <b>Who is working, and where.</b> Every AI coding session on your dev machines, with the
        slot you can reach it through and the agent attached to it. Sessions marked
        {' '}<b>protected</b> run in the background and survive a closed terminal; Sesha uses this
        same list to put calls and messages through to the right session.
      </div>

      {loading && (
        <div className="qx-skeleton qx-skeleton--line-md" style={{ width: '60%' }} data-testid="sessions-loading" />
      )}

      {!loading && error && (
        <div className="qx-empty" data-testid="sessions-error">
          <div className="qx-empty__title">Sessions unavailable</div>
          <div className="qx-empty__body">{error.message}</div>
        </div>
      )}

      {!loading && rows && rows.length === 0 && (
        <div className="qx-empty" data-testid="sessions-empty">
          <div className="qx-empty__title">No sessions reported yet</div>
          <div className="qx-empty__body">
            On a dev machine, run <code className="qx-code">quox sessions report</code> to list its
            sessions here. Run it on a timer (every couple of minutes) to keep the list current.
          </div>
        </div>
      )}

      {!loading && rows && rows.length > 0 && (
        <>
          {unprotected > 0 && (
            <div className="qx-banner qx-banner--warn" style={{ marginBottom: 12 }} data-testid="sessions-unprotected">
              {unprotected} running session{unprotected === 1 ? ' is' : 's are'} not protected: closing the
              terminal ends {unprotected === 1 ? 'it' : 'them'}. Restart with
              {' '}<code className="qx-code">quox claude --resume NAME</code>.
            </div>
          )}
          <table className="qx-table" data-testid="sessions-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Machine</th>
                <th>Program</th>
                <th>Reach via slot</th>
                <th>Agent</th>
                <th>Last seen</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...live, ...stale].map((r) => (
                <tr key={`${r.host}/${r.name}`}>
                  <td><code className="qx-code">{displayName(r.name)}</code></td>
                  <td>{r.host}</td>
                  <td>{r.program || '-'}</td>
                  <td>{r.slot ? <code className="qx-code">{r.slot}</code> : <span className="qx-hint">none</span>}</td>
                  <td>{r.agent ? `${r.agent}${r.splinter ? ` (${r.splinter})` : ''}` : <span className="qx-hint">none</span>}</td>
                  <td className="qx-hint">{relativeAge(r.last_seen_at)}</td>
                  <td>
                    {!r.live
                      ? <span className="qx-pill qx-pill--sm qx-pill--ghost">not seen</span>
                      : r.tmux
                        ? <span className="qx-pill qx-pill--sm qx-pill--online">protected</span>
                        : <span className="qx-pill qx-pill--sm qx-pill--warn">unprotected</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
