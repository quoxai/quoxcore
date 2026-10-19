/**
 * Monitoring commands: platform health and governance incidents.
 *
 * `quox status` (lib/commands/status.js) and `quox service health`
 * (lib/commands/service.js) already cover aggregate platform health and
 * per-service reachability — this group focuses on the gap: governance
 * incidents, which had no CLI surface at all.
 *
 * Endpoints wired (services/collector/server.js):
 *   GET /api/v1/health/aggregate     — same endpoint `quox status` uses
 *   GET /governance/incidents        — list
 *   GET /governance/incidents/:id    — detail + linked AEE envelopes
 */

import { formatOutput, formatDetail } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerMonitoringCommands(program, ctx) {
  const { client, auth } = ctx;

  const monitoring = program
    .command('monitoring')
    .description('Platform health and governance incidents');

  // GET /api/v1/health/aggregate — see `quox status` for the human-readable
  // pulse view; this subcommand exists for scripting/discoverability under
  // the monitoring namespace.
  monitoring
    .command('health')
    .description('Show aggregate platform health (services, fleet, sessions)')
    .action(async () => {
      // fleet #602: dropped noAuth: true, which suppressed the Authorization
      // header and 401'd on an authenticated collector (the same bug fixed in
      // `quox status`). Logged-out still works (client sends no header when
      // nothing is stored); logged-in now actually sends the token.
      const data = await client.get(resolveEndpoint('v1.health.aggregate.list').path, {
        service: resolveEndpoint('v1.health.aggregate.list').service,
        timeout: 15000, // #930: aggregate fan-out, 5s too tight under load
      });
      formatDetail(data, { format: program.opts().output, title: 'Platform Health' });
    });

  const incidents = monitoring
    .command('incidents')
    .description('Governance incidents');

  incidents
    .command('list')
    .description('List governance incidents')
    .option('--severity <severity>', 'filter by severity')
    .option('--status <status>', 'filter by status')
    .option('--type <type>', 'filter by incident type')
    .option('--agent <id>', 'filter by agent ID')
    .option('--corr <id>', 'filter by correlation ID')
    .option('--since <date>', 'start date (ISO)')
    .option('--until <date>', 'end date (ISO)')
    .option('--limit <n>', 'max results', '100')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.severity) query.severity = options.severity;
      if (options.status) query.status = options.status;
      if (options.type) query.incident_type = options.type;
      if (options.agent) query.agent_id = options.agent;
      if (options.corr) query.corr = options.corr;
      if (options.since) query.since = options.since;
      if (options.until) query.until = options.until;

      const data = await client.get(resolveEndpoint('governance.incidents.list').path, { service: resolveEndpoint('governance.incidents.list').service, query });
      formatOutput({
        columns: ['id', 'severity', 'status', 'incident_type', 'agent_id', 'created_at'],
        headers: ['ID', 'Severity', 'Status', 'Type', 'Agent', 'Created'],
        rows: data.data || data.incidents || data,
      }, { format: program.opts().output, emptyMessage: 'No incidents found.' });
    });

  incidents
    .command('get')
    .description('Show incident details and linked AEE envelopes')
    .argument('<id>', 'incident ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('governance.incidents.get', { id }).path, { service: resolveEndpoint('governance.incidents.get', { id }).service });
      formatDetail(data.incident || data, { format: program.opts().output, title: `Incident: ${id}` });
    });
}
