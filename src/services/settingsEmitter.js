/**
 * settingsEmitter.js — REGULA's configuration plane event emitter.
 *
 * Phase 3 of SET-REGULA. Every settings change, read, import, export,
 * reset, explain, or audit sweep goes through one of these emitters and
 * becomes an AEE envelope on AOCL Layer 11 (config.plane).
 *
 * Contract:
 *   - Emission is fire-and-forget. A failure to store an envelope MUST NOT
 *     block the underlying settings change — degrade gracefully.
 *   - Every envelope is stamped with layer: 'L11' so the audit waterfall
 *     knows to render it on the Configuration Plane row.
 *   - Destructive changes emit an `intent` envelope first, then wait for
 *     HITL approval, then emit a `result` envelope. Reversible changes
 *     emit a single `changed` envelope immediately.
 *   - VOLT bridge hook is called after successful storage so the change
 *     is hash-chained into the tamper-evident ledger.
 */

import { createEvent } from '../lib/aee/envelope'
import { storeEnvelope } from '../lib/aee/store'
import { SETTINGS_INTENTS } from '../lib/aee/intents'
import { getSetting } from '../config/settingsRegistry'

const FROM_REGULA = 'agent.regula'
const TO_SYSTEM = 'system.settings'
const LAYER = 'L11'

/**
 * Redact secret-bearing values before putting them in an envelope.
 * Never let raw credentials land in the audit trail.
 */
function redactValue(settingId, value) {
  if (value == null) return value
  const id = String(settingId || '').toLowerCase()
  if (id.startsWith('vault.') || id.includes('key') || id.includes('secret') || id.includes('password') || id.includes('token')) {
    return '[redacted]'
  }
  if (typeof value === 'string' && value.length > 200) {
    return value.slice(0, 200) + '…'
  }
  return value
}

/**
 * Normalise a settings-event payload for envelope storage.
 */
function buildPayload(settingId, extra = {}) {
  const meta = getSetting(settingId) || null
  return {
    settingId,
    section: meta?.section || null,
    label: meta?.label || null,
    destructive: !!meta?.destructive,
    hitlRequired: !!meta?.hitlRequired,
    layer: LAYER,
    ...extra,
  }
}

/**
 * Fire-and-forget envelope emission. Never throws.
 */
async function emit(intent, payload, corr) {
  try {
    const env = createEvent(FROM_REGULA, intent, payload, corr, {
      to: TO_SYSTEM,
      layer: LAYER,
    })
    // storeEnvelope fires the VOLT bridge automatically for every
    // stored envelope, so we do not need a manual hash-chain call here.
    await storeEnvelope(env)
    return env
  } catch (err) {
    console.warn('[REGULA] settingsEmitter.emit failed:', err)
    return null
  }
}

// ─────────────────────────────────────────────────────── Public API

/**
 * REGULA read a setting value (for display/explanation).
 * Low-noise — only call when the read is user-initiated (e.g. REGULA chat),
 * not on every component render.
 */
export function emitRead(settingId, { corr, reason } = {}) {
  return emit(SETTINGS_INTENTS.READ, buildPayload(settingId, { reason: reason || null }), corr)
}

/**
 * A reversible settings change just committed.
 */
export function emitChanged(settingId, { previousValue, newValue, corr, actor, reason } = {}) {
  return emit(
    SETTINGS_INTENTS.CHANGED,
    buildPayload(settingId, {
      previousValue: redactValue(settingId, previousValue),
      newValue: redactValue(settingId, newValue),
      actor: actor || 'human.user',
      reason: reason || null,
    }),
    corr
  )
}

/**
 * A destructive settings change wants to happen. Emits the intent
 * envelope that gets routed to the HITL inbox for approval.
 * Returns the stored envelope so the caller can pass its id into the
 * inbox item for later approved/rejected correlation.
 */
export function emitChangeIntent(settingId, { previousValue, newValue, corr, actor, reason } = {}) {
  return emit(
    SETTINGS_INTENTS.CHANGE_INTENT,
    buildPayload(settingId, {
      previousValue: redactValue(settingId, previousValue),
      newValue: redactValue(settingId, newValue),
      actor: actor || 'human.user',
      reason: reason || null,
      status: 'pending-approval',
    }),
    corr
  )
}

/** HITL approved a pending change. Emitted at commit time. */
export function emitChangeApproved(settingId, { previousValue, newValue, intentEnvelopeId, corr, approver } = {}) {
  return emit(
    SETTINGS_INTENTS.CHANGE_APPROVED,
    buildPayload(settingId, {
      previousValue: redactValue(settingId, previousValue),
      newValue: redactValue(settingId, newValue),
      intentEnvelopeId: intentEnvelopeId || null,
      approver: approver || 'human.user',
    }),
    corr
  )
}

/** HITL rejected a pending change. */
export function emitChangeRejected(settingId, { intentEnvelopeId, corr, approver, reason } = {}) {
  return emit(
    SETTINGS_INTENTS.CHANGE_REJECTED,
    buildPayload(settingId, {
      intentEnvelopeId: intentEnvelopeId || null,
      approver: approver || 'human.user',
      reason: reason || null,
    }),
    corr
  )
}

/** A settings bundle was imported. */
export function emitImport({ sourceLabel, settingCount, corr, actor } = {}) {
  return emit(
    SETTINGS_INTENTS.IMPORT,
    {
      sourceLabel: sourceLabel || 'unknown',
      settingCount: settingCount || 0,
      actor: actor || 'human.user',
      layer: LAYER,
    },
    corr
  )
}

/** A settings bundle was exported. */
export function emitExport({ settingCount, corr, actor } = {}) {
  return emit(
    SETTINGS_INTENTS.EXPORT,
    {
      settingCount: settingCount || 0,
      actor: actor || 'human.user',
      layer: LAYER,
    },
    corr
  )
}

/** Settings reset to defaults. Always destructive. */
export function emitReset({ scope, corr, actor, reason } = {}) {
  return emit(
    SETTINGS_INTENTS.RESET,
    {
      scope: scope || 'all',
      actor: actor || 'human.user',
      reason: reason || null,
      destructive: true,
      layer: LAYER,
    },
    corr
  )
}

/** REGULA explained a setting in plain English via chat. */
export function emitExplain(settingId, { corr, query } = {}) {
  return emit(
    SETTINGS_INTENTS.EXPLAIN,
    buildPayload(settingId, { query: query || null }),
    corr
  )
}

/** REGULA recommended a setting value based on context. */
export function emitRecommend(settingId, { recommendation, rationale, corr } = {}) {
  return emit(
    SETTINGS_INTENTS.RECOMMEND,
    buildPayload(settingId, {
      recommendation: redactValue(settingId, recommendation),
      rationale: rationale || null,
    }),
    corr
  )
}

/** Drift watchdog sweep produced findings. */
export function emitAudit({ findings = [], corr, sweepType } = {}) {
  return emit(
    SETTINGS_INTENTS.AUDIT,
    {
      sweepType: sweepType || 'drift',
      findingCount: findings.length,
      findings: findings.slice(0, 20).map(f => ({
        settingId: f.settingId || null,
        severity: f.severity || 'info',
        message: f.message || '',
      })),
      layer: LAYER,
    },
    corr
  )
}

/**
 * High-level helper: commit a settings change through REGULA.
 *
 * Reversible changes (per settingsRegistry) commit immediately and emit
 * a single `changed` envelope. Destructive changes emit an intent
 * envelope and return { needsApproval: true } without committing — the
 * caller is responsible for routing to HITL.
 *
 * Returns: { committed: boolean, needsApproval: boolean, envelope }
 */
export async function commitSettingChange(settingId, {
  previousValue,
  newValue,
  corr,
  actor,
  reason,
  onCommit,
} = {}) {
  const meta = getSetting(settingId)

  if (meta && meta.hitlRequired) {
    const env = await emitChangeIntent(settingId, { previousValue, newValue, corr, actor, reason })
    return { committed: false, needsApproval: true, envelope: env }
  }

  if (typeof onCommit === 'function') {
    try {
      await onCommit()
    } catch (err) {
      console.warn('[REGULA] commitSettingChange onCommit failed:', err)
      throw err
    }
  }

  const env = await emitChanged(settingId, { previousValue, newValue, corr, actor, reason })
  return { committed: true, needsApproval: false, envelope: env }
}

export default {
  emitRead,
  emitChanged,
  emitChangeIntent,
  emitChangeApproved,
  emitChangeRejected,
  emitImport,
  emitExport,
  emitReset,
  emitExplain,
  emitRecommend,
  emitAudit,
  commitSettingChange,
}
