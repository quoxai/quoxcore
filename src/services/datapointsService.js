/**
 * Datapoints Service
 *
 * Counts total datapoints across all QuoxCORE data stores:
 * - Memories (episodic, semantic, entity, learned)
 * - Files and folders
 * - Conversations and messages
 * - Workflow executions
 * - Entities
 *
 * Syncs across tabs using BroadcastChannel and storage events.
 * Provides animated counter updates.
 */

import { orgGet, orgSet, getOrgKey } from './orgScopedStorage'

const CACHE_BASE_KEY = 'datapoints'
const CHANNEL_NAME = 'quox_datapoints_sync'

let broadcastChannel = null
let listeners = new Set()
let cachedCount = null
let lastUpdate = 0

// Clear cache on org switch so counts recalculate for new org
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', () => {
    cachedCount = null
    lastUpdate = 0
  })
}

// Issue 1.5: Track storage event listeners for cleanup
let storageListenerFallback = null
let storageListenerWatcher = null

// CLARITY-CONSOLE-8: module-level debounce handle — never stored in localStorage or window
let _dpRefreshTimeout = null

// Initialize broadcast channel for cross-tab sync
function initBroadcastChannel() {
  if (broadcastChannel) return

  try {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME)
    broadcastChannel.onmessage = (event) => {
      if (event.data.type === 'datapoints_update') {
        cachedCount = event.data.count
        lastUpdate = event.data.timestamp
        notifyListeners(cachedCount, event.data.delta)
      }
    }
  } catch (e) {
    // BroadcastChannel not supported, fall back to storage events
    // Issue 1.5: Store listener reference for cleanup
    if (storageListenerFallback) {
      window.removeEventListener('storage', storageListenerFallback)
    }
    storageListenerFallback = (e) => {
      if (e.key === getOrgKey(CACHE_BASE_KEY)) {
        try {
          const data = JSON.parse(e.newValue || '{}')
          if (data.count != null && data.count !== cachedCount) {
            const delta = data.count - (cachedCount || 0)
            cachedCount = data.count
            notifyListeners(cachedCount, delta)
          }
        } catch { /* ignore corrupt/null storage values from other tabs */ }
      }
    }
    window.addEventListener('storage', storageListenerFallback)
  }
}

// Notify all listeners of count change
function notifyListeners(count, delta = 0) {
  listeners.forEach(fn => fn(count, delta))
}

/**
 * Count datapoints from localStorage-based stores
 */
function countLocalStorageItems(key, countFn = null) {
  try {
    const data = localStorage.getItem(key)
    if (!data) return 0
    const parsed = JSON.parse(data)
    if (countFn) return countFn(parsed)
    if (Array.isArray(parsed)) return parsed.length
    if (typeof parsed === 'object') return Object.keys(parsed).length
    return 0
  } catch {
    return 0
  }
}

/**
 * Calculate total datapoints across all sources
 */
export function calculateDatapoints() {
  let total = 0

  // Memory system
  total += countLocalStorageItems('quox_memory_episodic')
  total += countLocalStorageItems('quox_memory_semantic')
  total += countLocalStorageItems('quox_memory_entities')
  total += countLocalStorageItems('quox_memory_learned')
  total += countLocalStorageItems('quox_memory_profile', (p) => {
    // Count profile preferences
    let count = 0
    if (p.preferences) count += Object.keys(p.preferences).length
    if (p.facts) count += p.facts.length
    return count
  })

  // Working Set Memory
  total += countLocalStorageItems('quox_wsm_recent_entities')
  total += countLocalStorageItems('quox_wsm_open_loops')
  total += countLocalStorageItems('quox_wsm_context_threads')

  // Files
  total += countLocalStorageItems('quox_files')
  total += countLocalStorageItems('quox_folders')

  // Conversations (AEE envelopes) - Note: AEE uses IndexedDB, not localStorage
  // The actual count is fetched asynchronously; this is a fallback estimate
  // Real count comes from getStats() in aee/store.js
  total += countLocalStorageItems('quox_conversations', (c) => {
    // Count individual messages across conversations
    if (!c) return 0
    return Object.values(c).reduce((sum, conv) => {
      return sum + (conv.messages?.length || 0)
    }, 0)
  })

  // Activity/audit log
  total += countLocalStorageItems('quox_activity_log')

  // Workflow executions
  total += countLocalStorageItems('quox_workflow_history')

  // Entity registry
  total += countLocalStorageItems('quox_entity_registry')

  // Style engine samples
  total += countLocalStorageItems('quox_style_samples')

  // Imported data (ChatGPT imports, etc.)
  total += countLocalStorageItems('quox_imported_conversations')

  // Vector embeddings count (if tracked)
  total += countLocalStorageItems('quox_vector_count', (v) => v?.count || 0)

  // Plugin data
  total += countLocalStorageItems('quox_plugin_data', (p) => {
    if (!p) return 0
    return Object.values(p).reduce((sum, plugin) => {
      return sum + (typeof plugin === 'object' ? Object.keys(plugin).length : 0)
    }, 0)
  })

  return total
}

/**
 * Get current datapoints count (cached for performance)
 */
export function getDatapoints() {
  const now = Date.now()
  // Recalculate every 2 seconds max
  if (cachedCount === null || now - lastUpdate > 2000) {
    cachedCount = calculateDatapoints()
    lastUpdate = now

    // Persist to storage for cross-tab sync
    try {
      orgSet(CACHE_BASE_KEY, JSON.stringify({
        count: cachedCount,
        timestamp: lastUpdate
      }))
    } catch {}
  }
  return cachedCount
}

/**
 * Force recalculate and broadcast update
 */
export function refreshDatapoints() {
  const oldCount = cachedCount || 0
  cachedCount = calculateDatapoints()
  lastUpdate = Date.now()
  const delta = cachedCount - oldCount

  // Broadcast to other tabs
  if (broadcastChannel) {
    broadcastChannel.postMessage({
      type: 'datapoints_update',
      count: cachedCount,
      delta,
      timestamp: lastUpdate
    })
  }

  // Persist
  try {
    orgSet(CACHE_BASE_KEY, JSON.stringify({
      count: cachedCount,
      timestamp: lastUpdate
    }))
  } catch {}

  // Notify local listeners
  if (delta !== 0) {
    notifyListeners(cachedCount, delta)
  }

  return cachedCount
}

/**
 * Subscribe to datapoint changes
 * @param {function} callback - Called with (count, delta) on changes
 * @returns {function} Unsubscribe function
 */
export function subscribeToDatapoints(callback) {
  initBroadcastChannel()
  listeners.add(callback)

  // Immediately call with current count
  callback(getDatapoints(), 0)

  return () => {
    listeners.delete(callback)
  }
}

/**
 * Hook into storage changes to auto-refresh
 */
export function initDatapointsWatcher() {
  initBroadcastChannel()

  // Watch for localStorage changes (from this tab).
  // Use Object.defineProperty with enumerable:false so the patched function
  // does NOT appear as a key in Object.keys(localStorage) — fixing the
  // CLARITY-CONSOLE-8 "setItem" ghost key visible in browser DevTools.
  const originalSetItem = localStorage.setItem.bind(localStorage)
  Object.defineProperty(localStorage, 'setItem', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function(key, value) {
      originalSetItem(key, value)

      // If it's a data store key, schedule refresh
      if (key.startsWith('quox_') && key !== getOrgKey(CACHE_BASE_KEY)) {
        // Debounce refreshes — use module-level handle, NOT localStorage or window
        clearTimeout(_dpRefreshTimeout)
        _dpRefreshTimeout = setTimeout(() => {
          refreshDatapoints()
        }, 500)
      }
    },
  })

  // Also watch for storage events from other tabs
  // Issue 1.5: Store listener reference for cleanup
  if (storageListenerWatcher) {
    window.removeEventListener('storage', storageListenerWatcher)
  }
  storageListenerWatcher = (e) => {
    if (e.key?.startsWith('quox_') && e.key !== getOrgKey(CACHE_BASE_KEY)) {
      clearTimeout(_dpRefreshTimeout)
      _dpRefreshTimeout = setTimeout(() => {
        refreshDatapoints()
      }, 500)
    }
  }
  window.addEventListener('storage', storageListenerWatcher)
}

/**
 * Cleanup datapoints watcher - Issue 1.5 fix
 * Removes event listeners to prevent memory leaks
 */
export function cleanupDatapointsWatcher() {
  if (storageListenerFallback) {
    window.removeEventListener('storage', storageListenerFallback)
    storageListenerFallback = null
  }
  if (storageListenerWatcher) {
    window.removeEventListener('storage', storageListenerWatcher)
    storageListenerWatcher = null
  }
  if (broadcastChannel) {
    broadcastChannel.close()
    broadcastChannel = null
  }
  listeners.clear()
}

// Watcher is no longer auto-initialized at module scope.
// Call initDatapointsWatcher() after org context is available
// (e.g. from AppShell or a top-level component).

export default {
  getDatapoints,
  refreshDatapoints,
  subscribeToDatapoints,
  calculateDatapoints,
  cleanupDatapointsWatcher,
  initDatapointsWatcher
}
