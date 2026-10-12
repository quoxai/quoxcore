/**
 * `quox inventory` — the org's agent CMDB from the terminal (OPGOV quox#573).
 *
 * Org-wide rollup of the SAME grant graph `quox reach` evaluates per agent:
 * which agents exist (core roster + org-created), their declared model
 * routing, and per agent the granted tools / credentials / hosts / egress /
 * delegation counts plus the least-privilege unused-grant signal. The
 * collector computes it (GET /orgs/:orgId/inventory, witnessed as
 * quox.reach.inventory); this command only renders.
 *
 * Honesty: 'unknown' cells are real values, not absences — a registry or
 * layer that failed to enumerate says so, and `totals.complete` is only true
 * when NOTHING was unknown anywhere. A '?' in the table is a '?'.
 */

import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

function isJsonOutput(program) {
  const o = program.opts();
  return o.json === true || o.output === 'json';
}

function cell(v, width) {
  const s = v === 'unknown' ? '?' : String(v ?? '-');
  return s.padStart(width);
}

export function registerInventoryCommands(program, ctx) {
  const { client, auth } = ctx;

  program
    .command('inventory')
    .description("Org agent inventory (the agent CMDB): agents, models, tool/credential grants, delegation, unused-grant drift")
    .option('--days <n>', 'observed-usage window for the unused-grant column (default 30)')
    .option('--unused', 'ALSO compute the org-wide unused-grant pass (SLOW: minutes at org scale; for one agent use quox reach unused <agentId>)')
    .option('--drift', 'diff against the last stored snapshot and store this rollup as the new baseline (witnessed as quox.reach.inventory_drift)')
    .action(async (options) => {
      const orgId = resolveOrgId(auth, program);
      if (options.drift === true) {
        const dep = resolveEndpoint('reach.org.inventory.drift', { orgId });
        const result = await client.get(dep.path, { service: dep.service, timeout: 330000 });
        if (!result || result.schema !== 'inventory-drift.v1') {
          throw new Error(`unexpected response (schema ${result?.schema ?? 'missing'}, expected inventory-drift.v1): refusing to render. Check the collector URL points at a real collector.`);
        }
        if (isJsonOutput(program)) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (result.baseline) {
          process.stdout.write(`\u{1F4A5} REACH │ inventory drift │ baseline stored (snapshot #${result.snapshot_id}) · nothing to diff yet · re-run after the next change\n`);
          return;
        }
        const d = result.drift || {};
        const summary = d.changed
          ? `+${(d.agents_added || []).length} agents · −${(d.agents_removed || []).length} · ${(d.model_changes || []).length} model · ${(d.reach_changes || []).length} reach · ${(d.visibility_changes || []).length} visibility`
          : 'no change';
        const trust = d.prev_complete && d.curr_complete ? '' : ' · CAUTION: one side of the diff was INCOMPLETE';
        process.stdout.write(`\u{1F4A5} REACH │ inventory drift │ ${summary} · since ${result.prev_taken_at}${trust}\n`);
        for (const a of d.agents_added || []) process.stdout.write(`  + ${a.id} (${a.source}${a.model ? `, ${a.model}` : ''})\n`);
        for (const a of d.agents_removed || []) process.stdout.write(`  - ${a.id} (${a.source}${a.model ? `, ${a.model}` : ''})\n`);
        for (const m of d.model_changes || []) process.stdout.write(`  ~ ${m.id} model ${m.from ?? 'default'} → ${m.to ?? 'default'}\n`);
        for (const r of d.reach_changes || []) {
          const zones = ['tools', 'credentials', 'delegates'].filter((z) => r[z]).map((z) => `${z} ${r[z].from}→${r[z].to}`).join(', ');
          process.stdout.write(`  ~ ${r.id} ${zones}\n`);
        }
        for (const v of d.visibility_changes || []) process.stdout.write(`  ! ${v.id} ${v.from} → ${v.to}\n`);
        return;
      }
      const ep = resolveEndpoint('reach.org.inventory', {
        orgId,
        days: options.days,
        unused: options.unused === true,
      });
      // The first cold rollup resolves reach for every agent in the org and
      // can take minutes; the collector caches per-agent reach for 10 min so
      // re-runs are fast. 330s ceiling, not the default 30s.
      const result = await client.get(ep.path, { service: ep.service, timeout: 330000 });
      // A 200 with the wrong shape once rendered a confident empty table
      // ("? agents", "undefined unknown") from a non-collector endpoint. A
      // response that is not inventory.v1 is an error, never a rollup.
      if (!result || result.schema !== 'inventory.v1') {
        throw new Error(`unexpected response (schema ${result?.schema ?? 'missing'}, expected inventory.v1): refusing to render. Check the collector URL points at a real collector.`);
      }

      if (isJsonOutput(program)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      const t = result.totals || {};
      const completeness = t.complete ? 'complete' : `INCOMPLETE (${t.agents_reach_unknown} agent(s) unknown, ${(result.unknowns || []).length} registry gap(s))`;
      process.stdout.write(
        `\u{1F4A5} REACH │ inventory │ ${t.agents ?? '?'} agents · ${t.tool_grants ?? '?'} tool grants · ${t.credential_grants ?? '?'} cred grants · ${completeness} · ${result.duration_ms ?? '?'}ms\n\n`
      );

      const header = `${'agent'.padEnd(22)}${'src'.padEnd(6)}${'model'.padEnd(18)}${cell('tools', 6)}${cell('creds', 6)}${cell('hosts', 6)}${cell('deleg', 6)}${cell('unused', 7)}  badge`;
      process.stdout.write(`${header}\n${'─'.repeat(header.length)}\n`);
      for (const a of result.agents || []) {
        const r = a.reach;
        const row = r === 'unknown'
          ? `${a.id.padEnd(22)}${(a.source || '?').padEnd(6)}${(a.model || 'default').padEnd(18)}${cell('unknown', 6)}${cell('?', 6)}${cell('?', 6)}${cell('?', 6)}${cell('?', 7)}  reach failed: ${a.reach_error || '?'}`
          : `${a.id.padEnd(22)}${(a.source || '?').padEnd(6)}${(a.model || 'default').padEnd(18)}${cell(r.tools, 6)}${cell(r.credentials, 6)}${cell(r.hosts, 6)}${cell(r.delegates, 6)}${cell(a.unused_grants ?? '-', 7)}  ${r.badge?.level || '-'}${(r.unknown_zones || []).length ? ` (?: ${r.unknown_zones.join(',')})` : ''}`;
        process.stdout.write(`${row}\n`);
      }

      if ((result.unknowns || []).length) {
        process.stdout.write('\nregistry gaps (first-class UNKNOWN, not zero):\n');
        for (const u of result.unknowns) process.stdout.write(`  · [${u.source}] ${u.statement}\n`);
      }
      process.stdout.write(`\nunused-grant window: ${result.unused_window_days ?? 'skipped'} days · '?' = source did not enumerate · witnessed as quox.reach.inventory\n`);
    });
}

export default registerInventoryCommands;
