/**
 * Server Sync Queue — Batched, Debounced, Retrying Preference Sync
 *
 * All localStorage writes that need server persistence go through this queue.
 * Changes are batched and synced in a single PATCH /api/auth/me call.
 *
 * Pattern:
 *   1. Service writes to localStorage (fast, synchronous)
 *   2. Service calls queueSync(namespace, data)
 *   3. Queue debounces (2s) and batches all pending namespaces
 *   4. Single PATCH request with merged preferences
 *   5. On failure: exponential backoff retry (3 attempts)
 *   6. On persistent failure: queued changes survive in localStorage
 *      and will be retried on next page load via flushOnLoad()
 *
 * This replaces the fire-and-forget pattern in userPreferences.syncPreferenceToServer().
 */

const AUTH_API = '/api/auth'
const DEBOUNCE_MS = 2000
const MAX_RETRIES = 3
const RETRY_BASE_MS = 1000
const PENDING_KEY = 'quox_sync_pending'

let debounceTimer = null
let pendingNamespaces = new Map() // namespace -> data
let syncing = false
let syncListeners = []
let hydrationComplete = false // gate: don't flush stale data before hydration

// Org-scoped sync (separate queue, separate endpoint)
// Each entry is stamped with the org that was active when it was queued
// ({ orgId, data }), so a retry can never silently send org A's config
// under org B just because the active session switched orgs (F05).
let orgDebounceTimer = null
let orgPendingNamespaces = new Map() // namespace -> { orgId, data }
let orgSyncing = false
let _currentOrgId = null
const ORG_PENDING_KEY = 'quox_org_sync_pending'

function isDevBypassEnabled() {
  return Boolean(
    import.meta.env.DEV
    && typeof window !== 'undefined'
    && window.localStorage?.getItem('quox_dev_bypass') === 'true'
  )
}

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
  return match ? match[1] : null
}

async function authGet(url) {
  const headers = {}
  const csrf = getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf
  const response = await fetch(url, { credentials: 'include', headers })
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`)
  return response.json()
}

async function authPatch(url, body) {
  const headers = { 'Content-Type': 'application/json' }
  const csrf = getCsrfToken()
  if (csrf) headers['X-CSRF-Token'] = csrf
  const response = await fetch(url, {
    method: 'PATCH',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`PATCH ${url} returned ${response.status}`)
  return response.json()
}

/**
 * Queue a namespace for server sync. Debounces and batches.
 * @param {string} namespace - Server preferences key (e.g., 'chatWorkspace', 'layout')
 * @param {*} data - Value to store under this namespace
 */
export function queueSync(namespace, data) {
  pendingNamespaces.set(namespace, data)
  persistPending()

  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(flushQueue, DEBOUNCE_MS)
}

/**
 * Persist pending changes to localStorage so they survive page refresh.
 */
function persistPending() {
  try {
    const obj = Object.fromEntries(pendingNamespaces)
    localStorage.setItem(PENDING_KEY, JSON.stringify(obj))
  } catch { /* quota */ }
}

/**
 * Load any pending changes that survived a page refresh.
 */
function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (raw) {
      const obj = JSON.parse(raw)
      for (const [ns, data] of Object.entries(obj)) {
        if (!pendingNamespaces.has(ns)) {
          pendingNamespaces.set(ns, data)
        }
      }
    }
  } catch { /* corrupt */ }
}

/**
 * Flush all pending changes to the server.
 * Uses read-modify-write to avoid clobbering other namespaces.
 * Retries with exponential backoff on failure.
 */
async function flushQueue(retryCount = 0) {
  if (syncing || pendingNamespaces.size === 0) return
  if (isDevBypassEnabled()) {
    console.log('[SyncQueue] Dev bypass active — keeping preference changes local only')
    pendingNamespaces.clear()
    try { localStorage.removeItem(PENDING_KEY) } catch { /* */ }
    return
  }
  // Don't push stale local data to server before hydration has pulled server state
  if (!hydrationComplete && retryCount === 0) {
    console.log('[SyncQueue] Waiting for hydration before flushing pending changes...')
    return
  }
  syncing = true

  // Snapshot and clear pending
  const batch = new Map(pendingNamespaces)
  pendingNamespaces.clear()

  try {
    // Read current server state
    const data = await authGet(`${AUTH_API}/me`)
    const currentPrefs = data?.user?.preferences || {}

    // Merge all pending namespaces
    const updated = { ...currentPrefs }
    // Namespaces that represent key-value maps need deep merge (server + local)
    // to avoid clobbering changes made on other devices
    const DEEP_MERGE_NAMESPACES = ['extensions', 'safetyState']
    for (const [ns, value] of batch) {
      if (DEEP_MERGE_NAMESPACES.includes(ns) && typeof value === 'object' && typeof currentPrefs[ns] === 'object') {
        updated[ns] = { ...currentPrefs[ns], ...value }
      } else {
        updated[ns] = value
      }
    }

    // Write back
    await authPatch(`${AUTH_API}/me`, { preferences: updated })

    // Clear persisted pending
    try { localStorage.removeItem(PENDING_KEY) } catch { /* */ }

    console.log(`[SyncQueue] Synced ${batch.size} namespace(s): ${[...batch.keys()].join(', ')}`)
    notifyListeners({ success: true, namespaces: [...batch.keys()] })
  } catch (err) {
    console.warn(`[SyncQueue] Sync failed (attempt ${retryCount + 1}/${MAX_RETRIES}):`, err.message)

    // Put failed items back
    for (const [ns, value] of batch) {
      pendingNamespaces.set(ns, value)
    }
    persistPending()

    if (retryCount < MAX_RETRIES - 1) {
      const delay = RETRY_BASE_MS * Math.pow(2, retryCount)
      setTimeout(() => {
        syncing = false
        flushQueue(retryCount + 1)
      }, delay)
      return
    }

    console.error(`[SyncQueue] Gave up after ${MAX_RETRIES} attempts. Changes saved locally, will retry on next page load.`)
    notifyListeners({ success: false, namespaces: [...batch.keys()], error: err.message })
  } finally {
    syncing = false
  }
}

// ============================================================================
// ORG-SCOPED SYNC
// ============================================================================

/**
 * Set the current org context for org-scoped sync.
 * Called by WorkspaceContext on org load/switch.
 */
export function setOrgSyncContext(orgId) {
  if (_currentOrgId !== orgId && orgPendingNamespaces.size > 0) {
    // Flush pending for previous org before switching
    flushOrgQueue()
  }
  _currentOrgId = orgId
}

/**
 * Queue an org-scoped namespace for server sync.
 * @param {string} namespace - Server preferences key
 * @param {*} data - Value to store
 */
export function queueOrgSync(namespace, data) {
  if (!_currentOrgId) {
    console.warn('[SyncQueue] No org context set, skipping org sync for:', namespace)
    return
  }
  // Stamp with the org active right now. This stamp travels with the item
  // through every retry, so a later flush can assert it's still being sent
  // under the same org it was created for (F05 fix — stamp-and-assert).
  orgPendingNamespaces.set(namespace, { orgId: _currentOrgId, data })
  persistOrgPending()

  clearTimeout(orgDebounceTimer)
  orgDebounceTimer = setTimeout(flushOrgQueue, DEBOUNCE_MS)
}

function persistOrgPending() {
  try {
    if (orgPendingNamespaces.size === 0) {
      localStorage.removeItem(ORG_PENDING_KEY)
      return
    }
    const obj = { namespaces: Object.fromEntries(orgPendingNamespaces) }
    localStorage.setItem(ORG_PENDING_KEY, JSON.stringify(obj))
  } catch { /* quota */ }
}

function loadOrgPending() {
  try {
    const raw = localStorage.getItem(ORG_PENDING_KEY)
    if (raw) {
      const obj = JSON.parse(raw)
      if (obj && obj.namespaces) {
        for (const [ns, entry] of Object.entries(obj.namespaces)) {
          // Ignore any pre-fix (unstamped) entries left over from an older
          // build — they have no orgId to assert against.
          if (!orgPendingNamespaces.has(ns) && entry && entry.orgId) {
            orgPendingNamespaces.set(ns, entry)
          }
        }
      }
    }
  } catch { /* corrupt */ }
}

async function flushOrgQueue(retryCount = 0) {
  if (orgSyncing || orgPendingNamespaces.size === 0 || !_currentOrgId) return
  if (isDevBypassEnabled()) {
    console.log('[SyncQueue] Dev bypass active — keeping org preference changes local only')
    orgPendingNamespaces.clear()
    try { localStorage.removeItem(ORG_PENDING_KEY) } catch { /* */ }
    return
  }

  // F05 assert: only items stamped for the CURRENTLY active org are eligible
  // to send right now. An item stamped for a different org (queued while that
  // org was active, still unsent when the session switched) is deferred —
  // left queued untouched — rather than sent under the wrong org.
  const matching = new Map()
  const deferred = new Map()
  for (const [ns, entry] of orgPendingNamespaces) {
    if (entry.orgId === _currentOrgId) {
      matching.set(ns, entry)
    } else {
      deferred.set(ns, entry)
    }
  }

  if (matching.size === 0) {
    if (deferred.size > 0) {
      console.log(`[SyncQueue] Deferring ${deferred.size} org namespace(s) stamped for a different org than the active one (${_currentOrgId}): ${[...deferred.keys()].join(', ')}`)
    }
    return
  }

  orgSyncing = true
  const orgId = _currentOrgId
  // Remove only the matching entries; deferred entries stay queued for later.
  for (const ns of matching.keys()) orgPendingNamespaces.delete(ns)
  persistOrgPending()

  try {
    const preferences = {}
    for (const [ns, entry] of matching) preferences[ns] = entry.data
    // Org routes mount at /api/orgs (services/auth/server.js:681), NOT under
    // /api/auth — this PATCH 404'd since it shipped and every org-preference
    // sync silently died after 3 retries (found live, LI-OVERHAUL P11).
    await authPatch(`/api/orgs/${orgId}/my-preferences`, { preferences })

    console.log(`[SyncQueue] Org-synced ${matching.size} namespace(s) to ${orgId}: ${[...matching.keys()].join(', ')}`)
    notifyListeners({ success: true, namespaces: [...matching.keys()], scope: 'org' })
  } catch (err) {
    console.warn(`[SyncQueue] Org sync failed (attempt ${retryCount + 1}/${MAX_RETRIES}):`, err.message)

    // Put failed items back (still stamped with their original org).
    for (const [ns, entry] of matching) {
      orgPendingNamespaces.set(ns, entry)
    }
    persistOrgPending()

    if (retryCount < MAX_RETRIES - 1) {
      const delay = RETRY_BASE_MS * Math.pow(2, retryCount)
      setTimeout(() => {
        orgSyncing = false
        flushOrgQueue(retryCount + 1)
      }, delay)
      return
    }

    console.error(`[SyncQueue] Org sync gave up after ${MAX_RETRIES} attempts.`)
    notifyListeners({ success: false, namespaces: [...matching.keys()], scope: 'org', error: err.message })
  } finally {
    orgSyncing = false
  }
}

/**
 * Force immediate org flush.
 */
export function flushOrgNow() {
  clearTimeout(orgDebounceTimer)
  return flushOrgQueue()
}

/**
 * Subscribe to sync events (for UI indicators).
 * @param {Function} listener - Called with { success, namespaces, error? }
 * @returns {Function} unsubscribe
 */
export function onSyncEvent(listener) {
  syncListeners.push(listener)
  return () => {
    syncListeners = syncListeners.filter(l => l !== listener)
  }
}

function notifyListeners(event) {
  for (const listener of syncListeners) {
    try { listener(event) } catch { /* */ }
  }
}

/**
 * Signal that server hydration is complete and it's safe to flush pending changes.
 * Called from AuthContext/userPreferences after hydrateFromServer finishes.
 */
export function markHydrated() {
  hydrationComplete = true
  console.log('[SyncQueue] Hydration complete — flushing any pending changes')
  if (pendingNamespaces.size > 0) flushQueue()
  if (orgPendingNamespaces.size > 0) flushOrgQueue()
}

/**
 * Force immediate flush (e.g., after license activation or before logout).
 * Bypasses hydration gate since this is an explicit user action.
 */
export function flushNow() {
  hydrationComplete = true // explicit flush = user action, always safe
  clearTimeout(debounceTimer)
  return flushQueue()
}

/**
 * Hydrate localStorage from server preferences on login.
 * Called once when user data is available.
 * @param {Object} serverPreferences - The preferences object from GET /api/auth/me
 * @param {Object} hydrateMap - { serverKey: localStorageWriteFn } map
 */
export function hydrateFromServer(serverPreferences, hydrateMap) {
  if (!serverPreferences || typeof serverPreferences !== 'object') return

  let hydrated = 0
  for (const [namespace, writeFn] of Object.entries(hydrateMap)) {
    const serverValue = serverPreferences[namespace]
    if (serverValue === undefined || serverValue === null) continue
    if (typeof serverValue === 'object' && Object.keys(serverValue).length === 0) continue

    try {
      writeFn(serverValue)
      hydrated++
    } catch (err) {
      console.warn(`[SyncQueue] Failed to hydrate '${namespace}':`, err.message)
    }
  }

  if (hydrated > 0) {
    console.log(`[SyncQueue] Hydrated ${hydrated} namespace(s) from server`)
    window.dispatchEvent(new CustomEvent('quox-settings-hydrated', { detail: { count: hydrated } }))
  }
}

/**
 * Get count of pending unsynced changes.
 * @returns {number}
 */
export function getPendingCount() {
  return pendingNamespaces.size
}

/**
 * Initialize: load any pending changes from a previous session and flush.
 * Call once at app startup.
 */
export function initSyncQueue() {
  loadPending()
  loadOrgPending()
  if (pendingNamespaces.size > 0) {
    console.log(`[SyncQueue] Found ${pendingNamespaces.size} pending change(s) from previous session — will flush after hydration`)
    // Do NOT flush here — wait for markHydrated() after hydrateFromServer completes
  }
  if (orgPendingNamespaces.size > 0) {
    console.log(`[SyncQueue] Found ${orgPendingNamespaces.size} org-scoped pending change(s) — will flush after hydration`)
  }

  // Flush on page unload
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      // Global preferences
      if (pendingNamespaces.size > 0) {
        const batch = Object.fromEntries(pendingNamespaces)
        try {
          navigator.sendBeacon(
            `${AUTH_API}/me/preferences-sync`,
            new Blob([JSON.stringify({ namespaces: batch })], { type: 'application/json' })
          )
        } catch { /* best effort */ }
      }
      // Org-scoped preferences — same F05 assert as flushOrgQueue: only beacon
      // the items stamped for the currently active org. Items stamped for a
      // different org stay in ORG_PENDING_KEY (already persisted) and get
      // picked up on a later flush while that org is active, never sent here
      // under the wrong org just because it happens to be active at unload.
      if (orgPendingNamespaces.size > 0 && _currentOrgId) {
        const batch = {}
        for (const [ns, entry] of orgPendingNamespaces) {
          if (entry.orgId === _currentOrgId) batch[ns] = entry.data
        }
        if (Object.keys(batch).length > 0) {
          try {
            navigator.sendBeacon(
              `/api/orgs/${_currentOrgId}/my-preferences-sync`,  // /api/orgs mount, same fix as flushOrgQueue
              new Blob([JSON.stringify({ namespaces: batch })], { type: 'application/json' })
            )
          } catch { /* best effort */ }
        }
      }
    })
  }
}
