/**
 * Schedules tab: OutboundQ scheduled calls (QUOX-VOICE-OUTBOUND #521 phase 5).
 * The list and every write go through the collector proxy to the voice bridge;
 * nothing is held in the browser.
 */
import { useState } from 'react'
import { api } from './lib/api.js'
import { useSchedules } from './lib/useSchedules.js'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const BLANK = {
  name: '',
  purpose: '',
  cadence: 'daily',
  at_time: '09:00',
  days: [],
  tz: 'Europe/London',
  to_number: '',
  briefing_kind: 'none',
  briefing_text: '',
  max_attempts: 3,
  gap_seconds: 120,
  on_voicemail: 'leave',
}

function parseDays(csv) {
  if (!csv) return []
  return String(csv).split(',').map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6)
}

function describeWhen(s) {
  const time = s.at_time || ''
  const tz = s.tz || ''
  let cadence = s.cadence === 'once' ? 'Once' : s.cadence === 'weekly' ? 'Weekly' : 'Daily'
  if (s.cadence === 'weekly') {
    const days = parseDays(s.days).map((d) => DAYS[d]).join(', ')
    if (days) cadence = `Weekly ${days}`
  }
  return [cadence, time, tz].filter(Boolean).join(' ')
}

function fmtTime(ts) {
  if (!ts) return 'never'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString()
}

function errorText(err) {
  if (err?.status === 503) return null
  return err?.message || 'Something went wrong.'
}

function ScheduleRow({ s, busy, onToggle, onDelete }) {
  return (
    <tr>
      <td>{s.name}</td>
      <td>{describeWhen(s)}</td>
      <td>{s.enabled ? fmtTime(s.next_run_at) : 'paused'}</td>
      <td>
        {s.last_run_at ? fmtTime(s.last_run_at) : 'never'}
        {s.last_status ? <span className="qx-pill qx-pill--xs"> {s.last_status}</span> : null}
      </td>
      <td>
        {s.run_count || 0}
        {s.fail_count > 0 && (
          <span className="qx-pill qx-pill--danger qx-pill--xs"> {s.fail_count} failed</span>
        )}
      </td>
      <td>
        <label className="qx-toggle" title={s.enabled ? 'Pause schedule' : 'Enable schedule'}>
          <input type="checkbox" checked={!!s.enabled} disabled={busy}
            onChange={(e) => onToggle(s, e.target.checked)} />
          <span className="qx-toggle__track" />
        </label>
      </td>
      <td>
        <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" disabled={busy}
          onClick={() => onDelete(s)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </svg>
          Delete
        </button>
      </td>
    </tr>
  )
}

function NewScheduleForm({ onCreated }) {
  const [f, setF] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }))

  const toggleDay = (i) => setF((p) => ({
    ...p,
    days: p.days.includes(i) ? p.days.filter((d) => d !== i) : [...p.days, i].sort(),
  }))

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    const body = {
      name: f.name.trim(),
      purpose: f.purpose.trim(),
      cadence: f.cadence,
      at_time: f.at_time.trim(),
      tz: f.tz.trim(),
      briefing_kind: f.briefing_kind,
      max_attempts: Number(f.max_attempts),
      gap_seconds: Number(f.gap_seconds),
      on_voicemail: f.on_voicemail,
    }
    if (f.cadence === 'weekly') body.days = f.days.join(',')
    if (f.to_number.trim()) body.to_number = f.to_number.trim()
    if (f.briefing_kind === 'text') body.briefing_text = f.briefing_text
    try {
      await api.createSchedule(body)
      setF(BLANK)
      onCreated()
    } catch (e2) {
      setErr(e2)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="qx-form-grid" onSubmit={submit}>
      <div className="qx-form-grid__cells">
        <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
          <label className="qx-field__label">Name</label>
          <input className="qx-input" required value={f.name}
            onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
          <label className="qx-field__label">Purpose (spoken opener)</label>
          <input className="qx-input" value={f.purpose}
            onChange={(e) => set('purpose', e.target.value)} />
        </div>
        <div className="qx-field" style={{ '--span': 4, '--span-sm': 12 }}>
          <label className="qx-field__label">Cadence</label>
          <select className="qx-select" value={f.cadence}
            onChange={(e) => set('cadence', e.target.value)}>
            <option value="once">Once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        <div className="qx-field" style={{ '--span': 4, '--span-sm': 6 }}>
          <label className="qx-field__label">Time (HH:MM)</label>
          <input className="qx-input" required pattern="[0-9]{2}:[0-9]{2}" value={f.at_time}
            onChange={(e) => set('at_time', e.target.value)} />
        </div>
        <div className="qx-field" style={{ '--span': 4, '--span-sm': 6 }}>
          <label className="qx-field__label">Timezone</label>
          <input className="qx-input" required value={f.tz}
            onChange={(e) => set('tz', e.target.value)} />
        </div>
        {f.cadence === 'weekly' && (
          <div className="qx-field" style={{ '--span': 12 }}>
            <label className="qx-field__label">Days</label>
            <div className="qx-row" style={{ flexWrap: 'wrap', gap: 12 }}>
              {DAYS.map((d, i) => (
                <label key={d} className="qx-row" style={{ gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={f.days.includes(i)} onChange={() => toggleDay(i)} />
                  {d}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
          <label className="qx-field__label">Number to call</label>
          <input className="qx-input" placeholder="owner mobile by default" value={f.to_number}
            onChange={(e) => set('to_number', e.target.value)} />
        </div>
        <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
          <label className="qx-field__label">Briefing</label>
          <select className="qx-select" value={f.briefing_kind}
            onChange={(e) => set('briefing_kind', e.target.value)}>
            <option value="none">None</option>
            <option value="slots">Slots</option>
            <option value="lucid">Lucid</option>
            <option value="text">Text</option>
          </select>
        </div>
        {f.briefing_kind === 'text' && (
          <div className="qx-field" style={{ '--span': 12 }}>
            <label className="qx-field__label">Briefing text</label>
            <input className="qx-input" value={f.briefing_text}
              onChange={(e) => set('briefing_text', e.target.value)} />
          </div>
        )}
        <div className="qx-field" style={{ '--span': 4, '--span-sm': 6 }}>
          <label className="qx-field__label">Max attempts</label>
          <input className="qx-input" type="number" min="1" max="10" value={f.max_attempts}
            onChange={(e) => set('max_attempts', e.target.value)} />
        </div>
        <div className="qx-field" style={{ '--span': 4, '--span-sm': 6 }}>
          <label className="qx-field__label">Gap between tries (seconds)</label>
          <input className="qx-input" type="number" min="0" value={f.gap_seconds}
            onChange={(e) => set('gap_seconds', e.target.value)} />
        </div>
        <div className="qx-field" style={{ '--span': 4, '--span-sm': 12 }}>
          <label className="qx-field__label">On voicemail</label>
          <select className="qx-select" value={f.on_voicemail}
            onChange={(e) => set('on_voicemail', e.target.value)}>
            <option value="leave">Leave a message</option>
            <option value="retry">Retry</option>
          </select>
        </div>
      </div>
      {err && <div className="qx-banner qx-banner--error" style={{ marginTop: 12 }}>{errorText(err) || 'Scheduled calling is not configured on this instance.'}</div>}
      <div style={{ marginTop: 12 }}>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={saving}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          {saving ? 'Creating' : 'Create schedule'}
        </button>
      </div>
    </form>
  )
}

export default function SchedulesTab() {
  const { schedules, loading, error, retry } = useSchedules()
  const [busyId, setBusyId] = useState(null)
  const [actionErr, setActionErr] = useState(null)
  const [showForm, setShowForm] = useState(false)

  const unconfigured = error?.status === 503

  const toggle = async (s, enabled) => {
    setBusyId(s.id)
    setActionErr(null)
    try {
      await api.setEnabled(s.id, enabled)
      retry({ silent: true })
    } catch (e) {
      setActionErr(e)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (s) => {
    if (!window.confirm(`Delete schedule "${s.name}"?`)) return
    setBusyId(s.id)
    setActionErr(null)
    try {
      await api.deleteSchedule(s.id)
      retry({ silent: true })
    } catch (e) {
      setActionErr(e)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="qx-card quoxvoice-schedules" style={{ overflow: 'auto' }}>
      <div className="quoxvoice-head">
        <h2>Scheduled calls</h2>
        {!unconfigured && (
          <button type="button" className="qx-btn qx-btn--sm" onClick={() => setShowForm((v) => !v)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            {showForm ? 'Hide form' : 'New schedule'}
          </button>
        )}
      </div>
      <p className="quoxvoice-sub">
        OutboundQ rings you on a schedule and delivers a briefing live, or leaves it as a voicemail.
      </p>

      {unconfigured && (
        <div className="qx-banner qx-banner--info">Scheduled calling is not configured on this instance.</div>
      )}
      {error && !unconfigured && (
        <div className="qx-banner qx-banner--error">
          {errorText(error)}{' '}
          <button type="button" className="qx-btn qx-btn--sm" onClick={() => retry()}>Retry</button>
        </div>
      )}
      {actionErr && <div className="qx-banner qx-banner--error">{errorText(actionErr) || 'Scheduled calling is not configured on this instance.'}</div>}

      {showForm && !unconfigured && <NewScheduleForm onCreated={() => { setShowForm(false); retry({ silent: true }) }} />}

      {loading && <div className="qx-empty"><span className="qx-spinner" /></div>}

      {!loading && !error && schedules.length === 0 && (
        <div className="qx-empty">
          <div className="qx-empty__title">No schedules yet</div>
          <div className="qx-empty__body">Create one to have Q call you at a set time.</div>
        </div>
      )}

      {!loading && !error && schedules.length > 0 && (
        <table className="qx-table">
          <thead>
            <tr>
              <th>Name</th><th>When</th><th>Next run</th><th>Last run</th>
              <th>Runs</th><th>Enabled</th><th></th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <ScheduleRow key={s.id} s={s} busy={busyId === s.id} onToggle={toggle} onDelete={remove} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
