/**
 * AvailabilityTab — operator presence, office hours, and alert routing.
 *
 * QUOXCHAT-PRO P1 admin UI for the three website_widgets fields shipped
 * server-side in migration 084:
 *   - operator_online            manual go-offline override (instant PATCH,
 *                                optimistic UI with revert on failure)
 *   - office_hours_json          weekly schedule, evaluated collector-side
 *                                (lib/quoxchatOfficeHours.js); null = no
 *                                schedule = humans available at all times
 *   - notification_settings_json per-event alert channels (email + webhook)
 *                                for new_conversation / handoff_requested
 *
 * Availability semantics (mirrors evaluateAvailability server-side):
 *   human_available = operator_online AND within_office_hours
 * The AI keeps answering regardless; this only shapes handoff expectations.
 */

import { useEffect, useState } from 'react'
import EmailNotConnectedNotice from '../../../settings/EmailNotConnectedNotice.jsx'

const DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
]

const DEFAULT_START = '09:00'
const DEFAULT_END = '17:00'
const DEFAULT_TIMEZONE = 'Europe/London'

const FALLBACK_TIMEZONES = [
  'Europe/London', 'UTC', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Madrid', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
]

function listTimezones(current) {
  let zones = FALLBACK_TIMEZONES
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone')
  } catch (_) { /* fall back to curated list */ }
  if (current && !zones.includes(current)) return [current, ...zones]
  return zones
}

function isValidHHMM(s) {
  return typeof s === 'string' && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(s.trim())
}

function toMinutes(s) {
  const [h, m] = s.split(':').map(n => parseInt(n, 10))
  return h * 60 + m
}

function normaliseRange(entry) {
  // Server accepts ["09:00","17:00"] tuples or { start, end } objects.
  if (Array.isArray(entry) && isValidHHMM(entry[0]) && isValidHHMM(entry[1])) {
    return { start: entry[0], end: entry[1] }
  }
  if (entry && typeof entry === 'object' && isValidHHMM(entry.start) && isValidHHMM(entry.end)) {
    return { start: entry.start, end: entry.end }
  }
  return null
}

/**
 * Parse office_hours_json (object, JSON string, or null) into editor state.
 * The editor shows one range per day; any additional valid ranges are kept
 * in `extra` and re-emitted verbatim on save so multi-range configs written
 * via the CLI are never silently dropped.
 */
export function parseOfficeHours(raw) {
  let cfg = raw
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg) } catch { cfg = null }
  }
  const days = {}
  const hasSchedule = !!(cfg && typeof cfg === 'object')
  const hours = hasSchedule && cfg.hours && typeof cfg.hours === 'object' ? cfg.hours : {}
  for (const { key } of DAYS) {
    const ranges = Array.isArray(hours[key]) ? hours[key].map(normaliseRange).filter(Boolean) : []
    if (ranges.length > 0) {
      days[key] = { enabled: true, start: ranges[0].start, end: ranges[0].end, extra: ranges.slice(1) }
    } else {
      // No schedule at all: seed a sensible Mon-Fri 9-5 default so enabling
      // the schedule is one click, not fourteen.
      const weekday = !hasSchedule && key !== 'sat' && key !== 'sun'
      days[key] = { enabled: hasSchedule ? false : weekday, start: DEFAULT_START, end: DEFAULT_END, extra: [] }
    }
  }
  return {
    enabled: hasSchedule,
    timezone: (hasSchedule && typeof cfg.timezone === 'string' && cfg.timezone) || DEFAULT_TIMEZONE,
    days,
  }
}

/** Editor state back to the PATCH payload. null = no schedule (fail open). */
export function buildOfficeHoursJson(state) {
  if (!state.enabled) return null
  const hours = {}
  for (const { key } of DAYS) {
    const d = state.days[key]
    hours[key] = d.enabled
      ? [[d.start, d.end], ...d.extra.map(r => [r.start, r.end])]
      : []
  }
  return { timezone: state.timezone, hours }
}

/**
 * Client-side mirror of the collector's isWithinOfficeHours() for the live
 * preview line only. The server verdict remains authoritative.
 */
export function isWithinOfficeHoursLocal(state, now = new Date()) {
  if (!state.enabled) return true
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: state.timezone || 'UTC',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now)
  }
  let weekday = ''
  let hour = 0
  let minute = 0
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value.toLowerCase().slice(0, 3)
    else if (p.type === 'hour') hour = parseInt(p.value, 10) % 24
    else if (p.type === 'minute') minute = parseInt(p.value, 10)
  }
  const day = state.days[weekday]
  if (!day || !day.enabled) return false
  const nowMin = hour * 60 + minute
  const ranges = [{ start: day.start, end: day.end }, ...day.extra]
  return ranges.some(r =>
    isValidHHMM(r.start) && isValidHHMM(r.end)
    && nowMin >= toMinutes(r.start) && nowMin < toMinutes(r.end))
}

/**
 * Parse notification_settings_json into editor state. Email channels are
 * flattened to a comma-separated string; the first webhook channel maps to
 * the URL/secret fields. Unknown channel types (slack/telegram written via
 * the CLI) are preserved in `otherChannels` and re-emitted on save.
 */
export function parseNotificationSettings(raw) {
  let cfg = raw
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg) } catch { cfg = null }
  }
  const parseEvent = (evt) => {
    const e = cfg && typeof cfg === 'object' ? cfg[evt] : null
    const channels = e && Array.isArray(e.channels) ? e.channels : []
    const emails = channels.filter(c => c && c.type === 'email' && (c.to || c.recipient)).map(c => c.to || c.recipient)
    const webhook = channels.find(c => c && c.type === 'webhook') || null
    const otherChannels = channels.filter(c => c && c.type !== 'email' && c.type !== 'webhook')
    return {
      enabled: !!(e && e.enabled === true),
      emails: emails.join(', '),
      webhookUrl: (webhook && (webhook.url || webhook.recipient)) || '',
      webhookSecret: (webhook && webhook.secret) || '',
      otherChannels,
    }
  }
  return {
    new_conversation: parseEvent('new_conversation'),
    handoff_requested: parseEvent('handoff_requested'),
  }
}

export function buildNotificationSettingsJson(state) {
  const buildEvent = (e) => {
    const channels = []
    for (const addr of e.emails.split(',').map(s => s.trim()).filter(Boolean)) {
      channels.push({ type: 'email', to: addr })
    }
    if (e.webhookUrl.trim()) {
      const ch = { type: 'webhook', url: e.webhookUrl.trim() }
      if (e.webhookSecret.trim()) ch.secret = e.webhookSecret.trim()
      channels.push(ch)
    }
    channels.push(...e.otherChannels)
    return { enabled: e.enabled, channels }
  }
  return {
    new_conversation: buildEvent(state.new_conversation),
    handoff_requested: buildEvent(state.handoff_requested),
  }
}

/** One-line summary of an alert event's configured channels, for the collapsed state. */
function channelSummary(e) {
  const parts = []
  const emailList = e.emails.split(',').map(s => s.trim()).filter(Boolean)
  if (emailList.length > 0) parts.push(`Email: ${emailList.join(', ')}`)
  if (e.webhookUrl.trim()) parts.push('Webhook configured')
  for (const ch of e.otherChannels) {
    const label = ch && ch.type ? ch.type.charAt(0).toUpperCase() + ch.type.slice(1) : 'Channel'
    parts.push(`${label} configured`)
  }
  return parts.join(', ')
}

const inputStyle = {
  padding: '6px 10px', fontSize: 12, background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6,
  color: '#fff', fontFamily: 'inherit',
}

const sectionTitleStyle = { margin: 0, fontSize: 13, fontWeight: 700, color: '#fff' }
const hintStyle = { margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.7)' }

function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
  )
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10" />
    </svg>
  )
}

export default function AvailabilityTab({ widget, authFetch, orgId, onWidgetChange }) {
  // ── operator toggle ──
  const [operatorOnline, setOperatorOnline] = useState(() =>
    widget?.operator_online === undefined || widget?.operator_online === null
      ? true
      : !!Number(widget.operator_online))
  const [toggleBusy, setToggleBusy] = useState(false)
  const [toggleError, setToggleError] = useState(null)

  // ── office hours ──
  const [schedule, setSchedule] = useState(() => parseOfficeHours(widget?.office_hours_json))
  const [savedSchedule, setSavedSchedule] = useState(schedule)
  const [scheduleMsg, setScheduleMsg] = useState(null) // { type: 'success'|'error', text }
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const scheduleDirty = JSON.stringify(schedule) !== JSON.stringify(savedSchedule)

  // ── alerts ──
  const [alerts, setAlerts] = useState(() => parseNotificationSettings(widget?.notification_settings_json))
  const [alertsMsg, setAlertsMsg] = useState(null)
  const [alertsSaving, setAlertsSaving] = useState(false)

  // Keep the "Right now" preview honest as the clock ticks.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30000)
    return () => clearInterval(t)
  }, [])

  const patchWidget = async (body) => {
    const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
    if (data.widget && typeof onWidgetChange === 'function') onWidgetChange(data.widget)
    return data
  }

  // The owner's go-offline override: instant, optimistic, revert on failure.
  const handleToggleOperator = async () => {
    if (toggleBusy || !authFetch || !orgId || !widget?.id) return
    const next = !operatorOnline
    setOperatorOnline(next)
    setToggleBusy(true)
    setToggleError(null)
    try {
      await patchWidget({ operator_online: next })
    } catch (err) {
      setOperatorOnline(!next) // revert
      setToggleError(`Could not update status: ${err.message}`)
    } finally {
      setToggleBusy(false)
    }
  }

  const handleSaveSchedule = async () => {
    if (scheduleSaving || !authFetch || !orgId || !widget?.id) return
    if (schedule.enabled) {
      for (const { key, label } of DAYS) {
        const d = schedule.days[key]
        if (!d.enabled) continue
        if (!isValidHHMM(d.start) || !isValidHHMM(d.end)) {
          setScheduleMsg({ type: 'error', text: `${label}: enter times as HH:MM.` })
          return
        }
        if (toMinutes(d.start) >= toMinutes(d.end)) {
          setScheduleMsg({ type: 'error', text: `${label}: start time must be before end time.` })
          return
        }
      }
    }
    setScheduleSaving(true)
    setScheduleMsg(null)
    try {
      await patchWidget({ office_hours_json: buildOfficeHoursJson(schedule) })
      setSavedSchedule(schedule)
      setScheduleMsg({ type: 'success', text: 'Schedule saved' })
    } catch (err) {
      setScheduleMsg({ type: 'error', text: `Save failed: ${err.message}` })
    } finally {
      setScheduleSaving(false)
    }
  }

  const handleSaveAlerts = async () => {
    if (alertsSaving || !authFetch || !orgId || !widget?.id) return
    setAlertsSaving(true)
    setAlertsMsg(null)
    try {
      await patchWidget({ notification_settings_json: buildNotificationSettingsJson(alerts) })
      setAlertsMsg({ type: 'success', text: 'Alert settings saved' })
    } catch (err) {
      setAlertsMsg({ type: 'error', text: `Save failed: ${err.message}` })
    } finally {
      setAlertsSaving(false)
    }
  }

  const setDay = (key, patch) => {
    setSchedule(s => ({ ...s, days: { ...s.days, [key]: { ...s.days[key], ...patch } } }))
  }

  const setEvent = (evt, patch) => {
    setAlerts(a => ({ ...a, [evt]: { ...a[evt], ...patch } }))
  }

  const withinHours = isWithinOfficeHoursLocal(schedule)
  const humanAvailable = operatorOnline && withinHours
  const previewParts = [
    schedule.enabled
      ? (withinHours ? 'within office hours' : 'outside office hours')
      : 'no office-hours schedule',
    operatorOnline ? 'operator online' : 'operator toggled offline',
  ]
  const previewOutcome = humanAvailable
    ? 'visitors see human handoff as available'
    : 'visitors see your team as offline (the AI keeps answering)'

  const alertEventDefs = [
    { id: 'new_conversation', title: 'New conversation', desc: 'Fires the first time a visitor starts a chat.' },
    { id: 'handoff_requested', title: 'Human handoff requested', desc: 'Fires when a visitor asks for a human. Sent as high priority.' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Operator status ── */}
      <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span className={`wr-avail__lamp ${operatorOnline ? 'wr-avail__lamp--on' : 'wr-avail__lamp--off'}`} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 200 }}>
            <h3 style={sectionTitleStyle}>Operator status: {operatorOnline ? 'Online' : 'Offline'}</h3>
            <p style={hintStyle}>
              {operatorOnline
                ? 'Visitors can be handed off to your team while you are within office hours.'
                : 'Handoff is paused everywhere. The AI keeps answering visitors.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggleOperator}
            disabled={toggleBusy}
            className={`wr-avail__toggle ${operatorOnline ? 'wr-avail__toggle--online' : 'wr-avail__toggle--offline'}`}
            title={operatorOnline ? 'Instantly mark your team as offline (overrides the schedule)' : 'Bring your team back online'}
          >
            <PowerIcon />
            {toggleBusy ? 'Updating…' : operatorOnline ? 'Go offline' : 'Go online'}
          </button>
        </div>
        {toggleError && (
          <div style={{ fontSize: 11, color: '#ef4444' }}>{toggleError}</div>
        )}
        {/* Live preview */}
        <div style={{
          padding: '8px 12px', borderRadius: 8, fontSize: 12,
          background: humanAvailable ? 'rgba(48,255,144,0.07)' : 'rgba(245,158,11,0.07)',
          border: `1px solid ${humanAvailable ? 'rgba(48,255,144,0.2)' : 'rgba(245,158,11,0.2)'}`,
          color: '#fff',
        }}>
          <strong>Right now:</strong> {previewParts.join(', ')}, which means {previewOutcome}.
        </div>
      </div>

      {/* ── Office hours ── */}
      <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={sectionTitleStyle}>Office hours</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#fff', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={e => setSchedule(s => ({ ...s, enabled: e.target.checked }))}
            />
            Follow a weekly schedule
          </label>
        </div>
        <p style={hintStyle}>
          Outside these hours visitors see your team as offline and the AI keeps answering.
          With the schedule off, your team counts as available at all times (the status toggle above still applies).
        </p>
        {schedule.enabled && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#fff' }}>
              Timezone
              <select
                value={schedule.timezone}
                onChange={e => setSchedule(s => ({ ...s, timezone: e.target.value }))}
                style={{ ...inputStyle, maxWidth: 260 }}
              >
                {listTimezones(schedule.timezone).map(z => <option key={z} value={z}>{z}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {DAYS.map(({ key, label }) => {
                const d = schedule.days[key]
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: d.enabled ? 1 : 0.55 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: 130, fontSize: 12, color: '#fff', cursor: 'pointer', flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        onChange={e => setDay(key, { enabled: e.target.checked })}
                      />
                      {label}
                    </label>
                    {d.enabled ? (
                      <>
                        <input
                          type="time"
                          aria-label={`${label} start time`}
                          value={d.start}
                          onChange={e => setDay(key, { start: e.target.value })}
                          style={inputStyle}
                        />
                        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>to</span>
                        <input
                          type="time"
                          aria-label={`${label} end time`}
                          value={d.end}
                          onChange={e => setDay(key, { end: e.target.value })}
                          style={inputStyle}
                        />
                        {d.extra.length > 0 && (
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }} title={d.extra.map(r => `${r.start}-${r.end}`).join(', ')}>
                            +{d.extra.length} more range{d.extra.length === 1 ? '' : 's'} (set via CLI, kept on save)
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>Closed</span>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
        {(schedule.enabled || scheduleDirty) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="quoxchat-btn quoxchat-btn--primary"
              onClick={handleSaveSchedule}
              disabled={scheduleSaving}
            >
              <SaveIcon />
              {scheduleSaving ? 'Saving…' : 'Save schedule'}
            </button>
            {scheduleMsg && (
              <span style={{ fontSize: 11, color: scheduleMsg.type === 'success' ? '#30ff90' : '#ef4444' }}>
                {scheduleMsg.type === 'success' ? '✓ ' : ''}{scheduleMsg.text}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Alerts ── */}
      {/* id is the scroll anchor for the "configure alerts" nudge in
          QuoxChatWidgetRoom (handoff on, no channels configured). */}
      <div id="wr-alerts-section" className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={sectionTitleStyle}>Alerts</h3>
        <p style={hintStyle}>
          Get notified when visitors need attention. Up to 5 channels per event are delivered;
          email uses your organisation's configured mail credentials.
        </p>
        <EmailNotConnectedNotice featureLabel="email alerts" />
        {alertEventDefs.map(evt => {
          const e = alerts[evt.id]
          const summary = channelSummary(e)
          return (
            <div key={evt.id} style={{
              display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
              border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10,
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={e.enabled}
                  onChange={ev => setEvent(evt.id, { enabled: ev.target.checked })}
                />
                {evt.title}
              </label>
              <p style={{ ...hintStyle, marginLeft: 24 }}>{evt.desc}</p>
              {!e.enabled && summary && (
                <p style={{ ...hintStyle, marginLeft: 24 }}>{summary}</p>
              )}
              {e.enabled && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 24 }}>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Email recipients (comma separated)
                  </label>
                  <input
                    type="text"
                    placeholder="ops@example.com, support@example.com"
                    value={e.emails}
                    onChange={ev => setEvent(evt.id, { emails: ev.target.value })}
                    style={inputStyle}
                  />
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Webhook URL (optional)
                  </label>
                  <input
                    type="url"
                    placeholder="https://hooks.example.com/quoxchat"
                    value={e.webhookUrl}
                    onChange={ev => setEvent(evt.id, { webhookUrl: ev.target.value })}
                    style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                  />
                  {e.webhookUrl.trim() && (
                    <>
                      <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Webhook signing secret (optional)
                      </label>
                      <input
                        type="password"
                        placeholder="Used to sign webhook payloads"
                        value={e.webhookSecret}
                        onChange={ev => setEvent(evt.id, { webhookSecret: ev.target.value })}
                        style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                        autoComplete="new-password"
                      />
                    </>
                  )}
                  {e.otherChannels.length > 0 && (
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
                      +{e.otherChannels.length} extra channel{e.otherChannels.length === 1 ? '' : 's'} configured via CLI ({e.otherChannels.map(c => c.type).join(', ')}), kept on save.
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="quoxchat-btn quoxchat-btn--primary"
            onClick={handleSaveAlerts}
            disabled={alertsSaving}
          >
            <SaveIcon />
            {alertsSaving ? 'Saving…' : 'Save alerts'}
          </button>
          {alertsMsg && (
            <span style={{ fontSize: 11, color: alertsMsg.type === 'success' ? '#30ff90' : '#ef4444' }}>
              {alertsMsg.type === 'success' ? '✓ ' : ''}{alertsMsg.text}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
