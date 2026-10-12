/**
 * Audit Logger Service
 * Logs all operations for accountability and review
 *
 * Security Issue #69: Moved from localStorage to server-side storage
 * All audit events are now sent to the backend API for tamper-evident storage.
 */

import { csrfFetch } from '../utils/csrfFetch'
import { buildAuthApiUrl } from './authApiUrl'

// Development org ID - matches DEV_ORG_ID in services/auth/routes/setup.js
const DEV_ORG_ID = '01DEV000000000000000000002'

/**
 * Get the API URL
 */
function getApiUrl(path) {
  return buildAuthApiUrl(path)
}

/**
 * Get current organization ID from context
 */
function getOrgId() {
  if (typeof localStorage === 'undefined') return DEV_ORG_ID

  // Try to get from localStorage org context
  const orgContext = localStorage.getItem('quox-org-context')
  if (orgContext) {
    try {
      const parsed = JSON.parse(orgContext)
      if (parsed.orgId) return parsed.orgId
      if (parsed.id) return parsed.id
    } catch {
      // Fall through
    }
  }

  // Try auth context as backup
  const authContext = localStorage.getItem('quox-auth-context')
  if (authContext) {
    try {
      const parsed = JSON.parse(authContext)
      if (parsed.org?.id) return parsed.org.id
    } catch {
      // Fall through
    }
  }

  // Development fallback
  return DEV_ORG_ID
}

/**
 * Make an authenticated API request to create an audit event
 */
async function createAuditEvent(eventData) {
  const orgId = getOrgId()
  const url = getApiUrl(`/orgs/${orgId}/audit`)

  try {
    const response = await csrfFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventData)
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }))
      console.warn('[Audit] Failed to log event:', error.error || error.message)
      return null
    }

    return await response.json()
  } catch (err) {
    // Log to console if API call fails - audit should not crash the app
    console.warn('[Audit] Failed to send event:', err.message)
    return null
  }
}

/**
 * Fetch audit events from the backend
 */
async function fetchAuditEvents(options = {}) {
  const orgId = getOrgId()
  const params = new URLSearchParams()

  if (options.limit) params.set('limit', options.limit.toString())
  if (options.offset) params.set('offset', options.offset.toString())
  if (options.action) params.set('action', options.action)
  if (options.from_date) params.set('from_date', options.from_date)
  if (options.to_date) params.set('to_date', options.to_date)
  if (options.status) params.set('status', options.status)

  const url = getApiUrl(`/orgs/${orgId}/audit?${params}`)

  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error('Failed to fetch audit events')
    }

    return await response.json()
  } catch (err) {
    console.error('[Audit] Failed to fetch events:', err.message)
    return { events: [], pagination: { total: 0 } }
  }
}

/**
 * Generate unique ID (for local reference only)
 * @returns {string} Unique ID
 */
function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Log an operation
 * @param {object} entry - Audit entry data
 * @returns {Promise<object|null>} Created entry or null if failed
 */
export async function logOperation(entry) {
  const localId = generateId()

  const eventData = {
    action: 'frontend.operation',
    operation: entry.operation || 'unknown',
    query: entry.query || '',
    targets: entry.targets || [],
    status: entry.result === 'success' ? 'success' :
            entry.result === 'failed' ? 'failure' :
            entry.result === 'blocked' ? 'blocked' :
            entry.result === 'dry-run' ? 'dry_run' : 'success',
    defconLevel: entry.defconLevel || 'GREEN',
    metadata: {
      operator: entry.operator || 'unknown',
      approved: entry.approved !== false,
      approvedBy: entry.approvedBy || null,
      authCode: entry.authCode || null,
      duration: entry.duration || 0,
      ...entry.metadata
    }
  }

  console.log('[Audit]', eventData.operation, '-', eventData.status)

  // Send to backend asynchronously
  const result = await createAuditEvent(eventData)

  // Return a local representation for immediate use
  return {
    id: result?.id || localId,
    timestamp: new Date().toISOString(),
    operator: entry.operator || 'unknown',
    operation: entry.operation || 'unknown',
    query: entry.query || '',
    targets: entry.targets || [],
    defconLevel: entry.defconLevel || 'GREEN',
    approved: entry.approved !== false,
    approvedBy: entry.approvedBy || null,
    authCode: entry.authCode || null,
    result: entry.result || 'pending',
    duration: entry.duration || 0,
    metadata: entry.metadata || {}
  }
}

/**
 * Log a blocked operation
 * @param {object} entry - Entry data
 * @returns {Promise<object|null>} Created entry or null if failed
 */
export async function logBlocked(entry) {
  const eventData = {
    action: 'frontend.operation.blocked',
    operation: `BLOCKED: ${entry.operation || entry.query}`,
    query: entry.query || '',
    targets: entry.targets || [],
    status: 'blocked',
    defconLevel: entry.defconLevel || 'RED',
    metadata: {
      operator: entry.operator || 'unknown',
      approved: false,
      ...entry.metadata
    }
  }

  console.log('[Audit] BLOCKED:', eventData.operation)

  const result = await createAuditEvent(eventData)

  return {
    id: result?.id || generateId(),
    timestamp: new Date().toISOString(),
    operator: entry.operator || 'unknown',
    operation: eventData.operation,
    query: entry.query || '',
    targets: entry.targets || [],
    defconLevel: entry.defconLevel || 'RED',
    approved: false,
    result: 'blocked',
    metadata: entry.metadata || {}
  }
}

/**
 * Log a dry-run operation
 * @param {object} entry - Entry data
 * @returns {Promise<object|null>} Created entry or null if failed
 */
export async function logDryRun(entry) {
  const eventData = {
    action: 'frontend.operation.dry_run',
    operation: `DRY RUN: ${entry.operation || entry.query}`,
    query: entry.query || '',
    targets: entry.targets || [],
    status: 'dry_run',
    defconLevel: entry.defconLevel || 'GREEN',
    metadata: {
      operator: entry.operator || 'unknown',
      dryRun: true,
      ...entry.metadata
    }
  }

  console.log('[Audit] DRY RUN:', eventData.operation)

  const result = await createAuditEvent(eventData)

  return {
    id: result?.id || generateId(),
    timestamp: new Date().toISOString(),
    operator: entry.operator || 'unknown',
    operation: eventData.operation,
    query: entry.query || '',
    targets: entry.targets || [],
    defconLevel: entry.defconLevel || 'GREEN',
    result: 'dry-run',
    metadata: { ...entry.metadata, dryRun: true }
  }
}

/**
 * Update an existing audit entry
 * Note: Server-side audit logs are append-only for tamper-evidence.
 * This function logs a follow-up event instead of modifying the original.
 * @param {string} id - Entry ID
 * @param {object} updates - Fields to update
 * @returns {Promise<object|null>} New entry or null
 */
export async function updateEntry(id, updates) {
  // Log a follow-up event with the update
  return logOperation({
    operation: `UPDATE: ${updates.operation || 'entry update'}`,
    query: `Update to entry ${id}`,
    result: updates.result || 'success',
    metadata: {
      originalEntryId: id,
      updates
    }
  })
}

/**
 * Get recent entries from the server
 * @param {number} count - Number of entries to return
 * @returns {Promise<object[]>} Recent entries
 */
export async function getRecentEntries(count = 50) {
  const result = await fetchAuditEvents({
    limit: count,
    action: 'frontend.operation'
  })

  // Transform to legacy format for compatibility
  return (result.events || []).map(transformEvent)
}

/**
 * Get audit log (all frontend events)
 * @returns {Promise<object[]>} Audit log entries
 */
export async function getAuditLog() {
  const result = await fetchAuditEvents({ limit: 500 })
  return (result.events || []).map(transformEvent)
}

/**
 * Transform server event to legacy format
 */
function transformEvent(event) {
  const metadata = event.metadata || {}
  return {
    id: event.id,
    timestamp: event.created_at,
    operator: metadata.operator || event.actor_id || 'unknown',
    operation: metadata.operation || event.action,
    query: metadata.query || '',
    targets: metadata.targets || [],
    defconLevel: metadata.defconLevel || 'GREEN',
    approved: metadata.approved !== false,
    approvedBy: metadata.approvedBy || null,
    authCode: metadata.authCode || null,
    result: event.status === 'blocked' ? 'blocked' :
            event.status === 'dry_run' ? 'dry-run' :
            event.status === 'failure' ? 'failed' : 'success',
    duration: metadata.duration || 0,
    metadata: metadata
  }
}

/**
 * Get entries by date range
 * @param {Date} start - Start date
 * @param {Date} end - End date
 * @returns {Promise<object[]>} Matching entries
 */
export async function getEntriesByDateRange(start, end) {
  const result = await fetchAuditEvents({
    from_date: start.toISOString(),
    to_date: end.toISOString(),
    limit: 500
  })
  return (result.events || []).map(transformEvent)
}

/**
 * Get entries by DEFCON level
 * Note: This requires filtering on the client side since DEFCON is in metadata
 * @param {string} level - DEFCON level
 * @returns {Promise<object[]>} Matching entries
 */
export async function getEntriesByDefcon(level) {
  const entries = await getAuditLog()
  return entries.filter(e => e.defconLevel === level)
}

/**
 * Get blocked entries
 * @returns {Promise<object[]>} Blocked entries
 */
export async function getBlockedEntries() {
  const result = await fetchAuditEvents({
    status: 'blocked',
    limit: 500
  })
  return (result.events || []).map(transformEvent)
}

/**
 * Get statistics
 * @returns {Promise<object>} Audit statistics
 */
export async function getStats() {
  const log = await getAuditLog()

  const stats = {
    total: log.length,
    success: log.filter(e => e.result === 'success').length,
    failed: log.filter(e => e.result === 'failed').length,
    blocked: log.filter(e => e.result === 'blocked').length,
    dryRun: log.filter(e => e.result === 'dry-run').length,
    byDefcon: {
      GREEN: log.filter(e => e.defconLevel === 'GREEN').length,
      BLUE: log.filter(e => e.defconLevel === 'BLUE').length,
      AMBER: log.filter(e => e.defconLevel === 'AMBER').length,
      ORANGE: log.filter(e => e.defconLevel === 'ORANGE').length,
      RED: log.filter(e => e.defconLevel === 'RED').length
    }
  }

  // Today's stats
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayEntries = log.filter(e => new Date(e.timestamp) >= today)

  stats.today = {
    total: todayEntries.length,
    success: todayEntries.filter(e => e.result === 'success').length,
    blocked: todayEntries.filter(e => e.result === 'blocked').length
  }

  return stats
}

/**
 * Export audit log as JSON
 * @returns {Promise<string>} JSON string
 */
export async function exportLog() {
  const log = await getAuditLog()
  return JSON.stringify(log, null, 2)
}

/**
 * Clear audit log (requires confirmation)
 * Note: Server-side audit logs cannot be cleared for security/compliance.
 * This function is disabled.
 * @param {string} confirmCode - Must be 'CLEAR-AUDIT'
 * @returns {boolean} Always returns false
 */
export function clearLog(confirmCode) {
  console.warn('[Audit] Clearing audit logs is disabled for security. Audit logs are tamper-evident and append-only.')
  return false
}

/**
 * Search audit log
 * @param {string} query - Search query
 * @returns {Promise<object[]>} Matching entries
 */
export async function searchLog(query) {
  const log = await getAuditLog()
  const lowerQuery = query.toLowerCase()

  return log.filter(e =>
    (e.query || '').toLowerCase().includes(lowerQuery) ||
    (e.operation || '').toLowerCase().includes(lowerQuery) ||
    (e.operator || '').toLowerCase().includes(lowerQuery) ||
    (e.targets || []).some(t => t.toLowerCase().includes(lowerQuery))
  )
}

export default {
  logOperation,
  logBlocked,
  logDryRun,
  updateEntry,
  getAuditLog,
  getRecentEntries,
  getEntriesByDateRange,
  getEntriesByDefcon,
  getBlockedEntries,
  getStats,
  exportLog,
  clearLog,
  searchLog
}
