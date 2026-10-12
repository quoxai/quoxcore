/**
 * QuoxBrain Rule: tool-cost-spike
 *
 * Trigger: A tool's daily cost is more than 2× its rolling 7-day average.
 *
 * ctx: {
 *   toolCosts: Array<{
 *     tool_name: string,
 *     workflow_id: string,
 *     today_cost: number,
 *     avg_7d_cost: number
 *   }>
 * }
 */

const SPIKE_MULTIPLIER = 2; // strictly greater than this
const id = 'tool-cost-spike';

function evaluate(ctx = {}) {
  const { toolCosts = [] } = ctx;

  if (toolCosts.length === 0) {
    return { matches: false };
  }

  let worst = null;

  for (const tool of toolCosts) {
    const { tool_name, workflow_id, today_cost, avg_7d_cost } = tool;

    // Skip if average is zero (undefined baseline — can't compute ratio)
    if (!avg_7d_cost || avg_7d_cost === 0) continue;

    const multiple = Math.round(today_cost / avg_7d_cost);
    if (today_cost <= SPIKE_MULTIPLIER * avg_7d_cost) continue;

    if (!worst || multiple > worst.multiple) {
      worst = { toolName: tool_name, workflowId: workflow_id, multiple };
    }
  }

  if (!worst) {
    return { matches: false };
  }

  return {
    matches: true,
    payload: {
      toolName: worst.toolName,
      workflowId: worst.workflowId,
      multiple: worst.multiple,
    },
  };
}

module.exports = { id, evaluate };
