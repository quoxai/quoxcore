/**
 * Envelope severity derivation — QOBS-1a
 *
 * Assigns a visual-weight severity level to an individual AEE envelope so
 * the Activity Centre can render high-signal events (errors, policy
 * denials, user actions) more prominently than high-volume low-signal
 * chatter (AOCL layer telemetry, tool/LLM invoke-complete pairs, agent
 * thinking stream, heartbeats, session markers).
 *
 * One chat turn emits 26+ envelopes today, all rendered at equal visual
 * weight. This module is the pure-logic classifier that lets the UI dim
 * and collapse the noisy majority while keeping the handful of signal
 * envelopes (errors, denials, the actual user action) prominent.
 *
 * Severity levels (highest to lowest visual weight):
 *   'critical' — errors, failures, error-classified conversations
 *   'warn'     — policy denials, retries, other warnings
 *   'info'     — user-initiated actions, HITL approvals, run start/end
 *   'debug'    — high-volume infra chatter (dimmed + collapsed by default)
 *
 * Reuses the LLM dual-read taxonomy from llmIntents.js (the canonical
 * quox.flow.llm intents and legacy quox.flow.agent, ops.assistant.invoked,
 * agentic.think intents) so the noisy invoke/complete chatter is
 * classified consistently with the rest of the AEE library.
 *
 * These rules mirror — but do not literally share code with — the
 * category boundaries in services/collector/lib/envelopeBreakdown.js
 * (tools, aocl_layers, policy_checks, agent_stream, session_markers).
 * That module runs server-side (CommonJS, no build step) while this one
 * runs in the Vite-bundled frontend (ESM) — two separate runtimes that
 * can't import one another. envelopeBreakdown.js buckets all
 * `quox.flow.*` under `user_actions` for conversation-level rollup
 * counts; severity applies a finer per-envelope rule so the noisy
 * `quox.flow.llm.*` invoke/complete pair (dozens of envelopes per turn)
 * is 'debug' rather than inheriting the coarser conversation-level
 * label. Commit QOBS-1d ports an equivalent helper collector-side for
 * the server-computed severity rollup.
 *
 * An explicit `envelope.priority` (AEEEnvelope.priority, see types.js)
 * always wins when present — it's an authoritative override from the
 * emitter, taking precedence over intent-based inference.
 */

import { LLM_INVOKED_INTENTS, LLM_COMPLETED_INTENTS } from './llmIntents.js'

/** @type {Array<'critical'|'warn'|'info'|'debug'>} */
export const SEVERITY_LEVELS = ['critical', 'warn', 'info', 'debug']

const PRIORITY_TO_SEVERITY = {
  urgent: 'critical',
  high: 'warn',
  normal: 'info',
  low: 'debug',
}

/** Detects an explicit deny/reject/blocked signal in a policy/layer payload. */
function isDenialSignal(payload) {
  if (!payload || typeof payload !== 'object') return false
  const decision = String(payload.decision || payload.status || '').toLowerCase()
  return decision === 'deny' || decision === 'denied' || decision === 'reject' || decision === 'rejected' || payload.blocked === true
}

/**
 * Derive a severity level for a single AEE envelope.
 *
 * @param {{intent?: string, type?: string, payload?: object, corr?: string, priority?: string}} envelope
 * @returns {'critical'|'warn'|'info'|'debug'}
 */
export function deriveSeverity(envelope) {
  if (!envelope || typeof envelope !== 'object') return 'info'

  // Explicit priority override (types.js PRIORITY_LEVELS) — authoritative.
  if (envelope.priority && PRIORITY_TO_SEVERITY[envelope.priority]) {
    return PRIORITY_TO_SEVERITY[envelope.priority]
  }

  const intent = typeof envelope.intent === 'string' ? envelope.intent : ''
  const corr = typeof envelope.corr === 'string' ? envelope.corr : ''
  const payload = envelope.payload || {}

  // ─── critical — errors, failures, error-classified conversations ──
  if (
    envelope.type === 'error' ||
    intent.endsWith('.failed') ||
    intent.endsWith('.error') ||
    corr.startsWith('ERR_') || corr.startsWith('ERROR_')
  ) {
    return 'critical'
  }

  // ─── warn — policy denials, retries, other warnings ────────────────
  if (
    intent === 'aocl.run.reject' ||
    intent === 'ops.approval.deny' ||
    /denied|reject/i.test(intent) ||
    /retry|retried/i.test(intent) ||
    /warning/i.test(intent) ||
    ((intent.startsWith('aocl.policy.') || intent.startsWith('aocl.layer.')) && isDenialSignal(payload))
  ) {
    return 'warn'
  }

  // ─── info — user actions, chat.success, run start/end, HITL ────────
  if (
    intent === 'quox.chat.query' ||
    intent === 'quox.chat.response' ||
    intent === 'quox.chat.success' ||
    intent === 'quox.shell.open' ||
    intent === 'aocl.run.start' ||
    intent === 'aocl.run.complete' ||
    intent === 'ops.approval.request' ||
    intent === 'ops.approval.grant' ||
    intent.startsWith('quox.objective.') ||
    intent.startsWith('quox.browser.objective.')
  ) {
    return 'info'
  }

  // ─── debug — tool/LLM invoke-complete chatter, AOCL layers, agent
  //     stream, heartbeats, session markers ─────────────────────────
  if (
    LLM_INVOKED_INTENTS.includes(intent) ||
    LLM_COMPLETED_INTENTS.includes(intent) ||
    intent === 'ops.tool.executed' ||
    intent.startsWith('quox.tool.') ||
    intent === 'quox.agent.tool_call' ||
    intent === 'quox.agent.tool_result' ||
    intent.startsWith('aocl.layer.') ||
    intent.startsWith('aocl.policy.') ||
    intent.startsWith('quox.session.') ||
    intent.startsWith('quox.agent.session_') ||
    intent.startsWith('quox.agent.') ||
    intent === 'quoxagent.heartbeat.report'
  ) {
    return 'debug'
  }

  // Unrecognised intents default to 'info' — safer to surface unseen
  // data than to silently hide it behind the debug collapse.
  return 'info'
}
