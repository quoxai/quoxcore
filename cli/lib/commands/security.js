/**
 * Security commands: org session policy, IP allowlist, org-level MFA policy
 *
 * quox security session-policy get|set
 * quox security ip-allowlist list|add|remove
 * quox security mfa get|set
 *
 * Backend: services/auth/routes/orgSecurity.js, mounted at plain `/api`
 * (org-scoped IN the URL: /api/orgs/:orgId/security/...). Enterprise-tier +
 * ORG_MANAGE_SETTINGS gated — expect 402/403 on non-enterprise orgs.
 *
 * `mfa` here is the ORG-WIDE policy mode (disabled|optional|required), not
 * a specific user's MFA enrollment — see `quox mfa` (endpoints/mfa.js,
 * lib/commands/*.js's personal-MFA equivalent) for that.
 */

import { formatOutput, formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerSecurityCommands(program, ctx) {
  const { client, auth } = ctx;

  const security = program
    .command('security')
    .description('Manage org security policy (enterprise — session, IP allowlist, MFA)');

  // ── security session-policy ─────────────────────────────────────────────────

  const sessionPolicy = security
    .command('session-policy')
    .description('Manage the org session timeout policy');

  sessionPolicy
    .command('get')
    .description('Show the active session policy')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('security.session-policy.get', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.policy || data, { format: program.opts().output, title: 'Session Policy' });
    });

  sessionPolicy
    .command('set')
    .description('Update the session policy (0 = disabled for that dimension)')
    .option('--idle-timeout-sec <n>', 'idle timeout in seconds', (v) => parseInt(v, 10))
    .option('--max-session-sec <n>', 'max session lifetime in seconds', (v) => parseInt(v, 10))
    .option('--remember-me <bool>', 'true|false — allow "remember me" opt-in')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const body = {};
      if (options.idleTimeoutSec !== undefined) body.idleTimeoutSec = options.idleTimeoutSec;
      if (options.maxSessionSec !== undefined) body.maxSessionSec = options.maxSessionSec;
      if (options.rememberMe !== undefined) {
        if (options.rememberMe !== 'true' && options.rememberMe !== 'false') {
          throw new Error('--remember-me must be "true" or "false".');
        }
        body.rememberMeEnabled = options.rememberMe === 'true';
      }
      if (Object.keys(body).length === 0) {
        throw new Error('Specify at least one of --idle-timeout-sec, --max-session-sec, --remember-me.');
      }

      const ep = resolveEndpoint('security.session-policy.set', { orgId });
      const data = await client.put(ep.path, { service: ep.service, body });
      printSuccess('Session policy updated.');
      formatDetail(data.policy || data, { format: program.opts().output });
    });

  // ── security ip-allowlist ───────────────────────────────────────────────────

  const ipAllowlist = security
    .command('ip-allowlist')
    .description('Manage the org IP allowlist (empty list = allow all)');

  ipAllowlist
    .command('list')
    .description('List IP allowlist entries')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('security.ip-allowlist.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.entries || data || [];

      formatOutput({
        columns: ['id', 'cidr', 'label', 'created_at'],
        headers: ['ID', 'CIDR', 'Label', 'Created'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No IP allowlist entries (all IPs allowed).' });
    });

  ipAllowlist
    .command('add')
    .description('Add an IP allowlist entry')
    .argument('<cidr>', 'IPv4 CIDR (e.g. "203.0.113.0/24")')
    .option('--label <label>', 'human-readable label')
    .action(async (cidr, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { cidr };
      if (options.label) body.label = options.label;

      const ep = resolveEndpoint('security.ip-allowlist.add', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`IP allowlist entry "${cidr}" added.`);
      formatDetail(data.entry || data, { format: program.opts().output });
    });

  ipAllowlist
    .command('remove')
    .description('Remove an IP allowlist entry')
    .argument('<entryId>', 'entry ID')
    .action(async (entryId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('security.ip-allowlist.remove', { orgId, entryId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('IP allowlist entry removed.');
    });

  // ── security mfa ────────────────────────────────────────────────────────────

  const mfa = security
    .command('mfa')
    .description('Manage the org-wide MFA policy mode');

  mfa
    .command('get')
    .description('Show the active org MFA policy mode')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('security.mfa.get', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output, title: 'Org MFA Policy' });
    });

  mfa
    .command('set')
    .description('Set the org-wide MFA policy mode')
    .argument('<mode>', 'disabled|optional|required')
    .action(async (mode) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('security.mfa.set', { orgId });
      const data = await client.put(ep.path, { service: ep.service, body: { mode } });
      printSuccess(`Org MFA policy set to "${data.mode || mode}".`);
      if (mode === 'required') {
        printInfo('Members without MFA enrolled will be required to enroll on next login.');
      }
    });
}
