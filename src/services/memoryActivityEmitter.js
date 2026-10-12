/**
 * Memory Activity Emitter
 *
 * Lightweight pub/sub for memory bridge events.
 * UI hooks (useMemoryActivity) subscribe to this emitter
 * to show real-time memory activity in the terminal chat sidebar.
 *
 * Pattern: same approach as inboxEvents.js — service-layer emitter
 * that React hooks subscribe to via on-mount/on-unmount.
 */

// ── Event Types ─────────────────────────────────────────────────────

export const EVENT_TYPES = {
  ENTITY_STORED: 'entity_stored',
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  ERROR_TRACKED: 'error_tracked',
  RESOLUTION_STORED: 'resolution_stored',
  COMMAND_RECORDED: 'command_recorded',
  FOCUS_UPDATED: 'focus_updated',
  UPGRADE_BLOCKED: 'upgrade_blocked',
}

// ── Configuration ───────────────────────────────────────────────────

const MAX_BUFFER_SIZE = 30
const UPGRADE_RATE_LIMIT_MS = 60000 // 1 upgrade event per feature per 60s

// ── State ───────────────────────────────────────────────────────────

const subscribers = new Set()
const eventBuffer = []
const upgradeTimestamps = {} // { featureName: lastTimestamp }

// ── Public API ──────────────────────────────────────────────────────

/**
 * Subscribe to memory activity events.
 * @param {function} callback - Called with event object on each emit
 * @returns {function} Unsubscribe function
 */
export function subscribe(callback) {
  subscribers.add(callback)
  return () => subscribers.delete(callback)
}

/**
 * Unsubscribe from memory activity events.
 * @param {function} callback - The callback to remove
 */
export function unsubscribe(callback) {
  subscribers.delete(callback)
}

/**
 * Emit a memory activity event.
 * @param {string} type - One of EVENT_TYPES
 * @param {object} detail - Event-specific data
 * @param {boolean} [isPremium=false] - Whether this is a premium-only event
 */
export function emit(type, detail = {}, isPremium = false) {
  // Rate-limit UPGRADE_BLOCKED events per feature
  if (type === EVENT_TYPES.UPGRADE_BLOCKED) {
    const feature = detail.feature || 'unknown'
    const now = Date.now()
    const lastEmit = upgradeTimestamps[feature] || 0
    if (now - lastEmit < UPGRADE_RATE_LIMIT_MS) return
    upgradeTimestamps[feature] = now
  }

  const event = {
    type,
    detail,
    isPremium,
    timestamp: Date.now(),
  }

  // Add to buffer (trim to max size)
  eventBuffer.push(event)
  if (eventBuffer.length > MAX_BUFFER_SIZE) {
    eventBuffer.shift()
  }

  // Notify all subscribers
  for (const callback of subscribers) {
    try {
      callback(event)
    } catch {
      // Subscriber error should not break emitter
    }
  }
}

/**
 * Get current event buffer (for initial state on subscribe).
 * @returns {Array} Copy of the event buffer
 */
export function getEvents() {
  return [...eventBuffer]
}

/**
 * Clear the event buffer.
 */
export function clearEvents() {
  eventBuffer.length = 0
}

/**
 * Get subscriber count (for testing).
 * @returns {number}
 */
export function getSubscriberCount() {
  return subscribers.size
}

export default {
  EVENT_TYPES,
  subscribe,
  unsubscribe,
  emit,
  getEvents,
  clearEvents,
  getSubscriberCount,
}
