/**
 * Role commands: org custom roles (RBAC) + agent/tool permission rules
 *
 * quox role list|get|create|delete
 * quox role capability add|remove
 * quox role agent list|set|clear
 * quox role tool list|set|clear
 *
 * Backend: services/auth/routes/customRoles.js, mounted at plain `/api`
 * (org-scoped IN the URL: /api/orgs/:orgId/custom-roles...). Enterprise-tier
 * + ORG_MANAGE_ROLES gated — expect 402/403 on non-enterprise orgs.
 *
 * Capability grants are subject to a server-side privilege-escalation
 * guard: for capabilities in the known Capabilities enum, the caller must
 * already hold the capability themselves or the grant is rejected with
 * `forbidden_escalation` (customRoles.js:166-188). Free-form custom
 * capability strings bypass this check (org-defined extensions).
 */

import { formatOutput, formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerRoleCommands(program, ctx) {
  const { client, auth } = ctx;

  const role = program
    .command('role')
    .description('Manage org custom roles (enterprise — RBAC)');

  // ── role list ────────────────────────────────────────────────────────────────

  role
    .command('list')
    .description('List custom roles for the active org')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('custom-roles.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.roles || data || [];

      formatOutput({
        columns: ['id', 'slug', 'name', 'description', 'created_at'],
        headers: ['ID', 'Slug', 'Name', 'Description', 'Created'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No custom roles configured.' });
    });

  // ── role get ─────────────────────────────────────────────────────────────────

  role
    .command('get')
    .description('Show a custom role and its granted capabilities')
    .argument('<roleId>', 'role ID')
    .action(async (roleId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('custom-roles.get', { orgId, roleId });
      const data = await client.get(ep.path, { service: ep.service });

      formatDetail(data.role || {}, {
        format: program.opts().output,
        title: `Role: ${data.role?.name || roleId}`,
        fields: ['id', 'slug', 'name', 'description', 'created_at'],
      });
      const capabilities = data.capabilities || [];
      if (program.opts().output !== 'json') {
        formatOutput({
          columns: ['capability', 'scope_id'],
          headers: ['Capability', 'Scope'],
          rows: capabilities,
        }, { format: program.opts().output, emptyMessage: 'No capabilities granted.' });
      }
    });

  // ── role create ──────────────────────────────────────────────────────────────

  role
    .command('create')
    .description('Create a custom role')
    .requiredOption('--slug <slug>', 'unique role slug')
    .requiredOption('--name <name>', 'role name')
    .option('--description <text>', 'role description')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { slug: options.slug, name: options.name };
      if (options.description) body.description = options.description;

      const ep = resolveEndpoint('custom-roles.create', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Role "${options.name}" created.`);
      formatDetail(data.role || data, { format: program.opts().output });
    });

  // ── role delete ──────────────────────────────────────────────────────────────

  role
    .command('delete')
    .description('Delete a custom role')
    .argument('<roleId>', 'role ID')
    .option('--force', 'skip confirmation')
    .action(async (roleId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Delete role ${roleId}? Members assigned this role lose its capabilities immediately.`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Cancelled.');
          return;
        }
      }

      const ep = resolveEndpoint('custom-roles.delete', { orgId, roleId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('Role deleted.');
    });

  // ── role capability ─────────────────────────────────────────────────────────

  const capability = role
    .command('capability')
    .description('Manage capability grants on a role');

  capability
    .command('add')
    .description('Grant a capability to a role')
    .argument('<roleId>', 'role ID')
    .argument('<capability>', 'capability string (e.g. "agents.manage")')
    .option('--scope-id <scopeId>', 'restrict the grant to a specific scope')
    .action(async (roleId, cap, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { capability: cap };
      if (options.scopeId) body.scope_id = options.scopeId;

      const ep = resolveEndpoint('custom-roles.capabilities.add', { orgId, roleId });
      await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Capability "${cap}" granted.`);
    });

  capability
    .command('remove')
    .description('Revoke a capability from a role')
    .argument('<roleId>', 'role ID')
    .argument('<capability>', 'capability string')
    .option('--scope-id <scopeId>', 'scope ID (must match the grant\'s scope)')
    .action(async (roleId, cap, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { capability: cap };
      if (options.scopeId) query.scope_id = options.scopeId;

      const ep = resolveEndpoint('custom-roles.capabilities.remove', { orgId, roleId });
      await client.delete(ep.path, { service: ep.service, query });
      printSuccess(`Capability "${cap}" revoked.`);
    });

  // ── role agent ───────────────────────────────────────────────────────────────

  const agent = role
    .command('agent')
    .description('Manage agent access rules on a role');

  agent
    .command('list')
    .description('List agent access rules for a role')
    .argument('<roleId>', 'role ID')
    .action(async (roleId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('custom-roles.agents.list', { orgId, roleId });
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.permissions || data || [];

      formatOutput({
        columns: ['agent_id', 'scope_id', 'allowed'],
        headers: ['Agent ID', 'Scope', 'Allowed'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No agent access rules set for this role.' });
    });

  agent
    .command('set')
    .description('Set (allow or deny) a role\'s access to an agent')
    .argument('<roleId>', 'role ID')
    .argument('<agentId>', 'agent ID')
    .requiredOption('--allowed <bool>', 'true|false')
    .option('--scope-id <scopeId>', 'restrict the rule to a specific scope')
    .action(async (roleId, agentId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      if (options.allowed !== 'true' && options.allowed !== 'false') {
        throw new Error('--allowed must be "true" or "false".');
      }
      const body = { agent_id: agentId, allowed: options.allowed === 'true' };
      if (options.scopeId) body.scope_id = options.scopeId;

      const ep = resolveEndpoint('custom-roles.agents.set', { orgId, roleId });
      await client.put(ep.path, { service: ep.service, body });
      printSuccess(`Agent access rule set (${body.allowed ? 'allowed' : 'denied'}).`);
    });

  agent
    .command('clear')
    .description('Remove an agent access rule from a role')
    .argument('<roleId>', 'role ID')
    .argument('<agentId>', 'agent ID')
    .option('--scope-id <scopeId>', 'scope ID (must match the rule\'s scope)')
    .action(async (roleId, agentId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { agent_id: agentId };
      if (options.scopeId) query.scope_id = options.scopeId;

      const ep = resolveEndpoint('custom-roles.agents.clear', { orgId, roleId });
      await client.delete(ep.path, { service: ep.service, query });
      printSuccess('Agent access rule cleared.');
    });

  // ── role tool ────────────────────────────────────────────────────────────────

  const tool = role
    .command('tool')
    .description('Manage tool access rules on a role');

  tool
    .command('list')
    .description('List tool access rules for a role')
    .argument('<roleId>', 'role ID')
    .action(async (roleId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('custom-roles.tools.list', { orgId, roleId });
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.permissions || data || [];

      formatOutput({
        columns: ['tool_id', 'allowed'],
        headers: ['Tool ID', 'Allowed'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No tool access rules set for this role.' });
    });

  tool
    .command('set')
    .description('Set (allow or deny) a role\'s access to a tool')
    .argument('<roleId>', 'role ID')
    .argument('<toolId>', 'tool ID')
    .requiredOption('--allowed <bool>', 'true|false')
    .action(async (roleId, toolId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      if (options.allowed !== 'true' && options.allowed !== 'false') {
        throw new Error('--allowed must be "true" or "false".');
      }
      const body = { tool_id: toolId, allowed: options.allowed === 'true' };

      const ep = resolveEndpoint('custom-roles.tools.set', { orgId, roleId });
      await client.put(ep.path, { service: ep.service, body });
      printSuccess(`Tool access rule set (${body.allowed ? 'allowed' : 'denied'}).`);
    });

  tool
    .command('clear')
    .description('Remove a tool access rule from a role')
    .argument('<roleId>', 'role ID')
    .argument('<toolId>', 'tool ID')
    .action(async (roleId, toolId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { tool_id: toolId };

      const ep = resolveEndpoint('custom-roles.tools.clear', { orgId, roleId });
      await client.delete(ep.path, { service: ep.service, query });
      printSuccess('Tool access rule cleared.');
    });
}
