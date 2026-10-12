/**
 * Org platform settings (feature flags) commands.
 *
 * quox settings list|get|set|history
 *
 * Backend: services/collector/server.js
 *   GET   /api/v1/platform/settings/flags          effective flags for the caller's org
 *   PATCH /api/v1/platform/settings/flags/:key     { value } (human org admin)
 *   GET   /api/v1/platform/settings/flags/history  change audit trail (admin)
 */

import { formatOutput, formatDetail } from '../core/output.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';

async function fetchFlags(client) {
  const ep = resolveEndpoint('v1.settings.list');
  const data = await client.get(ep.path, { service: ep.service });
  return data.flags || [];
}

export function registerSettingsCommands(program, ctx) {
  const { client, auth } = ctx;

  const settings = program
    .command('settings')
    .description('View and change org platform settings (feature flags)');

  settings
    .command('list')
    .description('List effective platform settings for the active org')
    .action(async () => {
      auth.requireAuth();
      const flags = await fetchFlags(client);
      formatOutput(
        {
          columns: ['key', 'value', 'source'],
          headers: ['KEY', 'VALUE', 'SOURCE'],
          rows: flags.map((f) => ({ key: f.key, value: f.value, source: f.source })),
        },
        { format: program.opts().output, raw: flags, emptyMessage: 'No settings.' }
      );
    });

  settings
    .command('get <key>')
    .description('Show one platform setting')
    .action(async (key) => {
      auth.requireAuth();
      const flags = await fetchFlags(client);
      const flag = flags.find((f) => f.key === key);
      if (!flag) throw new Error(`Unknown setting: ${key}. Run "quox settings list" for valid keys.`);
      formatDetail(flag, { format: program.opts().output, title: key });
    });

  settings
    .command('set <key> <value>')
    .description('Change a platform setting for the active org (human org admin)')
    .action(async (key, value) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.settings.set', { key });
      const data = await client.patch(ep.path, { service: ep.service, body: { value } });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      printEvent(glyphLine('quox', `setting ${key}`, {
        result: `${data.old_value ?? '(unset)'} -> ${data.new_value}`,
        status: 'ok',
      }));
    });

  settings
    .command('history')
    .description('Show the platform settings change history (admin)')
    .option('--key <key>', 'filter to one setting')
    .option('--limit <n>', 'max rows', '50')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.settings.history');
      const query = { limit: options.limit };
      if (options.key) query.key = options.key;
      const data = await client.get(ep.path, { service: ep.service, query });
      const history = data.history || [];
      formatOutput(
        {
          columns: ['when', 'key', 'change', 'by'],
          headers: ['WHEN', 'KEY', 'CHANGE', 'BY'],
          rows: history.map((h) => ({
            when: h.created_at,
            key: h.key,
            change: `${h.old_value ?? '(unset)'} -> ${h.new_value}`,
            by: h.actor_label || h.actor_id || '',
          })),
        },
        { format: program.opts().output, raw: history, emptyMessage: 'No history.' }
      );
    });
}
