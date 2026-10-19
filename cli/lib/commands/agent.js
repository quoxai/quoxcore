/**
 * Agent commands: CRUD, activate/deactivate, tool assignments
 */

import { readFileSync } from 'node:fs';
import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxApiError } from '../core/errors.js';
import { loadBundledAssistantsRoster } from '../core/agentAlias.js';
import { registerAgentAttachCommands } from './agentAttach.js';

// quox#1169: the prompt, domains and parent a user gives their own agent. Auth reads
// system_prompt_additions, domains[] and parent_agent_id; it has never read manifest_id.
function agentPromptFields(options) {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new Error('Give either --prompt or --prompt-file, not both. Nothing was sent.');
  }
  if (options.manifestId !== undefined) {
    throw new Error('--manifest-id is not supported by the server (it was always ignored). Nothing was sent.');
  }
  const out = {};
  if (options.prompt !== undefined) out.system_prompt_additions = String(options.prompt);
  if (options.promptFile !== undefined) {
    try {
      out.system_prompt_additions = readFileSync(options.promptFile, 'utf8');
    } catch (err) {
      throw new Error(`cannot read --prompt-file ${options.promptFile}: ${err.code || err.message}. Nothing was sent.`);
    }
  }
  if (options.domain !== undefined) out.domains = String(options.domain).split(',').map((d) => d.trim()).filter(Boolean);
  if (options.parent !== undefined) out.parent_agent_id = options.parent;
  return out;
}

export function registerAgentCommands(program, ctx) {
  const { client, auth } = ctx;

  // Registered specialists (no org row): resolved from the collector registry, quox#927.
  async function registryAgent(agentId) {
    try {
      const ep = resolveEndpoint('v1.agents.registry');
      const data = await client.get(ep.path, { service: ep.service });
      return (data?.agents || []).find((r) => r.agent_id === agentId) || null;
    } catch { return null; }
  }
  async function registryGrants(agentId) {
    try {
      const ep = resolveEndpoint('v1.tools.agents.list');
      const data = await client.get(ep.path, { service: ep.service });
      const list = data?.agentTools?.[agentId];
      return Array.isArray(list) ? list : null;
    } catch { return null; }
  }

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
      let data;
      try {
        data = await client.get(resolveEndpoint('agents.get', { orgId, agentId }).path, { service: resolveEndpoint('agents.get', { orgId, agentId }).service });
      } catch (err) {
        // quox#927: `agent list` also shows registered specialists that have no org row;
        // resolve those from the registry instead of answering 404 for an id list printed.
        const reg = err?.status === 404 ? await registryAgent(agentId) : null;
        if (!reg) throw err;
        data = { agent: { ...reg, source: 'registry' } };
      }
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
    .option('--manifest-id <id>', 'not supported: refused (the server never read it)')
    .option('--prompt <text>', "the agent's instructions (its system prompt)")
    .option('--prompt-file <path>', "read the agent's instructions from a file")
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const fields = agentPromptFields(options);
      const body = {
        name: options.name,
        level: parseInt(options.level, 10),
        ...fields,
      };
      if (options.agentId) body.agent_id = options.agentId;
      // legacy key kept so older servers and tests see it; auth reads domains[] (set above)
      if (options.domain) body.domain = options.domain;
      if (options.description) body.description = options.description;
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
    .option('--prompt <text>', "new instructions (system prompt)")
    .option('--prompt-file <path>', 'read new instructions from a file')
    .option('--domain <domains>', 'comma-separated domains')
    .option('--parent <parentId>', 'parent agent ID')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { ...agentPromptFields(options) };
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
        body: { status: 'paused' }, // #985: auth accepts draft|active|paused|retired; 'inactive' 400'd
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
      let data;
      try {
        data = await client.get(resolveEndpoint('agents.tools.list', { orgId, agentId }).path, { service: resolveEndpoint('agents.tools.list', { orgId, agentId }).service });
      } catch (err) {
        // quox#927: a registered specialist's tools are its registry grants, not org assignments.
        const grants = err?.status === 404 ? await registryGrants(agentId) : null;
        if (!grants) throw err;
        data = { tools: grants.map((name) => ({ tool_id: name, tool_name: name, category: '-', access_mode: 'registry grant', enabled: true })) };
      }
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
      try {
        await client.post(resolveEndpoint('agents.tools.create', { orgId, agentId }).path, {
          service: resolveEndpoint('agents.tools.create', { orgId, agentId }).service,
          body: { tool_id: options.tool, access_mode: options.accessMode },
        });
      } catch (err) {
        // quox#1072: a built-in agent's tools come from its registry grant and
        // hat. The server says so in prose; surface that sentence as the error
        // with a stable code, so it does not read as a generic conflict.
        if (err?.status === 409 && err.body?.code === 'BUILTIN_AGENT_TOOLS_FROM_GRANT') {
          throw new QuoxApiError(409, err.body.code, err.body.message || err.body.error, undefined, err.body);
        }
        throw err;
      }
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
