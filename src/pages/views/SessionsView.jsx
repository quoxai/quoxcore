/**
 * SessionsView: /sessions (QUOXON J3). Owner: "a dashboard that knows the
 * index of all active sessions... I want to SEE it all on overview."
 *
 * Polls GET /collector/api/v1/sessions every 5 s (server-side data only; no
 * browser storage). A failed poll keeps the last good index on screen behind a
 * stale banner with the status, never an empty list. A 1 s clock keeps the
 * relative ages ticking between polls.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import SessionsOverview from '../../components/sessions/SessionsOverview'
import { getAssistant } from '../../config/assistants'

const POLL_MS = 5000
const agentColorOf = (id) => {
  const a = getAssistant(id)
  return (a && a.color) || null
}

export function useSessionsIndex(pollMs = POLL_MS) {
  const [index, setIndex] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastOkAt, setLastOkAt] = useState(null)
  const gen = useRef(0)

  const load = useCallback(async () => {
    const mine = gen.current
    try {
      const res = await fetch('/collector/api/v1/sessions', { credentials: 'include' })
      const body = await res.json().catch(() => null)
      if (gen.current !== mine) return
      if (!res.ok) {
        setError({ status: res.status, message: (body && body.error) || `HTTP ${res.status}` })
      } else if (!body || typeof body !== 'object' || !body.counts) {
        setError({ status: res.status, message: 'unexpected response shape' })
      } else {
        setIndex(body)
        setError(null)
        setLastOkAt(Date.now())
      }
    } catch (e) {
      if (gen.current === mine) setError({ status: 0, message: e.message || 'request failed' })
    } finally {
      if (gen.current === mine) setLoading(false)
    }
  }, [])

  useEffect(() => {
    gen.current++
    load()
    const t = setInterval(load, pollMs)
    return () => { gen.current++; clearInterval(t) }
  }, [load, pollMs])

  return { index, error, loading, lastOkAt }
}

export default function SessionsView() {
  const { index, error, loading, lastOkAt } = useSessionsIndex()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="qx-view">
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} data-testid="sessions-scroll">
        <div className="qx-stack">
        <header className="qx-card qx-row qx-row--apart" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>Sessions</h2>
            <div className="qx-hint">Everything live in this org: Claude and Codex sessions, conversations, slots and running work, by agent.</div>
          </div>
          {index && <span className="qx-pill qx-pill--sm qx-pill--online" data-testid="sessions-live-pill">{index.counts?.total || 0} live</span>}
        </header>
        <SessionsOverview index={index} error={error} loading={loading} now={now} lastOkAt={lastOkAt} agentColorOf={agentColorOf} />
        </div>
      </div>
    </div>
  )
}
