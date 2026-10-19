/**
 * `quox update` (and `quox --update`, rewritten to this in bin/quox.js): update this quox the way it was
 * installed. The same updater as /update in the conversation client (lib/core/selfUpdate.js).
 *
 *   quox update            check, show what's new, ask y/N (a TTY), then run the update with the terminal
 *   quox update --check    check and show, change nothing (exit 10 when an update is available)
 *   quox update --yes      no question (needed when not a TTY)
 */
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { detectInstall, checkUpdate, runUpdate, updateLines, updateAsk } from '../core/selfUpdate.js';

async function askYes(line) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${line} `)).trim()); } finally { rl.close(); }
}

export function registerUpdateCommand(program, ctx = {}) {
  const d = ctx.updateDeps || {};
  const out = d.log || ((l) => console.log(l));
  program.command('update')
    .description('Update quox to the latest version (npm, git checkout, or this box\'s shared CLI); also quox --update')
    .option('--check', 'show what an update would do and change nothing')
    .option('-y, --yes', 'update without asking (needed in a non-interactive shell)')
    .action(async (o) => {
      const info = (d.detect || detectInstall)({});
      const plan = await (d.check || checkUpdate)(info);
      for (const l of updateLines(plan)) out(l);
      if (!plan.ok) { process.exitCode = 2; return; }
      if (plan.upToDate) return;
      if (plan.refused) { process.exitCode = 1; return; }
      if (o.check) { out(`Update with: quox update  (runs: ${plan.command.display})`); process.exitCode = 10; return; }
      const yes = o.yes || program.opts().yes;
      if (!yes) {
        const tty = d.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!tty) { out('Not updated: this needs a yes. Re-run with quox update --yes in a non-interactive shell.'); process.exitCode = 1; return; }
        if (!(await (d.ask || askYes)(updateAsk(plan, { restart: false })))) { out('Not updated. Nothing was changed.'); return; }
      }
      out(chalk.dim(`Running: ${plan.command.display}`));
      const r = (d.run || runUpdate)(plan);
      if (r.ok) { out(chalk.green(`✔ Updated (exit 0). The next quox you start is the new one.`)); return; }
      process.exitCode = r.code || 1;
      out(chalk.red(`✖ Update failed: ${plan.command.display} ${r.error ? `could not start (${r.error})` : `exited ${r.code}`}. Nothing else was changed.`));
      out(`Run it yourself to see why: ${plan.manual}`);
    });
}
