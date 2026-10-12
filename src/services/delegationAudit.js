/**
 * Delegation AEE Audit Service
 * Fire-and-forget envelope logging for agent delegation operations.
 * Follows the actionAuditService.js pattern.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const DELEGATION_INTENTS = {
  ROUTED:   'quox.delegation.routed',
  FALLBACK: 'quox.delegation.fallback',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function delegCorrelation(existingCorr) {
  return existingCorr || prefixedUlid('DELEG')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[DelegationAudit]', err.message)) }
  catch (err) { console.warn('[DelegationAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logDelegationRouted(query, agentId, score, topScores, corr) {
  fireAndForget(async () => {
    const event = createEvent(
      'agent.quox',
      DELEGATION_INTENTS.ROUTED,
      {
        agentId,
        score,
        query: (query || '').slice(0, 200),
        topScores: topScores || {},
        timestamp: Date.now(),
      },
      delegCorrelation(corr)
    )
    await storeEnvelope(event)
  })
}

export function logDelegationFallback(query, scores, corr) {
  fireAndForget(async () => {
    const event = createEvent(
      'agent.quox',
      DELEGATION_INTENTS.FALLBACK,
      {
        agentId: 'quox',
        reason: 'no-suitable-agent',
        query: (query || '').slice(0, 200),
        topScores: scores || {},
        timestamp: Date.now(),
      },
      delegCorrelation(corr)
    )
    await storeEnvelope(event)
  })
}
