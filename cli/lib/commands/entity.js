/**
 * Entity commands: CRUD, search, relate
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerEntityCommands(program, ctx) {
  const { client, auth } = ctx;

  const entity = program
    .command('entity')
    .description('Manage entities in the knowledge graph');

  entity
    .command('list')
    .description('List entities')
    .option('--type <type>', 'filter by type')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.type) query.type = options.type;
      const data = await client.get(resolveEndpoint('entity.list').path, { service: resolveEndpoint('entity.list').service, query });
      formatOutput({
        // fleet #392: entities has entity_type/first_seen, not type/created_at.
        columns: ['id', 'entity_type', 'name', 'first_seen'],
        headers: ['ID', 'Type', 'Name', 'First Seen'],
        rows: data.entities || data,
      }, { format: program.opts().output });
    });

  entity
    .command('get')
    .description('Get entity details')
    .argument('<id>', 'entity ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('entity.get', { id }).path, { service: resolveEndpoint('entity.get', { id }).service });
      formatDetail(data.entity || data, { format: program.opts().output });
    });

  entity
    .command('create')
    .description('Create an entity')
    .requiredOption('--type <type>', 'entity type')
    .requiredOption('--name <name>', 'entity name')
    .option('--metadata <json>', 'metadata as JSON')
    .action(async (options) => {
      auth.requireAuth();
      const body = { type: options.type, name: options.name };
      if (options.metadata) body.metadata = parseJSON(options.metadata, '--metadata');
      await client.post(resolveEndpoint('entity.create').path, { service: resolveEndpoint('entity.create').service, body });
      printSuccess(`Entity "${options.name}" created.`);
    });

  entity
    .command('delete')
    .description('Delete an entity, soft by default (also removes its relations)')
    .argument('<id>', 'entity ID')
    .option('--hard', 'permanently delete, no soft-delete')
    .action(async (id, options) => {
      auth.requireAuth();
      const query = {};
      if (options.hard) query.hard = 'true';
      await client.delete(resolveEndpoint('entity.delete', { id }).path, { service: resolveEndpoint('entity.delete', { id }).service, query });
      printSuccess('Entity deleted.');
    });

  entity
    .command('search')
    .description('Search entities')
    .requiredOption('--query <q>', 'search query')
    .option('--type <type>', 'filter by type')
    .action(async (options) => {
      auth.requireAuth();
      const query = { query: options.query };
      if (options.type) query.type = options.type;
      const data = await client.get(resolveEndpoint('entity.search.list').path, { service: resolveEndpoint('entity.search.list').service, query });
      formatOutput({
        // fleet #392: search returns entity_type and bm25(...) AS rank.
        columns: ['id', 'entity_type', 'name', 'rank'],
        headers: ['ID', 'Type', 'Name', 'Rank'],
        rows: data.entities || data.results || data,
      }, { format: program.opts().output });
    });

  entity
    .command('relate')
    .description('Create a relation between entities')
    .argument('<fromId>', 'source entity ID')
    .argument('<toId>', 'target entity ID')
    .requiredOption('--type <relType>', 'relation type')
    .action(async (fromId, toId, options) => {
      auth.requireAuth();
      await client.post(resolveEndpoint('entity.relation').path, {
        service: resolveEndpoint('entity.relation').service,
        body: { from_id: fromId, to_id: toId, type: options.type },
      });
      printSuccess('Relation created.');
    });

  entity
    .command('unrelate')
    .description('Delete a relation between entities, soft by default')
    .argument('<relationId>', 'relation ID')
    .option('--hard', 'permanently delete, no soft-delete')
    .action(async (relationId, options) => {
      auth.requireAuth();
      const query = {};
      if (options.hard) query.hard = 'true';
      await client.delete(resolveEndpoint('entity.relation.delete', { id: relationId }).path, {
        service: resolveEndpoint('entity.relation.delete', { id: relationId }).service,
        query,
      });
      printSuccess('Relation deleted.');
    });
}
