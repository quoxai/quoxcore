/**
 * `quox discord` — Quox Discord Pro from the canonical CLI (quoxcli-parity-gate:
 * nothing ships without quox CLI support).
 *
 * Same principle as `quox done`: this is a thin wrapper over the daemon's own
 * control CLI (`qdp`, quox-discord-pro/bin/qdp.mjs), not a reimplementation.
 * The daemon already exposes status | instances | bindings | bind | unbind |
 * gaps | health over its token-gated loopback control API, and qdp is the one
 * client for it. Two clients for one control surface is how a control surface
 * drifts, so `quox discord <verb>` shells straight through to qdp with the
 * arguments unchanged, and qdp's exit code is passed through.
 *
 * Host-local, like `quox done` shelling to the DoneEngine: the operator CLI
 * runs where the daemon runs (one daemon per QuoxCORE instance). Set
 * QDP_CLI_PATH if qdp lives elsewhere.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QDP = process.env.QDP_CLI_PATH
  || path.join(os.homedir(), 'quox-discord-pro', 'bin', 'qdp.mjs');

/**
 * Per-verb usage, mirrored from qdp.mjs's own header doc block (bin/qdp.mjs
 * in the quox-discord-pro repo). qdp itself has no --help handling of its
 * own, and this command hand-rolls arg dispatch (allowUnknownOption +
 * helpOption(false), see below) rather than commander subcommands, so
 * `--help`/`-h` was previously just another unrecognised arg forwarded
 * straight through to qdp — which silently ran the verb instead of showing
 * help. Worst case for a mutating verb (bind/unbind/provision): "--help"
 * would have actually bound/unbound/provisioned a channel. This map is
 * checked BEFORE qdp is ever spawned so that can't happen (quox#603).
 */
const VERB_USAGE = {
  status: 'qdp status                 daemon liveness, instances, binding count',
  instances: 'qdp instances              configured instances and their targets',
  bindings: 'qdp bindings               every channel binding',
  gaps: 'qdp gaps                   open support-gap items awaiting an official answer',
  health: 'qdp health                 one-line OK/actionable summary',
  doctor: 'qdp doctor                 per-binding view/webhook/liveness check; exits\n'
    + '                            non-zero if any binding is non-functional',
  bind: 'qdp bind <channelId> <mode> [key=value ...]   bind an EXISTING channel',
  unbind: 'qdp unbind <channelId>',
  provision: 'qdp provision <agent-id> [options]   create/reuse a channel AND bind it\n'
    + '    --mode <feed|bridge|team|roundtable>   default: feed\n'
    + '    --channel <name>            default: feed-<agent-id> for feed, <agent-id> otherwise\n'
    + '    --host <hostname-or-ip>     dev server the agent runs on (sets bridge_remote_host)\n'
    + '    --inbox <name>              remote session-mail inbox (default <agent-id>-inbox)\n'
    + '    --outbox <name>             remote outbox (default discord-outbox)\n'
    + '    --two-way                   allow authorised humans to talk back (bridge only)\n'
    + '    --persona <name>            webhook display name (default: titlecased agent id)\n'
    + '    --roster <ids>              roundtable only: comma-separated "id" or "id:role" list\n'
    + '    --dry-run                   print exactly what it WOULD do, change nothing',
};

const GENERAL_USAGE = 'Usage: quox discord <verb> [args...]\n\n'
  + Object.values(VERB_USAGE).map((u) => `  ${u}`).join('\n')
  + '\n\nRun `quox discord <verb> --help` for a single verb\'s usage.';

function printVerbHelp(verb) {
  if (verb && VERB_USAGE[verb]) {
    process.stdout.write(`Usage:\n  ${VERB_USAGE[verb]}\n`);
  } else {
    process.stdout.write(`${GENERAL_USAGE}\n`);
  }
}

export function registerDiscordCommands(program) {
  program
    .command('discord [args...]')
    .description('Quox Discord Pro daemon: status | instances | bindings | bind | unbind | gaps | health')
    .allowUnknownOption(true)
    .helpOption(false)
    .action((args = []) => {
      if (args.includes('--help') || args.includes('-h')) {
        printVerbHelp(args[0]);
        process.exit(0);
      }
      if (!fs.existsSync(QDP)) {
        process.stderr.write(
          `Discord Pro control CLI (qdp) not found at ${QDP}\n` +
          'Set QDP_CLI_PATH if it lives elsewhere, or install the quox-discord-pro daemon on this host.\n',
        );
        process.exit(2);
      }
      const r = spawnSync(process.execPath, [QDP, ...args], { stdio: 'inherit' });
      if (r.error) {
        process.stderr.write(`qdp failed to run: ${r.error.message}\n`);
        process.exit(2);
      }
      process.exit(r.status ?? 2);
    });
}
