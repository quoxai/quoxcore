/**
 * Plugin AEE Audit Service
 * Fire-and-forget envelope logging for plugin operations.
 * Follows the actionAuditService.js pattern.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const PLUGIN_INTENTS = {
  ENABLED:           'quox.plugin.enabled',
  DISABLED:          'quox.plugin.disabled',
  LICENSE_ACTIVATED: 'quox.plugin.license.activated',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function plugCorrelation(parentCorr) {
  return parentCorr || prefixedUlid('PLUG')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[PluginAudit]', err.message)) }
  catch (err) { console.warn('[PluginAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logPluginEnabled(name, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.plugins',
      PLUGIN_INTENTS.ENABLED,
      {
        pluginName: name,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      plugCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logPluginDisabled(name, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.plugins',
      PLUGIN_INTENTS.DISABLED,
      {
        pluginName: name,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      plugCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logLicenseActivated(parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.plugins',
      PLUGIN_INTENTS.LICENSE_ACTIVATED,
      {
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      plugCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}
