/**
 * Inbox / HITL commands: list, get, respond
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { attachWalkthrough } from './walkthrough.js';
import { getApprovalContext, formatApprovalContext, approvalListColumns } from '../core/approvalContext.js';
import { QuoxUserError } from '../core/errors.js';
import { resolutionFromItem, alreadyResolvedError } from '../core/inboxResolution.js';
import chalk from 'chalk';

export function registerInboxCommands(program, ctx) {
  const { client, auth } = ctx;

  // An agent hands back a tool approvalId (tool_approvals.approval_id), stored on the card as
  // aee_correlation_id. The server now resolves it on GET and respond (CLI-ERRORS); this client-side
  // scan stays as the fallback for an older server. A failed scan is reported, never read as "no card".
  async function findByApprovalId(orgId, id) {
    const list = resolveEndpoint('inbox.list', { orgId });
    const data = await client.get(list.path, { service: list.service, query: { status: 'all', kind: 'approval', limit: 200 } });
    const items = (data && (data.items || data)) || [];
    const hit = Array.isArray(items) && items.find((it) => it.aee_correlation_id === id || (it.payload && it.payload.approval_id === id));
    return hit ? hit.id : null;
  }

  function notFound(id, cause) {
    const err = new QuoxUserError(`No inbox item or approval with id ${id} in this org, open or resolved.`, {
      next: "if it came from another org, switch with `quox org switch <org>`; `quox inbox list --status all` lists this org's items.",
      exitCode: 5, code: 'not_found', status: 404, body: cause?.body,
    });
    return err;
  }

  async function resolveItemId(orgId, id) {
    const direct = resolveEndpoint('inbox.get', { orgId, itemId: id });
    try {
      const data = await client.get(direct.path, { service: direct.service });
      // the server resolves an approvalId to its card; post to the card's own id
      return (data && data.item && data.item.id) || id;
    } catch (err) {
      if (!err || err.status !== 404) throw err;
      const hit = await findByApprovalId(orgId, id);
      if (hit) return hit;
      throw notFound(id, err);
    }
  }

  const inbox = program
    .command('inbox')
    .description('Manage inbox and approval requests');
  attachWalkthrough(inbox, ctx, program);

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
      const format = program.opts().output;
      const post = (itemId) => {
        const ep = resolveEndpoint('inbox.respond', { orgId, itemId });
        return client.post(ep.path, { service: ep.service, body: { action: options.action, comment: options.comment } });
      };
      // Resolve an approvalId to its card (server-side on a current server, else the client scan). When
      // this profile cannot see the card, still ask the server: it knows WHY (an agent login, another
      // org, already decided) and says so, where "not found" would hide it.
      let itemId = givenId;
      try { itemId = await resolveItemId(orgId, givenId); } catch (err) { if (err?.code !== 'not_found') throw err; }
      let result;
      try {
        result = await post(itemId);
      } catch (err) {
        if (err?.status === 404) throw notFound(givenId, err);
        if (!result) {
          const resolution = await alreadyResolvedFrom(err, orgId, itemId, options.action);
          if (!resolution) throw err;
          if (!resolution.matches) throw alreadyResolvedError(resolution, err);
          if (format === 'json') console.log(JSON.stringify({ success: true, already_resolved: true, ...resolution }));
          else if (format !== 'quiet') console.log(chalk.green(`✔ ${resolution.message}`));
          return;
        }
      }
      if (result?.item?.status === 'expired') {
        throw new QuoxUserError(result.message || 'This approval had expired, so nothing ran.', {
          next: 're-run the original command to ask for a fresh approval.', exitCode: 1, code: 'approval_expired',
        });
      }
      const PAST = { approve: 'approved', reject: 'rejected', deny: 'denied', defer: 'deferred', resolve: 'resolved', answer: 'answered' };
      printSuccess(`Item ${PAST[options.action] || `${options.action} recorded`}.`);
    });

  // A respond on a closed card: the server's structured answer, else (older server) read the card.
  async function alreadyResolvedFrom(err, orgId, givenId, action) {
    if (!err || err.status !== 400) return null;
    const body = err.body || {};
    if (body.code === 'already_resolved' && body.resolution) return { ...body.resolution, message: body.message };
    if (!/not open for response/i.test(`${body.error || ''} ${err.message || ''}`)) return null;
    try {
      const ep = resolveEndpoint('inbox.get', { orgId, itemId: givenId });
      const data = await client.get(ep.path, { service: ep.service });
      return resolutionFromItem(data.item || data, action);
    } catch { return null; }
  }

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
