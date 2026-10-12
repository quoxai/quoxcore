/**
 * SSO commands: org SSO provider registry (OIDC + SAML admin CRUD)
 *
 * quox sso providers list|get|create|update|delete|saml-metadata
 *
 * Backend: services/auth/routes/sso.js, mounted at plain `/api`
 * (org-scoped IN the URL for admin routes: /api/orgs/:orgId/sso/providers...).
 * Enterprise-tier + ORG_MANAGE_SSO gated — expect 402/403 on non-enterprise
 * orgs.
 *
 * `saml-metadata` is the one exception: its backend route has NO orgId
 * segment (`/api/sso/providers/:providerId/saml-metadata`) and is public
 * (no auth chain) — see endpoints/sso.js for the full finding. It only
 * works for providers whose protocol is 'saml'.
 *
 * The browser-flow login/callback/discover routes are intentionally not
 * exposed here — they're 302-redirect handshakes, not CLI-shaped.
 */

import { readFileSync } from 'node:fs';
import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/** Build a create/update body from the shared provider flags. */
function buildProviderBody(options) {
  const body = {};
  if (options.protocol) body.protocol = options.protocol;
  if (options.key) body.provider_key = options.key;
  if (options.displayName) body.display_name = options.displayName;
  if (options.enabled) body.enabled = true;
  if (options.disabled) body.enabled = false;
  if (options.ssoOnly) body.sso_only = true;
  if (options.emailDomains) {
    body.email_domains = options.emailDomains.split(',').map(d => d.trim()).filter(Boolean);
  }
  // OIDC
  if (options.issuer) body.issuer = options.issuer;
  if (options.clientId) body.client_id = options.clientId;
  if (options.clientSecret) body.client_secret = options.clientSecret;
  if (options.authzUrl) body.authz_url = options.authzUrl;
  if (options.tokenUrl) body.token_url = options.tokenUrl;
  if (options.userinfoUrl) body.userinfo_url = options.userinfoUrl;
  if (options.jwksUri) body.jwks_uri = options.jwksUri;
  if (options.scopes) body.scopes = options.scopes.split(',').map(s => s.trim()).filter(Boolean);
  // SAML
  if (options.entityId) body.entity_id = options.entityId;
  if (options.ssoUrl) body.sso_url = options.ssoUrl;
  if (options.sloUrl) body.slo_url = options.sloUrl;
  if (options.x509CertFile) body.x509_cert = readFileSync(options.x509CertFile, 'utf-8');
  if (options.nameidFormat) body.nameid_format = options.nameidFormat;
  if (options.attributeMap) body.attribute_map = parseJSON(options.attributeMap, '--attribute-map');
  if (options.groupRoleMap) body.group_role_map = parseJSON(options.groupRoleMap, '--group-role-map');
  return body;
}

function addProviderFlags(cmd) {
  return cmd
    .option('--protocol <protocol>', 'oidc|saml (create defaults to oidc)')
    .option('--display-name <name>', 'human-readable name')
    .option('--enabled', 'enable the provider')
    .option('--disabled', 'disable the provider')
    .option('--sso-only', 'require SSO for matching email domains (disable password login)')
    .option('--email-domains <domains>', 'comma-separated email domains routed to this provider')
    .option('--issuer <url>', '[oidc] issuer URL')
    .option('--client-id <id>', '[oidc] client ID')
    .option('--client-secret <secret>', '[oidc] client secret')
    .option('--authz-url <url>', '[oidc] authorization endpoint (optional, discovered if omitted)')
    .option('--token-url <url>', '[oidc] token endpoint')
    .option('--userinfo-url <url>', '[oidc] userinfo endpoint')
    .option('--jwks-uri <url>', '[oidc] JWKS URI')
    .option('--scopes <scopes>', '[oidc] comma-separated scopes (default: openid,email,profile)')
    .option('--entity-id <id>', '[saml] IdP entity ID')
    .option('--sso-url <url>', '[saml] IdP SSO URL')
    .option('--slo-url <url>', '[saml] IdP SLO URL')
    .option('--x509-cert-file <path>', '[saml] path to the IdP\'s PEM-encoded x509 certificate')
    .option('--nameid-format <format>', '[saml] NameID format')
    .option('--attribute-map <json>', '[saml] attribute mapping as a JSON object')
    .option('--group-role-map <json>', '[saml] group-to-role mapping as a JSON object');
}

export function registerSsoCommands(program, ctx) {
  const { client, auth } = ctx;

  const sso = program
    .command('sso')
    .description('Manage org SSO providers (enterprise — OIDC/SAML admin)');

  const providers = sso
    .command('providers')
    .description('Manage SSO provider configurations');

  // ── sso providers list ──────────────────────────────────────────────────────

  providers
    .command('list')
    .description('List SSO providers for the active org')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('sso.providers.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.providers || data || [];

      formatOutput({
        columns: ['id', 'protocol', 'provider_key', 'display_name', 'enabled', 'sso_only', 'created_at'],
        headers: ['ID', 'Protocol', 'Key', 'Display Name', 'Enabled', 'SSO Only', 'Created'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No SSO providers configured.' });
    });

  // ── sso providers get ───────────────────────────────────────────────────────

  providers
    .command('get')
    .description('Show SSO provider details')
    .argument('<providerId>', 'provider ID')
    .action(async (providerId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('sso.providers.get', { orgId, providerId });
      const data = await client.get(ep.path, { service: ep.service });
      const provider = data.provider || data;

      formatDetail(provider, {
        format: program.opts().output,
        title: `SSO Provider: ${provider.display_name || provider.provider_key || providerId}`,
        fields: [
          'id', 'protocol', 'provider_key', 'display_name', 'enabled', 'sso_only',
          'issuer', 'client_id', 'authz_url', 'token_url', 'userinfo_url', 'jwks_uri', 'scopes',
          'entity_id', 'sso_url', 'slo_url', 'nameid_format', 'attribute_map', 'group_role_map',
          'email_domains', 'created_at', 'updated_at',
        ],
      });
    });

  // ── sso providers create ────────────────────────────────────────────────────

  addProviderFlags(
    providers
      .command('create')
      .description('Create an SSO provider')
      .requiredOption('--key <providerKey>', 'unique provider key (e.g. "okta", "google-workspace")'),
  ).action(async (options) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);
    const body = buildProviderBody(options);

    const ep = resolveEndpoint('sso.providers.create', { orgId });
    const data = await client.post(ep.path, { service: ep.service, body });
    printSuccess(`SSO provider "${options.key}" created.`);
    formatDetail(data.provider || data, { format: program.opts().output });
  });

  // ── sso providers update ────────────────────────────────────────────────────

  addProviderFlags(
    providers
      .command('update')
      .description('Update an SSO provider')
      .argument('<providerId>', 'provider ID'),
  ).action(async (providerId, options) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);
    const body = buildProviderBody(options);

    if (Object.keys(body).length === 0) {
      throw new Error('Specify at least one field to update.');
    }

    const ep = resolveEndpoint('sso.providers.update', { orgId, providerId });
    const data = await client.patch(ep.path, { service: ep.service, body });
    printSuccess('SSO provider updated.');
    formatDetail(data.provider || data, { format: program.opts().output });
  });

  // ── sso providers delete ────────────────────────────────────────────────────

  providers
    .command('delete')
    .description('Delete an SSO provider')
    .argument('<providerId>', 'provider ID')
    .option('--force', 'skip confirmation')
    .action(async (providerId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Delete SSO provider ${providerId}? Users routed to it will fall back to password login.`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Cancelled.');
          return;
        }
      }

      const ep = resolveEndpoint('sso.providers.delete', { orgId, providerId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('SSO provider deleted.');
    });

  // ── sso providers saml-metadata ─────────────────────────────────────────────

  providers
    .command('saml-metadata')
    .description('Fetch the SP metadata XML for a SAML provider (paste into your IdP)')
    .argument('<providerId>', 'provider ID (must be a SAML provider)')
    .action(async (providerId) => {
      auth.requireAuth();
      // This backend route is public and NOT org-scoped in the URL — see
      // endpoints/sso.js's header note. No orgId is sent.
      const ep = resolveEndpoint('sso.providers.saml-metadata', { providerId });
      const data = await client.get(ep.path, { service: ep.service });
      // The route returns `application/xml`, so client.get() hands back
      // `{ success: true, text: '<...xml...>' }` (its non-JSON-content-type
      // fallback) rather than a parsed body.
      const xml = data?.text ?? data;
      if (program.opts().output === 'json') {
        console.log(JSON.stringify({ metadata: xml }, null, 2));
      } else {
        console.log(typeof xml === 'string' ? xml : JSON.stringify(xml, null, 2));
      }
    });
}
