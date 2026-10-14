/**
 * quox capabilities [name]
 *
 * What this Quox can do for your org right now (QUOXON E1): ready, needs setup,
 * not available, planned, each with the server's honest reason and setup hint.
 * Backend: collector GET /api/v1/capabilities (org from your token; 30 s cache).
 * Same renderer as the terminal's /capabilities, so the two never disagree.
 */

import { resolveEndpoint } from '../api/endpoints.js';
import { capabilityLines, findCapability, offerFor } from '../quoxon/capabilities.js';

export function registerCapabilitiesCommands(program, ctx) {
  const { client, auth } = ctx;
  program
    .command('capabilities [name]')
    .description('What this Quox can do for your org: ready, needs setup, not available, planned')
    .action(async (name) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.capabilities');
      const data = await client.get(ep.path, { service: ep.service });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const res = { ok: Array.isArray(data?.capabilities), capabilities: data?.capabilities, error: 'unexpected response' };
      if (name) {
        const c = findCapability(name, res);
        if (!c) { console.log(`Nothing called "${name}". quox capabilities lists them.`); process.exitCode = 1; return; }
        console.log(`${c.name}: ${c.intent}`);
        console.log(`Proof: ${c.evidence || 'not stated'}`);
        console.log(offerFor(c.id, res) || `✔ ${c.name} is ready here.`);
        return;
      }
      for (const [t] of capabilityLines(res)) console.log(t);
    });
}
