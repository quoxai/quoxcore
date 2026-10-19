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
import { createScreenRecorder, screenFramesEnabled } from './screenFrames.js';
import { applySettings } from './slash/settings.js';
import { headOf, RUNNING_ROOT, execRestart, restartPlan, checkRestart, startBuildWatch, settleMsFrom, restoreTerminal, RESTART_SLOT_ENV, RESTART_ATTACH_ENV, RESTART_NOTE_ENV, RESTART_MODE_ENV } from './slash/restart.js';
import { readLastSeen, writeLastSeen } from './away.js';
import { fileHistory } from './promptHistory.js';
import { takeLauncherHandoff, writeRestartHandoff, RESTART_EXIT_CODE } from './launcher.js';

export { parseArgs, USAGE, pickProfile, choosePick, chatCredentialProblem, noServerConfigured, printAuthMessage } from './headless.js';
import { parseArgs, USAGE, noServerConfigured, mainPrint, pickProfile, chatCredentialProblem } from './headless.js';

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
  let version = '0.3.1';
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
    // QUOX_DEMO_DECISIONS: demo-only pty test seam for the walkthrough proofs (a decisions state file; never a real server)
    props = { api: createDemoApi({ objects: true, decisionsFile: process.env.QUOX_DEMO_DECISIONS || null }), profile: 'demo', org: 'demo-org', demoLabel: auto ? AUTOPLAY_LABEL : DEMO_LABEL, autoplay: auto ? null : 'Show me what you can do (demo)', demoAuto: auto, onRestart: (r) => { restart = { ...r, conversationId: null }; }, onDemo: () => { restart = { demo: true }; }, restartCheck: checkRestart };
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
    const { createWindowClient, carryOrg, RESTART_ORG_ENV } = await import('./windowOrg.js');
    const win = createWindowClient({ config, auth: createAuth(config), createClient }); // #1034: /org switch is window-scoped
    const api = createApi({ ...win, config });
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
    // /restart hand-over: re-enter the predecessor window's org in this window only (the profile is untouched).
    const carried = !missing && !signedOut && !problem ? await carryOrg(api, process.env) : (delete process.env.QUOX_RESTART_ORG, null);
    const startupCarry = async () => (carried?.error ? `Could not re-enter org ${carried.id} after the restart (${carried.error}). This window is in the profile's org.` : startup());
    const saved = api.settings();
    applySettings(saved);
    if (!opts.verboseSet) opts.verbose = ['off', 'on', 'full'].includes(saved.verbose) ? saved.verbose : 'off'; // protocol lines are opt-in: /verbose on
    // PROFILE-SWITCH: build a signed-in profile's api for an in-place window switch (the App only asks after a y or
    // /profile). The window org rides along; the profile file's default is never moved (loadConfig(name) is a lens).
    const residentNames = () => (cfgMod.loadConfig().listResidentProfiles?.() || []).map(r => r.name);
    const switchProfile = async (name, { org: winOrg = null } = {}) => {
      const row = (cfgMod.loadConfig().listProfiles?.() || []).find(p => p.name === name);
      if (!row || !row.loggedIn) return { ok: false, reason: 'not_signed_in' };
      const c2 = cfgMod.loadConfig(name);
      const a2 = createApi({ ...createWindowClient({ config: c2, auth: createAuth(c2), createClient }), config: c2 });
      const pr = await Promise.race([a2.probeSession(), new Promise(r => setTimeout(() => r({ alive: true }), 4000))]).catch(() => ({ alive: true }));
      if (!pr.alive) return { ok: false, reason: 'not_signed_in' };
      const c = winOrg ? await carryOrg(a2, { [RESTART_ORG_ENV]: winOrg }) : null;
      const note = c?.error ? `Could not re-enter org ${winOrg} (${c.error}); this window is in ${name}'s org.` : null;
      return { ok: true, api: a2, agentLogin: residentNames().includes(name), orgName: (c && !c.error && c.name) || c2.getAuth?.()?.org_name || null, note };
    };
    const loginCandidates = profiles.filter(p => !p.loggedIn && !residentNames().includes(p.name)).map(p => p.name);
    props = { api, switchProfile, loginCandidates, away: { read: readLastSeen, write: writeLastSeen }, modelChoice: opts.provider, resume: opts.resume ?? null, onRestart: (r) => { restart = r; }, onDemo: () => { restart = { demo: true }; }, restartCheck: checkRestart, buildWatch: (o) => startBuildWatch({ ...o, settleMs: settleMsFrom() }), startSha: headOf(RUNNING_ROOT), rules: loadRules(), profile: pname, agentLogin: (probe.listResidentProfiles?.() || []).some(r => r.name === pname), humanProfiles: profiles.filter(p => p.loggedIn && !(probe.listResidentProfiles?.() || []).some(r => r.name === p.name)).map(p => p.name), org: missing ? null : ((carried && !carried.error && carried.name) || config.getAuth?.()?.org_name || null), startup: startupCarry, healthRecheck: () => api.health(8000), blocked: problem && !signedOut ? problem.message : null, signedOut, autoplay: replay };
  }
  // Interactive start: a clean screen under the intro (never when piped; NO_COLOR still clears),
  // except straight after Getting started, whose finale must stay readable.
  if (shouldClearBeforeChat({ isTTY: process.stdout.isTTY, noClear: opts.noClear, fromGettingStarted })) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // Z2H-R5 C: do not advertise /slot where the licence check says no (the server's own capabilities answer, short wait).
  let slotsAvailable = true;
  if (!opts.demo && process.stdout.isTTY && props.api?.capabilities && !props.signedOut && !props.blocked) {
    try {
      const caps = await Promise.race([props.api.capabilities(), new Promise(res => setTimeout(() => res(null), 2000))]);
      const c = caps?.ok ? caps.capabilities.find(x => x.id === 'slots') : null;
      if (c && c.availability === 'unavailable' && /not in your plan/i.test(String(c.reason || ''))) slotsAvailable = false;
    } catch { /* unknown: leave the invite as it was */ }
  }
  const welcome = shouldShowWelcome({ print: opts.print });
  if (welcome) markWelcomeSeen();
  const transcript = opts.demo ? null : createTranscript({ meta: { version, cols: process.stdout.columns, rows: process.stdout.rows, profile: props.profile, org: props.org, cwd } });
  const onResize = () => transcript?.resize(process.stdout.columns, process.stdout.rows);
  if (transcript) process.stdout.on('resize', onResize);
  // SCREEN-FRAMES: what the screen showed, settled, into the same local transcript (QUOX_SCREEN_FRAMES=0 turns it off).
  const screenRec = transcript && process.stdout.isTTY && screenFramesEnabled(process.env)
    ? createScreenRecorder({ write: (rec) => transcript.screen(rec), cols: () => process.stdout.columns, rows: () => process.stdout.rows })
    : null;
  const restartSlot = opts.demo ? null : (process.env[RESTART_SLOT_ENV] || null); delete process.env[RESTART_SLOT_ENV]; // one hand-over only
  const restartAttach = opts.demo ? null : (process.env[RESTART_ATTACH_ENV] || null); delete process.env[RESTART_ATTACH_ENV];
  const restartMode = opts.demo ? null : (process.env[RESTART_MODE_ENV] === 'plan' ? 'plan' : null); delete process.env[RESTART_MODE_ENV]; // PLAN MODE: window-scoped, carried once
  const restartNote = opts.demo ? null : (process.env[RESTART_NOTE_ENV] || null); delete process.env[RESTART_NOTE_ENV]; // e.g. a failed /update, said once in the restarted client
  if (restartNote && !props.introNote) props.introNote = restartNote;
  const app = render(React.createElement(App, { ...props, restartSlot, restartAttach, ...(restartMode ? { mode: restartMode } : {}), welcome, tipStartup: !fromGettingStarted && !opts.demo && Boolean(process.stdout.isTTY), whatsNewStartup: !opts.demo && Boolean(process.stdout.isTTY), version, cwd, verbose: opts.verbose, earlyInput: early, sessionName: opts.name, resumeConversation: opts.conversation || null, invite: Boolean(process.stdout.isTTY) && !opts.name, slotsAvailable, transcript, historyStore: opts.demo ? null : fileHistory() }), inkRenderOptions(process.stdout, { tap: screenRec?.tap }));
  try { await app.waitUntilExit(); screenRec?.stop(); transcript?.end(restart ? 'restart' : 'exit'); }
  catch (e) { screenRec?.stop(); transcript?.end(`crash: ${e?.message || e}`); throw e; }
  finally { screenRec?.stop(); process.stdout.off('resize', onResize); }
  if (!restart) return;
  if (restart.update) { // /update said y: the update owns the terminal (npm prompts, sudo), then the same restart either way
    const { runUpdate } = await import('../core/selfUpdate.js');
    const plan = restart.update;
    restoreTerminal();
    process.stdout.write(`\nUpdating quox: ${plan.command.display}\n`);
    const u = runUpdate(plan);
    if (u.ok) process.stdout.write(`\u2714 Update finished (exit 0). Restarting into this conversation\u2026\n`);
    else {
      const note = `Update failed: ${plan.command.display} ${u.error ? `could not start (${u.error})` : `exited ${u.code}`}. Restarting on the build that is installed now. Run it yourself to see why: ${plan.manual}`;
      process.stdout.write(`\u2716 ${note}\n`);
      process.env[RESTART_NOTE_ENV] = note; // the restarted client (same build) says it again in the conversation
    }
  }
  // The app preflighted the installed quox before letting go, so a failure here is rare (it changed in between).
  const how = { argv: restart.demo ? ['--demo', '--autoplay'] : argv, conversationId: restart.demo ? null : restart.conversationId, profile: opts.demo ? null : (restart.profile || props.profile), name: restart.name || opts.name || null, slot: restart.demo ? null : (restart.slot || null), attach: restart.demo ? null : (restart.attach || null), org: restart.demo ? null : (restart.org || null), mode: restart.demo ? null : (restart.mode || null), bin: restart.bin || undefined };
  // QUOXON-RESTART-LEAK: under the launcher this process EXITS and the launcher runs the successor, so exactly one
  // client stays alive per terminal. Without one (QUOX_NO_LAUNCHER=1) it falls back to waiting on a nested child.
  const launched = takeLauncherHandoff();
  if (launched && writeRestartHandoff(launched, restartPlan(how))) { restoreTerminal(); process.exitCode = RESTART_EXIT_CODE; return; }
  const r = execRestart(how);
  if (r.error) { process.stderr.write(`quox: could not restart (${r.bin}: ${r.error})${restart.conversationId ? `; resume with: quox --resume ${restart.conversationId}` : ''}\n`); process.exitCode = 1; return; }
  process.exitCode = r.code;
}
