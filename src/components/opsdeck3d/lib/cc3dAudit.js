/**
 * CC3D Audit Logger — AEE envelope logging for Cognitive Core 3D interactions.
 *
 * V2-QFY-0: Every significant user interaction logged as an AEE envelope.
 * Intents follow quox.cc3d.* namespace. AOCL classification: Layer 1 (read-only).
 *
 * Usage:
 *   import { logCC3DEvent } from '../lib/cc3dAudit'
 *   logCC3DEvent('select', { entityType: 'agent', entityId: 'sentinel' })
 */
// Lazy imports — avoid pulling AEE into the CC3D chunk's initialization graph
let createEvent, storeEnvelope
try {
  createEvent = require('../../../lib/aee/envelope').createEvent
  storeEnvelope = require('../../../lib/aee/store').storeEnvelope
} catch { /* AEE not available */ }

const FROM = 'cc3d.viewer'
const SESSION_ID = `cc3d_${Date.now()}`

// Rate limiter — prevent spam from rapid interactions
const lastEventTime = {}
const MIN_INTERVAL_MS = {
  'quox.cc3d.navigate': 2000,   // Zone jumps can be rapid
  'quox.cc3d.select': 500,      // Click throttle
  'quox.cc3d.layer.toggle': 1000,
  'quox.cc3d.search': 3000,     // Search is already debounced
  'quox.cc3d.depth.change': 1000,
  'quox.cc3d.tour.start': 5000,
  'quox.cc3d.horus.alert': 10000, // Don't spam anomaly logs
}

/**
 * Log a CC3D interaction as an AEE envelope.
 * @param {'select'|'navigate'|'layer.toggle'|'search'|'depth.change'|'tour.start'|'horus.alert'} action
 * @param {Object} payload — event-specific data
 */
export function logCC3DEvent(action, payload = {}) {
  if (!createEvent || !storeEnvelope) return
  try {
    const intent = `quox.cc3d.${action}`
    const now = Date.now()
    const minInterval = MIN_INTERVAL_MS[intent] || 1000

    // Rate limit
    if (now - (lastEventTime[intent] || 0) < minInterval) return
    lastEventTime[intent] = now

    const envelope = createEvent(
      FROM,
      intent,
      {
        ...payload,
        timestamp: new Date().toISOString(),
        aoclLayer: 1,         // Layer 1: read-only observation
        aoclRisk: 'LOW',      // No write/delete actions
        aoclAutonomy: 'FULL', // No approval needed
      },
      SESSION_ID,
    )

    // Fire-and-forget — don't block UI for audit logging
    storeEnvelope(envelope).catch(() => {
      // IndexedDB not available or quota exceeded — silently ignore
    })
  } catch {
    // AEE library not loaded or createEvent failed — silently ignore
  }
}

/**
 * Pre-built event helpers for common CC3D interactions.
 */
export const cc3dAudit = {
  select: (entityType, entityId, entityName) =>
    logCC3DEvent('select', { entityType, entityId, entityName }),

  navigate: (zone, position, method) =>
    logCC3DEvent('navigate', { zone, position, method }),

  layerToggle: (layerKey, visible) =>
    logCC3DEvent('layer.toggle', { layerKey, visible }),

  search: (query, resultCount) =>
    logCC3DEvent('search', { query, resultCount }),

  depthChange: (depth) =>
    logCC3DEvent('depth.change', { depth }),

  tourStart: (tourName) =>
    logCC3DEvent('tour.start', { tourName }),

  horusAlert: (anomalyType, entityId, severity) =>
    logCC3DEvent('horus.alert', { anomalyType, entityId, severity }),
}
