/**
 * AEE (Agent Envelope Exchange) commands
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerAeeCommands(program, ctx) {
  const { client, auth } = ctx;

  const aee = program
    .command('aee')
    .description('Agent Envelope Exchange protocol');

  aee
    .command('store')
    .description('Store an AEE envelope')
    .requiredOption('--envelope <json>', 'envelope data as JSON')
    .action(async (options) => {
      auth.requireAuth();
      const envelope = parseJSON(options.envelope, '--envelope');
      await client.post(resolveEndpoint('aee.store').path, { service: resolveEndpoint('aee.store').service, body: envelope });
      printSuccess('Envelope stored.');
    });

  aee
    .command('get')
    .description('Get an envelope by ID')
    .argument('<id>', 'envelope ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('aee.get', { id }).path, { service: resolveEndpoint('aee.get', { id }).service });
      formatDetail(data.envelope || data, { format: program.opts().output });
    });

  aee
    .command('query')
    .description('Query envelopes')
    // fleet #386 + adjacent fix: --from/--to were described as dates, but the
    // route matches them against the envelope's "from"/"to" columns — the AEE
    // sender and recipient (from: 'human.adam', to: 'agent.cipher'). Passing a
    // date matched a sender literally named "2026-01-01", i.e. nothing. The
    // route's real date filters are after/before, which the CLI never sent, so
    // date filtering was unreachable. Descriptions now match the protocol, and
    // --after/--before/--intent expose filters the route already supported.
    .option('--from <sender>', 'envelope sender (e.g. human.adam, agent.cipher)')
    .option('--to <recipient>', 'envelope recipient')
    .option('--after <date>', 'only envelopes at/after this ISO timestamp')
    .option('--before <date>', 'only envelopes before this ISO timestamp')
    .option('--intent <intent>', 'intent substring match (e.g. quox.chat)')
    .option('--corr <id>', 'correlation ID — the envelopes of one conversation (see `aee conversations`)')
    .option('--type <type>', 'envelope type')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.from) query.from = options.from;
      if (options.to) query.to = options.to;
      if (options.after) query.after = options.after;
      if (options.before) query.before = options.before;
      if (options.intent) query.intent = options.intent;
      if (options.corr) query.corr = options.corr;
      if (options.type) query.type = options.type;
      const data = await client.get(resolveEndpoint('aee.query.list').path, { service: resolveEndpoint('aee.query.list').service, query });
      formatOutput({
        columns: ['id', 'type', 'from', 'to', 'intent', 'ts'],
        headers: ['ID', 'Type', 'From', 'To', 'Intent', 'Time'],
        rows: data.envelopes || data.results || data,
      }, { format: program.opts().output });
    });

  aee
    .command('conversations')
    .description('List AEE conversations')
    .option('--limit <n>', 'max results', '20')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('aee.conversations.list').path, { service: resolveEndpoint('aee.conversations.list').service, query: { limit: options.limit } });
      formatOutput({
        // fleet #385: the endpoint returns { corr, first_ts, last_ts, count }
        // (see the GROUP BY corr query in collector/server.js). This declared
        // corr_id/envelope_count, which don't exist in the payload, so two of
        // three columns rendered as dashes with no error.
        columns: ['corr', 'count', 'last_ts'],
        headers: ['Conversation', 'Envelopes', 'Last Activity'],
        rows: data.conversations || data,
      }, { format: program.opts().output });
    });

  aee
    .command('stats')
    .description('AEE statistics')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('aee.stats.list').path, { service: resolveEndpoint('aee.stats.list').service });
      formatDetail(data.stats || data, { format: program.opts().output, title: 'AEE Stats' });
    });
}
