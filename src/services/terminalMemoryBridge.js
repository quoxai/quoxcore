/**
 * Terminal Memory Bridge Service
 *
 * Connects terminal sessions to the memory system:
 * - Extracts entities (hosts, IPs, services) from terminal output
 * - Tracks session lifecycle (connect/disconnect)
 * - Records error→resolution pairs as learned items (premium)
 * - Records command executions as decisions (premium)
 * - Updates WSM focus on workspace/tab changes (premium)
 *
 * Pattern: follows fileMemoryBridge.js — pure service, no React.
 * Premium features require the Advanced Memory Plugin ($99 one-time).
 */

import { getMemoryManager } from './memoryManager'
import { touchEntity, setCurrentFocus, addOpenLoop, recordDecision } from './workingSetMemory'
import { hasFeature, createUpgradePrompt } from './memoryTier'
import { isPluginEnabled } from './pluginClient'
import { emit, EVENT_TYPES } from './memoryActivityEmitter'

// localStorage key for session tracking
const SESSIONS_KEY = 'quox_terminal_sessions'

// Max error line length to store (truncate for safety)
const MAX_ERROR_LINE = 200

// ============================================================================
// TIER GATING
// ============================================================================

/**
 * Check if premium terminal memory features are available.
 * Premium requires the Advanced Memory plugin.
 * @returns {Promise<boolean>}
 */
export async function isPremiumTerminalMemory() {
  try {
    return await isPluginEnabled('advanced-memory')
  } catch {
    return false
  }
}

/**
 * Synchronous check using memoryTier feature flags.
 * @returns {boolean}
 */
function hasPremiumSync() {
  return hasFeature('hasWSM')
}

// ============================================================================
// SESSION LIFECYCLE
// ============================================================================

/**
 * Track a terminal session start.
 * Free: stores session entity, touches host entity.
 * Premium: also sets WSM current focus.
 *
 * @param {string} hostId - Host identifier (e.g. 'docker01' or 'local')
 * @param {string} sessionId - Terminal session ID
 * @param {string} mode - 'local' or 'ssh'
 */
export function trackSessionStart(hostId, sessionId, mode) {
  try {
    const mm = getMemoryManager()
    if (!mm) return

    const now = new Date().toISOString()

    // Store session entity (free)
    mm.storeEntity({
      type: 'terminal_session',
      name: sessionId,
      attributes: {
        hostId: hostId || 'local',
        mode,
        connectedAt: now,
        status: 'active'
      }
    })

    // Touch host entity (free)
    touchEntity({
      type: 'host',
      id: hostId || 'local',
      name: hostId || 'local',
      context: { lastTerminalSession: now }
    })

    // Track locally for metrics
    _trackSessionLocally(sessionId, hostId, mode)

    // Premium: set WSM focus
    if (hasPremiumSync()) {
      setCurrentFocus({
        task: `Terminal on ${hostId || 'local'}`,
        goal: `${mode === 'ssh' ? 'SSH' : 'Local'} session active`
      })
    }

    emit(EVENT_TYPES.SESSION_START, { hostId: hostId || 'local', mode })
    console.log(`[TerminalMemoryBridge] Session started: ${sessionId} on ${hostId || 'local'}`)
  } catch (err) {
    console.warn('[TerminalMemoryBridge] Failed to track session start:', err)
  }
}

/**
 * Track a terminal session end.
 * Updates session entity status to 'disconnected'.
 *
 * @param {string} sessionId - Terminal session ID
 */
export function trackSessionEnd(sessionId) {
  try {
    const mm = getMemoryManager()
    if (!mm) return

    mm.storeEntity({
      type: 'terminal_session',
      name: sessionId,
      attributes: {
        status: 'disconnected',
        disconnectedAt: new Date().toISOString()
      }
    })

    _updateSessionLocally(sessionId, 'disconnected')

    emit(EVENT_TYPES.SESSION_END, { sessionId })
    console.log(`[TerminalMemoryBridge] Session ended: ${sessionId}`)
  } catch (err) {
    console.warn('[TerminalMemoryBridge] Failed to track session end:', err)
  }
}

// ============================================================================
// ENTITY EXTRACTION
// ============================================================================

/**
 * Extract entities (hosts, IPs, services, containers, ports) from terminal output.
 * Stores each entity and touches it in WSM.
 *
 * @param {string} cleanOutput - ANSI-stripped terminal output
 * @returns {Array<{type: string, value: string}>} Extracted entities
 */
export function extractEntitiesFromOutput(cleanOutput) {
  if (!cleanOutput || cleanOutput.length < 5) return []

  try {
    const mm = getMemoryManager()
    if (!mm) return []

    // Use the memory manager's built-in entity extraction
    const entities = mm.extractEntities ? mm.extractEntities(cleanOutput) : []

    // Store each extracted entity
    for (const entity of entities) {
      try {
        mm.storeEntity({
          type: entity.type,
          name: entity.value || entity.name,
          attributes: {
            source: 'terminal',
            detectedAt: new Date().toISOString()
          }
        })

        touchEntity({
          type: entity.type,
          id: entity.value || entity.name,
          name: entity.value || entity.name,
          context: { source: 'terminal' }
        })

        emit(EVENT_TYPES.ENTITY_STORED, { type: entity.type, name: entity.value || entity.name })
      } catch {
        // Individual entity storage failure — continue
      }
    }

    return entities
  } catch (err) {
    console.warn('[TerminalMemoryBridge] Entity extraction failed:', err)
    return []
  }
}

// ============================================================================
// ERROR TRACKING
// ============================================================================

/**
 * Record a detected terminal error in memory.
 * Free: stores error entity.
 * Premium: also creates an open loop.
 *
 * @param {Object} error - Error object from detectTerminalError()
 * @param {string} error.errorType - Error type identifier
 * @param {string} error.errorLine - The error line text
 * @param {string|null} hostId - Host where the error occurred
 */
export function recordDetectedError(error, hostId) {
  if (!error) return

  try {
    const mm = getMemoryManager()
    if (!mm) return

    const truncatedLine = (error.errorLine || '').slice(0, MAX_ERROR_LINE)

    // Store error entity (free)
    mm.storeEntity({
      type: 'error',
      name: `${error.errorType}_${Date.now()}`,
      attributes: {
        errorType: error.errorType,
        errorLine: truncatedLine,
        hostId: hostId || 'local',
        source: 'terminal',
        detectedAt: new Date().toISOString()
      }
    })

    // Premium: create an open loop for unresolved errors
    if (hasPremiumSync()) {
      addOpenLoop({
        type: 'task',
        description: `${error.errorType} on ${hostId || 'local'}: ${truncatedLine}`,
        priority: 'medium'
      })
    }

    emit(EVENT_TYPES.ERROR_TRACKED, { errorType: error.errorType, hostId: hostId || 'local' })
    console.log(`[TerminalMemoryBridge] Error recorded: ${error.errorType}`)
  } catch (err) {
    console.warn('[TerminalMemoryBridge] Failed to record error:', err)
  }
}

/**
 * Record an error resolution (error + AI explanation).
 * Premium only: stores as a learned item of type 'error'.
 * Free: returns upgrade prompt.
 *
 * @param {Object} error - The original error object
 * @param {string} aiResponse - The AI's explanation/resolution
 * @param {string|null} hostId - Host where the error occurred
 * @returns {{ stored: boolean, blocked?: boolean, upgrade?: Object }}
 */
export function recordErrorResolution(error, aiResponse, hostId) {
  if (!error || !aiResponse) return { stored: false }

  // Premium only
  if (!hasPremiumSync()) {
    emit(EVENT_TYPES.UPGRADE_BLOCKED, { feature: 'resolution' })
    return {
      stored: false,
      blocked: true,
      upgrade: createUpgradePrompt('terminalMemory')
    }
  }

  try {
    const mm = getMemoryManager()
    if (!mm) return { stored: false }

    const truncatedLine = (error.errorLine || '').slice(0, MAX_ERROR_LINE)
    const truncatedResponse = aiResponse.slice(0, 500)

    // addLearnedItem has built-in secret detection
    mm.addLearnedItem('error', {
      content: `Error ${error.errorType}: ${truncatedLine} — Resolution: ${truncatedResponse}`,
      tags: ['terminal', hostId || 'local', error.errorType],
      source: 'terminal-memory-bridge'
    })

    emit(EVENT_TYPES.RESOLUTION_STORED, { errorType: error.errorType }, true)
    console.log(`[TerminalMemoryBridge] Error resolution stored: ${error.errorType}`)
    return { stored: true }
  } catch (err) {
    console.warn('[TerminalMemoryBridge] Failed to record error resolution:', err)
    return { stored: false }
  }
}

// ============================================================================
// COMMAND TRACKING
// ============================================================================

/**
 * Record a command execution as a decision.
 * Premium only (uses WSM recordDecision).
 *
 * @param {string} command - The executed command text
 * @param {string|null} hostId - Host where the command was executed
 */
export function recordCommandExecution(command, hostId) {
  if (!command || !hasPremiumSync()) return

  try {
    recordDecision({
      decision: `Executed: ${command.slice(0, 200)}`,
      context: {
        hostId: hostId || 'local',
        source: 'terminal',
        executedAt: new Date().toISOString()
      }
    })
    emit(EVENT_TYPES.COMMAND_RECORDED, { command: command.slice(0, 80) }, true)
  } catch (err) {
    console.warn('[TerminalMemoryBridge] Failed to record command:', err)
  }
}

// ============================================================================
// FOCUS TRACKING
// ============================================================================

/**
 * Update WSM focus when terminal workspace/tab changes.
 * Premium only.
 *
 * @param {string} workspaceName - Active workspace name
 * @param {string|null} hostId - Current host
 */
export function updateTerminalFocus(workspaceName, hostId) {
  if (!hasPremiumSync()) return

  try {
    setCurrentFocus({
      task: `Workspace: ${workspaceName}`,
      goal: `Working on ${hostId || 'local'}`
    })
    emit(EVENT_TYPES.FOCUS_UPDATED, { workspace: workspaceName }, true)
  } catch (err) {
    console.warn('[TerminalMemoryBridge] Failed to update focus:', err)
  }
}

// ============================================================================
// METRICS
// ============================================================================

/**
 * Get terminal session metrics from local tracking.
 * Works for all tiers.
 *
 * @returns {{ totalSessions: number, activeSessions: number, uniqueHosts: number }}
 */
export function getTerminalMetrics() {
  try {
    const sessions = _getLocalSessions()
    const active = sessions.filter(s => s.status === 'active')
    const hosts = new Set(sessions.map(s => s.hostId))

    return {
      totalSessions: sessions.length,
      activeSessions: active.length,
      uniqueHosts: hosts.size
    }
  } catch {
    return { totalSessions: 0, activeSessions: 0, uniqueHosts: 0 }
  }
}

// ============================================================================
// PRIVATE: LOCAL SESSION TRACKING
// ============================================================================

function _trackSessionLocally(sessionId, hostId, mode) {
  try {
    const sessions = _getLocalSessions()
    sessions.push({
      sessionId,
      hostId: hostId || 'local',
      mode,
      status: 'active',
      connectedAt: new Date().toISOString()
    })
    // Keep only last 50 sessions
    const trimmed = sessions.slice(-50)
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(trimmed))
  } catch {
    // localStorage may be unavailable
  }
}

function _updateSessionLocally(sessionId, status) {
  try {
    const sessions = _getLocalSessions()
    const session = sessions.find(s => s.sessionId === sessionId)
    if (session) {
      session.status = status
      session.disconnectedAt = new Date().toISOString()
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
    }
  } catch {
    // localStorage may be unavailable
  }
}

function _getLocalSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  isPremiumTerminalMemory,
  trackSessionStart,
  trackSessionEnd,
  extractEntitiesFromOutput,
  recordDetectedError,
  recordErrorResolution,
  recordCommandExecution,
  updateTerminalFocus,
  getTerminalMetrics
}
