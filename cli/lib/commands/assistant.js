/**
 * Assistant commands: CRUD, deploy, fork
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

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
    .command('deploy')
    .description('Deploy an assistant')
    .argument('<assistantId>', 'assistant ID')
    .option('--target <target>', 'deployment target')
    .action(async (assistantId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.target) body.target = options.target;
      await client.post(resolveEndpoint('assistants.deploy', { orgId, assistantId }).path, { service: resolveEndpoint('assistants.deploy', { orgId, assistantId }).service, body });
      printSuccess('Assistant deployed.');
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
