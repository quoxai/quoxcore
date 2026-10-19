/**
 * Plugin commands: org-scoped plugin install registry (PD-1..PD-8)
 *
 * quox plugin list|get|install|update|uninstall|mine
 * quox plugin enable <id>   (PLUGIN-IMG #1012: prebuilt private image, licence first)
 * quox plugin data list|get|set|delete
 * quox plugin secrets list|set|reveal|delete
 * quox plugin assign list|add|remove
 * quox plugin trusted-keys list|add|remove
 * quox plugin revocations list|add|remove
 *
 * Backend: services/auth/routes/plugins.js, mounted org-scoped at
 * `/api/orgs/:orgId/...` (server.js). Install/update/uninstall and all
 * secrets writes are admin-only per the PD stream's locked "admin-only
 * install model" decision; read endpoints require org membership only.
 */

import { registerPluginDoctor } from './plugin-doctor.js';
import { readFileSync } from 'node:fs';
import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { enablePlugin, entitlementFrom } from '../server/pluginEnable.js';
import { resolveInstall, readEnvKeys } from '../server/install.js';
import { createSys } from '../server/sys.js';

/** Read + JSON.parse a file, wrapping errors with the file path for context. */
function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read ${label} file "${filePath}": ${err.message}`);
  }
  return parseJSON(raw, label);
}

/** Read a file and base64-encode its bytes (bundle_b64 / css_b64 shape). */
function readBase64File(filePath, label) {
  try {
    return readFileSync(filePath).toString('base64');
  } catch (err) {
    throw new Error(`Could not read ${label} file "${filePath}": ${err.message}`);
  }
}

/** Best-effort JSON parse for a data value; falls back to the raw string. */
function coerceDataValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function confirmOrSkip(program, message) {
  const { default: inquirer } = await import('inquirer');
  const ans = await inquirer.prompt([{ type: 'confirm', name: 'confirm', message, default: false }]);
  return ans.confirm;
}

export function registerPluginCommands(program, ctx) {
  const { client, auth } = ctx;

  const plugin = program
    .command('plugin')
    .description('Manage org-installed plugins');

  registerPluginDoctor(plugin);

  // ── plugin licence ──────────────────────────────────────────────────────────

  plugin
    .command('licence')
    .alias('license')
    .description('Show whether a plugin is licence governed and entitled for this org (band, org id, entitlement errors)')
    .argument('<pluginId>', 'plugin id, e.g. notesq')
    .action(async (pluginId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('setup.licensing.entitlements.list');
      const data = await client.get(ep.path, { service: ep.service });
      const entitlements = Array.isArray(data.entitlements) ? data.entitlements : [];
      const governed = (Array.isArray(data.governed) ? data.governed : []).includes(pluginId);
      const match = entitlements.find((e) => e === pluginId || String(e).startsWith(`${pluginId}@`)) || null;
      // `entitlements` is the resolved (band-stripped) list; the band string lives on the licence itself.
      const licenceEnts = (Array.isArray(data.licenses) ? data.licenses : []).flatMap((l) => (Array.isArray(l.entitlements) ? l.entitlements : []));
      const banded = licenceEnts.find((e) => String(e).startsWith(`${pluginId}@`)) || null;
      const bandInfo = (data.org_bands && data.org_bands[pluginId]) || null;
      // A plugin outside the governed set is never licence gated (same rule as the server).
      const entitled = governed ? match !== null : true;
      const summary = {
        plugin: pluginId,
        governed,
        entitled,
        band: banded || (match && match.includes('@') ? match : null),
        seats_used: bandInfo && typeof bandInfo.assigned_count === 'number' ? bandInfo.assigned_count : null,
        seats_allowed: bandInfo && typeof bandInfo.allowance === 'number' ? bandInfo.allowance : null,
        seat_holders: bandInfo && Array.isArray(bandInfo.assigned_orgs) ? bandInfo.assigned_orgs : [],
        org_id: data.org_id || null,
        org_licensed: bandInfo ? bandInfo.org_licensed ?? null : null,
        entitlement_errors: Array.isArray(data.entitlement_errors) ? data.entitlement_errors : [],
      };
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      formatDetail({
        plugin: summary.plugin,
        governed: summary.governed ? 'yes' : 'no',
        entitled: summary.entitled ? 'yes' : 'no',
        band: summary.band || '(none)',
        org_seats: summary.seats_allowed === null ? '(no band)' : `${summary.seats_used} of ${summary.seats_allowed} used`,
        org_id: summary.org_id || '(instance scoped)',
        org_licensed: summary.org_licensed === null ? '(unknown)' : summary.org_licensed ? 'yes' : 'no',
        entitlement_errors: summary.entitlement_errors.length
          ? summary.entitlement_errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')
          : '(none)',
      }, { title: `Licence: ${pluginId}` });
    });

  // ── plugin enable (PLUGIN-IMG #1012) ────────────────────────────────────────
  // Starts a licensed plugin from its prebuilt private image on this
  // self-hosted install. Licence first: unlicensed means nothing runs.

  plugin
    .command('enable')
    .description('Start a licensed plugin from its prebuilt image on this self-hosted install (QuoxPlan for now). Unlicensed: refused, nothing pulled.')
    .argument('<pluginId>', 'plugin id, e.g. quoxplan')
    .option('--dir <path>', 'the install directory (default: the one Getting started recorded)')
    .action(async (pluginId, opts) => {
      auth.requireAuth();
      const deps = ctx.serverDeps || {};
      const env = deps.env || process.env;
      const sys = deps.sys || createSys();
      const checkEntitlement = async (id) => {
        const ep = resolveEndpoint('setup.licensing.entitlements.list');
        const data = await client.get(ep.path, { service: ep.service });
        return entitlementFrom(data, id);
      };
      // Licence before anything that touches the box: an unlicensed enable must not even look for the install.
      let ent;
      try { ent = await checkEntitlement(pluginId); } catch (err) { ent = err; }
      const resolveFirst = !(ent instanceof Error) && ent && ent.entitled;
      let install = null;
      if (resolveFirst) {
        const i = await resolveInstall({ dir: opts.dir, env, sys, journey: deps.journey });
        if (i.error) { const e = new Error(i.error); e.exitCode = 2; throw e; }
        install = i;
      }
      const tag = install ? (env.QUOX_IMAGE_TAG || readEnvKeys(install.repoDir, ['QUOX_IMAGE_TAG']).QUOX_IMAGE_TAG || '') : '';
      const result = await enablePlugin({
        pluginId,
        checkEntitlement: async () => { if (ent instanceof Error) throw ent; return ent; },
        install: install || { repoDir: '' },
        sys,
        tag,
        ...(deps.getPullCredential ? { getPullCredential: deps.getPullCredential } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        log: (l) => printInfo(l),
      });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify({ plugin: pluginId, ok: result.ok, stage: result.stage, message: result.message }, null, 2));
      } else if (result.ok) {
        printSuccess(result.message);
      } else {
        printWarning(result.message);
      }
      if (!result.ok) process.exitCode = result.stage === 'licence' ? 3 : 1;
    });

  // ── plugin list ─────────────────────────────────────────────────────────────

  plugin
    .command('list')
    .description('List installed plugins for the active org')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const plugins = data.plugins || data || [];
      formatOutput({
        columns: ['plugin_id', 'version', 'is_enabled', 'installed_by', 'installed_at', 'upgraded_at'],
        headers: ['Plugin ID', 'Version', 'Enabled', 'Installed By', 'Installed', 'Upgraded'],
        rows: plugins,
      }, { format: program.opts().output, emptyMessage: 'No plugins installed.' });
    });

  // ── plugin get ──────────────────────────────────────────────────────────────

  plugin
    .command('get')
    .description('Show plugin install details')
    .argument('<pluginId>', 'plugin ID (slug) or install-record id')
    .action(async (pluginId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const getFor = (id) => {
        const ep = resolveEndpoint('plugins.get', { orgId, pluginId: id });
        return client.get(ep.path, { service: ep.service });
      };
      let resolvedId = pluginId;
      let data;
      try {
        data = await getFor(resolvedId);
      } catch (err) {
        // quox-plugin-sdk#2(B): `plugin list --json` emits the install-record
        // ULID as `id`, but get resolves by plugin_id (slug) and 404s on the
        // ULID — so `plugin list --json | jq .id | xargs quox plugin get` broke.
        // On a 404, treat the arg as an install id and map it to its plugin_id
        // via the list, so BOTH identifiers round-trip. Slugs stay the fast path.
        if (err && err.status === 404) {
          const listEp = resolveEndpoint('plugins.list', { orgId });
          const listData = await client.get(listEp.path, { service: listEp.service });
          const rows = listData.plugins || listData || [];
          const match = rows.find(p => p.id === pluginId || p.install_id === pluginId);
          if (match && match.plugin_id && match.plugin_id !== pluginId) {
            resolvedId = match.plugin_id;
            data = await getFor(resolvedId);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      formatDetail(data.plugin || data, {
        format: program.opts().output,
        title: `Plugin: ${resolvedId}`,
        fields: ['id', 'plugin_id', 'version', 'is_enabled', 'bundle_sha256', 'installed_by', 'installed_at', 'upgraded_at', 'manifest', 'signature'],
        labels: {
          id: 'Install ID', plugin_id: 'Plugin ID', version: 'Version', is_enabled: 'Enabled',
          bundle_sha256: 'Bundle SHA256', installed_by: 'Installed By', installed_at: 'Installed',
          upgraded_at: 'Upgraded', manifest: 'Manifest', signature: 'Signature',
        },
      });
    });

  // ── plugin install ──────────────────────────────────────────────────────────

  plugin
    .command('install')
    .description('Install a plugin (admin only)')
    .requiredOption('--manifest <file>', 'path to a manifest JSON file (must include id, name, version)')
    .requiredOption('--bundle <file>', 'path to the plugin bundle JS file')
    .option('--css <file>', 'path to a CSS file for the plugin')
    .option('--signature <file>', 'path to a signature JSON file (required if the org has trusted keys)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const manifest = readJsonFile(options.manifest, '--manifest');
      const body = { manifest, bundle_b64: readBase64File(options.bundle, '--bundle') };
      if (options.css) body.css_b64 = readBase64File(options.css, '--css');
      if (options.signature) body.signature = readJsonFile(options.signature, '--signature');

      const ep = resolveEndpoint('plugins.install', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Plugin "${manifest.id}" installed.`);
      formatDetail(data.plugin || data, { format: program.opts().output });
    });

  // ── plugin update ───────────────────────────────────────────────────────────

  plugin
    .command('update')
    .description('Upgrade a plugin bundle and/or toggle its enabled state (admin only)')
    .argument('<pluginId>', 'plugin ID')
    .option('--enable', 'enable the plugin')
    .option('--disable', 'disable the plugin')
    .option('--manifest <file>', 'path to a new manifest JSON file (required together with --bundle)')
    .option('--bundle <file>', 'path to a new bundle JS file (required together with --manifest)')
    .option('--css <file>', 'path to a new CSS file')
    .option('--signature <file>', 'path to a new signature JSON file')
    .action(async (pluginId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (options.enable && options.disable) {
        throw new Error('Specify only one of --enable or --disable.');
      }

      const body = {};
      if (options.enable) body.is_enabled = true;
      if (options.disable) body.is_enabled = false;

      if (options.manifest || options.bundle) {
        if (!options.manifest || !options.bundle) {
          throw new Error('--manifest and --bundle must be provided together for an upgrade.');
        }
        body.manifest = readJsonFile(options.manifest, '--manifest');
        body.bundle_b64 = readBase64File(options.bundle, '--bundle');
        if (options.css) body.css_b64 = readBase64File(options.css, '--css');
        if (options.signature) body.signature = readJsonFile(options.signature, '--signature');
      }

      if (Object.keys(body).length === 0) {
        throw new Error('Specify --enable, --disable, or --manifest/--bundle to upgrade.');
      }

      const ep = resolveEndpoint('plugins.update', { orgId, pluginId });
      const data = await client.patch(ep.path, { service: ep.service, body });
      printSuccess('Plugin updated.');
      formatDetail(data.plugin || data, { format: program.opts().output });
    });

  // ── plugin uninstall ────────────────────────────────────────────────────────

  plugin
    .command('uninstall')
    .description('Uninstall a plugin (admin only)')
    .argument('<pluginId>', 'plugin ID')
    .option('--force', 'skip confirmation')
    .action(async (pluginId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const ok = await confirmOrSkip(program, `Uninstall plugin ${pluginId}? This cannot be undone.`);
        if (!ok) { printInfo('Cancelled.'); return; }
      }

      const ep = resolveEndpoint('plugins.uninstall', { orgId, pluginId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('Plugin uninstalled.');
    });

  // ── plugin mine ─────────────────────────────────────────────────────────────

  plugin
    .command('mine')
    .description('List plugins visible to the current user (respects assignments)')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.mine.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const plugins = data.plugins || data || [];
      formatOutput({
        columns: ['plugin_id', 'version', 'is_enabled', 'installed_at'],
        headers: ['Plugin ID', 'Version', 'Enabled', 'Installed'],
        rows: plugins,
      }, { format: program.opts().output, emptyMessage: 'No plugins visible to you in this org.' });
    });

  // ── plugin data ─────────────────────────────────────────────────────────────

  const data = plugin
    .command('data')
    .description('Manage plugin-scoped durable data (KV)');

  data
    .command('list')
    .description('List data keys for a plugin')
    .argument('<pluginId>', 'plugin ID')
    .option('--scope <scope>', 'org|user', 'org')
    .action(async (pluginId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.data.list', { orgId, pluginId });
      const result = await client.get(ep.path, { service: ep.service, query: { scope: options.scope } });
      const keys = result.keys || [];
      if (keys.length === 0) {
        printInfo('No data keys found.');
        return;
      }
      formatOutput({ columns: ['key'], headers: ['Key'], rows: keys.map(key => ({ key })) }, { format: program.opts().output });
    });

  data
    .command('get')
    .description('Get a plugin data value')
    .argument('<pluginId>', 'plugin ID')
    .argument('<key>', 'data key')
    .option('--scope <scope>', 'org|user', 'org')
    .action(async (pluginId, key, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.data.get', { orgId, pluginId, key });
      const row = await client.get(ep.path, { service: ep.service, query: { scope: options.scope } });
      formatDetail(row, { format: program.opts().output });
    });

  data
    .command('set')
    .description('Set a plugin data value')
    .argument('<pluginId>', 'plugin ID')
    .argument('<key>', 'data key')
    .requiredOption('--value <value>', 'value to store (JSON is parsed automatically; otherwise stored as a string)')
    .option('--scope <scope>', 'org|user', 'org')
    .action(async (pluginId, key, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.data.set', { orgId, pluginId, key });
      const row = await client.put(ep.path, {
        service: ep.service,
        query: { scope: options.scope },
        body: { value: coerceDataValue(options.value) },
      });
      printSuccess(`Data key "${key}" set.`);
      formatDetail(row, { format: program.opts().output });
    });

  data
    .command('delete')
    .description('Delete a plugin data value')
    .argument('<pluginId>', 'plugin ID')
    .argument('<key>', 'data key')
    .option('--scope <scope>', 'org|user', 'org')
    .action(async (pluginId, key, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.data.delete', { orgId, pluginId, key });
      await client.delete(ep.path, { service: ep.service, query: { scope: options.scope } });
      printSuccess('Data key deleted.');
    });

  // ── plugin secrets ──────────────────────────────────────────────────────────

  const secrets = plugin
    .command('secrets')
    .description('Manage plugin-scoped encrypted secrets');

  secrets
    .command('list')
    .description('List secret metadata for a plugin (no plaintext)')
    .argument('<pluginId>', 'plugin ID')
    .action(async (pluginId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.secrets.list', { orgId, pluginId });
      const result = await client.get(ep.path, { service: ep.service });
      const rows = result.secrets || result || [];
      formatOutput({
        columns: ['name', 'description', 'created_by', 'created_at', 'rotated_at'],
        headers: ['Name', 'Description', 'Created By', 'Created', 'Rotated'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No secrets set for this plugin.' });
    });

  secrets
    .command('set')
    .description('Set (or rotate) a plugin secret (admin only)')
    .argument('<pluginId>', 'plugin ID')
    .argument('<name>', 'secret name')
    .requiredOption('--value <text>', 'secret value')
    .option('--description <text>', 'secret description')
    .action(async (pluginId, name, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { value: options.value };
      if (options.description) body.description = options.description;
      const ep = resolveEndpoint('plugins.secrets.set', { orgId, pluginId, name });
      const result = await client.put(ep.path, { service: ep.service, body });
      printSuccess(`Secret "${name}" set.`);
      formatDetail(result.secret || result, { format: program.opts().output });
    });

  secrets
    .command('reveal')
    .description('Reveal a plugin secret\'s plaintext value (audited)')
    .argument('<pluginId>', 'plugin ID')
    .argument('<name>', 'secret name')
    .action(async (pluginId, name) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      printWarning('This reveals a plaintext secret and is recorded in the audit log.');
      const ep = resolveEndpoint('plugins.secrets.reveal', { orgId, pluginId, name });
      const result = await client.post(ep.path, { service: ep.service });
      formatDetail(result, { format: program.opts().output });
    });

  secrets
    .command('delete')
    .description('Delete a plugin secret (admin only)')
    .argument('<pluginId>', 'plugin ID')
    .argument('<name>', 'secret name')
    .action(async (pluginId, name) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.secrets.delete', { orgId, pluginId, name });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('Secret deleted.');
    });

  // ── plugin assign ───────────────────────────────────────────────────────────

  const assign = plugin
    .command('assign')
    .description('Manage plugin visibility assignments (admin only)');

  assign
    .command('list')
    .description('List assignments for a plugin')
    .argument('<pluginId>', 'plugin ID')
    .action(async (pluginId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.assignments.list', { orgId, pluginId });
      const result = await client.get(ep.path, { service: ep.service });
      const rows = result.assignments || result || [];
      formatOutput({
        columns: ['assignee_type', 'assignee_id', 'assigned_by', 'assigned_at'],
        headers: ['Type', 'Assignee', 'Assigned By', 'Assigned'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No assignments set (plugin uses default visibility).' });
    });

  assign
    .command('add')
    .description('Assign a plugin to all org members, a user, or a team')
    .argument('<pluginId>', 'plugin ID')
    .requiredOption('--type <assigneeType>', 'all_org_members|user|team')
    .option('--id <assigneeId>', 'assignee ID (user or team ID; omit for all_org_members)')
    .action(async (pluginId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { assignee_type: options.type };
      if (options.id) body.assignee_id = options.id;
      const ep = resolveEndpoint('plugins.assignments.create', { orgId, pluginId });
      const result = await client.post(ep.path, { service: ep.service, body });
      printSuccess('Assignment added.');
      formatDetail(result.assignment || result, { format: program.opts().output });
    });

  assign
    .command('remove')
    .description('Remove a plugin assignment')
    .argument('<pluginId>', 'plugin ID')
    .argument('<assigneeType>', 'all_org_members|user|team')
    .argument('[assigneeId]', 'assignee ID (omit for all_org_members)')
    .action(async (pluginId, assigneeType, assigneeId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.assignments.delete', { orgId, pluginId, assigneeType, assigneeId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('Assignment removed.');
    });

  // ── plugin trusted-keys ─────────────────────────────────────────────────────

  const trustedKeys = plugin
    .command('trusted-keys')
    .description('Manage per-org trusted Ed25519 signing keys (admin only)');

  trustedKeys
    .command('list')
    .description('List trusted keys')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.trusted-keys.list', { orgId });
      const result = await client.get(ep.path, { service: ep.service });
      const rows = result.trusted_keys || result || [];
      formatOutput({
        columns: ['id', 'label', 'public_key_hex', 'added_by', 'added_at'],
        headers: ['ID', 'Label', 'Public Key', 'Added By', 'Added'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No trusted keys configured (unsigned installs are accepted).' });
    });

  trustedKeys
    .command('add')
    .description('Add a trusted signing key')
    .requiredOption('--label <label>', 'key label')
    .requiredOption('--public-key <hex>', 'Ed25519 public key, hex-encoded')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { label: options.label, public_key_hex: options.publicKey };
      const ep = resolveEndpoint('plugins.trusted-keys.create', { orgId });
      const result = await client.post(ep.path, { service: ep.service, body });
      printSuccess('Trusted key added.');
      formatDetail(result.trusted_key || result, { format: program.opts().output });
    });

  trustedKeys
    .command('remove')
    .description('Remove a trusted signing key')
    .argument('<keyId>', 'trusted key ID')
    .option('--confirm-unsigned', 'WARNING: required to remove the LAST trusted key; the org will then accept UNSIGNED plugin bundles')
    .action(async (keyId, opts) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.trusted-keys.delete', { orgId, keyId });
      const reqOpts = { service: ep.service };
      if (opts && opts.confirmUnsigned) {
        console.error('WARNING: confirming downgrade. This org will accept UNSIGNED plugin bundles after this key is removed.');
        reqOpts.query = { confirm_unsigned: '1' };
      }
      await client.delete(ep.path, reqOpts);
      printSuccess('Trusted key removed.');
    });

  // ── plugin revocations (SDK-TEAM W5) ────────────────────────────────────────

  const revocations = plugin
    .command('revocations')
    .description('Revoke a plugin signer key or one bundle digest for this org (admin only). A revoked plugin cannot be installed and stops loading on the next page load.');

  revocations
    .command('list')
    .description('List revocations')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.revocations.list', { orgId });
      const result = await client.get(ep.path, { service: ep.service });
      const rows = result.revocations || result || [];
      formatOutput({
        columns: ['id', 'kind', 'value', 'reason', 'revoked_by', 'revoked_at'],
        headers: ['ID', 'Kind', 'Value', 'Reason', 'Revoked By', 'Revoked'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No revocations.' });
    });

  revocations
    .command('add')
    .description('Revoke a signer key or a bundle digest')
    .option('--signer-key <hex>', 'raw Ed25519 public key (64 hex), as in signature.json public_key_hex')
    .option('--bundle-digest <hex>', 'sha256 of plugin.esm.js (64 hex), as shown by quox plugin list')
    .option('--reason <text>', 'why (kept in the audit trail)')
    .action(async (options) => {
      auth.requireAuth();
      if (!!options.signerKey === !!options.bundleDigest) {
        throw new Error('Specify exactly one of --signer-key or --bundle-digest.');
      }
      const orgId = resolveOrgId(auth, program);
      const body = options.signerKey
        ? { kind: 'signer_key', value: options.signerKey, reason: options.reason }
        : { kind: 'bundle_digest', value: options.bundleDigest, reason: options.reason };
      const ep = resolveEndpoint('plugins.revocations.create', { orgId });
      const result = await client.post(ep.path, { service: ep.service, body });
      printSuccess('Revoked.');
      formatDetail(result.revocation || result, { format: program.opts().output });
    });

  revocations
    .command('remove')
    .description('Lift a revocation')
    .argument('<revocationId>', 'revocation ID')
    .action(async (revocationId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('plugins.revocations.delete', { orgId, revocationId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('Revocation lifted.');
    });
}
