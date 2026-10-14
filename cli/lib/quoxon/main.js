import React from 'react';
import { render } from 'ink';
import { realpathSync } from 'node:fs';
import { App } from './app.js';
import { inkRenderOptions, inkStdout } from './term.js';
import { createDemoApi } from './demo.js';
import { DEMO_LABEL } from './demo.fixtures.js';
import { AUTOPLAY_LABEL, autoplayOn } from './demo.autoplay.js';
import { captureEarlyInput } from './earlyInput.js';
import { shouldShowWelcome, markWelcomeSeen } from './welcome.js';
import { loadRules, rulesContext } from './rules.js';
import { createTranscript } from './transcript.js';
import { parseModelArg } from './model.js';
import { applySettings } from './slash/settings.js';
import { headOf, RUNNING_ROOT, execRestart, checkRestart } from './slash/restart.js';
import { readLastSeen, writeLastSeen } from './away.js';

const FLAGS = new Set(['-p', '--profile', '--verbose', '--demo', '--print', '--output', '--conversation', '--turn-id', '--timeout', '--color', '--no-clear', '-n', '--name', '--service-key', '--demo-onboarding', '--autoplay', '--autoplay-exit', '--provider', '--model', '--agent', '--prompt-profile', '--resume', '-h', '--help', '--']);
const isFlag = (a) => FLAGS.has(a) || /^--(profile|verbose|print|output|conversation|turn-id|timeout|provider|model|agent|prompt-profile|resume)=/.test(a);

export function parseArgs(argv) {
  const o = { profile: null, verbose: 'on', demo: false, help: false, print: false, prompt: null, output: 'text', conversation: null, turnId: null, timeout: 0, color: false, noClear: false, name: null, serviceKey: false, demoOnboarding: false, autoplay: false, autoplayExit: null, provider: null, agent: null, resume: null, verboseSet: false, errors: [] };
  let rawProvider = null, rawModel = null;
  const value = (flag, i) => { const v = argv[i + 1]; if (v === undefined || (v.startsWith('-') && isFlag(v))) { o.errors.push(`${flag} needs a value`); return undefined; } return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { const rest = argv.slice(i + 1).join(' '); if (rest) o.prompt = rest; break; }
    if (a === '-p' || a === '--profile') { const v = value(a, i); if (v !== undefined) { o.profile = v; i++; } }
    else if (a.startsWith('--profile=')) o.profile = a.slice(10);
    else if (a === '--verbose') { o.verboseSet = true; const v = argv[i + 1]; if (['off', 'on', 'full'].includes(v)) { o.verbose = v; i++; } else o.verbose = 'on'; } // no value means on
    else if (a.startsWith('--verbose=')) { o.verboseSet = true; o.verbose = a.slice(10); }
    else if (a === '--resume') { const v = argv[i + 1]; if (v !== undefined && !v.startsWith('-')) { o.resume = v; i++; } else o.resume = true; } // alone: the picker
    else if (a.startsWith('--resume=')) o.resume = a.slice(9) || true;
    else if (a === '-n' || a === '--name') { const v = value(a, i); if (v !== undefined) { o.name = v; i++; } }
    else if (a.startsWith('--name=')) o.name = a.slice(7);
    else if (a === '--demo') o.demo = true;
    else if (a === '--autoplay') o.autoplay = true;
    else if (a === '--autoplay-exit') { o.autoplay = true; const v = argv[i + 1]; if (v !== undefined && /^\d+(\.\d+)?$/.test(v)) { o.autoplayExit = Number(v); i++; } else o.autoplayExit = 5; } // seconds to hold the final frame
    else if (a === '--demo-onboarding') o.demoOnboarding = true;
    else if (a === '--print') { o.print = true; const n = argv[i + 1]; if (n !== undefined && !isFlag(n)) { o.prompt = n; i++; } }
    else if (a.startsWith('--print=')) { o.print = true; o.prompt = a.slice(8); }
    else if (a === '--output') { const v = value(a, i); if (v !== undefined) { o.output = v; i++; } }
    else if (a.startsWith('--output=')) o.output = a.slice(9);
    else if (a === '--conversation') { const v = value(a, i); if (v !== undefined) { o.conversation = v; i++; } }
    else if (a === '--agent') { const v = value(a, i); if (v !== undefined) { o.agent = v; i++; } }
    else if (a.startsWith('--agent=')) o.agent = a.slice(8) || null;
    else if (a === '--turn-id') { const v = value(a, i); if (v !== undefined) { o.turnId = v; i++; } }
    else if (a === '--timeout') { const v = value(a, i); if (v !== undefined) { o.timeout = Number(v) || 0; i++; } }
    else if (a === '--color') o.color = true;
    else if (a === '--no-clear') o.noClear = true;
    else if (a === '--service-key') o.serviceKey = true;
    else if (a === '--provider' || a === '--model') { const v = value(a, i); if (v !== undefined) { if (a === '--provider') rawProvider = v; else rawModel = v; i++; } }
    else if (a.startsWith('--provider=')) rawProvider = a.slice(11);
    else if (a.startsWith('--model=')) rawModel = a.slice(8);
    else if (a === '--prompt-profile') { const v = value(a, i); if (v !== undefined) { o.promptProfile = v; i++; } }
    else if (a.startsWith('--prompt-profile=')) o.promptProfile = a.slice(17);
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!a.startsWith('-') && o.prompt === null && argv.includes('--print')) o.prompt = a; // `--print` given earlier or later; this is its prompt
    else o.errors.push(a.startsWith('-') ? `unknown option ${a}` : `unexpected argument ${a}`);
  }
  if (rawModel && !rawProvider) o.errors.push('--model needs --provider (e.g. --provider openai --model gpt-5.4)');
  else if (rawProvider) {
    const m = parseModelArg(rawModel ? `${rawProvider} ${rawModel}` : rawProvider);
    if (!m.ok) o.errors.push(m.error); else o.provider = m.choice || 'auto'; // 'auto' = this run ignores the saved /model choice
  }
  if (o.promptProfile !== undefined && !['compact', 'full'].includes(o.promptProfile)) { o.errors.push(`invalid --prompt-profile "${o.promptProfile}" (use compact or full)`); delete o.promptProfile; }
  if (!['off', 'on', 'full'].includes(o.verbose)) o.verbose = 'on';
  if (!['text', 'json'].includes(o.output)) { o.errors.push(`invalid --output "${o.output}" (use text or json)`); o.output = 'text'; }
  return o;
}

export const USAGE = 'quox [-p|--profile <name>] [-n|--name <session name>] [--conversation <id>] [--resume [id|name]] [--verbose off|on|full] [--demo [--autoplay [--autoplay-exit [s]]]] [--no-clear] [--service-key] [--provider openai|anthropic|ollama|openrouter|huggingface|groq|together|lmstudio|vllm|custom|auto [--model <id>]]   (quoxon is an alias; the old menu is `quox tui`)\n  quox --conversation <id>   resume that conversation interactively (its saved turns load into the window)\n  quox --resume [id|name]   pick up a recent conversation; alone it opens a picker\n  quox --print "<prompt>" [--output text|json] [--conversation <id>] [--turn-id <id>] [--timeout <s>] [--agent <id>] [--provider <p> [--model <id>]] [--prompt-profile compact|full]   (prompt from stdin if absent or -; use -- before a prompt that starts with -)\n  exit: 0 completed, 1 other, 2 held for approval, 3 interrupted or abandoned, 4 not signed in, 5 ended without server confirmation\n  --provider asks the server for that provider this run (default: your /model choice for this profile, else auto); turn.started from the server says what ran\n  --service-key lets chat use an ambient QUOX_SERVICE_KEY when the profile has no login (never used silently)\n  --demo plays a simulated journey on its own (no server, nothing real runs)\n  --autoplay (with --demo, or QUOX_DEMO_AUTOPLAY=1) plays the whole journey with no input on a fixed script; --autoplay-exit [s] quits s seconds (default 5) after the last frame\n  --demo-onboarding walks Getting started with a dry-run install (nothing is downloaded, built or started)';

/** Default profile: a resident (agent) login cannot chat, so use the single logged-in human profile. */
export function pickProfile(explicit, cfgMod, env = process.env) {
  if (explicit) return { name: explicit, note: null };
  if (env.QUOX_PROFILE) return { name: env.QUOX_PROFILE, note: null }; // an explicit one-shot choice (same as -p), never "the default profile"

  const probe = cfgMod.loadConfig();
  const active = probe.getActiveProfileName?.();
  const residents = new Set((probe.listResidentProfiles?.() || []).map(r => r.name));
  return choosePick(active, residents, probe.listProfiles?.() || []);
}
export function choosePick(active, residents, profiles) {
  if (!residents.has(active)) return { name: undefined, note: null };
  const humans = profiles.filter(p => !residents.has(p.name) && p.loggedIn);
  if (humans.length === 1) return { name: humans[0].name, note: null }; // the status line shows the profile; no transcript noise
  const names = profiles.filter(p => !residents.has(p.name) && p.loggedIn).map(p => p.name);
  const hint = names.length ? ` Pass -p <your profile>. Human profiles found: ${names.join(', ')} (start with: quox -p ${names[0]}).` : ' Pass -p <your profile>.';
  return { name: undefined, note: `The default profile "${active}" is an agent login, so this chat runs as the agent, not as a person.${hint}` };
}

/**
 * Chat identity gate. A named profile that does not exist is an error (never created on the fly), and an
 * ambient QUOX_SERVICE_KEY is only a credential when the user asked for it (--service-key or FORCE).
 * -> null when chat may proceed, else { message }.
 */
export function chatCredentialProblem({ profileArg, profiles, hasStoredLogin, profileName, env = process.env, serviceKeyFlag = false }) {
  if (profileArg && !profiles.some(p => p.name === profileArg)) return { message: `profile ${profileArg} does not exist; create it with: quox login -p ${profileArg}` };
  if (hasStoredLogin) return null;
  if ((serviceKeyFlag || env.QUOX_FORCE_SERVICE_KEY) && env.QUOX_SERVICE_KEY) return null;
  return { message: `Not signed in for chat on profile ${profileName}. Run: quox login -p ${profileName}${env.QUOX_SERVICE_KEY ? ' (an ambient QUOX_SERVICE_KEY is ignored unless you pass --service-key)' : ''}` };
}

/**
 * Is this a machine with no Quox server configured at all? Then bare `quox` is Getting started, and --print
 * says how to get there. Reads profiles only (no network).
 */
export async function noServerConfigured(opts, cfgMod, env = process.env) {
  const { needsGettingStarted } = await import('./onboarding/detect.js');
  const { loadJourney } = await import('./onboarding/journey.js');
  const probe = cfgMod.loadConfig();
  return needsGettingStarted({ profiles: probe.listProfiles?.() || [], residents: probe.listResidentProfiles?.() || [], profileArg: opts.profile, env, serviceKeyFlag: opts.serviceKey, journey: loadJourney() });
}

/** --print without a usable login: today's message, plus the way in when no server exists yet. */
export function printAuthMessage(problem, gettingStarted, hint) {
  return `quox: ${problem.message}\n${gettingStarted ? `quox: ${hint}\n` : ''}`;
}

export { captureEarlyInput } from './earlyInput.js';

/**
 * Clear the screen before the chat client? Never right after Getting started: its finale (the one-time
 * dashboard link, a password shown once) is on screen and in scrollback, and ESC[3J would erase both.
 */
export function shouldClearBeforeChat({ isTTY, noClear, fromGettingStarted }) {
  return Boolean(isTTY) && !noClear && !fromGettingStarted;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  // Raw mode FIRST: the awaits below (module loads, config, health) must not leave the tty cooked.
  // bin/quox.js already turned it on before loading anything heavy; this returns that same capture.
  const early = !opts.print ? captureEarlyInput() : null;
  if (opts.help) { early?.release(); console.log(USAGE); return; }
  if (opts.errors.length) { early?.release(); process.stderr.write(`quox: ${opts.errors.join('; ')}\n${USAGE}\n`); process.exitCode = 1; return; }
  const cwd = process.cwd().replace(process.env.HOME || '\0', '~');
  const { resolveCliVersion } = await import('../core/version.js');
  let version = '0.3.0';
  try { version = resolveCliVersion?.() || version; } catch { /* keep default */ }
  if (opts.print) return mainPrint(opts);
  let replay = null;
  let fromGettingStarted = false;
  if (opts.demoOnboarding || (!opts.demo && await noServerConfigured(opts, await import('../core/config.js')))) {
    // Getting started (FIRST_RUN_JOURNEY.md C2a): a separate view, never the chat client talking.
    if (process.stdout.isTTY && !opts.noClear) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    const welcome = shouldShowWelcome({ print: false });
    if (welcome && !opts.demoOnboarding) markWelcomeSeen();
    const { runGettingStarted } = await import('./onboarding/index.js');
    const r = await runGettingStarted({ version, cwd, welcome, earlyInput: early, demo: opts.demoOnboarding });
    if (r?.action !== 'connected') return;
    // signed in (an existing server, or the one just installed): carry on into the conversation,
    // and a fresh install replays the original request as the first real turn
    replay = r.replay || null;
    fromGettingStarted = true;
  }
  let props;
  let restart = null; // set by /restart: run the installed quox here once the app has let go of the terminal
  if (opts.demo) {
    const auto = autoplayOn(opts.autoplay) ? { exitAfterMs: opts.autoplayExit != null ? opts.autoplayExit * 1000 : (process.env.QUOX_DEMO_AUTOPLAY_EXIT ? Number(process.env.QUOX_DEMO_AUTOPLAY_EXIT) * 1000 : null) } : null;
    // /restart works in the demo too (a fresh demo, nothing to resume): the same hand-over, testable with no server
    props = { api: createDemoApi({ objects: true }), profile: 'demo', org: 'demo-org', demoLabel: auto ? AUTOPLAY_LABEL : DEMO_LABEL, autoplay: auto ? null : 'Show me what you can do (demo)', demoAuto: auto, onRestart: (r) => { restart = { ...r, conversationId: null }; }, onDemo: () => { restart = { demo: true }; }, restartCheck: checkRestart };
  } else {
    const cfgMod = await import('../core/config.js');
    const { createAuth } = await import('../core/auth.js');
    const { createClient } = await import('../core/client.js');
    const { createApi } = await import('./api.js');
    const probe = cfgMod.loadConfig();
    const profiles = probe.listProfiles?.() || [];
    const missing = opts.profile && !profiles.some(p => p.name === opts.profile);
    const pick = pickProfile(opts.profile, cfgMod);
    const config = missing ? probe : cfgMod.loadConfig(pick.name);
    const auth = createAuth(config);
    const client = createClient(config, auth);
    const api = createApi({ client, config, auth });
    const pname = missing ? opts.profile : (config.getActiveProfileName?.() || 'default');
    const problem = chatCredentialProblem({ profileArg: opts.profile, profiles, hasStoredLogin: missing ? false : Boolean(config.getAuth?.()?.access_token), profileName: pname, serviceKeyFlag: opts.serviceKey });
    // Z2H: a dead session (refresh rejected) or a cleared login on a human profile is ONE signed-out state, answered
    // by a single card and /login, not scattered digest/approvals/chat errors. Transient failures read as alive.
    let signedOut = null;
    if (!missing && !opts.serviceKey) {
      if (problem && !pick.note) signedOut = { reason: null };
      else if (!problem) {
        const pr = await Promise.race([api.probeSession(), new Promise(r => setTimeout(() => r({ alive: true }), 4000))]).catch(() => ({ alive: true }));
        if (!pr.alive) signedOut = { reason: pr.reason || null };
      }
    }
    // The health probe runs inside the app (background); the UI is up and typing works immediately.
    const startup = async () => {
      if (signedOut) return null;
      if (problem) return problem.message;
      if (pick.note) return pick.note;
      const hl = await api.health(8000);
      return hl.ok ? null : hl.absent ? `No QuoxCORE running at ${hl.url}` : `QuoxCORE at ${hl.url} is not answering (${hl.status}); messages may be slow`;
    };
    const saved = api.settings();
    applySettings(saved);
    if (!opts.verboseSet) opts.verbose = ['off', 'on', 'full'].includes(saved.verbose) ? saved.verbose : 'off'; // protocol lines are opt-in: /verbose on
    props = { api, away: { read: readLastSeen, write: writeLastSeen }, modelChoice: opts.provider, resume: opts.resume ?? null, onRestart: (r) => { restart = r; }, onDemo: () => { restart = { demo: true }; }, restartCheck: checkRestart, startSha: headOf(RUNNING_ROOT), rules: loadRules(), profile: pname, agentLogin: (probe.listResidentProfiles?.() || []).some(r => r.name === pname), humanProfiles: profiles.filter(p => p.loggedIn && !(probe.listResidentProfiles?.() || []).some(r => r.name === p.name)).map(p => p.name), org: missing ? null : (config.getAuth?.()?.org_name || null), startup, blocked: problem && !signedOut ? problem.message : null, signedOut, autoplay: replay };
  }
  // Interactive start: a clean screen under the intro (never when piped; NO_COLOR still clears),
  // except straight after Getting started, whose finale must stay readable.
  if (shouldClearBeforeChat({ isTTY: process.stdout.isTTY, noClear: opts.noClear, fromGettingStarted })) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  const welcome = shouldShowWelcome({ print: opts.print });
  if (welcome) markWelcomeSeen();
  const transcript = opts.demo ? null : createTranscript({ meta: { version, cols: process.stdout.columns, rows: process.stdout.rows, profile: props.profile, org: props.org, cwd } });
  const onResize = () => transcript?.resize(process.stdout.columns, process.stdout.rows);
  if (transcript) process.stdout.on('resize', onResize);
  const app = render(React.createElement(App, { ...props, welcome, tipStartup: !fromGettingStarted && !opts.demo && Boolean(process.stdout.isTTY), version, cwd, verbose: opts.verbose, earlyInput: early, sessionName: opts.name, resumeConversation: opts.conversation || null, invite: Boolean(process.stdout.isTTY) && !opts.name, transcript }), inkRenderOptions(process.stdout));
  try { await app.waitUntilExit(); transcript?.end(restart ? 'restart' : 'exit'); }
  catch (e) { transcript?.end(`crash: ${e?.message || e}`); throw e; }
  finally { process.stdout.off('resize', onResize); }
  if (!restart) return;
  // The app preflighted the installed quox before letting go, so a failure here is rare (it changed in between).
  const r = execRestart({ argv: restart.demo ? ['--demo', '--autoplay'] : argv, conversationId: restart.demo ? null : restart.conversationId, profile: opts.demo ? null : props.profile, name: restart.name || opts.name || null, bin: restart.bin || undefined });
  if (r.error) { process.stderr.write(`quox: could not restart (${r.bin}: ${r.error})${restart.conversationId ? `; resume with: quox --resume ${restart.conversationId}` : ''}\n`); process.exitCode = 1; return; }
  process.exitCode = r.code;
}

async function mainPrint(opts) {
  const { runPrint, resolvePrompt, EXIT } = await import('./print.js');
  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);
  const prompt = await resolvePrompt(opts.prompt, process.stdin);
  let api;
  if (opts.demo) api = createDemoApi({ speed: 20 });
  else {
    const cfgMod = await import('../core/config.js');
    const { createAuth } = await import('../core/auth.js');
    const { createClient } = await import('../core/client.js');
    const { createApi } = await import('./api.js');
    const probe = cfgMod.loadConfig();
    const profiles = probe.listProfiles?.() || [];
    const missing = opts.profile && !profiles.some(p => p.name === opts.profile);
    const pick = pickProfile(opts.profile, cfgMod);
    if (pick.note) err(pick.note + '\n');
    const config = missing ? probe : cfgMod.loadConfig(pick.name);
    const auth = createAuth(config);
    const pname = missing ? opts.profile : (config.getActiveProfileName?.() || 'default');
    const problem = chatCredentialProblem({ profileArg: opts.profile, profiles, hasStoredLogin: missing ? false : Boolean(config.getAuth?.()?.access_token), profileName: pname, serviceKeyFlag: opts.serviceKey });
    if (problem) {
      const { NO_SERVER_PRINT } = await import('./onboarding/copy.js');
      err(printAuthMessage(problem, await noServerConfigured(opts, cfgMod), NO_SERVER_PRINT));
      process.exitCode = EXIT.auth; return;
    }
    api = createApi({ client: createClient(config, auth), config, auth });
    if (opts.conversation && api.conversationExists) {
      const c = await api.conversationExists(opts.conversation);
      if (c.exists === false) { err(`quox: conversation not found: ${opts.conversation}\n`); process.exitCode = EXIT.error; return; }
      if (c.exists === null) err(`quox: could not verify conversation ${opts.conversation} (${c.reason}); continuing\n`);
    }
  }
  const rules = opts.demo ? null : loadRules();
  for (const s of rules?.skipped || []) err(`quox: ignoring ${s.path}: ${s.reason}\n`);
  const choice = opts.provider === 'auto' ? null : opts.provider || api.modelChoice?.() || null;
  process.exitCode = await runPrint({ api, choice, agent: opts.agent || undefined, promptProfile: opts.promptProfile, context: rulesContext(rules), prompt, output: opts.output, conversation: opts.conversation, turnId: opts.turnId || undefined, timeoutS: opts.timeout, color: opts.color, out, err });
}
