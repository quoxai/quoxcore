/**
 * Trace commands: TRV (Trace Replay & Visualization) — assembled QuoxTraces,
 * what-if simulation, trace comparison, and persisted replay
 * sessions/comparisons/correlation cache.
 *
 * quox trace list|get|simulate|compare
 * quox trace replay list|get|create|update|delete|delete-all
 * quox trace comparison list|get|create|update|delete|delete-all
 * quox trace correlation list|get|create|delete
 *
 * Backend: services/collector/server.js (TRV-1/TRV-2/TRV-5/TRV-6), mounted
 * at plain `/traces` — collector-direct, NOT org-scoped in the URL (same
 * pattern as `quox aee`/`quox chat`). See endpoints/traces.js's header for
 * the verified org-scoping finding on the list reads.
 *
 * UX note (repo lesson, project_trv_ux): don't bury the useful data behind
 * an extra fetch. `trace get` prints the narrative + key facts inline, not
 * just a raw JSON dump requiring a follow-up call.
 */

import { randomUUID } from 'node:crypto';
import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/** Flatten the nested `actor` object into a display string for table rows. */
function actorLabel(actor) {
  if (!actor) return '';
  return actor.display_name || actor.id || '';
}

function normalizeTraceSummary(t) {
  return { ...t, actor: actorLabel(t.actor) };
}

async function confirmOrSkip(program, options, message) {
  if (options.force || program.opts().yes) return true;
  const { default: inquirer } = await import('inquirer');
  const ans = await inquirer.prompt([{ type: 'confirm', name: 'confirm', message, default: false }]);
  return ans.confirm;
}

export function registerTraceCommands(program, ctx) {
  const { client, auth } = ctx;

  const trace = program
    .command('trace')
    .description('Trace Replay & Visualization: assembled traces, simulation, comparison, replay sessions');

  // ── trace list ──────────────────────────────────────────────────────────────

  trace
    .command('list')
    .description('List assembled trace summaries')
    .option('--limit <n>', 'max results', '30')
    .option('--offset <n>', 'result offset', '0')
    .option('--after <iso>', 'only traces starting at/after this ISO timestamp')
    .option('--before <iso>', 'only traces starting before this ISO timestamp')
    .option('--actor <id>', 'filter by actor ID (e.g. human.adam)')
    .option('--outcome <outcome>', 'filter by outcome')
    .option('--denied', 'only traces with at least one policy denial')
    .option('--hitl', 'only traces with at least one HITL layer')
    .option('--sort <mode>', 'newest|oldest|slowest|fastest', 'newest')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit, offset: options.offset, sort: options.sort };
      if (options.after) query.after = options.after;
      if (options.before) query.before = options.before;
      if (options.actor) query.actor = options.actor;
      if (options.outcome) query.outcome = options.outcome;
      if (options.denied) query.has_denial = 'true';
      if (options.hitl) query.has_hitl = 'true';

      const data = await client.get(resolveEndpoint('traces.list').path, {
        service: resolveEndpoint('traces.list').service,
        query,
      });
      const traces = (data.traces || data || []).map(normalizeTraceSummary);

      formatOutput({
        columns: ['run_id', 'actor', 'outcome', 'layer_count', 'decision_count', 'has_denial', 'has_hitl', 'duration_ms', 'started_at'],
        headers: ['Run ID', 'Actor', 'Outcome', 'Layers', 'Decisions', 'Denied', 'HITL', 'Duration (ms)', 'Started'],
        rows: traces,
      }, { format: program.opts().output, emptyMessage: 'No traces found.' });

      if (program.opts().output !== 'json' && program.opts().output !== 'quiet' && typeof data.total === 'number') {
        printInfo(`Showing ${traces.length} of ${data.total} trace(s).`);
      }
    });

  // ── trace get ───────────────────────────────────────────────────────────────

  trace
    .command('get')
    .description('Assemble and show a single trace (narrative + per-layer waterfall)')
    .argument('<identifier>', 'conversation ID (corr) or RUN_ id')
    .option('--include-raw', 'include raw layer payloads')
    .action(async (identifier, options) => {
      auth.requireAuth();
      const query = {};
      if (options.includeRaw) query.include_raw = 'true';

      const t = await client.get(resolveEndpoint('traces.get', { id: identifier }).path, {
        service: resolveEndpoint('traces.get', { id: identifier }).service,
        query,
      });

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(t, null, 2));
        return;
      }
      if (format === 'quiet') {
        console.log(t.run_id || t.corr || '');
        return;
      }

      formatDetail({ ...t, id: t.run_id }, {
        format,
        title: `Trace: ${t.run_id || identifier}`,
        fields: ['id', 'corr', 'actor', 'query', 'outcome', 'narrative', 'duration_ms', 'layer_count', 'decision_count', 'has_denial', 'has_hitl', 'compliance_tags', 'most_interesting_layer', 'started_at', 'ended_at', 'volt'],
        labels: {
          id: 'Run ID', corr: 'Conversation', actor: 'Actor', query: 'Query', outcome: 'Outcome',
          narrative: 'Narrative', duration_ms: 'Duration (ms)', layer_count: 'Layers',
          decision_count: 'Decisions', has_denial: 'Denied', has_hitl: 'HITL',
          compliance_tags: 'Compliance Tags', most_interesting_layer: 'Most Interesting Layer',
          started_at: 'Started', ended_at: 'Ended', volt: 'VOLT',
        },
      });

      if (Array.isArray(t.layers) && t.layers.length > 0) {
        console.log('');
        formatOutput({
          columns: ['layer_id', 'layer_label', 'status', 'outcome', 'duration_ms', 'layer_summary'],
          headers: ['Layer', 'Name', 'Status', 'Outcome', 'Duration (ms)', 'Summary'],
          rows: t.layers,
        }, { format, emptyMessage: 'No layers.' });
      }
    });

  // ── trace simulate ──────────────────────────────────────────────────────────

  trace
    .command('simulate')
    .description('Run a what-if policy simulation against a trace (TRV-5)')
    .argument('<identifier>', 'conversation ID (corr) or RUN_ id')
    .option('--policy-overrides <json>', 'JSON map of layer_id -> { action } overrides')
    .option('--layer-toggles <json>', 'JSON map of layer_id -> enabled(bool)')
    .option('--query-override <text>', 'replacement query text')
    .action(async (identifier, options) => {
      auth.requireAuth();
      const body = {};
      if (options.policyOverrides) body.policy_overrides = parseJSON(options.policyOverrides, '--policy-overrides');
      if (options.layerToggles) body.layer_toggles = parseJSON(options.layerToggles, '--layer-toggles');
      if (options.queryOverride !== undefined) body.query_override = options.queryOverride;

      const data = await client.post(resolveEndpoint('traces.simulate', { id: identifier }).path, {
        service: resolveEndpoint('traces.simulate', { id: identifier }).service,
        body,
      });

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      printInfo(`Confidence: ${data.confidence}${data.simulation_boundary ? ` (boundary ${data.simulation_boundary})` : ''}`);
      formatOutput({
        columns: ['layer_id', 'original_outcome', 'simulated_outcome'],
        headers: ['Layer', 'Original', 'Simulated'],
        rows: data.diffs || [],
      }, { format, emptyMessage: 'No differences — simulation matches the original trace.' });
    });

  // ── trace compare ───────────────────────────────────────────────────────────

  trace
    .command('compare')
    .description('Compare two traces with layer-aligned diffs (TRV-6)')
    .requiredOption('--a <identifier>', 'first trace ID (corr or RUN_ id)')
    .requiredOption('--b <identifier>', 'second trace ID (corr or RUN_ id)')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.post(resolveEndpoint('traces.compare').path, {
        service: resolveEndpoint('traces.compare').service,
        body: { trace_a: options.a, trace_b: options.b },
      });

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      printInfo(data.summary || '');
      formatOutput({
        // fleet #392: compare returns diff_type, not status.
        columns: ['layer_id', 'diff_type'],
        headers: ['Layer', 'Diff'],
        rows: data.layer_diffs || [],
      }, { format, emptyMessage: 'No layer diffs.' });
    });

  // ══ trace replay — persisted replay sessions ════════════════════════════════

  const replay = trace
    .command('replay')
    .description('Manage persisted trace replay sessions');

  replay
    .command('list')
    .description('List replay sessions')
    .option('--limit <n>', 'max results', '30')
    .option('--offset <n>', 'result offset', '0')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('traces.replaySessions.list').path, {
        service: resolveEndpoint('traces.replaySessions.list').service,
        query: { limit: options.limit, offset: options.offset },
      });
      formatOutput({
        columns: ['id', 'run_id', 'status', 'created_at', 'completed_at'],
        headers: ['ID', 'Run ID', 'Status', 'Created', 'Completed'],
        rows: data.sessions || data || [],
      }, { format: program.opts().output, emptyMessage: 'No replay sessions found.' });
    });

  replay
    .command('get')
    .description('Show a replay session')
    .argument('<id>', 'replay session ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('traces.replaySessions.get', { id }).path, {
        service: resolveEndpoint('traces.replaySessions.get', { id }).service,
      });
      formatDetail(data.session || data, { format: program.opts().output, title: `Replay Session: ${id}` });
    });

  replay
    .command('create')
    .description('Create a replay session for a run')
    .requiredOption('--run-id <runId>', 'the RUN_ id being replayed')
    .option('--id <id>', 'replay session ID (auto-generated if omitted)')
    .option('--status <status>', 'initial status', 'pending')
    .option('--query <text>', 'replacement query for the replay')
    .option('--layer-config <json>', 'JSON layer configuration')
    .option('--mock-config <json>', 'JSON mock configuration')
    .option('--original-trace <json>', 'JSON snapshot of the original trace')
    .action(async (options) => {
      auth.requireAuth();
      const body = {
        id: options.id || randomUUID(),
        run_id: options.runId,
        status: options.status,
      };
      if (options.query) body.query = options.query;
      if (options.layerConfig) body.layer_config = parseJSON(options.layerConfig, '--layer-config');
      if (options.mockConfig) body.mock_config = parseJSON(options.mockConfig, '--mock-config');
      if (options.originalTrace) body.original_trace = parseJSON(options.originalTrace, '--original-trace');

      const data = await client.post(resolveEndpoint('traces.replaySessions.create').path, {
        service: resolveEndpoint('traces.replaySessions.create').service,
        body,
      });
      printSuccess(`Replay session "${body.id}" created.`);
      formatDetail(data.session || data, { format: program.opts().output });
    });

  replay
    .command('update')
    .description('Update a replay session (status and/or result)')
    .argument('<id>', 'replay session ID')
    .option('--status <status>', 'new status')
    .option('--result <json>', 'JSON replay result')
    .action(async (id, options) => {
      auth.requireAuth();
      if (!options.status && !options.result) {
        throw new Error('Specify at least one field to update (--status, --result).');
      }
      const body = {};
      if (options.status) body.status = options.status;
      if (options.result) body.replay_result = parseJSON(options.result, '--result');

      const data = await client.put(resolveEndpoint('traces.replaySessions.update', { id }).path, {
        service: resolveEndpoint('traces.replaySessions.update', { id }).service,
        body,
      });
      printSuccess('Replay session updated.');
      formatDetail(data.session || data, { format: program.opts().output });
    });

  replay
    .command('delete')
    .description('Delete a replay session')
    .argument('<id>', 'replay session ID')
    .option('--force', 'skip confirmation')
    .action(async (id, options) => {
      auth.requireAuth();
      if (!(await confirmOrSkip(program, options, `Delete replay session ${id}? This cannot be undone.`))) {
        printInfo('Cancelled.');
        return;
      }
      await client.delete(resolveEndpoint('traces.replaySessions.delete', { id }).path, {
        service: resolveEndpoint('traces.replaySessions.delete', { id }).service,
      });
      printSuccess('Replay session deleted.');
    });

  replay
    .command('delete-all')
    .description('Delete ALL replay sessions')
    .option('--force', 'skip confirmation')
    .action(async (options) => {
      auth.requireAuth();
      if (!(await confirmOrSkip(program, options, 'Delete ALL replay sessions? This cannot be undone.'))) {
        printInfo('Cancelled.');
        return;
      }
      await client.delete(resolveEndpoint('traces.replaySessions.deleteAll').path, {
        service: resolveEndpoint('traces.replaySessions.deleteAll').service,
      });
      printSuccess('All replay sessions deleted.');
    });

  // ══ trace comparison — persisted trace comparisons ══════════════════════════

  const comparison = trace
    .command('comparison')
    .description('Manage persisted trace comparisons');

  comparison
    .command('list')
    .description('List trace comparisons')
    .option('--limit <n>', 'max results', '30')
    .option('--offset <n>', 'result offset', '0')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('traces.comparisons.list').path, {
        service: resolveEndpoint('traces.comparisons.list').service,
        query: { limit: options.limit, offset: options.offset },
      });
      const rows = (data.comparisons || data || []).map(c => ({
        ...c,
        corr_ids: Array.isArray(c.corr_ids) ? c.corr_ids.join(', ') : c.corr_ids,
      }));
      formatOutput({
        columns: ['id', 'name', 'corr_ids', 'similarity_score', 'created_at'],
        headers: ['ID', 'Name', 'Traces', 'Similarity', 'Created'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No trace comparisons found.' });
    });

  comparison
    .command('get')
    .description('Show a trace comparison')
    .argument('<id>', 'comparison ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('traces.comparisons.get', { id }).path, {
        service: resolveEndpoint('traces.comparisons.get', { id }).service,
      });
      formatDetail(data.comparison || data, { format: program.opts().output, title: `Trace Comparison: ${id}` });
    });

  comparison
    .command('create')
    .description('Persist a comparison across two or more traces')
    .requiredOption('--corr-ids <ids>', 'comma-separated conversation IDs (corr) to compare')
    .option('--id <id>', 'comparison ID (auto-generated if omitted)')
    .option('--name <name>', 'comparison name')
    .option('--options <json>', 'JSON comparison options')
    .option('--result <json>', 'JSON precomputed comparison result')
    .option('--similarity-score <n>', 'similarity score (0-1)')
    .action(async (options) => {
      auth.requireAuth();
      const body = {
        id: options.id || randomUUID(),
        corr_ids: options.corrIds.split(',').map(s => s.trim()).filter(Boolean),
      };
      if (options.name) body.name = options.name;
      if (options.options) body.options = parseJSON(options.options, '--options');
      if (options.result) body.result = parseJSON(options.result, '--result');
      if (options.similarityScore) body.similarity_score = parseFloat(options.similarityScore);

      const data = await client.post(resolveEndpoint('traces.comparisons.create').path, {
        service: resolveEndpoint('traces.comparisons.create').service,
        body,
      });
      printSuccess(`Trace comparison "${body.id}" created.`);
      formatDetail(data.comparison || data, { format: program.opts().output });
    });

  comparison
    .command('update')
    .description('Rename a trace comparison')
    .argument('<id>', 'comparison ID')
    .requiredOption('--name <name>', 'new name')
    .action(async (id, options) => {
      auth.requireAuth();
      await client.put(resolveEndpoint('traces.comparisons.update', { id }).path, {
        service: resolveEndpoint('traces.comparisons.update', { id }).service,
        body: { name: options.name },
      });
      printSuccess('Trace comparison updated.');
    });

  comparison
    .command('delete')
    .description('Delete a trace comparison')
    .argument('<id>', 'comparison ID')
    .option('--force', 'skip confirmation')
    .action(async (id, options) => {
      auth.requireAuth();
      if (!(await confirmOrSkip(program, options, `Delete trace comparison ${id}? This cannot be undone.`))) {
        printInfo('Cancelled.');
        return;
      }
      await client.delete(resolveEndpoint('traces.comparisons.delete', { id }).path, {
        service: resolveEndpoint('traces.comparisons.delete', { id }).service,
      });
      printSuccess('Trace comparison deleted.');
    });

  comparison
    .command('delete-all')
    .description('Delete ALL trace comparisons')
    .option('--force', 'skip confirmation')
    .action(async (options) => {
      auth.requireAuth();
      if (!(await confirmOrSkip(program, options, 'Delete ALL trace comparisons? This cannot be undone.'))) {
        printInfo('Cancelled.');
        return;
      }
      await client.delete(resolveEndpoint('traces.comparisons.deleteAll').path, {
        service: resolveEndpoint('traces.comparisons.deleteAll').service,
      });
      printSuccess('All trace comparisons deleted.');
    });

  // ══ trace correlation — cross-agent correlation cache ═══════════════════════
  // NOTE: the backend route is `/traces/correlations/:runId`, but the row it
  // resolves against is keyed by `root_run_id` (see trvStatements.getCorrelationByRun
  // / deleteCorrelation in services/collector/server.js) — the CLI argument is
  // named <rootRunId> to match that semantics, not the literal route segment name.

  const correlation = trace
    .command('correlation')
    .description('Manage the cross-agent trace correlation cache');

  correlation
    .command('list')
    .description('List cached correlations')
    .option('--limit <n>', 'max results', '30')
    .option('--offset <n>', 'result offset', '0')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('traces.correlations.list').path, {
        service: resolveEndpoint('traces.correlations.list').service,
        query: { limit: options.limit, offset: options.offset },
      });
      formatOutput({
        columns: ['id', 'root_run_id', 'correlation_id', 'agent_count', 'handoff_count', 'created_at', 'expires_at'],
        headers: ['ID', 'Root Run', 'Correlation ID', 'Agents', 'Handoffs', 'Created', 'Expires'],
        rows: data.correlations || data || [],
      }, { format: program.opts().output, emptyMessage: 'No cached correlations found.' });
    });

  correlation
    .command('get')
    .description('Show the cached correlation tree for a root run')
    .argument('<rootRunId>', 'root run ID')
    .action(async (rootRunId) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('traces.correlations.get', { runId: rootRunId }).path, {
        service: resolveEndpoint('traces.correlations.get', { runId: rootRunId }).service,
      });
      formatDetail(data.correlation || data, { format: program.opts().output, title: `Correlation: ${rootRunId}` });
    });

  correlation
    .command('create')
    .description('Store a correlation tree in the cache (24h TTL)')
    .requiredOption('--root-run-id <id>', 'root run ID')
    .requiredOption('--correlation-id <id>', 'correlation ID')
    .option('--id <id>', 'cache entry ID (auto-generated if omitted)')
    .option('--tree <json>', 'JSON correlation tree', '{}')
    .option('--stats <json>', 'JSON stats object')
    .option('--agent-count <n>', 'agent count', '0')
    .option('--handoff-count <n>', 'handoff count', '0')
    .action(async (options) => {
      auth.requireAuth();
      const body = {
        id: options.id || randomUUID(),
        root_run_id: options.rootRunId,
        correlation_id: options.correlationId,
        tree: parseJSON(options.tree, '--tree'),
        agent_count: parseInt(options.agentCount, 10),
        handoff_count: parseInt(options.handoffCount, 10),
      };
      if (options.stats) body.stats = parseJSON(options.stats, '--stats');

      const data = await client.post(resolveEndpoint('traces.correlations.create').path, {
        service: resolveEndpoint('traces.correlations.create').service,
        body,
      });
      printSuccess(`Correlation cached (expires ${data.expires_at}).`);
    });

  correlation
    .command('delete')
    .description('Delete the cached correlation for a root run')
    .argument('<rootRunId>', 'root run ID')
    .option('--force', 'skip confirmation')
    .action(async (rootRunId, options) => {
      auth.requireAuth();
      if (!(await confirmOrSkip(program, options, `Delete cached correlation for ${rootRunId}?`))) {
        printInfo('Cancelled.');
        return;
      }
      await client.delete(resolveEndpoint('traces.correlations.delete', { runId: rootRunId }).path, {
        service: resolveEndpoint('traces.correlations.delete', { runId: rootRunId }).service,
      });
      printSuccess('Cached correlation deleted.');
    });
}
