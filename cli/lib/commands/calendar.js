/**
 * Calendar-Q commands: connected calendars, agenda, coverage, manual sync,
 * and (L2-C2) proposing/reconciling/reviewing approved event creation.
 *
 * There is deliberately NO `calendar create` command: creating an event
 * always requires a human approval, resolved through the Approvals inbox
 * (`quox inbox`) — not a second CLI doorway around that gate. `calendar
 * propose` only ever builds the proposal (no external effect); an agent or a
 * human approver is what actually triggers calendar_event_create, and that
 * call is unconditionally gated by withApprovalGate regardless of caller.
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

function isJsonOutput(program) {
  return program.opts().output === 'json';
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

export function registerCalendarCommands(program, ctx) {
  const { client, auth } = ctx;

  const calendar = program
    .command('calendar')
    .description('Calendar-Q: connected calendars, agenda, coverage, sync');

  // ── status ───────────────────────────────────────────────────────────

  calendar
    .command('status')
    .description('Show connected Calendar-Q connections and their sync watermark')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('calendarq.status');
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      formatOutput({
        columns: ['connectionId', 'provider', 'resourceId', 'status', 'latestWatermarkTs'],
        headers: ['ID', 'Provider', 'Resource', 'Status', 'Watermark'],
        rows: data.connections || [],
      }, { format: program.opts().output });
      printSuccess(`${data.connectionsCount ?? 0} connection(s), ${data.layerCount ?? 0} layer(s).`);
    });

  // ── layers ───────────────────────────────────────────────────────────

  calendar
    .command('layers')
    .description('List Calendar-Q layers')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('calendarq.layers');
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      formatOutput({
        columns: ['layerId', 'kind', 'displayName', 'visible', 'scope'],
        headers: ['Layer', 'Kind', 'Name', 'Visible', 'Scope'],
        rows: data.layers || [],
      }, { format: program.opts().output });
    });

  // ── agenda ───────────────────────────────────────────────────────────

  calendar
    .command('agenda')
    .description("Show a connection's agenda: occurrences plus coverage state")
    .requiredOption('--connection <id>', 'Calendar-Q connection ID')
    .option('--layers <csv>', 'comma-separated layer ids to restrict to')
    .action(async (options) => {
      auth.requireAuth();
      const query = { connectionId: options.connection };
      if (options.layers) query.layerIds = options.layers;
      const ep = resolveEndpoint('calendarq.agenda');
      const data = await client.get(ep.path, { service: ep.service, query });
      if (isJsonOutput(program)) return printJson(data);
      const coverage = data.coverage || {};
      console.log(`Coverage: ${coverage.state} (watermark ${coverage.watermarkTs ?? 'n/a'}, window ${coverage.windowStartLocalDate} to ${coverage.windowEndLocalDateExclusive})`);
      const occurrences = data.occurrences || [];
      if (occurrences.length === 0) {
        console.log('No occurrences in this window.');
        return;
      }
      for (const occ of occurrences) console.log(occ.spokenForm);
    });

  // ── coverage ─────────────────────────────────────────────────────────

  calendar
    .command('coverage')
    .description('Show just the coverage/freshness state for a connection')
    .requiredOption('--connection <id>', 'Calendar-Q connection ID')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('calendarq.coverage');
      const data = await client.get(ep.path, { service: ep.service, query: { connectionId: options.connection } });
      if (isJsonOutput(program)) return printJson(data);
      formatDetail(data.coverage || {}, { format: program.opts().output, title: 'Calendar-Q Coverage' });
    });

  // ── sync ─────────────────────────────────────────────────────────────

  calendar
    .command('sync')
    .description('Trigger a manual sync for a connection (respects retired/backoff eligibility)')
    .requiredOption('--connection <id>', 'Calendar-Q connection ID')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('calendarq.sync');
      // A full-window provider fetch can run long; give it the same generous
      // ceiling `quox mail sync` uses.
      const data = await client.post(ep.path, { service: ep.service, body: { connectionId: options.connection }, timeout: 240000 });
      if (isJsonOutput(program)) return printJson(data);
      const result = data.result || {};
      if (result.skipped) {
        printSuccess(`Sync skipped for ${options.connection}: ${result.skipped}.`);
        return;
      }
      if (result.failed) {
        console.error(`Sync failed for ${options.connection}: ${result.error}`);
        return;
      }
      const stats = result.stats || {};
      printSuccess(`Synced ${options.connection}. ${stats.inserted ?? 0} occurrence(s), ${stats.omitted ?? 0} omitted, ${stats.changed ?? 0} changed.`);
    });

  // ── propose ──────────────────────────────────────────────────────────

  calendar
    .command('propose')
    .description('Propose creating a single, non-recurring event (no external effect — nothing is created yet)')
    .requiredOption('--connection <id>', 'Calendar-Q connection ID')
    .requiredOption('--title <title>', 'Event title')
    .requiredOption('--timezone <tz>', 'IANA timezone')
    .option('--start <iso>', 'Start time, ISO 8601 (omit for --all-day)')
    .option('--end <iso>', 'End time, ISO 8601, must be after --start (omit for --all-day)')
    .option('--all-day', 'Create a single-day all-day event')
    .option('--date <date>', "'YYYY-MM-DD', required with --all-day")
    .option('--attendees <csv>', 'comma-separated attendee emails')
    .option('--notify <policy>', "'none' or 'attendees'", 'none')
    .option('--visibility <visibility>', "'default', 'private', or 'busy-only'", 'default')
    .option('--description <text>', 'Event description')
    .action(async (options) => {
      auth.requireAuth();
      const body = {
        connectionId: options.connection,
        title: options.title,
        timezone: options.timezone,
        notifyPolicy: options.notify,
        visibility: options.visibility,
      };
      if (options.allDay) {
        body.allDay = true;
        body.dateOnly = options.date;
      } else {
        body.startTs = options.start ? Date.parse(options.start) : undefined;
        body.endTs = options.end ? Date.parse(options.end) : undefined;
      }
      if (options.attendees) body.attendees = options.attendees.split(',').map((e) => ({ email: e.trim() })).filter((a) => a.email);
      if (options.description) body.description = options.description;

      const ep = resolveEndpoint('calendarq.propose');
      const data = await client.post(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      const p = data.proposal;
      console.log(`Proposed "${p.title}" (proposalId ${p.proposalId}).`);
      if ((data.overlaps || []).length > 0) {
        console.log(`Disclosed conflicts: ${data.overlaps.map((o) => o.title).join(', ')}`);
      } else {
        console.log('No conflicts found against the latest synced calendar data.');
      }
      printSuccess('Nothing has been created yet. Approve via the Approvals inbox to actually create this event.');
    });

  // ── receipts ─────────────────────────────────────────────────────────

  calendar
    .command('receipts')
    .description('Show Calendar-Q write-path receipts (newest first), each with its full state timeline')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('calendarq.receipts');
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      const receipts = data.receipts || [];
      if (receipts.length === 0) {
        console.log('No receipts yet.');
        return;
      }
      formatOutput({
        columns: ['createdAt', 'kind', 'operationState', 'opId'],
        headers: ['When', 'Kind', 'State', 'Operation'],
        rows: receipts,
      }, { format: program.opts().output });
    });

  // ── reconcile ────────────────────────────────────────────────────────

  calendar
    .command('reconcile <opId>')
    .description("Resolve an 'attempted' or 'outcome_unknown' create against provider evidence (read-only — never creates/updates/deletes)")
    .action(async (opId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('calendarq.reconcile', { opId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      if (isJsonOutput(program)) return printJson(data);
      if (data.pending) {
        console.log(`Still unresolved: ${data.error}. Try again later${data.nextEligibleAt ? ` (not before ${new Date(data.nextEligibleAt).toISOString()})` : ''}.`);
        return;
      }
      printSuccess(`Reconciled ${opId}: ${data.outcome}${data.reason ? ` (${data.reason})` : ''}.`);
    });
}
