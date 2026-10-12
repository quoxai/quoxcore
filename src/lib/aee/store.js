/**
 * AEE IndexedDB Storage Layer
 * Persistent storage for AEE envelopes
 *
 * @fileoverview Provides IndexedDB storage with indexes for fast querying
 */

// ============================================================================
// Source Classification
// ============================================================================

/**
 * Classify a conversation by its correlation ID prefix.
 * Used for source-based filtering in the Activity Centre.
 *
 * @param {string} corr - Correlation ID
 * @returns {string} Source category key
 */
export function classifySource(corr) {
  if (!corr) return 'unknown'
  // Case-insensitive check for the common prefixes that appear in either case
  const c = corr
  // Chat conversations — user-initiated chat UI, MCP sessions, sidebar agent chats, UUIDs
  if (c.startsWith('CONV_') || c.startsWith('CHAT_')) return 'chat'
  if (c.startsWith('mcp-') || c.startsWith('MCP_') || c.startsWith('MCP-')) return 'chat'
  if (/_CHAT_/.test(c)) return 'chat' // e.g. TAILSCALE_MESHNET_CHAT_, DOCKER_DOCKULA_CHAT_
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(c)) return 'chat' // UUIDs from MCP/CLI
  // Workflow + flow runs
  if (c.startsWith('wf-') || c.startsWith('WF_') || c.startsWith('FLOW_')) return 'workflow'
  // Shell (SSH) and terminal (local PTY) sessions — normalise both case variants
  if (c.startsWith('SHELL_') || c.startsWith('shell-')) return 'shell'
  if (c.startsWith('TERM_') || c.startsWith('term-')) return 'terminal'
  if (c.startsWith('INBOX_')) return 'inbox'
  if (c.startsWith('TG_') || c.startsWith('TELEGRAM_')) return 'telegram'
  if (c.startsWith('ERR_') || c.startsWith('ERROR_')) return 'error'
  if (c.startsWith('AOCL_')) return 'aocl'
  if (c.startsWith('FLEET_')) return 'fleet'
  if (c.startsWith('AUDIT_')) return 'audit'
  if (c.startsWith('ACTION_')) return 'actions'
  if (c.startsWith('OBJ_') || c.startsWith('OBJECTIVE_')) return 'objectives'
  if (c.startsWith('BQ_') || c.startsWith('BROWSER_')) return 'browser'
  if (c.startsWith('MEM_') || c.startsWith('MEMORY_')) return 'memory'
  if (c.startsWith('FILE_') || c.startsWith('FILES_')) return 'files'
  if (c.startsWith('PLUG_') || c.startsWith('PLUGIN_')) return 'plugins'
  if (c.startsWith('APPR_') || c.startsWith('APPROVAL_')) return 'approvals'
  if (c.startsWith('DELEG_') || c.startsWith('DELEGATION_')) return 'delegation'
  if (c.startsWith('TEAM_')) return 'teams'
  return 'other'
}

export const SOURCE_CATEGORIES = {
  chat:       { label: 'Chats',       color: '#38bdf8' },
  workflow:   { label: 'Workflows',   color: '#a78bfa' },
  shell:      { label: 'Shell',       color: '#10b981' },
  terminal:   { label: 'Terminal',    color: '#f59e0b' },
  inbox:      { label: 'Inbox',       color: '#f472b6' },
  aocl:       { label: 'AOCL',       color: '#6b7280' },
  telegram:   { label: 'Telegram',   color: '#0088cc' },
  error:      { label: 'Errors',      color: '#ef4444' },
  fleet:      { label: 'Fleet',       color: '#22d3ee' },
  audit:      { label: 'Audit',       color: '#d97706' },
  actions:    { label: 'Actions',     color: '#f59e0b' },
  objectives: { label: 'Objectives',  color: '#8b5cf6' },
  browser:    { label: 'Browser-Q',   color: '#f59e42' },
  memory:     { label: 'Memory',      color: '#14b8a6' },
  files:      { label: 'Files',       color: '#64748b' },
  plugins:    { label: 'Plugins',     color: '#f97316' },
  approvals:  { label: 'Approvals',   color: '#ec4899' },
  delegation: { label: 'Delegation',  color: '#06b6d4' },
  teams:      { label: 'Teams',       color: '#a855f7' },
  other:      { label: 'Other',       color: '#9ca3af' },
}

// ============================================================================
// IndexedDB Storage
// ============================================================================

const DB_NAME = 'quox_aee'
const DB_VERSION = 1
const STORE_NAME = 'envelopes'

let dbInstance = null
let dbPromise = null

/**
 * Opens or returns existing IndexedDB connection
 * @returns {Promise<IDBDatabase>}
 */
async function getDB() {
  if (dbInstance) return dbInstance

  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    // Check if IndexedDB is available
    if (!indexedDB) {
      console.error('[AEE Store] IndexedDB not available')
      reject(new Error('IndexedDB not available in this browser'))
      return
    }

    console.log('[AEE Store] Opening database...')
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('[AEE Store] Failed to open database:', request.error)
      dbPromise = null // Reset so we can retry
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`))
    }

    request.onsuccess = () => {
      dbInstance = request.result
      console.log('[AEE Store] Database opened successfully')

      // Handle connection errors
      dbInstance.onerror = (event) => {
        console.error('[AEE Store] Database error:', event.target.error)
      }

      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      console.log('[AEE Store] Upgrading database schema...')
      const db = event.target.result

      // Create envelopes store with indexes
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })

        // Indexes for efficient querying
        store.createIndex('corr', 'corr', { unique: false })
        store.createIndex('ts', 'ts', { unique: false })
        store.createIndex('type', 'type', { unique: false })
        store.createIndex('from', 'from', { unique: false })
        store.createIndex('to', 'to', { unique: false })
        store.createIndex('intent', 'intent', { unique: false })
        store.createIndex('reply_to', 'reply_to', { unique: false })

        // Compound indexes for common queries
        store.createIndex('corr_ts', ['corr', 'ts'], { unique: false })
        store.createIndex('type_ts', ['type', 'ts'], { unique: false })

        console.log('[AEE Store] Created object store with indexes')
      }
    }

    request.onblocked = () => {
      console.warn('[AEE Store] Database blocked - close other tabs with this app')
    }
  })

  return dbPromise
}

/**
 * Stores an envelope in IndexedDB
 *
 * @param {import('./types.js').AEEEnvelope} envelope
 * @returns {Promise<void>}
 */
export async function storeEnvelope(envelope) {
  try {
    const db = await getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)

      // Add sync metadata
      const record = {
        ...envelope,
        _stored_at: new Date().toISOString(),
        _synced: false
      }

      const request = store.put(record)

      request.onerror = () => {
        console.error('[AEE Store] Failed to put envelope:', request.error)
        reject(new Error(`Failed to store envelope: ${request.error?.message}`))
      }

      request.onsuccess = () => {
        // Use console.log instead of console.debug for visibility
        // console.debug is often filtered out in browser consoles
        console.log('[AEE Store] Envelope stored:', envelope.id)

        // VOLT: Record envelope as trace event (non-blocking, fire-and-forget)
        import('../volt/volt-bridge.js').then(({ onEnvelopeStored }) => {
          onEnvelopeStored(envelope).catch(err => {
            console.warn('[VOLT] Failed to record envelope:', err.message)
          })
        }).catch(err => {
          console.warn('[VOLT] Failed to load bridge module:', err.message)
        })

        resolve()
      }

      tx.onerror = () => {
        console.error('[AEE Store] Transaction error:', tx.error)
      }
    })
  } catch (err) {
    console.error('[AEE Store] storeEnvelope error:', err)
    throw err
  }
}

/**
 * Stores multiple envelopes in a single transaction
 *
 * @param {import('./types.js').AEEEnvelope[]} envelopes
 * @returns {Promise<void>}
 */
export async function storeEnvelopes(envelopes) {
  if (!envelopes.length) return

  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)

    const now = new Date().toISOString()

    for (const envelope of envelopes) {
      store.put({
        ...envelope,
        _stored_at: now,
        _synced: false
      })
    }

    tx.oncomplete = () => {
      // VOLT: Record each envelope as trace event (non-blocking, fire-and-forget)
      import('../volt/volt-bridge.js').then(({ onEnvelopeStored }) => {
        for (const envelope of envelopes) {
          onEnvelopeStored(envelope).catch(() => {})
        }
      }).catch(() => {})
      resolve()
    }
    tx.onerror = () => reject(new Error(`Failed to store envelopes: ${tx.error?.message}`))
  })
}

/**
 * Retrieves an envelope by ID
 *
 * @param {string} id - Envelope ID
 * @returns {Promise<import('./types.js').AEEEnvelope|null>}
 */
export async function getEnvelope(id) {
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(id)

    request.onerror = () => reject(new Error(`Failed to get envelope: ${request.error?.message}`))
    request.onsuccess = () => resolve(request.result || null)
  })
}

/**
 * Retrieves all envelopes in a conversation (by correlation ID)
 *
 * @param {string} corr - Correlation ID
 * @returns {Promise<import('./types.js').AEEEnvelope[]>}
 */
export async function getConversation(corr) {
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('corr')
    const request = index.getAll(IDBKeyRange.only(corr))

    request.onerror = () => reject(new Error(`Failed to get conversation: ${request.error?.message}`))
    request.onsuccess = () => {
      // Sort by timestamp
      const results = request.result || []
      results.sort((a, b) => a.ts.localeCompare(b.ts))
      resolve(results)
    }
  })
}

/**
 * Find events related to a conversation via parentCorr linkage.
 * Scans all envelopes whose payload.parentCorr matches the given corr.
 * Used by the "Related Events" feature in ActivityView.
 *
 * @param {string} corr - The parent correlation ID to search for
 * @returns {Promise<import('./types.js').AEEEnvelope[]>}
 */
export async function findRelatedEvents(corr) {
  if (!corr) return []
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const results = []

    // Full scan with payload.parentCorr filter — IndexedDB doesn't index
    // nested fields, but the dataset is small (local client-side store).
    // Server-side query would use SQL WHERE payload->>'parentCorr' = ?
    const request = store.openCursor()
    request.onerror = () => reject(new Error('Failed to scan for related events'))
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        const env = cursor.value
        if (env.payload?.parentCorr === corr || env.corr === corr) {
          results.push(env)
        }
        cursor.continue()
      } else {
        results.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
        resolve(results)
      }
    }
  })
}

/**
 * Retrieves all replies to a message (children in the DAG)
 *
 * @param {string} id - Parent message ID
 * @returns {Promise<import('./types.js').AEEEnvelope[]>}
 */
export async function getThread(id) {
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('reply_to')
    const request = index.getAll(IDBKeyRange.only(id))

    request.onerror = () => reject(new Error(`Failed to get thread: ${request.error?.message}`))
    request.onsuccess = () => {
      const results = request.result || []
      results.sort((a, b) => a.ts.localeCompare(b.ts))
      resolve(results)
    }
  })
}

/**
 * @typedef {Object} QueryFilters
 * @property {string} [corr] - Filter by correlation ID
 * @property {string} [type] - Filter by envelope type
 * @property {string} [from] - Filter by sender
 * @property {string} [to] - Filter by recipient
 * @property {string} [intent] - Filter by intent
 * @property {string} [after] - Filter by timestamp (ISO string, inclusive)
 * @property {string} [since] - Alias for 'after' — filter by timestamp (ISO string, inclusive)
 * @property {string} [before] - Filter by timestamp (ISO string, exclusive)
 * @property {number} [limit] - Maximum results (default: 100)
 * @property {number} [offset] - Skip first N results (default: 0)
 * @property {string} [sortOrder] - Sort direction: 'asc' or 'desc' (default: 'desc')
 */

/**
 * Queries envelopes with filters
 *
 * @param {QueryFilters} filters
 * @returns {Promise<import('./types.js').AEEEnvelope[]>}
 */
export async function queryEnvelopes(filters = {}) {
  const db = await getDB()
  const { limit = 100, offset = 0, after, before, since, intentPrefix, sortOrder = 'desc', ...indexFilters } = filters

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)

    // Choose best index based on filters
    let request
    const indexField = Object.keys(indexFilters).find(k => indexFilters[k])

    if (indexField && store.indexNames.contains(indexField)) {
      const index = store.index(indexField)
      request = index.getAll(IDBKeyRange.only(indexFilters[indexField]))
    } else {
      request = store.getAll()
    }

    request.onerror = () => reject(new Error(`Query failed: ${request.error?.message}`))
    request.onsuccess = () => {
      let results = request.result || []

      // Apply additional filters
      results = results.filter(env => {
        // Check index filters that weren't used for primary query
        for (const [key, value] of Object.entries(indexFilters)) {
          if (key !== indexField && env[key] !== value) {
            return false
          }
        }

        // Check time range (since is an alias for after)
        const afterTime = after || since
        if (afterTime && env.ts < afterTime) return false
        if (before && env.ts >= before) return false

        // Check intent prefix
        if (intentPrefix && (!env.intent || !env.intent.startsWith(intentPrefix))) return false

        return true
      })

      // Sort by timestamp (default: newest first)
      results.sort((a, b) => sortOrder === 'asc'
        ? a.ts.localeCompare(b.ts)
        : b.ts.localeCompare(a.ts))

      // Apply pagination
      results = results.slice(offset, offset + limit)

      resolve(results)
    }
  })
}

/**
 * Gets all unique conversation IDs with their first message
 *
 * @param {Object} [options]
 * @param {number} [options.limit] - Maximum results
 * @param {string} [options.after] - Filter by timestamp
 * @returns {Promise<Array<{corr: string, firstMessage: import('./types.js').AEEEnvelope, count: number, lastTs: string}>>}
 */
/**
 * Noise prefixes that produce single-event "conversations" and should be
 * excluded from the default activity view.
 */
const NOISE_PREFIXES = ['MEM_', 'ERR_', 'ACTION_']

export async function getConversations(options = {}) {
  const { limit = 30, after } = options
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()

    request.onerror = () => reject(new Error(`Failed to get conversations: ${request.error?.message}`))
    request.onsuccess = () => {
      const envelopes = request.result || []

      // Group by correlation ID
      const convMap = new Map()

      for (const env of envelopes) {
        if (after && env.ts < after) continue

        if (!convMap.has(env.corr)) {
          convMap.set(env.corr, {
            corr: env.corr,
            messages: [],
            firstTs: env.ts,
            lastTs: env.ts
          })
        }

        const conv = convMap.get(env.corr)
        conv.messages.push(env)
        if (env.ts < conv.firstTs) conv.firstTs = env.ts
        if (env.ts > conv.lastTs) conv.lastTs = env.ts
      }

      // Convert to result format, filtering out noise
      const conversations = Array.from(convMap.values())
        .filter(conv => {
          // Skip noise prefixes
          if (NOISE_PREFIXES.some(p => conv.corr.startsWith(p))) return false
          // Skip single-event "conversations"
          if (conv.messages.length < 2) return false
          return true
        })
        .map(conv => {
          // Sort messages by timestamp with stable tiebreaker:
          // tasks (chat queries) before results before events (AOCL)
          const typeOrder = { task: 0, result: 1, error: 2, stream: 3, event: 4 }
          conv.messages.sort((a, b) => {
            const tsCmp = a.ts.localeCompare(b.ts)
            if (tsCmp !== 0) return tsCmp
            return (typeOrder[a.type] ?? 5) - (typeOrder[b.type] ?? 5)
          })

          // Prefer a chat message as representative (not AOCL event)
          const chatMsg = conv.messages.find(m =>
            m.intent && !m.intent.startsWith('aocl.')
          )

          return {
            corr: conv.corr,
            firstMessage: chatMsg || conv.messages[0],
            count: conv.messages.length,
            lastTs: conv.lastTs
          }
        })
        .sort((a, b) => b.lastTs.localeCompare(a.lastTs)) // Newest conversations first
        .slice(0, limit)

      resolve(conversations)
    }
  })
}

/**
 * Gets envelopes that haven't been synced to server
 *
 * @param {number} [limit] - Maximum results
 * @returns {Promise<import('./types.js').AEEEnvelope[]>}
 */
export async function getUnsyncedEnvelopes(limit = 100) {
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()

    request.onerror = () => reject(new Error(`Failed to get unsynced: ${request.error?.message}`))
    request.onsuccess = () => {
      const results = (request.result || [])
        .filter(env => !env._synced)
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(0, limit)

      resolve(results)
    }
  })
}

/**
 * Marks envelopes as synced
 *
 * @param {string[]} ids - Envelope IDs to mark
 * @returns {Promise<void>}
 */
export async function markSynced(ids) {
  if (!ids.length) return

  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)

    let completed = 0

    for (const id of ids) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        if (getReq.result) {
          const updated = { ...getReq.result, _synced: true, _synced_at: new Date().toISOString() }
          store.put(updated)
        }
        completed++
        if (completed === ids.length) {
          tx.oncomplete = () => resolve()
        }
      }
    }

    tx.onerror = () => reject(new Error(`Failed to mark synced: ${tx.error?.message}`))
  })
}

/**
 * Deletes an envelope by ID
 *
 * @param {string} id - Envelope ID
 * @returns {Promise<void>}
 */
export async function deleteEnvelope(id) {
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.delete(id)

    request.onerror = () => reject(new Error(`Failed to delete: ${request.error?.message}`))
    request.onsuccess = () => resolve()
  })
}

/**
 * Deletes old envelopes (cleanup)
 *
 * @param {number} maxAgeDays - Delete envelopes older than this
 * @returns {Promise<number>} - Number of deleted envelopes
 */
export async function cleanupOldEnvelopes(maxAgeDays = 30) {
  const db = await getDB()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - maxAgeDays)
  const cutoffStr = cutoff.toISOString()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('ts')
    const range = IDBKeyRange.upperBound(cutoffStr)

    let deleted = 0
    const request = index.openCursor(range)

    request.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) {
        store.delete(cursor.primaryKey)
        deleted++
        cursor.continue()
      }
    }

    tx.oncomplete = () => resolve(deleted)
    tx.onerror = () => reject(new Error(`Cleanup failed: ${tx.error?.message}`))
  })
}

/**
 * Gets database statistics
 *
 * @returns {Promise<{totalEnvelopes: number, conversations: number, oldestTs: string|null, newestTs: string|null}>}
 */
export async function getStats() {
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)

    const countReq = store.count()
    const allReq = store.getAll()

    allReq.onerror = () => reject(new Error(`Stats failed: ${allReq.error?.message}`))
    allReq.onsuccess = () => {
      const envelopes = allReq.result || []
      const corrSet = new Set(envelopes.map(e => e.corr))

      let oldest = null
      let newest = null

      for (const env of envelopes) {
        if (!oldest || env.ts < oldest) oldest = env.ts
        if (!newest || env.ts > newest) newest = env.ts
      }

      resolve({
        totalEnvelopes: envelopes.length,
        conversations: corrSet.size,
        oldestTs: oldest,
        newestTs: newest
      })
    }
  })
}

/**
 * Clears all stored envelopes (use with caution!)
 *
 * @returns {Promise<void>}
 */
export async function clearAll() {
  const db = await getDB()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.clear()

    request.onerror = () => reject(new Error(`Clear failed: ${request.error?.message}`))
    request.onsuccess = () => resolve()
  })
}

/**
 * Closes the database connection
 */
export function closeDB() {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
    dbPromise = null
  }
}

// ============================================================================
// Server Sync
// ============================================================================

const SYNC_INTERVAL_MS = 30000 // 30 seconds
const COLLECTOR_URL = '/collector'
let syncIntervalId = null

// CLARITY-3: csrf_token is the same JS-readable, login-session cookie
// AuthContext/serverSyncQueue use as a liveness signal for "is there an
// active session". Its absence means the user isn't logged in (e.g. the
// login page) — POSTing to /collector/aee/sync in that state was getting
// CORS-rejected and spamming the console/network panel for no benefit.
function hasActiveSession() {
  if (typeof document === 'undefined') return false
  return /(?:^|;\s*)csrf_token=([^;]+)/.test(document.cookie)
}

/**
 * Syncs unsynced envelopes to the server
 * @returns {Promise<{synced: number, error?: string}>}
 */
export async function syncToServer() {
  if (!hasActiveSession()) {
    return { synced: 0 }
  }
  try {
    const unsynced = await getUnsyncedEnvelopes(100)
    if (unsynced.length === 0) {
      return { synced: 0 }
    }

    const response = await fetch(`${COLLECTOR_URL}/aee/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelopes: unsynced })
    })

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`)
    }

    const result = await response.json()

    // Mark as synced
    const ids = unsynced.map(e => e.id)
    await markSynced(ids)

    return { synced: result.synced || unsynced.length }
  } catch (err) {
    console.warn('[AEE Sync] Failed to sync:', err.message)
    return { synced: 0, error: err.message }
  }
}

// AEE-CORE-4.1: sync state tracks consecutive failures + circuit breaker so
// transient network errors don't spam retries and don't silently drop data.
import { nextSyncDelay, updateSyncState, syncStatus as computeSyncStatus } from './syncBackoff.js'
let _syncState = { consecutiveFailures: 0, breakerTrippedAt: null, lastSuccessAt: null }
let _syncTimeoutId = null
let _syncStopped = false

/**
 * Public accessor for UI diagnostics (AEE health banner, settings page).
 */
export function getSyncDiagnostics() {
  return {
    status: computeSyncStatus(_syncState),
    consecutiveFailures: _syncState.consecutiveFailures,
    breakerTrippedAt: _syncState.breakerTrippedAt,
    lastSuccessAt: _syncState.lastSuccessAt,
  }
}

async function _syncTick() {
  if (_syncStopped) return
  let outcome = 'success'
  try {
    const result = await syncToServer()
    if (result && result.error) outcome = 'failure'
  } catch {
    outcome = 'failure'
  }
  _syncState = updateSyncState(_syncState, outcome)
  const delay = nextSyncDelay(_syncState)
  if (_syncState.consecutiveFailures > 0) {
    const status = computeSyncStatus(_syncState)
    console.warn(`[AEE Sync] ${status} — next retry in ${Math.round(delay / 1000)}s (failures: ${_syncState.consecutiveFailures})`)
  }
  _syncTimeoutId = setTimeout(_syncTick, delay)
}

/**
 * Starts background sync to server with exponential backoff + circuit breaker.
 * @param {number} [_intervalMs] - Legacy parameter; ignored. Base interval is
 *                                 controlled by SYNC_BASE_MS in syncBackoff.js.
 */
export function startBackgroundSync(_intervalMs) {
  if (_syncTimeoutId) {
    clearTimeout(_syncTimeoutId)
  }
  _syncStopped = false

  // Initial sync
  _syncTick()

  // Flush on tab close / navigation to minimise data loss
  window.removeEventListener('beforeunload', _flushOnUnload)
  window.addEventListener('beforeunload', _flushOnUnload)
  window.removeEventListener('visibilitychange', _flushOnHide)
  window.addEventListener('visibilitychange', _flushOnHide)

  console.log('[AEE Sync] Background sync started (exp backoff, 30s base → 5min max, breaker at 10 failures)')
}

function _flushOnUnload() {
  // Use sendBeacon for reliable delivery on tab close
  try {
    const db = indexedDB.open('quox_aee')
    // Can't do async in beforeunload — rely on visibilitychange or periodic sync
    // sendBeacon as best-effort with any cached pending count
  } catch { /* ignore */ }
}

function _flushOnHide() {
  if (document.visibilityState === 'hidden') {
    syncToServer().catch(() => {})
  }
}

/**
 * Stops background sync
 */
export function stopBackgroundSync() {
  _syncStopped = true
  if (_syncTimeoutId) {
    clearTimeout(_syncTimeoutId)
    _syncTimeoutId = null
  }
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
  console.log('[AEE Sync] Background sync stopped')
}

// ============================================================================
// Server Read (for cross-device persistence)
// ============================================================================

/**
 * Fetch conversations from the collector server (enriched with first-message preview).
 * Used by ActivityView for cross-device history.
 *
 * @param {Object} [options]
 * @param {number} [options.limit] - Maximum results (default 30)
 * @param {number} [options.offset] - Skip first N results (default 0)
 * @param {boolean} [options.includeNoise] - Include MEM_, ERR_ etc. single-event noise (default false)
 * @param {string} [options.family] - Log-type tab family: 'chats' (default — real
 *   user<->agent CONV_ conversations only), 'objectives' (OBJ_ corrs),
 *   'workflows' (WORKFLOW_/WF_/wf- corrs), 'governance' (AOCL_/ANOM_ corrs),
 *   'tools' (TOOL_ corrs), 'rooms' (Matrix room-DAG corrs — `!<roomId>:quox`
 *   receipts + `matrix_<roomId>` agent turns), or 'system' (the infra
 *   catch-all — everything not claimed by a more specific family). Each
 *   family is a distinct server-side scoped + paginated query.
 * @returns {Promise<{conversations: Array<{corr: string, firstMessage: object, count: number, lastTs: string}>, total: number, offset: number, limit: number, family: string}>}
 */
export async function getConversationsFromServer(options = {}) {
  const { limit = 30, offset = 0, includeNoise = false, family = 'chats' } = options
  const params = new URLSearchParams({ limit, offset, family })
  if (includeNoise) params.set('includeNoise', 'true')

  const response = await fetch(`${COLLECTOR_URL}/aee/conversations/enriched?${params}`, {
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error(`Server returned ${response.status}`)
  const data = await response.json()

  const conversations = (data.conversations || []).map(conv => ({
    corr: conv.corr,
    firstMessage: conv.firstMessage || { ts: conv.first_ts, corr: conv.corr, payload: {} },
    count: conv.count,
    lastTs: conv.last_ts,
    // Server-computed rollups — required by ConversationList rollup badges
    // and the ActivityView breakdown quick-filters (onlyWithTools/Policy/
    // Errors). Dropping these here silently broke both: badges never render
    // and each quick-filter matched `!(undefined > 0)` → excluded every row.
    breakdown: conv.breakdown || null,
    severity: conv.severity || null,
  }))

  return {
    conversations,
    total: data.total || conversations.length,
    offset: data.offset || 0,
    limit: data.limit || limit,
    family: data.family || family,
  }
}

/**
 * Fetch a full conversation from the collector server (decrypted).
 * Used by ActivityView when selecting a conversation for cross-device access.
 *
 * @param {string} corr - Correlation ID
 * @returns {Promise<import('./types.js').AEEEnvelope[]>} Envelopes sorted by timestamp
 */
export async function getConversationFromServer(corr) {
  const response = await fetch(`${COLLECTOR_URL}/aee/conversation/${encodeURIComponent(corr)}`, {
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error(`Server returned ${response.status}`)
  const data = await response.json()
  return data.envelopes || []
}
