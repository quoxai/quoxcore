/**
 * CoreComms AEE Audit Service
 * Fire-and-forget envelope logging for notification channel operations.
 * Covers config changes, notification sends, and webhook management.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const COMMS_INTENTS = {
  CONFIG_SAVED: 'quox.comms.config_saved',
  CONFIG_RESET: 'quox.comms.config_reset',
  NOTIFICATION_SENT: 'quox.comms.notification_sent',
  WEBHOOK_REGISTERED: 'quox.comms.webhook_registered',
  WEBHOOK_DEACTIVATED: 'quox.comms.webhook_deactivated',
  ENDPOINT_CREATED: 'quox.comms.endpoint_created',
  ENDPOINT_UPDATED: 'quox.comms.endpoint_updated',
  ENDPOINT_DELETED: 'quox.comms.endpoint_deleted',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function commsCorrelation() {
  return prefixedUlid('COMMS')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[CommsAudit]', err.message)) }
  catch (err) { console.warn('[CommsAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logConfigSaved(orgId) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.CONFIG_SAVED, {
      orgId,
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}

export function logConfigReset(orgId) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.CONFIG_RESET, {
      orgId,
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}

export function logNotificationSent(channel, priority) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.NOTIFICATION_SENT, {
      channel: (channel || '').slice(0, 50),
      priority: (priority || '').slice(0, 20),
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}

export function logWebhookRegistered(channelType) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.WEBHOOK_REGISTERED, {
      channelType: (channelType || '').slice(0, 50),
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}

export function logWebhookDeactivated(channelType) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.WEBHOOK_DEACTIVATED, {
      channelType: (channelType || '').slice(0, 50),
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}

export function logEndpointCreated(orgId, result) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.ENDPOINT_CREATED, {
      orgId,
      endpointId: result?.id,
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}

export function logEndpointUpdated(orgId, endpointId) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.ENDPOINT_UPDATED, {
      orgId,
      endpointId,
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}

export function logEndpointDeleted(orgId, endpointId) {
  fireAndForget(async () => {
    const event = createEvent('system.comms', COMMS_INTENTS.ENDPOINT_DELETED, {
      orgId,
      endpointId,
      timestamp: Date.now(),
    }, commsCorrelation())
    await storeEnvelope(event)
  })
}
