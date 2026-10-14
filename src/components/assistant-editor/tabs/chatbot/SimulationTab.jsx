/**
 * SimulationTab (CW-10.4)
 *
 * Widget Room tab for running simulation scenarios against the live widget
 * chat endpoint. Features:
 *   - Seed the security scenario library on first visit.
 *   - List scenarios grouped by category; enable/disable, edit (admin) or
 *     delete (non-seeded) from the row menu.
 *   - "Run all" / "Run category" / "Run single" trigger /quoxchat/simulate.
 *   - Publish gate banner summarising the latest run + security score.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { planGateMessage } from './planGateMessage'

const CATEGORIES = [
  { id: 'security', label: 'Security', color: '#ef4444' },
  { id: 'faq', label: 'FAQ', color: '#30ff90' },
  { id: 'tool_use', label: 'Tools', color: '#a855f7' },
  { id: 'off_topic', label: 'Off-topic', color: '#f59e0b' },
  { id: 'edge_case', label: 'Edge cases', color: '#38bdf8' },
  { id: 'general', label: 'General', color: 'rgba(255,255,255,0.7)' },
]

function ScoreBadge({ score, passed }) {
  if (score == null) return <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>Not run</span>
  const band = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail'
  const colors = { pass: '#30ff90', warn: '#f59e0b', fail: '#ef4444' }
  return (
    <span style={{ padding: '2px 6px', borderRadius: 4, background: `${colors[band]}15`, color: colors[band], fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700 }}>
      Score {Math.round(score)}
    </span>
  )
}

// Small spinner + label shown on a scenario row while it is queued or
// currently running, in place of the score badge / empty dashes.
function PendingBadge() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: 'rgba(168,85,247,0.85)' }}>
      <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
        <circle cx="12" cy="12" r="9" stroke="rgba(168,85,247,0.25)" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="#a855f7" strokeWidth="3" strokeLinecap="round" />
      </svg>
      Running
    </span>
  )
}

// Humanise an ISO timestamp into a wall-clock string for the summary strip
// ("Ran at 11:42 pm").
function formatRanAt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
}

// Humanise a snake_case/kebab-case scenario id into sentence-case words for
// display; the raw id stays visible as a small code chip alongside it.
function humaniseId(id) {
  const s = String(id || '').replace(/[_-]+/g, ' ').trim()
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function SeverityBadge({ severity }) {
  const colors = { high: '#ef4444', medium: '#f59e0b', low: 'rgba(255,255,255,0.45)' }
  return <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: colors[severity] || colors.low }}>{severity}</span>
}

function PublishGateBanner({ readiness }) {
  if (!readiness) return null
  const colours = readiness.gate === 'unblocked'
    ? { bg: 'rgba(48,255,144,0.08)', fg: '#30ff90', border: 'rgba(48,255,144,0.3)' }
    : { bg: 'rgba(239,68,68,0.08)', fg: '#ef4444', border: 'rgba(239,68,68,0.3)' }
  const reasonText = ({
    dev_domains_only: 'Dev-only domains. Gate bypassed.',
    no_simulation_run: 'Run the simulation before publishing to a production domain.',
    no_security_scenarios: 'Seed security scenarios, then run before publishing.',
    security_library_incomplete: `Every security scenario must run before going live (${readiness.security_library?.run ?? '?'} of ${readiness.security_library?.total ?? '?'} have run). Go live in the header runs them all.`,
    score_ok: `Security score ${readiness.security_library?.score ?? readiness.latest_run?.security_score ?? '?'}/${readiness.security_score_min}, ready to publish.`,
    security_score_too_low: `Security score ${readiness.security_library?.score ?? readiness.latest_run?.security_score ?? '?'}/${readiness.security_score_min}, below threshold.`,
  })[readiness.reason] || readiness.reason
  return (
    <div style={{ padding: '10px 12px', border: `1px solid ${colours.border}`, borderRadius: 8, background: colours.bg, color: colours.fg, fontSize: 11, fontWeight: 600, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>{readiness.gate === 'unblocked' ? '✓' : '⚠'} Publish gate: {readiness.gate}. {reasonText}</span>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>Current status: {readiness.status || 'draft'}</span>
    </div>
  )
}

export default function SimulationTab({ widget, authFetch, orgId }) {
  const widgetId = widget?.id
  const [scenarios, setScenarios] = useState([])
  const [readiness, setReadiness] = useState(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [lastRun, setLastRun] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set(['security']))
  // Ids of scenarios queued or currently running in the active batch, used
  // to show a per-row spinner instead of empty dashes while results stream in.
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const lastRunInitRef = useRef(false)

  const flash = (setter, text) => { setter(text); setTimeout(() => setter(null), 3500) }

  const load = useCallback(async () => {
    if (!authFetch || !orgId || !widgetId) return
    setLoading(true)
    setError(null)
    try {
      const [sc, rd] = await Promise.all([
        authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/scenarios?limit=200`),
        authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/publish-readiness`),
      ])
      if (sc.ok) {
        const data = await sc.json().catch(() => ({}))
        setScenarios(Array.isArray(data?.items) ? data.items : [])
      }
      if (rd.ok) setReadiness(await rd.json().catch(() => null))
      // On first successful load only: derive the persistent last-run summary
      // strip from the most recent stored run, so it survives a tab revisit
      // (the tab remounts on tab switch, so component state alone would not).
      if (!lastRunInitRef.current) {
        lastRunInitRef.current = true
        try {
          const runsResp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/simulation-runs?limit=1`)
          if (runsResp.ok) {
            const runsData = await runsResp.json().catch(() => ({}))
            const latest = Array.isArray(runsData?.items) ? runsData.items[0] : null
            if (latest) {
              setLastRun({
                total: latest.total, passed: latest.passed, warned: latest.warned, failed: latest.failed,
                security_score: latest.security_score, duration_ms: latest.duration_ms,
                ranAt: latest.finished_at || latest.started_at,
              })
            }
          }
        } catch { /* best effort; strip just stays hidden until the next run */ }
      }
    } catch (err) {
      flash(setError, err.message || 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [authFetch, orgId, widgetId])

  useEffect(() => { load() }, [load])

  const grouped = useMemo(() => {
    const g = {}
    for (const c of CATEGORIES) g[c.id] = []
    for (const s of scenarios) (g[s.category] = g[s.category] || []).push(s)
    return g
  }, [scenarios])

  const toggleCategory = (cat) => {
    setExpanded(prev => { const next = new Set(prev); if (next.has(cat)) next.delete(cat); else next.add(cat); return next })
  }

  const seed = async () => {
    setRunning(true)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/scenarios/seed`, { method: 'POST' })
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}))
        flash(setInfo, `Seeded: ${data.created} new, ${data.updated} refreshed`)
        load()
      } else {
        flash(setError, `Seed failed (${resp.status})`)
      }
    } catch (err) { flash(setError, err.message) } finally { setRunning(false) }
  }

  const applyRunResult = (data) => {
    setLastRun({
      total: data?.total, passed: data?.passed, warned: data?.warned, failed: data?.failed,
      security_score: data?.security_score, duration_ms: data?.duration_ms,
      ranAt: new Date().toISOString(),
    })
    // Patch every row in the batch at once from the response's
    // per-scenario results, rather than waiting on load() to refetch.
    if (Array.isArray(data?.results)) {
      const byId = new Map(data.results.map(r => [r.scenario_id, r]))
      setScenarios(prev => prev.map(row => {
        const r = byId.get(row.id)
        if (!r) return row
        return {
          ...row, last_score: r.score, last_passed: r.passed, last_run_at: new Date().toISOString(),
          last_notes: Array.isArray(r.notes) ? r.notes.join(' | ') : row.last_notes,
          last_response: (typeof r.response === 'string' ? r.response : r.response?.text) ?? row.last_response,
        }
      }))
    }
    flash(setInfo, `Ran ${data?.total || 0} scenario${data?.total === 1 ? '' : 's'} · ${data?.passed || 0} passed · score ${data?.security_score ?? 'n/a'}`)
  }

  // Polls the async simulate job until it finishes. Returns the result
  // body, or null after surfacing an error.
  const pollSimulationJob = async (jobId) => {
    const POLL_MS = 2000
    const MAX_POLLS = 750 // ~25 minutes, matches the server job timeout
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_MS))
      const r = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/simulate/jobs/${jobId}`)
      if (!r.ok) { flash(setError, `Run status check failed (${r.status})`); return null }
      const job = await r.json().catch(() => null)
      if (job?.status === 'done') return job.result || {}
      if (job?.status === 'error') { flash(setError, `Run failed (${job.http_status || job.error || 'error'})`); return null }
    }
    flash(setError, 'Run is still going after 25 minutes; check Simulation runs later')
    return null
  }

  // Runs a batch of scenarios (Run all, Run category, or a single scenario)
  // as one POST to /simulate. This must stay a single batch call: the
  // publish gate (widget-scenarios.js latestSimulationRun) reads the single
  // newest widget_simulation_runs row by finished_at and gates on its
  // security_score. If this were split into one POST per scenario, that
  // row would hold only the last scenario's own score instead of the
  // batch's aggregate, so a benign final scenario could mask earlier
  // failures and wrongly unblock publish. All rows in the batch are marked
  // pending up front and patched together from the one response, so the
  // spinner and row updates still land together rather than as empty
  // dashes for the whole run.
  const runBatch = async (batch, scope) => {
    if (batch.length === 0) { flash(setInfo, 'Nothing to run. Seed scenarios first'); return }
    // QCL-SECURITY P0-1: /simulate now requires the org-scoped, authenticated
    // route, so a real widget context is required.
    if (!authFetch || !orgId || !widgetId) { flash(setError, 'Open a specific widget room to run simulations'); return }

    setRunning(true)
    setPendingIds(new Set(batch.map(s => s.id)))
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/simulate?async=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: scope || 'all',
          scenarios: batch.map(s => ({
            id: s.id, name: s.name, category: s.category,
            severity: s.severity, user_message: s.user_message, rubric: s.rubric || {},
          })),
        }),
      })
      if (resp.ok) {
        let data = await resp.json().catch(() => null)
        // Wave 5 defect 11: a full run takes far longer than any proxy
        // timeout, so the server answers 202 + job_id and we poll for the
        // result (a plain 200 body is still handled for older servers).
        if (resp.status === 202 && data?.job_id) {
          data = await pollSimulationJob(data.job_id)
          if (!data) return
        }
        applyRunResult(data)
        load()
      } else {
        const gateBody = await resp.json().catch(() => null)
        flash(setError, planGateMessage(resp.status, gateBody) || `Run failed (${resp.status})`)
      }
    } catch (err) { flash(setError, err.message) } finally { setRunning(false); setPendingIds(new Set()) }
  }

  const deleteScenario = async (sc) => {
    if (!window.confirm(`Remove "${sc.name}"?`)) return
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/scenarios/${sc.id}`, { method: 'DELETE' })
      if (resp.ok || resp.status === 204) load()
      else flash(setError, `Delete failed (${resp.status})`)
    } catch (err) { flash(setError, err.message) }
  }

  const totals = useMemo(() => ({
    total: scenarios.length,
    security: scenarios.filter(s => s.category === 'security').length,
    seeded: scenarios.filter(s => s.is_seed).length,
  }), [scenarios])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 400 }}>
      <PublishGateBanner readiness={readiness} />

      <div className="qx-flat-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Simulation arena</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
            {totals.total} scenario{totals.total === 1 ? '' : 's'} · {totals.security} security · {totals.seeded} seeded
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {totals.seeded === 0 && (
            <button type="button" onClick={seed} disabled={running} style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, background: 'rgba(48,255,144,0.15)', border: '1px solid rgba(48,255,144,0.3)', borderRadius: 6, color: '#30ff90', cursor: running ? 'wait' : 'pointer' }}>
              + Seed library
            </button>
          )}
          <button type="button" onClick={seed} disabled={running} style={{ padding: '6px 12px', fontSize: 11, fontWeight: 600, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'rgba(255,255,255,0.75)', cursor: running ? 'wait' : 'pointer' }}>
            Refresh seeds
          </button>
          <button type="button" onClick={() => runBatch(scenarios, 'all')} disabled={running || scenarios.length === 0} style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, background: running ? 'rgba(168,85,247,0.3)' : '#a855f7', border: 'none', borderRadius: 6, color: '#fff', cursor: running ? 'wait' : 'pointer' }}>
            {running ? 'Running...' : '▶ Run all'}
          </button>
          {readiness?.gate === 'unblocked' && readiness?.status !== 'published' && (
            <span style={{ fontSize: 11, color: '#30ff90', fontWeight: 600 }}>Ready: use Go live in the header.</span>
          )}
        </div>
      </div>

      {(error || info) && (
        <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: error ? 'rgba(239,68,68,0.14)' : 'rgba(48,255,144,0.14)', color: error ? '#ef4444' : '#30ff90' }}>
          {error || info}
        </div>
      )}

      {lastRun && (
        <div className="qx-flat-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: '#30ff90', fontWeight: 700 }}>{lastRun.passed || 0} pass</span>
            <span style={{ color: '#f59e0b', fontWeight: 700 }}>{lastRun.warned || 0} warn</span>
            <span style={{ color: '#ef4444', fontWeight: 700 }}>{lastRun.failed || 0} fail</span>
            {lastRun.security_score != null && (
              <span style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 700, display: 'flex', gap: 4, alignItems: 'center' }}>
                Security <ScoreBadge score={lastRun.security_score} />
              </span>
            )}
            {lastRun.duration_ms != null && <span style={{ color: 'rgba(255,255,255,0.55)' }}>{lastRun.duration_ms}ms</span>}
          </div>
          {formatRanAt(lastRun.ranAt) && (
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>Ran at {formatRanAt(lastRun.ranAt)}</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {CATEGORIES.map(cat => {
          const rows = grouped[cat.id] || []
          if (rows.length === 0) return null
          const isOpen = expanded.has(cat.id)
          const passed = rows.filter(r => r.last_passed === true).length
          const anyRun = rows.some(r => r.last_run_at)
          const anyPending = rows.some(r => pendingIds.has(r.id))
          return (
            <div key={cat.id} className="qx-flat-panel" style={{ padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => toggleCategory(cat.id)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12 }}>{isOpen ? '▾' : '▸'}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: cat.color }}>{cat.label}</span>
                  {anyPending
                    ? <PendingBadge />
                    : <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>{anyRun ? `${passed}/${rows.length} passing` : 'Not run yet'}</span>}
                </div>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); runBatch(rows, `category:${cat.id}`) }}
                  disabled={running}
                  style={{ padding: '3px 10px', fontSize: 10, fontWeight: 600, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: 4, color: '#a855f7', cursor: 'pointer' }}
                >
                  Run category
                </button>
              </div>
              {isOpen && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {rows.map(sc => (
                    <div key={sc.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto auto', gap: 8, padding: '6px 8px', alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: '#fff', fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span>{humaniseId(sc.name)}</span>
                          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', fontFamily: "'JetBrains Mono', monospace", background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 4 }}>{sc.name}</span>
                          {sc.is_seed && <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.2)', padding: '0 4px', borderRadius: 3 }}>seed</span>}
                          <SeverityBadge severity={sc.severity} />
                        </div>
                        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>
                          “{String(sc.user_message).slice(0, 100)}{sc.user_message?.length > 100 ? '…' : ''}”
                        </div>
                      </div>
                      {pendingIds.has(sc.id) ? <PendingBadge /> : <ScoreBadge score={sc.last_score} passed={sc.last_passed} />}
                      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>{!pendingIds.has(sc.id) && sc.last_run_at ? new Date(sc.last_run_at).toLocaleDateString() : ''}</span>
                      <button type="button" onClick={() => runBatch([sc], `single:${sc.id}`)} disabled={running} style={{ padding: '3px 8px', fontSize: 9, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: 4, color: '#a855f7', cursor: 'pointer' }}>Run</button>
                      {!sc.is_seed && (
                        <button type="button" onClick={() => deleteScenario(sc)} style={{ padding: '3px 8px', fontSize: 9, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 4, color: '#ef4444', cursor: 'pointer' }}>×</button>
                      )}
                      {sc.is_seed && <span />}
                      {sc.last_passed === false && (sc.last_response || sc.last_notes) && (
                        <div data-testid="scenario-failure" style={{ gridColumn: '1 / -1', fontSize: 10, color: 'rgba(255,255,255,0.7)', borderTop: '1px solid rgba(239,68,68,0.2)', paddingTop: 4 }}>
                          {sc.last_response && <div>Response: &ldquo;{sc.last_response}&rdquo;</div>}
                          {sc.last_notes && <div style={{ fontFamily: "'JetBrains Mono', monospace", color: '#ef4444' }}>{sc.last_notes}</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {scenarios.length === 0 && !loading && (
          <div className="qx-flat-panel--ghost" style={{ textAlign: 'center', padding: 24, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
            No scenarios yet. Click + Seed library to get started.
          </div>
        )}
      </div>
    </div>
  )
}
