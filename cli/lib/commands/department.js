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
    .description('List departments (all divisions unless --division; division ids: quox org divisions list)')
    .option('--division <divId>', 'only this division')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const listFor = async (division) => {
        const ep = resolveEndpoint('divisions.departments.list', { orgId, division });
        const data = await client.get(ep.path, { service: ep.service });
        return data.departments || data || [];
      };
      if (options.division) {
        formatOutput({
          columns: ['id', 'name', 'description', 'created_at'],
          headers: ['ID', 'Name', 'Description', 'Created'],
          rows: await listFor(options.division),
        }, { format: program.opts().output });
        return;
      }
      // quox#922: no --division lists every division's departments, so the read
      // needs no id the department group cannot show.
      const divEp = resolveEndpoint('divisions.list', { orgId });
      const divData = await client.get(divEp.path, { service: divEp.service });
      const divisions = divData.divisions || divData || [];
      const rows = [];
      for (const d of divisions) {
        for (const dept of await listFor(d.id)) rows.push({ ...dept, division: d.name || d.id });
      }
      formatOutput({
        columns: ['id', 'name', 'division', 'description', 'created_at'],
        headers: ['ID', 'Name', 'Division', 'Description', 'Created'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No departments.' });
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
