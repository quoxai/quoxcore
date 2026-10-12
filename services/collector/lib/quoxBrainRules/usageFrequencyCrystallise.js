/**
 * QuoxBrain Rule: usage-frequency-crystallise
 *
 * Trigger: A workflow has been run ≥4× in the last 7 days and
 * no Crystal exists for it yet.
 *
 * ctx: {
 *   recentRuns: Array<{ workflow_id, workflow_name, started_at, status }>
 *   crystals: Array<{ source_workflow_id }>
 *   windowMs: number  (default 7 days)
 * }
 */

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_THRESHOLD = 4;
// Rough estimate: $0.60 saved per crystallised run (frozen prompt cost)
const COST_PER_RUN_SAVED = 0.60;

const id = 'usage-frequency-crystallise';

function evaluate(ctx = {}) {
  const { recentRuns = [], crystals = [], windowMs = DEFAULT_WINDOW_MS } = ctx;
  const cutoff = Date.now() - windowMs;

  // Filter runs within the window
  const windowRuns = recentRuns.filter((r) => {
    const ts = new Date(r.started_at).getTime();
    return ts >= cutoff;
  });

  // Group by workflow_id
  const byWorkflow = new Map();
  for (const run of windowRuns) {
    const key = run.workflow_id;
    if (!byWorkflow.has(key)) {
      byWorkflow.set(key, { count: 0, name: run.workflow_name });
    }
    byWorkflow.get(key).count += 1;
  }

  // Build set of crystallised workflow ids
  const crystallisedIds = new Set(
    crystals.map((c) => c.source_workflow_id).filter(Boolean),
  );

  // Find the workflow with the most runs that qualifies
  let best = null;
  for (const [workflowId, { count, name }] of byWorkflow.entries()) {
    if (count < RUN_THRESHOLD) continue;
    if (crystallisedIds.has(workflowId)) continue;
    if (!best || count > best.count) {
      best = { workflowId, name, count };
    }
  }

  if (!best) {
    return { matches: false };
  }

  const costSaved = `$${(best.count * COST_PER_RUN_SAVED).toFixed(2)}`;

  return {
    matches: true,
    payload: {
      workflowId: best.workflowId,
      name: best.name,
      count: best.count,
      costSaved,
    },
  };
}

module.exports = { id, evaluate };
