/**
 * Notification commands
 *
 * quox notification channels list|set
 */

import { formatOutput, formatDetail } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerNotificationCommands(program, ctx) {
  const { client, auth } = ctx;

  const notification = program
    .command('notification')
    .description('Manage notification settings');

  const channels = notification
    .command('channels')
    .description('Notification channel management');

  channels
    .command('list')
    .description('List notification channels')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('users.me.notification-channels.list').path, { service: resolveEndpoint('users.me.notification-channels.list').service });
      const chans = data.channels || data || [];
      formatOutput({
        // fleet #392: rows carry channel_type and a nested config object;
        // `type` and a flat `destination` don't exist on them.
        columns: ['type', 'enabled', 'destination'],
        headers: ['Type', 'Enabled', 'Destination'],
        rows: chans.map(c => ({
          type: c.channel_type ?? c.type,
          enabled: c.enabled ? 'Yes' : 'No',
          destination: c.config?.destination ?? c.destination ?? '-',
        })),
      }, { format: program.opts().output });
    });

  channels
    .command('set')
    .description('Configure a notification channel')
    .requiredOption('--type <type>', 'Channel type (email|slack|telegram|...)')
    .option('--enable', 'Enable channel')
    .option('--disable', 'Disable channel')
    .option('--destination <dest>', 'Channel destination (email, webhook URL, chat ID)')
    .action(async (opts) => {
      auth.requireAuth();
      const body = {};
      if (opts.enable) body.enabled = true;
      if (opts.disable) body.enabled = false;
      if (opts.destination) body.config = { destination: opts.destination };
      const data = await client.put(resolveEndpoint('users.me.notification-channels.update', { type: opts.type }).path, { service: resolveEndpoint('users.me.notification-channels.update', { type: opts.type }).service, body });
      formatDetail(data, { format: program.opts().output, title: 'Channel Updated' });
    });
}
