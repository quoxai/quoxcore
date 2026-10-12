// topicSubscriptions.js - ONE-BRAIN CX6 store + routes for "tell my slot when
// new notes about X land". Org and user come from auth only, never the body.
// The collector scheduler uses the service-only /internal/subscriptions/*
// routes to list active rows and to record each tick's outcome.
import crypto from 'crypto'
import { getDatabase } from './db.js'

export const MAX_NOTIFIED_IDS = 200
export const MAX_CONSECUTIVE_FAILURES = 10
const MAX_QUERY = 300
const SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const shape = (r) => r && ({
  id: r.id, orgId: r.org_id, userId: r.user_id, query: r.query, slot: r.slot,
  createdAt: r.created_at, lastCheckedAt: r.last_checked_at,
  lastNotifiedNoteIds: JSON.parse(r.last_notified_note_ids || '[]'),
  consecutiveFailures: r.consecutive_failures, disabledAt: r.disabled_at, disabledReason: r.disabled_reason,
})

export function addSubscription({ orgId, userId, query, slot }) {
  const q = typeof query === 'string' ? query.trim() : ''
  const s = typeof slot === 'string' ? slot.trim() : ''
  if (!q || q.length > MAX_QUERY) { const e = new Error('bad_query'); e.code = 'bad_query'; throw e }
  if (!SLOT_RE.test(s)) { const e = new Error('bad_slot'); e.code = 'bad_slot'; throw e }
  const db = getDatabase()
  const existing = db.prepare('SELECT * FROM topic_subscriptions WHERE org_id = ? AND user_id = ? AND query = ? AND slot = ?').get(orgId, userId, q, s)
  if (existing) {
    // Re-subscribing revives a disabled row (fresh start, silent first tick).
    if (existing.disabled_at) {
      db.prepare('UPDATE topic_subscriptions SET disabled_at = NULL, disabled_reason = NULL, consecutive_failures = 0, last_checked_at = NULL WHERE id = ?').run(existing.id)
      return { ...shape(db.prepare('SELECT * FROM topic_subscriptions WHERE id = ?').get(existing.id)), created: false, revived: true }
    }
    return { ...shape(existing), created: false }
  }
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO topic_subscriptions (id, org_id, user_id, query, slot, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, orgId, userId, q, s, new Date().toISOString())
  return { ...shape(db.prepare('SELECT * FROM topic_subscriptions WHERE id = ?').get(id)), created: true }
}

/** userId given -> own rows only; null -> the whole org (service callers). */
export function listSubscriptions(orgId, { userId = null } = {}) {
  const db = getDatabase()
  const rows = userId
    ? db.prepare('SELECT * FROM topic_subscriptions WHERE org_id = ? AND user_id = ? ORDER BY created_at, rowid').all(orgId, userId)
    : db.prepare('SELECT * FROM topic_subscriptions WHERE org_id = ? ORDER BY created_at, rowid').all(orgId)
  return rows.map(shape)
}

export function deleteSubscription(orgId, id, { userId = null } = {}) {
  const db = getDatabase()
  const r = userId
    ? db.prepare('DELETE FROM topic_subscriptions WHERE id = ? AND org_id = ? AND user_id = ?').run(id, orgId, userId)
    : db.prepare('DELETE FROM topic_subscriptions WHERE id = ? AND org_id = ?').run(id, orgId)
  return r.changes > 0
}

/** Every enabled subscription in every org (scheduler, service-only). */
export function listActiveSubscriptions() {
  return getDatabase().prepare('SELECT * FROM topic_subscriptions WHERE disabled_at IS NULL ORDER BY created_at, rowid').all().map(shape)
}

/**
 * Record one tick's outcome for a subscription.
 *  ok=true : failures reset, last_checked_at advances to checkedAt, notified
 *            ids (if any) are appended and the list trimmed to the last 200.
 *  ok=false: consecutive_failures++; at MAX_CONSECUTIVE_FAILURES the row is
 *            disabled durably with the reason. last_checked_at does NOT move,
 *            so the window is retried, not skipped.
 */
export function recordResult(id, { ok, checkedAt, noteIds = [], error = null } = {}) {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM topic_subscriptions WHERE id = ?').get(id)
  if (!row) return null
  if (ok) {
    const prior = JSON.parse(row.last_notified_note_ids || '[]')
    const merged = [...prior, ...noteIds.filter((n) => typeof n === 'string' && !prior.includes(n))].slice(-MAX_NOTIFIED_IDS)
    db.prepare('UPDATE topic_subscriptions SET consecutive_failures = 0, last_checked_at = ?, last_notified_note_ids = ? WHERE id = ?')
      .run(typeof checkedAt === 'string' && checkedAt ? checkedAt : new Date().toISOString(), JSON.stringify(merged), id)
  } else {
    const failures = row.consecutive_failures + 1
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      db.prepare('UPDATE topic_subscriptions SET consecutive_failures = ?, disabled_at = ?, disabled_reason = ? WHERE id = ?')
        .run(failures, new Date().toISOString(), `disabled after ${failures} consecutive failures: ${String(error || 'unknown error').slice(0, 300)}`, id)
    } else {
      db.prepare('UPDATE topic_subscriptions SET consecutive_failures = ? WHERE id = ?').run(failures, id)
    }
  }
  return shape(db.prepare('SELECT * FROM topic_subscriptions WHERE id = ?').get(id))
}

export function registerSubscriptionRoutes(app, { authenticate } = {}) {
  const needUser = (req, res) => {
    if (!req.org_id || !req.user_id || (req.service && req.user_id === 'service')) {
      res.status(400).json({ error: 'user context required' }); return false
    }
    return true
  }
  const serviceOnly = (req, res) => {
    if (!req.service) { res.status(403).json({ error: 'service key required' }); return false }
    return true
  }
  const fail = (res, e, what) => {
    if (e.code === 'bad_query' || e.code === 'bad_slot') return res.status(400).json({ error: e.code })
    console.error(`[Brain] subscriptions ${what} error:`, e)
    return res.status(500).json({ error: 'internal_error' })
  }

  app.post('/brain/subscriptions', authenticate, (req, res) => {
    if (!needUser(req, res)) return
    try {
      const { created, revived, ...subscription } = addSubscription({ orgId: req.org_id, userId: req.user_id, query: req.body?.query, slot: req.body?.slot })
      res.status(created ? 201 : 200).json({ subscription, created, ...(revived ? { revived } : {}) })
    } catch (e) { fail(res, e, 'create') }
  })
  app.get('/brain/subscriptions', authenticate, (req, res) => {
    try {
      // A service caller with a real X-User-Id still sees the whole org.
      res.json({ subscriptions: listSubscriptions(req.org_id, { userId: req.service ? null : req.user_id }) })
    } catch (e) { fail(res, e, 'list') }
  })
  app.delete('/brain/subscriptions/:id', authenticate, (req, res) => {
    try {
      const ok = deleteSubscription(req.org_id, req.params.id, { userId: req.service ? null : (req.user_id || '\u0000none') })
      if (!ok) return res.status(404).json({ error: 'Subscription not found' })
      res.json({ deleted: true })
    } catch (e) { fail(res, e, 'delete') }
  })

  // Scheduler-only (service key). Cross-org by design: one tick serves all orgs.
  app.get('/internal/subscriptions/active', authenticate, (req, res) => {
    if (!serviceOnly(req, res)) return
    try { res.json({ subscriptions: listActiveSubscriptions() }) } catch (e) { fail(res, e, 'active') }
  })
  app.post('/internal/subscriptions/:id/result', authenticate, (req, res) => {
    if (!serviceOnly(req, res)) return
    try {
      const b = req.body || {}
      const row = recordResult(req.params.id, { ok: b.ok === true, checkedAt: b.checkedAt, noteIds: Array.isArray(b.noteIds) ? b.noteIds : [], error: b.error })
      if (!row) return res.status(404).json({ error: 'Subscription not found' })
      res.json({ subscription: row })
    } catch (e) { fail(res, e, 'result') }
  })
}
