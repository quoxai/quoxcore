/**
 * quox claude / codex / gemini / run / sessions: governed tmux sessions. The runner
 * lives in core/governedSession.js; this file holds argument parsing and the
 * commander wiring. argv arrays only; user input never reaches a shell string.
 */
import * as gs from '../core/governedSession.js';
import { validateName, PROGRAMS } from '../core/governedSession.js';
import { gatherReport } from '../core/liveSessionsReport.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { formatOutput } from '../core/output.js';
import { resolveOrgId } from './helpers.js';

export {
  validateName, autoName, planLaunch, parseSessions, renderIntro, runKill, runLs, runAttach,
} from '../core/governedSession.js';

/**
 * Split raw args after `quox claude`: strip quox's own --no-tmux, --as <agent>
 * and --slot <name> (also --as=x / --slot=x; consumed only before a bare `--`),
 * find --resume <name> (else -n/--name). Claude's own --agent is NOT ours and
 * passes through verbatim, as does everything else, in order.
 */
export function parseClaudeArgs(raw) {
  let noTmux = false;
  let as;
  let slot;
  const args = [];
  let past = false;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (past) { args.push(a); continue; }
    if (a === '--') { past = true; args.push(a); continue; }
    if (a === '--no-tmux') noTmux = true;
    else if ((a === '--as' || a === '--slot') && raw[i + 1] && !raw[i + 1].startsWith('-')) {
      if (a === '--as') as = raw[i + 1]; else slot = raw[i + 1];
      i++;
    } else if (a.startsWith('--as=') && a.length > 5) as = a.slice(5);
    else if (a.startsWith('--slot=') && a.length > 7) slot = a.slice(7);
    else args.push(a);
  }
  let name;
  let resume = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a === '--resume' || a === '-r') {
      resume = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) name = args[i + 1];
      break;
    }
    if (a.startsWith('--resume=')) {
      resume = true;
      name = a.slice('--resume='.length) || undefined;
      break;
    }
  }
  // Claude's own -n/--name also names the tmux session, so a session started
  // as `quox claude -n VULCAN` comes back with `quox claude --resume VULCAN`.
  if (!resume) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') break;
      if ((a === '-n' || a === '--name') && args[i + 1] && !args[i + 1].startsWith('-')) { name = args[i + 1]; break; }
      if (a.startsWith('--name=')) { name = a.slice('--name='.length) || undefined; break; }
    }
  }
  if (name !== undefined && !validateName(name)) name = undefined;
  return { args, name, resume, noTmux, as, slot };
}

/**
 * quox codex <args>: verbatim to `codex`. Codex has no --resume flag; it
 * resumes with the subcommand `codex resume [SESSION_ID|NAME]`, so
 * `quox codex resume NAME` names the tmux session after NAME.
 */
export function parseCodexArgs(raw) {
  let noTmux = false;
  const args = [];
  for (const a of raw) {
    if (a === '--no-tmux') noTmux = true;
    else args.push(a);
  }
  let name;
  let resume = false;
  if (args[0] === 'resume') {
    resume = true;
    if (args[1] && !args[1].startsWith('-') && validateName(args[1])) name = args[1];
  }
  return { args, name, resume, noTmux };
}

/** `--as` / `--slot` become the preattach request that runGoverned exports as QUOX_PREATTACH_*. */
export const runClaude = ({ as, slot, ...opts } = {}, over) => gs.runGoverned({
  ...opts,
  program: 'claude',
  ...(as || slot ? { preattach: { agent: as, slot, session: opts.name } } : {}),
}, over);
/**
 * quox gemini <args>: verbatim to `gemini`. Gemini resumes by index or
 * "latest" (`--resume latest`, `-r 5`), not by name, so the tmux session is
 * auto-named; reattach with `quox sessions attach NAME`.
 */
export function parseGeminiArgs(raw) {
  let noTmux = false;
  const args = [];
  for (const a of raw) {
    if (a === '--no-tmux') noTmux = true;
    else args.push(a);
  }
  const resume = args.some((a) => a === '--resume' || a === '-r' || a.startsWith('--resume='));
  return { args, name: undefined, resume, noTmux };
}

/**
 * quox wrap <program> [args...]: wrap ANY command. Known programs use their
 * registry entry (so `quox wrap codex` == `quox codex`); unknown ones get the
 * generic tag and attach-based resume hint. Args are passed verbatim.
 */
export function parseRunArgs(raw) {
  let noTmux = false;
  const rest = [];
  for (const a of raw) {
    if (a === '--no-tmux' && rest.length === 0) noTmux = true;
    else rest.push(a);
  }
  const [bin, ...args] = rest;
  return { bin, args, noTmux };
}

export function runRun({ bin, args = [], noTmux = false } = {}, over) {
  const known = ['claude', 'codex', 'gemini'].find((k) => PROGRAMS[k].bin === bin);
  if (known) return gs.runGoverned({ program: known, args, noTmux }, over);
  return gs.runGoverned({ program: 'run', bin, args, noTmux }, over);
}

export const runGemini = (opts, over) => gs.runGoverned({ ...opts, program: 'gemini' }, over);
export const runCodex = (opts, over) => gs.runGoverned({ ...opts, program: 'codex' }, over);
export const runTui = (opts, over) => gs.runGoverned({ ...opts, program: 'tui' }, over);
export const runHelp = gs.runHelp;

/** `quox tui --governed [screen] [--name N]`: the inner command is plain `quox tui [screen]`. */
export function runTuiGoverned({ screen, name, noTmux = false } = {}, over) {
  return runTui({ args: screen ? [screen] : [], name, resume: !!name, noTmux }, over);
}

/** True when --help/-h appears before a bare `--` (after it, flags belong to claude). */
export function wantsWrapperHelp(args) {
  for (const a of args) {
    if (a === '--') return false;
    if (a === '--help' || a === '-h') return true;
  }
  return false;
}

export const CLAUDE_WRAPPER_HELP = `Usage: quox claude [options] [-- claude-args...]

Run Claude Code in a governed tmux session that survives sleep and drops.
All other arguments are passed to claude exactly as given.

quox's own flags (consumed here, not passed to claude):
  --as <agent>    start already attached to a Quox agent
  --slot <name>   start already holding a dev slot
  --no-tmux       run claude directly, without tmux
  -n, --name <n>  name the session (also names the tmux session; claude's own flag)
  --resume <n>    resume the named session (claude's own flag)
  -h, --help      show this help

To pass --help (or any flag) through to claude itself:
  quox claude -- --help`;

export function registerClaudeCommands(program, ctx, over) {
  // `quox claude <args>` behaves exactly like `claude <args>`: every arg is
  // forwarded verbatim. Only --no-tmux is quox's own. Management lives in
  // `quox sessions` so it can never collide with claude's own arguments.
  program
    .command('claude')
    .description('Run Claude Code (same arguments as claude) in a tmux session that survives sleep and drops')
    .argument('[args...]', 'passed to claude exactly as given (quox adds only --no-tmux, --as, --slot)')
    .addHelpText('after', `
quox's own flags (consumed here, not passed to claude):
  --as <agent>    start already attached to a Quox agent (quox agent attach <agent> at session start)
  --slot <name>   start already holding a dev slot (talk to it from Discord)
  --no-tmux       run claude directly, without tmux
Claude's own --agent is untouched and passes through to claude.`)
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action((_a, _o, cmd) => {
      const raw = (cmd.parent && cmd.parent.rawArgs) || process.argv;
      const i = raw.indexOf('claude', 2);
      const rest = i >= 0 ? raw.slice(i + 1) : [];
      if (wantsWrapperHelp(rest)) { console.log(CLAUDE_WRAPPER_HELP); process.exitCode = 0; return; }
      const parsed = parseClaudeArgs(rest);
      process.exitCode = runClaude(parsed, over);
    });
  program
    .command('codex')
    .description('Run Codex (same arguments as codex) in a tmux session that survives sleep and drops')
    .argument('[args...]', 'passed to codex exactly as given (quox adds only --no-tmux)')
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action((_a, _o, cmd) => {
      const raw = (cmd.parent && cmd.parent.rawArgs) || process.argv;
      const i = raw.indexOf('codex', 2);
      const parsed = parseCodexArgs(i >= 0 ? raw.slice(i + 1) : []);
      process.exitCode = runCodex(parsed, over);
    });
  program
    .command('gemini')
    .description('Run Gemini CLI (same arguments as gemini) in a tmux session that survives sleep and drops')
    .argument('[args...]', 'passed to gemini exactly as given (quox adds only --no-tmux)')
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action((_a, _o, cmd) => {
      const raw = (cmd.parent && cmd.parent.rawArgs) || process.argv;
      const i = raw.indexOf('gemini', 2);
      process.exitCode = runGemini(parseGeminiArgs(i >= 0 ? raw.slice(i + 1) : []), over);
    });
  program
    .command('wrap')
    .description('Run any program in a governed tmux session: quox wrap <program> [args...]')
    .argument('<program>', 'command name on PATH')
    .argument('[args...]', 'passed to the program exactly as given')
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action((_prog, _args, _opts, cmd) => {
      // Two declared arguments => commander passes (program, args, opts, command).
      const raw = (cmd && cmd.parent && cmd.parent.rawArgs) || process.argv;
      const i = raw.indexOf('wrap', 2);
      const rest = i >= 0 ? raw.slice(i + 1) : [];
      // `quox wrap --help` / `-h` (program position only) shows usage instead
      // of being refused as a program name.
      if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
        cmd.outputHelp();
        return;
      }
      process.exitCode = runRun(parseRunArgs(rest), over);
    });
  const sessions = program.command('sessions').description('Manage Quox tmux sessions (ls, attach, kill)');
  sessions.command('help').description('Show how governed sessions work (also Ctrl-b then h)')
    .option('--wait', 'wait for a key before exiting (used by the popup)')
    .action((o) => {
      process.exitCode = runHelp({ wait: !!o.wait }, over);
    });
  sessions.command('ls').description('List Quox sessions (--all: the org-wide live register)')
    .option('--all', 'list the org-wide register of live sessions from the collector')
    .action(async (o) => {
      if (!o.all) {
        process.exitCode = gs.runLs(over);
        return;
      }
      const { client, auth } = ctx;
      auth.requireAuth();
      const ep = resolveEndpoint('v1.liveSessions.list');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      const rows = (data.sessions || []).map((s) => ({
        NAME: s.name, HOST: s.host, PROGRAM: s.program || '-', TMUX: s.tmux ? 'yes' : 'no',
        SLOT: s.slot || '-', AGENT: s.agent || '-', STREAM: s.stream || '-',
        'LAST-SEEN': s.last_seen_at, LIVE: s.live ? 'yes' : 'no',
      }));
      formatOutput(rows, {
        format: program.opts().output,
        columns: ['NAME', 'HOST', 'PROGRAM', 'TMUX', 'SLOT', 'AGENT', 'STREAM', 'LAST-SEEN', 'LIVE'],
        emptyMessage: 'No sessions registered. Run `quox sessions report` on a dev host.',
        raw: data.sessions || [],
      });
    });
  sessions.command('report').description('Report this host\'s tmux sessions to the org live-session register').action(async () => {
    const { client, auth } = ctx;
    auth.requireAuth();
    const payload = gatherReport();
    if (!payload) {
      process.stderr.write('tmux is not installed; nothing to report.\n');
      process.exitCode = 1;
      return;
    }
    const ep = resolveEndpoint('v1.liveSessions.report');
    const data = await client.post(ep.path, {
      service: ep.service,
      body: { ...payload, org_id: resolveOrgId(auth, program) },
    });
    process.stdout.write(`Reported ${payload.sessions.length} session(s) from ${payload.host} (ended ${data.ended ?? 0}).\n`);
  });
  sessions.command('attach <name>').description('Reattach to a running Quox session').action((name) => {
    process.exitCode = gs.runAttach(name, over);
  });
  sessions.command('kill <name>').description('Kill a Quox session').action((name) => {
    process.exitCode = gs.runKill(name, over);
  });
}
