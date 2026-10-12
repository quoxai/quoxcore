// retractionOutbox.js: durable belief-retraction outbox (BRAIN2-W10 C).
// vaultStore.deleteNote enqueues a row in the same transaction as the note
// delete. drainTick calls the existing retractBeliefsForNote (provenance =
// source note id) and removes the row only on success. Scheduler triad:
// failures counted distinctly from empty, capped exponential backoff per row,
// durable retirement (retired_at, row kept) after MAX_ATTEMPTS with a loud log.

import { getDatabase } from './db.js'
import { retractBeliefsForNote } from './quoxDream.js'

export const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.QUOXBRAIN_RETRACT_MAX_ATTEMPTS || '8', 10) || 8)
export const BASE_BACKOFF_MS = 30_000
export const MAX_BACKOFF_MS = 30 * 60_000
export const IDLE_MS = 5 * 60_000
export const BUSY_MS = 5_000
export const DEFAULT_WARMUP_MS = 30_000

export function rowBackoffMs(attempts) {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts, 10))
}

export function isPermanentError(msg) {
  return /\bHTTP 4(?!08|29)\d\d\b/.test(String(msg || ''))
}

async function drainRow(db, row, { retract = retractBeliefsForNote, deps, now = Date.now(), maxAttempts = MAX_ATTEMPTS } = {}) {
  let ret
  try { ret = await retract(row.org_id, row.owner_user_id, row.note_id, { ...(deps || {}), before: row.deleted_at }) } catch (err) { ret = { retracted: 0, error: err.message } }
  if (!ret.error) {
    db.prepare('DELETE FROM belief_retraction_outbox WHERE note_id = ?').run(row.note_id)
    return { ok: true, retracted: ret.retracted }
  }
  const attempts = row.attempts + 1
  // Codex cycle 4: an outage is not a reason to stop forgetting. Only a
  // permanent rejection (a 4xx other than 408/429) retires a row; transient
  // failures keep retrying at the capped backoff until the service is back.
  if (attempts >= maxAttempts && isPermanentError(ret.error)) {
    db.prepare('UPDATE belief_retraction_outbox SET attempts = ?, last_error = ?, retired_at = ? WHERE note_id = ?')
      .run(attempts, ret.error, new Date(now).toISOString(), row.note_id)
    console.error(`[RetractionOutbox] RETIRED note ${row.note_id} (org ${row.org_id}) after ${attempts} attempts, derived beliefs may survive: ${ret.error}`)
    return { ok: false, retired: true, retracted: ret.retracted, error: ret.error }
  }
  db.prepare('UPDATE belief_retraction_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE note_id = ?')
    .run(attempts, ret.error, new Date(now + rowBackoffMs(attempts)).toISOString(), row.note_id)
  return { ok: false, retired: false, retracted: ret.retracted, error: ret.error }
}

/** Immediate attempt for one note (NotesQ delete path). Failure leaves the row. */
export async function drainNote(noteId, opts = {}) {
  const db = opts.db || getDatabase()
  const row = db.prepare('SELECT * FROM belief_retraction_outbox WHERE note_id = ?').get(noteId)
  if (!row) return { retracted: 0, error: null }
  const r = await drainRow(db, row, opts)
  if (r.error) console.error(`[NotesQ] belief retraction failed for deleted note ${noteId}, queued for retry: ${r.error}`)
  return { retracted: r.retracted || 0, error: r.error || null }
}

/** One scheduled pass over due, non-retired rows. */
export async function drainTick(opts = {}) {
  const db = opts.db || getDatabase()
  const now = opts.now ?? Date.now()
  const batch = opts.batch || 25
  const rows = db.prepare('SELECT * FROM belief_retraction_outbox WHERE retired_at IS NULL AND next_attempt_at <= ? ORDER BY queued_at LIMIT ?')
    .all(new Date(now).toISOString(), batch)
  const out = { drained: 0, failed: 0, retired: 0, retracted: 0, due: rows.length, pending: 0, error: null }
  for (const row of rows) {
    const r = await drainRow(db, row, { ...opts, now })
    if (r.ok) { out.drained += 1; out.retracted += r.retracted }
    else { out.failed += 1; out.error = r.error; if (r.retired) out.retired += 1 }
  }
  out.pending = db.prepare('SELECT COUNT(*) c FROM belief_retraction_outbox WHERE retired_at IS NULL').get().c
  return out
}

export function nextDelay({ result, streak }) {
  if (result.error || result.failed > 0) return Math.min(MAX_BACKOFF_MS, BUSY_MS * 2 ** Math.min(streak, 10))
  return result.due >= 25 ? BUSY_MS : IDLE_MS
}

export function startRetractionScheduler(deps = {}) {
  const tick = deps.drainTick || drainTick
  const setTimeoutFn = deps.setTimeoutFn || setTimeout
  let streak = 0
  let stopped = false
  const run = async () => {
    if (stopped) return
    let result
    try { result = await tick(deps.tickOpts || {}) } catch (err) { result = { drained: 0, failed: 0, retired: 0, due: 0, pending: 0, error: err.message } }
    streak = (result.error || result.failed > 0) ? streak + 1 : 0
    if (result.due > 0 || result.error) {
      console.log(`[RetractionOutbox] tick drained=${result.drained} failed=${result.failed} retired=${result.retired} pending=${result.pending}${result.error ? ` error=${result.error}` : ''} streak=${streak}`)
    }
    if (!stopped) setTimeoutFn(run, nextDelay({ result, streak })).unref?.()
  }
  const t = setTimeoutFn(run, deps.warmupMs ?? DEFAULT_WARMUP_MS)
  t?.unref?.()
  return { stop: () => { stopped = true } }
}
