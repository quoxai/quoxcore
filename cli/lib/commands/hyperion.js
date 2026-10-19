/**
 * `quox hyperion`: everything HYPERION (the governed Proxmox operator, agent id atlas) is doing in one place.
 * Collector route GET /api/v1/proxmox/activity (org-scoped, read only).
 *
 *   quox hyperion [status] [--json]   VMs and who holds them, node load, pool counts, last 5 ops
 *   quox hyperion deck                live full-screen view, refreshes every 10s (q quits, r refreshes)
 */
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { fetchActivity, statusLines, summaryText } from '../core/hyperion.js';

export function registerHyperionCommands(program, ctx) {
  const { client, auth } = ctx;

  const hy = program
    .command('hyperion')
    .description('HYPERION activity: which VMs exist, who holds each and why, node load and recent operations')
    .option('--json', 'print the full JSON response');

  const wantJson = (cmd) => {
    const o = cmd.optsWithGlobals ? cmd.optsWithGlobals() : cmd.opts();
    return Boolean(o.json) || program.opts().output === 'json';
  };

  // An error body is not data: report the status and stop.
  async function show(cmd) {
    auth.requireAuth();
    let data;
    try {
      data = await fetchActivity(client);
    } catch (err) {
      const status = err && (err.status || err.statusCode);
      if (!status) throw err;
      console.error(`HYPERION request failed: HTTP ${status}${err.message ? ` ${err.message}` : ''}`);
      process.exitCode = 1;
      return;
    }
    if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
    printEvent(glyphLine('hyperion', 'activity', { result: summaryText(data) }));
    console.log(statusLines(data).join('\n'));
  }

  hy.action(async (_o, cmd) => show(cmd));

  hy
    .command('status')
    .description('Same as bare `quox hyperion`')
    .option('--json', 'print the full JSON response')
    .action(async (_o, cmd) => show(cmd));

  hy
    .command('deck')
    .description('Live full-screen HYPERION deck (refreshes every 10s; r refreshes, q quits)')
    .action(async () => {
      auth.requireAuth();
      const { launchHyperionDeck } = await import('../hyperion/deck.js');
      await launchHyperionDeck({ activity: () => fetchActivity(client) });
    });
}
