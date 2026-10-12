/**
 * dedupDualRead — QOBS-1c
 *
 * AEE-FULL Gap 3 introduced canonical `quox.flow.llm.*` intents for LLM
 * invoke/complete/fail. Historical envelopes carry legacy equivalents
 * (`quox.flow.agent.*`, `ops.assistant.invoked`, `agentic.think`) that are
 * cryptographically witnessed and therefore permanent per WARD
 * immutability — they can never be migrated in storage. Both intent
 * families can appear in the same conversation, and when they represent
 * the same underlying LLM call (duplicate emission across a migration
 * cutover, or overlapping instrumentation) rendering both is noise: the
 * dual-read must be resolved at RENDER time, not by mutating storage.
 *
 * This pure function hides legacy LLM-intent siblings for any
 * corr/reply_to "window" (envelopes sharing the same `reply_to` value —
 * `corr` is already invariant for a single conversation's envelope list)
 * where a canonical `quox.flow.llm.*` envelope is also present. Legacy
 * envelopes in a window with NO canonical sibling are left untouched —
 * they're the sole record of that call and must not be hidden.
 *
 * Non-LLM envelopes are never touched by this function.
 */

import { V1_INTENTS, LEGACY_INTENTS } from './llmIntents.js'

/**
 * @param {Array<object>} list - Envelopes from a single conversation
 *   (shared `corr`), in any order.
 * @returns {Array<object>} The same envelopes, minus legacy LLM envelopes
 *   whose reply_to window also contains a canonical LLM envelope.
 */
export function dedupDualRead(list = []) {
  if (!Array.isArray(list) || list.length === 0) return []

  // Bucket by reply_to "window". Envelopes with no reply_to (or a
  // top-level reply_to === null) share the null bucket.
  const windows = new Map()
  for (const env of list) {
    if (!env) continue
    const windowKey = env.reply_to ?? null
    if (!windows.has(windowKey)) windows.set(windowKey, [])
    windows.get(windowKey).push(env)
  }

  // Determine which windows contain a canonical LLM envelope.
  const windowsWithCanonical = new Set()
  for (const [windowKey, envs] of windows) {
    if (envs.some((e) => V1_INTENTS.has(e.intent))) {
      windowsWithCanonical.add(windowKey)
    }
  }

  return list.filter((env) => {
    if (!env) return false
    const isLegacyLlm = LEGACY_INTENTS.has(env.intent)
    if (!isLegacyLlm) return true
    const windowKey = env.reply_to ?? null
    // Hide only if this legacy envelope's own window has a canonical sibling.
    return !windowsWithCanonical.has(windowKey)
  })
}
