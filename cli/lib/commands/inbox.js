/**
 * Inbox / HITL commands: list, get, respond
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { getApprovalContext, formatApprovalContext, approvalListColumns } from '../core/approvalContext.js';

export function registerInboxCommands(program, ctx) {
  const { client, auth } = ctx;

  // An agent hands back a tool approvalId (tool_approvals.approval_id), which is
  // stored on the inbox card as aee_correlation_id, not its item id. No server
  // lookup-by-correlation route exists, so on a 404 we scan the org's approval
  // cards (all statuses) client-side. Falls back to the id as given.
  async function resolveItemId(orgId, id) {
    const direct = resolveEndpoint('inbox.get', { orgId, itemId: id });
    try {
      await client.get(direct.path, { service: direct.service });
      return id;
    } catch (err) {
      if (!err || err.status !== 404) throw err;
      const list = resolveEndpoint('inbox.list', { orgId });
      let data;
      try {
        data = await client.get(list.path, { service: list.service, query: { status: 'all', kind: 'approval', limit: 200 } });
      } catch { data = null; }
      const items = (data && (data.items || data)) || [];
      const hit = Array.isArray(items) && items.find((it) => it.aee_correlation_id === id || (it.payload && it.payload.approval_id === id));
      if (hit) return hit.id;
      err.message += `\nHint: ${id} is not an inbox item id, and no approval card in your recent approvals carries it as an approvalId. `
        + 'Try `quox inbox list --status all` to find the card.';
      throw err;
    }
  }

  const inbox = program
    .command('inbox')
    .description('Manage inbox and approval requests');

  inbox
    .command('list')
    .description('List inbox items')
    .option('--status <status>', 'filter: one status, a comma list (resolved,cancelled,expired), or all (includes answered approvals). Default: active only')
    .option('--decision <decision>', 'with resolved/all: approved or rejected')
    .option('--page <n>', 'page number (newest first)')
    .option('--priority <priority>', 'filter: low, normal, high, urgent')
    .option('--awaiting-human', 'org-wide: approvals waiting for a human (see-only, cannot act)')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { limit: options.limit };
      if (options.status) query.status = options.status;
      if (options.decision) query.decision = options.decision;
      if (options.page) query.page = options.page;
      if (options.priority) query.priority = options.priority;
      if (options.awaitingHuman) query.awaiting_human = 'true';
      const data = await client.get(resolveEndpoint('inbox.list', { orgId }).path, { service: resolveEndpoint('inbox.list', { orgId }).service, query });
      // HITL-CONTEXT: Source + Reason columns from payload.approval_context so a
      // stale approval still says who asked and why without opening it.
      const items = (data.items || data || []).map((it) => ({ ...it, ...approvalListColumns(it) }));
      formatOutput({
        columns: ['id', 'kind', 'priority', 'title', 'source', 'reason', 'status', 'created_at'],
        headers: ['ID', 'Kind', 'Priority', 'Title', 'Source', 'Reason', 'Status', 'Created'],
        rows: items,
      }, { format: program.opts().output });
    });

  inbox
    .command('get')
    .alias('show')
    .description('Get inbox item details (alias: show), including the approval context: source, on behalf of, reason, method, why approval')
    .argument('<itemId>', 'inbox item ID, or a tool approvalId from an agent')
    .action(async (givenId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const itemId = await resolveItemId(orgId, givenId);
      const data = await client.get(resolveEndpoint('inbox.get', { orgId, itemId }).path, { service: resolveEndpoint('inbox.get', { orgId, itemId }).service });
      const item = data.item || data;
      const format = program.opts().output;
      const context = getApprovalContext(item);
      if (context && format !== 'json') {
        // Lead with the context block: it is what a human needs to decide.
        console.log(formatApprovalContext(context));
        console.log('');
        const { payload, ...rest } = item;
        const { approval_context: _omit, ...payloadRest } = payload || {};
        formatDetail({ ...rest, payload: payloadRest }, { format });
        return;
      }
      formatDetail(item, { format });
    });

  inbox
    .command('respond')
    .description('Respond to an inbox item')
    .argument('<itemId>', 'inbox item ID, or a tool approvalId from an agent')
    .requiredOption('--action <action>', 'action: approve, reject, defer, resolve')
    .option('--comment <text>', 'response comment')
    .action(async (givenId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const itemId = await resolveItemId(orgId, givenId);
      await client.post(resolveEndpoint('inbox.respond', { orgId, itemId }).path, {
        service: resolveEndpoint('inbox.respond', { orgId, itemId }).service,
        body: { action: options.action, comment: options.comment },
      });
      printSuccess(`Item ${options.action}ed.`);
    });

  inbox
    .command('stats')
    .description('Show inbox statistics')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('inbox.stats.list', { orgId }).path, { service: resolveEndpoint('inbox.stats.list', { orgId }).service });
      formatDetail(data.stats || data, { format: program.opts().output, title: 'Inbox Stats' });
    });
}
