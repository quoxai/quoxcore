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
        // Journey #3 (2026-10-19): the engine path sent no query, so --workflow/--status/--limit were ignored and a
        // filter for one workflow listed every workflow's runs. quoxflow's /api/executions takes all three.
        const ep = resolveEndpoint('executions.list');
        const engineQuery = { ...(options.workflow ? { workflowId: options.workflow } : {}), ...(options.status ? { status: options.status } : {}), limit: options.limit };
        const data = await client.get(ep.path, { service: ep.service, query: engineQuery });
        let items = data.data || data.items || (Array.isArray(data) ? data : []);
        // an older engine that ignores the filter must still never show another workflow's runs
        if (options.workflow) items = items.filter((it) => (it.workflowId ?? it.workflow_id) === options.workflow);
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
    .option('--wait', 'engine workflows: wait for the run to finish (up to 10 minutes) instead of returning its id at once')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { workflow_id: options.workflow };
      if (options.input) body.context = parseJSON(options.input, '--input');
      let data;
      try {
        data = await client.post(resolveEndpoint('runs.create', { orgId }).path, { service: resolveEndpoint('runs.create', { orgId }).service, body });
      } catch (err) {
        if (err.status !== 404) throw err;
        // #997: the auth runs model only knows auth-store workflows; an engine workflow runs on the engine
        // (same fallback as `workflow run`, quoxflow#7).
        const getEp = resolveEndpoint('workflows.applyGet', { workflowId: options.workflow });
        try { await client.get(getEp.path, { service: getEp.service }); } catch (engineErr) { if (engineErr.status === 404) throw err; throw engineErr; }
        const exEp = resolveEndpoint('workflows.applyExecute', { workflowId: options.workflow });
        // #1029: start async by default and return the id at once; the engine ran synchronously before, so any
        // run past the 30 s client timeout printed 'timed out' while it kept going. --wait keeps the old shape.
        const ran = await client.post(exEp.path, {
          service: exEp.service,
          body: { triggerData: body.context || {}, async: !options.wait },
          ...(options.wait ? { timeout: 600000 } : {}),
        });
        const runId = ran.executionId || ran.execution_id || ran.id || ran.execution?.id || ran.data?.executionId || 'ok';
        const st = ran.status || ran.execution?.status || ran.data?.status;
        printSuccess(`Run started (engine): ${runId}${st ? ` [${st}]` : ''}`);
        if (!options.wait && runId !== 'ok') console.log(`  Follow it: quox run get ${runId}`);
        return;
      }
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
      // #997: engine first (the runs `run list` shows), auth-store fallback on a 404 only
      const source = await engineFirst(
        () => { const ep = resolveEndpoint('executions.cancel', { executionId: runId }); return client.post(ep.path, { service: ep.service, body }); },
        () => client.post(resolveEndpoint('runs.cancel', { orgId, runId }).path, { service: resolveEndpoint('runs.cancel', { orgId, runId }).service, body }),
      );
      printSuccess(`Run cancelled (${source}).`);
    });

  run
    .command('resume')
    .description('Resume a paused run')
    .argument('<runId>', 'run ID')
    .option('--response <json>', 'human response payload as JSON')
    .option('--wait', 'engine runs: wait for the resumed run to finish (up to 10 minutes) instead of answering at once')
    .action(async (runId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const response = options.response ? parseJSON(options.response, '--response') : undefined;
      const body = response === undefined ? {} : { response };
      // #997: the engine's resume body IS the decision ({approved, approver, reason?}; approver must be you);
      // the auth model wraps it as { response }.
      const source = await engineFirst(
        // #1037: async by default; the engine checks the approver synchronously, then runs the rest in the background
        () => {
          const ep = resolveEndpoint('executions.resume', { executionId: runId });
          return client.post(ep.path, {
            service: ep.service,
            body: { ...(response || {}), async: !options.wait },
            ...(options.wait ? { timeout: 600000 } : {}),
          });
        },
        () => client.post(resolveEndpoint('runs.resume', { orgId, runId }).path, { service: resolveEndpoint('runs.resume', { orgId, runId }).service, body }),
      );
      printSuccess(`Run resumed (${source}).`);
      if (source === 'engine' && !options.wait) console.log(`  Follow it: quox run get ${runId}`);
    });
}

// #997: try the engine (quoxflow) store, fall back to the auth-service store only when the engine says 404.
// Any other engine answer (409 already terminal, 400 not paused) is the real outcome and is thrown.
async function engineFirst(engineCall, authCall) {
  try { await engineCall(); return 'engine'; } catch (err) { if (err.status !== 404) throw err; }
  await authCall();
  return 'auth';
}
