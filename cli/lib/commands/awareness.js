/**
 * `quox awareness post|list|summary|remove`: QuoxAwareness ledger, the
 * cross-surface situational-awareness store. Collector routes under
 * /api/v1/awareness (org-scoped).
 */
import { formatOutput, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

export function registerAwarenessCommands(program, ctx) {
  const { client, auth } = ctx;

  const aw = program.command('awareness').description('QuoxAwareness: cross-surface situational-awareness ledger');

  aw
    .command('post <key> <state>')
    .description('Post or update an awareness entry (upsert by key)')
    .option('--title <text>', 'short title')
    .option('--detail <text>', 'longer detail')
    .option('--source <text>', 'who is posting this entry', 'manual')
    .option('--severity <level>', 'info|warn|critical', 'info')
    .option('--ttl <seconds>', 'expire the entry after this many seconds')
    .action(async (key, state, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('awareness.post');
      const body = {
        key,
        state,
        title: options.title,
        detail: options.detail,
        source: options.source,
        severity: options.severity,
        ttl_s: options.ttl ? Number(options.ttl) : undefined,
      };
      const data = await client.post(ep.path, { service: ep.service, body, query: { org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Posted awareness: ${key}`);
    });

  aw
    .command('list')
    .description('List awareness entries for the active org')
    .option('--source <text>', 'filter by source')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('awareness.list');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program), source: options.source } });
      const entries = data.entries || [];
      formatOutput(entries.map((e) => ({
        KEY: e.key,
        TITLE: e.title || '',
        STATE: e.state,
        SEV: e.severity || '',
        SOURCE: e.source || '',
        UPDATED: e.updated_at || '',
      })), {
        format: program.opts().output,
        columns: ['KEY', 'TITLE', 'STATE', 'SEV', 'SOURCE', 'UPDATED'],
        emptyMessage: 'No awareness entries. Post one with `quox awareness post <key> <state>`.',
        raw: entries,
      });
    });

  aw
    .command('summary')
    .description('Current-state briefing (what a reader like the voice receptionist sees)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('awareness.summary');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') {
        formatOutput(data, { format: 'json', raw: data });
        return;
      }
      console.log(data.text);
    });

  aw
    .command('remove <key>')
    .description('Remove an awareness entry')
    .action(async (key) => {
      auth.requireAuth();
      const ep = resolveEndpoint('awareness.remove', { key });
      const data = await client.delete(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Removed ${key}`);
    });
}
