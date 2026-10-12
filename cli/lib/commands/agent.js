/**
 * Agent commands: CRUD, activate/deactivate, tool assignments
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { registerAgentAttachCommands } from './agentAttach.js';

export function registerAgentCommands(program, ctx) {
  const { client, auth } = ctx;

  const agent = program
    .command('agent')
    .description('Manage agents');

  agent
    .command('list')
    .description('List agents')
    .option('--status <status>', 'filter by status')
    .option('--level <level>', 'filter by level (0-4)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = {};
      if (options.status) query.status = options.status;
      if (options.level) query.level = options.level;
      // fleet #392: tool_count is only computed when includeTools=true, which
      // was never sent; and rows carry a `domains` ARRAY, not a `domain`.
      query.includeTools = 'true';
      const data = await client.get(resolveEndpoint('agents.list', { orgId }).path, { service: resolveEndpoint('agents.list', { orgId }).service, query });
      formatOutput({
        columns: ['id', 'agent_id', 'name', 'level', 'status', 'domains', 'tool_count'],
        headers: ['ID', 'Agent ID', 'Name', 'Level', 'Status', 'Domains', 'Tools'],
        rows: (data.agents || data || []).map(a => ({
          ...a,
          domains: Array.isArray(a.domains) ? a.domains.join(', ') : (a.domains ?? '-'),
        })),
      }, { format: program.opts().output });
    });

  agent
    .command('get')
    .description('Get agent details')
    .argument('<agentId>', 'agent ID')
    .action(async (agentId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('agents.get', { orgId, agentId }).path, { service: resolveEndpoint('agents.get', { orgId, agentId }).service });
      formatDetail(data.agent || data, {
        format: program.opts().output,
        title: data.agent?.name || data.name,
      });
    });

  agent
    .command('create')
    .description('Create a new agent')
    .requiredOption('--name <name>', 'agent display name')
    .option('--agent-id <id>', 'machine identifier')
    .option('--level <level>', 'agent level (0-4)', '2')
    .option('--domain <domain>', 'agent domain')
    .option('--description <desc>', 'description')
    .option('--parent <parentId>', 'parent agent ID')
    .option('--manifest-id <id>', 'manifest ID')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {
        name: options.name,
        level: parseInt(options.level, 10),
      };
      if (options.agentId) body.agent_id = options.agentId;
      if (options.domain) body.domain = options.domain;
      if (options.description) body.description = options.description;
      if (options.parent) body.parent_id = options.parent;
      if (options.manifestId) body.manifest_id = options.manifestId;
      await client.post(resolveEndpoint('agents.create', { orgId }).path, { service: resolveEndpoint('agents.create', { orgId }).service, body });
      printSuccess(`Agent "${options.name}" created.`);
    });

  agent
    .command('update')
    .description('Update an agent')
    .argument('<agentId>', 'agent ID')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .option('--level <level>', 'new level')
    .option('--status <status>', 'new status')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      if (options.level) body.level = parseInt(options.level, 10);
      if (options.status) body.status = options.status;
      await client.patch(resolveEndpoint('agents.update', { orgId, agentId }).path, { service: resolveEndpoint('agents.update', { orgId, agentId }).service, body });
      printSuccess('Agent updated.');
    });

  agent
    .command('delete')
    .description('Delete an agent')
    .argument('<agentId>', 'agent ID')
    .action(async (agentId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('agents.delete', { orgId, agentId }).path, { service: resolveEndpoint('agents.delete', { orgId, agentId }).service });
      printSuccess('Agent deleted.');
    });

  agent
    .command('activate')
    .description('Activate an agent')
    .argument('<agentId>', 'agent ID')
    .action(async (agentId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.patch(resolveEndpoint('agents.update', { orgId, agentId }).path, {
        service: resolveEndpoint('agents.update', { orgId, agentId }).service,
        body: { status: 'active' },
      });
      printSuccess('Agent activated.');
    });

  agent
    .command('deactivate')
    .description('Deactivate an agent')
    .argument('<agentId>', 'agent ID')
    .action(async (agentId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.patch(resolveEndpoint('agents.update', { orgId, agentId }).path, {
        service: resolveEndpoint('agents.update', { orgId, agentId }).service,
        body: { status: 'inactive' },
      });
      printSuccess('Agent deactivated.');
    });

  // Agent tool management
  const agentTool = agent
    .command('tool')
    .description('Manage agent tool assignments');

  agentTool
    .command('list')
    .description('List tools assigned to an agent')
    .argument('<agentId>', 'agent ID')
    .action(async (agentId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('agents.tools.list', { orgId, agentId }).path, { service: resolveEndpoint('agents.tools.list', { orgId, agentId }).service });
      formatOutput({
        // fleet #392: assignment rows carry tool_name/category/enabled.
        columns: ['tool_id', 'tool_name', 'category', 'access_mode', 'enabled'],
        headers: ['Tool ID', 'Name', 'Type', 'Access', 'Status'],
        rows: data.assignments || data.tools || data,
      }, { format: program.opts().output });
    });

  agentTool
    .command('assign')
    .description('Assign a tool to an agent')
    .argument('<agentId>', 'agent ID')
    .requiredOption('--tool <toolId>', 'tool ID')
    .option('--access-mode <mode>', 'access mode', 'full')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.post(resolveEndpoint('agents.tools.create', { orgId, agentId }).path, {
        service: resolveEndpoint('agents.tools.create', { orgId, agentId }).service,
        body: { tool_id: options.tool, access_mode: options.accessMode },
      });
      printSuccess(`Tool assigned to agent.`);
    });

  agentTool
    .command('revoke')
    .description('Revoke a tool from an agent')
    .argument('<agentId>', 'agent ID')
    .requiredOption('--tool <toolId>', 'tool ID')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // The DELETE route is keyed by assignment id, not tool id — resolve
      // the assignment whose tool matches the given --tool value first.
      const data = await client.get(resolveEndpoint('agents.tools.list', { orgId, agentId }).path, { service: resolveEndpoint('agents.tools.list', { orgId, agentId }).service });
      const assignments = data.assignments || data.tools || data || [];
      const assignment = assignments.find(a => a.tool_id === options.tool || a.id === options.tool);
      if (!assignment) {
        throw new Error(`Tool "${options.tool}" is not assigned to agent ${agentId}.`);
      }
      await client.delete(resolveEndpoint('agents.tools.delete', { orgId, agentId, id: assignment.id }).path, { service: resolveEndpoint('agents.tools.delete', { orgId, agentId, id: assignment.id }).service });
      printSuccess('Tool revoked from agent.');
    });

  // QuoxIdentity P1 (docs/QUOXIDENTITY_P1_CONTRACT.md): attach/detach/
  // attach-status/attach-heartbeat, registered onto this same `agent` group.
  registerAgentAttachCommands(agent, ctx, program);
}
