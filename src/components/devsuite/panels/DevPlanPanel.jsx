/**
 * DevPlanPanel — the roadmap work assigned to one governed dev server.
 *
 * DEVSUITE phase 6: "dev.plan window opens the org roadmap".
 *
 * The suite's whole premise is that a dev server executes work the roadmap
 * planned, and until phase 6 the two halves could not be joined: nothing
 * recorded which host a stream belonged to. Streams now carry an optional
 * `dev_server` tag, and GET /roadmaps/:id/streams?dev_server=<host_id> narrows
 * to one host, so this panel answers a question the product could not answer
 * before: what is THIS machine supposed to be working on?
 *
 * Reads through the collector's governed quoxplan proxy, never :3107 directly.
 * That proxy resolves the org, gates on the instance's owning organisation and
 * forwards X-Quoxplan-Org; a client talking to the service port would be both
 * ungoverned and unreachable from a browser.
 *
 * HONEST EMPTY STATE. An untagged host is the norm, not a fault: most streams
 * are not host-specific and a fresh install has tagged none. The panel says so
 * and names the command that changes it, rather than rendering a blank box
 * that reads like a failure.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../contexts/AuthContext'

const STATUS_PILL = {
  IN_PROGRESS: 'qx-pill--online',
  COMPLETE: 'qx-pill--ghost',
  BLOCKED: 'qx-pill--warn',
  DECISION_NEEDED: 'qx-pill--warn',
  NOT_STARTED: 'qx-pill--ghost',
}

// The live roadmap. Per-org roadmap selection is the other half of phase 6 and
// is not wired yet, so this names the one roadmap the instance serves rather
// than pretending to choose.
const ROADMAP_ID = 'quox-strategic'

function phaseProgress(stream) {
  const phases = Array.isArray(stream.phases) ? stream.phases : []
  if (phases.length === 0) return null
  const done = phases.filter((p) => p.status === 'DONE').length
  return { done, total: phases.length }
}

export default function DevPlanPanel({ server }) {
  const { authFetch } = useAuth()
  const hostId = server?.host_id
  const [streams, setStreams] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!hostId) return
    try {
      setError(null)
      const res = await authFetch(
        `/collector/api/v1/quoxplan/roadmaps/${encodeURIComponent(ROADMAP_ID)}/streams`
        + `?lens=all&dev_server=${encodeURIComponent(hostId)}`
      )
      if (!res.ok) throw new Error(`roadmap read failed (${res.status})`)
      const data = await res.json()
      setStreams(Array.isArray(data.streams) ? data.streams : [])
    } catch (e) {
      setError(e.message)
    }
  }, [hostId, authFetch])

  useEffect(() => { load() }, [load])

  if (error) {
    return <div className="capability-panel-row qx-hint qx-hint--warn" data-testid="dev-plan-error">Roadmap unavailable: {error}</div>
  }
  // null is "not loaded yet", never "empty": an empty state painted before the
  // first response is the load-flash defect this bundle has had twice.
  if (streams === null) {
    return <div className="capability-panel-row" data-testid="dev-plan-loading">Loading this server&rsquo;s roadmap work…</div>
  }
  if (streams.length === 0) {
    return (
      <div className="capability-panel-row qx-hint" data-testid="dev-plan-empty">
        No roadmap streams are assigned to this server yet. Tag one with{' '}
        <code className="qx-code">quox plan update &lt;stream&gt; dev_server {hostId}</code>.
      </div>
    )
  }

  return (
    <div className="capability-panel-dev-plan" data-testid="capability-panel-dev-plan">
      {streams.map((s) => {
        const progress = phaseProgress(s)
        // A substream tagged to this host keeps its parent in the result even
        // when the parent itself is untagged, so say which ones are actually
        // this server's rather than implying the whole parent is.
        const ownSubs = (s.substreams || []).filter((c) => c.dev_server === hostId)
        return (
          <div key={s.id} data-testid={`dev-plan-stream-${s.id}`}>
            <div className="capability-panel-row">
              <code className="qx-code">{s.id}</code>
              <span className={`qx-pill qx-pill--sm ${STATUS_PILL[s.status] || 'qx-pill--ghost'}`}>{s.status}</span>
              {progress && (
                <span className="qx-hint qx-hint--sm">{progress.done} of {progress.total} phases</span>
              )}
              {s.dev_server !== hostId && (
                <span className="qx-hint qx-hint--sm" title="This parent is not itself assigned here; a substream below it is.">
                  parent
                </span>
              )}
              <span style={{ fontSize: '0.8rem' }}>{s.name}</span>
            </div>
            {ownSubs.map((c) => (
              <div className="capability-panel-row" key={c.id} data-testid={`dev-plan-substream-${c.id}`} style={{ paddingLeft: 18 }}>
                <code className="qx-code">{c.id}</code>
                <span className={`qx-pill qx-pill--sm ${STATUS_PILL[c.status] || 'qx-pill--ghost'}`}>{c.status}</span>
                <span className="qx-hint qx-hint--sm">{c.name}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
