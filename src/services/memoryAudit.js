/**
 * Memory AEE Audit Service
 * Fire-and-forget envelope logging for memory operations.
 * Follows the actionAuditService.js pattern.
 *
 * U-minimal: When parentCorr is provided, events GROUP under that corr
 * (same conversation in Activity Centre). Without it, they get their own MEM_ corr.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const MEMORY_INTENTS = {
  SAVED:          'quox.memory.saved',
  UPDATED:        'quox.memory.updated',
  DELETED:        'quox.memory.deleted',
  ENTITY_STORED:  'quox.entity.stored',
  WSM_LOOP_OPENED:   'quox.wsm.loop.opened',
  WSM_LOOP_RESOLVED: 'quox.wsm.loop.resolved',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function memCorrelation(parentCorr) {
  return parentCorr || prefixedUlid('MEM')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[MemoryAudit]', err.message)) }
  catch (err) { console.warn('[MemoryAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logMemorySaved(item, type, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.memory',
      MEMORY_INTENTS.SAVED,
      {
        itemId: item.id,
        type,
        contentLength: item.content?.length || 0,
        confidence: item.confidence?.value,
        source: item.provenance?.source,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      memCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logMemoryUpdated(memoryId, useful, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.memory',
      MEMORY_INTENTS.UPDATED,
      {
        memoryId,
        feedback: useful ? 'useful' : 'not_useful',
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      memCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logMemoryDeleted(relationshipId, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.memory',
      MEMORY_INTENTS.DELETED,
      {
        relationshipId,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      memCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logEntityStored(entity, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.memory',
      MEMORY_INTENTS.ENTITY_STORED,
      {
        entityId: entity.id,
        entityType: entity.type,
        name: entity.name,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      memCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logOpenLoopCreated(loop, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.memory',
      MEMORY_INTENTS.WSM_LOOP_OPENED,
      {
        loopId: loop.id,
        type: loop.type,
        priority: loop.priority,
        description: (loop.description || '').slice(0, 200),
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      memCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logOpenLoopResolved(loop, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.memory',
      MEMORY_INTENTS.WSM_LOOP_RESOLVED,
      {
        loopId: loop.id,
        type: loop.type,
        outcome: loop.resolution?.outcome,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      memCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}
