/**
 * LLM intent taxonomy union + envelope payload normalization.
 *
 * AEE-FULL Gap 3 introduces canonical LLM intents:
 *   quox.flow.llm.invoked / .completed / .failed
 *
 * Historical envelopes carry the legacy intents:
 *   quox.flow.agent.{invoked,completed,failed}
 *   ops.assistant.invoked
 *   agentic.think
 *
 * WARD-immutability constraint: historical envelopes are cryptographically
 * witnessed; their intent strings are part of the signature. They cannot be
 * DB-migrated without breaking the audit chain. Consumers therefore dual-read
 * BOTH old and new intent strings PERMANENTLY (not transitionally) until the
 * org's retention policy reaps the old envelopes.
 *
 * This module is the single source of truth for that union, plus a
 * `normalizeLlmEnvelopePayload` adapter that returns a consistent shape
 * regardless of the source envelope's schema version. The adapter follows
 * the AGENT-HONESTY contract: missing fields on legacy envelopes return
 * null (not fabricated zeros or estimates) so rendering code can choose
 * appropriate fallbacks.
 *
 * Reference: quox-dashboard/docs/STREAM_AEE_FULL_PLAN.md
 */

// ─── Union arrays ──────────────────────────────────────────────────────

export const LLM_INVOKED_INTENTS = [
  'quox.flow.llm.invoked',     // v1 canonical (Gap 3+)
  'quox.flow.agent.invoked',   // legacy — historical envelopes
]

export const LLM_COMPLETED_INTENTS = [
  'quox.flow.llm.completed',   // v1 canonical
  'quox.flow.agent.completed', // legacy
  'ops.assistant.invoked',     // legacy (assistant-invoke emitted no .completed; the .invoked event signalled completion in this branch)
  'agentic.think',             // legacy (agentic loop per-iteration; pre-Gap-3 each think() emitted this instead of an LLM envelope)
]

export const LLM_FAILED_INTENTS = [
  'quox.flow.llm.failed',      // v1 canonical
  'quox.flow.agent.failed',    // legacy
]

export const LLM_ALL_INTENTS = [
  ...LLM_INVOKED_INTENTS,
  ...LLM_COMPLETED_INTENTS,
  ...LLM_FAILED_INTENTS,
]

// ─── Schema-version detection ──────────────────────────────────────────

// Exported so other dual-read-aware consumers (e.g. dedupDualRead.js,
// QOBS-1c) can distinguish canonical from legacy without re-declaring
// this taxonomy.
export const V1_INTENTS = new Set([
  'quox.flow.llm.invoked',
  'quox.flow.llm.completed',
  'quox.flow.llm.failed',
])

export const LEGACY_INTENTS = new Set([
  'quox.flow.agent.invoked',
  'quox.flow.agent.completed',
  'quox.flow.agent.failed',
  'ops.assistant.invoked',
  'agentic.think',
])

// ─── Normalization adapter ─────────────────────────────────────────────

/**
 * Normalize an LLM-related envelope's payload to a consistent shape.
 *
 * Returns null when the envelope's intent is not LLM-related (caller should
 * handle the absence rather than receive a partial shape).
 *
 * The returned shape preserves AGENT-HONESTY: missing fields on legacy
 * envelopes are null, not fabricated zeros. Rendering code can show "—"
 * or a "historical" badge based on schemaVersion.
 *
 * @param {object|null} env - The envelope to normalize
 * @returns {object|null}
 */
export function normalizeLlmEnvelopePayload(env) {
  if (!env || typeof env !== 'object' || typeof env.intent !== 'string') {
    return null
  }

  const intent = env.intent
  const payload = env.payload || {}

  if (V1_INTENTS.has(intent)) {
    return normalizeV1(payload)
  }
  if (LEGACY_INTENTS.has(intent)) {
    return normalizeLegacy(payload)
  }
  return null
}

function normalizeV1(payload) {
  const tokensInput = typeof payload.tokens_input === 'number' ? payload.tokens_input : null
  const tokensOutput = typeof payload.tokens_output === 'number' ? payload.tokens_output : null

  let tokensUsed = null
  if (tokensInput !== null || tokensOutput !== null) {
    tokensUsed = (tokensInput || 0) + (tokensOutput || 0)
  }

  return {
    schemaVersion: 'v1',
    tokensInput,
    tokensOutput,
    tokensCachedInput: typeof payload.tokens_cached_input === 'number' ? payload.tokens_cached_input : null,
    tokensUnknown: payload.tokens_unknown === true,
    tokensUsed,
    model: typeof payload.model === 'string' ? payload.model : null,
    provider: typeof payload.provider === 'string' ? payload.provider : null,
    costUsd: typeof payload.cost_usd === 'number' ? payload.cost_usd : null,
    finishReason: typeof payload.finish_reason === 'string' ? payload.finish_reason : null,
    durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
    cancelled: payload.cancelled === true,
    partialOutput: typeof payload.partial_output === 'string' ? payload.partial_output : null,
    cancelledAt: typeof payload.cancelled_at === 'string' ? payload.cancelled_at : null,
    cancelledBy: typeof payload.cancelled_by === 'string' ? payload.cancelled_by : null,
    // Pass-through fields some renderers still consume
    toolsUsed: Array.isArray(payload.tools_used) ? payload.tools_used : [],
    result: payload.result ?? null,
    error: typeof payload.error_message === 'string' ? payload.error_message : null,
    nodeId: typeof payload.nodeId === 'string' ? payload.nodeId : null,
  }
}

function normalizeLegacy(payload) {
  // Legacy envelopes carry opaque tokens_used scalar (when present at all);
  // no model/provider/split-tokens — honest-null those fields.
  const opaqueTokensUsed = typeof payload.tokens_used === 'number' ? payload.tokens_used : null

  return {
    schemaVersion: 'legacy',
    tokensInput: null,
    tokensOutput: null,
    tokensCachedInput: null,
    tokensUnknown: false,           // legacy can't claim "unknown" — that's a v1 concept
    tokensUsed: opaqueTokensUsed,
    model: typeof payload.model === 'string' ? payload.model : null,
    provider: null,                  // pre-Gap-3 envelopes don't carry provider
    costUsd: null,
    finishReason: null,
    durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
    cancelled: false,
    partialOutput: null,
    cancelledAt: null,
    cancelledBy: null,
    toolsUsed: Array.isArray(payload.tools_used) ? payload.tools_used : [],
    result: typeof payload.result === 'string' ? payload.result : null,
    error: typeof payload.error_message === 'string' ? payload.error_message : null,
    nodeId: typeof payload.nodeId === 'string' ? payload.nodeId : null,
  }
}
