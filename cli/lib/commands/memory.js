/**
 * Memory commands: CRUD, search, stats, export, batch
 *
 * FINDING F5 (SEER first-test, QuoxIdentity): `memory search` used to hit
 * the memory service DIRECTLY at :3103 (fragile cert/port, and a different
 * code path from everything else). It now routes through the collector's
 * governed POST /api/v1/tools/execute (tool_name memory_search), matching
 * how nucleus.js and fleet.js already call that endpoint, so the op is
 * org-scoped and audited exactly like every other tool call.
 *
 * `list` and `create` stay on the direct memory-service path: the collector
 * only exposes memory_save/memory_search/memory_update/entity_note as
 * governed tools (services/collector/lib/agentTools.js MEMORY_TOOLS): there
 * is no memory_list tool, and memory_search itself 400s without a non-empty
 * `q` (services/memory/server.js), so it cannot stand in for an unfiltered
 * list. memory_save's type enum (fact/preference/decision/constraint/
 * observation) also does not match `create`'s documented enum (which
 * includes `entity`, not `constraint`), and it has no input for targeting
 * an arbitrary --agent the way the direct endpoint's body.agent_id does.
 * Converting either would be a silent behaviour change, not a port fix, so
 * they were left as-is. See the F5 task report for the full note.
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxError } from '../core/errors.js';
import { resolveOrgId } from './helpers.js';
import { resolveMyAttach } from './agentAttach.js';

// QUOXIDENTITY P9: which agent this session acts as is resolved session-scoped
// (QUOX_T subtree / QUOX_ATTACH_AGENT override / single-attach fallback), so
// two sessions on one box no longer collide. See agentAttach.js resolveMyAttach.
const detectSoleAttachLease = resolveMyAttach;

/**
 * Call a governed collector memory tool (POST /api/v1/tools/execute).
 * Lease-aware: when exactly one attach lease is active, the call is made
 * AS that agent (its attach token, no caller org_id override) so the op is
 * witnessed under the agent's own identity and scoped server-side to its
 * namespace (services/collector/lib/memoryToolHandlers.js already scopes
 * memory_search to attachLeaseId's agent_id). Otherwise it runs as the
 * caller's own identity, org-scoped like nucleus.js's tool calls.
 */
async function callMemoryTool({ client, auth, program }, toolName, input) {
  const ep = resolveEndpoint('v1.tools.execute');
  const body = { tool_name: toolName, input };
  const requestOptions = { service: ep.service, body };

  const lease = detectSoleAttachLease();
  if (lease) {
    requestOptions.noAuth = true;
    requestOptions.headers = { Authorization: `Bearer ${lease.token}` };
  } else {
    const orgId = resolveOrgId(auth, program);
    if (orgId) body.org_id = orgId;
  }

  return client.post(ep.path, requestOptions);
}

export function registerMemoryCommands(program, ctx) {
  const { client, auth } = ctx;

  const memory = program
    .command('memory')
    .description('Manage memories');

  memory
    .command('list')
    .description('List memories')
    .option('--type <type>', 'filter by type: fact, preference, decision, entity, observation')
    .option('--limit <n>', 'max results', '50')
    .option('--agent <agentId>', 'filter by agent')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.type) query.type = options.type;
      if (options.agent) query.agent_id = options.agent;
      const data = await client.get(resolveEndpoint('memory.list').path, { service: resolveEndpoint('memory.list').service, query });
      formatOutput({
        columns: ['id', 'type', 'content', 'tags', 'created_at'],
        headers: ['ID', 'Type', 'Content', 'Tags', 'Created'],
        rows: (data.memories || data).map(m => ({
          ...m,
          // fleet #373: the service stores/returns `memory_type`; this table
          // read `type` and so rendered "-" for every row even though
          // `--json` showed the value correctly.
          type: m.memory_type ?? m.type,
          content: (m.content || '').slice(0, 80),
          tags: Array.isArray(m.tags) ? m.tags.join(', ') : m.tags,
        })),
      }, { format: program.opts().output });
    });

  memory
    .command('get')
    .description('Get memory details')
    .argument('<id>', 'memory ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('memory.get', { id }).path, { service: resolveEndpoint('memory.get', { id }).service });
      formatDetail(data.memory || data, { format: program.opts().output });
    });

  // Codex cycle 4 #10: how beliefs changed, and undoing a wrong correction.
  memory
    .command('timeline')
    .description('Decisions that changed over time (newest change first)')
    .argument('[query]', 'only chains mentioning this text')
    .option('--limit <n>', 'max decisions', '20')
    .action(async (query, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('memory.timeline');
      const data = await client.get(ep.path, { service: ep.service, query: { q: query || '', limit: options.limit } });
      const decisions = data.decisions || [];
      formatOutput({
        columns: ['id', 'changes', 'last_change', 'now', 'was'],
        headers: ['Current ID', 'Changes', 'Last change', 'Now', 'Was'],
        rows: decisions.map((d) => ({
          id: d.current.id,
          changes: d.changes,
          last_change: d.last_change || '-',
          now: (d.current.content || '').slice(0, 70),
          was: (d.history[d.history.length - 2]?.content || '').slice(0, 70),
        })),
      }, { format: program.opts().output, raw: data });
    });

  memory
    .command('history')
    .description('Full change history of one belief, oldest first, with reasons')
    .argument('<id>', 'memory ID (any version in the chain)')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('memory.history', { id });
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['id', 'state', 'created_at', 'content', 'reason'],
        headers: ['ID', 'State', 'Created', 'Content', 'Replaced because'],
        rows: (data.history || []).map((m) => ({
          id: m.id,
          state: m.valid ? 'current' : 'replaced',
          created_at: m.created_at,
          content: (m.content || '').slice(0, 80),
          reason: (m.superseded_reason || '').slice(0, 80),
        })),
      }, { format: program.opts().output, raw: data });
    });

  memory
    .command('reinstate')
    .description('Undo a wrong correction: make a replaced belief current again')
    .argument('<id>', 'ID of the replaced belief that was right')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('memory.reinstate', { id });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Reinstated ${data.reinstated?.id}; retired ${data.retired?.id} (marked disputed, Dream will not re-apply it)`);
    });

  memory
    .command('create')
    .description('Save a new memory')
    .requiredOption('--type <type>', 'memory type: fact, preference, decision, entity, observation')
    .requiredOption('--content <text>', 'memory content')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--agent <agentId>', 'agent ID')
    .action(async (options) => {
      auth.requireAuth();
      const body = {
        type: options.type,
        content: options.content,
      };
      if (options.tags) body.tags = options.tags.split(',').map(t => t.trim());
      if (options.agent) body.agent_id = options.agent;
      await client.post(resolveEndpoint('memory.create').path, { service: resolveEndpoint('memory.create').service, body });
      printSuccess('Memory saved.');
    });

  memory
    .command('update')
    .description('Update a memory')
    .argument('<id>', 'memory ID')
    .option('--content <text>', 'new content')
    .option('--tags <tags>', 'new tags (comma-separated)')
    .action(async (id, options) => {
      auth.requireAuth();
      const body = {};
      if (options.content) body.content = options.content;
      if (options.tags) body.tags = options.tags.split(',').map(t => t.trim());
      await client.patch(resolveEndpoint('memory.update', { id }).path, { service: resolveEndpoint('memory.update', { id }).service, body });
      printSuccess('Memory updated.');
    });

  memory
    .command('delete')
    .description('Delete a memory')
    .argument('<id>', 'memory ID')
    .option('--hard', 'permanently delete (no soft-delete)')
    .action(async (id, options) => {
      auth.requireAuth();
      const query = {};
      if (options.hard) query.hard = 'true';
      await client.delete(resolveEndpoint('memory.delete', { id }).path, { service: resolveEndpoint('memory.delete', { id }).service, query });
      printSuccess('Memory deleted.');
    });

  // ONE-BRAIN CX6: the user-facing twin of the Cortex memory_forget tool.
  // Same endpoint as `delete`; confirmation is required, like `notes rm`.
  memory
    .command('forget')
    .description('Forget one of your memories (soft delete). Requires --yes. --permanent erases it for good (irreversible).')
    .argument('<id>', 'memory ID')
    .option('--permanent', 'permanently erase the memory (no soft-delete); cannot be undone')
    .option('--yes', 'confirm forgetting')
    .action(async (id, options) => {
      auth.requireAuth();
      if (!options.yes) throw new QuoxError(`Refusing to ${options.permanent ? 'permanently erase' : 'forget'} memory ${id} without --yes.`, 2);
      const ep = resolveEndpoint('memory.delete', { id });
      const query = {};
      if (options.permanent) query.hard = 'true';
      await client.delete(ep.path, { service: ep.service, query });
      printSuccess(options.permanent ? `Permanently erased memory ${id}.` : `Forgot memory ${id}.`);
    });

  memory
    .command('search')
    .description('Search memories')
    // #620: accept a positional query as shorthand; --query still works and
    // wins if both are given. One of the two is required.
    .argument('[query]', 'search query (shorthand for --query)')
    .option('--query <q>', 'search query')
    .option('--limit <n>', 'max results', '20')
    .option('--type <type>', 'filter by type')
    .action(async (queryArg, options) => {
      auth.requireAuth();
      const query = options.query || queryArg;
      if (!query) {
        throw new Error('A search query is required: `quox memory search "your query"` or --query "your query".');
      }
      // FINDING F5: governed path (POST /api/v1/tools/execute, tool_name
      // memory_search) instead of a direct GET against the memory service.
      // See the file header comment for why list/create stayed direct.
      const input = { query, limit: options.limit };
      if (options.type) input.type_filter = options.type;
      const data = await callMemoryTool({ client, auth, program }, 'memory_search', input);
      formatOutput({
        // The governed memory_search tool's result shape (services/collector
        // /lib/memoryToolHandlers.js memorySearch) has no `rank`/`score`
        // field (it drops the FTS bm25 rank), so this column shows '-'.
        columns: ['id', 'type', 'content', 'rank'],
        headers: ['ID', 'Type', 'Content', 'Score'],
        rows: (data.results || data.memories || []).map(m => ({
          ...m,
          type: m.memory_type ?? m.type, // fleet #373, same as list above
          content: (m.content || '').slice(0, 80),
          rank: typeof m.rank === 'number' ? m.rank.toFixed(2) : (m.rank ?? '-'),
        })),
      }, { format: program.opts().output });
    });

  memory
    .command('stats')
    .description('Show memory statistics')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('memory.stats.list').path, { service: resolveEndpoint('memory.stats.list').service });
      formatDetail(data.stats || data, {
        format: program.opts().output,
        title: 'Memory Stats',
      });
    });

  memory
    .command('export')
    .description('Export all memories')
    .option('--format <fmt>', 'export format', 'json')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('memory.export.list').path, { service: resolveEndpoint('memory.export.list').service, query: { format: options.format } });
      console.log(JSON.stringify(data, null, 2));
    });
}
