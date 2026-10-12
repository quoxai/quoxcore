/**
 * Actions Service
 *
 * Server-first API with localStorage cache fallback for the Action Tracker plugin.
 * Actions are stored in the auth DB, scoped by org_id + scope_id.
 *
 * Both UI and agents (MCP tools) use this service via the collector proxy.
 *
 * Auth service endpoints (via nginx /api/orgs proxy):
 *   GET    /api/orgs/:orgId/actions         → list
 *   POST   /api/orgs/:orgId/actions         → create
 *   PATCH  /api/orgs/:orgId/actions/:id     → update
 *   DELETE /api/orgs/:orgId/actions/:id     → delete
 *   POST   /api/orgs/:orgId/actions/sync    → merge browser items into auth DB
 */

// ─── Constants ───────────────────────────────────────────────────────

import { logActionCreated, logActionMoved, logActionUpdated, logActionDeleted } from './actionAuditService'

// ACTIONQ-FIX-SPEC 1b: the cache key is built directly from the (orgId, userId)
// the caller supplies — NEVER from orgScopedStorage's mutable module-global
// context. A late response from a since-abandoned org (NEW-2) must not be able
// to write under a different org's key just because the global context moved
// on while the request was in flight. `orgId` falls back to a 'none' bucket
// for pre-auth/local-only work (deliberately quarantined from every real org).
const CACHE_VERSION = 2

export function getStorageKey(orgId, userId) {
  const org = encodeURIComponent(orgId || 'none')
  const user = encodeURIComponent(userId || 'default')
  return `quox:actions:v2:${org}:${user}`
}

export const COLUMNS = [
  { id: 'todo', label: 'TODO', className: 'column-todo' },
  { id: 'doing', label: 'DOING', className: 'column-doing' },
  { id: 'done', label: 'DONE', className: 'column-done' },
]

export const PRIORITIES = [
  { value: '', label: 'No priority' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

export const CONFETTI_COLORS = [
  '#22c55e', '#38bdf8', '#f59e0b', '#ef4444', '#a855f7',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
]

// Priority sort order (higher = more urgent)
const PRIORITY_ORDER = { urgent: 4, high: 3, medium: 2, low: 1 }

// ─── Seed Data ───────────────────────────────────────────────────────

function createSeedData() {
  const now = new Date().toISOString()
  return {
    items: [
      {
        id: crypto.randomUUID(),
        title: 'Get solicitor to review IP assignment deed',
        description: '',
        priority: 'high',
        category: 'legal',
        dueDate: null,
        status: 'todo',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        notes: '',
        order: 0,
        archivedAt: null,
        tags: [],
        assignedTo: null,
      },
      {
        id: crypto.randomUUID(),
        title: 'Submit SEIS/EIS advance assurance to HMRC',
        description: '',
        priority: 'high',
        category: 'financial',
        dueDate: null,
        status: 'todo',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        notes: '',
        order: 1,
        archivedAt: null,
        tags: [],
        assignedTo: null,
      },
      {
        id: crypto.randomUUID(),
        title: 'Share subdivision (1→10,000) — Companies House SH02',
        description: '',
        priority: 'medium',
        category: 'legal',
        dueDate: null,
        status: 'todo',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        notes: '',
        order: 2,
        archivedAt: null,
        tags: [],
        assignedTo: null,
      },
    ],
    streak: { current: 0, lastCompletionDate: null },
  }
}

// ─── Local Storage (offline cache) ──────────────────────────────────
//
// ACTIONQ-FIX-SPEC 1b: `recoverAllLocalItems` (the function that used to live
// here) scanned every localStorage key across every org for the same user and
// quietly imported whatever it found — a cross-org read turned into a
// cross-org WRITE the moment the (possibly empty, possibly filtered) result
// of a single org's GET was empty. That recovery path, and the "any failed
// GET returns it too" variant, are both removed outright rather than
// hardened: an empty/failed GET must mean exactly that. Pre-existing polluted
// caches under the legacy `actions-<userId>` / `quox_<org>_actions-<userId>`
// keys are left quarantined — unread by this file — not auto-migrated.

function emptyData() {
  return { items: [], streak: { current: 0, lastCompletionDate: null } }
}

function loadLocalData(orgId, userId) {
  try {
    const raw = localStorage.getItem(getStorageKey(orgId, userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Reject any envelope whose claimed identity/version doesn't match the
    // key we just read it under — defence in depth against any future
    // key-derivation drift re-opening the cross-identity hole.
    if (parsed.version !== CACHE_VERSION) return null
    if ((parsed.orgId || 'none') !== (orgId || 'none')) return null
    if ((parsed.userId || 'default') !== (userId || 'default')) return null
    return { items: Array.isArray(parsed.items) ? parsed.items : [], streak: parsed.streak || emptyData().streak }
  } catch { /* corrupt data, re-seed */ }
  return null
}

function saveLocalData(data, orgId, userId) {
  const envelope = {
    version: CACHE_VERSION,
    orgId: orgId || 'none',
    userId: userId || 'default',
    items: data.items || [],
    streak: data.streak || emptyData().streak,
    fetchedAt: new Date().toISOString(),
  }
  try {
    localStorage.setItem(getStorageKey(orgId, userId), JSON.stringify(envelope))
  } catch { /* storage full/unavailable — cache is best-effort */ }
}

function getLocalData(orgId, userId) {
  return loadLocalData(orgId, userId) || emptyData()
}

// ─── Server API helpers ─────────────────────────────────────────────

/**
 * Fetch from auth service (via nginx /api/orgs proxy).
 * Uses httpOnly cookies for auth (same as authFetch).
 */
async function authFetchJSON(path, options = {}) {
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
  const csrfToken = csrfMatch ? csrfMatch[1] : null

  const headers = { ...options.headers }
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken
  if (!headers['Content-Type'] && options.body) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers,
  })
  return res
}

/** Build the direct auth-service URL for actions */
function actionsUrl(orgId, suffix = '') {
  return `/api/orgs/${orgId}/actions${suffix}`
}

/**
 * Strict create (NotesQ send-tasks): POST /api/orgs/:orgId/actions with exactly
 * the given body, status checked before the body is trusted, NO local-cache
 * fallback (addAction() silently keeps a local-only item on failure, which would
 * lie about a task having reached Action-Q). Resolves to the server item.
 */
export async function createActionStrict(orgId, body) {
  if (!orgId) throw new ActionHttpError(null, 'no org selected')
  let res
  try {
    res = await authFetchJSON(actionsUrl(orgId), { method: 'POST', body: JSON.stringify(body) })
  } catch (err) {
    throw new ActionHttpError(null, err?.message || 'network error')
  }
  if (!res.ok) throw new ActionHttpError(res.status, await res.text().catch(() => ''))
  const data = await res.json().catch(() => null)
  if (!data || data.success === false || !data.item?.id) throw new ActionHttpError(res.status, JSON.stringify(data))
  return data.item
}

// ACTIONQ-FIX-SPEC 1c — server-authoritative mutations.
//
// A structured HTTP error: carries the status when available so callers can
// distinguish "visible but forbidden" (403) from "not found" (404) from a
// transient failure, rather than a single generic rejection.
export class ActionHttpError extends Error {
  constructor(status, diagnostic) {
    super(`Action request failed (${status ?? 'network'})`)
    this.name = 'ActionHttpError'
    this.status = status ?? null
    this.diagnostic = diagnostic || ''
  }
}

/**
 * Status-before-parse PATCH/DELETE helper for the mutation endpoints. Any
 * non-2xx, network failure, or malformed 200 body (success:false, missing
 * required fields, mismatched id) rejects — it is NEVER treated as a
 * successful write. Error bodies are read for diagnostics only, never
 * forwarded through success normalization.
 */
async function serverMutate(path, options, { expectItem = false, requireId = null } = {}) {
  let response
  try {
    response = await authFetchJSON(path, options)
  } catch (err) {
    throw new ActionHttpError(null, err?.message || 'network error')
  }

  if (!response.ok) {
    const diagnostic = await response.text().catch(() => '')
    throw new ActionHttpError(response.status, diagnostic)
  }

  const body = await response.json().catch(() => null)
  if (!body || body.success === false) {
    throw new ActionHttpError(response.status, JSON.stringify(body))
  }
  if (expectItem) {
    if (!body.item || !body.item.id) {
      throw new ActionHttpError(response.status, 'malformed response: missing item')
    }
    if (requireId && body.item.id !== requireId) {
      throw new ActionHttpError(response.status, 'malformed response: id mismatch')
    }
  }
  return body
}

// ─── Migration Helper ───────────────────────────────────────────────

export function migrateItem(item) {
  const migrated = { ...item }
  if (migrated.archivedAt === undefined) migrated.archivedAt = null
  if (migrated.tags === undefined) migrated.tags = []
  if (migrated.assignedTo === undefined) migrated.assignedTo = null
  return migrated
}

/**
 * Normalize a server item (snake_case) to client format (camelCase)
 */
function normalizeItem(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description || '',
    priority: item.priority || 'medium',
    category: item.category || '',
    dueDate: item.due_date || item.dueDate || null,
    status: item.status || 'todo',
    createdAt: item.created_at || item.createdAt || new Date().toISOString(),
    updatedAt: item.updated_at || item.updatedAt || new Date().toISOString(),
    completedAt: item.completed_at || item.completedAt || null,
    notes: item.notes || '',
    order: item.order || 0,
    archivedAt: item.archived_at || item.archivedAt || null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    assignedTo: item.assigned_to || item.assignedTo || null,
    source: item.source || 'user',
    sourceAgent: item.source_agent || item.sourceAgent || null,
    scopeId: item.scope_id || item.scopeId || null,
    scopeName: item.scope_name || item.scopeName || null,
    orgId: item.org_id || item.orgId || null,
    createdBy: item.created_by || item.createdBy || null,
    // ACTIONQ-FIX-SPEC 1a: explicit visibility ('private' | 'org' | 'scope').
    // Legacy rows the server backfilled have a real value from migration
    // 108, never undefined — default here is only a defensive fallback.
    visibility: item.visibility || (item.scope_id || item.scopeId ? 'scope' : 'private'),
  }
}

// ─── Pure Helpers (exported for tests) ───────────────────────────────

export function computeStats(items) {
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  const weekAgo = new Date(now)
  weekAgo.setDate(weekAgo.getDate() - 7)

  const total = items.length
  const done = items.filter(i => i.status === 'done').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const doneThisWeek = items.filter(i => {
    if (i.status !== 'done' || !i.completedAt) return false
    return new Date(i.completedAt) >= weekAgo
  }).length

  const overdue = items.filter(i => {
    if (i.status === 'done' || !i.dueDate) return false
    if (i.archivedAt) return false
    return i.dueDate < todayStr
  }).length

  const completedItems = items.filter(i => i.completedAt && i.createdAt)
  let avgDays = 0
  if (completedItems.length > 0) {
    const totalMs = completedItems.reduce((sum, i) => {
      return sum + (new Date(i.completedAt) - new Date(i.createdAt))
    }, 0)
    avgDays = Math.round(totalMs / completedItems.length / 86400000)
  }

  return { total, done, pct, doneThisWeek, overdue, avgDays }
}

export function moveItem(items, id, newStatus) {
  const now = new Date().toISOString()
  return items.map(item => {
    if (item.id !== id) return item
    const updated = { ...item, status: newStatus, updatedAt: now }
    if (newStatus === 'done') {
      updated.completedAt = now
    } else {
      updated.completedAt = null
    }
    return updated
  })
}

export function updateStreak(streak, completionDateStr) {
  if (!completionDateStr) return streak
  const dayStr = completionDateStr.slice(0, 10)

  if (!streak.lastCompletionDate) {
    return { current: 1, lastCompletionDate: dayStr }
  }

  if (dayStr === streak.lastCompletionDate) {
    return streak // same day, no change
  }

  const last = new Date(streak.lastCompletionDate + 'T00:00:00')
  const curr = new Date(dayStr + 'T00:00:00')
  const diffDays = Math.round((curr - last) / 86400000)

  if (diffDays === 1) {
    return { current: streak.current + 1, lastCompletionDate: dayStr }
  }

  // Gap — reset
  return { current: 1, lastCompletionDate: dayStr }
}

// ─── Filter / Sort / Archive Helpers ────────────────────────────────

export function filterItems(items, { search = '', priority = '', category = '', showArchived = false } = {}) {
  return items.filter(item => {
    // Archive filter
    if (!showArchived && item.archivedAt) return false

    // Search filter (title, description, notes)
    if (search) {
      const q = search.toLowerCase()
      const matchesTitle = item.title?.toLowerCase().includes(q)
      const matchesDesc = item.description?.toLowerCase().includes(q)
      const matchesNotes = item.notes?.toLowerCase().includes(q)
      if (!matchesTitle && !matchesDesc && !matchesNotes) return false
    }

    // Priority filter
    if (priority && (item.priority || '') !== priority) return false

    // Category filter
    if (category && (item.category || '') !== category) return false

    return true
  })
}

export function sortItems(items, sortKey = 'newest') {
  const sorted = [...items]
  switch (sortKey) {
    case 'oldest':
      return sorted.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    case 'priority': {
      return sorted.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority] || 0
        const pb = PRIORITY_ORDER[b.priority] || 0
        return pb - pa // higher priority first
      })
    }
    case 'due-date':
      return sorted.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return a.dueDate.localeCompare(b.dueDate)
      })
    case 'newest':
    default:
      return sorted.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }
}

export function autoArchiveItems(items, days = 7) {
  const now = new Date()
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  let changed = false

  const updated = items.map(item => {
    if (item.status !== 'done' || item.archivedAt) return item
    if (!item.completedAt) return item
    if (new Date(item.completedAt) < cutoff) {
      changed = true
      return { ...item, archivedAt: now.toISOString() }
    }
    return item
  })

  return { items: updated, changed }
}

export function getOverdueCount(items) {
  const todayStr = new Date().toISOString().slice(0, 10)
  return items.filter(i => {
    if (i.status === 'done' || !i.dueDate) return false
    if (i.archivedAt) return false
    return i.dueDate < todayStr
  }).length
}

export function getUniqueCategories(items) {
  const cats = new Set()
  for (const item of items) {
    if (item.category && item.category.trim()) {
      cats.add(item.category.trim())
    }
  }
  return [...cats].sort()
}

// ─── Public API (server-first with localStorage fallback) ───────────

/**
 * Load actions from server. The server is the ONLY source of truth for this
 * call — a failed or empty GET is never silently backfilled from a cache
 * that might belong to a different org/user (ACTIONQ-FIX-SPEC 1b). Callers
 * must catch rejection and show an explicit "unavailable, retry" state
 * rather than falling back to stale/foreign data themselves.
 * @param {string} userId
 * @param {object} opts - { orgId, scopeId, status, assignedTo }
 * @returns {Promise<Array>}
 */
export async function getActions(userId, opts = {}) {
  const { orgId, scopeId, status, assignedTo } = opts

  // No pre-auth/default-user hydration — nothing is authoritative yet.
  if (!orgId) {
    return []
  }

  // ACTIONQ-FIX-SPEC 1d: the server caps each page at 100 — a single
  // `limit=200` request silently clamped to 100 and made item 101+
  // permanently unreachable from the browser. Traverse every page the
  // server reports via `pagination.has_more`, preserving all filters. A
  // failure on ANY page rejects the whole call rather than returning a
  // partial board labelled complete.
  const items = []
  let page = 1
  // Safety bound: a pathological total_pages (bug or malicious response)
  // must not spin forever.
  const MAX_PAGES = 1000
  for (; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams()
    if (scopeId) query.set('scope_id', scopeId)
    if (status && status !== 'all') query.set('status', status)
    if (assignedTo) query.set('assigned_to', assignedTo)
    query.set('limit', '100')
    query.set('page', String(page))

    const res = await authFetchJSON(`${actionsUrl(orgId)}?${query.toString()}`)

    // Status-before-parse: any non-2xx (including 401/403) must never fall
    // back to a cached board — a stale cache can belong to a different
    // identity entirely. Propagate the failure; the caller shows "unavailable".
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`)
    }

    const data = await res.json()
    items.push(...(data.items || []).map(normalizeItem))

    if (!data.pagination?.has_more) break
  }

  // Cache the authoritative result under THIS exact (orgId, userId) — never
  // the mutable global storage context, which may have moved on by the time
  // this response arrives (NEW-2 late-response race).
  const localData = getLocalData(orgId, userId)
  saveLocalData({ items, streak: localData.streak }, orgId, userId)

  return items
}

/**
 * Add a new action item via server.
 */
export async function addAction(title, opts = {}, userId, orgId) {
  // Optimistic local add
  const localData = getLocalData(orgId, userId)
  const now = new Date().toISOString()
  const localItem = {
    id: crypto.randomUUID(),
    title,
    description: opts.description || '',
    priority: opts.priority || null,
    category: opts.category || '',
    dueDate: opts.dueDate || null,
    status: 'todo',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    notes: opts.notes || '',
    order: localData.items.filter(i => i.status === 'todo').length,
    archivedAt: null,
    tags: [],
    assignedTo: null,
    scopeId: opts.scopeId || null,
    scopeName: opts.scopeName || null,
  }
  localData.items.push(localItem)
  saveLocalData(localData, orgId, userId)

  // If no org context, just return the local item
  if (!orgId) {
    logActionCreated(localItem, userId)
    return localItem
  }

  // Server create via direct POST
  try {
    const res = await authFetchJSON(actionsUrl(orgId), {
      method: 'POST',

      body: JSON.stringify({
        title: localItem.title,
        description: localItem.description,
        priority: localItem.priority,
        category: localItem.category,
        due_date: localItem.dueDate,
        status: localItem.status,
        notes: localItem.notes,
        order: localItem.order,
        scope_id: localItem.scopeId || null,
        scope_name: localItem.scopeName || null,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.item) {
        const serverItem = normalizeItem(data.item)
        // Replace local optimistic item with server-authoritative one
        localData.items = localData.items.map(i => i.id === localItem.id ? serverItem : i)
        saveLocalData(localData, orgId, userId)
        logActionCreated(serverItem, userId)
        return serverItem
      }
    }
  } catch (err) {
    console.warn('[ActionsService] Server add failed, local only:', err.message)
  }

  logActionCreated(localItem, userId)
  return localItem
}

/**
 * Move an action to a new status. ACTIONQ-FIX-SPEC 1c: when an org context
 * exists, this is server-authoritative — the server is awaited BEFORE the
 * canonical cache (and therefore any "done" celebration) is committed. A
 * non-2xx, network failure, or malformed success body REJECTS; it is never
 * silently treated as a successful completion. A missing LOCAL cache entry
 * does not suppress the request — the server, not the cache, is the
 * authority on whether the item exists and can be moved.
 */
export async function moveAction(id, newStatus, userId, orgId) {
  if (orgId) {
    const now = new Date().toISOString()
    const body = { status: newStatus, updated_at: now, completed_at: newStatus === 'done' ? now : null }

    const result = await serverMutate(actionsUrl(orgId, `/${id}`), { method: 'PATCH', body: JSON.stringify(body) }, { expectItem: true, requireId: id })

    const serverItem = normalizeItem(result.item)
    const data = getLocalData(orgId, userId)
    const prior = data.items.find(i => i.id === id)
    const oldStatus = prior ? prior.status : null
    data.items = data.items.some(i => i.id === id)
      ? data.items.map(i => i.id === id ? serverItem : i)
      : [...data.items, serverItem]

    if (result.streak) {
      data.streak = {
        current: result.streak.current,
        best: result.streak.best,
        lastCompletionDate: result.streak.lastCompletionDate,
      }
    }
    saveLocalData(data, orgId, userId)
    logActionMoved(serverItem, oldStatus, newStatus, userId)
    return result.streak ? { ...serverItem, _streak: data.streak, _oldStatus: oldStatus } : { ...serverItem, _oldStatus: oldStatus }
  }

  // Local-only (no org context) — unchanged offline behavior.
  const data = getLocalData(orgId, userId)
  const item = data.items.find(i => i.id === id)
  if (!item || item.status === newStatus) return null

  const oldStatus = item.status
  data.items = moveItem(data.items, id, newStatus)

  if (newStatus === 'done') {
    const movedItem = data.items.find(i => i.id === id)
    data.streak = updateStreak(data.streak, movedItem.completedAt)
  }

  saveLocalData(data, orgId, userId)
  const movedItem = data.items.find(i => i.id === id)
  logActionMoved(movedItem, oldStatus, newStatus, userId)
  return { ...movedItem, _oldStatus: oldStatus }
}

/**
 * Fetch the user's completion streak from the server (ACT-STREAK).
 * Returns { current, best, lastCompletionDate }. Falls back to local cache
 * shape if the server can't be reached.
 */
export async function fetchStreak(userId, orgId) {
  if (!orgId) return getLocalData(orgId, userId).streak || { current: 0, lastCompletionDate: null }
  try {
    const res = await authFetchJSON(`/api/orgs/${orgId}/streak`)
    if (res.ok) {
      const data = await res.json()
      if (data.success && data.streak) return data.streak
    }
  } catch (err) {
    console.warn('[ActionsService] Streak fetch failed, using cache:', err.message)
  }
  return getLocalData(orgId, userId).streak || { current: 0, lastCompletionDate: null }
}

/**
 * Delete an action. ACTIONQ-FIX-SPEC 1c: with an org context, resolves only
 * on a confirmed `{success:true, deleted:true}` — any non-2xx, network
 * failure, or malformed body rejects and the cached item is retained.
 */
export async function deleteAction(id, userId, orgId) {
  if (orgId) {
    const data = getLocalData(orgId, userId)
    const item = data.items.find(i => i.id === id)

    const result = await serverMutate(actionsUrl(orgId, `/${id}`), { method: 'DELETE' })
    if (!result.deleted) {
      throw new ActionHttpError(null, 'malformed response: missing deleted:true')
    }

    data.items = data.items.filter(i => i.id !== id)
    saveLocalData(data, orgId, userId)
    if (item) logActionDeleted(item, userId)
    return item || { id, title: result.title }
  }

  // Local-only (no org context) — unchanged offline behavior.
  const data = getLocalData(orgId, userId)
  const item = data.items.find(i => i.id === id)
  if (!item) return null

  data.items = data.items.filter(i => i.id !== id)
  saveLocalData(data, orgId, userId)
  logActionDeleted(item, userId)
  return item
}

/**
 * Update an action's fields. ACTIONQ-FIX-SPEC 1c: with an org context, the
 * canonical cache is only committed AFTER the server confirms — a non-2xx,
 * network failure, or malformed body rejects and the cache is left
 * untouched (the caller/UI is responsible for keeping its own optimistic
 * state reversible on rejection).
 */
export async function updateAction(id, updates, userId, orgId) {
  if (orgId) {
    const now = new Date().toISOString()
    const snakeUpdates = {}
    if (updates.title !== undefined) snakeUpdates.title = updates.title
    if (updates.description !== undefined) snakeUpdates.description = updates.description
    if (updates.priority !== undefined) snakeUpdates.priority = updates.priority
    if (updates.category !== undefined) snakeUpdates.category = updates.category
    if (updates.dueDate !== undefined) snakeUpdates.due_date = updates.dueDate
    if (updates.notes !== undefined) snakeUpdates.notes = updates.notes
    if (updates.status !== undefined) snakeUpdates.status = updates.status
    if (updates.order !== undefined) snakeUpdates.order = updates.order
    if (updates.scopeId !== undefined) snakeUpdates.scope_id = updates.scopeId
    if (updates.scopeName !== undefined) snakeUpdates.scope_name = updates.scopeName
    if (updates.tags !== undefined) snakeUpdates.tags = updates.tags
    snakeUpdates.updated_at = now

    const result = await serverMutate(actionsUrl(orgId, `/${id}`), { method: 'PATCH', body: JSON.stringify(snakeUpdates) }, { expectItem: true, requireId: id })

    const serverItem = normalizeItem(result.item)
    const data = getLocalData(orgId, userId)
    data.items = data.items.some(i => i.id === id)
      ? data.items.map(i => i.id === id ? serverItem : i)
      : [...data.items, serverItem]
    saveLocalData(data, orgId, userId)
    logActionUpdated(serverItem, Object.keys(updates), userId)
    return serverItem
  }

  // Local-only (no org context) — unchanged offline behavior.
  const data = getLocalData(orgId, userId)
  const now = new Date().toISOString()
  let found = null
  data.items = data.items.map(item => {
    if (item.id !== id) return item
    found = { ...item, ...updates, updatedAt: now, id: item.id }
    return found
  })
  if (!found) return null
  saveLocalData(data, orgId, userId)
  logActionUpdated(found, Object.keys(updates), userId)
  return found
}

export function getActionStats(userId, orgId) {
  const data = getLocalData(orgId, userId)
  return computeStats(data.items)
}

export function getStreak(userId, orgId) {
  return getLocalData(orgId, userId).streak
}

export function getFullData(userId, orgId) {
  return getLocalData(orgId, userId)
}

export function saveFullData(data, userId, orgId) {
  saveLocalData(data, orgId, userId)
}

// ─── Server Sync ────────────────────────────────────────────────────

/**
 * Sync browser localStorage items with server (auth DB via collector proxy).
 * Server may have AI-created items that the browser doesn't know about.
 * This also handles one-time migration of localStorage items to the DB.
 * @param {string} userId
 * @param {string} orgId - Current org ID (required for server sync)
 * @returns {Promise<{synced: boolean, newFromServer: number}>}
 */
export async function syncWithServer(userId, orgId) {
  // Without orgId, cannot sync to server
  if (!orgId) return { synced: false, newFromServer: 0 }

  try {
    const localData = getLocalData(orgId, userId)
    const res = await authFetchJSON(actionsUrl(orgId, '/sync'), {
      method: 'POST',
      body: JSON.stringify({ items: localData.items }),
    })

    if (!res.ok) {
      console.warn('[ActionsService] Server sync failed:', res.status)
      return { synced: false, newFromServer: 0 }
    }

    const result = await res.json()
    if (!result.success || !Array.isArray(result.items)) {
      return { synced: false, newFromServer: 0 }
    }

    // Normalize server items
    const serverItems = result.items.map(normalizeItem)

    // Count items that came from server that weren't in local
    const localIds = new Set(localData.items.map(i => i.id))
    const newFromServer = serverItems.filter(i => !localIds.has(i.id)).length

    // Save merged result to localStorage (preserving streak)
    saveLocalData({ items: serverItems, streak: localData.streak }, orgId, userId)

    return { synced: true, newFromServer }
  } catch (err) {
    console.warn('[ActionsService] Server sync error:', err.message)
    return { synced: false, newFromServer: 0 }
  }
}
