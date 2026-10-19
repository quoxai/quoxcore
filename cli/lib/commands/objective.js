/**
 * Objective commands: create, list, get, start, approve, plus the HITL
 * checkpoint verbs (checkpoints, approve-checkpoint, deny-checkpoint).
 *
 * Objectives are served by the tasks service (port 3104), not the auth
 * service. Org/user scoping comes from the JWT (org_id/sub claims) rather
 * than a URL path segment — see services/tasks/middleware/auth.js.
 *
 * Two approval gates exist and must not be confused:
 *   `approve`            resolves a decomposed objective's DAG plan.
 *   `approve-checkpoint` resolves one HITL checkpoint (pre-start gate or a
 *                        live loop gate: budget, risk, interval).
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/**
 * Format a timestamp as a short relative-time string ("5m ago").
 *
 * Checkpoint rows carry SQLite `datetime('now')` values ("2026-08-14
 * 04:00:00"), which are UTC but have no zone marker, so Node would read them
 * as local time and skew the age by the offset. Normalise that shape to ISO
 * UTC first; anything already ISO passes straight through.
 */
function relativeTime(ts) {
  if (!ts) return '—';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)
    ? `${ts.replace(' ', 'T')}Z`
    : ts;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Accumulate repeated `--capability-scope` flags into one array of raw
 * strings. Each value may itself be a comma-separated list; splitting and
 * trimming happen in the action, alongside the other body fields.
 */
function collectScope(value, previous) {
  return (previous || []).concat(value);
}

export function registerObjectiveCommands(program, ctx) {
  const { client, auth } = ctx;

  const objective = program
    .command('objective')
    .description('Manage objectives (autonomous multi-step goals)');

  objective
    .command('create')
    .description('Create a new objective (DAG plan by default, or a QLoop loop with --execution-mode loop)')
    .argument('<goal>', 'objective title / goal statement')
    .option('--description <text>', 'longer description')
    .option('--team <id>', 'team ID to run the objective under')
    .option('--max-tokens <n>', 'max token budget')
    .option('--max-tool-calls <n>', 'max tool call budget')
    .option('--max-duration-ms <n>', 'max wall-clock duration in ms')
    .option('--require-approval', 'require approval before starting')
    .option('--checkpoint', 'checkpoint after each task')
    .option('--goal-condition <text>', 're-observe loop exit condition')
    .option('--max-iterations <n>', 'max re-observe loop iterations')
    .option('--metadata <json>', 'arbitrary metadata as JSON')
    .option('--execution-mode <mode>', 'dag|loop. A loop runs a QLoop backend instead of a reviewable DAG plan, so it ALWAYS requires a before_start approval (see `quox objective checkpoints` and `approve-checkpoint`)')
    .option('--loop-backend <backend>', 'claude|codex, loop mode only (default claude)')
    .option('--capability-scope <tools>', 'comma-separated tool names the loop may call (repeatable); empty scope escalates every tool', collectScope)
    .option('--system-prompt <text>', 'per-objective system prompt, carried verbatim to the run')
    .action(async (goal, options) => {
      auth.requireAuth();
      const body = { title: goal };
      if (options.description) body.description = options.description;
      if (options.team) body.team_id = options.team;
      if (options.maxTokens) body.max_tokens = Number(options.maxTokens);
      if (options.maxToolCalls) body.max_tool_calls = Number(options.maxToolCalls);
      if (options.maxDurationMs) body.max_duration_ms = Number(options.maxDurationMs);
      if (options.requireApproval) body.require_approval_before_start = true;
      if (options.checkpoint) body.checkpoint_after_each_task = true;
      if (options.goalCondition) body.goal_condition = options.goalCondition;
      if (options.maxIterations) body.max_iterations = Number(options.maxIterations);
      if (options.metadata) body.metadata = parseJSON(options.metadata, '--metadata');
      if (options.executionMode) body.execution_mode = options.executionMode;
      if (options.loopBackend) body.loop_backend = options.loopBackend;
      if (options.capabilityScope) {
        const scope = options.capabilityScope
          .flatMap((raw) => raw.split(','))
          .map((t) => t.trim())
          .filter(Boolean);
        if (scope.length > 0) body.capability_scope = scope;
      }
      if (options.systemPrompt) body.system_prompt = options.systemPrompt;

      const data = await client.post(resolveEndpoint('objectives.create').path, { service: resolveEndpoint('objectives.create').service, body });
      printSuccess(`Objective created: ${data.id}`);
    });

  objective
    .command('list')
    .description('List objectives')
    .option('--status <status>', 'filter by status')
    .option('--team <id>', 'filter by team ID')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.status) query.status = options.status;
      if (options.team) query.team_id = options.team;
      const data = await client.get(resolveEndpoint('objectives.list').path, { service: resolveEndpoint('objectives.list').service, query });
      formatOutput({
        columns: ['id', 'title', 'status', 'team_id', 'created_at'],
        headers: ['ID', 'Title', 'Status', 'Team', 'Created'],
        rows: data.objectives || data,
      }, { format: program.opts().output });
    });

  objective
    .command('get')
    .description('Get objective details (tasks, checkpoints, DAG)')
    .argument('<id>', 'objective ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('objectives.get', { id }).path, { service: resolveEndpoint('objectives.get', { id }).service });
      formatDetail(data, { format: program.opts().output, title: data.title });
    });

  objective
    .command('start')
    .description('Start an objective (decompose into tasks)')
    .argument('<id>', 'objective ID')
    .option('--skip-checkpoint', 'bypass pre-start approval checkpoint')
    .action(async (id, options) => {
      auth.requireAuth();
      const body = {};
      if (options.skipCheckpoint) body.skip_checkpoint = true;
      const data = await client.post(resolveEndpoint('objectives.start', { id }).path, { service: resolveEndpoint('objectives.start', { id }).service, body });
      printSuccess(`Objective ${id}: ${data.status}${data.message ? ` — ${data.message}` : ''}`);
    });

  objective
    .command('approve')
    .description('Approve a decomposed objective\'s plan (starts execution)')
    .argument('<id>', 'objective ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.post(resolveEndpoint('objectives.approve-plan', { id }).path, { service: resolveEndpoint('objectives.approve-plan', { id }).service });
      printSuccess(`Objective ${id}: ${data.status}${data.message ? ` — ${data.message}` : ''}`);
    });

  objective
    .command('checkpoints')
    .description('List pending HITL checkpoints across the org (approval queue)')
    .option('--include-reviewed', 'include checkpoints that have already been reviewed')
    .option('--limit <n>', 'max results', '100')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.includeReviewed) query.include_reviewed = 'true';
      const data = await client.get(resolveEndpoint('objectives.checkpoints-pending').path, { service: resolveEndpoint('objectives.checkpoints-pending').service, query });
      const rows = (data.checkpoints || data || []).map((cp) => ({
        id: cp.id,
        objective_title: cp.objectiveTitle,
        checkpoint_type: cp.checkpointType,
        age: relativeTime(cp.createdAt),
        title: cp.title,
      }));
      formatOutput({
        columns: ['id', 'objective_title', 'checkpoint_type', 'age', 'title'],
        headers: ['Checkpoint', 'Objective', 'Type', 'Age', 'Title'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No pending checkpoints.' });
    });

  objective
    .command('approve-checkpoint')
    .description('Approve one HITL checkpoint (not the DAG plan, see `approve`)')
    .argument('<objectiveId>', 'objective ID')
    .argument('<checkpointId>', 'checkpoint ID')
    .option('--notes <text>', 'review notes recorded against the decision')
    .action(async (objectiveId, checkpointId, options) => {
      auth.requireAuth();
      const body = {};
      if (options.notes) body.notes = options.notes;
      const params = { id: objectiveId, checkpointId };
      const data = await client.post(resolveEndpoint('objectives.checkpoint-approve', params).path, { service: resolveEndpoint('objectives.checkpoint-approve', params).service, body });
      printSuccess(`Checkpoint ${checkpointId}: ${data.status}${data.objective_status ? ` (objective ${data.objective_status})` : ''}`);
    });

  objective
    .command('deny-checkpoint')
    .description('Reject one HITL checkpoint (not the DAG plan, see `approve`)')
    .argument('<objectiveId>', 'objective ID')
    .argument('<checkpointId>', 'checkpoint ID')
    .option('--notes <text>', 'review notes recorded against the decision')
    .action(async (objectiveId, checkpointId, options) => {
      auth.requireAuth();
      const body = {};
      if (options.notes) body.notes = options.notes;
      const params = { id: objectiveId, checkpointId };
      const data = await client.post(resolveEndpoint('objectives.checkpoint-reject', params).path, { service: resolveEndpoint('objectives.checkpoint-reject', params).service, body });
      printSuccess(`Checkpoint ${checkpointId}: ${data.status}${data.objective_status ? ` (objective ${data.objective_status})` : ''}`);
    });

  objective
    .command('cancel')
    .description('Cancel an objective (pending ones included, e.g. proof leftovers that never started); its open tasks are cancelled too. For a RUNNING loop prefer `halt`, which also kills the live session.')
    .argument('<objectiveId>', 'objective ID')
    .action(async (objectiveId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('objectives.cancel', { id: objectiveId });
      const data = await client.delete(ep.path, { service: ep.service });
      printSuccess(`Objective ${objectiveId}: ${data?.status || 'cancelled'}`);
    });

  objective
    .command('halt')
    .description('Halt a running QLoop loop ON DEMAND (unconditional human stop; no pending gate needed). Fires the same signed-kill as a gate deny.')
    .argument('<objectiveId>', 'loop objective ID')
    .option('--notes <text>', 'reason recorded against the halt')
    .action(async (objectiveId, options) => {
      auth.requireAuth();
      const body = {};
      if (options.notes) body.notes = options.notes;
      const params = { id: objectiveId };
      const data = await client.post(resolveEndpoint('objectives.halt', params).path, { service: resolveEndpoint('objectives.halt', params).service, body });
      if (data.status === 'halted') {
        printSuccess(`Loop ${objectiveId} halted (interrupted=${data.interrupted}, objective ${data.objective_status})`);
      } else {
        printSuccess(`Loop ${objectiveId}: ${data.status}${data.reason ? ` (${data.reason})` : ''}`);
      }
    });
}
