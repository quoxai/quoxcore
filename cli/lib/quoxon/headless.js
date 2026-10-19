/**
 * QUOXON-LATENCY: the headless half of the conversation client (`quox --print`), with no
 * React / Ink / App import. bin/quox.js routes --print here directly, so a headless turn
 * no longer pays ~2 s of renderer load before its request is sent. main.js re-exports
 * every name below, so the interactive client and its importers are unchanged.
 */
import { parseModelArg } from './model.js';
import { loadRules, rulesContext } from './rules.js';

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

export async function mainPrint(opts) {
  const { runPrint, resolvePrompt, EXIT } = await import('./print.js');
  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);
  const prompt = await resolvePrompt(opts.prompt, process.stdin);
  let api;
  if (opts.demo) api = (await import('./demo.js')).createDemoApi({ speed: 20 });
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
    const { createWindowClient } = await import('./windowOrg.js');
    api = createApi({ ...createWindowClient({ config, auth, createClient }), config }); // #1034: /org stays in this process
    if (opts.conversation && api.conversationExists) {
      const c = await api.conversationExists(opts.conversation);
      if (c.exists === false) { err(`quox: conversation not found: ${opts.conversation}\n`); process.exitCode = EXIT.error; return; }
      if (c.exists === null) err(`quox: could not verify conversation ${opts.conversation} (${c.reason}); continuing\n`);
    }
  }
  const rules = opts.demo ? null : loadRules();
  for (const s of rules?.skipped || []) err(`quox: ignoring ${s.path}: ${s.reason}\n`);
  const choice = opts.provider === 'auto' ? null : opts.provider || api.modelChoice?.() || null;
  process.exitCode = await runPrint({ api, choice, agent: opts.agent || undefined, promptProfile: opts.promptProfile, context: rulesContext(rules), prompt, output: opts.output, conversation: opts.conversation, turnId: opts.turnId || undefined, timeoutS: opts.timeout, color: opts.color, profile: opts.profile || null, out, err });
}

/** bin/quox.js entry for --print: the same arg checks main() makes, then the headless turn. */
export async function runHeadless(argv) {
  const opts = parseArgs(argv);
  if (!opts.print) return false; // not a headless run after all (e.g. `-- --print` is a prompt): main() owns it
  if (opts.help) { console.log(USAGE); return true; }
  if (opts.errors.length) { process.stderr.write(`quox: ${opts.errors.join('; ')}\n${USAGE}\n`); process.exitCode = 1; return true; }
  await mainPrint(opts);
  return true;
}
