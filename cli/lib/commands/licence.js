/**
 * `quox licence` (alias `license`), GRIPE-715: governed, audited licence
 * operations from the terminal.
 *
 * Phase 1 (instance-local): status reads the lease (never the key), refresh
 * runs the renewal, seats lists/cleans band holders (dry run default).
 *
 * Phase 2 (owner-only vendor tooling for the quox.ai website) lives in
 * lib/vendor/licenceOwner.js and is registered only when that file is present.
 * lib/vendor/ is excluded from the npm package (quox#1134): the public build
 * never carries it.
 */

import { formatOutput, formatDetail, printSuccess, printInfo, printWarning } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxValidationError } from '../core/errors.js';

// quox#1134: the owner-only website verbs are vendor tooling, kept out of the published package (package.json
// "files" excludes lib/vendor/). Present in the dev tree, absent for every npm user.
let VENDOR_OWNER = null;
try {
  VENDOR_OWNER = await import('../vendor/licenceOwner.js');
} catch (e) {
  if (!(e?.code === 'ERR_MODULE_NOT_FOUND' && String(e?.message || '').includes('licenceOwner'))) throw e;
}

export function registerLicenceCommands(program, ctx, { owner = VENDOR_OWNER } = {}) {
  const { client, auth } = ctx;
  const fetchImpl = ctx.websiteFetch || globalThis.fetch;
  const json = () => program.opts().output === 'json';

  const licence = program
    .command('licence')
    .alias('license')
    .description('Instance licence status, lease refresh and seat bands')
    .action(() => { licence.help(); });
  if (owner) licence.addHelpText('after', owner.OWNER_HELP);

  licence
    .command('status')
    .description('Licence id, plan, lease timestamps, governed count, entitled list with seat usage')
    .option('--plugin <id>', 'limit to one plugin')
    .action(async (opts) => {
      auth.requireAuth();
      const ep = resolveEndpoint('setup.licensing.status');
      const d = await client.get(ep.path, { service: ep.service });
      const bands = d.org_bands || {};
      const pick = (id) => !opts.plugin || id === opts.plugin;
      const entitled = (d.entitlements || []).filter(pick).map((id) => {
        const b = bands[id];
        return { plugin: id, seats: b ? `${b.assigned_count}/${b.allowance}` : 'whole install' };
      });
      const out = {
        licenses: (d.licenses || []).map((l) => ({
          license_id: l.license_id,
          plans: l.plans || [],
          lease_issued_at: l.issued_at,
          lease_expires_at: l.lease_expires_at,
          licence_expires_at: l.expires_at,
        })),
        governed_count: Array.isArray(d.governed) ? d.governed.length : 0,
        org_id: d.org_id || null,
        entitled,
        entitlement_errors: d.entitlement_errors || [],
        renewal_health: d.renewal_health || null,
      };
      if (opts.plugin) out.governed = (d.governed || []).includes(opts.plugin);
      if (json()) { console.log(JSON.stringify(out, null, 2)); return; }
      formatDetail({
        licence_id: out.licenses.map((l) => l.license_id).join(', ') || '(none)',
        plan: out.licenses.flatMap((l) => l.plans).join(', ') || '(none)',
        lease_issued: out.licenses.map((l) => l.lease_issued_at || '?').join(', ') || '(none)',
        lease_expires: out.licenses.map((l) => l.lease_expires_at).join(', ') || '(none)',
        governed: String(out.governed_count),
        org_id: out.org_id || '(instance scoped)',
        entitlement_errors: out.entitlement_errors.length
          ? out.entitlement_errors.map((e) => (e.entitlement ? `${e.entitlement}: ${e.error}` : JSON.stringify(e))).join('; ')
          : '(none)',
      }, { title: 'Licence status' });
      formatOutput({
        columns: ['plugin', 'seats'],
        headers: ['Entitled plugin', 'Seats (used/cap)'],
        rows: entitled,
      }, { format: program.opts().output, emptyMessage: 'No entitlements.' });
    });

  licence
    .command('refresh')
    .description('Renew the licence lease now; prints old to new lease timestamps and entitlement diff')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('setup.licensing.refresh');
      const d = await client.post(ep.path, { service: ep.service, body: {} });
      if (json()) { console.log(JSON.stringify(d, null, 2)); return; }
      const byId = new Map((d.before || []).map((l) => [l.license_id, l]));
      for (const l of d.after || []) {
        const old = byId.get(l.license_id);
        printInfo(`${l.license_id}: lease expires ${old ? old.lease_expires_at : '(new)'} -> ${l.lease_expires_at}`);
      }
      for (const r of d.results || []) printInfo(`${r.license_id}: ${r.action}${r.reason ? ` (${r.reason})` : ''}`);
      const diff = d.entitlement_diff || { added: [], removed: [] };
      printInfo(`entitlements added: ${diff.added.join(', ') || '(none)'}`);
      printInfo(`entitlements removed: ${diff.removed.join(', ') || '(none)'}`);
      printSuccess('Lease refresh complete.');
    });

  licence
    .command('seats')
    .description('List a plugin band holders; --release-dead frees non-live holders (dry run unless --yes)')
    .argument('<pluginId>', 'plugin id, e.g. notesq')
    .option('--release-dead', 'release holders that are not live orgs (deleted orgs, user: ids)')
    .option('--yes', 'actually release (otherwise dry run)')
    .action(async (pluginId, opts) => {
      auth.requireAuth();
      const lep = resolveEndpoint('setup.licensing.seats.list', { pluginId });
      const list = await client.get(lep.path, { service: lep.service });
      let rel = null;
      if (opts.releaseDead) {
        const rep = resolveEndpoint('setup.licensing.seats.releaseDead', { pluginId });
        rel = await client.post(rep.path, { service: rep.service, body: { dry_run: !opts.yes } });
      }
      if (json()) { console.log(JSON.stringify({ ...list, release: rel }, null, 2)); return; }
      printInfo(`${pluginId}: ${list.holders.length} holder(s), cap ${list.allowance ?? '(no band)'}`);
      formatOutput({
        columns: ['id', 'name', 'status'],
        headers: ['Holder', 'Org name', 'Status'],
        rows: list.holders.map((h) => ({ id: h.id, name: h.name || '-', status: h.status })),
      }, { format: program.opts().output, emptyMessage: 'No holders.' });
      if (rel) {
        if (rel.dry_run) {
          printInfo(`DRY RUN: would release ${rel.dead.length} non-live holder(s): ${rel.dead.map((d) => d.id).join(', ') || '(none)'}. Re-run with --yes to release.`);
        } else {
          printSuccess(`Released ${rel.released.length} non-live holder(s): ${rel.released.join(', ') || '(none)'}`);
        }
      }
    });

  if (owner) owner.registerLicenceOwnerCommands(licence, { json, fetchImpl });
}
