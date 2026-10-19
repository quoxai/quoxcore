/**
 * `quox mind implants|implant <id>|health`: QuoxMind cognitive implants (read-only).
 * Collector routes under /api/v1/mind (org-scoped). Implants with no recorded
 * activity say so; nothing is invented.
 */
import { formatOutput } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

export function registerMindCommands(program, ctx) {
  const { client, auth } = ctx;
  const get = async (name, params) => {
    auth.requireAuth();
    const ep = resolveEndpoint(name, params);
    return client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
  };
  const isJson = () => program.opts().output === 'json';

  const mind = program.command('mind').description('QuoxMind: the cognitive implants (read-only)');

  mind
    .command('implants')
    .description('List the cognitive implants: purpose, status, last activity')
    .action(async () => {
      const data = await get('mind.implants');
      const rows = data.implants || [];
      formatOutput(rows.map((i) => ({
        ID: i.short,
        NAME: i.name,
        PURPOSE: i.purpose,
        STATUS: i.status,
        'LAST ACTIVITY': i.last_activity || 'no activity recorded',
        // QUOXMIND-PROOF: firing evidence from the implant's own table (null = not tracked).
        'LAST FIRED': i.activity_error ? 'unknown' : (typeof i.fired_7d === 'number' ? (i.last_fired || 'never') : 'not tracked'),
        '7D': typeof i.fired_7d === 'number' && !i.activity_error ? i.fired_7d : '-',
      })), {
        format: program.opts().output,
        columns: ['ID', 'NAME', 'STATUS', 'LAST FIRED', '7D', 'PURPOSE'],
        emptyMessage: 'No implants registered.',
        raw: rows,
      });
    });

  mind
    .command('implant <id>')
    .description('One implant in detail (e.g. predict, reflect, repobrain, qortex)')
    .action(async (id) => {
      const d = await get('mind.implant', { id });
      if (isJson()) { console.log(JSON.stringify(d, null, 2)); return; }
      console.log(`${d.name} (${d.short}) · ${d.status}${d.tier ? ` · ${d.tier}` : ''}`);
      console.log(d.description || d.purpose);
      if (d.inspired_by) console.log(`Inspired by: ${d.inspired_by}`);
      if (d.summary) console.log(`Now: ${d.summary}`);
      console.log(d.activity);
      if (typeof d.fired_7d === 'number' && !d.activity_error) console.log(`Fired: ${d.last_fired || 'never'} · ${d.fired_7d} in the last 7 days${d.activity_source ? ` (from ${d.activity_source})` : ''}`);
      else if (d.activity_error) console.log(`Fired: unknown (${d.activity_error})`);
      for (const [k, v] of Object.entries(d.metrics || {})) if (v !== null && typeof v !== 'object') console.log(`  ${k}: ${v}`);
    });

  mind
    .command('health')
    .description('Summary of QuoxMind health across all implants')
    .action(async () => {
      const d = await get('mind.health');
      if (isJson()) { console.log(JSON.stringify(d, null, 2)); return; }
      console.log(`${d.total} implants: ${Object.entries(d.by_status).map(([k, v]) => `${v} ${k}`).join(', ')}`);
      console.log(`${d.with_activity} with recorded activity, ${d.no_activity} with no activity recorded`);
      if (typeof d.fired_7d_total === 'number') console.log(`Last 7 days: ${d.fired_7d_implants} implants fired (${d.fired_7d_total} firings), ${d.silent_7d} silent, ${d.activity_unknown} not tracked`);
      console.log(d.average_health === null ? 'Average health: not enough data' : `Average health: ${d.average_health} (over ${d.scored} scored)`);
    });
}
