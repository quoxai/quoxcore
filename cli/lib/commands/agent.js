/**
 * Agent commands: CRUD, activate/deactivate, tool assignments
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { loadBundledAssistantsRoster } from '../core/agentAlias.js';
import { registerAgentAttachCommands } from './agentAttach.js';

export function registerAgentCommands(program, ctx) {
  const { client, auth } = ctx;

  const agent = program
    .command('agent')
    .description('Manage agents');

  agent
    .command('list')
    .description('List registered specialist agents and the org\'s own agents')
    .option('--status <status>', 'filter by status (org agents only)')
    .option('--level <level>', 'filter by level (0-4)')
    .option('--source <source>', 'registry | org | all', 'all')
    .option('--plugin <id>', 'only agents that require this plugin')
    .option('--search <text>', 'substring match on id, name or description')
    .action(async (options) => {
      auth.requireAuth();
      const source = String(options.source || 'all').toLowerCase();
      if (!['registry', 'org', 'all'].includes(source)) {
        throw new Error(`--source must be registry, org or all (got "${options.source}")`);
      }
      const notes = [];

      // Registered specialists (server roster; bundled roster if the server lacks the route).
      let registry = [];
      if (source !== 'org') {
        try {
          const ep = resolveEndpoint('v1.agents.registry');
          const data = await client.get(ep.path, { service: ep.service });
          if (!Array.isArray(data?.agents)) throw new Error('unexpected response');
          registry = data.agents.map(r => ({ ...r, source: 'registry' }));
        } catch (err) {
          notes.push(`note: server registry unavailable (${err.message}); showing the bundled roster, which may be out of date.`);
          registry = loadBundledAssistantsRoster().map(r => ({
            agent_id: r.id, name: r.name || r.id, level: null, requires_plugin: null, tool_count: null, source: 'registry',
          }));
        }
      }

      // The org's own agent rows.
      let orgRows = [];
      if (source !== 'registry') {
        try {
          const orgId = resolveOrgId(auth, program);
          const query = { includeTools: 'true' };
          if (options.status) query.status = options.status;
          if (options.level) query.level = options.level;
          const ep = resolveEndpoint('agents.list', { orgId });
          const data = await client.get(ep.path, { service: ep.service, query });
          orgRows = (data.agents || data || []).map(r => ({ ...r, source: 'org' }));
        } catch (err) {
          if (source === 'org') throw err;
          notes.push(`note: org agents unavailable (${err.message}); showing registered specialists only.`);
        }
      }

      // Merge by agent_id: org row wins for status, registry supplies plugin/description.
      const merged = new Map();
      for (const r of registry) merged.set(r.agent_id, r);
      for (const o of orgRows) {
        const key = o.agent_id || o.id;
        const reg = merged.get(key);
        merged.set(key, reg
          ? { ...reg, ...o, requires_plugin: reg.requires_plugin, description: reg.description ?? o.description, tool_count: o.tool_count ?? reg.tool_count, source: 'org+registry' }
          : o);
      }

      let all = [...merged.values()];
      if (options.level !== undefined) all = all.filter(r => String(r.level) === String(options.level));
      if (options.status) all = all.filter(r => r.status === options.status);
      if (options.plugin) all = all.filter(r => r.requires_plugin === options.plugin);
      if (options.search) {
        const q = options.search.toLowerCase();
        all = all.filter(r => [r.agent_id, r.name, r.description].some(v => String(v ?? '').toLowerCase().includes(q)));
      }
      all.sort((x, y) => String(x.agent_id).localeCompare(String(y.agent_id)));

      for (const n of notes) console.error(n);
      const dash = (v) => (v === null || v === undefined || v === '' ? '-' : v);
      formatOutput({
        columns: ['agent_id', 'name', 'source', 'level', 'state', 'tool_count'],
        headers: ['Agent ID', 'Name', 'Source', 'Level', 'Status/Plugin', 'Tools'],
        rows: all.map(r => ({
          ...r,
          level: dash(r.level),
          state: r.status ? r.status : (r.requires_plugin ? `plugin:${r.requires_plugin}` : '-'),
          tool_count: dash(r.tool_count),
        })),
      }, { format: program.opts().output, raw: all, emptyMessage: 'No agents match.' });
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
