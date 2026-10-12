/**
 * Safety commands: kill switch (per-agent E-STOP) + instance DEFCON.
 *
 * quox safety status              org halt state: DEFCON + active E-STOPs
 * quox safety gate <agentId>      the enforcement verdict a dispatcher sees
 * quox safety estop <agentId>     activate the per-agent kill switch
 * quox safety release <agentId>   release it
 * quox safety defcon <LEVEL>      set instance DEFCON (GREEN..RED)
 * quox safety history             append-only audit trail of every flip
 *
 * Backend: collector routes/safetyGate.js (quox#503, PR #505; dispatch
 * chokepoint coverage quox#506). Mutations REQUIRE a human admin login:
 * the server rejects agent/resident/service tokens by design, so if
 * `estop`/`release`/`defcon` return 403 admin_required under a resident
 * profile, that is the governance boundary working: log in as a human
 * (`quox login`), do not look for a bypass.
 *
 * Closes the quox#507 parity gap: the 2026-09-02 live E-STOP proof drive
 * had to be scripted with raw curl because these verbs did not exist.
 */

import { formatOutput, formatDetail, printSuccess, printWarning } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerSafetyCommands(program, ctx) {
  const { client, auth } = ctx;

  const safety = program
    .command('safety')
    .description('Kill switch (per-agent E-STOP) and instance DEFCON (human-admin gated mutations)');

  safety
    .command('status')
    .description('Org halt state: DEFCON level + active per-agent E-STOPs')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('safety.status');
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output });
    });

  safety
    .command('gate')
    .description('The enforcement verdict a dispatcher gets for this agent right now')
    .argument('<agentId>', 'agent id, e.g. quox, sentinel')
    .action(async (agentId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('safety.gate', { agentId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output });
      if (data.blocked) printWarning(`Dispatch for ${agentId} is BLOCKED: ${data.reason}`);
    });

  safety
    .command('estop')
    .description('Activate the per-agent kill switch (HUMAN admin only, enforced server-side)')
    .argument('<agentId>', 'agent id to halt')
    .option('--reason <text>', 'why (lands in the audit trail)')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('safety.estop', { agentId });
      const data = await client.post(ep.path, { service: ep.service, body: { reason: options.reason || null } });
      printSuccess(`E-STOP ACTIVE for ${agentId}${data.was_active ? ' (was already active)' : ''}: new dispatch is blocked at every chokepoint; live loop sessions end at the next turn boundary.`);
    });

  safety
    .command('release')
    .description('Release a per-agent kill switch (HUMAN admin only, enforced server-side)')
    .argument('<agentId>', 'agent id to release')
    .action(async (agentId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('safety.release', { agentId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess(`E-STOP released for ${agentId}.`);
    });

  safety
    .command('defcon')
    .description('Set instance DEFCON: GREEN | BLUE | AMBER | ORANGE (escalate) | RED (full halt)')
    .argument('<level>', 'GREEN, BLUE, AMBER, ORANGE or RED')
    .option('--reason <text>', 'why (lands in the audit trail)')
    .action(async (level, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('safety.defcon');
      const data = await client.post(ep.path, { service: ep.service, body: { level: level.toUpperCase(), reason: options.reason || null } });
      printSuccess(`DEFCON ${data.old_level} -> ${data.new_level}.`);
    });

  safety
    .command('history')
    .description('Append-only audit trail of every E-STOP and DEFCON change')
    .option('--agent <agentId>', 'filter to one agent')
    .option('--limit <n>', 'max rows', '50')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('safety.history');
      const qs = new URLSearchParams();
      if (options.agent) qs.set('agent_id', options.agent);
      qs.set('limit', options.limit);
      const data = await client.get(`${ep.path}?${qs}`, { service: ep.service });
      formatOutput({
        columns: ['created_at', 'scope', 'action', 'agent_id', 'new_value', 'actor_label', 'reason'],
        headers: ['At', 'Scope', 'Action', 'Agent', 'Value', 'Actor', 'Reason'],
        rows: data.history || [],
      }, { format: program.opts().output, emptyMessage: 'No safety state changes recorded.' });
    });
}
