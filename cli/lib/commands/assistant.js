/**
 * Assistant commands: CRUD, deploy, fork
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxError } from '../core/errors.js';

// #1049: auth routes/assistants.js DEPLOYMENT_MODES (the server is the authority).
const DEPLOY_MODES = ['private', 'shared', 'public'];

export function registerAssistantCommands(program, ctx) {
  const { client, auth } = ctx;

  const assistant = program
    .command('assistant')
    .description('Manage assistants');

  assistant
    .command('list')
    .description('List assistants')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('assistants.list', { orgId }).path, { service: resolveEndpoint('assistants.list', { orgId }).service });
      formatOutput({
        // fleet #392: route returns active_deployments, not deployed.
        columns: ['id', 'name', 'status', 'active_deployments', 'created_at'],
        headers: ['ID', 'Name', 'Status', 'Deployed', 'Created'],
        rows: data.items || data.assistants || data,
      }, { format: program.opts().output });
    });

  assistant
    .command('get')
    .description('Get assistant details')
    .argument('<assistantId>', 'assistant ID')
    .action(async (assistantId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('assistants.get', { orgId, assistantId }).path, { service: resolveEndpoint('assistants.get', { orgId, assistantId }).service });
      formatDetail(data.assistant || data, { format: program.opts().output, title: data.assistant?.name || data.name });
    });

  assistant
    .command('create')
    .description('Create an assistant')
    .requiredOption('--name <name>', 'assistant name')
    .option('--persona <text>', 'persona/system prompt')
    .option('--description <desc>', 'description')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { name: options.name };
      if (options.persona) body.persona = options.persona;
      if (options.description) body.description = options.description;
      await client.post(resolveEndpoint('assistants.create', { orgId }).path, { service: resolveEndpoint('assistants.create', { orgId }).service, body });
      printSuccess(`Assistant "${options.name}" created.`);
    });

  assistant
    .command('update')
    .description('Update an assistant')
    .argument('<assistantId>', 'assistant ID')
    .option('--name <name>', 'new name')
    .option('--persona <text>', 'new persona')
    .option('--description <desc>', 'new description')
    .action(async (assistantId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      if (options.persona) body.persona = options.persona;
      if (options.description) body.description = options.description;
      await client.patch(resolveEndpoint('assistants.update', { orgId, assistantId }).path, { service: resolveEndpoint('assistants.update', { orgId, assistantId }).service, body });
      printSuccess('Assistant updated.');
    });

  assistant
    .command('delete')
    .description('Delete an assistant')
    .argument('<assistantId>', 'assistant ID')
    .action(async (assistantId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('assistants.delete', { orgId, assistantId }).path, { service: resolveEndpoint('assistants.delete', { orgId, assistantId }).service });
      printSuccess('Assistant deleted.');
    });

  assistant
    .command('publish')
    .description('Publish a draft assistant (draft to active), so it can be deployed')
    .argument('<assistantId>', 'assistant ID')
    .action(async (assistantId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // #1028: create makes a draft and deploy refuses anything not active; this is the step between.
      const ep = resolveEndpoint('assistants.publish', { orgId, assistantId });
      await client.post(ep.path, { service: ep.service });
      printSuccess('Assistant published.');
    });

  assistant
    .command('deploy')
    .description('Deploy an active assistant to a scope (scope ids: quox org divisions list, quox department list, quox team list)')
    .argument('<assistantId>', 'assistant ID')
    .option('--scope <scopeId>', 'scope ID to deploy to (required)')
    .option('--target <scopeId>', 'alias for --scope')
    .option('--mode <mode>', `${DEPLOY_MODES.join(', ')} (default shared)`)
    .action(async (assistantId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // #998: the auth route requires scope_id; the CLI used to send { target }.
      const scopeId = options.scope || options.target;
      if (!scopeId) throw new QuoxError('assistant deploy needs --scope <scopeId>.', 1);
      // #1049: the server's modes (auth routes/assistants.js DEPLOYMENT_MODES); refuse anything else here.
      if (options.mode && !DEPLOY_MODES.includes(options.mode)) {
        throw new QuoxError(`--mode must be one of: ${DEPLOY_MODES.join(', ')} (got "${options.mode}").`, 1);
      }
      const body = { scope_id: scopeId };
      if (options.mode) body.mode = options.mode;
      await client.post(resolveEndpoint('assistants.deploy', { orgId, assistantId }).path, { service: resolveEndpoint('assistants.deploy', { orgId, assistantId }).service, body });
      printSuccess('Assistant deployed.');
    });

  assistant
    .command('undeploy')
    .description('Remove a deployment of an assistant (by --deployment id, or the active one at --scope)')
    .argument('<assistantId>', 'assistant ID')
    .option('--deployment <deploymentId>', 'deployment ID to remove (see quox assistant get)')
    .option('--scope <scopeId>', 'remove the active deployment at this scope')
    .action(async (assistantId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // #1049: a deployed assistant could not be removed from the CLI.
      let deploymentId = options.deployment;
      if (!deploymentId) {
        if (!options.scope) throw new QuoxError('assistant undeploy needs --deployment <id> or --scope <scopeId>.', 1);
        const g = resolveEndpoint('assistants.get', { orgId, assistantId });
        const data = await client.get(g.path, { service: g.service });
        const deps = (data && data.assistant && data.assistant.deployments) || (data && data.deployments) || [];
        const live = deps.filter((d) => d.status === 'active');
        const hit = live.find((d) => d.scope_id === options.scope);
        if (!hit) {
          const where = live.length ? live.map((d) => `${d.scope_id} (${d.id})`).join(', ') : 'nowhere';
          throw new QuoxError(`No active deployment of ${assistantId} at scope ${options.scope}. It is deployed at: ${where}.`, 1);
        }
        deploymentId = hit.id;
      }
      const ep = resolveEndpoint('assistants.undeploy', { orgId, assistantId, deploymentId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess(`Deployment ${deploymentId} removed.`);
    });

  assistant
    .command('fork')
    .description('Fork an assistant')
    .argument('<assistantId>', 'assistant ID to fork')
    .option('--name <name>', 'name for the fork')
    .action(async (assistantId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      await client.post(resolveEndpoint('assistants.fork', { orgId, assistantId }).path, { service: resolveEndpoint('assistants.fork', { orgId, assistantId }).service, body });
      printSuccess('Assistant forked.');
    });
}
