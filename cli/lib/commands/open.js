/**
 * quox open — Resolve quox:// URIs
 *
 * Opens a quox:// URI in the dashboard (browser) or prints the
 * equivalent CLI command.
 *
 * CLI-3f (Stream CLI Phase 3)
 */

import chalk from 'chalk';
import { resolveQuoxUri } from '../core/deeplinks.js';
import { execFile } from 'node:child_process';
import { emitCliEvent } from '../core/aee.js';

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

export function registerOpenCommand(program, ctx) {
  const { config, client } = ctx;

  program
    .command('open')
    .description('Open a quox:// URI in the dashboard or show CLI equivalent')
    .argument('<uri>', 'quox:// URI (e.g., quox://fleet/docker01)')
    .option('--cli', 'show CLI command instead of opening browser')
    .action(async (uri, opts) => {
      const baseUrl = config.getBaseUrl();
      const resolved = resolveQuoxUri(uri, baseUrl);

      if (!resolved) {
        console.error(chalk.red(`Invalid URI: ${uri}`));
        console.error(chalk.dim('Format: quox://<type>/<id> (e.g., quox://fleet/docker01)'));
        process.exitCode = 2;
        return;
      }

      if (opts.cli) {
        console.log(resolved.cliCommand);
      } else {
        console.log(chalk.dim(`Opening ${resolved.dashboardUrl}`));
        openBrowser(resolved.dashboardUrl);
        console.log(chalk.dim(`CLI equivalent: ${resolved.cliCommand}`));
      }

      emitCliEvent(client, {
        command: 'open',
        intent: 'quox.cli.open',
        payload: { uri, type: resolved.type, id: resolved.id },
      });
    });
}
