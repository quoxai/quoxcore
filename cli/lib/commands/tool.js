/**
 * Tool commands: CRUD, catalog, install, publish
 */

import { missingReasonWarning } from '../core/callerSource.js';
import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

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
        type: options.type,
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
    .description('Execute a governed tool via the collector (POST /api/v1/tools/execute)')
    .argument('<name>', 'tool name/id (the TOOL_DEFS key, e.g. "codebase_query")')
    .option('--args <json>', "tool arguments as a JSON string, e.g. '{\"query\":\"...\"}'", '{}')
    // #620: docs/muscle-memory reach for --input; accept it as an alias for
    // --args so the documented form works. --args still wins if both given.
    .option('--input <json>', 'alias for --args (tool arguments as a JSON string)')
    .option('--reason <text>', 'why you are running this; shown on the approval card if the call is held for a human')
    .action(async (name, options) => {
      // QUOXON-IDENTITY: QUOX_AUTH_TOKEN is the collector's per-turn scoped
      // credential for the model-driven CLI-tools path. When set it is the ONLY
      // credential: sent as the bearer, never the service key, no stored-session
      // or refresh fallback, and org/user come from the token (not the body).
      const turnToken = process.env.QUOX_AUTH_TOKEN || '';
      if (!turnToken) auth.requireAuth();
      // Prefer whichever was explicitly given; --args carries the '{}' default
      // so it is always defined, hence check --input first.
      const usedInput = options.input !== undefined && (options.args === undefined || options.args === '{}');
      const raw = usedInput ? options.input : options.args;
      const input = parseJSON(raw, usedInput ? '--input' : '--args');
      const body = { tool_name: name, input };
      if (options.reason) body.reason = String(options.reason);
      { const w = missingReasonWarning(name, options.reason); if (w) console.error(w); }

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
        timeout: 120000,
        ...(turnToken ? { noAuth: true, noActAs: true, headers: { Authorization: `Bearer ${turnToken}` } } : {}),
      });

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const result = data && (data.result !== undefined ? data.result : data);
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
