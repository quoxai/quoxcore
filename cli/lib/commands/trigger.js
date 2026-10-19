/**
 * Trigger commands: read-only enumeration of quoxflow's active trigger
 * subscriptions, plus workflow activate/deactivate (which registers or
 * unregisters those triggers).
 *
 * quox trigger webhooks|schedules|events
 * quox trigger workflow-activate|workflow-deactivate <workflow-id>
 * quox trigger pause|resume <workflow-id> [node-id]
 * quox trigger webhook-fire <path> [--body <json|@file>]
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
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep, basename } from 'node:path';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxApiError } from '../core/errors.js';


// A webhook path is plain segments under /webhooks: no .., no query or fragment, no encoding tricks, no spaces.
const WEBHOOK_SEGMENT = /^[A-Za-z0-9._~-]+$/;
export function normalizeWebhookPath(raw) {
  let p = String(raw || '').trim().replace(/^\/+/, '');
  if (p.startsWith('webhooks/')) p = p.slice('webhooks/'.length);
  const segs = p.split('/');
  if (!p || segs.some((x) => !WEBHOOK_SEGMENT.test(x) || x === '.' || x === '..')) {
    throw new Error(`webhook path "${raw}" is not a plain path under /webhooks (letters, digits, . _ ~ - and /; no .., query, fragment or spaces)`);
  }
  return segs.join('/');
}
// HYPERION #23: --body @file is an ALLOWLIST. The file must be a regular file whose REAL path (symlinks resolved) is
// inside the working directory, and never a credential-shaped name: ~/.config/quox/config.json is JSON and holds the
// user's tokens, and the fired run's trigger data is org-readable and can be forwarded by the workflow.
const CREDENTIAL_NAME = /^(?:\.env(?:\..*)?|.*\.pem|.*\.key|id_[a-z0-9_]+(?:\.pub)?|credentials(?:\..*)?)$/i;
export function parseWebhookBody(raw, { cwd = process.cwd() } = {}) {
  if (raw === undefined) return {};
  let text = String(raw);
  if (text.startsWith('@')) {
    const asked = text.slice(1);
    const rule = '--body @file reads only a regular file inside the current directory';
    let real, root;
    try { root = realpathSync(cwd); real = realpathSync(resolvePath(cwd, asked)); }
    catch { throw new Error(`--body @${asked}: no such file (${rule})`); }
    if (real !== root && !real.startsWith(root + sep)) throw new Error(`--body @${asked} is not inside the current directory (${rule}; symlinks are followed)`);
    const rel = real.slice(root.length + 1);
    if (CREDENTIAL_NAME.test(basename(real)) || /(^|[\\/])\.config[\\/].*config\.json$/i.test(rel)) throw new Error(`--body @${asked} looks like a credential file; refused (${rule}, never a key, token or config file)`);
    if (!statSync(real).isFile()) throw new Error(`--body @${asked} is not a regular file (${rule})`);
    text = readFileSync(real, 'utf8');
  }
  try { return JSON.parse(text); } catch { throw new Error('--body is not JSON (pass a JSON string or @file with JSON in it)'); }
}
const apiFail = (method, path, err) => {
  const status = err instanceof QuoxApiError ? err.status : 'network error';
  return new Error(`${method} ${path} failed (${status}): ${err.message}`);
};

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

  // ── trigger pause | resume ─────────────────────────────────────────────────
  // SITE-CLI 2026-10-19: pausing a schedule meant re-applying the workflow JSON with paused:true pasted in by hand.
  // The node is found from the workflow when it has exactly one schedule; with several, name it (never guess).
  const scheduleNode = async (workflowId, nodeId) => {
    if (nodeId) return nodeId;
    const ep = resolveEndpoint('triggers.schedule-list');
    const data = await client.get(ep.path, { service: ep.service });
    const rows = (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []).filter((r) => r.workflowId === workflowId);
    if (rows.length === 0) throw new Error(`no schedule found for workflow ${workflowId} (is it activated? quox trigger schedules)`);
    if (rows.length > 1) throw new Error(`workflow ${workflowId} has ${rows.length} schedule nodes (${rows.map((r) => r.nodeId).join(', ')}): name one, quox trigger pause ${workflowId} <node>`);
    return rows[0].nodeId;
  };
  for (const [verb, key, done] of [['pause', 'triggers.schedule-pause', 'paused'], ['resume', 'triggers.schedule-resume', 'resumed']]) {
    trigger
      .command(verb)
      .description(verb === 'pause'
        ? 'Pause a workflow schedule (stays paused across restarts) without re-applying the workflow'
        : 'Resume a paused workflow schedule')
      .argument('<workflowId>', 'workflow ID')
      .argument('[nodeId]', 'schedule node ID (needed only when the workflow has more than one schedule)')
      .action(async (workflowId, nodeIdArg) => {
        auth.requireAuth();
        const nodeId = await scheduleNode(workflowId, nodeIdArg);
        const ep = resolveEndpoint(key, { workflowId, nodeId });
        let data;
        try { data = await client.post(ep.path, { service: ep.service }); } catch (err) { throw apiFail('POST', ep.path, err); }
        const result = data?.data || data;
        printEvent(glyphLine('quox', `schedule ${done}`, { result: `${workflowId}:${nodeId}`, status: 'ok' }));
        formatDetail(result, { format: program.opts().output });
      });
  }

  // ── trigger webhook-fire ───────────────────────────────────────────────────
  // Test-fire a workflow's inbound webhook through the real public ingress. The route copies every request header
  // into the run's trigger data, so this sends NO bearer and NO service key: the run is a system:webhook:<path> run,
  // exactly like an outside caller's.
  trigger
    .command('webhook-fire')
    .description('Fire a workflow inbound webhook (POST /webhooks/<path>) as an outside caller would, with no credentials')
    .argument('<path>', 'webhook path, e.g. orders/new (a leading /webhooks/ is fine)')
    .option('--body <json|@file>', 'JSON body (a JSON string, or @file); default {}')
    .action(async (rawPath, options) => {
      const path = normalizeWebhookPath(rawPath);
      const body = parseWebhookBody(options.body, { cwd: (ctx.cwd || (() => process.cwd()))() });
      const ep = resolveEndpoint('triggers.webhook-fire', { path });
      let data;
      try { data = await client.post(ep.path, { service: ep.service, body, noAuth: true, noActAs: true, anonymous: true }); } catch (err) { throw apiFail('POST', ep.path, err); }
      const result = data?.data || data;
      printEvent(glyphLine('quox', 'webhook fired', { result: `/webhooks/${path}${result?.executionId ? ` · run ${result.executionId}` : ''}`, status: 'ok' }));
      formatDetail(result, { format: program.opts().output });
    });
}
