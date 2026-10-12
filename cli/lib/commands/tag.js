/**
 * Tag commands
 *
 * quox tag list|create|update|delete
 */

import { formatOutput, formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { confirmDestructive } from '../core/confirm.js';

export function registerTagCommands(program, ctx) {
  const { client, auth } = ctx;

  const tag = program
    .command('tag')
    .description('Manage tags');

  tag
    .command('list')
    .description('List tags')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // fleet #392: the route only computes usage when include_counts=true,
      // which was never sent — so Count was hardcoded 0 for every tag.
      const data = await client.get(resolveEndpoint('tags.list', { orgId }).path, { service: resolveEndpoint('tags.list', { orgId }).service, query: { include_counts: 'true' } });
      const tags = data.tags || data || [];
      formatOutput({
        columns: ['id', 'name', 'color', 'count'],
        headers: ['ID', 'Name', 'Color', 'Count'],
        rows: tags.map(t => ({ id: t.id, name: t.name, color: t.color || '-', count: t.total_usage ?? 0 })),
      }, { format: program.opts().output });
    });

  tag
    .command('create')
    .description('Create a tag')
    .requiredOption('--name <name>', 'Tag name')
    .option('--color <color>', 'Tag color (hex)')
    .action(async (opts) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { name: opts.name };
      if (opts.color) body.color = opts.color;
      // fleet #399: the id wasn't surfaced, so a script had to call
      // `tag list` to recover it after create.
      const data = await client.post(resolveEndpoint('tags.create', { orgId }).path, { service: resolveEndpoint('tags.create', { orgId }).service, body });
      const t = data.tag || data;
      printSuccess(`Tag "${opts.name}" created (id: ${t.id}).`);
      formatDetail(t, { format: program.opts().output });
    });

  tag
    .command('update')
    .argument('<tagId>', 'tag ID')
    .description('Update a tag')
    .option('--name <name>', 'New name')
    .option('--color <color>', 'New color')
    .action(async (tagId, opts) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (opts.name) body.name = opts.name;
      if (opts.color) body.color = opts.color;
      await client.patch(resolveEndpoint('tags.update', { orgId, tagId }).path, { service: resolveEndpoint('tags.update', { orgId, tagId }).service, body });
      printSuccess('Tag updated.');
    });

  tag
    .command('delete')
    .argument('<tagId>', 'tag ID')
    .description('Delete a tag')
    .option('--force', 'skip confirmation')
    .action(async (tagId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      // fleet #399: this deleted immediately with no confirmation and no
      // --force option, inconsistent with `prompt delete` which is equally
      // destructive.
      const confirmed = await confirmDestructive(program, options, `Delete tag ${tagId}? This cannot be undone.`);
      if (!confirmed) {
        printInfo('Cancelled.');
        return;
      }

      await client.delete(resolveEndpoint('tags.delete', { orgId, tagId }).path, { service: resolveEndpoint('tags.delete', { orgId, tagId }).service });
      printSuccess('Tag deleted.');
    });
}
