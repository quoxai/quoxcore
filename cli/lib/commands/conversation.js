/**
 * Conversation commands
 *
 * quox conversation list|get|search|stats
 */

import { formatOutput, formatDetail } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerConversationCommands(program, ctx) {
  const { client, auth } = ctx;

  const conv = program
    .command('conversation')
    .description('Manage conversations');

  conv
    .command('list')
    .description('List your chat conversations (newest first); --archive lists the imported conversation archive')
    .option('--limit <n>', 'Max results', '20')
    .option('--offset <n>', 'Skip results (archive only)', '0')
    .option('--archive', 'list the imported conversation archive instead of chat conversations')
    .action(async (opts) => {
      auth.requireAuth();
      if (!opts.archive) {
        const ep = resolveEndpoint('conversations.chat.list');
        const data = await client.get(ep.path, { service: ep.service, query: { limit: opts.limit } });
        const rows = data.conversations || [];
        formatOutput({
          columns: ['id', 'title', 'turns', 'agent', 'updated_at'],
          headers: ['ID', 'Title', 'Turns', 'Agent', 'Updated'],
          rows: rows.map((c) => ({
            id: c.id,
            title: (c.title || 'Untitled').slice(0, 50),
            turns: c.turn_count ?? 0,
            agent: c.agent || '-',
            updated_at: c.updated_at ? new Date(c.updated_at).toLocaleString() : '-',
          })),
        }, { format: program.opts().output });
        return;
      }
      const query = { limit: opts.limit, offset: opts.offset };
      const data = await client.get(resolveEndpoint('conversations.list').path, { service: resolveEndpoint('conversations.list').service, query });
      const conversations = data.conversations || data || [];
      formatOutput({
        columns: ['id', 'title', 'messages', 'created_at'],
        headers: ['ID', 'Title', 'Messages', 'Created'],
        rows: conversations.map(c => ({
          id: c.id,
          title: (c.title || 'Untitled').slice(0, 50),
          messages: c.message_count || c.messages?.length || 0,
          created_at: c.created_at ? new Date(c.created_at).toLocaleDateString() : '-',
        })),
      }, { format: program.opts().output });
    });

  conv
    .command('get')
    .argument('<id>', 'conversation ID')
    .description('Show a chat conversation\'s turns; --archive reads the imported conversation archive')
    .option('--limit <n>', 'Max turns (chat only)', '50')
    .option('--archive', 'read the imported conversation archive instead of chat conversations')
    .action(async (id, opts) => {
      auth.requireAuth();
      if (!opts.archive) {
        const ep = resolveEndpoint('conversations.chat.turns', { id });
        const data = await client.get(ep.path, { service: ep.service, query: { limit: opts.limit } });
        const turns = data.turns || [];
        formatOutput({
          columns: ['ts', 'role', 'content'],
          headers: ['Time', 'Role', 'Content'],
          rows: turns.map((t) => ({ ts: t.ts ? new Date(t.ts).toLocaleString() : '-', role: t.role, content: t.content })),
        }, { format: program.opts().output });
        return;
      }
      const data = await client.get(resolveEndpoint('conversations.get', { id }).path, { service: resolveEndpoint('conversations.get', { id }).service });
      formatDetail(data.conversation || data, { format: program.opts().output, title: 'Conversation' });
    });

  conv
    .command('search')
    .description('Search conversations')
    .requiredOption('--query <q>', 'Search query')
    .option('--limit <n>', 'Max results', '10')
    .action(async (opts) => {
      auth.requireAuth();
      const query = { query: opts.query, limit: opts.limit };
      const data = await client.get(resolveEndpoint('conversations.search.list').path, { service: resolveEndpoint('conversations.search.list').service, query });
      const results = data.results || data || [];
      formatOutput({
        columns: ['id', 'title', 'score'],
        headers: ['ID', 'Title', 'Score'],
        rows: results.map(r => ({ id: r.id, title: (r.title || 'Untitled').slice(0, 50), score: r.score != null ? r.score.toFixed(2) : '-' })),
      }, { format: program.opts().output });
    });

  conv
    .command('stats')
    .description('Conversation statistics')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('conversations.stats.list').path, { service: resolveEndpoint('conversations.stats.list').service });
      formatDetail(data.stats || data, { format: program.opts().output, title: 'Conversation Stats' });
    });
}
