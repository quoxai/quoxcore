/**
 * Trigger commands: read-only enumeration of quoxflow's active trigger
 * subscriptions, plus workflow activate/deactivate (which registers or
 * unregisters those triggers).
 *
 * quox trigger webhooks|schedules|events
 * quox trigger workflow-activate|workflow-deactivate <workflow-id>
 *
 * Backend: quoxflow (NOT the auth service, NOT proxied by collector) — see
 * cli/lib/api/endpoints/triggers.js header for the full access-path
 * decision. quoxflow/src/api/routes/triggers.ts (mounted at /api/triggers)
 * and quoxflow/src/api/routes/workflows-lifecycle.ts (mounted at
 * /api/workflows).
 *
 * Every read here returns UNFILTERED results — see the BACKEND FINDING in
 * the endpoints/triggers.js header: none of webhooks/schedules/events scope
 * by org or workflow. Do not treat an empty `--org` filter as meaningful;
 * there isn't one, by backend design (or omission) today.
 */

import { formatOutput, formatDetail, printInfo } from '../core/output.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerTriggerCommands(program, ctx) {
  const { client, auth } = ctx;

  const trigger = program
    .command('trigger')
    .description('View quoxflow trigger subscriptions (webhooks, schedules, events) and activate/deactivate workflows');

  // ── trigger webhooks ────────────────────────────────────────────────────────

  trigger
    .command('webhooks')
    .description('List registered inbound webhook trigger paths (from active workflow nodes)')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('triggers.webhooks').path, {
        service: resolveEndpoint('triggers.webhooks').service,
      });
      const webhooks = data.data?.webhooks || data.webhooks || [];

      formatOutput({
        columns: ['workflowId', 'nodeId', 'method', 'path', 'fireCount', 'lastFiredAt'],
        headers: ['Workflow', 'Node', 'Method', 'Path', 'Fires', 'Last Fired'],
        rows: webhooks,
      }, { format: program.opts().output, emptyMessage: 'No registered webhook triggers.' });
    });

  // ── trigger schedules ───────────────────────────────────────────────────────

  trigger
    .command('schedules')
    .description('List active cron schedule triggers owned by quoxflow (empty when tasks-service-owned)')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('triggers.schedules').path, {
        service: resolveEndpoint('triggers.schedules').service,
      });
      const payload = data.data || data;
      const schedules = payload.schedules || [];

      if (payload.owned_by === 'tasks') {
        printInfo(payload.note || 'Schedules are managed by the tasks service. View at `quox schedule` / the dashboard.');
      }

      formatOutput({
        columns: ['workflowId', 'nodeId', 'expression', 'timezone', 'nextFireAt', 'active'],
        headers: ['Workflow', 'Node', 'Cron', 'Timezone', 'Next Fire', 'Active'],
        rows: schedules,
      }, { format: program.opts().output, emptyMessage: 'No quoxflow-owned schedule triggers.' });
    });

  // ── trigger events ──────────────────────────────────────────────────────────

  trigger
    .command('events')
    .description('List active EventBus subscriptions')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('triggers.events').path, {
        service: resolveEndpoint('triggers.events').service,
      });
      const subscriptions = data.data?.subscriptions || data.subscriptions || [];

      formatOutput({
        columns: ['id', 'pattern', 'workflowId', 'once', 'lastMatchAt'],
        headers: ['ID', 'Pattern', 'Workflow', 'Once', 'Last Match'],
        rows: subscriptions,
      }, { format: program.opts().output, emptyMessage: 'No active event subscriptions.' });
    });

  // ── trigger workflow-activate ───────────────────────────────────────────────

  trigger
    .command('workflow-activate')
    .description('Activate a workflow — registers its webhook/schedule/event triggers')
    .argument('<id>', 'workflow ID')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.post(resolveEndpoint('workflows.activate', { workflowId: id }).path, {
        service: resolveEndpoint('workflows.activate', { workflowId: id }).service,
        body: { org_id: orgId },
      });
      const result = data.data || data;
      printEvent(glyphLine('quox', 'workflow activated', { result: `${id} · ${result.triggersRegistered ?? 0} trigger(s) registered`, status: 'ok' }));
      formatDetail(result, { format: program.opts().output });
    });

  // ── trigger workflow-deactivate ─────────────────────────────────────────────

  trigger
    .command('workflow-deactivate')
    .description('Deactivate a workflow — unregisters its webhook/schedule/event triggers')
    .argument('<id>', 'workflow ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.post(resolveEndpoint('workflows.deactivate', { workflowId: id }).path, {
        service: resolveEndpoint('workflows.deactivate', { workflowId: id }).service,
      });
      const result = data.data || data;
      printEvent(glyphLine('quox', 'workflow deactivated', { result: id, status: 'ok' }));
      formatDetail(result, { format: program.opts().output });
    });
}
