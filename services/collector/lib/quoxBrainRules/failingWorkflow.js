/**
 * QuoxBrain Rule: failing-workflow
 *
 * Trigger: A workflow's success_rate is < 50% over its last 5 runs.
 *
 * ctx: {
 *   recentRuns: Array<{ workflow_id, workflow_name, status, started_at }>
 * }
 */

const WINDOW = 5;
const id = 'failing-workflow';

function evaluate(ctx = {}) {
  const { recentRuns = [] } = ctx;

  if (recentRuns.length === 0) {
    return { matches: false };
  }

  // Group by workflow, keep runs sorted newest-first (array assumed newest-first already,
  // but we sort defensively)
  const byWorkflow = new Map();
  for (const run of recentRuns) {
    const key = run.workflow_id;
    if (!byWorkflow.has(key)) {
      byWorkflow.set(key, { name: run.workflow_name, runs: [] });
    }
    byWorkflow.get(key).runs.push(run);
  }

  let worst = null;

  for (const [workflowId, { name, runs }] of byWorkflow.entries()) {
    // Sort newest-first and take last WINDOW runs
    const sorted = runs.slice().sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );
    const last5 = sorted.slice(0, WINDOW);
    const failCount = last5.filter((r) => r.status === 'failed').length;
    const successRate = (last5.length - failCount) / last5.length;

    if (successRate < 0.5) {
      // Strictly less than 50% success rate (>50% failure rate)
      if (!worst || failCount > worst.failCount) {
        worst = { workflowId, name, failCount };
      }
    }
  }

  if (!worst) {
    return { matches: false };
  }

  return {
    matches: true,
    payload: {
      workflowId: worst.workflowId,
      name: worst.name,
      failCount: worst.failCount,
    },
  };
}

module.exports = { id, evaluate };
