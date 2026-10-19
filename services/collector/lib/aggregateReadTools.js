'use strict';
/**
 * QUOXON-AGG (quox#900): named aggregate reads for asks the item-level tools cannot count.
 *
 * objective_counts: the org's objectives tallied by state, from the same tasks-service list
 * `quox objective list --limit 500` reads. Org from the turn (ctx.orgId), never the model.
 * A failed read is success:false with the status, never a zero count. A full page is
 * flagged truncated so a count is never presented as complete when it may not be.
 */

const PAGE = 500;

const objective_counts = {
  name: 'objective_counts',
  description: 'Count the org\'s objectives by state (completed, running, failed, ...) and list the running QLoop loop objectives with their status. Use this for "how many objectives completed / failed / are running" and "is that loop still running". Same list `quox objective list` reads. Read-only.',
  input_schema: { type: 'object', properties: {}, required: [] },
  execute: async (_input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return { success: false, error: 'No organization context for this turn; refusing to read.' };
    const tasksUrl = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
    try {
      const res = await fetch(`${tasksUrl}/api/objectives?limit=${PAGE}`, {
        headers: { 'X-Org-Id': orgId, 'X-User-Id': (ctx && ctx.userId) || '', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { success: false, error: `The objectives list could not be read (HTTP ${res.status}). Say so; do not estimate a count.` };
      const body = await res.json();
      const list = Array.isArray(body) ? body : (Array.isArray(body.objectives) ? body.objectives : []);
      const by_status = {};
      for (const o of list) { const s = o.status || 'unknown'; by_status[s] = (by_status[s] || 0) + 1; }
      return {
        success: true,
        source: 'QuoxTasks objectives list',
        as_of: new Date().toISOString(),
        total: list.length,
        truncated: list.length >= PAGE,
        by_status,
        completed: by_status.completed || 0,
        running_loops: list.filter((o) => o.execution_mode === 'loop' && o.status === 'running').slice(0, 20).map((o) => ({ id: o.id, status: o.status })),
      };
    } catch (e) {
      return { success: false, error: `The objectives list could not be read (${(e && e.code) || 'error'}). Say so; do not estimate a count.` };
    }
  },
};

// quox#896: the objective checkpoints waiting for a human, from the same list the
// Approvals mirror is raised from. Read-only; deciding stays a human act.
const objective_checkpoints_pending = {
  name: 'objective_checkpoints_pending',
  description: 'List the objective checkpoints waiting for a human decision (objective, checkpoint type, age). Use for "what objective checkpoints are waiting on me". Read-only: this never approves anything; a person decides each one in the Approvals inbox or with quox objective approve.',
  input_schema: { type: 'object', properties: {}, required: [] },
  execute: async (_input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return { success: false, error: 'No organization context for this turn; refusing to read.' };
    const tasksUrl = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
    try {
      const res = await fetch(`${tasksUrl}/api/checkpoints/pending?limit=100`, {
        headers: { 'X-Org-Id': orgId, 'X-User-Id': (ctx && ctx.userId) || '', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { success: false, error: `The pending checkpoints could not be read (HTTP ${res.status}). Say so; never say nothing is pending.` };
      const body = await res.json();
      const list = Array.isArray(body.checkpoints) ? body.checkpoints : [];
      const now = Date.now();
      return {
        success: true,
        source: 'QuoxTasks pending checkpoints',
        as_of: new Date(now).toISOString(),
        total: list.length,
        checkpoints: list.slice(0, 50).map((c) => {
          const t = Date.parse(c.createdAt && !/Z|[+-]\d\d:?\d\d$/.test(c.createdAt) ? `${c.createdAt.replace(' ', 'T')}Z` : c.createdAt);
          return {
            checkpoint_id: c.id,
            objective_id: c.objectiveId,
            objective: c.objectiveTitle,
            type: c.checkpointType,
            title: c.title,
            age_hours: Number.isFinite(t) ? Math.round(((now - t) / 3600000) * 10) / 10 : null,
          };
        }),
      };
    } catch (e) {
      return { success: false, error: `The pending checkpoints could not be read (${(e && e.code) || 'error'}). Say so; never say nothing is pending.` };
    }
  },
};

// QLOOP-PROOFBLITZ (quox#900 family): the single-objective READ the item-level
// tools lacked. get_objective_results only fetches a COMPLETED DAG objective's
// task report, so it fails on a QLoop loop or a failed/zero-task objective, and
// chat had no governed tool for "what is objective X's status/goal/did it
// finish" (it fell to get_objective_results, which errored, or to Bash). This
// reads ONE objective's record for EVERY kind. Org from the turn, never the model.
const objective_get = {
  name: 'objective_get',
  description: 'Read ONE objective by id: its status, goal, execution mode (dag or loop), tasks completed/failed, and whether it finished. Use this for "what is the status of objective X", "what was objective X\'s goal", and "did objective X finish". Works for EVERY objective kind, including QLoop loops and failed objectives, unlike get_objective_results (which only fetches a completed DAG objective\'s task report). Read-only.',
  input_schema: { type: 'object', properties: { objective_id: { type: 'string', description: 'The objective id to read (e.g. 01J...).' } }, required: ['objective_id'] },
  execute: async (input, ctx) => {
    const orgId = ctx && ctx.orgId;
    if (!orgId) return { success: false, error: 'No organization context for this turn; refusing to read.' };
    const id = input && typeof input.objective_id === 'string' ? input.objective_id.trim() : '';
    if (!id) return { success: false, error: 'objective_id is required.' };
    const tasksUrl = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
    try {
      const res = await fetch(`${tasksUrl}/api/objectives/${encodeURIComponent(id)}`, {
        headers: { 'X-Org-Id': orgId, 'X-User-Id': (ctx && ctx.userId) || '', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404) return { success: false, error: `No objective ${id} is readable in this org. Say so; do not guess.` };
      if (!res.ok) return { success: false, error: `Objective ${id} could not be read (HTTP ${res.status}). Say so; do not estimate.` };
      const body = await res.json();
      // The tasks endpoint may wrap the row ({objective:{...}}) or return it flat.
      const o = body && body.objective ? body.objective : body;
      if (!o || !o.id) return { success: false, error: `Objective ${id} could not be read (no record). Say so.` };
      const FINISHED = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'aborted'];
      return {
        success: true,
        source: 'QuoxTasks objective record',
        as_of: new Date().toISOString(),
        id: o.id,
        title: o.title,
        goal: o.goal_condition || o.title,
        status: o.status,
        execution_mode: o.execution_mode,
        tasks_completed: o.tasks_completed,
        tasks_failed: o.tasks_failed,
        task_count: o.task_count,
        finished: FINISHED.includes(o.status),
        error_message: o.error_message || null,
      };
    } catch (e) {
      return { success: false, error: `Objective ${id} could not be read (${(e && e.code) || 'error'}). Say so.` };
    }
  },
};

module.exports = { AGGREGATE_READ_TOOLS: { objective_counts, objective_checkpoints_pending, objective_get } };
