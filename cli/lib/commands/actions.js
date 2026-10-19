/**
 * Action Tracker commands (read-only): `quox actions list | get`.
 *
 * #839 / #891: the agent has action_list but the CLI had no verb, so Action
 * Tracker answers could not be checked against CLI truth. These verbs call the
 * SAME governed tool the Action Tracker UI and the agent use (POST
 * /api/v1/tools/execute, tool_name action_list), so chat, UI and CLI read one
 * source. Writes (add/move/update/delete) stay in chat and the UI for now.
 */

import { formatOutput, formatDetail } from '../core/output.js';
import { QuoxError } from '../core/errors.js';
import { executeGovernedTool } from './tool.js';

const STATUSES = ['todo', 'doing', 'done', 'all'];

async function listItems(ctx, { status = 'all', limit = 100, scope } = {}) {
  if (!STATUSES.includes(status)) {
    throw new QuoxError(`--status must be one of ${STATUSES.join(', ')}`);
  }
  const input = { status, limit: Math.min(Math.max(Number(limit) || 20, 1), 100) };
  if (scope) input.scope_id = scope;
  const data = await executeGovernedTool(ctx, 'action_list', input);
  const result = data && data.result !== undefined ? data.result : data;
  if (!result || result.success === false) {
    throw new QuoxError(`action_list failed: ${(result && (result.error || result.message)) || 'no result'}`);
  }
  return Array.isArray(result.items) ? result.items : [];
}

export function registerActionsCommands(program, ctx) {
  const actions = program
    .command('actions')
    .description('Action Tracker items (read-only; add and move items in chat or the dashboard)');

  actions
    .command('list')
    .description('List action items')
    .option('--status <status>', 'todo, doing, done or all', 'all')
    .option('--limit <n>', 'max items (1-100)', '100')
    .option('--scope <scopeId>', 'only items in this team/department/division scope')
    .action(async (options) => {
      const items = await listItems({ ...ctx, program }, options);
      formatOutput({
        columns: ['id', 'status', 'priority', 'title', 'dueDate'],
        headers: ['ID', 'Status', 'Priority', 'Title', 'Due'],
        rows: items.map((i) => ({ ...i, dueDate: i.dueDate || '-' })),
      }, { raw: items });
    });

  actions
    .command('get')
    .description('Show one action item by id')
    .argument('<id>', 'action item id (from `quox actions list`)')
    .action(async (id) => {
      const items = await listItems({ ...ctx, program }, { status: 'all', limit: 100 });
      const item = items.find((i) => i.id === id);
      if (!item) throw new QuoxError(`No action item ${id} among the latest 100 items.`);
      formatDetail(item);
    });
}
