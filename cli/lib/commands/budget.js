/**
 * Budget commands: CRUD for quoxflow budget definitions + rolled-up usage.
 *
 * quox budget list|get|create|update|delete|usage
 *
 * Backend: quoxflow (NOT the auth service, NOT proxied by collector) —
 * quoxflow/src/api/routes/budgets.ts, mounted at /api/budgets. Org scoping
 * is via `?org_id=` query param on GETs and an `org_id` body field on
 * writes — see cli/lib/api/endpoints/budgets.js header for the full
 * verified org-scoping mechanism (list requires+filters org_id; get/usage
 * check org_id against the budget's owner when present; update/delete
 * require it in the body and 403 on mismatch).
 */

import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

const SCOPE_KINDS = ['org', 'objective', 'execution', 'iteration'];

function numOrUndefined(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Expected a number, got: ${value}`);
  return n;
}

export function registerBudgetCommands(program, ctx) {
  const { client, auth } = ctx;

  const budget = program
    .command('budget')
    .description('Manage quoxflow spend/usage budgets (org, objective, execution, iteration scope)');

  // ── budget list ─────────────────────────────────────────────────────────────

  budget
    .command('list')
    .description('List budgets for the active org')
    .option('--scope <kind>', `filter by scope kind (${SCOPE_KINDS.join('|')})`)
    .option('--scope-id <id>', 'filter by scope id')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { org_id: orgId };
      if (options.scope) query.scope = options.scope;
      if (options.scopeId) query.scope_id = options.scopeId;

      const data = await client.get(resolveEndpoint('budgets.list').path, {
        service: resolveEndpoint('budgets.list').service,
        query,
      });
      const budgets = data.data?.budgets || data.budgets || [];

      formatOutput({
        columns: ['id', 'scope_kind', 'scope_id', 'period_start', 'period_end', 'max_cost_usd_micro', 'max_tokens', 'hard_stop'],
        headers: ['ID', 'Scope', 'Scope ID', 'Period Start', 'Period End', 'Max Cost (micro-USD)', 'Max Tokens', 'Hard Stop'],
        rows: budgets,
      }, { format: program.opts().output, emptyMessage: 'No budgets found.' });
    });

  // ── budget get ───────────────────────────────────────────────────────────────

  budget
    .command('get')
    .description('Show budget details')
    .argument('<id>', 'budget ID')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('budgets.get', { id }).path, {
        service: resolveEndpoint('budgets.get', { id }).service,
        query: { org_id: orgId },
      });
      const b = data.data?.budget || data.budget || data;

      formatDetail(b, {
        format: program.opts().output,
        title: `Budget: ${b.id || id}`,
      });
    });

  // ── budget create ────────────────────────────────────────────────────────────

  budget
    .command('create')
    .description('Create a budget')
    .requiredOption('--scope <kind>', `scope kind (${SCOPE_KINDS.join('|')})`)
    .requiredOption('--scope-id <id>', 'scope id (e.g. org id, objective id, execution id, iteration id)')
    .requiredOption('--period-start <iso>', 'period start (ISO timestamp)')
    .requiredOption('--period-end <iso>', 'period end (ISO timestamp)')
    .option('--max-tokens <n>', 'max total tokens (in + out)')
    .option('--max-cost-usd-micro <n>', 'max cost in micro-USD (1 USD = 1,000,000)')
    .option('--max-tool-calls <n>', 'max tool calls')
    .option('--max-duration-ms <n>', 'max wall-clock duration (ms)')
    .option('--max-iterations <n>', 'max iterations')
    .option('--no-hard-stop', 'do not hard-stop execution when exceeded (default: hard-stop enabled)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!SCOPE_KINDS.includes(options.scope)) {
        throw new Error(`--scope must be one of: ${SCOPE_KINDS.join(', ')}`);
      }

      const body = {
        org_id: orgId,
        scope_kind: options.scope,
        scope_id: options.scopeId,
        period_start: options.periodStart,
        period_end: options.periodEnd,
        max_tokens: numOrUndefined(options.maxTokens),
        max_cost_usd_micro: numOrUndefined(options.maxCostUsdMicro),
        max_tool_calls: numOrUndefined(options.maxToolCalls),
        max_duration_ms: numOrUndefined(options.maxDurationMs),
        max_iterations: numOrUndefined(options.maxIterations),
        hard_stop: options.hardStop,
      };

      const data = await client.post(resolveEndpoint('budgets.create').path, {
        service: resolveEndpoint('budgets.create').service,
        body,
      });
      const b = data.data?.budget || data.budget || data;
      printSuccess(`Budget created (${b.id}).`);
      formatDetail(b, { format: program.opts().output });
    });

  // ── budget update ────────────────────────────────────────────────────────────

  budget
    .command('update')
    .description('Update a budget')
    .argument('<id>', 'budget ID')
    .option('--period-start <iso>', 'new period start (ISO timestamp)')
    .option('--period-end <iso>', 'new period end (ISO timestamp)')
    .option('--max-tokens <n>', 'new max total tokens')
    .option('--max-cost-usd-micro <n>', 'new max cost in micro-USD')
    .option('--max-tool-calls <n>', 'new max tool calls')
    .option('--max-duration-ms <n>', 'new max wall-clock duration (ms)')
    .option('--max-iterations <n>', 'new max iterations')
    .option('--hard-stop <bool>', 'set hard_stop (true|false)')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const patch = { org_id: orgId };
      if (options.periodStart !== undefined) patch.period_start = options.periodStart;
      if (options.periodEnd !== undefined) patch.period_end = options.periodEnd;
      if (options.maxTokens !== undefined) patch.max_tokens = numOrUndefined(options.maxTokens);
      if (options.maxCostUsdMicro !== undefined) patch.max_cost_usd_micro = numOrUndefined(options.maxCostUsdMicro);
      if (options.maxToolCalls !== undefined) patch.max_tool_calls = numOrUndefined(options.maxToolCalls);
      if (options.maxDurationMs !== undefined) patch.max_duration_ms = numOrUndefined(options.maxDurationMs);
      if (options.maxIterations !== undefined) patch.max_iterations = numOrUndefined(options.maxIterations);
      if (options.hardStop !== undefined) {
        if (options.hardStop !== 'true' && options.hardStop !== 'false') {
          throw new Error('--hard-stop must be "true" or "false".');
        }
        patch.hard_stop = options.hardStop === 'true';
      }

      if (Object.keys(patch).length === 1) {
        throw new Error('Specify at least one field to update.');
      }

      const data = await client.patch(resolveEndpoint('budgets.update', { id }).path, {
        service: resolveEndpoint('budgets.update', { id }).service,
        body: patch,
      });
      const b = data.data?.budget || data.budget || data;
      printSuccess('Budget updated.');
      formatDetail(b, { format: program.opts().output });
    });

  // ── budget delete ────────────────────────────────────────────────────────────

  budget
    .command('delete')
    .description('Delete a budget')
    .argument('<id>', 'budget ID')
    .option('--force', 'skip confirmation')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Delete budget ${id}? This cannot be undone.`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Cancelled.');
          return;
        }
      }

      await client.delete(resolveEndpoint('budgets.delete', { id }).path, {
        service: resolveEndpoint('budgets.delete', { id }).service,
        body: { org_id: orgId },
      });
      printSuccess('Budget deleted.');
    });

  // ── budget usage ─────────────────────────────────────────────────────────────

  budget
    .command('usage')
    .description('Show rolled-up usage + daily breakdown for a budget')
    .argument('<id>', 'budget ID')
    .option('--since <iso>', 'filter usage since this ISO timestamp')
    .option('--until <iso>', 'filter usage until this ISO timestamp')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { org_id: orgId };
      if (options.since) query.since = options.since;
      if (options.until) query.until = options.until;

      const data = await client.get(resolveEndpoint('budgets.usage', { id }).path, {
        service: resolveEndpoint('budgets.usage', { id }).service,
        query,
      });
      const payload = data.data || data;

      formatDetail(payload.usage, {
        format: program.opts().output,
        title: `Budget Usage: ${id}`,
      });

      if (program.opts().output !== 'json' && program.opts().output !== 'quiet') {
        formatOutput({
          columns: ['date', 'tokens_in', 'tokens_out', 'cost_usd_micro', 'tool_calls', 'duration_ms', 'iteration_count'],
          headers: ['Date', 'Tokens In', 'Tokens Out', 'Cost (micro-USD)', 'Tool Calls', 'Duration (ms)', 'Iterations'],
          rows: payload.daily || [],
        }, { format: program.opts().output, emptyMessage: 'No daily usage recorded.' });
      }
    });
}
