/**
 * DevSessionsPanel — capability panel for dev.sessions (DEVSUITE-HUB replan
 * phase 8: the per-server loop-sessions window + the dashboard HALT button).
 *
 * Data: GET /collector/api/v1/dev-sessions?host_id= (org-scoped listing, see
 * services/collector/lib/devLoopSessionsStore.listLoopSessions), joined
 * client-side to loop objectives from the tasks service on
 * objectives.loop_session_id, so a running loop gets a HALT button wired to
 * the proven POST /api/objectives/:id/halt (signed kill, witnessed reason).
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../contexts/AuthContext'
import { listObjectives, haltObjective } from '../../../services/objectivesClient'
// QUOXIFY pass 4 (DEVSUITE phase 17): the witnessed-turn evidence UI. Built
// 2026-08-10, imported by nothing until now, so the "every turn is
// WARD-witnessed" claim rendered nowhere in the product.
import LoopReplay from '../../objectives/LoopReplay'
import GovernedConfirmDialog from '../GovernedConfirmDialog'

const STATUS_PILL = {
  spawned: 'qx-pill--degraded',
  streaming: 'qx-pill--online',
  done: 'qx-pill--ghost',
  error: 'qx-pill--warn',
}

function ReplayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" strokeLinecap="round" />
      <path d="M3 4v5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}

export default function DevSessionsPanel({ server }) {
  const { authFetch } = useAuth()
  const hostId = server?.host_id
  const [sessions, setSessions] = useState(null)
  const [objectivesBySession, setObjectivesBySession] = useState({})
  const [error, setError] = useState(null)
  const [halting, setHalting] = useState(null)
  const [haltError, setHaltError] = useState(null)
  // One replay open at a time: the envelope chain for a long loop is not
  // cheap to fetch or to render, and comparing two at once is not a real use.
  const [replaySession, setReplaySession] = useState(null)
  const [replayEnvelopes, setReplayEnvelopes] = useState([])
  const [replayLoading, setReplayLoading] = useState(false)
  const [replayError, setReplayError] = useState(null)

  const load = useCallback(async () => {
    if (!hostId) return
    try {
      setError(null)
      // Bundle audit 2026-08-17: this was a bare `fetch` while authFetch sat
      // unused two lines below, so the read 401'd and blanked the whole panel
      // for anyone whose session cookie was not doing the work by accident.
      const res = await authFetch(`/collector/api/v1/dev-sessions?host_id=${encodeURIComponent(hostId)}&limit=20`)
      if (!res.ok) throw new Error(`session list failed (${res.status})`)
      const data = await res.json()
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    } catch (e) {
      setError(e.message)
      return
    }
    // Loop objectives are the halt handles; a failure here degrades the join
    // (sessions still render), it never blanks the panel.
    try {
      const data = await listObjectives(authFetch, { limit: 100 })
      const map = {}
      for (const o of (data?.objectives || [])) {
        if (o.execution_mode === 'loop' && o.loop_session_id) map[o.loop_session_id] = o
      }
      setObjectivesBySession(map)
    } catch {
      setObjectivesBySession({})
    }
  }, [hostId, authFetch])

  useEffect(() => { load() }, [load])

  // BUNDLE POLISH D: halting a running loop is the single most consequential
  // button in the suite — it sends a SIGNED kill to a real host and fails the
  // objective. It was asking through window.confirm, browser chrome, in a
  // product whose pitch is that governed actions are deliberate and witnessed.
  // Same question, in the product's own voice, restating what gets recorded.
  const [haltTarget, setHaltTarget] = useState(null)

  const onHalt = useCallback((objective) => {
    setHaltError(null)
    setHaltTarget(objective)
  }, [])

  const confirmHalt = useCallback(async () => {
    const objective = haltTarget
    if (!objective) return
    setHaltTarget(null)
    setHalting(objective.id)
    try {
      await haltObjective(authFetch, objective.id)
    } catch (e) {
      setHaltError(e.message)
    } finally {
      setHalting(null)
      load()
    }
  }, [haltTarget, authFetch, load])

  // QUOXIFY pass 4: fetch the session's real AEE envelope chain and hand it
  // to LoopReplay. `corr` is the causality key of the AEE protocol and the
  // loop's envelopes are all emitted under corr = session.id (see the
  // collector's dev-session routes), so one query IS the loop's evidence.
  // Nothing is synthesised here: if the chain is empty, the UI says so.
  const toggleReplay = useCallback(async (sessionId) => {
    if (replaySession === sessionId) {
      setReplaySession(null)
      return
    }
    setReplaySession(sessionId)
    setReplayEnvelopes([])
    setReplayError(null)
    setReplayLoading(true)
    try {
      const res = await authFetch(`/collector/aee/query?corr=${encodeURIComponent(sessionId)}&limit=500`)
      if (!res.ok) throw new Error(`evidence query failed (${res.status})`)
      const data = await res.json()
      const envelopes = Array.isArray(data?.envelopes) ? data.envelopes
        : Array.isArray(data?.results) ? data.results
        : Array.isArray(data) ? data : []
      // LoopReplay's contract is "ordered by ts". Sort rather than trust the
      // query order, because a replay that scrubs backwards through time is
      // worse than no replay.
      envelopes.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
      setReplayEnvelopes(envelopes)
    } catch (e) {
      setReplayError(e.message)
    } finally {
      setReplayLoading(false)
    }
  }, [authFetch, replaySession])

  if (error) {
    return <div className="capability-panel-row" data-testid="dev-sessions-error">Loop sessions unavailable: {error}</div>
  }
  if (sessions === null) {
    return <div className="capability-panel-row" data-testid="dev-sessions-loading">Loading loop sessions…</div>
  }
  if (sessions.length === 0) {
    return <div className="capability-panel-row" data-testid="dev-sessions-empty">Nothing has run on this host yet. To start a coding loop, <a href="/objectives">create an objective</a>.</div>
  }

  return (
    <div className="capability-panel-dev-sessions" data-testid="capability-panel-dev-sessions">
      {haltTarget && (
        <GovernedConfirmDialog
          testIdPrefix="dev-sessions-halt-confirm"
          title={`Halt "${haltTarget.title}"?`}
          danger
          confirmLabel="Halt the loop"
          busy={halting === haltTarget.id}
          onCancel={() => setHaltTarget(null)}
          onConfirm={confirmHalt}
          body={(
            <>
              <p style={{ margin: 0 }}>
                A signed kill goes to the host and ends the loop where it stands.
                The objective is marked failed, not paused.
              </p>
              <p style={{ margin: 0, opacity: 0.75 }}>
                The halt is witnessed: who asked, when, and against which loop
                session is recorded on the evidence chain and cannot be edited
                afterwards.
              </p>
            </>
          )}
        />
      )}
      {haltError && <div className="capability-panel-row qx-hint qx-hint--warn" data-testid="dev-sessions-halt-error">Halt failed: {haltError}</div>}
      {sessions.map((s) => {
        const obj = objectivesBySession[s.id]
        const canHalt = obj && obj.status === 'running'
        const replayOpen = replaySession === s.id
        return (
          <div key={s.id}>
            <div className="capability-panel-row" data-testid={`dev-sessions-row-${s.id}`}>
              <code className="qx-code">{s.id.slice(0, 12)}</code>
              <span className="qx-pill qx-pill--sm">{s.backend}</span>
              <span className={`qx-pill qx-pill--sm ${STATUS_PILL[s.status] || 'qx-pill--ghost'}`}>{s.status}</span>
              <span className="qx-hint qx-hint--sm">turns: {s.latest_seq}</span>
              {/*
                BUNDLE POLISH B, the budget half of "live turn + budget feed".
                A loop runs under a real token and iteration ceiling, and the
                panel showed the turn count while saying nothing about how close
                the run was to the limit that will stop it. The numbers were
                already on the objective (the list route is SELECT *), so this
                was surfacing, not plumbing.

                Rendered only when a ceiling actually exists: an objective with
                no cap must not get a fabricated one, and "0 of 0" reads as a
                measurement rather than an absence.
              */}
              {/*
                ZERO RECORDED IS NOT ZERO USED, and the difference matters here.
                Caught by looking at the first capture after this shipped: every
                row read "tokens: 0%", including completed runs with 30 to 126
                turns. A loop that took 126 turns did not use 0% of its token
                budget; its usage was never recorded. 25 of 42 loop objectives
                carry a real figure, so the plumbing works and the rest are a
                data gap.

                Printing 0% there would assert a measurement we do not have,
                which is exactly the failure the VOLT badge had. So an unrecorded
                run says so, and only a real figure is shown as a percentage.
              */}
              {obj && obj.max_tokens > 0 && (
                obj.tokens_used > 0 ? (
                  <span
                    className={`qx-hint qx-hint--sm${obj.tokens_used / obj.max_tokens >= 0.8 ? ' qx-hint--warn' : ''}`}
                    data-testid={`dev-sessions-budget-${s.id}`}
                    title={`${obj.tokens_used.toLocaleString()} of ${obj.max_tokens.toLocaleString()} tokens used`}
                  >
                    {/* A real usage that rounds to zero must not render as "0%".
                        2026-08-19: runs with 104, 159 and 377 tokens against
                        caps of 150k-400k all displayed "tokens: 0%", which
                        reads as nothing-used and is the SAME lie the
                        not-recorded branch below was added to kill, just
                        arriving by rounding instead of by a null. Show "<1%"
                        so small-but-real is visibly distinct from both zero
                        and unrecorded; the title carries the exact numbers. */}
                    tokens: {(() => {
                      const pct = (obj.tokens_used / obj.max_tokens) * 100
                      return pct > 0 && pct < 1 ? '<1' : Math.round(pct)
                    })()}%
                  </span>
                ) : (
                  <span
                    className="qx-hint qx-hint--sm"
                    data-testid={`dev-sessions-budget-${s.id}`}
                    title={`Cap is ${obj.max_tokens.toLocaleString()} tokens; usage was never recorded for this run.`}
                    style={{ opacity: 0.6 }}
                  >
                    tokens: not recorded
                  </span>
                )
              )}
              {obj && obj.max_iterations > 0 && (
                <span className="qx-hint qx-hint--sm" data-testid={`dev-sessions-iterations-${s.id}`}>
                  cap: {obj.max_iterations} iterations
                </span>
              )}
              {obj && <span style={{ fontSize: '0.8rem' }}>{obj.title}</span>}
              {/* QUOXIFY pass 4 (DEVSUITE phase 17). The whole QLoop pitch is
                  "every turn is WARD-witnessed", and the UI that renders that
                  evidence (LoopReplay + ObjectiveStateVector + KnotBadge) was
                  built, tested, and imported by NOTHING. The moat was dead
                  code. This is the button that mounts it. */}
              <button
                type="button"
                className="qx-btn qx-btn--ghost qx-btn--sm"
                data-testid={`dev-sessions-replay-${s.id}`}
                aria-expanded={replayOpen}
                onClick={() => toggleReplay(s.id)}
              >
                <ReplayIcon /> {replayOpen ? 'Hide evidence' : 'Replay evidence'}
              </button>
              {canHalt && (
                <button
                  type="button"
                  className="qx-btn qx-btn--sm qx-btn--danger"
                  data-testid={`dev-sessions-halt-${obj.id}`}
                  disabled={halting === obj.id}
                  onClick={() => onHalt(obj)}
                >
                  <StopIcon /> {halting === obj.id ? 'Halting…' : 'Halt'}
                </button>
              )}
            </div>
            {replayOpen && (
              <div style={{ padding: '4px 0 12px' }} data-testid={`dev-sessions-replay-panel-${s.id}`}>
                {replayError && (
                  <div className="qx-hint qx-hint--danger" data-testid="dev-sessions-replay-error">
                    Evidence unavailable: {replayError}
                  </div>
                )}
                {!replayError && replayLoading && (
                  <div className="qx-hint" data-testid="dev-sessions-replay-loading">Loading witnessed turns…</div>
                )}
                {/* An empty chain is a REAL answer and must read as one. The
                    house rule is that a green check which lies is worse than
                    a red one, and "no envelopes" quietly rendering an empty
                    player would imply a clean loop rather than no evidence. */}
                {!replayError && !replayLoading && replayEnvelopes.length === 0 && (
                  <div className="qx-hint" data-testid="dev-sessions-replay-empty">
                    No witnessed envelopes recorded for this session yet. That means nothing has
                    been evidenced, not that the loop ran cleanly.
                  </div>
                )}
                {!replayError && !replayLoading && replayEnvelopes.length > 0 && (
                  <LoopReplay
                    envelopes={replayEnvelopes}
                    title={obj ? `Replay: ${obj.title}` : 'Loop replay'}
                    flat
                  />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
