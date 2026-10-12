/**
 * QuoxBrain Rule: unused-agent
 *
 * Trigger: An agent has had zero invocations in the last 30 days.
 *
 * ctx: {
 *   agents: Array<{ id, name }>
 *   recentInvocations: Array<{ agent_id, invoked_at }>
 *   windowMs: number  (default 30 days)
 * }
 */

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const id = 'unused-agent';

function evaluate(ctx = {}) {
  const { agents = [], recentInvocations = [], windowMs = DEFAULT_WINDOW_MS } = ctx;

  if (agents.length === 0) {
    return { matches: false };
  }

  const cutoff = Date.now() - windowMs;

  // Build set of agent ids that have been invoked within the window
  const activeIds = new Set(
    recentInvocations
      .filter((inv) => new Date(inv.invoked_at).getTime() >= cutoff)
      .map((inv) => inv.agent_id),
  );

  // Find the first agent that has NOT been invoked
  const unused = agents.find((a) => !activeIds.has(a.id));

  if (!unused) {
    return { matches: false };
  }

  return {
    matches: true,
    payload: {
      agentId: unused.id,
      agentName: unused.name,
    },
  };
}

module.exports = { id, evaluate };
