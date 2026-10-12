// notesqSchedules.js - NotesQ P4 durable schedules (AQ-9D).
//
// Pure time helpers (localParts, nextRunAt, periodFor) plus a sqlite store
// (migrations/023-notesq-schedules.sql). User-facing CRUD is scoped by
// orgId+userId; listDue/claim/recordResult are service-side (cross-org) and
// drive the scheduler: claim is a compare-and-set on last_period so a period
// fires at most once, recordResult does failure accounting with capped
// backoff and retires a schedule after MAX_FAILURES.

import { randomBytes } from 'crypto'
import { getDatabase } from './db.js'
import { NotesqError } from './notesq.js'

export const MAX_PER_USER = 20
export const MAX_FAILURES = 10
const BACKOFF_BASE_MS = 5 * 60 * 1000
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000
const DAY_MS = 86400000

const fmtCache = new Map()
function formatter(tz) {
  let f = fmtCache.get(tz)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', weekday: 'short',
      })
    } catch {
      throw new NotesqError(400, 'invalid_tz')
    }
    fmtCache.set(tz, f)
  }
  return f
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function localParts(ms, tz) {
  if (typeof tz !== 'string' || !tz) throw new NotesqError(400, 'invalid_tz')
  const parts = formatter(tz).formatToParts(new Date(ms))
  const o = {}
  for (const p of parts) o[p.type] = p.value
  return {
    year: Number(o.year), month: Number(o.month), day: Number(o.day),
    hour: Number(o.hour) % 24, minute: Number(o.minute), weekday: WD[o.weekday],
  }
}

// Local wall time expressed as if it were UTC (ms).
function wallAsUtc(ms, tz) {
  const p = localParts(ms, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
}

// Wall time y-m-d h:min in tz -> UTC ms. Two-pass offset correction; a wall
// time inside a spring-forward gap resolves to the next valid minute.
function wallToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min)
  let t = guess - (wallAsUtc(guess, tz) - guess)
  t = guess - (wallAsUtc(t, tz) - t)
  if (wallAsUtc(t, tz) === guess) return t
  // Gap: walk forward minute by minute from well before the transition.
  let s = Math.floor((guess - 26 * 3600000) / 60000) * 60000
  for (let i = 0; i < 52 * 60; i++, s += 60000) {
    if (wallAsUtc(s, tz) >= guess) return s
  }
  return t
}

export function nextRunAt(schedule, fromMs) {
  const { tz, hour, minute, cadence, weekday } = schedule
  const lp = localParts(fromMs, tz)
  for (let i = 0; i <= 8; i++) {
    const c = new Date(Date.UTC(lp.year, lp.month - 1, lp.day + i))
    if (cadence === 'weekly' && c.getUTCDay() !== weekday) continue
    const t = wallToUtc(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), hour, minute, tz)
    if (t > fromMs) return new Date(t).toISOString()
  }
  throw new NotesqError(400, 'unschedulable')
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

export function periodFor(schedule, atMs) {
  const p = localParts(atMs, schedule.tz)
  if (schedule.cadence === 'daily') return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
  // ISO week of the local date.
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const isoYear = d.getUTCFullYear()
  const week = Math.ceil(((d - Date.UTC(isoYear, 0, 1)) / DAY_MS + 1) / 7)
  return `${pad(isoYear, 4)}-W${pad(week)}`
}

const nowIso = () => new Date().toISOString()
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi

function toPublic(r) {
  if (!r) return r
  const { org_id, ...rest } = r
  return { ...rest, enabled: !!r.enabled }
}

function getOwned(db, { orgId, userId, id }) {
  const row = db.prepare('SELECT * FROM notesq_schedules WHERE id = ? AND org_id = ? AND user_id = ?').get(id, orgId, userId)
  if (!row) throw new NotesqError(404, 'not_found')
  return row
}

export function listSchedules({ orgId, userId }) {
  return getDatabase()
    .prepare('SELECT * FROM notesq_schedules WHERE org_id = ? AND user_id = ? ORDER BY created_at, id')
    .all(orgId, userId).map(toPublic)
}

export function createSchedule({ orgId, userId, template, title_pattern = null, cadence, weekday = null, hour, minute, tz, scope, collection = null }) {
  if (typeof template !== 'string' || !template.trim() || template.length > 120) throw new NotesqError(400, 'invalid_template')
  if (cadence !== 'daily' && cadence !== 'weekly') throw new NotesqError(400, 'invalid_cadence')
  if (cadence === 'weekly') {
    if (!intIn(weekday, 0, 6)) throw new NotesqError(400, 'invalid_weekday')
  } else if (weekday != null) {
    throw new NotesqError(400, 'invalid_weekday')
  }
  if (!intIn(hour, 0, 23)) throw new NotesqError(400, 'invalid_hour')
  if (!intIn(minute, 0, 59)) throw new NotesqError(400, 'invalid_minute')
  localParts(Date.now(), tz) // throws invalid_tz
  if (scope !== 'user' && scope !== 'org') throw new NotesqError(400, 'invalid_scope')
  if (collection != null && (typeof collection !== 'string' || collection.length > 120)) throw new NotesqError(400, 'invalid_collection')
  if (title_pattern != null && (typeof title_pattern !== 'string' || title_pattern.length > 200)) throw new NotesqError(400, 'invalid_title_pattern')
  const db = getDatabase()
  const { n } = db.prepare('SELECT COUNT(*) n FROM notesq_schedules WHERE org_id = ? AND user_id = ?').get(orgId, userId)
  if (n >= MAX_PER_USER) throw new NotesqError(400, 'too_many_schedules')
  const row = {
    id: 'nqs_' + randomBytes(9).toString('hex'), org_id: orgId, user_id: userId,
    template: template.trim(), title_pattern: title_pattern || null, cadence,
    weekday: cadence === 'weekly' ? weekday : null, hour, minute, tz, scope,
    collection: collection || null, enabled: 1, last_period: null,
    next_run_at: nextRunAt({ cadence, weekday, hour, minute, tz }, Date.now()),
    failures: 0, last_error: null, disabled_reason: null, created_at: nowIso(), updated_at: nowIso(),
  }
  db.prepare(`INSERT INTO notesq_schedules (id, org_id, user_id, template, title_pattern, cadence, weekday, hour, minute, tz, scope, collection, enabled, last_period, next_run_at, failures, last_error, disabled_reason, created_at, updated_at)
    VALUES (@id, @org_id, @user_id, @template, @title_pattern, @cadence, @weekday, @hour, @minute, @tz, @scope, @collection, @enabled, @last_period, @next_run_at, @failures, @last_error, @disabled_reason, @created_at, @updated_at)`).run(row)
  return toPublic(row)
}

export function setEnabled({ orgId, userId, id, enabled }) {
  if (typeof enabled !== 'boolean') throw new NotesqError(400, 'invalid_enabled')
  const db = getDatabase()
  const row = getOwned(db, { orgId, userId, id })
  if (enabled) {
    db.prepare('UPDATE notesq_schedules SET enabled = 1, failures = 0, last_error = NULL, disabled_reason = NULL, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt(row, Date.now()), nowIso(), id)
  } else {
    db.prepare('UPDATE notesq_schedules SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso(), id)
  }
  return toPublic(db.prepare('SELECT * FROM notesq_schedules WHERE id = ?').get(id))
}

export function deleteSchedule({ orgId, userId, id }) {
  const db = getDatabase()
  getOwned(db, { orgId, userId, id })
  db.prepare('DELETE FROM notesq_schedules WHERE id = ?').run(id)
  return { deleted: true }
}

// ---- service-side (cross-org) ----

// Service view keeps org_id/user_id: the scheduler needs them to act as the owner.
export function listDue(nowStr, limit = 50) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
  const now = nowStr && !Number.isNaN(Date.parse(nowStr)) ? new Date(nowStr).toISOString() : nowIso()
  const rows = getDatabase()
    .prepare('SELECT * FROM notesq_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?')
    .all(now, lim)
  return rows.map((r) => ({ ...r, enabled: !!r.enabled, period: periodFor(r, Date.parse(r.next_run_at)) }))
}

function getAny(db, id) {
  const row = db.prepare('SELECT * FROM notesq_schedules WHERE id = ?').get(id)
  if (!row) throw new NotesqError(404, 'not_found')
  return row
}

export function claim(id, period) {
  if (typeof period !== 'string' || !period) throw new NotesqError(400, 'invalid_period')
  const db = getDatabase()
  const row = getAny(db, id)
  const r = db.prepare('UPDATE notesq_schedules SET last_period = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND (last_period IS NULL OR last_period < ?)')
    .run(period, nowIso(), id, period)
  return { claimed: r.changes === 1, previous_period: r.changes === 1 ? row.last_period : null }
}

export function recordResult(id, { period, outcome, error, previous_period = null } = {}, nowMs = Date.now()) {
  if (!['ok', 'error', 'skip'].includes(outcome)) throw new NotesqError(400, 'invalid_outcome')
  const db = getDatabase()
  const row = getAny(db, id)
  const ts = new Date(nowMs).toISOString()
  if (outcome === 'ok') {
    db.prepare('UPDATE notesq_schedules SET failures = 0, last_error = NULL, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt(row, nowMs), ts, id)
  } else if (outcome === 'skip') {
    db.prepare('UPDATE notesq_schedules SET last_period = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(previous_period, nextRunAt(row, nowMs), ts, id)
  } else {
    const failures = row.failures + 1
    const msg = String(error || 'error').slice(0, 300)
    const next = new Date(nowMs + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS)).toISOString()
    const retire = failures >= MAX_FAILURES
    db.prepare('UPDATE notesq_schedules SET failures = ?, last_error = ?, last_period = ?, next_run_at = ?, enabled = ?, disabled_reason = ?, updated_at = ? WHERE id = ?')
      .run(failures, msg, previous_period, next, retire ? 0 : 1, retire ? `too many failures: ${msg}` : null, ts, id)
  }
  const out = db.prepare('SELECT * FROM notesq_schedules WHERE id = ?').get(id)
  return { ...out, enabled: !!out.enabled }
}
