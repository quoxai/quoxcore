/**
 * Assistant Storage Service
 *
 * Handles persistence of assistant settings to server and localStorage.
 * Supports sync between browser and server, backup/restore, and versioning.
 */

import { personalGet, personalSet, personalRemove } from './orgScopedStorage'

const COLLECTOR_URL = '/collector'
const SYNC_INTERVAL_MS = 60000 // 1 minute
const STORAGE_QUOTA_MB = 5 // 5MB localStorage quota per origin

let syncIntervalId = null
let pendingChanges = new Set()

// Sync metrics tracking — lazy-loaded on first access
let syncMetrics = null

// Clear caches on org switch so data reloads from new org's namespace
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', () => {
    syncMetrics = null
    pendingChanges = new Set()
  })
}

function getSyncMetrics() {
  if (!syncMetrics) {
    syncMetrics = {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      lastSyncTime: null,
      lastSyncSuccess: null,
      lastError: null
    }
    try {
      const stored = personalGet('assistant-sync')
      if (stored) {
        syncMetrics = { ...syncMetrics, ...JSON.parse(stored) }
      }
    } catch (e) { /* ignore */ }
  }
  return syncMetrics
}

function saveSyncMetrics() {
  try {
    personalSet('assistant-sync', JSON.stringify(getSyncMetrics()))
  } catch (e) { /* ignore */ }
}

/**
 * Load assistant overrides from localStorage
 */
export function loadLocal() {
  try {
    const stored = personalGet('assistant-overrides')
    return stored ? JSON.parse(stored) : {}
  } catch (err) {
    console.warn('[AssistantStorage] Failed to load local:', err)
    return {}
  }
}

/**
 * Save assistant overrides to localStorage
 */
export function saveLocal(overrides) {
  try {
    personalSet('assistant-overrides', JSON.stringify(overrides))
    return true
  } catch (err) {
    console.error('[AssistantStorage] Failed to save local:', err)
    return false
  }
}

/**
 * Load assistant overrides from server
 */
export async function loadFromServer() {
  try {
    const res = await fetch(`${COLLECTOR_URL}/assistants/overrides`)
    if (!res.ok) {
      if (res.status === 404) {
        return {} // No overrides stored on server yet
      }
      throw new Error(`Server returned ${res.status}`)
    }
    const data = await res.json()
    return data.overrides || {}
  } catch (err) {
    console.warn('[AssistantStorage] Failed to load from server:', err.message)
    return null // null indicates server error
  }
}

/**
 * Save assistant overrides to server
 */
export async function saveToServer(overrides) {
  try {
    const res = await fetch(`${COLLECTOR_URL}/assistants/overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides,
        timestamp: new Date().toISOString(),
        source: 'dashboard'
      })
    })

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`)
    }

    return true
  } catch (err) {
    console.warn('[AssistantStorage] Failed to save to server:', err.message)
    return false
  }
}

/**
 * Sync local changes to server
 */
export async function syncToServer() {
  if (pendingChanges.size === 0) {
    return { synced: 0 }
  }

  const local = loadLocal()
  const success = await saveToServer(local)

  const metrics = getSyncMetrics()
  metrics.totalSyncs++
  metrics.lastSyncTime = new Date().toISOString()

  if (success) {
    const count = pendingChanges.size
    pendingChanges.clear()
    metrics.successfulSyncs++
    metrics.lastSyncSuccess = true
    metrics.lastError = null
    saveSyncMetrics()
    console.log(`[AssistantStorage] Synced ${count} changes to server`)
    return { synced: count }
  }

  metrics.failedSyncs++
  metrics.lastSyncSuccess = false
  metrics.lastError = 'Failed to sync to server'
  saveSyncMetrics()
  return { synced: 0, error: 'Failed to sync to server' }
}

/**
 * Sync from server to local (pull)
 */
export async function syncFromServer() {
  const serverOverrides = await loadFromServer()
  if (serverOverrides === null) {
    return { success: false, error: 'Server unavailable' }
  }

  const local = loadLocal()

  // Merge strategy: server wins for keys not in pending changes
  const merged = { ...local }
  for (const [id, override] of Object.entries(serverOverrides)) {
    if (!pendingChanges.has(id)) {
      merged[id] = override
    }
  }

  saveLocal(merged)
  return { success: true, merged: Object.keys(merged).length }
}

/**
 * Mark an assistant as having pending changes
 */
export function markPending(assistantId) {
  pendingChanges.add(assistantId)
}

/**
 * Save a single assistant override
 */
export async function saveAssistant(assistantId, override, syncImmediately = false) {
  const overrides = loadLocal()
  overrides[assistantId] = {
    ...override,
    _updatedAt: new Date().toISOString()
  }

  const localSuccess = saveLocal(overrides)
  if (!localSuccess) {
    return { success: false, error: 'Failed to save locally' }
  }

  markPending(assistantId)

  if (syncImmediately) {
    const syncResult = await syncToServer()
    return { success: true, synced: syncResult.synced > 0 }
  }

  return { success: true, synced: false }
}

/**
 * Delete an assistant override
 */
export async function deleteAssistant(assistantId, syncImmediately = false) {
  const overrides = loadLocal()
  delete overrides[assistantId]

  const localSuccess = saveLocal(overrides)
  if (!localSuccess) {
    return { success: false, error: 'Failed to delete locally' }
  }

  markPending(assistantId)

  if (syncImmediately) {
    await syncToServer()
  }

  return { success: true }
}

/**
 * Reset all assistant overrides
 */
export async function resetAll(syncImmediately = false) {
  personalRemove('assistant-overrides')
  pendingChanges.clear()

  if (syncImmediately) {
    await saveToServer({})
  }

  return { success: true }
}

/**
 * Export all assistant settings for backup
 */
export function exportSettings() {
  const overrides = loadLocal()
  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    overrides
  }, null, 2)
}

/**
 * Import assistant settings from backup
 */
export async function importSettings(jsonString) {
  try {
    const data = JSON.parse(jsonString)

    if (!data.overrides) {
      return { success: false, error: 'Invalid backup format: missing overrides' }
    }

    // Validate each override
    for (const [id, override] of Object.entries(data.overrides)) {
      if (typeof override !== 'object') {
        return { success: false, error: `Invalid override for ${id}` }
      }
    }

    // Merge with existing (imported settings win)
    const existing = loadLocal()
    const merged = { ...existing, ...data.overrides }

    saveLocal(merged)

    // Mark all imported as pending
    for (const id of Object.keys(data.overrides)) {
      markPending(id)
    }

    return { success: true, imported: Object.keys(data.overrides).length }
  } catch (err) {
    return { success: false, error: `Parse error: ${err.message}` }
  }
}

/**
 * Get storage usage statistics
 * @returns {object} Storage usage info
 */
export function getStorageUsage() {
  const data = loadLocal()
  const jsonStr = JSON.stringify(data)
  const used = new Blob([jsonStr]).size
  const max = STORAGE_QUOTA_MB * 1024 * 1024 // Convert MB to bytes

  // Calculate total localStorage usage
  let totalUsed = 0
  try {
    for (const key of Object.keys(localStorage)) {
      totalUsed += localStorage.getItem(key)?.length || 0
    }
    totalUsed *= 2 // UTF-16 encoding = 2 bytes per char
  } catch (e) { /* ignore */ }

  return {
    used,
    usedFormatted: used > 1024 ? `${(used / 1024).toFixed(1)} KB` : `${used} B`,
    max,
    maxFormatted: `${STORAGE_QUOTA_MB} MB`,
    totalUsed,
    totalUsedFormatted: totalUsed > 1024 * 1024
      ? `${(totalUsed / (1024 * 1024)).toFixed(2)} MB`
      : `${(totalUsed / 1024).toFixed(1)} KB`,
    percentUsed: Math.round((totalUsed / max) * 100),
    assistantCount: Object.keys(data || {}).length
  }
}

/**
 * Get sync status
 */
export function getSyncStatus() {
  const metrics = getSyncMetrics()
  const successRate = metrics.totalSyncs > 0
    ? Math.round((metrics.successfulSyncs / metrics.totalSyncs) * 100)
    : 100

  return {
    pendingCount: pendingChanges.size,
    pendingIds: Array.from(pendingChanges),
    pendingChanges: pendingChanges.size, // Alias for cognitiveTopologyService
    syncActive: syncIntervalId !== null,
    // New metrics for continuity anchor
    syncCount: metrics.totalSyncs,
    successfulSyncs: metrics.successfulSyncs,
    failedSyncs: metrics.failedSyncs,
    lastSync: metrics.lastSyncTime,
    lastSyncSuccess: metrics.lastSyncSuccess,
    lastError: metrics.lastError,
    successRate
  }
}

/**
 * Start background sync to server
 */
export function startBackgroundSync(intervalMs = SYNC_INTERVAL_MS) {
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
  }

  // Initial sync from server
  syncFromServer()

  // Periodic sync to server
  syncIntervalId = setInterval(syncToServer, intervalMs)

  console.log(`[AssistantStorage] Background sync started (interval: ${intervalMs}ms)`)
}

/**
 * Stop background sync
 */
export function stopBackgroundSync() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
    console.log('[AssistantStorage] Background sync stopped')
  }
}

/**
 * Get history of changes for an assistant
 */
export async function getHistory(assistantId) {
  try {
    const res = await fetch(`${COLLECTOR_URL}/assistants/${assistantId}/history`)
    if (!res.ok) {
      return []
    }
    const data = await res.json()
    return data.history || []
  } catch {
    return []
  }
}

/**
 * Restore an assistant to a previous version
 */
export async function restoreVersion(assistantId, version) {
  try {
    const res = await fetch(`${COLLECTOR_URL}/assistants/${assistantId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version })
    })

    if (!res.ok) {
      return { success: false, error: `Server returned ${res.status}` }
    }

    const data = await res.json()

    // Update local storage with restored version
    if (data.override) {
      const overrides = loadLocal()
      overrides[assistantId] = data.override
      saveLocal(overrides)
    }

    return { success: true, version: data.version }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

export default {
  loadLocal,
  saveLocal,
  loadFromServer,
  saveToServer,
  syncToServer,
  syncFromServer,
  markPending,
  saveAssistant,
  deleteAssistant,
  resetAll,
  exportSettings,
  importSettings,
  getSyncStatus,
  startBackgroundSync,
  stopBackgroundSync,
  getHistory,
  restoreVersion
}
