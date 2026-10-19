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
 * in the quox-discord-pro repo), shown in each subcommand's --help. qdp has no
 * --help handling of its own; before quox#1077 this command hand-rolled arg
 * dispatch and had to intercept --help itself (quox#603). Commander
 * subcommands now answer --help before any action runs.
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

/**
 * qdp verbs that only READ (quox#1077). Each was checked against bin/qdp.mjs:
 * status/instances/bindings print config.json, the pid file and the systemd
 * state; gaps GETs the open support-gap inbox items; health reads the pid and
 * systemd state; doctor GETs the control API /health and Discord's channel,
 * webhook and @me endpoints. None issues PUT/POST/PATCH/DELETE or writes a
 * file. bind, unbind and provision PUT/DELETE bindings and create channels.
 */
export const DISCORD_READ_VERBS = ['status', 'instances', 'bindings', 'gaps', 'health', 'doctor'];
export const DISCORD_WRITE_VERBS = ['bind', 'unbind', 'provision'];

// No "Usage:" line here: the matrix's --help walker (scripts/matrix/cli-tree.mjs) reads one as the command's usage.
const GENERAL_USAGE = Object.values(VERB_USAGE).map((u) => `  ${u}`).join('\n')
  + '\n\nRun `quox discord <verb> --help` for a single verb\'s usage.';

function runQdp(verb, args = []) {
  if (!fs.existsSync(QDP)) {
    process.stderr.write(
      `Discord Pro control CLI (qdp) not found at ${QDP}\n` +
      'Set QDP_CLI_PATH if it lives elsewhere, or install the quox-discord-pro daemon on this host.\n',
    );
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [QDP, verb, ...args], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`qdp failed to run: ${r.error.message}\n`);
    process.exit(2);
  }
  process.exit(r.status ?? 2);
}

const VERB_DESC = { unbind: 'remove a channel binding', doctor: 'per-binding view/webhook/liveness check (exits non-zero if any binding is broken)' };
const firstLine = (verb) => VERB_DESC[verb] || VERB_USAGE[verb].split('\n')[0].replace(/^qdp \S+(?: [<[][^\]>]*[>\]])*\s+/, '').trim();

/**
 * One commander subcommand per qdp verb (quox#1077). It used to be a single
 * `discord [args...]` leaf, so the CLI leaf policy could only class the whole
 * group, and it classed it write: a read like `quox discord bindings` was held
 * for approval. Per-verb leaves let reads be read and keep bind/unbind/provision
 * write. Commander's own --help runs before any action, so `--help` can never
 * reach qdp and run a mutating verb (quox#603).
 */
export function registerDiscordCommands(program) {
  const discord = program
    .command('discord')
    .description('Quox Discord Pro daemon: status | instances | bindings | gaps | health | doctor | bind | unbind | provision')
    .addHelpText('after', `\nPer-verb usage (each verb shells straight through to qdp):\n${GENERAL_USAGE}`);

  for (const verb of DISCORD_READ_VERBS) {
    discord
      .command(verb)
      .description(firstLine(verb) || verb)
      .addHelpText('after', `\nqdp usage:\n  ${VERB_USAGE[verb]}`)
      .action(() => runQdp(verb));
  }

  const writeArgs = { bind: '<channelId> <mode> [pairs...]', unbind: '<channelId>', provision: '<agentId> [args...]' };
  for (const verb of DISCORD_WRITE_VERBS) {
    const leaf = discord
      .command(`${verb} ${writeArgs[verb]}`);
    // Only provision has a dry run in qdp. Declaring it here keeps it in --help and lets the
    // root guard refuse `discord bind|unbind --dry-run` instead of binding for real.
    if (verb === 'provision') leaf.option('--dry-run', 'print exactly what it WOULD do, change nothing');
    leaf
      .description(firstLine(verb) || verb)
      .addHelpText('after', `\nqdp usage:\n  ${VERB_USAGE[verb]}`)
      // qdp parses its own options (provision --mode/--host/...), so they pass through unchanged.
      .allowUnknownOption(true)
      .action((...a) => {
        const cmd = a[a.length - 1];
        const args = [...cmd.args];
        // --dry-run is also a root quox flag, so commander hands it to the root and it never reaches
        // cmd.args: a requested dry run of provision used to provision for real. Forward it explicitly.
        if (cmd.optsWithGlobals().dryRun && !args.includes('--dry-run')) args.push('--dry-run');
        runQdp(verb, args);
      });
  }
}
