/**
 * Action Tracker AEE Audit Service
 * Fire-and-forget envelope logging for action item CRUD operations.
 * Follows the backup plugin pattern (backupIntents.js).
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const ACTION_INTENTS = {
  ITEM_CREATED:    'quox.actions.item.created',
  ITEM_MOVED:      'quox.actions.item.moved',
  ITEM_UPDATED:    'quox.actions.item.updated',
  ITEM_DELETED:    'quox.actions.item.deleted',
  ITEM_ARCHIVED:   'quox.actions.item.archived',
  SYNC_COMPLETED:  'quox.actions.sync.completed',
  SYNC_FAILED:     'quox.actions.sync.failed',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function actionCorrelation() {
  return prefixedUlid('ACTION')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[ActionAudit]', err.message)) }
  catch (err) { console.warn('[ActionAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logActionCreated(item, userId) {
  fireAndForget(async () => {
    const event = createEvent(
      'plugin.actions',
      ACTION_INTENTS.ITEM_CREATED,
      {
        actionId: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        category: item.category,
        userId,
        timestamp: Date.now(),
      },
      actionCorrelation()
    )
    await storeEnvelope(event)
  })
}

export function logActionMoved(item, fromStatus, toStatus, userId) {
  fireAndForget(async () => {
    const event = createEvent(
      'plugin.actions',
      ACTION_INTENTS.ITEM_MOVED,
      {
        actionId: item.id,
        title: item.title,
        fromStatus,
        toStatus,
        userId,
        timestamp: Date.now(),
      },
      actionCorrelation()
    )
    await storeEnvelope(event)
  })
}

export function logActionUpdated(item, changedFields, userId) {
  fireAndForget(async () => {
    const event = createEvent(
      'plugin.actions',
      ACTION_INTENTS.ITEM_UPDATED,
      {
        actionId: item.id,
        title: item.title,
        changedFields,
        userId,
        timestamp: Date.now(),
      },
      actionCorrelation()
    )
    await storeEnvelope(event)
  })
}

export function logActionDeleted(item, userId) {
  fireAndForget(async () => {
    const event = createEvent(
      'plugin.actions',
      ACTION_INTENTS.ITEM_DELETED,
      {
        actionId: item.id,
        title: item.title,
        status: item.status,
        userId,
        timestamp: Date.now(),
      },
      actionCorrelation()
    )
    await storeEnvelope(event)
  })
}

export function logActionArchived(item, userId) {
  fireAndForget(async () => {
    const event = createEvent(
      'plugin.actions',
      ACTION_INTENTS.ITEM_ARCHIVED,
      {
        actionId: item.id,
        title: item.title,
        userId,
        timestamp: Date.now(),
      },
      actionCorrelation()
    )
    await storeEnvelope(event)
  })
}

export function logSyncCompleted(count, userId) {
  fireAndForget(async () => {
    const event = createEvent(
      'plugin.actions',
      ACTION_INTENTS.SYNC_COMPLETED,
      { count, userId, timestamp: Date.now() },
      actionCorrelation()
    )
    await storeEnvelope(event)
  })
}

export function logSyncFailed(error, userId) {
  fireAndForget(async () => {
    const event = createEvent(
      'plugin.actions',
      ACTION_INTENTS.SYNC_FAILED,
      { error: String(error), userId, timestamp: Date.now() },
      actionCorrelation()
    )
    await storeEnvelope(event)
  })
}
