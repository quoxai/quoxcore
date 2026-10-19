/**
 * `quox reach` — an agent's governed blast radius from the terminal
 * (BLAST-RADIUS-P2).
 *
 * Every call goes through the collector's governed route (GET
 * /orgs/:orgId/agents/:agentId/reach), which is the same evaluation the
 * approval gate and the reach_agent agent tool trigger — one runtime
 * (services/collector/lib/reach/runtime.js), witnessed the same way
 * regardless of door. This command doesn't catch API errors itself: they
 * propagate to bin/quox.js's global handleError(), which already prints the
 * real status + the server's own message rather than rendering an error
 * body as data (see lib/core/errors.js).
 */

import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

/** Top N display names for a `may.<source>` items array (credentials/hosts). */
function topNames(items, n = 3) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, n).map((it) => (it && (it.name || it.id)) || 'unknown');
}

/**
 * Reads the GLOBAL --json flag (program.opts().json, mapped to output=json
 * by bin/quox.js's preAction hook) rather than redefining a local --json
 * option on this subcommand: a subcommand-local option of the same name as
 * a parent's silently shadows the parent's value (commander quirk), so
 * `isJsonOutput` is the same pattern lib/commands/plan.js already uses.
 */
function isJsonOutput(program) {
  const opts = program.opts();
  return opts.output === 'json' || opts.json === true;
}

export function registerReachCommands(program, ctx) {
  const { client, auth } = ctx;

  const r = program
    .command('reach')
    .description("An agent's governed blast radius: what it may touch, may not, and what cannot be statically known");

  r.command('agent <agentId>')
    .description('Compute an agent\'s reach: tools, credentials, hosts, egress origins, delegation')
    .action(async (agentId) => {
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('reach.agent.get', { orgId, agentId });
      const result = await client.get(ep.path, { service: ep.service });

      if (isJsonOutput(program)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      const sources = result.sources || {};
      const may = result.may || {};
      const badge = result.badge || { level: 'R0', working: [] };
      const t = sources.tools?.count ?? 0;
      const c = sources.credentials?.count ?? 0;
      const h = sources.hosts?.count ?? 0;
      const e = sources.egress?.count ?? 0;
      const ms = result.duration_ms ?? 0;

      // House QuoxGlyph grammar, exact separators (U+2502).
      process.stdout.write(
        `\u{1F4A5} REACH │ agent ${agentId} │ ${badge.level} · ${t} tools ${c} creds ${h} hosts ${e} origins · ${ms}ms\n`
      );

      if (badge.working?.length) {
        process.stdout.write('\nbadge working:\n');
        for (const w of badge.working) process.stdout.write(`  · ${w}\n`);
      }

      process.stdout.write('\nmay:\n');
      process.stdout.write(`  tools:       ${t}${sources.tools?.ok === false ? '  (source failed)' : ''}\n`);
      const credNames = topNames(may.credentials);
      process.stdout.write(`  credentials: ${c}${sources.credentials?.ok === false ? '  (source failed)' : ''}${credNames.length ? `  top: ${credNames.join(', ')}` : ''}\n`);
      const hostNames = topNames(may.hosts);
      process.stdout.write(`  hosts:       ${h}${sources.hosts?.ok === false ? '  (source failed)' : ''}${hostNames.length ? `  top: ${hostNames.join(', ')}` : ''}\n`);
      process.stdout.write(`  origins:     ${e}${sources.egress?.ok === false ? '  (source failed)' : ''}\n`);
      const delegateCount = may.delegates?.direct?.length ?? sources.delegation?.count ?? 0;
      process.stdout.write(`  delegates:   ${delegateCount}${sources.delegation?.ok === false ? '  (source failed)' : ''}\n`);

      if (result.cannot?.length) {
        process.stdout.write('\ncannot:\n');
        for (const item of result.cannot) process.stdout.write(`  × ${item.statement}\n`);
      }

      if (result.unknown?.length) {
        process.stdout.write('\nunknown:\n');
        for (const item of result.unknown) process.stdout.write(`  ? [${item.zone}] ${item.statement}\n`);
      }
    });

  // BLAST-RADIUS-P4: predicted-vs-actual least-privilege report. Every
  // layer prints its coverage FIRST — 'not-observed' layers (hosts, egress,
  // delegates today) are never rendered as "unused", and never carry a
  // recommendation. See lib/reach/leastPrivilege.js's HONESTY CONTRACT.
  r.command('unused <agentId>')
    .description('Predicted-vs-actual least-privilege report: which granted tools/credentials show zero observed use')
    .option('--days <n>', 'trailing window in days', '30')
    .action(async (agentId, options) => {
      const orgId = resolveOrgId(auth, program);
      const days = parseInt(options.days, 10) || 30;
      const ep = resolveEndpoint('reach.agent.leastPrivilege', { orgId, agentId, days });
      // #923: the report scans the usage window and outlived the 30 s default under load
      const result = await client.get(ep.path, { service: ep.service, timeout: 120000 });

      if (isJsonOutput(program)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      const layers = result.layers || {};
      const tools = layers.tools || {};
      const creds = layers.credentials || {};
      const ms = result.duration_ms ?? 0;

      // House QuoxGlyph grammar, exact separators (U+2502).
      process.stdout.write(
        `\u{1F4A5} REACH │ unused ${agentId} ${result.window_days ?? days}d │ tools ${tools.used ?? 0}/${tools.predicted ?? 0} used · creds ${creds.used ?? 0}/${creds.predicted ?? 0} · ${ms}ms\n`
      );

      if (result.note) {
        process.stdout.write(`\n⚠ ${result.note}\n`);
      }

      const layerOrder = ['tools', 'credentials', 'hosts', 'egress', 'delegates'];
      for (const name of layerOrder) {
        const layer = layers[name];
        if (!layer) continue;
        process.stdout.write(`\n${name}:\n`);
        process.stdout.write(`  coverage: ${layer.coverage}\n`);
        if (layer.reason) process.stdout.write(`  reason:   ${layer.reason}\n`);
        if (Array.isArray(layer.gaps) && layer.gaps.length) {
          for (const gap of layer.gaps) process.stdout.write(`  gap:      ${gap}\n`);
        }
        if (typeof layer.predicted === 'number') process.stdout.write(`  predicted: ${layer.predicted}\n`);
        if (typeof layer.used === 'number') process.stdout.write(`  used:      ${layer.used}\n`);
        if (Array.isArray(layer.unused_list) && layer.unused_list.length) {
          process.stdout.write(`  unused:    ${layer.unused_list.join(', ')}\n`);
        }
      }

      if (result.recommendations?.length) {
        process.stdout.write('\nrecommendations:\n');
        for (const rec of result.recommendations) {
          process.stdout.write(`  · [${rec.layer}] ${rec.statement}\n`);
          process.stdout.write(`      edit: ${rec.edit}\n`);
        }
      } else {
        process.stdout.write('\nrecommendations: none\n');
      }
    });

  return r;
}

export default registerReachCommands;
