/**
 * Tool commands: CRUD, catalog, install, publish
 */

import fs from 'node:fs';
import { missingReasonWarning } from '../core/callerSource.js';
import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { capInline, checkShape, shapeOutput, shapeRecord } from '../toolOutputShape.js';

/**
 * QUOXON-LATENCY L2: the per-turn credential. QUOX_AUTH_TOKEN (cold spawn) or, on a warm
 * `claude` spare, QUOX_AUTH_TOKEN_FILE: a file the collector writes for one turn and
 * deletes when it ends. When the file variable is set it is the ONLY credential: a
 * missing or empty file fails closed, never falling back to a stored session or the
 * service key.
 */
function readTurnToken(env) {
  if (env.QUOX_AUTH_TOKEN) return env.QUOX_AUTH_TOKEN;
  if (!env.QUOX_AUTH_TOKEN_FILE) return '';
  let token = '';
  try { token = fs.readFileSync(env.QUOX_AUTH_TOKEN_FILE, 'utf8').trim(); } catch { token = ''; }
  if (!token) throw new Error('No turn credential: QUOX_AUTH_TOKEN_FILE holds no token (the turn has ended). Refusing to use any other credential.');
  return token;
}

const failedOf = (data) => !!((data && data.success === false) || (data && data.result && data.result.success === false));

export function registerToolCommands(program, ctx) {
  const { client, auth } = ctx;

  const tool = program
    .command('tool')
    .description('Manage tools and tool catalog');

  tool
    .command('list')
    .description('List tools in the organization')
    .option('--type <type>', 'filter by type: mcp, function, api, script, workflow')
    .option('--status <status>', 'filter by status: active, draft')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = {};
      if (options.type) query.type = options.type;
      if (options.status) query.status = options.status;
      const data = await client.get(resolveEndpoint('tools.list', { orgId }).path, { service: resolveEndpoint('tools.list', { orgId }).service, query });
      formatOutput({
        // fleet #392: column is tool_type.
        columns: ['id', 'name', 'tool_type', 'status', 'risk_level', 'created_at'],
        headers: ['ID', 'Name', 'Type', 'Status', 'Risk', 'Created'],
        rows: data.items || data.tools || data,
      }, { format: program.opts().output });
    });

  tool
    .command('get')
    .description('Get tool details')
    .argument('<toolId>', 'tool ID')
    .action(async (toolId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('tools.get', { orgId, toolId }).path, { service: resolveEndpoint('tools.get', { orgId, toolId }).service });
      formatDetail(data.tool || data, { format: program.opts().output, title: data.tool?.name || data.name });
    });

  tool
    .command('create')
    .description('Create a new tool')
    .requiredOption('--name <name>', 'tool name')
    .requiredOption('--type <type>', 'type: mcp, function, api, script, workflow')
    .option('--description <desc>', 'description')
    .option('--risk-level <level>', 'risk level: low, medium, high', 'low')
    .option('--spec <json>', 'tool spec as JSON string')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {
        name: options.name,
        tool_type: options.type, // #987: auth reads tool_type ('type' made every create 400)
        risk_level: options.riskLevel,
      };
      if (options.description) body.description = options.description;
      if (options.spec) body.spec = parseJSON(options.spec, '--spec');
      await client.post(resolveEndpoint('tools.create', { orgId }).path, { service: resolveEndpoint('tools.create', { orgId }).service, body });
      printSuccess(`Tool "${options.name}" created.`);
    });

  tool
    .command('update')
    .description('Update a tool')
    .argument('<toolId>', 'tool ID')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .option('--status <status>', 'new status')
    .action(async (toolId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      if (options.status) body.status = options.status;
      await client.patch(resolveEndpoint('tools.update', { orgId, toolId }).path, { service: resolveEndpoint('tools.update', { orgId, toolId }).service, body });
      printSuccess('Tool updated.');
    });

  tool
    .command('delete')
    .description('Delete a tool')
    .argument('<toolId>', 'tool ID')
    .action(async (toolId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('tools.delete', { orgId, toolId }).path, { service: resolveEndpoint('tools.delete', { orgId, toolId }).service });
      printSuccess('Tool deleted.');
    });

  tool
    .command('publish')
    .description('Publish a tool')
    .argument('<toolId>', 'tool ID')
    .action(async (toolId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.post(resolveEndpoint('tools.publish', { orgId, toolId }).path, { service: resolveEndpoint('tools.publish', { orgId, toolId }).service });
      printSuccess('Tool published.');
    });

  tool
    .command('catalog')
    .description('Browse the tool catalog')
    .option('--search <query>', 'search tools')
    .option('--category <cat>', 'filter by category')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.search) query.search = options.search;
      if (options.category) query.category = options.category;
      const data = await client.get(resolveEndpoint('catalog.list').path, { service: resolveEndpoint('catalog.list').service, query });
      // NOTE: display the business key `tool_id` (not the catalog row `id`)
      // as the identifier column — `tool install <toolId>` and the
      // POST /api/tools/install-to-scope handler both validate against
      // tool_definitions.tool_id, not tool_definitions.id. Showing `id`
      // here previously led users to copy the wrong value into `install`.
      formatOutput({
        columns: ['tool_id', 'name', 'category', 'risk_level', 'description'],
        headers: ['Tool ID', 'Name', 'Category', 'Risk', 'Description'],
        rows: data.items || data.tools || data,
      }, { format: program.opts().output });
    });

  tool
    .command('exec')
    .description('Execute a governed tool via the collector (POST /api/v1/tools/execute). Large output: use --select/--summary, never a shell pipe.')
    .argument('<name>', 'tool name/id (the TOOL_DEFS key, e.g. "codebase_query")')
    .option('--args <json>', "tool arguments as a JSON string, e.g. '{\"query\":\"...\"}'", '{}')
    // #620: docs/muscle-memory reach for --input; accept it as an alias for
    // --args so the documented form works. --args still wins if both given.
    .option('--input <json>', 'alias for --args (tool arguments as a JSON string)')
    .option('--reason <text>', 'why you are running this; shown on the approval card if the call is held for a human')
    // #970: governed shaping of a large result (the receipt records the shape). Grammar:
    // a.b, a[0], list[field=value], list[field~text], list[*].field, list[*].{a,b}, list[field=value].name, count(list).
    .option('--select <path>', 'return only this part of the result, e.g. agents[status=disconnected].name, streams[name~license] (contains, any case), layers[*].state (every item), containers[*].{host,name,status} (several fields in one call), count(urls), or several paths at once: total,count(urls)')
    .option('--summary', 'honest summary of the main list: total, per-status counts, first N items ("showing N of M")')
    .option('--limit <n>', 'cap the list to N items (with --summary: the sample size, default 10)')
    .action(async (name, options) => {
      // Prefer whichever was explicitly given; --args carries the '{}' default
      // so it is always defined, hence check --input first.
      const usedInput = options.input !== undefined && (options.args === undefined || options.args === '{}');
      const raw = usedInput ? options.input : options.args;
      const input = parseJSON(raw, usedInput ? '--input' : '--args');
      const shape = { select: options.select, summary: !!options.summary, limit: options.limit };
      // A malformed shape fails BEFORE the tool runs: nothing executes, nothing to receipt.
      const shapeErr = checkShape(shape);
      if (shapeErr) throw new Error(shapeErr);
      const outputShape = shapeRecord(shape);
      const data = await executeGovernedTool({ client, auth, program }, name, input, { reason: options.reason, outputShape });
      // Shape only a completed, successful result: a held or failed call is shown whole.
      let shown = data;
      const held = data && (data.pending || data._approval || data.status === 'pending_approval' || data.status === 'held');
      if (outputShape && data && !held && !failedOf(data)) {
        const wrapped = data.result !== undefined;
        const value = shapeOutput(wrapped ? data.result : data, shape).value;
        shown = wrapped ? { ...data, result: value, output_shape: outputShape } : { result: value, output_shape: outputShape };
      }
      // BASH-FALLBACK: on the model-driven path (a per-turn credential is set) an oversized
      // result would be saved to a file by the Bash tool and the model would reach for jq on
      // it, which the guard denies. Keep it inline as the honest summary view instead. Never
      // for a held or failed call (the approval/error is shown whole), never for a human.
      let modelPath = false;
      try { modelPath = !!readTurnToken(process.env); } catch { modelPath = false; }
      if (modelPath && data && !held && !failedOf(data)) {
        const wrapped = shown && shown.result !== undefined;
        const capped = capInline(wrapped ? shown.result : shown);
        if (capped.capped) shown = wrapped ? { ...shown, result: capped.value } : capped.value;
      }
      // quox#1031 (same class as #999): a refused or failed call must exit non-zero, or a script reads
      // success on failure. A HELD (pending) call awaits a human, so it stays 0.
      const failed = failedOf(data);
      if (failed && !(data && data.pending)) process.exitCode = 1;

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(shown, null, 2));
        return;
      }
      const result = shown && (shown.result !== undefined ? shown.result : shown);
      if (typeof result === 'string') {
        console.log(result);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    });

  tool
    .command('install')
    .description('Install a tool from the catalog')
    .argument('<toolId>', 'catalog tool_id (the "Tool ID" column from `tool catalog`, not its row id)')
    .action(async (toolId) => {
      auth.requireAuth();
      // org_id is derived server-side from the JWT — no :orgId in the path.
      await client.post(resolveEndpoint('tools.install-to-scope').path, {
        service: resolveEndpoint('tools.install-to-scope').service,
        body: { tool_id: toolId },
      });
      printSuccess('Tool installed.');
    });
}

/**
 * POST /api/v1/tools/execute for one governed tool, with the full identity
 * contract `tool exec` established (per-turn QUOX_AUTH_TOKEN, org resolution,
 * hat session/user/agent forwarding). Shared so a named verb that wraps a tool
 * (e.g. `quox actions list`, #839) authenticates exactly like `tool exec`.
 * Returns the raw response body.
 */
// quox#1034: the HTTP budget for one governed tool call. 120 s for a person at a terminal. A caller that spawns
// the CLI with a longer budget of its own (the collector's CLI-tools chat path, where delegate_to_agent waits up to
// the specialist's delegation.wait_ms, Browser-Q 180 s) states it in QUOX_TOOL_EXEC_TIMEOUT_MS, so the client hop
// never gives up before the server's own deadline and detach do. Capped at 15 minutes.
export function toolExecTimeoutMs(env = process.env) {
  const n = Number(env && env.QUOX_TOOL_EXEC_TIMEOUT_MS);
  if (!Number.isFinite(n) || n < 1000) return 120000;
  return Math.min(Math.floor(n), 900000);
}

export async function executeGovernedTool({ client, auth, program }, name, input, { reason, outputShape } = {}) {
  // QUOXON-IDENTITY: QUOX_AUTH_TOKEN is the collector's per-turn scoped
  // credential for the model-driven CLI-tools path. When set it is the ONLY
  // credential: sent as the bearer, never the service key, no stored-session
  // or refresh fallback, and org/user come from the token (not the body).
  const turnToken = readTurnToken(process.env);
  if (!turnToken) auth.requireAuth();
  const body = { tool_name: name, input };
  if (reason) body.reason = String(reason);
  // #970: the collector records the view the caller was shown in the tool receipt.
  if (outputShape) body.output_shape = outputShape;
  { const w = missingReasonWarning(name, reason); if (w) console.error(w); }

  // Same org-resolution precedence as `fleet exec` (lib/commands/fleet.js):
  // the collector's /api/v1/tools/execute requires org_id in the body for
  // service-key authenticated callers (isServiceKeyAuth = !req.user,
  // services/collector/server.js ~8326) since there is no session to
  // derive org from. A human-logged-in caller has req.user and the
  // server derives org from the session instead — --org / QUOX_ORG_ID
  // still wins when set explicitly.
  const orgId = turnToken ? null : auth.getOrgId(program.opts().org || process.env.QUOX_ORG_ID);
  if (!orgId && !turnToken && process.env.QUOX_SERVICE_KEY) {
    throw new Error(
      'QUOX_SERVICE_KEY is set but no org could be resolved. '
      + 'Set QUOX_ORG_ID=<org> for automation callers, or pass --org <id>.'
    );
  }
  if (orgId) body.org_id = orgId;

  // QUOXHAT T0 (2026-10-01): automation callers (the collector's
  // CLI-tools chat path) carry the conversation + acting user in env,
  // exactly like QUOX_ORG_ID above. The collector's execute route keys
  // hat-binding resolution on body.session_id and user prefs on
  // body.user_id; without them every CLI-tools execution ran against the
  // org default hat and user-less. Interactive humans have neither set.
  if (process.env.QUOX_SESSION_ID) body.session_id = process.env.QUOX_SESSION_ID;
  if (process.env.QUOX_USER_ID && !turnToken) body.user_id = process.env.QUOX_USER_ID;
  // QUOXHAT #657 P-C.2: forward the ACTING AGENT so a specialist's CLI-tools
  // chat turn executes as that specialist, not the orchestrator. Without it
  // the spawned CLI is a service caller with no agent_id, which the
  // collector defaults to 'quox' — so under enforce a restricted specialist
  // would silently run tools against the orchestrator's broad grant (the
  // "CLI exec silently becomes quox" bypass). The collector sets this from
  // its own selected_agent; a service-key caller's known agent_id is
  // trusted, and the P-B gate then authorizes against the specialist's own
  // grant ceiling ∩ the hat mode.
  if (process.env.QUOX_AGENT_ID) body.agent_id = process.env.QUOX_AGENT_ID;

  const ep = resolveEndpoint('v1.tools.execute');
  // noAuth: client.js adds no service key / stored session / refresh retry.
  const data = await client.post(ep.path, {
    service: ep.service,
    body,
    timeout: toolExecTimeoutMs(process.env),
    ...(turnToken ? { noAuth: true, noActAs: true, headers: { Authorization: `Bearer ${turnToken}` } } : {}),
  });
  return data;
}
