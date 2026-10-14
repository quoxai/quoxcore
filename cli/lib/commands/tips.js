/**
 * quox tips [--json]
 *
 * The canned "did you know" tips behind the terminal's /tip (QUOXON-TIPS). Offline: this prints the registry
 * (cli/lib/quoxon/tips.js), not what is ready on your install; the terminal applies the honesty gate
 * (shipped maturity, capabilities contract, /tip-settings) when it shows one. --json (or -o json) is the
 * shape the dashboard and cli.quox.ai reuse.
 */

import { TIPS, tipsJson, tipsReply } from '../quoxon/tips.js';

export function registerTipsCommands(program) {
  program
    .command('tips')
    .description('List the "did you know" tips the terminal shows (/tip); --json for the registry as data')
    .argument('[query...]', 'search the tips by topic or words (like /tips); bare lists every tip')
    .option('--json', 'print the registry as JSON')
    .action((query, opts) => {
      if (opts.json || program.opts().output === 'json') { console.log(JSON.stringify(tipsJson(), null, 2)); return; }
      if (query?.length) { for (const l of tipsReply(query.join(' ')).lines) console.log(l); return; }
      for (const t of TIPS) console.log(`${t.id}  [${t.product} · ${t.tier} · ${t.maturity}]  ${t.text}  Try: ${t.try}`);
    });
}
