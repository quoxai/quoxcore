/**
 * Organization commands: CRUD, switch, members, divisions, audit
 */

import { QuoxError } from '../core/errors.js';
import { formatOutput, formatDetail, printSuccess, printWarning } from '../core/output.js';
import { otherProfileUsers, listProcs } from '../core/profileUsers.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerOrgCommands(program, ctx) {
  const { client, auth, config } = ctx;

  const org = program
    .command('org')
    .description('Manage organizations');

  org
    .command('list')
    .description('List organizations')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('orgs.list').path, { service: resolveEndpoint('orgs.list').service });
      formatOutput({
        columns: ['id', 'name', 'slug', 'plan', 'created_at'],
        headers: ['ID', 'Name', 'Slug', 'Plan', 'Created'],
        rows: data.orgs || data.organizations || data,
      }, { format: program.opts().output });
    });

  org
    .command('get')
    .description('Get organization details')
    .argument('<orgId>', 'organization ID')
    .action(async (orgId) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('orgs.get', { orgId }).path, { service: resolveEndpoint('orgs.get', { orgId }).service });
      const org = data.organization || data.org || data;
      formatDetail(org, {
        format: program.opts().output,
        title: org.name || data.name,
      });
    });

  org
    .command('create')
    .description('Create a new organization')
    .requiredOption('--name <name>', 'organization name')
    .option('--slug <slug>', 'URL-friendly slug')
    .option('--description <desc>', 'organization description')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.post(resolveEndpoint('orgs.create').path, {
        service: resolveEndpoint('orgs.create').service,
        body: {
          name: options.name,
          slug: options.slug,
          description: options.description,
        },
      });
      const created = data.organization || data.org;
      printSuccess(`Created organization: ${options.name}${created?.slug ? ` (${created.slug})` : ''}`);
    });

  org
    .command('update')
    .description('Update an organization')
    .argument('<orgId>', 'organization ID')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .action(async (orgId, options) => {
      auth.requireAuth();
      const body = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      await client.patch(resolveEndpoint('orgs.update', { orgId }).path, { service: resolveEndpoint('orgs.update', { orgId }).service, body });
      printSuccess(`Organization updated.`);
    });

  org
    .command('delete')
    .description('Delete an organization')
    .argument('<orgId>', 'organization ID')
    .action(async (orgId) => {
      auth.requireAuth();
      await client.delete(resolveEndpoint('orgs.delete', { orgId }).path, { service: resolveEndpoint('orgs.delete', { orgId }).service });
      printSuccess('Organization deleted.');
    });

  org
    .command('switch')
    .description('Switch active organization context')
    .argument('<orgId>', 'organization ID or slug')
    .action(async (orgId) => {
      auth.requireAuth();
      // The server matches memberships by org ID only. Accept a slug (or exact name) by
      // resolving it against the caller's org list first; a 26-char ULID passes through.
      let targetId = orgId;
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(orgId)) {
        const list = await client.get(resolveEndpoint('orgs.list').path, { service: resolveEndpoint('orgs.list').service });
        const orgs = Array.isArray(list) ? list : (list?.organizations || list?.orgs || list?.data || []);
        const hit = orgs.find((o) => o.slug === orgId) || orgs.find((o) => String(o.name || '').toLowerCase() === orgId.toLowerCase());
        if (!hit) throw new QuoxError(`No organisation with slug or name '${orgId}'. Run \`quox org list\` and pass its ID.`, 1);
        targetId = hit.id;
      }
      // Call switch-org endpoint
      const data = await client.post(resolveEndpoint('auth.switch-org').path, {
        service: resolveEndpoint('auth.switch-org').service,
        body: { org_id: targetId },
      });

      // Update stored auth
      const authData = config.getAuth();
      if (data.org) {
        authData.org_id = data.org.id;
        authData.org_name = data.org.name;
        authData.org_slug = data.org.slug;
        authData.org_role = data.role;
      }
      if (data.access_token) authData.access_token = data.access_token;
      config.setAuth(authData);

      printSuccess(`Switched to ${data.org?.name || orgId}`);
      // #1034: this changed the SHARED profile. Name the other live sessions that will follow it.
      try {
        const name = config.getActiveProfileName?.();
        const others = name ? otherProfileUsers({ profile: name, defaultProfile: config._data?.activeProfile, procs: listProcs(), selfPids: [process.pid, process.ppid] }) : [];
        if (others.length) {
          printWarning(`${others.length} other quox session${others.length === 1 ? '' : 's'} use profile "${name}" (pid ${others.map(p => p.pid).join(', ')}). `
            + 'They follow this org on their next token refresh or restart. To move one window only, use /org switch inside it.');
        }
      } catch { /* best effort: never fail the switch over the warning */ }
    });

  // Members subcommands
  const members = org
    .command('members')
    .description('Manage organization members');

  members
    .command('list')
    .description('List organization members')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('members.list', { orgId }).path, { service: resolveEndpoint('members.list', { orgId }).service });
      formatOutput({
        // fleet #392: member rows key on id, not user_id.
        columns: ['id', 'email', 'display_name', 'role', 'status', 'joined_at'],
        headers: ['User ID', 'Email', 'Name', 'Role', 'Status', 'Joined'],
        rows: data.members || data,
      }, { format: program.opts().output });
    });

  members
    .command('add')
    .description('Invite a member to the organization')
    .requiredOption('--email <email>', 'email to invite')
    .option('--role <role>', 'role: owner, admin, builder, viewer', 'viewer')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.post(resolveEndpoint('members.create', { orgId }).path, {
        service: resolveEndpoint('members.create', { orgId }).service,
        body: { email: options.email, role: options.role },
      });
      printSuccess(`Invited ${options.email} as ${options.role}.`);
    });

  members
    .command('update')
    .description('Update a member role')
    .argument('<userId>', 'user ID')
    .requiredOption('--role <role>', 'new role')
    .action(async (userId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.patch(resolveEndpoint('members.update', { orgId, userId }).path, {
        service: resolveEndpoint('members.update', { orgId, userId }).service,
        body: { role: options.role },
      });
      printSuccess(`Member role updated to ${options.role}.`);
    });

  members
    .command('remove')
    .description('Remove a member from the organization')
    .argument('<userId>', 'user ID')
    .action(async (userId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('members.delete', { orgId, userId }).path, { service: resolveEndpoint('members.delete', { orgId, userId }).service });
      printSuccess('Member removed.');
    });

  // Divisions subcommands
  const divisions = org
    .command('divisions')
    .description('Manage divisions within the organization');

  divisions
    .command('list')
    .description('List divisions')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('divisions.list', { orgId }).path, { service: resolveEndpoint('divisions.list', { orgId }).service });
      formatOutput({
        columns: ['id', 'name', 'description', 'created_at'],
        headers: ['ID', 'Name', 'Description', 'Created'],
        rows: data.divisions || data,
      }, { format: program.opts().output });
    });

  divisions
    .command('create')
    .description('Create a division')
    .requiredOption('--name <name>', 'division name')
    .option('--description <desc>', 'description')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.post(resolveEndpoint('divisions.create', { orgId }).path, {
        service: resolveEndpoint('divisions.create', { orgId }).service,
        body: { name: options.name, description: options.description },
      });
      printSuccess(`Division "${options.name}" created.`);
    });

  divisions
    .command('update')
    .description('Update a division')
    .argument('<divId>', 'division ID')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .action(async (divId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      await client.patch(resolveEndpoint('divisions.update', { orgId, divId }).path, { service: resolveEndpoint('divisions.update', { orgId, divId }).service, body });
      printSuccess('Division updated.');
    });

  divisions
    .command('delete')
    .description('Delete a division')
    .argument('<divId>', 'division ID')
    .action(async (divId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('divisions.delete', { orgId, divId }).path, { service: resolveEndpoint('divisions.delete', { orgId, divId }).service });
      printSuccess('Division deleted.');
    });

  // Audit subcommand
  org
    .command('audit')
    .description('View organization audit log')
    .option('--action <action>', 'filter by action type')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { limit: options.limit };
      if (options.action) query.action = options.action;
      const data = await client.get(resolveEndpoint('audit.list', { orgId }).path, { service: resolveEndpoint('audit.list', { orgId }).service, query });
      formatOutput({
        // fleet #392: audit_events uses created_at/actor_email/metadata.
        columns: ['created_at', 'actor_email', 'action', 'metadata'],
        headers: ['Time', 'User', 'Action', 'Detail'],
        rows: data.events || data.entries || data,
      }, { format: program.opts().output });
    });
}
