/**
 * Run commands: list, get, create, cancel, resume
 */

import { formatOutput, formatDetail, printSuccess, printWarning } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerRunCommands(program, ctx) {
  const { client, auth } = ctx;

  const run = program
    .command('run')
    .description('Manage workflow runs');

  // fleet #465: runs live in two stores. The engine (quoxflow) is the
  // execution store `workflow run`/apply-triggered runs actually land in;
  // the auth-service 'runs.*' store is a separate model quoxflow never
  // writes to. `list`/`get` below try the engine FIRST and fall back to the
  // auth-service store, labeling which store answered.

  run
    .command('list')
    .description('List runs')
    .option('--status <status>', 'filter by status')
    .option('--workflow <id>', 'filter by workflow')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      let rows, source;
      try {
        const ep = resolveEndpoint('executions.list');
        const data = await client.get(ep.path, { service: ep.service });
        const items = data.data || data.items || (Array.isArray(data) ? data : []);
        rows = items.map((item) => ({ ...item, source: 'engine' }));
        source = 'engine';
      } catch (err) {
        printWarning(`Engine (quoxflow) execution list failed, falling back to the auth-service store: ${err.message}`);
        const query = { limit: options.limit };
        if (options.status) query.status = options.status;
        if (options.workflow) query.workflow_id = options.workflow;
        const ep = resolveEndpoint('runs.list', { orgId });
        const data = await client.get(ep.path, { service: ep.service, query });
        const items = data.items || data.runs || (Array.isArray(data) ? data : []);
        rows = items.map((item) => ({ ...item, source: 'auth' }));
        source = 'auth';
      }

      formatOutput({
        // fleet #392: runs table has finished_at, not completed_at.
        columns: ['id', 'workflow_name', 'status', 'source', 'started_at', 'finished_at'],
        headers: ['ID', 'Workflow', 'Status', 'Source', 'Started', 'Completed'],
        rows,
      }, { format: program.opts().output, emptyMessage: `No results (${source} store).` });
    });

  run
    .command('get')
    .description('Get run details')
    .argument('<runId>', 'run ID')
    .action(async (runId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      let data, source;
      try {
        const ep = resolveEndpoint('executions.get', { executionId: runId });
        const res = await client.get(ep.path, { service: ep.service });
        data = res.data || res;
        source = 'engine';
      } catch (err) {
        if (err.status !== 404) throw err;
        try {
          const ep = resolveEndpoint('runs.get', { orgId, pollRunId: runId });
          const res = await client.get(ep.path, { service: ep.service });
          data = res.run || res;
          source = 'auth';
        } catch (err2) {
          if (err2.status !== 404) throw err2;
          throw new Error(
            `Run "${runId}" was not found in either the engine (quoxflow) execution store or the auth-service run store.`
          );
        }
      }

      formatDetail({ ...data, source }, { format: program.opts().output });
    });

  run
    .command('create')
    .description('Start a new workflow run')
    .requiredOption('--workflow <id>', 'workflow ID')
    .option('--input <json>', 'input data as JSON')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { workflow_id: options.workflow };
      if (options.input) body.context = parseJSON(options.input, '--input');
      const data = await client.post(resolveEndpoint('runs.create', { orgId }).path, { service: resolveEndpoint('runs.create', { orgId }).service, body });
      printSuccess(`Run started: ${data.run?.id || data.id || 'ok'}`);
    });

  run
    .command('cancel')
    .description('Cancel a running workflow')
    .argument('<runId>', 'run ID')
    .option('--reason <text>', 'cancellation reason')
    .action(async (runId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.reason) body.reason = options.reason;
      await client.post(resolveEndpoint('runs.cancel', { orgId, runId }).path, { service: resolveEndpoint('runs.cancel', { orgId, runId }).service, body });
      printSuccess('Run cancelled.');
    });

  run
    .command('resume')
    .description('Resume a paused run')
    .argument('<runId>', 'run ID')
    .option('--response <json>', 'human response payload as JSON')
    .action(async (runId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.response) body.response = parseJSON(options.response, '--response');
      await client.post(resolveEndpoint('runs.resume', { orgId, runId }).path, { service: resolveEndpoint('runs.resume', { orgId, runId }).service, body });
      printSuccess('Run resumed.');
    });
}
