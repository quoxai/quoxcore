/**
 * QuoxHat commands (QUOXHAT #721 b; CUSTOM-HATS 2026-10-17).
 *
 *   quox hat list
 *   quox hat show <id|key> [--rev <n>]
 *   quox hat reset <id|key> --yes      (audited reset-to-template, built-ins)
 *   quox hat create <key> --name "<Name>" [--from <hat>] [--agents a,b] [--tools x,y] [--mode m] [--offer o]
 *   quox hat edit <hat> [--name N] [--add-agents|--remove-agents|--agents] [--add-tools|--remove-tools|--tools] [--mode m]
 *   quox hat delete <hat> --yes        (custom hats only)
 *   quox hat use <hat> --conversation <id> [--yes]
 *
 * Custom hats (owner 2026-10-17): users who build their own agents organise them under their own
 * hats, so a turn under "security" carries only the security agents, not every agent in the org.
 * create/edit/delete act on CUSTOM hats only; a built-in is reset to its template, or copied with --from.
 * Everything is server-side, org-scoped, revisioned and audited (services/auth/routes/quoxhat.js);
 * who may create or change an org hat is the existing hat-edit permission (org manage-settings),
 * a private hat (--private) only its owner. This file never decides permission itself.
 *
 * Backend: services/auth/routes/quoxhat.js (see cli/lib/api/endpoints/hat.js).
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


export { DELEGATION_TOOLS, HAT_MODES, HAT_OFFERS, parseList, memberTools, applyMode, buildCustomDefinition, applyHatEdits } from '../core/customHats.js';
import { parseList, memberTools, buildCustomDefinition, applyHatEdits } from '../core/customHats.js';

/** Which of `ids` no registered or org agent matches. checked=false when neither list could be read. */
export async function findUnknownAgents(client, orgId, ids) {
  if (!ids.length) return { unknown: [], checked: true };
  const known = new Set();
  let read = 0;
  try {
    const ep = resolveEndpoint('v1.agents.registry');
    const d = await client.get(ep.path, { service: ep.service });
    if (Array.isArray(d?.agents)) { read++; for (const a of d.agents) if (a?.agent_id) known.add(String(a.agent_id).toLowerCase()); }
  } catch { /* named below */ }
  try {
    const ep = resolveEndpoint('agents.list', { orgId });
    const d = await client.get(ep.path, { service: ep.service });
    const rows = Array.isArray(d?.agents) ? d.agents : (Array.isArray(d) ? d : null);
    if (rows) { read++; for (const a of rows) { const id = a?.agent_id || a?.agentId; if (id) known.add(String(id).toLowerCase()); } }
  } catch { /* named below */ }
  if (!read) return { unknown: [], checked: false };
  return { unknown: ids.filter(id => !known.has(id)), checked: true };
}

function isBuiltin(h) { return !!h?.template_key; }

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
      out.push(`Offer:        ${def.tools?.offer === 'members' ? 'members (an orchestrator turn is offered only this hat\'s tools)' : 'authorized (hat tools first, then the rest of the grant)'}`);
      out.push(`Kind:         ${h.template_key ? 'built-in' : 'custom'}${h.visibility === 'private' ? ' (private)' : ''}`);
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
  // ── hat create (custom) ───────────────────────────────────────────────────────
  hat
    .command('create <key>')
    .description('Create a custom hat: the agents and tools it lists are the only ones a turn under it carries')
    .requiredOption('--name <name>', 'display name, e.g. "Security"')
    .option('--from <hat>', 'start from a copy of this hat (key or id)')
    .option('--agents <ids>', 'comma-separated agent ids this hat puts in scope (registered or your own agents)')
    .option('--tools <names>', 'comma-separated tool names the orchestrator is offered under this hat')
    .option('--mode <mode>', 'permissive (default: each agent keeps its own grant) or restrictive (only the listed tools are authorized, for every agent under the hat)')
    .option('--offer <offer>', 'members (default: offer only this hat\'s tools) or authorized')
    .option('--purpose <text>', 'one line: what this hat is for')
    .option('--private', 'a private hat only you can see and wear (needs no org settings permission)')
    .option('--reason <text>', 'why (kept in the revision history)')
    .action(async (key, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const k = String(key || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(k)) throw new Error(`Hat key '${key}' must be a lowercase slug (a-z, 0-9, hyphen), 2-41 characters.`);
      const list = await fetchList(client, orgId);
      const hats = list?.hats || [];
      if (findHat(hats, k)) throw new Error(`A hat with key '${k}' already exists in this org. Use quox hat edit ${k}.`);
      let base = null;
      if (options.from) {
        const from = findHat(hats, options.from);
        if (!from) throw new Error(`No hat '${options.from}' to copy. Available: ${hats.map(h => h.key).join(', ') || 'none'}`);
        base = from.definition;
      }
      const agents = options.agents !== undefined ? parseList(options.agents) : undefined;
      const tools = options.tools !== undefined ? parseList(options.tools) : undefined;
      const { definition, autoAdded } = buildCustomDefinition({ base, name: options.name, purpose: options.purpose, agents, tools, mode: options.mode, offer: options.offer });
      const named = definition.agents.specialists;
      const check = await findUnknownAgents(client, orgId, named);
      if (check.unknown.length) throw new Error(`Unknown agent(s): ${check.unknown.join(', ')}. See quox agent list.`);
      const ep = resolveEndpoint('hat.create', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body: { key: k, name: String(options.name).trim(), definition, visibility: options.private ? 'private' : 'org' } });
      const h = data?.hat;
      if (!h) throw new Error(`Create of '${k}' returned no hat`);
      if (program.opts().output === 'json') { console.log(JSON.stringify({ hat: h, warnings: data.warnings || [], auto_added_tools: autoAdded }, null, 2)); return; }
      const d = h.definition || definition;
      console.log(`  Ⓠ QUOX │ hat ${h.key} created │ rev ${h.current_revision} · agents ${(d.agents?.specialists || []).join(', ') || 'none'} · ${memberTools(d).length} tool(s) · offer ${d.tools?.offer || 'authorized'} · ${authzMode(d)} ✔`);
      if (autoAdded.length) printInfo(`Added ${autoAdded.join(', ')} so the orchestrator can reach the hat's agents.`);
      if (!check.checked) printInfo('Agent ids were not checked: the agent lists could not be read.');
      if (d.authz?.mode === 'restrictive') printInfo('Restrictive: every agent working under this hat, its own agents included when delegated to, may only run the tools listed here.');
      for (const w of data.warnings || []) printInfo(`warning: ${w}`);
      printInfo(`Wear it: /hat ${h.key} in quox, or quox hat use ${h.key} --conversation <id>.`);
    });

  // ── hat edit (custom) ─────────────────────────────────────────────────────────
  hat
    .command('edit <hat>')
    .description('Change a custom hat: add or remove agents and tools, rename, mode (appends an audited revision)')
    .option('--name <name>', 'rename the hat')
    .option('--purpose <text>', 'new one-line purpose')
    .option('--agents <ids>', 'replace the agent list')
    .option('--add-agents <ids>', 'comma-separated agents to add')
    .option('--remove-agents <ids>', 'comma-separated agents to remove')
    .option('--tools <names>', 'replace the explicit tool list')
    .option('--add-tools <names>', 'comma-separated tools to add')
    .option('--remove-tools <names>', 'comma-separated tools to remove')
    .option('--mode <mode>', 'permissive or restrictive')
    .option('--offer <offer>', 'members or authorized')
    .option('--reason <text>', 'why (kept in the revision history)')
    .action(async (ref, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const list = await fetchList(client, orgId);
      const found = findHat(list?.hats, ref);
      if (!found) throw new Error(`No hat '${ref}' in this org. Available: ${(list?.hats || []).map(h => h.key).join(', ') || 'none'}`);
      if (isBuiltin(found)) throw new Error(`'${found.key}' is a built-in hat: quox hat edit changes custom hats only. Reset it with quox hat reset ${found.key} --yes, or make your own from it: quox hat create <key> --name "<Name>" --from ${found.key}.`);
      const opts = {
        agents: options.agents !== undefined ? parseList(options.agents) : undefined,
        addAgents: parseList(options.addAgents),
        removeAgents: parseList(options.removeAgents),
        tools: options.tools !== undefined ? parseList(options.tools) : undefined,
        addTools: parseList(options.addTools),
        removeTools: parseList(options.removeTools),
        mode: options.mode,
        offer: options.offer,
        purpose: options.purpose,
      };
      const { definition, changes } = applyHatEdits(found.definition, opts);
      const rename = options.name !== undefined && String(options.name).trim() !== found.name ? String(options.name).trim() : undefined;
      if (rename !== undefined) changes.unshift(`name "${found.name}" -> "${rename}"`);
      if (!changes.length) throw new Error(`Nothing to change on '${found.key}'.`);
      const newAgents = [...(opts.agents || []), ...opts.addAgents];
      const check = await findUnknownAgents(client, orgId, newAgents);
      if (check.unknown.length) throw new Error(`Unknown agent(s): ${check.unknown.join(', ')}. See quox agent list.`);
      const ep = resolveEndpoint('hat.update', { orgId, hatId: found.id });
      const data = await client.put(ep.path, { service: ep.service, body: { definition, ...(rename !== undefined ? { name: rename } : {}), change_reason: options.reason || changes.join('; ') } });
      const h = data?.hat;
      if (!h) throw new Error(`Edit of '${found.key}' returned no hat`);
      if (program.opts().output === 'json') { console.log(JSON.stringify({ hat: h, changes, warnings: data.warnings || [] }, null, 2)); return; }
      console.log(`  Ⓠ QUOX │ hat ${h.key} edited │ rev ${h.current_revision} · ${changes.join(' · ')} ✔`);
      for (const w of data.warnings || []) printInfo(`warning: ${w}`);
    });

  // ── hat delete (custom) ───────────────────────────────────────────────────────
  hat
    .command('delete <hat>')
    .description('Delete a custom hat (built-ins cannot be deleted; reset them instead). Audited.')
    .option('--yes', 'confirm: conversations wearing it fall back to the default hat')
    .action(async (ref, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const list = await fetchList(client, orgId);
      const found = findHat(list?.hats, ref);
      if (!found) throw new Error(`No hat '${ref}' in this org. Available: ${(list?.hats || []).map(h => h.key).join(', ') || 'none'}`);
      if (isBuiltin(found)) throw new Error(`'${found.key}' is a built-in hat and cannot be deleted. quox hat reset ${found.key} --yes returns it to its template.`);
      if (!options.yes) throw new Error(`Deleting '${found.key}' moves every conversation wearing it back to the default hat. Re-run with --yes to confirm.`);
      const ep = resolveEndpoint('hat.delete', { orgId, hatId: found.id });
      const data = await client.delete(ep.path, { service: ep.service });
      const d = data?.deleted;
      if (!d) throw new Error(`Delete of '${found.key}' returned no confirmation`);
      if (program.opts().output === 'json') { console.log(JSON.stringify({ deleted: d }, null, 2)); return; }
      console.log(`  Ⓠ QUOX │ hat ${d.key} deleted │ was rev ${d.revision} · ${d.bindings_cleared} conversation(s) moved to the default · ${d.user_prefs_cleared} preference(s) cleared ✔`);
    });

  // ── hat use ───────────────────────────────────────────────────────────────────
  hat
    .command('use <hat>')
    .description('Wear a hat in one conversation (the same audited switch as /hat <name> in quox)')
    .requiredOption('--conversation <id>', 'the conversation to switch')
    .option('--yes', 'confirm a privileged hat')
    .action(async (ref, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const list = await fetchList(client, orgId);
      const found = findHat(list?.hats, ref);
      if (!found) throw new Error(`No hat '${ref}' in this org. Available: ${(list?.hats || []).map(h => h.key).join(', ') || 'none'}`);
      if (found.definition?.transitions?.privileged && !options.yes) throw new Error(`'${found.key}' is a privileged hat. Re-run with --yes to wear it.`);
      const ep = resolveEndpoint('hat.bind', { orgId, conversationId: options.conversation });
      const data = await client.put(ep.path, { service: ep.service, body: { hat_id: found.id } });
      const b = data?.binding;
      if (!b) throw new Error(`Switch to '${found.key}' returned no binding`);
      if (program.opts().output === 'json') { console.log(JSON.stringify({ binding: b, hat: { id: found.id, key: found.key } }, null, 2)); return; }
      console.log(`  Ⓠ QUOX │ conversation ${options.conversation} now wears ${found.key} │ rev ${b.revision} · seq ${b.seq} ✔`);
    });
}
