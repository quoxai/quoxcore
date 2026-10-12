/**
 * VOLT Persistent Store — V0.1
 *
 * IndexedDB persistence for VOLT runs, events, and evidence bundles.
 * Follows the AEE store pattern (src/lib/aee/store.js).
 *
 * Schema (3 object stores):
 *   volt_runs    — keyPath: run_id, indexes: corr, status, started_at
 *   volt_events  — keyPath: event_id, indexes: run_id, event_type, ts
 *   volt_bundles — keyPath: bundle_id, indexes: run_id, created_ts
 *
 * Events are append-only (add, not put) to enforce chain of custody.
 */

import { _onEvent, _onRunChange } from './volt-recorder.js'

const DB_NAME = 'quox_volt'
const DB_VERSION = 2
const STORE_RUNS = 'volt_runs'
const STORE_EVENTS = 'volt_events'
const STORE_BUNDLES = 'volt_bundles'
const STORE_CONTENT = 'volt_content'

let dbInstance = null
let dbPromise = null
let unsubEvent = null
let unsubRun = null

/**
 * Opens or returns existing IndexedDB connection.
 * @returns {Promise<IDBDatabase>}
 */
async function getDB() {
  if (dbInstance) return dbInstance
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      dbPromise = null
      reject(new Error('IndexedDB not available'))
      return
    }

    // Timeout: never hang forever waiting for IndexedDB
    const timeout = setTimeout(() => {
      dbPromise = null
      reject(new Error('VOLT DB open timed out after 5s'))
    }, 5000)

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      clearTimeout(timeout)
      dbPromise = null
      reject(new Error(`Failed to open VOLT DB: ${request.error?.message}`))
    }

    request.onblocked = () => {
      clearTimeout(timeout)
      console.warn('[VOLT Store] DB upgrade blocked - close other tabs and reload')
      dbPromise = null
      reject(new Error('VOLT DB upgrade blocked by another tab. Close other tabs and reload.'))
    }

    request.onsuccess = () => {
      clearTimeout(timeout)
      dbInstance = request.result
      dbInstance.onerror = (event) => {
        // Suppress ConstraintError from append-only add() — expected for duplicate events
        if (event.target?.error?.name !== 'ConstraintError') {
          console.error('[VOLT Store] DB error:', event.target.error)
        }
      }
      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      const db = event.target.result

      // Runs store
      if (!db.objectStoreNames.contains(STORE_RUNS)) {
        const runs = db.createObjectStore(STORE_RUNS, { keyPath: 'run_id' })
        runs.createIndex('corr', 'corr', { unique: false })
        runs.createIndex('status', 'status', { unique: false })
        runs.createIndex('started_at', 'started_at', { unique: false })
      }

      // Events store (append-only)
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const events = db.createObjectStore(STORE_EVENTS, { keyPath: 'event_id' })
        events.createIndex('run_id', 'run_id', { unique: false })
        events.createIndex('event_type', 'event_type', { unique: false })
        events.createIndex('ts', 'ts', { unique: false })
      }

      // Bundles store
      if (!db.objectStoreNames.contains(STORE_BUNDLES)) {
        const bundles = db.createObjectStore(STORE_BUNDLES, { keyPath: 'bundle_id' })
        bundles.createIndex('run_id', 'run_id', { unique: false })
        bundles.createIndex('created_ts', 'created_ts', { unique: false })
      }

      // Content store (v0.2 - separate from events for independent rotation)
      if (!db.objectStoreNames.contains(STORE_CONTENT)) {
        const content = db.createObjectStore(STORE_CONTENT, { keyPath: 'event_id' })
        content.createIndex('run_id', 'run_id', { unique: false })
        content.createIndex('created_at', 'created_at', { unique: false })
        content.createIndex('event_type', 'event_type', { unique: false })
      }
    }
  })

  return dbPromise
}

/**
 * Initialize the VOLT store and subscribe to recorder hooks.
 * Call once at app startup.
 * @returns {Promise<void>}
 */
export async function initVoltStore() {
  await getDB()

  // Subscribe to recorder hooks (fire-and-forget persistence)
  if (!unsubEvent) {
    unsubEvent = _onEvent((event) => {
      persistEvent(event).catch(err => {
        console.warn('[VOLT Store] Failed to persist event:', err.message)
      })
    })
  }

  if (!unsubRun) {
    unsubRun = _onRunChange((runSnapshot) => {
      persistRun(runSnapshot).catch(err => {
        console.warn('[VOLT Store] Failed to persist run:', err.message)
      })
    })
  }
}

/**
 * Persist a single event (append-only — uses add, not put).
 * @param {Object} event - VOLT event
 * @returns {Promise<void>}
 */
export async function persistEvent(event) {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EVENTS, 'readwrite')
    const store = tx.objectStore(STORE_EVENTS)
    const request = store.add(event)
    request.onerror = () => {
      // ConstraintError means duplicate — that's fine for idempotency
      if (request.error?.name === 'ConstraintError') {
        resolve()
      } else {
        reject(new Error(`Failed to persist event: ${request.error?.message}`))
      }
    }
    request.onsuccess = () => resolve()
  })
}

/**
 * Persist/update run metadata (upsert).
 * @param {Object} runState - Run snapshot
 * @returns {Promise<void>}
 */
export async function persistRun(runState) {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RUNS, 'readwrite')
    const store = tx.objectStore(STORE_RUNS)
    // Upsert: store run metadata (without full events array to save space)
    const record = {
      run_id: runState.run_id,
      corr: runState.corr,
      status: runState.status,
      started_at: runState.started_at,
      completed_at: runState.completed_at,
      seq: runState.seq,
      head_hash: runState.head_hash,
      _stored_at: new Date().toISOString()
    }
    const request = store.put(record)
    request.onerror = () => reject(new Error(`Failed to persist run: ${request.error?.message}`))
    request.onsuccess = () => resolve()
  })
}

/**
 * Persist a serialized evidence bundle.
 * @param {Object} bundle - Serialized bundle (from serializeBundle)
 * @returns {Promise<void>}
 */
export async function persistBundle(bundle) {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BUNDLES, 'readwrite')
    const store = tx.objectStore(STORE_BUNDLES)
    const record = {
      bundle_id: bundle.manifest.bundle_id,
      run_id: bundle.manifest.run_id,
      created_ts: bundle.manifest.created_ts,
      data: bundle,
      _stored_at: new Date().toISOString()
    }
    const request = store.put(record)
    request.onerror = () => reject(new Error(`Failed to persist bundle: ${request.error?.message}`))
    request.onsuccess = () => resolve()
  })
}

// ============================================================================
// CONTENT STORE (v0.2) — Stores full prompts, tool I/O, model responses
// Separate from events for independent retention/rotation
// ============================================================================

/**
 * Persist content for a VOLT event (v0.2 content capture).
 * Content is stored separately from the event metadata.
 *
 * @param {Object} contentRecord
 * @param {string} contentRecord.event_id - Links to volt_events
 * @param {string} contentRecord.run_id - For bulk queries
 * @param {string} contentRecord.event_type - Event type
 * @param {Object} contentRecord.content - Full content (prompts, tool I/O, etc.)
 * @param {string} contentRecord.content_hash - SHA-256 of content for integrity
 * @param {boolean} [contentRecord.redacted=false] - Whether content has been redacted
 * @returns {Promise<void>}
 */
export async function persistContent(contentRecord) {
  const db = await getDB()
  if (!db.objectStoreNames.contains(STORE_CONTENT)) return // DB not yet upgraded
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONTENT, 'readwrite')
    const store = tx.objectStore(STORE_CONTENT)
    const record = {
      ...contentRecord,
      created_at: contentRecord.created_at || new Date().toISOString(),
      redacted: contentRecord.redacted || false,
    }
    const request = store.put(record)
    request.onerror = () => reject(new Error(`Failed to persist content: ${request.error?.message}`))
    request.onsuccess = () => resolve()
  })
}

/**
 * Load content for a specific event.
 * @param {string} event_id
 * @returns {Promise<Object|null>}
 */
export async function loadContent(event_id) {
  const db = await getDB()
  if (!db.objectStoreNames.contains(STORE_CONTENT)) return null
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONTENT, 'readonly')
    const store = tx.objectStore(STORE_CONTENT)
    const request = store.get(event_id)
    request.onerror = () => reject(new Error(`Failed to load content: ${request.error?.message}`))
    request.onsuccess = () => resolve(request.result || null)
  })
}

/**
 * Load all content records for a run.
 * @param {string} run_id
 * @returns {Promise<Object[]>}
 */
export async function loadRunContent(run_id) {
  const db = await getDB()
  if (!db.objectStoreNames.contains(STORE_CONTENT)) return []
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONTENT, 'readonly')
    const store = tx.objectStore(STORE_CONTENT)
    const index = store.index('run_id')
    const request = index.getAll(IDBKeyRange.only(run_id))
    request.onerror = () => reject(new Error(`Failed to load content: ${request.error?.message}`))
    request.onsuccess = () => resolve(request.result || [])
  })
}

/**
 * Delete content older than a given date (retention policy).
 * Hash chain in volt_events is preserved - only content is removed.
 *
 * @param {string} beforeDate - ISO date string; content created before this is deleted
 * @returns {Promise<number>} Number of records deleted
 */
export async function purgeContentBefore(beforeDate) {
  const db = await getDB()
  if (!db.objectStoreNames.contains(STORE_CONTENT)) return 0
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONTENT, 'readwrite')
    const store = tx.objectStore(STORE_CONTENT)
    const index = store.index('created_at')
    const range = IDBKeyRange.upperBound(beforeDate, true)
    const request = index.openCursor(range)
    let deleted = 0

    request.onerror = () => reject(new Error(`Failed to purge content: ${request.error?.message}`))
    request.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) {
        cursor.delete()
        deleted++
        cursor.continue()
      } else {
        resolve(deleted)
      }
    }
  })
}

/**
 * Get content store statistics.
 * @returns {Promise<{count: number, oldestDate: string|null}>}
 */
export async function getContentStats() {
  const db = await getDB()
  if (!db.objectStoreNames.contains(STORE_CONTENT)) return { count: 0, oldestDate: null }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONTENT, 'readonly')
    const store = tx.objectStore(STORE_CONTENT)
    const countReq = store.count()
    const index = store.index('created_at')
    const oldestReq = index.openCursor()

    let oldest = null
    oldestReq.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) oldest = cursor.value.created_at
    }

    tx.oncomplete = () => resolve({ count: countReq.result, oldestDate: oldest })
    tx.onerror = () => reject(new Error(`Failed to get content stats: ${tx.error?.message}`))
  })
}

/**
 * Load all runs from the store.
 * @returns {Promise<Object[]>}
 */
export async function loadRuns() {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RUNS, 'readonly')
    const store = tx.objectStore(STORE_RUNS)
    const request = store.getAll()
    request.onerror = () => reject(new Error(`Failed to load runs: ${request.error?.message}`))
    request.onsuccess = () => resolve(request.result || [])
  })
}

/**
 * Load events for a specific run, sorted by seq.
 * @param {string} run_id
 * @returns {Promise<Object[]>}
 */
export async function loadRunEvents(run_id) {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EVENTS, 'readonly')
    const store = tx.objectStore(STORE_EVENTS)
    const index = store.index('run_id')
    const request = index.getAll(IDBKeyRange.only(run_id))
    request.onerror = () => reject(new Error(`Failed to load events: ${request.error?.message}`))
    request.onsuccess = () => {
      const events = request.result || []
      events.sort((a, b) => a.seq - b.seq)
      resolve(events)
    }
  })
}

/**
 * Load a bundle by run_id.
 * @param {string} run_id
 * @returns {Promise<Object|null>}
 */
export async function loadBundleByRunId(run_id) {
  const db = await getDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BUNDLES, 'readonly')
    const store = tx.objectStore(STORE_BUNDLES)
    const index = store.index('run_id')
    const request = index.getAll(IDBKeyRange.only(run_id))
    request.onerror = () => reject(new Error(`Failed to load bundle: ${request.error?.message}`))
    request.onsuccess = () => {
      const results = request.result || []
      resolve(results.length > 0 ? results[0].data : null)
    }
  })
}

/**
 * Query runs with optional filters.
 * @param {Object} [filters]
 * @param {string} [filters.status] - Filter by status
 * @param {string} [filters.corr] - Filter by correlation ID
 * @param {string} [filters.after] - Filter by started_at >= ISO string
 * @param {string} [filters.before] - Filter by started_at < ISO string
 * @returns {Promise<Object[]>}
 */
export async function queryRuns(filters = {}) {
  const runs = await loadRuns()
  return runs.filter(run => {
    if (filters.status && run.status !== filters.status) return false
    if (filters.corr && run.corr !== filters.corr) return false
    if (filters.after && run.started_at < filters.after) return false
    if (filters.before && run.started_at >= filters.before) return false
    return true
  })
}

/**
 * Get store statistics.
 * @returns {Promise<{runs: number, events: number, bundles: number}>}
 */
export async function getStoreStats() {
  const db = await getDB()
  const hasContent = db.objectStoreNames.contains(STORE_CONTENT)
  return new Promise((resolve, reject) => {
    const stores = [STORE_RUNS, STORE_EVENTS, STORE_BUNDLES]
    if (hasContent) stores.push(STORE_CONTENT)
    const tx = db.transaction(stores, 'readonly')

    const runsReq = tx.objectStore(STORE_RUNS).count()
    const eventsReq = tx.objectStore(STORE_EVENTS).count()
    const bundlesReq = tx.objectStore(STORE_BUNDLES).count()
    const contentReq = hasContent ? tx.objectStore(STORE_CONTENT).count() : null

    tx.oncomplete = () => {
      resolve({
        runs: runsReq.result,
        events: eventsReq.result,
        bundles: bundlesReq.result,
        contentRecords: contentReq ? contentReq.result : 0,
      })
    }
    tx.onerror = () => reject(new Error(`Failed to get stats: ${tx.error?.message}`))
  })
}

// ============================================================================
// SERVER SYNC — Background sync of VOLT data to collector
// ============================================================================

let voltSyncInterval = null
const VOLT_SYNC_INTERVAL_MS = 60000 // 1 minute
const VOLT_SYNC_BATCH_SIZE = 50

/**
 * Sync unsynced VOLT runs and events to the server.
 * Uses _synced flag on runs to track sync state.
 */
export async function syncVoltToServer() {
  try {
    const db = await getDB()

    // Get unsynced runs (runs without _synced_at)
    const unsyncedRuns = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RUNS, 'readonly')
      const store = tx.objectStore(STORE_RUNS)
      const request = store.getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        // CRP-AU-2: Include runs that completed since last sync (not just unsynced)
        const runs = (request.result || []).filter(r =>
          !r._synced_at || // never synced
          (r.status === 'completed' && r._synced_status !== 'completed') || // completed since last sync
          (r.status === 'failed' && r._synced_status !== 'failed') // failed since last sync
        )
        resolve(runs.slice(0, VOLT_SYNC_BATCH_SIZE))
      }
    })

    if (unsyncedRuns.length === 0) return { synced: { runs: 0, events: 0 } }

    // Get events for those runs
    const allEvents = []
    for (const run of unsyncedRuns) {
      const events = await loadRunEvents(run.run_id)
      allEvents.push(...events.filter(e => !e._synced_at))
    }

    // CRP-BE-4: Also sync bundles and content
    let allBundles = []
    let allContent = []
    try {
      if (db.objectStoreNames.contains(STORE_BUNDLES)) {
        const btx = db.transaction(STORE_BUNDLES, 'readonly')
        const bstore = btx.objectStore(STORE_BUNDLES)
        const bundles = await new Promise((resolve, reject) => {
          const req = bstore.getAll()
          req.onerror = () => reject(req.error)
          req.onsuccess = () => resolve(req.result || [])
        })
        allBundles = bundles.filter(b => !b._synced_at).slice(0, VOLT_SYNC_BATCH_SIZE)
      }
      if (db.objectStoreNames.contains(STORE_CONTENT)) {
        const ctx = db.transaction(STORE_CONTENT, 'readonly')
        const cstore = ctx.objectStore(STORE_CONTENT)
        const contentItems = await new Promise((resolve, reject) => {
          const req = cstore.getAll()
          req.onerror = () => reject(req.error)
          req.onsuccess = () => resolve(req.result || [])
        })
        allContent = contentItems.filter(c => !c._synced_at).slice(0, VOLT_SYNC_BATCH_SIZE)
      }
    } catch (_) { /* non-fatal — bundles/content sync is optional */ }

    // POST to server
    const response = await fetch('/collector/volt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        runs: unsyncedRuns,
        events: allEvents.slice(0, VOLT_SYNC_BATCH_SIZE * 10),
        bundles: allBundles.length > 0 ? allBundles : undefined,
        content: allContent.length > 0 ? allContent : undefined,
      }),
    })

    if (!response.ok) throw new Error(`VOLT sync failed: ${response.status}`)
    const result = await response.json()

    // Mark runs as synced (CRP-AU-2: also track synced status for lifecycle updates)
    const markTx = db.transaction(STORE_RUNS, 'readwrite')
    const markStore = markTx.objectStore(STORE_RUNS)
    for (const run of unsyncedRuns) {
      run._synced_at = new Date().toISOString()
      run._synced_status = run.status || 'active'
      markStore.put(run)
    }

    // CRP-BE-4: Mark bundles and content as synced
    try {
      if (allBundles.length > 0 && db.objectStoreNames.contains(STORE_BUNDLES)) {
        const btx = db.transaction(STORE_BUNDLES, 'readwrite')
        const bs = btx.objectStore(STORE_BUNDLES)
        for (const b of allBundles) { b._synced_at = new Date().toISOString(); bs.put(b) }
      }
      if (allContent.length > 0 && db.objectStoreNames.contains(STORE_CONTENT)) {
        const ctx = db.transaction(STORE_CONTENT, 'readwrite')
        const cs = ctx.objectStore(STORE_CONTENT)
        for (const c of allContent) { c._synced_at = new Date().toISOString(); cs.put(c) }
      }
    } catch (_) { /* non-fatal */ }

    const bc = result.synced?.bundles || 0
    const cc = result.synced?.content || 0
    console.log(`[VOLT Sync] Synced ${result.synced?.runs || 0} runs, ${result.synced?.events || 0} events${bc ? `, ${bc} bundles` : ''}${cc ? `, ${cc} content` : ''}`)
    return result
  } catch (err) {
    console.warn('[VOLT Sync] Failed:', err.message)
    return null
  }
}

/**
 * Start background sync of VOLT data to server.
 * @param {number} [intervalMs] - Sync interval (default: 60s)
 */
export function startVoltBackgroundSync(intervalMs = VOLT_SYNC_INTERVAL_MS) {
  stopVoltBackgroundSync()
  // Initial sync after 10s delay
  setTimeout(() => syncVoltToServer(), 10000)
  voltSyncInterval = setInterval(() => syncVoltToServer(), intervalMs)

  // CRP-BE-4: Flush on visibility change (reduce 60s data loss window)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        syncVoltToServer().catch(() => {})
      }
    })
  }

  console.log(`[VOLT Sync] Background sync started (every ${intervalMs / 1000}s)`)
}

/**
 * Stop background sync.
 */
export function stopVoltBackgroundSync() {
  if (voltSyncInterval) {
    clearInterval(voltSyncInterval)
    voltSyncInterval = null
  }
}

/**
 * Close the VOLT database and unsubscribe from recorder hooks.
 */
export function closeVoltDB() {
  stopVoltBackgroundSync()
  if (unsubEvent) { unsubEvent(); unsubEvent = null }
  if (unsubRun) { unsubRun(); unsubRun = null }
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
    dbPromise = null
  }
}
