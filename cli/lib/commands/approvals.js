/**
 * Approvals commands: result (quox#791), grants list|create|revoke (fleet standing grants, 2026-10-13)
 *
 * After a human approves a held tool call (e.g. a gated ssh_exec) the collector
 * runs it and stores the outcome. `quox approvals result <id>` reads it back.
 */

import { resolveEndpoint } from '../api/endpoints.js';

import { attachWalkthrough } from './walkthrough.js';

export function registerApprovalsCommands(program, ctx) {
  const { client, auth } = ctx;

  const approvals = program
    .command('approvals')
    .description('Tool approvals (held actions awaiting or past a human decision)');
  attachWalkthrough(approvals, ctx, program);

  approvals
    .command('result <approvalId>')
    .description('Show the status and stored output of an approved tool call')
    .option('--org <id>', 'org ID (service-key automation callers; defaults to active org / QUOX_ORG_ID)')
    .action(async (approvalId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.approvals.result', { id: approvalId });
      const orgId = auth.getOrgId(options.org || process.env.QUOX_ORG_ID);
      const query = orgId ? { org_id: orgId } : undefined;
      const data = await client.get(ep.path, { service: ep.service, ...(query ? { query } : {}) });

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(`Approval ${data.approval_id}  tool: ${data.tool}  status: ${data.status}`
        + (data.executed_at ? `  executed: ${data.executed_at}` : ''));
      if (data.result === null || data.result === undefined) {
        if (data.status === 'pending') console.log('Still pending: a human has not decided yet.');
        else if (data.status === 'resuming') console.log('Approved, executing. Re-run shortly.');
        else console.log('No stored output.');
        return;
      }
      const r = data.result;
      if (typeof r === 'string') { console.log(r); return; }
      if (r.success === false) console.log(`Failed: ${r.error || 'unknown error'}`);
      const out = r.output ?? r.stdout ?? r.result;
      if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      else console.log(JSON.stringify(r, null, 2));
    });

  // Fleet standing grants: an org admin pre-approves ONE host + an anchored command
  // shape + a VMID range until an expiry, for ssh_exec. Every use still lands in
  // approvals history with an AEE envelope; anything outside the grant files HITL.
  const grants = approvals
    .command('grants')
    .description('Standing grants: org-admin pre-approved fleet command lanes (ssh_exec)');

  grants
    .command('list')
    .description('List active standing grants (--all includes revoked and expired)')
    .option('--all', 'include revoked and expired grants')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.approvals.grants.list');
      const data = await client.get(ep.path, { service: ep.service, ...(options.all ? { query: { all: '1' } } : {}) });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const rows = data.grants || [];
      if (!rows.length) { console.log('No standing grants.'); return; }
      for (const g of rows) {
        const state = g.revoked_at ? `revoked ${g.revoked_at}` : `expires ${g.expires_at}`;
        const range = g.vmid_min != null ? `  vmids ${g.vmid_min}-${g.vmid_max}` : '';
        console.log(`${g.grant_id}  ${g.tool}@${g.host}${range}  ${g.preset || `${g.patterns.length} patterns`}  uses ${g.use_count}  ${state}`);
        console.log(`  reason: ${g.reason}  (by ${g.created_by})`);
      }
    });

  grants
    .command('create')
    .description('Create a standing grant (human org admin only)')
    .requiredOption('--host <hostId>', 'the ONE host the grant covers')
    .requiredOption('--reason <text>', 'why (shown in history and evidence)')
    .option('--preset <name>', 'proxmox-test-vm-lane (clone/power/destroy/guest-exec in a VMID range)')
    .option('--template <vmid>', 'template VMID the lane clones from (preset)')
    .option('--vmid-range <min-max>', 'VMID range, e.g. 9100-9199')
    .option('--name-prefix <prefix>', 'VM name prefix the lane may create (preset)', 'z2h')
    .option('--pattern <regex>', 'custom anchored command regex (repeatable; instead of --preset)', (v, a) => (a || []).concat([v]))
    .option('--days <n>', 'expiry in days (max 30)', '14')
    .action(async (options) => {
      auth.requireAuth();
      const body = { tool: 'ssh_exec', host: options.host, reason: options.reason, expires_in_days: Number(options.days) };
      if (options.vmidRange) {
        const m = /^(\d+)-(\d+)$/.exec(options.vmidRange);
        if (!m) { console.error('--vmid-range must look like 9100-9199'); process.exitCode = 1; return; }
        body.vmid_min = Number(m[1]); body.vmid_max = Number(m[2]);
      }
      if (options.preset) {
        body.preset = options.preset; body.template_vmid = Number(options.template); body.name_prefix = options.namePrefix;
      } else {
        body.patterns = options.pattern || [];
      }
      const ep = resolveEndpoint('v1.approvals.grants.create');
      const data = await client.post(ep.path, { service: ep.service, body });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const g = data.grant || {};
      console.log(`Created ${g.grant_id}: ${g.tool}@${g.host}${g.vmid_min != null ? ` vmids ${g.vmid_min}-${g.vmid_max}` : ''}, expires ${g.expires_at}`);
      console.log(`Revoke any time: quox approvals grants revoke ${g.grant_id}`);
    });

  grants
    .command('revoke <grantId>')
    .description('Revoke a standing grant now (human org admin only)')
    .action(async (grantId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.approvals.grants.revoke', { id: grantId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      console.log(`Revoked ${data.grant?.grant_id || grantId} at ${data.grant?.revoked_at || 'now'}.`);
    });
}
