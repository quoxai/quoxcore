/**
 * Workflow commands: CRUD, run, steps, versions, declarative apply/validate/import (WP2.5)
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import yaml from 'js-yaml';
import { formatOutput, formatDetail, printWarning, printInfo, getOutputFormat } from '../core/output.js';
import { events, printEvent, line as glyphLine } from '../core/quoxglyph.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { confirmDestructive } from '../core/confirm.js';

// Top-level Workflow fields compared for `workflow apply`'s diff-preview
// (mirrors core/workflow.ts's WorkflowSchema field set, minus `id`).
const APPLY_DIFF_FIELDS = ['name', 'description', 'notes', 'version', 'nodes', 'edges', 'variables', 'credentials', 'settings', 'metadata'];

/**
 * Read a declarative workflow/template file (.yaml/.yml/.json) and parse it
 * to a plain object. Falls back to trying both parsers when the extension
 * is unrecognized (YAML is a superset of JSON, so this also covers a
 * misnamed .json-shaped file).
 */
function readDeclarativeFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read ${filePath}: ${err.message}`);
  }

  const ext = extname(filePath).toLowerCase();
  try {
    if (ext === '.json') return JSON.parse(raw);
    if (ext === '.yaml' || ext === '.yml') return yaml.load(raw);
    try {
      return JSON.parse(raw);
    } catch {
      return yaml.load(raw);
    }
  } catch (err) {
    throw new Error(`Could not parse ${filePath} (expected YAML or JSON): ${err.message}`);
  }
}

/** Short human-readable summary of a field value for the diff-preview. */
function summarizeValue(value) {
  if (value === undefined) return '(unset)';
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value !== null && typeof value === 'object') return `${Object.keys(value).length} key(s)`;
  return JSON.stringify(value);
}

/**
 * Build a field-level diff between the currently-stored workflow (from
 * `workflows.applyGet`) and the local file, restricted to fields present in
 * the local file — used by `workflow apply` to preview a PUT before firing it.
 */
function buildApplyDiff(existing, incoming) {
  const existingDef = existing.definition || existing;
  const changes = [];
  for (const key of APPLY_DIFF_FIELDS) {
    if (!(key in incoming)) continue;
    const before = existingDef[key];
    const after = incoming[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({ key, before, after });
  }
  return changes;
}

function printApplyDiff(workflowId, changes) {
  console.log(`\nChanges to workflow ${workflowId}:`);
  for (const { key, before, after } of changes) {
    console.log(`  ${key}: ${summarizeValue(before)} -> ${summarizeValue(after)}`);
  }
  console.log('');
}

// Read one engine workflow by id, or by its exact name when no id matches (proof cases and people know
// names; engine ids are wf-<ms>-<6>). An ambiguous name is refused with the matching ids, never guessed.
async function getEngineWorkflow(client, ref) {
  const ep = resolveEndpoint('workflows.applyGet', { workflowId: ref });
  try {
    const res = await client.get(ep.path, { service: ep.service });
    return res.data || res;
  } catch (err) {
    if (err.status !== 404) throw err;
    const listEp = resolveEndpoint('workflows.applyList');
    const matches = [];
    for (let offset = 0, guard = 0; guard < 200; guard++) {
      const data = await client.get(listEp.path, { service: listEp.service, query: { limit: 100, offset } });
      const items = data.data || data.items || data.workflows || (Array.isArray(data) ? data : []);
      for (const w of items) if (w && w.name === ref) matches.push(w);
      offset += items.length;
      const pg = data.pagination;
      if (!pg || !items.length || !(offset < pg.total)) break;
    }
    if (matches.length > 1) throw new Error(`Workflow name "${ref}" matches ${matches.length} workflows (${matches.map((m) => m.id).join(', ')}); give the id instead.`);
    if (!matches.length) throw err;
    const byId = resolveEndpoint('workflows.applyGet', { workflowId: matches[0].id });
    const res = await client.get(byId.path, { service: byId.service });
    return res.data || res;
  }
}

export function registerWorkflowCommands(program, ctx) {
  const { client, auth } = ctx;

  const workflow = program
    .command('workflow')
    .description('Manage workflows');

  // fleet #465: workflows live in two stores. The engine (quoxflow) is the
  // WRITE path for `workflow apply`/`activate`, but the auth-service store
  // is a completely separate model quoxflow never writes to. `list` and
  // `get` below read BOTH (or try engine-first with a fallback) and label
  // which store answered, instead of silently missing engine-created
  // workflows the way the auth-only read used to.

  workflow
    .command('list')
    .description('List workflows')
    .option('--status <status>', 'filter by status')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = {};
      if (options.status) query.status = options.status;

      const rows = [];

      try {
        const ep = resolveEndpoint('workflows.applyList');
        // The engine pages (default 20, max 100). Walk every page so the list is the
        // whole store, not the first page (121 workflows read as 20 before).
        const PAGE = 100;
        for (let offset = 0, guard = 0; guard < 200; guard++) {
          const data = await client.get(ep.path, { service: ep.service, query: { limit: PAGE, offset } });
          const items = data.data || data.items || data.workflows || (Array.isArray(data) ? data : []);
          for (const item of items) rows.push({ ...item, source: 'engine' });
          const pg = data.pagination;
          offset += items.length;
          if (!pg || !items.length || !(offset < pg.total)) break;
        }
      } catch (err) {
        printWarning(`Engine (quoxflow) workflow list failed: ${err.message}`);
      }

      try {
        const ep = resolveEndpoint('workflows.list', { orgId });
        const data = await client.get(ep.path, { service: ep.service, query });
        const items = data.items || data.workflows || (Array.isArray(data) ? data : []);
        for (const item of items) rows.push({ ...item, source: 'auth' });
      } catch (err) {
        printWarning(`Auth-service workflow list failed: ${err.message}`);
      }

      formatOutput({
        columns: ['id', 'name', 'status', 'source', 'step_count', 'last_run', 'created_at'],
        headers: ['ID', 'Name', 'Status', 'Source', 'Steps', 'Last Run', 'Created'],
        rows,
      }, { format: program.opts().output });
    });

  workflow
    .command('get')
    .description('Get workflow details')
    .argument('<workflowId>', 'workflow ID or exact name')
    .action(async (workflowId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      let data, source;
      try {
        data = await getEngineWorkflow(client, workflowId);
        source = 'engine';
      } catch (err) {
        if (err.status !== 404) throw err;
        try {
          const ep = resolveEndpoint('workflows.get', { orgId, workflowId });
          const res = await client.get(ep.path, { service: ep.service });
          data = res.workflow || res;
          source = 'auth';
        } catch (err2) {
          if (err2.status !== 404) throw err2;
          throw new Error(
            `Workflow "${workflowId}" was not found in either the engine (quoxflow) or auth-service workflow store.`
          );
        }
      }

      formatDetail({ ...data, source }, { format: program.opts().output, title: data.name });
    });

  // ── workflow schedule <id> ──────────────────────────────────────────────────
  // Is the schedule REALLY registered, and when does it fire next? Read from the live scheduler
  // (GET /api/triggers/schedules), never inferred from the saved config (SITE-CLI 2026-10-17).
  workflow
    .command('schedule')
    .description('Show whether a workflow\'s schedule trigger is registered with the live scheduler, and its next fire time')
    .argument('<workflowId>', 'workflow ID or exact name')
    .action(async (workflowId) => {
      auth.requireAuth();
      const wf = await getEngineWorkflow(client, workflowId);
      const id = wf.id || workflowId;
      const nodes = (wf.definition && wf.definition.nodes) || wf.nodes || [];
      const schedNodes = nodes.filter((n) => n && n.type === 'trigger:schedule');

      const liveEp = resolveEndpoint('triggers.schedules');
      const liveRes = await client.get(liveEp.path, { service: liveEp.service });
      const live = liveRes.data || liveRes;
      const ownedByTasks = live.owned_by === 'tasks';
      const rows = (live.schedules || []).filter((r) => r.workflowId === id);

      const schedules = schedNodes.map((n) => {
        const cfg = n.config || {};
        const saved = cfg.expression || cfg.cron || null;
        const reg = rows.find((r) => r.nodeId === n.id);
        if (ownedByTasks) {
          return { nodeId: n.id, registered: null, state: 'unknown', saved, expression: null, timezone: cfg.timezone || 'UTC', nextFireAt: null,
            reason: 'Scheduling is owned by the tasks service on this instance; the workflow engine cannot see registrations.' };
        }
        if (!reg) {
          return { nodeId: n.id, registered: false, state: 'not registered', saved, expression: null, timezone: cfg.timezone || 'UTC', nextFireAt: null,
            reason: wf.active === false ? 'The workflow is not active, so its schedule is not registered. Activate it to register.' : 'Not registered with the scheduler.' };
        }
        return { nodeId: n.id, registered: true, state: reg.active ? 'active' : 'paused', saved, expression: reg.expression, timezone: reg.timezone || 'UTC', nextFireAt: reg.nextFireAt || null };
      });

      const result = { workflowId: id, name: wf.name, active: wf.active, ...(live.owned_by ? { owned_by: live.owned_by } : {}), schedules,
        ...(schedNodes.length ? {} : { note: 'This workflow has no schedule trigger.' }) };
      if (getOutputFormat() === 'json' || program.opts().output === 'json') { formatDetail(result, { format: 'json' }); return; }
      if (!schedNodes.length) { printInfo(`${id}: ${result.note}`); return; }
      if (ownedByTasks) printInfo(live.note || 'Schedules are managed by the tasks service.');
      formatOutput({
        columns: ['nodeId', 'registeredLabel', 'state', 'expression', 'timezone', 'nextFireAt', 'reason'],
        headers: ['Node', 'Registered', 'State', 'Cron (live)', 'Timezone', 'Next Fire', 'Note'],
        rows: schedules.map((r) => ({ ...r, registeredLabel: r.registered === true ? 'yes' : r.registered === false ? 'no' : 'unknown', expression: r.expression || '-', nextFireAt: r.nextFireAt || '-', reason: r.reason || '' })),
      }, { format: program.opts().output });
    });

  workflow
    .command('create')
    .description('Create a new workflow in the workflow engine (quoxflow). --steps takes a JSON array of nodes (chained in order) or an object with nodes and optional edges')
    .requiredOption('--name <name>', 'workflow name')
    .option('--description <desc>', 'description')
    .option('--steps <json>', 'nodes as a JSON array (chained sequentially), or {"nodes":[...],"edges":[...]}')
    .action(async (options) => {
      auth.requireAuth();
      // #1190: the engine is the one workflow store. Same id shape as `workflow apply`.
      const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
      let nodes = [];
      let edges = [];
      if (options.steps) {
        const steps = parseJSON(options.steps, '--steps');
        if (Array.isArray(steps)) {
          nodes = steps;
          edges = steps.slice(1).map((n, i) => ({ id: `e${i + 1}`, source: steps[i].id ?? `n${i}`, target: n.id ?? `n${i + 1}` }));
        } else if (steps && typeof steps === 'object' && Array.isArray(steps.nodes)) {
          nodes = steps.nodes;
          edges = Array.isArray(steps.edges) ? steps.edges : [];
        } else {
          throw new Error('--steps must be a JSON array of nodes, or an object with a "nodes" array (and optional "edges").');
        }
      }
      const body = { id, name: options.name, nodes, edges };
      if (options.description) body.description = options.description;
      const ep = resolveEndpoint('workflows.applyCreate');
      const res = await client.post(ep.path, { service: ep.service, body });
      const created = res?.data || res;
      printEvent(events.created('quox', 'workflow', `${options.name} (quoxflow) id:${created.id || id}`));
      // #1000: --json gets the saved workflow (the event line is suppressed in json mode, which left nothing)
      if (getOutputFormat() === 'json') formatDetail(created, { format: 'json' });
    });

  workflow
    .command('update')
    .description('Update a workflow')
    .argument('<workflowId>', 'workflow ID')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .option('--status <status>', 'new status')
    .action(async (workflowId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      if (options.status) body.status = options.status;
      const data = await client.patch(resolveEndpoint('workflows.update', { orgId, workflowId }).path, { service: resolveEndpoint('workflows.update', { orgId, workflowId }).service, body });
      printEvent(events.updated('quox', 'workflow', workflowId));
      if (getOutputFormat() === 'json') formatDetail(data?.workflow || data, { format: 'json' });
    });

  workflow
    .command('delete')
    .description('Delete a workflow')
    .argument('<workflowId>', 'workflow ID')
    .action(async (workflowId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // #997: engine (quoxflow) first, the auth store only on an engine 404 (same order as `workflow get`)
      let source = 'engine';
      try {
        const ep = resolveEndpoint('workflows.applyDelete', { workflowId });
        await client.delete(ep.path, { service: ep.service });
      } catch (err) {
        if (err.status !== 404) throw err;
        source = 'auth';
        await client.delete(resolveEndpoint('workflows.delete', { orgId, workflowId }).path, { service: resolveEndpoint('workflows.delete', { orgId, workflowId }).service });
      }
      printEvent(glyphLine('quox', 'workflow deleted', { result: `${workflowId} (${source})`, status: 'ok' }));
    });

  workflow
    .command('run')
    .description('Execute a workflow (must be published/active — see `workflow publish`)')
    .argument('<workflowId>', 'workflow ID')
    .option('--input <json>', 'input data as JSON (passed as run context)')
    .action(async (workflowId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { workflow_id: workflowId };
      if (options.input) body.context = parseJSON(options.input, '--input');
      try {
        const data = await client.post(resolveEndpoint('runs.create', { orgId }).path, { service: resolveEndpoint('runs.create', { orgId }).service, body });
        printEvent(glyphLine('quox', 'workflow run', { result: `${workflowId} -> run ${data.run?.id || data.run_id || data.id || 'ok'}`, status: 'ok' }));
      } catch (err) {
        if (err.status === 404) {
          // quoxflow#7: the auth runs route only knows auth-store workflows. If
          // the engine store has it, execute it there instead.
          let engineExists = false;
          try {
            const getEp = resolveEndpoint('workflows.applyGet', { workflowId });
            await client.get(getEp.path, { service: getEp.service });
            engineExists = true;
          } catch (engineErr) {
            if (engineErr.status !== 404) throw engineErr;
          }
          if (engineExists) {
            const exEp = resolveEndpoint('workflows.applyExecute', { workflowId });
            // #1029: the engine reads triggerData (a bare body lost --input), and async returns the run id at once
            const run = await client.post(exEp.path, { service: exEp.service, body: { triggerData: body.context || {}, async: true } });
            const runId = run.executionId || run.execution_id || run.runId || run.run_id || run.id || run.execution?.id || 'ok';
            const st = run.status || run.execution?.status;
            printEvent(glyphLine('quox', 'workflow run', { result: `${workflowId} (quoxflow) -> run ${runId}${st ? ` [${st}]` : ''}`, status: 'ok' }));
            return;
          }
          throw new Error(
            `Workflow not found or not active. Only published workflows can be run — try \`quox workflow publish ${workflowId}\` first.`
          );
        }
        throw err;
      }
    });

  workflow
    .command('publish')
    .description('Publish a workflow')
    .argument('<workflowId>', 'workflow ID')
    .action(async (workflowId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      try {
        const ep = resolveEndpoint('workflows.publish', { orgId, workflowId });
        await client.post(ep.path, { service: ep.service });
        printEvent(glyphLine('quox', 'workflow published', { result: workflowId, status: 'ok' }));
      } catch (err) {
        if (err.status !== 404) throw err;

        // fleet #465: publish operates on the auth-service model only. A
        // workflow that exists solely in the engine (e.g. via `workflow
        // apply`) 404s here even though it exists — check the engine before
        // reporting a bare "not found".
        let engineExists = false;
        try {
          const getEp = resolveEndpoint('workflows.applyGet', { workflowId });
          await client.get(getEp.path, { service: getEp.service });
          engineExists = true;
        } catch (engineErr) {
          if (engineErr.status !== 404) throw engineErr;
        }

        if (engineExists) {
          throw new Error(
            `Workflow "${workflowId}" lives in the engine (quoxflow) store, not the auth-service store that `
            + `\`workflow publish\` operates on. Use \`quox trigger workflow-activate ${workflowId}\` to make it live — `
            + '`workflow publish` only applies to workflows created via `workflow create`.'
          );
        }

        throw new Error(
          `Workflow "${workflowId}" was not found in either the engine (quoxflow) or auth-service workflow store.`
        );
      }
    });

  // Steps subcommand
  const steps = workflow
    .command('steps')
    .description('Manage workflow steps');

  steps
    .command('list')
    .description('List steps of a workflow')
    .argument('<workflowId>', 'workflow ID')
    .action(async (workflowId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // No dedicated GET .../steps route exists: steps are a field on the
      // workflow object itself. quox#928: look in the same stores `workflow get`
      // does, engine (quoxflow) first, so engine workflows (wf-obj-*) resolve too.
      let rows;
      try {
        const ep = resolveEndpoint('workflows.applyGet', { workflowId });
        const res = await client.get(ep.path, { service: ep.service });
        const wf = res.data || res;
        const nodes = wf?.definition?.nodes || wf?.nodes;
        if (!Array.isArray(nodes)) throw Object.assign(new Error('not an engine workflow'), { status: 404 });
        rows = nodes.map((n, idx) => ({ idx, label: n.name || n.id, step_type: n.type, ref_id: n.config?.tool || n.config?.toolName || '-' }));
      } catch (err) {
        if (err.status !== 404) throw err;
        const data = await client.get(resolveEndpoint('workflows.get', { orgId, workflowId }).path, { service: resolveEndpoint('workflows.get', { orgId, workflowId }).service });
        rows = (data.workflow || data).steps || [];
      }
      formatOutput({
        // fleet #392: workflow_steps columns are idx/label/step_type/ref_id.
        columns: ['idx', 'label', 'step_type', 'ref_id'],
        headers: ['#', 'Name', 'Type', 'Tool'],
        rows,
      }, { format: program.opts().output });
    });

  steps
    .command('set')
    .description('Set workflow steps (replaces all)')
    .argument('<workflowId>', 'workflow ID')
    .requiredOption('--steps <json>', 'steps as JSON array')
    .action(async (workflowId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const stepList = parseJSON(options.steps, '--steps');
      try {
        await client.put(resolveEndpoint('workflows.steps', { orgId, workflowId }).path, {
          service: resolveEndpoint('workflows.steps', { orgId, workflowId }).service,
          body: { steps: stepList },
        });
      } catch (err) {
        if (err.status !== 404) throw err;
        // #997: `steps list` reads engine workflows too, so an engine id 404'd here with a bare 'Workflow not found'.
        // An engine workflow is a node/edge graph, not a step list: refuse it by name, like `workflow publish`.
        let engineExists = false;
        try {
          const getEp = resolveEndpoint('workflows.applyGet', { workflowId });
          await client.get(getEp.path, { service: getEp.service });
          engineExists = true;
        } catch (engineErr) {
          if (engineErr.status !== 404) throw engineErr;
        }
        if (engineExists) {
          throw new Error(
            `Workflow "${workflowId}" lives in the engine (quoxflow) store, where it is a graph of nodes and edges, `
            + 'not the step list `workflow steps set` replaces. Edit it with `quox workflow apply -f <file>` '
            + `(start from \`quox -o json workflow get ${workflowId}\`).`
          );
        }
        throw new Error(
          `Workflow "${workflowId}" was not found in either the engine (quoxflow) or auth-service workflow store.`
        );
      }
      printEvent(events.updated('quox', 'workflow steps', workflowId));
    });

  // ── workflow apply / validate / import-n8n / import-objective (WP2.5) ───────
  //
  // Declarative, file-based create/edit against quoxflow's own workflow
  // engine — DIRECT to quoxflow (service: 'quoxflow'), NOT the auth-service
  // 'workflows.create'/'workflows.update' used by the commands above. See
  // the header comment in lib/api/endpoints/workflows.js for the full
  // access-path + naming-collision rationale.

  workflow
    .command('apply')
    .description('Create or update a workflow declaratively from a YAML/JSON file (quoxflow-direct: POST if the file has no id, PUT with a diff-preview if it does)')
    .requiredOption('-f, --file <path>', 'path to a workflow definition file (.yaml/.yml/.json)')
    .option('--force', 'skip the diff-preview confirmation on update')
    .action(async (options) => {
      auth.requireAuth();
      const wf = readDeclarativeFile(options.file);
      if (!wf || typeof wf !== 'object') {
        throw new Error(`${options.file} did not parse to a workflow object.`);
      }

      if (wf.id) {
        let existing = null;
        try {
          const getEp = resolveEndpoint('workflows.applyGet', { workflowId: wf.id });
          const data = await client.get(getEp.path, { service: getEp.service });
          existing = data.data || data;
        } catch (err) {
          if (err.status !== 404) throw err;
        }

        if (existing) {
          const changes = buildApplyDiff(existing, wf);
          if (changes.length === 0) {
            printInfo(`No field-level changes detected for workflow ${wf.id}. Nothing to apply.`);
            return;
          }
          printApplyDiff(wf.id, changes);

          // fleet #468 item 3: on a non-TTY shell (no --force/-y) the old
          // unconditional inquirer.prompt() call printed "User force closed
          // the prompt with 0 null" and returned silently WITHOUT applying,
          // which looked like success but wasn't. confirmDestructive() checks
          // process.stdin.isTTY before ever importing inquirer, so a
          // non-interactive shell without --force now fails loudly (exit
          // code 1) naming --force, instead of no-op-ing.
          const confirmed = await confirmDestructive(program, options, `Apply these changes to workflow ${wf.id}?`);
          if (!confirmed) {
            printInfo('Cancelled.');
            return;
          }

          const putEp = resolveEndpoint('workflows.applyUpdate', { workflowId: wf.id });
          const data = await client.put(putEp.path, { service: putEp.service, body: wf });
          printEvent(glyphLine('quox', 'workflow updated', { result: `${wf.id} (quoxflow)`, status: 'ok' }));
          formatDetail(data.data || data, { format: program.opts().output });
          return;
        }

        // An id was given but nothing is stored under it yet — falls
        // through to create below (POST also accepts a caller-supplied id).
        printInfo(`No existing workflow found for id "${wf.id}" — creating.`);
      }

      const createEp = resolveEndpoint('workflows.applyCreate');
      // #1000: quoxflow's WorkflowSchema requires an id, so "no id = create" 400'd. Mint one in the
      // engine's own wf-<ms>-<6> shape; the created id is printed, so the file can be given it to update later.
      const body = wf.id ? wf : { ...wf, id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}` };
      const data = await client.post(createEp.path, { service: createEp.service, body });
      const created = data.data || data;
      printEvent(events.created('quox', 'workflow', `${created.name || wf.name || created.id} (quoxflow) id:${created.id}`));
      formatDetail(created, { format: program.opts().output });
    });

  workflow
    .command('validate')
    .description('Validate a workflow (quoxflow-direct). Give a stored workflow id to fetch and validate it (the same read path as `workflow get`), or -f <file> to validate the workflow stored under that file\'s "id" field. NOTE: this validates the STORED workflow, not local file content; run `workflow apply -f <file>` first to validate your latest edits.')
    .argument('[workflowId]', 'stored workflow ID (fetched the same way `quox workflow get` does, then validated). Omit if using -f instead.')
    .option('-f, --file <path>', 'workflow file — only its "id" field is used to look up the stored workflow')
    .action(async (workflowId, options) => {
      auth.requireAuth();

      let targetId;
      if (options.file) {
        const wf = readDeclarativeFile(options.file);
        if (!wf?.id) {
          throw new Error(`${options.file} has no "id" field. \`workflow validate\` checks the STORED workflow by id, not local file content — apply the file first with \`quox workflow apply -f ${options.file}\`, or add an "id" matching an existing workflow.`);
        }
        targetId = wf.id;
      } else if (workflowId) {
        // fleet #468 item 1: `quox workflow validate <id>` previously required
        // -f/--file even when the caller already had a stored workflow id.
        // Fetch it through the same read path `quox workflow get` uses, so a
        // missing id fails with the same "not found" signal that command gives.
        const orgId = resolveOrgId(auth, program);
        const getEp = resolveEndpoint('workflows.get', { orgId, workflowId });
        try {
          await client.get(getEp.path, { service: getEp.service });
        } catch (err) {
          if (err.status !== 404) throw err;
          // `workflow get` also reads the engine (quoxflow) store; engine-only workflows
          // (most of them) are not in the auth store, so fall back the same way.
          try {
            const engEp = resolveEndpoint('workflows.applyGet', { workflowId });
            await client.get(engEp.path, { service: engEp.service });
          } catch (err2) {
            if (err2.status === 404) {
              throw new Error(`Workflow "${workflowId}" was not found on the read path \`quox workflow get\` uses. Use -f <file> to validate a local file instead.`);
            }
            throw err2;
          }
        }
        targetId = workflowId;
      } else {
        throw new Error('Provide either a workflow id argument or -f <file>. Example: `quox workflow validate <id>`, or `quox workflow validate -f workflow.yaml`.');
      }

      const ep = resolveEndpoint('workflows.validate', { workflowId: targetId });
      const data = await client.post(ep.path, { service: ep.service });
      const result = data.data || data;
      formatDetail(result, { format: program.opts().output, title: `Validation: ${targetId}` });
    });

  workflow
    .command('import-n8n')
    .description('Import an n8n workflow export as a quoxflow workflow')
    .requiredOption('-f, --file <path>', 'path to an n8n workflow export (.yaml/.yml/.json)')
    .option('--generate-ids', 'generate new node/workflow ids instead of reusing the n8n ones')
    .option('--include-positions', 'preserve n8n canvas node positions')
    .action(async (options) => {
      auth.requireAuth();
      const parsed = readDeclarativeFile(options.file);
      // Accept either a raw n8n export, or an already-wrapped { workflow, options } body.
      const n8nWorkflow = parsed && typeof parsed === 'object' && 'workflow' in parsed ? parsed.workflow : parsed;
      const importOptions = { ...(parsed?.options || {}) };
      if (options.generateIds) importOptions.generateIds = true;
      if (options.includePositions) importOptions.includePositions = true;

      const ep = resolveEndpoint('workflows.importN8n');
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { workflow: n8nWorkflow, options: Object.keys(importOptions).length ? importOptions : undefined },
      });
      const result = data.data || data;
      printEvent(glyphLine('quox', 'n8n workflow imported', { result: result.workflow?.id || result.id, status: 'ok' }));
      if (result.warnings?.length) {
        for (const w of result.warnings) printWarning(w);
      }
      formatDetail(result.workflow || result, { format: program.opts().output });
    });

  workflow
    .command('import-objective')
    .description('Import an objective template as a quoxflow workflow')
    .requiredOption('-f, --file <path>', 'path to an objective template (.yaml/.yml/.json) — a bare template object, or { template, schedule, options }')
    .option('--cron <expr>', 'cron schedule expression (adds/overrides schedule.cron)')
    .option('--timezone <tz>', 'schedule timezone (adds/overrides schedule.timezone)')
    .option('--activate', 'activate the imported workflow (registers triggers)')
    .option('--include-approval-gate', 'insert an approval gate node')
    .action(async (options) => {
      auth.requireAuth();
      const parsed = readDeclarativeFile(options.file);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`${options.file} did not parse to an object.`);
      }
      const template = parsed.template && typeof parsed.template === 'object' ? parsed.template : parsed;
      const schedule = { ...(parsed.schedule || {}) };
      if (options.cron) schedule.cron = options.cron;
      if (options.timezone) schedule.timezone = options.timezone;
      const importOptions = { ...(parsed.options || {}) };
      if (options.activate) importOptions.activate = true;
      if (options.includeApprovalGate) importOptions.includeApprovalGate = true;

      const body = { template };
      if (schedule.cron) body.schedule = schedule;
      if (Object.keys(importOptions).length) body.options = importOptions;

      const ep = resolveEndpoint('workflows.importObjective');
      const data = await client.post(ep.path, { service: ep.service, body });
      const result = data.data || data;
      printEvent(glyphLine('quox', 'objective template imported', { result: `${result.workflow?.id || result.id}${result.activated ? ' (activated)' : ''}`, status: 'ok' }));
      if (result.warnings?.length) {
        for (const w of result.warnings) printWarning(w);
      }
      formatDetail(result.workflow || result, { format: program.opts().output });
    });
}
