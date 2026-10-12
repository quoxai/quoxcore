/**
 * Collector-side severity rollup — QOBS-1d
 *
 * Ports the intent/type classification rules from the frontend's
 * src/lib/aee/envelopeSeverity.js (deriveSeverity) so the
 * /aee/conversations/enriched endpoint can return a per-conversation
 * severity summary (counts by level) alongside the existing breakdown
 * rollup, without adding an extra query.
 *
 * CHEAPER HONEST PATH: this computes severity counts from the same
 * pre-aggregated `[{intent, type, n}]` rows that
 * computeBreakdownFromGrouped (envelopeBreakdown.js) already consumes —
 * one SQL group-by per conversation, already run for the breakdown
 * rollup, reused here rather than decrypting every envelope a second
 * time.
 *
 * HONEST LIMITATION: grouped rows carry only {intent, type, n} — no
 * payload, no corr, no explicit envelope.priority. The frontend
 * deriveSeverity's payload-dependent rules (policy-denial detection via
 * payload.decision/status, ERR_/ERROR_ corr-prefix override, explicit
 * priority override) can't be applied without decrypting every envelope,
 * which defeats the point of the grouped-rows optimization. Those
 * envelopes fall back to their intent-only classification here (e.g. an
 * aocl.policy.evaluated envelope is counted 'debug' regardless of
 * allow/deny). The frontend's per-envelope deriveSeverity (full
 * envelope, with payload) remains the source of truth for individual
 * envelope rendering in the detail chain — this rollup is a best-effort
 * aggregate for the conversation list row only.
 */

/**
 * @param {string} intent
 * @param {string} [type]
 * @returns {'critical'|'warn'|'info'|'debug'}
 */
function deriveSeverityFromIntent(intent, type) {
  if (!intent) return 'info';

  // ─── critical ───────────────────────────────────────────────
  if (type === 'error' || intent.endsWith('.failed') || intent.endsWith('.error')) {
    return 'critical';
  }

  // ─── warn ───────────────────────────────────────────────────
  if (
    intent === 'aocl.run.reject' ||
    intent === 'ops.approval.deny' ||
    /denied|reject/i.test(intent) ||
    /retry|retried/i.test(intent) ||
    /warning/i.test(intent)
  ) {
    return 'warn';
  }

  // ─── info ───────────────────────────────────────────────────
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
    return 'info';
  }

  // ─── debug ──────────────────────────────────────────────────
  if (
    intent === 'quox.flow.llm.invoked' ||
    intent === 'quox.flow.llm.completed' ||
    intent === 'quox.flow.agent.invoked' ||
    intent === 'quox.flow.agent.completed' ||
    intent === 'ops.assistant.invoked' ||
    intent === 'agentic.think' ||
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
    return 'debug';
  }

  return 'info';
}

/**
 * @param {Array<{intent?: string, type?: string, n?: number}>} rows
 * @returns {{critical: number, warn: number, info: number, debug: number}}
 */
function computeSeverityFromGrouped(rows = []) {
  const acc = { critical: 0, warn: 0, info: 0, debug: 0 };
  for (const r of rows) {
    const intent = r?.intent;
    const type = r?.type;
    const n = Number(r?.n) || 0;
    if (!intent || n === 0) continue;
    const severity = deriveSeverityFromIntent(intent, type);
    acc[severity] += n;
  }
  return acc;
}

module.exports = { deriveSeverityFromIntent, computeSeverityFromGrouped };
