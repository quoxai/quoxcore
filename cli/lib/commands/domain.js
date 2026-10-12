/**
 * Domain commands: org domain verification (DNS TXT record ownership proof)
 *
 * quox domain list|add|verify|remove
 *
 * Backend: services/auth/routes/domains.js, mounted at plain `/api`
 * (org-scoped IN the URL: /api/orgs/:orgId/domains...). Team-tier+ +
 * ORG_MANAGE_SETTINGS gated — expect 402/403 on non-team orgs.
 *
 * `add` returns a verification token and human-readable DNS instructions;
 * `verify` re-checks DNS and returns 202 (retryable) rather than an error
 * when the TXT record isn't there yet or hasn't propagated.
 */

import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerDomainCommands(program, ctx) {
  const { client, auth } = ctx;

  const domain = program
    .command('domain')
    .description('Manage org domain verification (team+ — DNS ownership proof)');

  // ── domain list ──────────────────────────────────────────────────────────────

  domain
    .command('list')
    .description('List domains claimed by the active org')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('domains.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.domains || data || [];

      formatOutput({
        // fleet #392: column is verified_at (a timestamp), not a `verified` flag.
        columns: ['id', 'domain', 'verified_at', 'created_at'],
        headers: ['ID', 'Domain', 'Verified', 'Created'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No domains claimed for this org.' });
    });

  // ── domain add ───────────────────────────────────────────────────────────────

  domain
    .command('add')
    .description('Claim a domain and get its DNS verification instructions')
    .argument('<domain>', 'domain name (e.g. "example.com")')
    .action(async (domainName) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { domain: domainName };

      const ep = resolveEndpoint('domains.create', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Domain "${domainName}" claim started.`);
      formatDetail(data.domain || {}, { format: program.opts().output });
      if (data.instructions && program.opts().output !== 'json') {
        printInfo(data.instructions);
      }
    });

  // ── domain verify ────────────────────────────────────────────────────────────

  domain
    .command('verify')
    .description('Re-check DNS for a claimed domain')
    .argument('<domainId>', 'domain ID')
    .action(async (domainId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('domains.verify', { orgId, domainId });
      const data = await client.post(ep.path, { service: ep.service });

      if (data.verified) {
        printSuccess('Domain verified.');
      } else {
        printWarning(`Not verified yet (reason: ${data.reason || 'unknown'}).${data.retryable ? ' Retryable — DNS changes can take up to 48 hours.' : ''}`);
      }
    });

  // ── domain remove ────────────────────────────────────────────────────────────

  domain
    .command('remove')
    .description('Remove a claimed domain')
    .argument('<domainId>', 'domain ID')
    .option('--force', 'skip confirmation')
    .action(async (domainId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Remove domain ${domainId}? SSO/user-domain routing tied to it will stop working.`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Cancelled.');
          return;
        }
      }

      const ep = resolveEndpoint('domains.delete', { orgId, domainId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('Domain removed.');
    });
}
