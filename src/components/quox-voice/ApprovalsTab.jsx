/**
 * Approvals tab: ApprovalsQ policy settings and the recent-escalations log
 * (QUOX-VOICE-OUTBOUND ApprovalsQ phase 4). ApprovalsQ phones the owner to
 * clear a stale approval. It never approves anything itself.
 * The policy is stored server-side (plugin storage); the log comes from the
 * collector. Nothing is held in the browser.
 */
import { useEffect, useState } from 'react'
import { approvalsApi, DEFAULT_POLICY } from './lib/approvalsApi.js'
import { useApprovalsPolicy, useEscalations } from './lib/useApprovals.js'

function mergePolicy(stored) {
  const s = stored || {}
  return {
    ...DEFAULT_POLICY,
    ...s,
    quiet_hours: { ...DEFAULT_POLICY.quiet_hours, ...(s.quiet_hours || {}) },
  }
}

function fmtTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString()
}

function Field({ label, hint, span = 4, children }) {
  return (
    <label className="qx-field" style={{ '--span': span, '--span-sm': 12 }}>
      <span className="qx-field__label">{label}</span>
      {children}
      {hint ? <span className="qx-field__hint">{hint}</span> : null}
    </label>
  )
}

function PolicyForm({ stored, onSaved }) {
  const [f, setF] = useState(() => mergePolicy(stored))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [saved, setSaved] = useState(false)
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setSaved(false) }
  const setQh = (k, v) => {
    setF((p) => ({ ...p, quiet_hours: { ...p.quiet_hours, [k]: v } }))
    setSaved(false)
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    const dest = (f.destination_number || '').trim()
    const policy = {
      enabled: !!f.enabled,
      age_threshold_minutes: Number(f.age_threshold_minutes),
      quiet_hours: {
        start: f.quiet_hours.start,
        end: f.quiet_hours.end,
        timezone: (f.quiet_hours.timezone || '').trim(),
      },
      max_retries: Number(f.max_retries),
      gap_minutes: Number(f.gap_minutes),
      destination_number: dest || null,
      min_tier: f.min_tier,
      voicemail_policy: f.voicemail_policy,
    }
    try {
      await approvalsApi.putPolicy(policy)
      setSaved(true)
      onSaved()
    } catch (e2) {
      setErr(e2)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="qx-stack" onSubmit={submit} aria-label="ApprovalsQ policy">
      {err && (
        <div className="qx-banner qx-banner--error" role="alert">
          {err.message || 'Could not save the policy.'}
        </div>
      )}
      {saved && !err && (
        <div className="qx-banner qx-banner--success" role="status">Policy saved.</div>
      )}
      <label className="qx-row qx-row--tight" style={{ alignItems: 'center', cursor: 'pointer' }}>
        <span className="qx-toggle">
          <input type="checkbox" checked={!!f.enabled} aria-label="Enable ApprovalsQ"
            onChange={(e) => set('enabled', e.target.checked)} />
          <span className="qx-toggle__track" />
        </span>
        <span>
          <strong>Call me about stale approvals</strong><br />
          <span>Off by default. When on, ApprovalsQ rings you once an approval has waited past the threshold.</span>
        </span>
      </label>
      <div className="qx-form-grid">
        <div className="qx-form-grid__cells">
          <Field label="Wait before calling (minutes)" hint="How old an approval must be before ApprovalsQ calls.">
            <input type="number" min="1" className="qx-input" value={f.age_threshold_minutes}
              onChange={(e) => set('age_threshold_minutes', e.target.value)} />
          </Field>
          <Field label="Max retries" hint="Calls attempted per approval before giving up.">
            <input type="number" min="0" max="10" className="qx-input" value={f.max_retries}
              onChange={(e) => set('max_retries', e.target.value)} />
          </Field>
          <Field label="Gap between tries (minutes)">
            <input type="number" min="0" className="qx-input" value={f.gap_minutes}
              onChange={(e) => set('gap_minutes', e.target.value)} />
          </Field>
          <Field label="Quiet hours from" hint="No calls inside quiet hours.">
            <input type="time" className="qx-input" value={f.quiet_hours.start}
              onChange={(e) => setQh('start', e.target.value)} />
          </Field>
          <Field label="Quiet hours until">
            <input type="time" className="qx-input" value={f.quiet_hours.end}
              onChange={(e) => setQh('end', e.target.value)} />
          </Field>
          <Field label="Timezone">
            <input className="qx-input" value={f.quiet_hours.timezone}
              onChange={(e) => setQh('timezone', e.target.value)} />
          </Field>
          <Field label="Number to call" hint="Leave empty to use the owner default." span={4}>
            <input className="qx-input" placeholder="owner default" value={f.destination_number || ''}
              onChange={(e) => set('destination_number', e.target.value)} />
          </Field>
          <Field label="Which approvals" hint="Destructive only keeps the phone quiet for routine ones.">
            <select className="qx-select" value={f.min_tier} onChange={(e) => set('min_tier', e.target.value)}>
              <option value="tier1">Tier 1 and destructive only</option>
              <option value="all">All approvals</option>
            </select>
          </Field>
          <Field label="On voicemail">
            <select className="qx-select" value={f.voicemail_policy}
              onChange={(e) => set('voicemail_policy', e.target.value)}>
              <option value="leave">Leave a message</option>
              <option value="retry">Retry</option>
            </select>
          </Field>
        </div>
      </div>
      <div className="qx-row qx-row--end">
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
          {busy ? 'Saving' : 'Save policy'}
        </button>
      </div>
    </form>
  )
}

function EscalationsSection() {
  const { escalations, loading, error, retry } = useEscalations()
  const unavailable = error?.status === 404 || error?.status === 503

  return (
    <div className="qx-stack">
      <div className="quoxvoice-head">
        <h2>Recent escalations</h2>
        <button type="button" className="qx-btn qx-btn--sm" onClick={() => retry()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
          </svg>
          Refresh
        </button>
      </div>

      {unavailable && (
        <div className="qx-banner qx-banner--info">
          The escalation log is not available yet on this instance. It appears here once the collector route is deployed.
        </div>
      )}
      {error && !unavailable && (
        <div className="qx-banner qx-banner--error" role="alert">
          {error.message || 'Could not load escalations.'}{' '}
          <button type="button" className="qx-btn qx-btn--sm" onClick={() => retry()}>Retry</button>
        </div>
      )}

      {loading && <div className="qx-empty"><span className="qx-spinner" /></div>}

      {!loading && !error && escalations.length === 0 && (
        <div className="qx-empty">
          <div className="qx-empty__title">No escalations yet</div>
          <div className="qx-empty__body">When ApprovalsQ rings you about a stale approval, it is logged here.</div>
        </div>
      )}

      {!loading && !error && escalations.length > 0 && (
        <table className="qx-table">
          <thead>
            <tr>
              <th>Approval</th><th>State</th><th>Attempts</th>
              <th>Last outcome</th><th>Started</th><th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {escalations.map((x, i) => (
              <tr key={x.id || x.approval_id || i}>
                <td>{x.title || x.approval_title || x.approval_id || '-'}</td>
                <td><span className="qx-pill qx-pill--xs">{x.state || '-'}</span></td>
                <td>{x.attempts ?? 0}</td>
                <td>{x.last_outcome || '-'}</td>
                <td>{fmtTime(x.created_at || x.started_at)}</td>
                <td>{fmtTime(x.updated_at || x.last_attempt_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function ApprovalsTab() {
  const { policy, loading, error, retry } = useApprovalsPolicy()
  const [formKey, setFormKey] = useState(0)

  // Remount the form when a fresh server copy arrives so fields match what is stored.
  useEffect(() => { setFormKey((k) => k + 1) }, [policy])

  return (
    <div className="qx-card qx-stack quoxvoice-approvals" style={{ overflow: 'auto' }}>
      <div className="quoxvoice-head">
        <h2>Approvals</h2>
      </div>
      <p className="quoxvoice-sub">
        ApprovalsQ rings you when an approval has been waiting too long, so you can decide.
      </p>
      <div className="qx-banner qx-banner--info">
        ApprovalsQ never approves anything on its own. It only calls you; you make the decision.
      </div>

      {loading && <div className="qx-empty"><span className="qx-spinner" /></div>}
      {error && (
        <div className="qx-banner qx-banner--error" role="alert">
          {error.message || 'Could not load the policy.'}{' '}
          <button type="button" className="qx-btn qx-btn--sm" onClick={() => retry()}>Retry</button>
        </div>
      )}
      {!loading && !error && (
        <PolicyForm key={formKey} stored={policy} onSaved={() => retry({ silent: true })} />
      )}

      <div className="qx-divider" />
      <EscalationsSection />
    </div>
  )
}
