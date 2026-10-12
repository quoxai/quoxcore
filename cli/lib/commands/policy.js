/**
 * `quox policy` — the governance compiler from the terminal (OPGOV quox#582).
 *
 * compile: plain-language rule -> deterministic quox-policy.v1 DRAFT, with
 * the compiled policy printed in full for review (a policy nobody read is
 * not governance). arm: moves a reviewed draft to armed; the collector
 * refuses arming without a logged-in human. Honesty: enforcement is phase 3
 * (IMPACT #491) and is NOT wired; an armed policy is a reviewed intent, not
 * yet a running gate, and this command says so.
 */

import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

function isJsonOutput(program) {
  const o = program.opts();
  return o.json === true || o.output === 'json';
}

const NOT_ENFORCED_NOTE = 'note: enforcement is phase 3 (IMPACT #491) and is not wired yet; armed = reviewed intent, not a running gate.';

export function registerPolicyCommands(program, ctx) {
  const { client, auth } = ctx;

  const p = program
    .command('policy')
    .description('Governance compiler: plain-language rule -> reviewed, armable policy (OPGOV)');

  p.command('compile <rule>')
    .description('Compile a plain-language rule to a quox-policy.v1 draft (deterministic grammar; out-of-grammar rules are refused, never approximated)')
    .action(async (rule) => {
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('governance.policy.compile', { orgId });
      try {
        const data = await client.post(ep.path, { service: ep.service, body: { rule } });
        if (isJsonOutput(program)) { console.log(JSON.stringify(data, null, 2)); return; }
        const rec = data.record;
        console.log(`compiled DRAFT ${rec.id} (${rec.policy.effect})`);
        console.log(JSON.stringify(rec.policy, null, 2));
        console.log(`review it, then: quox policy arm ${rec.id}`);
        console.log(NOT_ENFORCED_NOTE);
      } catch (err) {
        const msg = err?.message || String(err);
        if (/422|unknown/i.test(msg)) {
          console.log('NOT COMPILED: the rule is outside the deterministic grammar and was refused rather than approximated.');
        }
        throw err;
      }
    });

  p.command('list')
    .description('List compiled policies for this org')
    .option('--state <s>', 'draft | armed | retired')
    .action(async (opts) => {
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('governance.policy.list', { orgId, state: opts.state });
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) { console.log(JSON.stringify(data, null, 2)); return; }
      const items = data.policies || [];
      if (!items.length) { console.log('No policies. Compile one: quox policy compile "<rule>"'); return; }
      for (const r of items) {
        console.log(`${r.id}  [${r.state}]  ${r.policy?.effect ?? '?'}  ${r.rule_text}${r.approved_by ? `  (armed by ${r.approved_by})` : ''}`);
      }
      console.log(NOT_ENFORCED_NOTE);
    });

  p.command('arm <id>')
    .description('Arm a reviewed draft (requires a logged-in human; service keys are refused by design)')
    .action(async (id) => {
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('governance.policy.arm', { orgId, id });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      if (isJsonOutput(program)) { console.log(JSON.stringify(data, null, 2)); return; }
      const rec = data.record;
      console.log(`ARMED ${rec.id} (${rec.policy.effect}) approved by ${rec.approved_by}`);
      console.log(NOT_ENFORCED_NOTE);
    });
}
