#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, resolveProfileFlagFromArgv } from '../lib/core/config.js';
import { resolveCliVersion, BASE_VERSION } from '../lib/core/version.js';
import { mergeShadowedGlobals } from '../lib/core/global-flags.js';
import { createAuth } from '../lib/core/auth.js';
import { extractActingAs } from '../lib/core/actingAs.js';
import { createClient } from '../lib/core/client.js';
import { handleError } from '../lib/core/errors.js';
import { assertOrgOverrideSafe, commandPath } from '../lib/core/org-override.js';
// QUOXIFY pass 2 (DEVSUITE phase 15): the two dev-suite members that had no
// unified verb at all. Gripe's own definition of done named `quox gripe`.
import { generateCompletion } from '../lib/core/completions.js';
import { loadAllPlugins } from '../lib/plugins/loader.js';
import { registerCommandGroups } from '../lib/core/lazyCommands.js';
import v8 from 'node:v8';

// CORTEX-BENCH: Node's fetch parses HTTP with a WebAssembly module, and V8
// recompiles it at the optimising tier on a background thread; Node waits for
// that compile before exiting, adding 350-700ms to every short command after
// its output is already printed. The baseline tier is plenty for a CLI.
v8.setFlagsFromString('--liftoff-only');

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
  .option('--insecure', 'allow self-signed SSL certificates');

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
const COMMAND_REGISTRARS = [
  ['../lib/commands/auth.js', 'registerAuthCommands'],
  ['../lib/commands/service.js', 'registerServiceCommands'],
  ['../lib/commands/status.js', 'registerStatusCommand'],
  ['../lib/commands/doctor.js', 'registerDoctorCommand'],
  ['../lib/commands/open.js', 'registerOpenCommand'],
  ['../lib/commands/config-cmd.js', 'registerConfigCommands'],
  ['../lib/commands/org.js', 'registerOrgCommands'],
  ['../lib/commands/invites.js', 'registerInvitesCommands'],
  ['../lib/commands/team.js', 'registerTeamCommands'],
  ['../lib/commands/department.js', 'registerDepartmentCommands'],
  ['../lib/commands/agent.js', 'registerAgentCommands'],
  ['../lib/commands/tool.js', 'registerToolCommands'],
  ['../lib/commands/workflow.js', 'registerWorkflowCommands'],
  ['../lib/commands/objective.js', 'registerObjectiveCommands'],
  ['../lib/commands/assistant.js', 'registerAssistantCommands'],
  ['../lib/commands/fleet.js', 'registerFleetCommands'],
  ['../lib/commands/chat.js', 'registerChatCommands'],
  ['../lib/commands/memory.js', 'registerMemoryCommands'],
  ['../lib/commands/brain.js', 'registerBrainCommands'],
  ['../lib/commands/entity.js', 'registerEntityCommands'],
  ['../lib/commands/backup.js', 'registerBackupCommands'],
  ['../lib/commands/inbox.js', 'registerInboxCommands'],
  ['../lib/commands/mail.js', 'registerMailCommands'],
  ['../lib/commands/calendar.js', 'registerCalendarCommands'],
  ['../lib/commands/notes.js', 'registerNotesCommands'],
  ['../lib/commands/contacts.js', 'registerContactsCommands'],
  ['../lib/commands/licence.js', 'registerLicenceCommands'],
  ['../lib/commands/run.js', 'registerRunCommands'],
  ['../lib/commands/file.js', 'registerFileCommands'],
  ['../lib/commands/admin.js', 'registerAdminCommands'],
  ['../lib/commands/aee.js', 'registerAeeCommands'],
  ['../lib/commands/integration.js', 'registerIntegrationCommands'],
  ['../lib/commands/consent.js', 'registerConsentCommands'],
  ['../lib/commands/setup.js', 'registerSetupCommands'],
  ['../lib/commands/watch.js', 'registerWatchCommands'],
  ['../lib/commands/tag.js', 'registerTagCommands'],
  ['../lib/commands/scope.js', 'registerScopeCommands'],
  ['../lib/commands/notification.js', 'registerNotificationCommands'],
  ['../lib/commands/prompt.js', 'registerPromptCommands'],
  ['../lib/commands/plugin.js', 'registerPluginCommands'],
  ['../lib/commands/powers.js', 'registerPowersCommands'],
  ['../lib/commands/conversation.js', 'registerConversationCommands'],
  ['../lib/commands/vault.js', 'registerVaultCommands'],
  ['../lib/commands/volt.js', 'registerVoltCommands'],
  ['../lib/commands/governance.js', 'registerGovernanceCommands'],
  ['../lib/commands/skills.js', 'registerSkillsCommands'],
  ['../lib/commands/claude.js', 'registerClaudeCommands'],
  ['../lib/commands/monitoring.js', 'registerMonitoringCommands'],
  ['../lib/commands/trigger.js', 'registerTriggerCommands'],
  ['../lib/commands/webhook.js', 'registerWebhookCommands'],
  ['../lib/commands/sso.js', 'registerSsoCommands'],
  ['../lib/commands/role.js', 'registerRoleCommands'],
  ['../lib/commands/domain.js', 'registerDomainCommands'],
  ['../lib/commands/security.js', 'registerSecurityCommands'],
  ['../lib/commands/safety.js', 'registerSafetyCommands'],
  ['../lib/commands/scim.js', 'registerScimCommands'],
  ['../lib/commands/llm-policy.js', 'registerLlmPolicyCommands'],
  ['../lib/commands/hat.js', 'registerHatCommands'],
  ['../lib/commands/settings.js', 'registerSettingsCommands'],
  ['../lib/commands/llm.js', 'registerLlmCommands'],
  ['../lib/commands/quoxchat.js', 'registerQuoxchatCommands'],
  ['../lib/commands/budget.js', 'registerBudgetCommands'],
  ['../lib/commands/trace.js', 'registerTraceCommands'],
  ['../lib/commands/mon.js', 'registerMonCommands'],
  ['../lib/commands/quoxbox.js', 'registerQuoxboxCommands'],
  ['../lib/commands/plan.js', 'registerPlanCommands'],
  ['../lib/commands/engagement.js', 'registerEngagementCommands'],
  ['../lib/commands/done.js', 'registerDoneCommands'],
  ['../lib/commands/discord.js', 'registerDiscordCommands'],
  ['../lib/commands/qlarity.js', 'registerQlarityCommands'],
  ['../lib/commands/reach.js', 'registerReachCommands'],
  ['../lib/commands/inventory.js', 'registerInventoryCommands'],
  ['../lib/commands/policy.js', 'registerPolicyCommands'],
  ['../lib/commands/quoxseo.js', 'registerQuoxseoCommands'],
  ['../lib/commands/voice.js', 'registerVoiceCommands'],
  ['../lib/commands/awareness.js', 'registerAwarenessCommands'],
  ['../lib/commands/lucid.js', 'registerLucidCommands'],
  ['../lib/commands/tg.js', 'registerTgCommands'],
  ['../lib/commands/dev.js', 'registerDevCommands'],
  ['../lib/commands/build.js', 'registerBuildCommands'],
  ['../lib/commands/slot.js', 'registerSlotCommands'],
  ['../lib/commands/gripe.js', 'registerGripeCommands'],
  ['../lib/commands/nucleus.js', 'registerNucleusCommands'],
  ['../lib/commands/onboard.js', 'registerOnboardCommands'],
  ['../lib/commands/x.js', 'registerXCommands'],
  ['../lib/commands/linkedin.js', 'registerLinkedInCommands'],
  ['../lib/commands/facebook.js', 'registerFacebookCommands'],
  ['../lib/commands/instagram.js', 'registerInstagramCommands'],
  ['../lib/commands/tiktok.js', 'registerTikTokCommands'],
];
await registerCommandGroups(program, ctx, COMMAND_REGISTRARS, process.argv.slice(2), import.meta.url);

// TUI command
program
  .command('tui')
  .argument('[screen]', 'Open directly on a screen (fleet, agents, tools, orgs, memory, brain, workflows, chat, admin, files, backups, objectives, inbox, vault, governance, health)')
  .option('--governed', 'Run the TUI in a Quox governed tmux session (survives sleep and drops)')
  .option('--name <name>', 'Session name for --governed (reattaches if it is already running)')
  .option('--no-tmux', 'With --governed: skip tmux')
  .description('Launch interactive TUI')
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

// Auto-launch TUI when no args and running in a terminal
if (process.argv.length <= 2 && process.stdout.isTTY) {
  try {
    const { launchTUI } = await import('../lib/tui/index.js');
    await launchTUI(ctx);
  } catch (err) {
    handleError(err, 'table');
    process.exit(err.exitCode || 1);
  }
} else {
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
  } catch (err) {
    handleError(err, program.opts().output);
    process.exit(err.exitCode || 1);
  }
}
