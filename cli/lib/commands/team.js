/**
 * Team commands: CRUD + members
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerTeamCommands(program, ctx) {
  const { client, auth } = ctx;

  const team = program
    .command('team')
    .description('Manage teams');

  team
    .command('list')
    .description('List teams')
    .option('--division <divId>', 'filter by division')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = {};
      if (options.division) query.division_id = options.division;
      // fleet #392: division_name and member_count only exist when
      // includeStats=true, which was never sent — both columns were dashes.
      query.includeStats = 'true';
      const data = await client.get(resolveEndpoint('teams.list', { orgId }).path, { service: resolveEndpoint('teams.list', { orgId }).service, query });
      formatOutput({
        columns: ['id', 'name', 'division_name', 'member_count', 'created_at'],
        headers: ['ID', 'Name', 'Division', 'Members', 'Created'],
        rows: data.teams || data,
      }, { format: program.opts().output });
    });

  team
    .command('get')
    .description('Get team details')
    .argument('<teamId>', 'team ID')
    .action(async (teamId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('teams.get', { orgId, teamId }).path, { service: resolveEndpoint('teams.get', { orgId, teamId }).service });
      formatDetail(data.team || data, { format: program.opts().output, title: data.team?.name || data.name });
    });

  team
    .command('create')
    .description('Create a team')
    .requiredOption('--name <name>', 'team name')
    .option('--division <divId>', 'division ID')
    .option('--department <deptId>', 'department ID')
    .option('--description <desc>', 'description')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.post(resolveEndpoint('teams.create', { orgId }).path, {
        service: resolveEndpoint('teams.create', { orgId }).service,
        body: {
          name: options.name,
          division_id: options.division,
          department_id: options.department,
          description: options.description,
        },
      });
      printSuccess(`Team "${options.name}" created.`);
    });

  team
    .command('update')
    .description('Update a team')
    .argument('<teamId>', 'team ID')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .action(async (teamId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      await client.patch(resolveEndpoint('teams.update', { orgId, teamId }).path, { service: resolveEndpoint('teams.update', { orgId, teamId }).service, body });
      printSuccess('Team updated.');
    });

  team
    .command('delete')
    .description('Delete a team')
    .argument('<teamId>', 'team ID')
    .action(async (teamId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('teams.delete', { orgId, teamId }).path, { service: resolveEndpoint('teams.delete', { orgId, teamId }).service });
      printSuccess('Team deleted.');
    });

  team
    .command('provision-room')
    .description('Provision (or adopt) the governed Matrix room for a team')
    .argument('<teamId>', 'team ID')
    .action(async (teamId) => {
      auth.requireAuth();
      const data = await client.post(resolveEndpoint('teams.provisionRoom', { teamId }).path, { service: resolveEndpoint('teams.provisionRoom', { teamId }).service });
      printSuccess('Team Matrix room provisioned.');
      const room = data.room || data;
      formatDetail(room, { format: program.opts().output, title: 'Matrix Room' });
    });

  // Team members
  const members = team
    .command('members')
    .description('Manage team members');

  members
    .command('add')
    .description('Add a member to a team')
    .argument('<teamId>', 'team ID')
    .requiredOption('--user <userId>', 'user ID')
    .option('--role <role>', 'team role', 'member')
    .action(async (teamId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.post(resolveEndpoint('teams.members.create', { orgId, teamId }).path, {
        service: resolveEndpoint('teams.members.create', { orgId, teamId }).service,
        body: { user_id: options.user, role: options.role },
      });
      printSuccess('Member added to team.');
    });

  members
    .command('remove')
    .description('Remove a member from a team')
    .argument('<teamId>', 'team ID')
    .requiredOption('--user <userId>', 'user ID')
    .action(async (teamId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('teams.members.delete', { orgId, teamId, user: options.user }).path, { service: resolveEndpoint('teams.members.delete', { orgId, teamId, user: options.user }).service });
      printSuccess('Member removed from team.');
    });
}
