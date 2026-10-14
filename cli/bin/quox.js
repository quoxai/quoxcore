#!/usr/bin/env node
import '../lib/core/prodEnv.js'; // first: production React unless NODE_ENV is set (before anything loads React)

import v8 from 'node:v8';

// CORTEX-BENCH: Node's fetch parses HTTP with a WebAssembly module, and V8
// recompiles it at the optimising tier on a background thread; Node waits for
// that compile before exiting, adding 350-700ms to every short command after
// its output is already printed. The baseline tier is plenty for a CLI.
v8.setFlagsFromString('--liftoff-only');

// Bare `quox` is the conversation (CLI-QUOXON Q3, owner decision): with no
// subcommand and only client flags, a TTY gets the QUOXON client and
// `--print` runs headless. The old 15-item menu is `quox tui`. Decided from
// argv alone, before config or any command module loads.
// R3 D4: raw mode before ANY heavy module loads. The command modules below used to be static imports,
// evaluated before this block, so keys typed in the first ~2 s echoed cooked and an Enter was lost.
{
  const { routesToQuoxon } = await import('../lib/quoxon/route.js');
  const qArgv = process.argv.slice(2);
  if (routesToQuoxon(qArgv, process.stdout.isTTY)) {
    if (!qArgv.some(a => a === '--print' || a.startsWith('--print=') || a === '-h' || a === '--help')) (await import('../lib/quoxon/earlyInput.js')).captureEarlyInput();
    const { main: quoxonMain } = await import('../lib/quoxon/main.js');
    try {
      await quoxonMain(qArgv);
    } catch (err) {
      console.error(err?.message || err);
      process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
  }
}

// The commander CLI: loaded only when the conversation client is not (see the block above).
const { Command } = await import('commander');
const { loadConfig, resolveProfileFlagFromArgv } = await import('../lib/core/config.js');
const { resolveCliVersion, BASE_VERSION } = await import('../lib/core/version.js');
const { mergeShadowedGlobals } = await import('../lib/core/global-flags.js');
const { createAuth } = await import('../lib/core/auth.js');
const { extractActingAs } = await import('../lib/core/actingAs.js');
const { createClient } = await import('../lib/core/client.js');
const { handleError } = await import('../lib/core/errors.js');
const { assertOrgOverrideSafe, commandPath } = await import('../lib/core/org-override.js');
// QUOXIFY pass 2 (DEVSUITE phase 15): the two dev-suite members that had no
// unified verb at all. Gripe's own definition of done named `quox gripe`.
const { generateCompletion } = await import('../lib/core/completions.js');
const { loadAllPlugins } = await import('../lib/plugins/loader.js');
const { registerCommandGroups } = await import('../lib/core/lazyCommands.js');

// #610: --version must reflect the ACTUAL running commit, not a frozen literal
// (the global CLI worktree was silently 32 commits behind and --version never
// showed it). The git-backed resolution lives in ../lib/core/version.js, shared
// with `quox doctor` so the two never disagree. Resolving the commit needs a
// git read, so only pay that cost when --version/-V is actually requested —
// every other command stays zero-cost by keeping the argv guard HERE (the
// shared resolver has none, because doctor wants the facts unconditionally).
const versionRequested = process.argv.includes('--version') || process.argv.includes('-V');

const program = new Command();

program
  .name('quox')
  .description('QuoxCORE CLI — manage agents, workflows, memory, fleet, and more')
  .version(versionRequested ? resolveCliVersion() : BASE_VERSION)
  .option('-o, --output <format>', 'output format: table, json, csv, quiet', 'table')
  .option('--json', 'shorthand for --output json')
  .option('-q, --quiet', 'suppress output, show IDs only')
  .option('--org <slug>', 'override active organization')
  .option('-p, --profile <name>', 'use a specific config profile')
  .option('--no-color', 'disable colored output')
  .option('-v, --verbose', 'show detailed output')
  .option('--debug', 'show HTTP request/response details')
  .option('--dry-run', 'show what would happen without executing')
  .option('-y, --yes', 'skip confirmation prompts')
  .option('--insecure', 'allow self-signed SSL certificates')
  .addHelpText('after', '\nConversation (QUOXON client):\n  quox                                  interactive conversation (terminal only)\n  quox --print "<prompt>" [--output text|json] [--conversation <id>] [--timeout <s>]   one headless turn; exit 0 completed, 2 held for approval, 3 interrupted, 4 not signed in, 5 unconfirmed\n  quox --demo                           simulated journey, nothing real runs\n');

// Wire up global flags
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.json) opts.output = 'json';
  if (opts.quiet) opts.output = 'quiet';
});

// A subcommand that redeclares a root flag (--yes, --org, --json, --dry-run)
// never receives it: commander resolves against the root first and the
// subcommand reads undefined forever. See lib/core/global-flags.js for the
// 13 places this had already shipped, including --dry-run executing for real.
program.hook('preAction', (thisCommand, actionCommand) => {
  mergeShadowedGlobals(thisCommand, actionCommand);
});

// GRIPE-709: --org must be honoured or refused, never silently ignored.
program.hook('preAction', (thisCommand, actionCommand) => {
  assertOrgOverrideSafe({
    override: thisCommand.opts().org,
    authData: config.getAuth?.() || null,
    hasUserToken: Boolean(auth.getTokens?.()?.access_token),
    command: commandPath(actionCommand),
  });
});

// Handle --insecure and --no-color before anything runs
// QUOX_INSECURE=1 is the env twin of --insecure: dev-server wrappers set it
// because the LAN dashboard proxy serves a self-signed cert and requiring
// --insecure on every verb is a papercut (DEVSUITE phase 8). Same warning,
// same mechanism, so it is never silent.
if (process.argv.includes('--insecure') || process.env.QUOX_INSECURE === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.error('\x1b[33mWARNING: TLS certificate verification disabled (--insecure)\x1b[0m');
}
if (process.argv.includes('--no-color') || process.env.NO_COLOR) {
  process.env.FORCE_COLOR = '0';
}

// Build shared context
// program.opts() is EMPTY here (parse() runs later) — the -p flag must come
// from the argv pre-scan or it silently falls back to activeProfile.
// quox#772: fold a global `--as <agent>` into QUOX_AS (flag wins) and strip it
// from argv before commander sees it (linkedin/claude own their own --as).
{
  const acting = extractActingAs(process.argv.slice(2), process.env);
  if (acting.name) {
    // flag vs env matters to `whoami` only: record the origin (flag wins).
    const fromFlag = extractActingAs(process.argv.slice(2), {}).name;
    process.env.QUOX_AS = acting.name;
    process.env.QUOX_AS_FLAG = fromFlag ? '1' : '0';
  }
  process.argv = [...process.argv.slice(0, 2), ...acting.argv];
}
const config = loadConfig(resolveProfileFlagFromArgv(process.argv.slice(2)));
const auth = createAuth(config);
const client = createClient(config, auth);
const ctx = { config, auth, client, program };

// Register all command groups
// Command groups, in registration order. CORTEX-BENCH (quox#7xx CLI startup):
// importing all 86 modules cost ~1s on EVERY invocation, including each
// attached-agent `quox agent exec` tool call. They now load lazily: only the
// module(s) that define the command being run (see lib/core/lazyCommands.js),
// with a full load whenever the command is unknown, help is asked for, or the
// lazy path fails. A miss can only be slower, never wrong.
const { COMMAND_REGISTRARS, COMMAND_REGISTRARS_BASE } = await import('../lib/core/commandRegistrars.js');
await registerCommandGroups(program, ctx, COMMAND_REGISTRARS, process.argv.slice(2), COMMAND_REGISTRARS_BASE);

// TUI command
program
  .command('tui')
  .argument('[screen]', 'Open directly on a screen (fleet, agents, tools, orgs, memory, brain, workflows, chat, admin, files, backups, objectives, inbox, vault, governance, health)')
  .option('--governed', 'Run the TUI in a Quox governed tmux session (survives sleep and drops)')
  .option('--name <name>', 'Session name for --governed (reattaches if it is already running)')
  .option('--no-tmux', 'With --governed: skip tmux')
  .description('Launch the classic menu TUI (bare `quox` opens the conversation)')
  .action(async (screen, opts) => {
    if (opts && opts.governed) {
      const { runTuiGoverned } = await import('../lib/commands/claude.js');
      process.exitCode = runTuiGoverned({ screen, name: opts.name, noTmux: opts.tmux === false });
      return;
    }
    const { launchTUI } = await import('../lib/tui/index.js');
    await launchTUI(ctx, { initialScreen: screen });
  });

// Shell completion command
program
  .command('completion <shell>')
  .description('Generate shell completions (bash, zsh, fish)')
  .action((shell) => {
    process.stdout.write(generateCompletion(shell));
  });

// Load plugins (non-blocking — errors are logged, not thrown)
try {
  const { loaded, errors } = await loadAllPlugins(program, ctx);
  if (program.opts().debug && loaded.length > 0) {
    console.error(`Loaded ${loaded.length} plugin(s): ${loaded.map(p => p.name).join(', ')}`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`Plugin "${e.name}" failed: ${e.error}`);
    }
  }
} catch {
  // Plugin loading should never crash the CLI
}

// C4: once a day, warn when this CLI and the server differ in major/minor. Never for JSON/quiet output,
// a non-TTY stderr, or `quox server …` itself (that verb shows versions); never fails a command.
async function warnVersionSkew() {
  try {
    const o = program.opts();
    if (o.output === 'json' || o.output === 'quiet' || o.json || o.quiet || !process.stderr.isTTY || process.env.QUOX_NO_SKEW_CHECK) return;
    const first = process.argv.slice(2).find((a) => !a.startsWith('-'));
    if (!first || first === 'server') return;
    const { checkSkewOncePerDay } = await import('../lib/server/skew.js');
    const sk = await checkSkewOncePerDay({ collectorUrl: config.getServiceUrl('collector') });
    if (sk) process.stderr.write(`\u26a0 version skew: ${sk.message}\n`);
  } catch { /* advisory only */ }
}

// Bare `quox` in a TTY never reaches here (routed to QUOXON above); bare
// non-TTY prints the banner so a script never hangs.
{
  try {
    if (process.argv.length <= 2) {
      // Bare `quox`: the splash, not a help dump (DEVSUITE-GLYPH).
      const { printBanner } = await import('../lib/core/banner.js');
      let loggedIn = true;
      try { loggedIn = !!auth.isLoggedIn(); } catch { /* banner must never fail */ }
      printBanner(program.version(), { loggedIn });
      process.exit(0);
    }
    await program.parseAsync(process.argv);
    await warnVersionSkew();
  } catch (err) {
    handleError(err, program.opts().output);
    process.exit(err.exitCode || 1);
  }
}
