/**
 * QuoxMind wisdom hygiene — QUOXMIND #1112.
 *
 * Keeps what feeds prompts small, fresh and real:
 *   - isEventLogWisdom: plugin event logs (ContactsQ/NotesQ outcome counters)
 *     are recorded to the wisdom table by their writers but are not planning
 *     lessons. They never feed the advisory, recall search or predict counts.
 *     They are NOT retired: writers look up active rows, so retiring them
 *     would only churn fresh duplicates.
 *   - retireWisdom: stale never-corroborated singletons and duplicate active
 *     rows of one pattern retire durably (active = 0 + reason). Never DELETE.
 *   - decayWisdom: 0.1 confidence per 30 days unseen beyond staleDays; below
 *     0.2 retires as 'decayed'.
 *   - retireOrphanedTasks: pending tasks under a terminal objective can never
 *     run; cancel them after a grace window.
 *   - rankWisdom: fresh-first, de-duplicated, char-budgeted advisory feed.
 *
 * User-confirmed rows (confidence >= 1.0, set only by confirmWisdom) and
 * user-authored rows (category 'user' or tag 'user') are never touched.
 */

export const EVENT_LOG_CATEGORIES = Object.freeze(['contactsq', 'notesq'])

/** SQL fragment excluding event-log rows (pattern names with 2+ colons are event keys). */
export const NOT_EVENT_LOG_SQL = `category NOT IN (${EVENT_LOG_CATEGORIES.map((c) => `'${c}'`).join(', ')}) AND pattern_name NOT LIKE '%:%:%'`

const USER_GUARD_SQL = `confidence < 1.0 AND category != 'user' AND COALESCE(tags, '') NOT LIKE '%"user"%'`

export function isEventLogWisdom(w) {
  if (!w) return false
  if (EVENT_LOG_CATEGORIES.includes(w.category)) return true
  return (String(w.pattern_name || '').match(/:/g) || []).length >= 2
}

/**
 * Retire stale singletons and duplicates. Bounded by `batch` per reason.
 * @returns {{ staleSingleton: number, duplicate: number }}
 */
export function retireWisdom(db, { staleDays = 90, batch = 500, dryRun = false } = {}) {
  const staleIds = db.prepare(`
    SELECT id FROM execution_wisdom
    WHERE active = 1 AND occurrence_count <= 1
      AND last_seen_at < datetime('now', ?)
      AND ${USER_GUARD_SQL} AND ${NOT_EVENT_LOG_SQL}
    ORDER BY last_seen_at ASC LIMIT ?
  `).all(`-${staleDays} days`, batch).map((r) => r.id)

  // Duplicates: more than one active row for (org_id, pattern_name). Keep the
  // strongest (occurrence, then confidence, then most recent); retire the rest.
  const dupIds = db.prepare(`
    SELECT id FROM (
      SELECT id, confidence, category, tags, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(org_id, ''), pattern_name
        ORDER BY occurrence_count DESC, confidence DESC, last_seen_at DESC
      ) AS rn
      FROM execution_wisdom WHERE active = 1
    ) WHERE rn > 1 AND ${USER_GUARD_SQL} LIMIT ?
  `).all(batch).map((r) => r.id)

  if (dryRun) return { staleSingleton: staleIds.length, duplicate: dupIds.length }

  const retire = db.prepare(`
    UPDATE execution_wisdom SET active = 0, retired_at = datetime('now'), retired_reason = ?, updated_at = datetime('now')
    WHERE id = ? AND active = 1
  `)
  let staleSingleton = 0
  let duplicate = 0
  db.transaction(() => {
    for (const id of staleIds) staleSingleton += retire.run('stale_singleton', id).changes
    for (const id of dupIds) duplicate += retire.run('duplicate', id).changes
  })()
  return { staleSingleton, duplicate }
}

/**
 * Decay stale wisdom by 0.1, at most once per `everyDays` per row (updated_at
 * marks the last decay or sighting). Rows falling below 0.2 retire as 'decayed'.
 * @returns {number} rows decayed
 */
export function decayWisdom(db, { staleDays = 90, everyDays = 30, batch = 500, dryRun = false } = {}) {
  const rows = db.prepare(`
    SELECT id, confidence FROM execution_wisdom
    WHERE active = 1 AND last_seen_at < datetime('now', ?) AND updated_at < datetime('now', ?)
      AND ${USER_GUARD_SQL}
    LIMIT ?
  `).all(`-${staleDays} days`, `-${everyDays} days`, batch)
  if (dryRun) return rows.length
  const upd = db.prepare(`UPDATE execution_wisdom SET confidence = ?, updated_at = datetime('now') WHERE id = ?`)
  const ret = db.prepare(`UPDATE execution_wisdom SET active = 0, retired_at = datetime('now'), retired_reason = 'decayed' WHERE id = ?`)
  db.transaction(() => {
    for (const r of rows) {
      const next = Math.max(0.1, Math.round((r.confidence - 0.1) * 100) / 100)
      upd.run(next, r.id)
      if (next < 0.2) ret.run(r.id)
    }
  })()
  return rows.length
}

/**
 * Cancel pending tasks whose objective reached a terminal status more than
 * `graceMinutes` ago. Pending to cancelled is a legal task transition.
 * @returns {number} tasks cancelled
 */
export function retireOrphanedTasks(db, { graceMinutes = 60, batch = 500, dryRun = false } = {}) {
  const ids = db.prepare(`
    SELECT t.id FROM tasks t JOIN objectives o ON o.id = t.objective_id
    WHERE t.status = 'pending'
      AND o.status IN ('completed', 'completed_with_errors', 'failed', 'cancelled')
      AND COALESCE(o.completed_at, o.started_at, o.created_at) < datetime('now', ?)
    LIMIT ?
  `).all(`-${graceMinutes} minutes`, batch).map((r) => r.id)
  if (dryRun) return ids.length
  const upd = db.prepare(`
    UPDATE tasks SET status = 'cancelled', completed_at = datetime('now'),
      result = COALESCE(result, 'Retired: objective reached a terminal status before this task ran.')
    WHERE id = ? AND status = 'pending'
  `)
  let n = 0
  db.transaction(() => { for (const id of ids) n += upd.run(id).changes })()
  return n
}

function ageDays(ts, now) {
  if (!ts) return 365
  const t = Date.parse(String(ts).includes('T') ? ts : `${String(ts).replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : 365
}

/** 1.0 within 30 days of last sighting, sliding to 0.5 over the following year. */
export function freshness(lastSeenAt, now = Date.now()) {
  const d = ageDays(lastSeenAt, now)
  return d <= 30 ? 1 : Math.max(0.5, 1 - (d - 30) / 730)
}

/**
 * Rank candidates for prompt injection: drop event logs, keep one row per
 * pattern (org-scoped beats global), drop near-identical lessons, order by
 * relevance then confidence x freshness, and stop at `limit` items or
 * `charBudget` characters of lesson + directive.
 */
export function rankWisdom(rows, { orgId, limit = 5, charBudget = 1500, now = Date.now() } = {}) {
  const scored = rows
    .filter((w) => !isEventLogWisdom(w))
    .map((w) => ({ w, score: (w.confidence || 0) * freshness(w.last_seen_at, now), own: w.org_id === orgId ? 1 : 0 }))
    .sort((a, b) => (b.w.relevance_score || 0) - (a.w.relevance_score || 0) || b.own - a.own || b.score - a.score)

  const seenPattern = new Set()
  const seenLesson = new Set()
  const out = []
  let used = 0
  for (const { w } of scored) {
    if (out.length >= limit) break
    const lessonKey = String(w.lesson || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)
    if (seenPattern.has(w.pattern_name) || (lessonKey && seenLesson.has(lessonKey))) continue
    const cost = String(w.lesson || '').length + String(w.decomposition_directive || '').length
    if (used + cost > charBudget) continue
    seenPattern.add(w.pattern_name)
    if (lessonKey) seenLesson.add(lessonKey)
    used += cost
    out.push(w)
  }
  return out
}

const STOPWORDS = new Set(['with', 'from', 'that', 'this', 'into', 'across', 'about', 'their', 'there', 'then', 'than', 'have', 'will', 'should', 'would', 'could', 'please', 'each', 'every', 'them', 'what', 'when', 'where', 'which', 'your', 'make', 'sure'])

/** Keywords for LIKE matching: lowercased, punctuation stripped, stopwords and short words dropped. */
export function keywords(text, max = 8) {
  const seen = new Set()
  for (const raw of String(text || '').toLowerCase().split(/\s+/)) {
    const w = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    if (w.length > 3 && !STOPWORDS.has(w)) seen.add(w)
    if (seen.size >= max) break
  }
  return [...seen]
}

/** Record that the advisory injected these rows into a prompt. Fail-soft. */
export function markInjected(db, ids) {
  if (!ids || ids.length === 0) return 0
  try {
    const upd = db.prepare(`UPDATE execution_wisdom SET injected_count = COALESCE(injected_count, 0) + 1, last_injected_at = datetime('now') WHERE id = ?`)
    let n = 0
    db.transaction(() => { for (const id of ids) n += upd.run(id).changes })()
    return n
  } catch (err) {
    console.warn(`[QuoxMind] markInjected failed (non-fatal): ${err.message}`)
    return 0
  }
}
