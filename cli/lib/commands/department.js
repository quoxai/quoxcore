/**
 * Department commands: CRUD
 */

import { formatOutput, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerDepartmentCommands(program, ctx) {
  const { client, auth } = ctx;

  const dept = program
    .command('department')
    .description('Manage departments within divisions');

  dept
    .command('list')
    .description('List departments')
    .requiredOption('--division <divId>', 'division ID')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('divisions.departments.list', { orgId, division: options.division }).path, { service: resolveEndpoint('divisions.departments.list', { orgId, division: options.division }).service });
      formatOutput({
        columns: ['id', 'name', 'description', 'created_at'],
        headers: ['ID', 'Name', 'Description', 'Created'],
        rows: data.departments || data,
      }, { format: program.opts().output });
    });

  dept
    .command('create')
    .description('Create a department')
    .requiredOption('--division <divId>', 'division ID')
    .requiredOption('--name <name>', 'department name')
    .option('--description <desc>', 'description')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.post(resolveEndpoint('divisions.departments.create', { orgId, division: options.division }).path, {
        service: resolveEndpoint('divisions.departments.create', { orgId, division: options.division }).service,
        body: { name: options.name, description: options.description },
      });
      printSuccess(`Department "${options.name}" created.`);
    });

  dept
    .command('update')
    .description('Update a department')
    .argument('<deptId>', 'department ID')
    .requiredOption('--division <divId>', 'division ID')
    .option('--name <name>', 'new name')
    .option('--description <desc>', 'new description')
    .action(async (deptId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      await client.patch(resolveEndpoint('divisions.departments.update', { orgId, division: options.division, deptId }).path, { service: resolveEndpoint('divisions.departments.update', { orgId, division: options.division, deptId }).service, body });
      printSuccess('Department updated.');
    });

  dept
    .command('delete')
    .description('Delete a department')
    .argument('<deptId>', 'department ID')
    .requiredOption('--division <divId>', 'division ID')
    .action(async (deptId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('divisions.departments.delete', { orgId, division: options.division, deptId }).path, { service: resolveEndpoint('divisions.departments.delete', { orgId, division: options.division, deptId }).service });
      printSuccess('Department deleted.');
    });
}
