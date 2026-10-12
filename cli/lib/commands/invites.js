/**
 * Invitation commands (GRIPE-712): list and accept the caller's own pending
 * invitations without needing the emailed token.
 */
import { formatOutput, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerInvitesCommands(program, ctx) {
  const { client, auth } = ctx;

  const invites = program.command('invites').description('Your pending organization invitations');

  invites
    .command('list')
    .description('List pending invitations addressed to your verified email')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('invites.mine.list');
      const data = await client.get(ep.path, { service: ep.service });
      const rows = (data.invites || []).map(i => ({
        id: i.id,
        organization: i.organization?.name || i.organization?.slug || '',
        role: i.role,
        invited_by: i.invited_by || '',
        expires_at: i.expires_at || '',
      }));
      formatOutput({
        columns: ['id', 'organization', 'role', 'invited_by', 'expires_at'],
        headers: ['ID', 'Organization', 'Role', 'Invited by', 'Expires'],
        rows,
      }, { format: program.opts().output });
    });

  invites
    .command('accept')
    .description('Accept a pending invitation by id (no emailed token needed)')
    .argument('<id>', 'invitation id from `quox invites list`')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('invites.mine.accept', { inviteId: id });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      const org = data.organization;
      printSuccess(`${data.message || 'Invite accepted'}${org?.name ? `: ${org.name}` : ''}. Run \`quox org switch ${org?.id || '<orgId>'}\` to use it.`);
    });
}
