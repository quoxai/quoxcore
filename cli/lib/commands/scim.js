/**
 * SCIM commands: org SCIM bearer tokens (IdP-driven directory sync auth)
 *
 * quox scim tokens list|create|delete
 *
 * Backend: services/auth/routes/webhooks.js, mounted at plain `/api`
 * (org-scoped IN the URL: /api/orgs/:orgId/scim/tokens...). Enterprise-tier
 * + ORG_MANAGE_SETTINGS gated — expect 402/403 on non-enterprise orgs.
 *
 * The plaintext bearer token is returned ONLY on create — it is never
 * retrievable again after that response (only its SHA-256 is stored). We
 * print it prominently and warn the user to record it now.
 */

import { formatOutput, printSuccess, printWarning } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

function printToken(token) {
  printWarning('Record this bearer token now — it will not be shown again:');
  console.log(`  ${token}`);
}

export function registerScimCommands(program, ctx) {
  const { client, auth } = ctx;

  const scim = program
    .command('scim')
    .description('Manage org SCIM bearer tokens (enterprise — IdP directory sync)');

  const tokens = scim
    .command('tokens')
    .description('Manage SCIM bearer tokens');

  // ── scim tokens list ────────────────────────────────────────────────────────

  tokens
    .command('list')
    .description('List SCIM tokens for the active org')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('scim.tokens.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.tokens || data || [];

      formatOutput({
        columns: ['id', 'label', 'created_at', 'last_used_at', 'revoked_at'],
        headers: ['ID', 'Label', 'Created', 'Last Used', 'Revoked'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No SCIM tokens configured.' });
    });

  // ── scim tokens create ──────────────────────────────────────────────────────

  tokens
    .command('create')
    .description('Create a SCIM bearer token')
    .option('--label <label>', 'human-readable label')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.label) body.label = options.label;

      const ep = resolveEndpoint('scim.tokens.create', { orgId });
      // NOTE: the backend response here is the raw `{ id, token }` shape,
      // not wrapped under a named key like every other create route in
      // this CLI — see endpoints/scim.js's header note.
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`SCIM token created (id: ${data.id}).`);
      if (data.token) printToken(data.token);
    });

  // ── scim tokens delete ──────────────────────────────────────────────────────

  tokens
    .command('delete')
    .description('Revoke a SCIM token')
    .argument('<tokenId>', 'token ID')
    .action(async (tokenId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('scim.tokens.delete', { orgId, tokenId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('SCIM token revoked.');
    });
}
