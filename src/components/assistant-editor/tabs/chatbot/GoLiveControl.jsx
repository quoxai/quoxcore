/**
 * GoLiveControl: status pill + "Go live" / Pause / Resume for the Widget Room
 * header. Going live runs the widget's stored security checks on the server
 * (POST .../publish, async job) and only then flips the widget to published.
 */

import { useState, useRef, useEffect } from 'react'
import { liveState, publishResultLine } from '../../../../widget/goLiveUtils'

const POLL_MS = 3000
const MAX_POLLS = 500 // ~25 minutes, matching the server job timeout

export default function GoLiveControl({ widget, authFetch, orgId, onWidgetChange }) {
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState(null)
  // Compliance blockers the admin must acknowledge before Go live proceeds.
  const [pendingWarnings, setPendingWarnings] = useState(null)
  // Failed security scenarios from the last run (with the bot's response and
  // the rubric line it failed). High severity ones need an explicit ack.
  const [failures, setFailures] = useState(null)
  const [needsHighAck, setNeedsHighAck] = useState(false)
  const [ackedCompliance, setAckedCompliance] = useState(false)
  // W16: a publish job that errored (not a security verdict) offers Retry.
  const [jobErrored, setJobErrored] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const st = liveState(widget?.status)
  const base = `/api/orgs/${orgId}/widgets/${widget?.id}`

  const patchStatus = async (status) => {
    const resp = await authFetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    const body = await resp.json().catch(() => ({}))
    if (resp.ok) { onWidgetChange?.(body.widget || { status }); return true }
    setLine(body.message || body.error || `Could not change status (${resp.status})`)
    return false
  }

  const pause = async () => { setBusy(true); setLine(null); try { await patchStatus('paused') } finally { setBusy(false) } }

  const goLive = async (acknowledge = false, ackHigh = false) => {
    setPendingWarnings(null)
    setFailures(null)
    setNeedsHighAck(false)
    setJobErrored(false)
    setAckedCompliance(acknowledge)
    setBusy(true)
    setLine('Starting the security checks...')
    try {
      // A paused widget with a passing publish resumes directly.
      if (st.key === 'paused') {
        const resp = await authFetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'published' }) })
        if (resp.ok) { const b = await resp.json().catch(() => ({})); onWidgetChange?.(b.widget || { status: 'published' }); setLine('Live again.'); setBusy(false); return }
      }
      const resp = await authFetch(`${base}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(acknowledge ? { acknowledge: true } : {}), ...(ackHigh ? { acknowledge_high_severity: true } : {}) }) })
      const body = await resp.json().catch(() => ({}))
      if (resp.status === 409 && body.error === 'compliance_acknowledgement_required') {
        setPendingWarnings(body.compliance_warnings || [])
        setLine(body.message || 'Compliance items are not ready.')
        setBusy(false)
        return
      }
      if (resp.status === 200) { onWidgetChange?.({ status: 'published' }); setLine('Live.'); setBusy(false); return }
      if (resp.status !== 202 || !body.job_id) { setLine(body.message || body.error || `Go live failed (${resp.status})`); setBusy(false); return }
      setLine(`Running ${body.scenario_count} security checks...`)
      let n = 0
      const poll = async () => {
        n += 1
        try {
          const r = await authFetch(`${base}/publish/jobs/${body.job_id}`)
          const job = await r.json().catch(() => null)
          if (job && job.status !== 'running') {
            setLine(publishResultLine(job))
            const fs = job.result?.failed_scenarios
            setFailures(Array.isArray(fs) && fs.length > 0 ? fs : null)
            setNeedsHighAck(job.result?.reason === 'high_severity_failures_unacknowledged')
            setJobErrored(job.status === 'error')
            if (job.result?.published) onWidgetChange?.({ status: 'published' })
            setBusy(false)
            return
          }
        } catch { /* keep polling */ }
        if (n >= MAX_POLLS) { setLine('Still running after 25 minutes. Check Simulation runs later.'); setBusy(false); return }
        timer.current = setTimeout(poll, POLL_MS)
      }
      timer.current = setTimeout(poll, POLL_MS)
    } catch (err) {
      setLine(err?.message || 'Go live failed.')
      setBusy(false)
    }
  }

  return (
    <div className="wr-golive" data-testid="go-live" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className={`quoxchat-card__status quoxchat-card__status--${widget?.status || 'draft'}`} data-testid="status-pill">{st.label}</span>
      {st.canGoLive && (
        <button type="button" className="quoxchat-btn quoxchat-btn--primary" onClick={() => goLive(false)} disabled={busy} data-testid="go-live-btn">
          {busy ? 'Working...' : st.key === 'paused' ? 'Resume' : 'Go live'}
        </button>
      )}
      {st.canPause && (
        <button type="button" className="quoxchat-btn quoxchat-btn--ghost" onClick={pause} disabled={busy} data-testid="pause-btn">Pause</button>
      )}
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }} data-testid="go-live-line">{line || st.note}</span>
      {jobErrored && (
        <button type="button" className="quoxchat-btn quoxchat-btn--ghost" onClick={() => goLive(ackedCompliance)} disabled={busy} data-testid="go-live-retry-btn">
          Retry
        </button>
      )}
      {failures && (
        <div role="alert" data-testid="failed-scenarios" style={{ flexBasis: '100%', fontSize: 12, color: '#ffcf70' }}>
          <div style={{ fontWeight: 700 }}>{failures.length} security {failures.length === 1 ? 'check' : 'checks'} failed. Read each response and judge whether it is a real leak.</div>
          <ul style={{ margin: '4px 0 6px 16px', padding: 0 }}>
            {failures.map(f => (
              <li key={f.scenario_id} style={{ marginBottom: 6 }}>
                <strong>{f.name}</strong> ({f.severity})
                {f.response_text != null && <div>Response: &ldquo;{f.response_text}&rdquo;</div>}
                {(f.rubric_lines || []).map((l, i) => <div key={i} style={{ fontFamily: 'monospace', fontSize: 11 }}>{l}</div>)}
              </li>
            ))}
          </ul>
          {needsHighAck && (
            <button type="button" className="quoxchat-btn quoxchat-btn--ghost" onClick={() => goLive(ackedCompliance, true)} disabled={busy} data-testid="go-live-ack-high-btn">
              I reviewed the high severity failures, go live anyway
            </button>
          )}
        </div>
      )}
      {pendingWarnings && pendingWarnings.length > 0 && (
        <div role="alert" data-testid="compliance-warnings" style={{ flexBasis: '100%', fontSize: 12, color: '#ffcf70' }}>
          <ul style={{ margin: '4px 0 6px 16px', padding: 0 }}>
            {pendingWarnings.map(w => <li key={w.id}>{w.message}{w.fix ? ` Fix: ${w.fix}` : ''}</li>)}
          </ul>
          <button type="button" className="quoxchat-btn quoxchat-btn--ghost" onClick={() => goLive(true)} disabled={busy} data-testid="go-live-ack-btn">
            I understand, go live anyway
          </button>
        </div>
      )}
    </div>
  )
}
