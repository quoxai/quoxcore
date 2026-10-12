/**
 * Envelope breakdown — rollup counts per conversation.
 *
 * Turns a flat list of envelopes (one conversation's worth) into the
 * per-category counts the Activity Centre list row uses to show a
 * compact summary like:
 *
 *   "chat · 2 tools · 3 AOCL layers · 1 policy check"
 *
 * Pure — no DB, no side effects — so it can be unit-tested without
 * booting the server.
 */

/**
 * @param {Array<{type?: string, intent?: string}>} envelopes
 * @returns {{
 *   total: number,
 *   user_actions: number,
 *   tools: number,
 *   aocl_layers: number,
 *   policy_checks: number,
 *   errors: number,
 *   agent_stream: number,
 *   session_markers: number,
 * }}
 */
function computeBreakdown(envelopes = []) {
  let total = 0;
  let user_actions = 0;
  let tools = 0;
  let aocl_layers = 0;
  let policy_checks = 0;
  let errors = 0;
  let agent_stream = 0;
  let session_markers = 0;

  for (const env of envelopes) {
    if (!env || !env.intent) continue;
    total++;

    const intent = env.intent;
    const isError = env.type === 'error' || intent.endsWith('.error') || intent.endsWith('.failed');
    if (isError) errors++;

    if (intent.startsWith('aocl.layer.')) {
      aocl_layers++;
      // L3 is policy evaluation (per AOCL spec)
      if (intent.includes('L3')) policy_checks++;
    } else if (intent.startsWith('aocl.policy.')) {
      policy_checks++;
    } else if (
      intent === 'ops.tool.executed' ||
      intent === 'ops.tool.failed' ||
      intent.startsWith('quox.tool.') ||
      intent === 'quox.agent.tool_call' ||
      intent === 'quox.agent.tool_result'
    ) {
      tools++;
    } else if (intent.startsWith('quox.session.') || intent.startsWith('quox.agent.session_')) {
      session_markers++;
    } else if (intent.startsWith('quox.agent.')) {
      agent_stream++;
    } else if (
      intent === 'quox.chat.query' ||
      intent === 'quox.chat.response' ||
      intent === 'quox.chat.success' ||
      intent === 'quox.shell.open' ||
      intent.startsWith('quox.objective.') ||
      intent.startsWith('quox.flow.') ||
      intent.startsWith('quox.browser.')
    ) {
      user_actions++;
    }
  }

  return {
    total,
    user_actions,
    tools,
    aocl_layers,
    policy_checks,
    errors,
    agent_stream,
    session_markers,
  };
}

/**
 * Same classification logic, but takes pre-aggregated SQL rows
 * `[{ intent, type, n }]` so the collector can produce breakdowns without
 * decrypting every envelope in a conversation (intent and type are stored
 * as plain-text columns).
 */
function computeBreakdownFromGrouped(rows = []) {
  const acc = {
    total: 0, user_actions: 0, tools: 0, aocl_layers: 0,
    policy_checks: 0, errors: 0, agent_stream: 0, session_markers: 0,
  };
  for (const r of rows) {
    const intent = r?.intent;
    const type = r?.type;
    const n = Number(r?.n) || 0;
    if (!intent || n === 0) continue;
    acc.total += n;

    const isError = type === 'error' || intent.endsWith('.error') || intent.endsWith('.failed');
    if (isError) acc.errors += n;

    if (intent.startsWith('aocl.layer.')) {
      acc.aocl_layers += n;
      if (intent.includes('L3')) acc.policy_checks += n;
    } else if (intent.startsWith('aocl.policy.')) {
      acc.policy_checks += n;
    } else if (
      intent === 'ops.tool.executed' ||
      intent === 'ops.tool.failed' ||
      intent.startsWith('quox.tool.') ||
      intent === 'quox.agent.tool_call' ||
      intent === 'quox.agent.tool_result'
    ) {
      acc.tools += n;
    } else if (intent.startsWith('quox.session.') || intent.startsWith('quox.agent.session_')) {
      acc.session_markers += n;
    } else if (intent.startsWith('quox.agent.')) {
      acc.agent_stream += n;
    } else if (
      intent === 'quox.chat.query' ||
      intent === 'quox.chat.response' ||
      intent === 'quox.chat.success' ||
      intent === 'quox.shell.open' ||
      intent.startsWith('quox.objective.') ||
      intent.startsWith('quox.flow.') ||
      intent.startsWith('quox.browser.')
    ) {
      acc.user_actions += n;
    }
  }
  return acc;
}

module.exports = { computeBreakdown, computeBreakdownFromGrouped };
