/**
 * QuoxHat commands (QUOXHAT #721 b): READ-ONLY views of the org's hats.
 *
 *   quox hat list
 *   quox hat show <id|key> [--rev <n>]
 *   quox hat reset <id|key> --yes      (audited reset-to-template)
 *
 * Shows what each hat presents (explicit tools, bundles, connector families),
 * its authorization mode, revision, template status and the org's enforcement
 * and selection mode. Editing hat definitions is deliberately NOT here: edits
 * go through the dashboard (Settings, QuoxHat Modes) where they are validated
 * and audited. The one write is `reset`, which returns an org-edited built-in
 * to its current template through the same audited route the dashboard uses.
 *
 * Backend: services/auth/routes/quoxhat.js (see cli/lib/api/endpoints/quoxhat.js).
 */

import chalk from 'chalk';
import { formatOutput, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/** Authorization mode a hat declares; no authz block means permissive (grant ceiling). */
export function authzMode(def) {
  const a = def && typeof def.authz === 'object' ? def.authz : null;
  if (!a) return 'permissive';
  return a.mode === 'restrictive' ? 'restrictive' : 'permissive (declared)';
}

/** "v9", "v8 (template v9 available)" or "custom". */
export function templateLabel(hat) {
  if (!hat.template_key) return 'custom';
  const cur = hat.template_version;
  const latest = hat.template_latest;
  // The latest revision's author (only on `show`, which carries history):
  // anything not 'template:*' means the org edited this built-in, which
  // freezes it out of automatic template upgrades until reset-to-template.
  const latestAuthor = Array.isArray(hat.revisions) && hat.revisions[0] ? hat.revisions[0].created_by : null;
  const customised = typeof latestAuthor === 'string' && !latestAuthor.startsWith('template:');
  if (latest && cur && cur < latest) return `v${cur} (template v${latest} available)`;
  return customised ? `v${cur || '?'} (edited)` : `v${cur || '?'}`;
}

function toolCounts(def) {
  const explicit = Array.isArray(def?.tools?.explicit) ? def.tools.explicit.length : 0;
  const bundles = Array.isArray(def?.tools?.bundles) ? def.tools.bundles : [];
  const bundled = bundles.reduce((n, b) => n + (Array.isArray(b?.tools) ? b.tools.length : 0), 0);
  return { explicit, bundles: bundles.length, bundled };
}

async function fetchList(client, orgId) {
  const ep = resolveEndpoint('hat.list', { orgId });
  return client.get(ep.path, { service: ep.service });
}

/** Resolve a hat argument (ULID or key) to its id using the org's hat list. */
export function findHat(hats, ref) {
  const r = String(ref || '').trim();
  return (hats || []).find(h => h.id === r) || (hats || []).find(h => h.key === r) || null;
}

export function registerHatCommands(program, ctx) {
  const { client, auth } = ctx;

  const hat = program
    .command('hat')
    .description('QuoxHat: read the org hats (tools, mode, revision, enforcement); reset a built-in to its template');

  // ── hat list ────────────────────────────────────────────────────────────────
  hat
    .command('list')
    .description('List the org hats with revision, template status, mode and tool counts')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await fetchList(client, orgId);
      const hats = Array.isArray(data?.hats) ? data.hats : [];
      const settings = data?.settings || {};
      const format = program.opts().output;

      if (format === 'json') {
        console.log(JSON.stringify({ hats, settings }, null, 2));
        return;
      }

      const rows = hats.map(h => {
        const c = toolCounts(h.definition);
        return {
          key: h.key + (settings.default_hat_id === h.id ? ' *' : ''),
          name: h.name,
          rev: String(h.current_revision),
          status: h.status,
          template: templateLabel(h),
          mode: authzMode(h.definition),
          privileged: h.definition?.transitions?.privileged ? 'yes' : 'no',
          tools: `${c.explicit} + ${c.bundled} in ${c.bundles} bundle(s)`,
          id: h.id,
        };
      });
      formatOutput({
        rows,
        columns: ['key', 'name', 'rev', 'status', 'template', 'mode', 'privileged', 'tools', 'id'],
        headers: ['Key', 'Name', 'Rev', 'Status', 'Template', 'Mode', 'Privileged', 'Tools (explicit + bundled)', 'ID'],
      }, { format, emptyMessage: 'No hats.' });
      printInfo(`Enforcement: ${settings.enforcement || 'preview'} · selection: ${settings.selection_mode || 'manual'}${settings.default_hat_id ? ' · * = org default' : ' · org default: built-in Default'}`);
    });

  // ── hat show ────────────────────────────────────────────────────────────────
  hat
    .command('show <hat>')
    .description('Show one hat (id or key): tools, bundles, mode, revision history, enforcement')
    .option('--rev <n>', 'show a historical revision instead of the current one')
    .action(async (ref, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      let rev;
      if (options.rev !== undefined) {
        rev = Number(options.rev);
        if (!Number.isInteger(rev) || rev < 1) throw new Error(`--rev must be a positive integer (got '${options.rev}')`);
      }

      const list = await fetchList(client, orgId);
      const found = findHat(list?.hats, ref);
      if (!found) {
        const keys = (list?.hats || []).map(h => h.key).join(', ') || 'none';
        throw new Error(`No hat '${ref}' in this org. Available: ${keys}`);
      }

      const ep = resolveEndpoint('hat.get', { orgId, hatId: found.id });
      const data = await client.get(ep.path, {
        service: ep.service,
        ...(rev ? { query: { revision: rev } } : {}),
      });
      const h = data?.hat;
      if (!h) throw new Error(`Hat '${ref}' not found`);
      const enforcement = data.enforcement || list?.settings?.enforcement || 'preview';

      if (program.opts().output === 'json') {
        console.log(JSON.stringify({ hat: h, enforcement, settings: list?.settings || null }, null, 2));
        return;
      }

      const def = h.definition || {};
      const shown = h.revision_shown || h.current_revision;
      const out = [];
      out.push(chalk.bold(`${h.name} (${h.key})`) + chalk.dim(`  ${h.id}`));
      if (h.purpose) out.push(h.purpose);
      out.push('');
      out.push(`Revision:     ${shown}${shown !== h.current_revision ? chalk.yellow(`  (historical; current is ${h.current_revision})`) : ' (current)'}`);
      out.push(`Digest:       ${h.digest || '-'}`);
      out.push(`Status:       ${h.status}`);
      out.push(`Template:     ${templateLabel(h)}`);
      out.push(`Mode:         ${authzMode(def)}`);
      out.push(`Enforcement:  ${enforcement} (org)`);
      out.push(`Transitions:  confirm=${def.transitions?.confirm || 'none'} privileged=${def.transitions?.privileged ? 'yes' : 'no'}`);
      out.push(`Agents:       orchestrator=${def.agents?.orchestrator || '-'} specialists=${(def.agents?.specialists || []).join(', ') || 'none'}`);
      out.push(`Budgets:      initial_tool_target=${def.budgets?.initial_tool_target ?? '-'} max_manifest=${def.budgets?.max_manifest ?? '-'}`);
      out.push('');
      const explicit = def.tools?.explicit || [];
      out.push(chalk.bold(`Explicit tools (${explicit.length}):`));
      out.push(`  ${explicit.join(', ') || 'none'}`);
      const bundles = def.tools?.bundles || [];
      out.push(chalk.bold(`Bundles (${bundles.length}, loaded per conversation with hat_load_bundle):`));
      for (const b of bundles) out.push(`  ${b.key}: ${(b.tools || []).join(', ')}`);
      if (!bundles.length) out.push('  none');
      const fams = def.tools?.connector_families || [];
      out.push(chalk.bold('Connector families:') + ` ${fams.join(', ') || 'none'}`);
      if (def.authz && typeof def.authz === 'object') {
        if (Array.isArray(def.authz.allow)) out.push(`Authz allow:  ${def.authz.allow.join(', ')}`);
        if (Array.isArray(def.authz.deny)) out.push(`Authz deny:   ${def.authz.deny.join(', ')}`);
      }
      const revisions = Array.isArray(h.revisions) ? h.revisions : [];
      if (revisions.length) {
        out.push('');
        out.push(chalk.bold('Revisions:'));
        for (const r of revisions) {
          out.push(`  ${String(r.revision).padStart(3)}  ${r.created_at || ''}  ${r.created_by || ''}  ${r.change_reason || ''}`);
        }
      }
      console.log(out.join('\n'));
    });

  // ── hat reset ───────────────────────────────────────────────────────────────
  hat
    .command('reset <hat>')
    .description('Reset an org-edited built-in hat to its current template (drops the org edits; audited)')
    .option('--yes', 'confirm: the org edits on this hat are replaced by the template')
    .action(async (ref, options) => {
      auth.requireAuth();
      if (!options.yes) throw new Error(`Resetting '${ref}' replaces its org edits with the template. Re-run with --yes to confirm.`);
      const orgId = resolveOrgId(auth, program);
      const list = await fetchList(client, orgId);
      const found = findHat(list?.hats, ref);
      if (!found) {
        const keys = (list?.hats || []).map(h => h.key).join(', ') || 'none';
        throw new Error(`No hat '${ref}' in this org. Available: ${keys}`);
      }
      const ep = resolveEndpoint('hat.reset', { orgId, hatId: found.id });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      const h = data?.hat;
      if (!h) throw new Error(`Reset of '${ref}' returned no hat`);
      if (program.opts().output === 'json') { console.log(JSON.stringify({ hat: h }, null, 2)); return; }
      console.log(`  Ⓠ QUOX │ hat ${h.key} reset to template │ rev ${h.current_revision} · ${templateLabel(h)} ✔`);
    });
}
