/**
 * DevBuildPanel — capability panel for dev.build (DEVSUITE-BUILD step 3:
 * the QuoxBuild per-server build queue window).
 *
 * Data (all reads are daemon state and Postgres/SQLite, never an LLM —
 * token-discipline law):
 *   GET  /collector/api/v1/dev-build/:hostId/status   live executor state
 *   GET  /collector/api/v1/dev-build/:hostId/targets  pre-registered targets
 *   GET  /collector/api/v1/build-receipts?host=       durable history (mirror)
 * Action:
 *   POST /collector/api/v1/dev-build/:hostId/dispatch {target, msg?} — the
 *   body names a pre-registered target; the collector signs the envelope
 *   and the host-side executor does the rest. The terminal label on the
 *   receipt is derived server-side from the authenticated caller.
 */

import { useState, useEffect, useCallback } from 'react'

const OUTCOME_PILL = {
  ok: 'qx-pill--online',
  FAIL: 'qx-pill--warn',
  UNVERIFIED: 'qx-pill--degraded',
  INTERRUPTED: 'qx-pill--ghost',
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

/**
 * The receipt `terminal` field is a free-text label with no agreed shape, so
 * it holds whatever the requester wrote. In practice it holds three things:
 *
 *   "T4"                                    from the CLI (useful)
 *   "dashboard:01KKNKG580E967VC6YKAFWRT27"  from dashboard-initiated builds
 *   "dashboard:01KKN...,dashboard:01KKN..." when the queue COALESCED two
 *                                           requests inside its 3s window
 *
 * The third is real information (two people asked for the same build and got
 * one) rendered as noise: the identical id printed twice, comma-joined, wider
 * than every other column on the row. A raw ULID also tells a reader nothing
 * they can act on.
 *
 * Normalise for display only. The stored value is left exactly as it is,
 * because it is evidence.
 */
function terminalLabel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const parts = [...new Set(raw.split(',').map((p) => p.trim()).filter(Boolean))];
  if (parts.length === 0) return null;
  const pretty = (p) => (p.startsWith('dashboard:') ? 'dashboard' : p);
  const first = pretty(parts[0]);
  // More than one DISTINCT requester means the queue coalesced them, which is
  // worth saying in words rather than making the reader diff two ULIDs.
  return parts.length > 1 ? `${first} +${parts.length - 1} coalesced` : first;
}

function agoLabel(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function DevBuildPanel({ server }) {
  const hostId = server?.host_id
  const receiptHost = server?.hostname || server?.host_id
  const [status, setStatus] = useState(null)
  const [targets, setTargets] = useState(null)
  const [receipts, setReceipts] = useState([])
  const [error, setError] = useState(null)
  const [dispatching, setDispatching] = useState(null)
  const [dispatchNote, setDispatchNote] = useState(null)

  const load = useCallback(async () => {
    if (!hostId) return
    try {
      setError(null)
      const [stRes, tgRes] = await Promise.all([
        fetch(`/collector/api/v1/dev-build/${encodeURIComponent(hostId)}/status`),
        fetch(`/collector/api/v1/dev-build/${encodeURIComponent(hostId)}/targets`),
      ])
      if (!stRes.ok) throw new Error(`status failed (${stRes.status})`)
      if (!tgRes.ok) throw new Error(`targets failed (${tgRes.status})`)
      setStatus(await stRes.json())
      const tg = await tgRes.json()
      setTargets(Array.isArray(tg.targets) ? tg.targets : [])
    } catch (e) {
      setError(e.message)
      return
    }
    // History is the durable mirror; a receipts failure degrades the view
    // (live state still renders), it never blanks the panel.
    try {
      const res = await fetch(`/collector/api/v1/build-receipts?host=${encodeURIComponent(receiptHost)}&limit=10`)
      if (res.ok) {
        const data = await res.json()
        setReceipts(Array.isArray(data.receipts) ? data.receipts : [])
      }
    } catch {
      setReceipts([])
    }
  }, [hostId, receiptHost])

  useEffect(() => { load() }, [load])

  // BUNDLE POLISH B: follow a build while it runs, instead of going silent.
  //
  // Dispatching printed "<target> queued (coalesces within the queue window)"
  // and then nothing ever moved again until the user pressed Refresh. A build
  // takes minutes, so the panel's most common state was a stale snapshot of a
  // system that was actively working, and the honest CLI-side signal
  // (queued is not built) had no counterpart here.
  //
  // Poll only WHILE something is building, and stop when it is not: an idle
  // panel must not sit on a timer forever, and this is a per-host request.
  useEffect(() => {
    if (!status?.building) return undefined
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [status?.building, load])

  const onDispatch = useCallback(async (targetName) => {
    setDispatchNote(null)
    setDispatching(targetName)
    try {
      const res = await fetch(`/collector/api/v1/dev-build/${encodeURIComponent(hostId)}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetName, msg: 'dispatched from hub panel' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `dispatch failed (${res.status})`)
      // "queued" is the honest word for what just happened, and it is NOT
       // "built". The polling effect above takes over from here and the pill
       // row shows what the queue is actually doing.
      setDispatchNote({ ok: true, text: `${targetName} queued. Watching the queue…`, target: targetName })
      // Give the executor a moment to pick the run up, then refresh.
      setTimeout(load, 2500)
    } catch (e) {
      setDispatchNote({ ok: false, text: e.message })
    } finally {
      setDispatching(null)
    }
  }, [hostId, load])

  if (error) {
    return <div className="capability-panel-row" data-testid="dev-build-error">Build queue unavailable: {error}</div>
  }
  if (status === null || targets === null) {
    return <div className="capability-panel-row" data-testid="dev-build-loading">Loading build queue…</div>
  }

  const prereqs = status.prereqs || {}
  const lastOutcomes = status.last_outcomes || {}

  return (
    <div className="capability-panel-dev-build" data-testid="capability-panel-dev-build">
      <div className="capability-panel-row">
        <span className={`qx-pill qx-pill--sm ${status.ready ? 'qx-pill--online' : 'qx-pill--warn'}`}>
          {status.ready ? 'ready' : 'degraded'}
        </span>
        {status.building
          ? <span className="qx-pill qx-pill--sm qx-pill--info">building: {status.building}</span>
          : <span className="qx-pill qx-pill--sm qx-pill--ghost">idle</span>}
        <span className="qx-hint qx-hint--sm">
          {status.target_count || 0} registered targets
        </span>
        <button type="button" className="qx-btn qx-btn--sm" data-testid="dev-build-refresh" onClick={load}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      {!status.ready && (
        <div className="capability-panel-row qx-hint qx-hint--warn" data-testid="dev-build-degraded">
          {prereqs.config_error || 'No build-targets.yaml registered on this host. `quox dev enable` provisions it.'}
        </div>
      )}
      {Array.isArray(prereqs.missing_workdirs) && prereqs.missing_workdirs.length > 0 && (
        <div className="capability-panel-row qx-hint qx-hint--warn">
          missing workdirs: {prereqs.missing_workdirs.join(', ')}
        </div>
      )}

      {dispatchNote && (
        <div data-testid="dev-build-dispatch-note"
             className={`capability-panel-row qx-hint ${dispatchNote.ok ? '' : 'qx-hint--warn'}`}>
          {/*
            Once the queue reports an outcome for the target we dispatched, say
            THAT instead of still saying "queued". A note frozen on the word
            queued while the receipt below already reads FAIL is the panel
            disagreeing with itself.
          */}
          {dispatchNote.ok && dispatchNote.target && lastOutcomes[dispatchNote.target]
            ? `${dispatchNote.target}: ${lastOutcomes[dispatchNote.target]}`
            : dispatchNote.text}
        </div>
      )}

      {targets.length === 0 ? (
        <div className="capability-panel-row" data-testid="dev-build-no-targets">No pre-registered targets on this host.</div>
      ) : targets.map((t) => {
        const outcome = lastOutcomes[t.name]
        return (
          <div className="capability-panel-row" data-testid={`dev-build-target-${t.name}`} key={t.name}
              >
            <code className="qx-code">{t.name}</code>
            {t.composite && t.composite.length > 0
              ? <span className="qx-pill qx-pill--sm qx-pill--ghost">→ {t.composite.join(' + ')}</span>
              : <span className="qx-hint qx-hint--sm">{t.steps} steps · {t.verify_count} probes</span>}
            {outcome && <span className={`qx-pill qx-pill--sm ${OUTCOME_PILL[outcome] || 'qx-pill--ghost'}`}>{outcome}</span>}
            <button
              type="button"
              className="qx-btn qx-btn--sm"
              data-testid={`dev-build-dispatch-${t.name}`}
              disabled={!status.ready || dispatching === t.name}
              onClick={() => onDispatch(t.name)}
            >
              <PlayIcon /> {dispatching === t.name ? 'Queuing…' : 'Build'}
            </button>
          </div>
        )
      })}

      {receipts.length > 0 && (
        <>
          <div className="capability-panel-label">Recent receipts</div>
          {receipts.map((r) => (
            <div className="capability-panel-row" data-testid={`dev-build-receipt-${r.id}`} key={r.id}
                >
              <span className={`qx-pill qx-pill--sm ${OUTCOME_PILL[r.result] || 'qx-pill--ghost'}`}>{r.result}</span>
              <code className="qx-code">{r.target}</code>
              {terminalLabel(r.terminal) && <span className="qx-hint qx-hint--sm" title={r.terminal}>{terminalLabel(r.terminal)}</span>}
              {(r.stream || r.phase) && (
                <span className="qx-pill qx-pill--sm qx-pill--ghost">{[r.stream, r.phase].filter(Boolean).join('/')}</span>
              )}
              {Number.isFinite(r.duration_seconds) && r.duration_seconds !== null && (
                <span className="qx-hint qx-hint--sm">{r.duration_seconds}s</span>
              )}
              <span className="qx-hint qx-hint--sm">{agoLabel(r.created_at)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
