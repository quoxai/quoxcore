/**
 * NotesQSchedules: the caller's scheduled notes (template -> one note per day or week).
 * Schedules are per user and run on the server; this is only the editor for them.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../notesq/lib/api'
import { CalendarIcon, PauseIcon, PlayIcon, TrashIcon, PlusIcon, CheckIcon, XIcon } from '../notesq/icons'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n) => String(n).padStart(2, '0')

export function cadenceText(s) {
  const time = `${pad(s.hour)}:${pad(s.minute)} ${s.tz}`
  return s.cadence === 'weekly' ? `Weekly ${DAYS[s.weekday] ?? '?'} ${time}` : `Daily ${time}`
}

function nextRunText(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

function AddForm({ templates, onCreated, onCancel }) {
  const [template, setTemplate] = useState(templates[0]?.name || '')
  const [cadence, setCadence] = useState('daily')
  const [weekday, setWeekday] = useState(1)
  const [time, setTime] = useState('07:30')
  const [tz, setTz] = useState(browserTz())
  const [scope, setScope] = useState('user')
  const [collection, setCollection] = useState('')
  const [titlePattern, setTitlePattern] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    const m = /^(\d{1,2}):(\d{2})$/.exec(time)
    if (!m) { setError('Enter the time as HH:MM.'); return }
    const body = { template, cadence, hour: Number(m[1]), minute: Number(m[2]), tz: tz.trim(), scope }
    if (cadence === 'weekly') body.weekday = Number(weekday)
    if (collection.trim()) body.collection = collection.trim()
    if (titlePattern.trim()) body.title_pattern = titlePattern.trim()
    setBusy(true); setError('')
    try {
      await api.createSchedule(body)
      onCreated()
    } catch (err) {
      setError(err.message || 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Add schedule">
      {error ? <div className="qx-banner qx-banner--error" role="alert">{error}</div> : null}
      <div className="qx-field">
        <label className="qx-field__label" htmlFor="nq-sch-template">Template</label>
        <select id="nq-sch-template" className="qx-select" value={template} onChange={(e) => setTemplate(e.target.value)}>
          {templates.map((t) => <option key={`${t.source}:${t.id || t.name}`} value={t.name}>{t.name}</option>)}
        </select>
      </div>
      <div className="qx-seg" role="group" aria-label="Cadence">
        {[['daily', 'Daily'], ['weekly', 'Weekly']].map(([v, l]) => (
          <button key={v} type="button" className={`qx-seg__btn${cadence === v ? ' qx-seg__btn--active' : ''}`} aria-pressed={cadence === v} onClick={() => setCadence(v)}>{l}</button>
        ))}
      </div>
      {cadence === 'weekly' ? (
        <div className="qx-field">
          <label className="qx-field__label" htmlFor="nq-sch-weekday">Day of the week</label>
          <select id="nq-sch-weekday" className="qx-select" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </div>
      ) : null}
      <div className="qx-field">
        <label className="qx-field__label" htmlFor="nq-sch-time">Time (HH:MM)</label>
        <input id="nq-sch-time" className="qx-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
      </div>
      <div className="qx-field">
        <label className="qx-field__label" htmlFor="nq-sch-tz">Time zone</label>
        <input id="nq-sch-tz" className="qx-input" type="text" value={tz} onChange={(e) => setTz(e.target.value)} required />
      </div>
      <div className="qx-seg" role="group" aria-label="Scheduled note scope">
        {[['user', 'Personal'], ['org', 'Org']].map(([v, l]) => (
          <button key={v} type="button" className={`qx-seg__btn${scope === v ? ' qx-seg__btn--active' : ''}`} aria-pressed={scope === v} onClick={() => setScope(v)}>{l}</button>
        ))}
      </div>
      <div className="qx-field">
        <label className="qx-field__label" htmlFor="nq-sch-coll">Collection (optional)</label>
        <input id="nq-sch-coll" className="qx-input" type="text" value={collection} onChange={(e) => setCollection(e.target.value)} />
      </div>
      <div className="qx-field">
        <label className="qx-field__label" htmlFor="nq-sch-title">Title pattern (optional)</label>
        <input id="nq-sch-title" className="qx-input" type="text" value={titlePattern} onChange={(e) => setTitlePattern(e.target.value)} />
      </div>
      <div className="qx-row qx-row--tight">
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy || !template}><CheckIcon /> Save schedule</button>
        <button type="button" className="qx-btn qx-btn--ghost" onClick={onCancel}><XIcon /> Cancel</button>
      </div>
    </form>
  )
}

export default function NotesQSchedules() {
  const [schedules, setSchedules] = useState(null)
  const [templates, setTemplates] = useState([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await api.listSchedules()
      setSchedules(r?.schedules || []); setError('')
    } catch (e) {
      setSchedules((s) => s || [])
      setError(`Could not load scheduled notes. ${e.message}`)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.listTemplates().then((r) => setTemplates(r?.templates || [])).catch((e) => setError((p) => p || `Could not load templates. ${e.message}`))
  }, [])

  const toggle = async (s) => {
    setBusyId(s.id); setError('')
    try { await api.setScheduleEnabled(s.id, !s.enabled); await load() } catch (e) { setError(e.message || 'Something went wrong.') } finally { setBusyId(null) }
  }
  const remove = async (s) => {
    if (!window.confirm(`Delete the schedule for "${s.template}"? Notes it already created are kept.`)) return
    setBusyId(s.id); setError('')
    try { await api.deleteSchedule(s.id); await load() } catch (e) { setError(e.message || 'Something went wrong.') } finally { setBusyId(null) }
  }

  return (
    <section className="qx-card qx-stack qx-stack--compact" data-testid="notesq-schedules" aria-label="Scheduled notes">
      <div className="qx-row qx-row--apart qx-row--wrap">
        <span className="qx-section-title"><CalendarIcon /> Scheduled notes</span>
        {!adding ? (
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => setAdding(true)}><PlusIcon /> Add schedule</button>
        ) : null}
      </div>
      <p className="qx-hint qx-hint--sm">One note per day or week, never doubled. Runs on the server, even when nobody is signed in.</p>
      {error ? <div className="qx-banner qx-banner--error" role="alert">{error}</div> : null}
      {adding ? <AddForm templates={templates} onCreated={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} /> : null}
      {schedules === null ? <div className="qx-hint" role="status">Loading...</div> : null}
      {schedules && schedules.length === 0 && !adding ? <div className="qx-hint">No scheduled notes yet.</div> : null}
      {schedules && schedules.length > 0 ? (
        <ul className="qx-stack qx-stack--compact" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {schedules.map((s) => (
            <li key={s.id} className="qx-row qx-row--apart qx-row--wrap" data-testid={`schedule-${s.id}`}>
              <div className="qx-stack qx-stack--tight" style={{ minWidth: 0 }}>
                <strong>{s.template}</strong>
                <span>{cadenceText(s)}</span>
                <span className="qx-hint qx-hint--sm">
                  {s.scope === 'org' ? 'Org' : 'Personal'}{s.collection ? `, ${s.collection}` : ''}
                  {s.enabled && s.next_run_at ? `, next run ${nextRunText(s.next_run_at)}` : ''}
                </span>
                <span className="qx-row qx-row--tight qx-row--wrap">
                  <span className={`qx-pill qx-pill--xs ${s.enabled ? 'qx-pill--success' : 'qx-pill--medium'}`}>{s.enabled ? 'Active' : 'Paused'}</span>
                  {!s.enabled && s.disabled_reason ? <span className="qx-hint qx-hint--sm">Paused: {s.disabled_reason}</span> : null}
                  {s.failures > 0 ? <span className="qx-hint qx-hint--sm">{s.failures} {s.failures === 1 ? 'failure' : 'failures'}{s.last_error ? `, last: ${s.last_error}` : ''}</span> : null}
                </span>
              </div>
              <div className="qx-row qx-row--tight">
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busyId === s.id} onClick={() => toggle(s)}>
                  {s.enabled ? <><PauseIcon /> Pause</> : <><PlayIcon /> Resume</>}
                </button>
                <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" disabled={busyId === s.id} onClick={() => remove(s)}><TrashIcon /> Delete</button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
