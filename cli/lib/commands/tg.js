/**
 * Telegram Pro commands (QTG-PRO P0 CLI parity): onboarding status, owner
 * binding, session leases, and webhook admin.
 *
 * quox tg status [--bot <botId>]
 * quox tg bind-owner <tg_chat_id> [--bot <botId>]
 * quox tg leases
 * quox tg webhook-info [--bot <botId>]
 * quox tg setup <webhook_url> [--bot <botId>]
 *
 * Backend: services/collector/server.js (QTG-PRO P0 sections) — every route
 * is collector-direct (no org segment in the URL), requireServiceOrUserAuth()
 * gated. Onboarding handler bodies live in
 * services/collector/lib/telegramPro/onboardingService.js (getOnboardingStatus,
 * bindOwner); session leases in services/collector/lib/telegramPro/sessionLeaseStore.js;
 * webhook admin reuses the existing /webhook/telegram/* routes shared with
 * the original Telegram integration setup flow.
 *
 * bind-owner 409s when a primary owner binding already exists for the
 * bot/chat/thread — mirrored on the quoxchat `reply` 409 convention
 * (cli/lib/commands/quoxchat.js): catch, surface a plain-language error, and
 * point the caller at `quox tg status` rather than trying to unpack response
 * detail the generic client error path doesn't forward (QuoxApiError only
 * carries `detail`/`details`, not arbitrary body fields like `binding`).
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function isoOrDash(value) {
  if (value === null || value === undefined) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function renderStatus(data, botId) {
  const lines = [];
  lines.push('');
  lines.push(`Bot: ${botId || 'default'}`);
  if (data.bot) {
    lines.push(`  Username        ${data.bot.username || '-'}`);
    lines.push(`  Name            ${data.bot.name || '-'}`);
  } else {
    lines.push('  (no bot token configured)');
  }
  lines.push(`  Webhook URL     ${data.webhook?.url || '-'}`);
  lines.push(`  Webhook active  ${yesNo(!!data.webhook?.active)}`);
  if (data.webhook?.last_error_message) {
    lines.push(`  Last error      ${data.webhook.last_error_message}`);
  }
  if (data.owner_binding) {
    lines.push(`  Owner chat      ${data.owner_binding.tg_chat_id}${data.owner_binding.title ? ` (${data.owner_binding.title})` : ''}`);
  } else {
    lines.push('  Owner chat      not bound');
  }
  return lines.join('\n');
}

export function registerTgCommands(program, ctx) {
  const { client, auth } = ctx;

  const tg = program
    .command('tg')
    .description('Manage Telegram Pro: onboarding status, owner binding, session leases, webhook admin');

  // ── status ───────────────────────────────────────────────────────────────

  tg
    .command('status')
    .description('Show Telegram Pro onboarding status: bot, webhook, seen chats, owner binding')
    .option('--bot <botId>', 'target a specific bot ID instead of the default gateway bot')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.bot) query.bot_id = options.bot;

      const ep = resolveEndpoint('tg.status');
      const data = await client.get(ep.path, { service: ep.service, query });

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (format === 'quiet') {
        console.log(data.bot?.username || '');
        return;
      }

      console.log(renderStatus(data, options.bot));

      formatOutput({
        columns: ['tg_chat_id', 'title', 'is_forum', 'seen_at'],
        headers: ['Chat ID', 'Title', 'Forum', 'Seen'],
        rows: (data.chats_seen || []).map((c) => ({
          tg_chat_id: c.tg_chat_id,
          title: c.title || '-',
          is_forum: yesNo(c.is_forum),
          seen_at: c.seen_at || '-',
        })),
      }, { format, emptyMessage: 'No chats seen yet — message the bot from a chat first.' });

      if (data.bots && data.bots.length) {
        console.log('\nBots');
        formatOutput({
          columns: ['bot_id', 'username', 'kind', 'webhook_active', 'chats_bound'],
          headers: ['Bot ID', 'Username', 'Kind', 'Webhook', 'Chats'],
          rows: data.bots.map((b) => ({
            bot_id: b.bot_id,
            username: b.username || '-',
            kind: b.kind,
            webhook_active: yesNo(b.webhook_active),
            chats_bound: b.chats_bound,
          })),
        }, { format, emptyMessage: 'No bots configured.' });
      }
    });

  // ── bind-owner ───────────────────────────────────────────────────────────

  tg
    .command('bind-owner')
    .description('Bind a Telegram chat as the owner target (the chat must have messaged the bot first)')
    .argument('<tg_chat_id>', 'Telegram chat ID that has already messaged the bot')
    .option('--bot <botId>', 'target a specific bot ID instead of the default gateway bot')
    .action(async (tgChatId, options) => {
      auth.requireAuth();
      const body = { tg_chat_id: tgChatId };
      if (options.bot) body.bot_id = options.bot;

      const ep = resolveEndpoint('tg.bindOwner');
      try {
        const data = await client.post(ep.path, { service: ep.service, body });
        if (program.opts().output === 'json') {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        printSuccess(`Owner bound to chat ${tgChatId}.`);
        if (data.binding) {
          formatDetail(data.binding, {
            format: program.opts().output,
            title: 'Owner Binding',
          });
        }
      } catch (err) {
        if (err.status === 409) {
          throw new Error(
            `A primary owner binding already exists for this bot. Run \`quox tg status${options.bot ? ` --bot ${options.bot}` : ''}\` to see the current owner binding before rebinding.`
          );
        }
        throw err;
      }
    });

  // ── leases ───────────────────────────────────────────────────────────────

  tg
    .command('leases')
    .description('List session leases for parallel terminal identities (T1-T8)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('tg.leases.list');
      const data = await client.get(ep.path, { service: ep.service });

      formatOutput({
        columns: ['terminal', 'session_id', 'stream', 'alive', 'expires_at'],
        headers: ['Terminal', 'Session ID', 'Stream', 'Alive', 'Expires'],
        rows: (data.leases || []).map((l) => ({
          terminal: l.terminal,
          session_id: l.session_id,
          stream: l.stream || '-',
          alive: yesNo(l.alive),
          expires_at: isoOrDash(l.expires_at),
        })),
      }, { format: program.opts().output, emptyMessage: 'No active session leases.' });
    });

  // ── webhook-info ─────────────────────────────────────────────────────────

  tg
    .command('webhook-info')
    .description('Show current Telegram webhook status (per-bot info is pending backend support; --bot is a no-op today)')
    .option('--bot <botId>', 'target a specific bot ID (not yet honored server-side)')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.bot) query.bot_id = options.bot;

      const ep = resolveEndpoint('tg.webhook.info');
      const data = await client.get(ep.path, { service: ep.service, query });

      formatDetail({
        active: data.active,
        has_token: data.has_token,
        bot_username: data.bot_username,
        webhook_url: data.webhook_url,
        pending_update_count: data.pending_update_count,
        last_error_date: data.last_error_date,
        last_error_message: data.last_error_message,
      }, {
        format: program.opts().output,
        title: 'Telegram Webhook Info',
        labels: {
          active: 'Active',
          has_token: 'Has token',
          bot_username: 'Bot username',
          webhook_url: 'Webhook URL',
          pending_update_count: 'Pending updates',
          last_error_date: 'Last error date',
          last_error_message: 'Last error message',
        },
      });
    });

  // ── setup ────────────────────────────────────────────────────────────────

  tg
    .command('setup')
    .description('Register the Telegram webhook URL for the bot')
    .argument('<webhook_url>', 'HTTPS URL Telegram should POST updates to')
    .option('--bot <botId>', 'target a specific bot ID instead of the default gateway bot')
    .action(async (webhookUrl, options) => {
      auth.requireAuth();
      const body = { webhook_url: webhookUrl };
      if (options.bot) body.bot_id = options.bot;

      const ep = resolveEndpoint('tg.webhook.setup');
      const data = await client.post(ep.path, { service: ep.service, body });

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      printSuccess(`Webhook registered: ${data.webhook_url} (bot: ${data.bot_username || 'unknown'}).`);
    });
}
