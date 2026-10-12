/**
 * Webhook commands: org webhook subscribers (team_event fan-out targets).
 *
 * quox webhook list|create|rotate|delete
 *
 * Backend: services/auth/routes/webhooks.js, mounted at plain `/api`
 * (org-scoped IN the URL: /api/orgs/:orgId/webhooks...). Enterprise-tier +
 * ORG_MANAGE_SETTINGS gated — expect 402/403 on non-enterprise orgs.
 *
 * The secret is returned ONLY on create and rotate (plaintext, once) — it
 * is never retrievable again after that response, by design (HMAC signing
 * secret for payload verification). We print it prominently and warn the
 * user to record it now.
 *
 * Valid `events` values are the frozen TEAM_EVENT_TYPES set
 * (services/auth/utils/teamEvents.js): team.created, team.archived,
 * team.member.invited, team.member.joined, team.member.left,
 * team.member.role_changed. Not enumerated client-side — the server
 * validates and returns `invalid_webhook` on an unknown type.
 *
 * Distinct from `quox trigger webhooks` (endpoints/triggers.js), which
 * lists INBOUND workflow-trigger webhook paths on quoxflow, not these
 * outbound org subscriptions.
 */

import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

function printSecret(secret) {
  printWarning('Record this secret now — it will not be shown again:');
  console.log(`  ${secret}`);
}

export function registerWebhookCommands(program, ctx) {
  const { client, auth } = ctx;

  const webhook = program
    .command('webhook')
    .description('Manage org webhook subscribers (enterprise — team_event fan-out)');

  // ── webhook list ─────────────────────────────────────────────────────────────

  webhook
    .command('list')
    .description('List org webhook subscriptions')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('webhooks.list', { orgId }).path, {
        service: resolveEndpoint('webhooks.list', { orgId }).service,
      });
      const webhooks = data.webhooks || data || [];

      formatOutput({
        columns: ['id', 'url', 'events', 'enabled', 'created_at'],
        headers: ['ID', 'URL', 'Events', 'Enabled', 'Created'],
        rows: webhooks.map(w => ({
          ...w,
          events: Array.isArray(w.events) ? w.events.join(', ') : w.events,
        })),
      }, { format: program.opts().output, emptyMessage: 'No webhooks configured.' });
    });

  // ── webhook create ──────────────────────────────────────────────────────────

  webhook
    .command('create')
    .description('Create an org webhook subscription')
    .requiredOption('--url <url>', 'https:// endpoint to receive events')
    .requiredOption('--events <events>', 'comma-separated team_event types (e.g. team.created,team.member.joined)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const events = options.events.split(',').map(e => e.trim()).filter(Boolean);

      const data = await client.post(resolveEndpoint('webhooks.create', { orgId }).path, {
        service: resolveEndpoint('webhooks.create', { orgId }).service,
        body: { url: options.url, events },
      });
      const created = data.webhook || data;
      printSuccess(`Webhook created for ${options.url}.`);
      formatDetail(created, {
        format: program.opts().output,
        fields: ['id', 'url', 'events', 'enabled', 'created_at'],
        labels: { id: 'ID', url: 'URL', events: 'Events', enabled: 'Enabled', created_at: 'Created' },
      });
      if (created.secret) printSecret(created.secret);
    });

  // ── webhook rotate ──────────────────────────────────────────────────────────

  webhook
    .command('rotate')
    .description('Rotate a webhook\'s signing secret')
    .argument('<id>', 'webhook ID')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.post(resolveEndpoint('webhooks.rotate', { orgId, id }).path, {
        service: resolveEndpoint('webhooks.rotate', { orgId, id }).service,
      });
      printSuccess(`Webhook ${id} secret rotated.`);
      if (data.secret) printSecret(data.secret);
    });

  // ── webhook delete ──────────────────────────────────────────────────────────

  webhook
    .command('delete')
    .description('Delete an org webhook subscription')
    .argument('<id>', 'webhook ID')
    .option('--force', 'skip confirmation')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Delete webhook ${id}? This cannot be undone.`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Cancelled.');
          return;
        }
      }

      await client.delete(resolveEndpoint('webhooks.delete', { orgId, id }).path, {
        service: resolveEndpoint('webhooks.delete', { orgId, id }).service,
      });
      printSuccess('Webhook deleted.');
    });
}
