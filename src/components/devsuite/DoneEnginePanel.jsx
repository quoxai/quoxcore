/**
 * DoneEnginePanel — DONEENGINE phase 9: the dashboard MIRROR of the
 * instrument ("dashboard panel, last, once the verbs are real" — the verbs
 * are `quox done check|board|bar|history|packs`, live since phase 11).
 *
 * A mirror, deliberately: the engine runs on the control box where git and
 * docker can answer; this panel renders the newest SNAPSHOT it wrote and
 * says WHEN it was taken. It never re-measures, and it never softens the
 * engine's own honesty rules: no snapshot renders as "no measurement", a
 * stale one gets a loud age warning, and attested/machine evidence are
 * never summed (the engine exists because sentences once outvoted facts).
 *
 * Composition only — qx classes per the glass design system, zero bespoke
 * CSS (SlotsDeckPanel is the sibling pattern).
 */

import { useState, useEffect, useCallback, useRef } from 'react'

const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function relativeAge(ms) {
  if (ms == null) return 'unknown age'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

function DeployPill({ deployed }) {
  const cls = deployed === 'yes' ? 'qx-pill--ok' : deployed === 'no' ? 'qx-pill--danger' : 'qx-pill--warn'
  const label = deployed === 'yes' ? 'deployed' : deployed === 'no' ? 'not deployed' : 'unknown'
  return <span className={`qx-pill qx-pill--sm ${cls}`}>{label}</span>
}

const FlagIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M5 21V4" strokeLinecap="round" />
    <path d="M5 4h13l-2.5 4L18 12H5" strokeLinejoin="round" />
  </svg>
)

export default function DoneEnginePanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const connectionIdRef = useRef(0)

  const fetchLatest = useCallback(async () => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch('/collector/api/v1/doneengine/snapshots/latest')
      const body = await res.json().catch(() => null)
      if (connectionIdRef.current !== currentId) return
      if (!res.ok) {
        // 404 no-measurement and 503 unreadable both carry a message; show
        // it verbatim rather than inventing a softer one.
        setError({ status: res.status, message: body?.message || `HTTP ${res.status}` })
        setData(null)
      } else {
        setData(body)
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
    fetchLatest()
    const interval = setInterval(fetchLatest, 60000) // snapshots change rarely
    return () => {
      connectionIdRef.current++
      clearInterval(interval)
    }
  }, [fetchLatest])

  const snap = data?.snapshot
  const stale = data?.age_ms != null && data.age_ms > STALE_AFTER_MS

  return (
    <div className="qx-card" data-testid="doneengine-panel">
      <div className="qx-row qx-row--apart" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          {FlagIcon}
          <h3 style={{ margin: 0 }}>DoneEngine</h3>
        </div>
        {snap && (
          <span className="qx-hint" data-testid="doneengine-taken-at">
            measured {relativeAge(data.age_ms)} · pack {snap.pack}{snap.pack_version ? ` v${snap.pack_version}` : ''}
          </span>
        )}
      </div>

      {/* 2026-10-08 owner: the tab read like an internal benchmark. Lead with
          what it is and why a team would want it, in plain words, and point at
          the customer verb (not the control-box gauge.mjs internals). */}
      <div className="qx-tip" style={{ marginBottom: 12 }} data-testid="doneengine-explainer">
        <b>Is it really done?</b> DoneEngine scores every surface you ship against a rule pack
        and gives two separate verdicts: <b>Build</b> (the code is finished and tested) and
        {' '}<b>Deployed</b> (the running system actually has it). They are never merged into one
        number, so &ldquo;done in the repo&rdquo; can never pass as &ldquo;live&rdquo;. Take a reading
        with <code className="qx-code">quox done bar &lt;pack&gt; --snapshot</code>; this tab shows the
        newest one and when it was taken.
      </div>

      {loading && (
        <div className="qx-skeleton qx-skeleton--line-md" style={{ width: '60%' }} data-testid="doneengine-loading" />
      )}

      {!loading && error && (
        <div className="qx-empty" data-testid="doneengine-error">
          <div className="qx-empty__title">
            {error.status === 404 ? 'No measurement taken' : 'Snapshot unavailable'}
          </div>
          <div className="qx-empty__body">
            {error.status === 404 ? (
              <>Run <code className="qx-code">quox done packs</code> to see the rule packs, then
              {' '}<code className="qx-code">quox done bar &lt;pack&gt; --snapshot</code> to take your
              first reading. It appears here straight away.</>
            ) : error.message}
          </div>
        </div>
      )}

      {!loading && snap && (
        <>
          {stale && (
            <div className="qx-banner qx-banner--warn" style={{ marginBottom: 12 }} data-testid="doneengine-stale">
              This measurement is {relativeAge(data.age_ms)} old. The world has likely moved;
              re-run <code className="qx-code">quox done bar &lt;pack&gt; --snapshot</code> before trusting it.
            </div>
          )}

          <div className="qx-stat-row" style={{ marginBottom: 16 }}>
            <div className="qx-stat">
              <div className="qx-stat__value" data-testid="doneengine-build-ready">{snap.build_ready}/{snap.total}</div>
              <div className="qx-stat__label">Build Ready (the repo)</div>
            </div>
            <div className="qx-stat">
              <div className="qx-stat__value" data-testid="doneengine-deployed-ready">{snap.deployed_ready}/{snap.total}</div>
              <div className="qx-stat__label">Deployed Ready (the box)</div>
            </div>
            {snap.evidence && (
              <div className="qx-stat">
                <div className="qx-stat__value">
                  {Object.entries(snap.evidence).map(([k, v]) => `${v} ${k}`).join(' · ')}
                </div>
                <div className="qx-stat__label">deploy evidence strength</div>
              </div>
            )}
          </div>

          <table className="qx-table" data-testid="doneengine-subjects">
            <thead>
              <tr>
                <th>Surface</th>
                <th>Score</th>
                <th>Build</th>
                <th>Deployed</th>
                <th>Deploy evidence</th>
              </tr>
            </thead>
            <tbody>
              {(snap.subjects || []).map((s) => (
                <tr key={s.surface}>
                  <td><code className="qx-code">{s.surface}</code></td>
                  <td>{s.score ?? '-'}</td>
                  <td>
                    <span className={`qx-pill qx-pill--sm ${s.build_ready ? 'qx-pill--ok' : 'qx-pill--danger'}`}>
                      {s.build_ready ? 'ready' : 'not ready'}
                    </span>
                  </td>
                  <td><DeployPill deployed={s.deployed} /></td>
                  <td className="qx-hint">{s.deploy_evidence || 'none'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="qx-hint" style={{ marginTop: 12 }}>
            These verdicts match <code className="qx-code">quox done board</code> one for one.
          </div>
        </>
      )}
    </div>
  )
}
