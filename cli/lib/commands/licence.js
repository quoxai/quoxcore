/**
 * `quox licence` (alias `license`), GRIPE-715: governed, audited licence
 * operations from the terminal.
 *
 * Phase 1 (instance-local): status reads the lease (never the key), refresh
 * runs the renewal, seats lists/cleans band holders (dry run default).
 *
 * Phase 2 (owner-only, talks to the quox.ai WEBSITE admin API with a separate
 * website session, see core/websiteSession.js): reissue re-bands/extends a
 * licence record, catalogue-sign re-signs the product catalogue. Both are DRY
 * RUN unless --apply. The signing key never leaves the website VM; the CLI
 * never sees, prints or sends key material or licence keys.
 */

import { writeFileSync } from 'node:fs';
import { formatOutput, formatDetail, printSuccess, printInfo, printWarning } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxValidationError } from '../core/errors.js';
import {
  DEFAULT_WEBSITE_URL, DEFAULT_WEBSITE_PROFILE, normaliseWebsiteUrl, websiteLogin, websitePost,
  saveWebsiteSession, clearWebsiteSession, getWebsiteSession,
} from '../core/websiteSession.js';

const OWNER_HELP = `
Owner-only (website admin session, dry run unless --apply):
  website-login       log in to the quox.ai admin API once (password is not stored)
  reissue <licenseId> band bare paid ids / add ids, re-signed on the website VM
  catalogue-sign      re-sign the product catalogue with the live key
See the quox-licensing skill (~/.claude/skills/quox-licensing/SKILL.md).
`;

const ID_LIST_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseIdList(value, flag) {
  if (value === undefined) return undefined;
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!ID_LIST_RE.test(id)) throw new QuoxValidationError(`${flag}: invalid plugin id "${id}"`);
  }
  return ids;
}

export function parseOrgs(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new QuoxValidationError('--orgs must be an integer between 1 and 1000');
  return n;
}

function list(arr) {
  return arr && arr.length ? arr.join(', ') : '(none)';
}

export function registerLicenceCommands(program, ctx) {
  const { client, auth } = ctx;
  const fetchImpl = ctx.websiteFetch || globalThis.fetch;
  const json = () => program.opts().output === 'json';

  const licence = program
    .command('licence')
    .alias('license')
    .description('Instance licence status, lease refresh and seat bands')
    .addHelpText('after', OWNER_HELP)
    .action(() => { licence.help(); });

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

  // ---------------- Phase 2: owner-only, website admin API ----------------

  licence
    .command('website-login')
    .description('Log in to the quox.ai website admin API for reissue/catalogue-sign (stores the session cookie only, 0600)')
    .option('--website-profile <name>', 'website session profile', DEFAULT_WEBSITE_PROFILE)
    .option('--url <url>', 'website base URL', DEFAULT_WEBSITE_URL)
    .option('--username <name>', 'website admin username')
    .option('--password-stdin', 'read the password from stdin (one line) instead of prompting')
    .action(async (opts) => {
      normaliseWebsiteUrl(opts.url); // refuse a bad or plain-http URL before asking for a password
      let { username } = opts;
      let password;
      if (opts.passwordStdin) {
        const chunks = [];
        for await (const c of process.stdin) chunks.push(Buffer.from(c));
        password = Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
      }
      if (!username || !password) {
        const { default: inquirer } = await import('inquirer');
        if (!username) username = (await inquirer.prompt([{ type: 'input', name: 'u', message: 'Website admin username:' }])).u;
        if (!password) password = (await inquirer.prompt([{ type: 'password', name: 'p', message: 'Password:', mask: '*' }])).p;
      }
      if (!username || !password) throw new QuoxValidationError('username and password are required');
      const session = await websiteLogin({ url: opts.url, username, password, fetchImpl });
      password = null;
      saveWebsiteSession(opts.websiteProfile, session);
      if (json()) { console.log(JSON.stringify({ profile: opts.websiteProfile, url: session.url, username: session.username, must_change_password: session.must_change_password }, null, 2)); return; }
      printSuccess(`Website session saved for ${session.username} at ${session.url} (profile ${opts.websiteProfile}, valid ~24h). Password not stored.`);
      if (session.must_change_password) printWarning('This admin must change their password on the website before licence operations will be allowed (HTTP 403 until then).');
    });

  licence
    .command('website-logout')
    .description('End the website admin session and delete the stored cookie')
    .option('--website-profile <name>', 'website session profile', DEFAULT_WEBSITE_PROFILE)
    .action(async (opts) => {
      if (getWebsiteSession(opts.websiteProfile)) {
        try { await websitePost(opts.websiteProfile, '/api/admin/logout', {}, { fetchImpl }); } catch { /* session may already be dead */ }
      }
      const had = clearWebsiteSession(opts.websiteProfile);
      printSuccess(had ? `Website session ${opts.websiteProfile} removed.` : `No website session ${opts.websiteProfile} was stored.`);
    });

  licence
    .command('reissue')
    .description('Owner-only: band bare paid ids and add ids on a licence record, re-signed on the website (dry run unless --apply)')
    .argument('<licenseId>', 'licence id, e.g. lic_abc123')
    .option('--orgs <n>', 'org band for every banded/added id (default 10)')
    .option('--add <ids>', 'comma-separated ids to ADD as <id>@orgs=N')
    .option('--band <ids>', 'comma-separated ids already present to FORCE-band')
    .option('--apply', 'actually reissue (otherwise dry run, nothing changes)')
    .option('--website-profile <name>', 'website session profile', DEFAULT_WEBSITE_PROFILE)
    .action(async (licenseId, opts) => {
      const body = { dryRun: !opts.apply };
      const orgs = parseOrgs(opts.orgs);
      if (orgs !== undefined) body.orgs = orgs;
      const add = parseIdList(opts.add, '--add');
      if (add) body.add = add;
      const band = parseIdList(opts.band, '--band');
      if (band) body.band = band;

      const d = await websitePost(opts.websiteProfile, `/api/admin/licenses/${encodeURIComponent(licenseId)}/reissue`, body, { fetchImpl });
      if (json()) { console.log(JSON.stringify(d, null, 2)); return; }

      printInfo(`Licence ${d.license_id}${d.customer_email ? ` (${d.customer_email})` : ''}: max_servers ${d.max_servers ?? '?'}, expires ${d.expires_at || 'never'}`);
      const removed = new Set(d.diff?.removed || []);
      const added = new Set(d.diff?.added || []);
      for (const e of d.current || []) console.log(`  ${removed.has(e) ? '-' : ' '} ${e}`);
      for (const e of d.next || []) if (added.has(e)) console.log(`  + ${e}`);
      if (d.unknown_ids?.length) printWarning(`Not issuable (unknown to the signed catalogue), apply will be refused: ${d.unknown_ids.join(', ')}`);

      if (!d.changed) { printSuccess('No change needed: the licence already has these entitlements.'); return; }
      if (d.dry_run) { printInfo('DRY RUN: nothing changed. Re-run with --apply to reissue.'); return; }
      printSuccess(`Reissued ${d.license_id}. Audit/backup id: ${d.backup_id}`);
      printInfo('Instances pick this up on their next lease renewal (~6h). To pull it now, on the instance: quox licence refresh');
    });

  licence
    .command('catalogue-sign')
    .alias('catalog-sign')
    .description('Owner-only: re-sign the product catalogue with the live key on the website (dry run unless --apply)')
    .option('--apply', 'actually sign and publish to the website API (otherwise dry run)')
    .option('--out <path>', 'after --apply, save the signed catalogue (public artifact) here for committing')
    .option('--website-profile <name>', 'website session profile', DEFAULT_WEBSITE_PROFILE)
    .action(async (opts) => {
      if (opts.out && !opts.apply) throw new QuoxValidationError('--out is only meaningful with --apply');
      const d = await websitePost(opts.websiteProfile, '/api/admin/catalog/sign', { dryRun: !opts.apply }, { fetchImpl });
      if (opts.out && d.artifact) writeFileSync(opts.out, JSON.stringify(d.artifact, null, 2) + '\n', 'utf8');
      if (json()) {
        const { artifact, ...rest } = d;
        console.log(JSON.stringify({ ...rest, artifact_saved_to: opts.out && artifact ? opts.out : null }, null, 2));
        return;
      }
      const p = d.published || {};
      formatDetail({
        published: p.exists ? `${p.verified ? 'verified' : 'NOT VERIFIED'}, sha256 ${p.sha256 ? p.sha256.slice(0, 16) : '?'}..., ${p.generated_at || '?'}` : '(none)',
        products: `${p.product_count ?? 0} -> ${d.candidate?.product_count ?? '?'}`,
        governed: `${p.governed_count ?? 0} -> ${d.candidate?.governed_count ?? '?'}`,
        products_added: list(d.diff?.products_added),
        products_removed: list(d.diff?.products_removed),
        products_changed: list(d.diff?.products_changed),
        governed_added: list(d.diff?.governed_added),
        governed_removed: list(d.diff?.governed_removed),
        signing_key: d.signing ? (d.signing.trusted ? `trusted (${d.signing.trusted_key_prefix}...)` : (d.signing.configured ? 'NOT the trusted key: apply will be refused' : 'not configured: apply will be refused')) : '?',
      }, { title: d.dry_run ? 'Catalogue sign (DRY RUN)' : 'Catalogue sign' });
      if (d.diff?.governed_added?.length) {
        printWarning(`Newly governed: ${d.diff.governed_added.join(', ')}. Reissue the owner licence with these ids (quox licence reissue <id> --add ...) and refresh its lease BEFORE instances install this catalogue, or they lock out.`);
      }
      if (!d.changed) { printSuccess('No change: the published catalogue already matches.'); return; }
      if (d.dry_run) { printInfo('DRY RUN: nothing signed. Re-run with --apply to sign.'); return; }
      printSuccess(`Catalogue signed. sha256 ${d.sha256}, governed ${d.governed_count}, audit id ${d.audit_id}`);
      if (opts.out) printInfo(`Signed catalogue saved to ${opts.out}.`);
      printInfo('The website container copy does not survive a rebuild: commit the artifact to quox-website api/data/signed-catalog.json and quox-dashboard services/auth/data/signed-catalog.json (use --out to save it).');
    });
}
