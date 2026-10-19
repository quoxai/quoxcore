/**
 * `quox dev supervisor`, DEVSUITE-DEVMODE (quox#453 phase 15 follow-on).
 *
 * The headless runner that lets a dev host's resident agent answer its slot
 * channel with no interactive session open. All of the actual picking,
 * rate-limiting, prompt-building, turn-execution and state logic lives in
 * `../core/supervisorEngine.js` and is unit tested there; this file is the
 * thin wiring: resolve defaults from the resident bootstrap profile, build
 * the injected fetch/post/spawn closures against the CLI's existing
 * endpoint-resolution and client patterns, and drive the poll loop.
 *
 * Delivery: this needs no new delivery channel because the CLI is already
 * on every dev-enabled host (/opt/quoxcli + /usr/local/bin/quox), and it
 * already holds the resident's auth (see lib/core/residentAuth.js).
 *
 * A SEPARATE stream owns the server-side switch (writes to
 * /api/v1/dev-servers/:hostId/supervisor). This module is read-only against
 * it: it never writes to that endpoint.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { formatDetail, formatOutput, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';
import { loadResidentProfile, expandHome, deriveSupervisorEnv } from '../core/residentAuth.js';
import { createInitialPumpState, runPumpOnce } from '../core/residentPump.js';
import { createInitialAlarmState, runWardenPass, sendAlarm } from '../core/residentAlarm.js';
import {
  DEFAULT_SETTINGS,
  DEFAULT_IDLE_RECHECK_SECONDS,
  DEFAULT_WAIT_FAILURE_THRESHOLD,
  DEFAULT_MAX_MESSAGE_AGE_MINUTES,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  resolveSettings,
  buildSelfIdentity,
  runPollOnce,
  runClaudeTurn,
  createInitialState,
  attemptSlotClaim,
  createClaimState,
  shouldPostErrorNotice,
  startIndependentHeartbeat,
} from '../core/supervisorEngine.js';
import {
  SERVICE_NAME,
  DEFAULT_RESTART_SEC,
  buildUnitFile,
  defaultUnitDir,
  defaultUnitPath,
  installSupervisorService,
  uninstallSupervisorService,
  getServiceInstallStatus,
  realExecFn,
} from '../core/systemdInstaller.js';

export function defaultLogPath() {
  return join(homedir(), '.quox', 'supervisor.log');
}

export function defaultStatePath() {
  return join(homedir(), '.quox', 'supervisor-state.json');
}

// QUOXPERTICUS-REVISIT P4/P5: separate continuity files for the warden's
// pump (steer) and alarm (watchdog) state, so they persist across process
// restarts the same way supervisor-state.json does, without mixing shapes
// with the headless-answering state above.
export function defaultPumpStatePath() {
  return join(homedir(), '.quox', 'warden-pump-state.json');
}

export function defaultAlarmStatePath() {
  return join(homedir(), '.quox', 'warden-alarm-state.json');
}

// #619: which `quox` binary to bake into the Restart=always unit's ExecStart.
// Baking process.argv[1] (the CLI doing the install) is the trap: if that CLI
// lives in a MUTABLE tree — the shared quox-dashboard checkout that
// sessions branch-switch, or a per-session …-wt-<name> worktree — then a
// later checkout/reset silently changes or removes the deployed supervisor
// code under the running unit. A resident crash-looped to StartLimit and sat
// dark ~15 days exactly this way ("long-lived units must NOT exec from a live
// working tree"). Prefer the STABLE detached CLI worktree the rest of the box
// already treats as canonical ($QUOX_CLI_DIR or ~/quox-dashboard-cli — the
// same one quox-cli-refresh/#607 maintains). If we can only fall back to a
// mutable path, return mutable:true so the caller warns loudly.
export function resolveSupervisorBin({ quoxBin, argv1, home, existsFn = existsSync, env = process.env } = {}) {
  if (quoxBin) return { bin: quoxBin, source: 'explicit (--quox-bin)', mutable: false };
  const stableDir = env.QUOX_CLI_DIR || join(home || homedir(), 'quox-dashboard-cli');
  const stableBin = join(stableDir, 'cli', 'bin', 'quox.js');
  if (existsFn(stableBin)) return { bin: stableBin, source: 'stable CLI worktree', mutable: false };
  const fallback = argv1 || 'quox';
  // A per-session worktree (…-wt-…) or the shared mutable dev tree
  // (…/quox-dashboard/… but NOT …/quox-dashboard-cli/… or …-wt-…).
  const mutable = /-wt-/.test(fallback) || /\/quox-dashboard\//.test(fallback);
  return { bin: fallback, source: 'install-time process path', mutable };
}

function loadNamedState(path, factory) {
  try {
    if (!existsSync(path)) return factory();
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { ...factory(), ...parsed };
  } catch {
    // A corrupt or unreadable state file must never crash the warden; it
    // just loses continuity and starts fresh.
    return factory();
  }
}

function saveNamedState(path, state) {
  ensureDirFor(path);
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function ensureDirFor(path) {
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* already exists */ }
}

export function loadState(path) {
  try {
    if (!existsSync(path)) return createInitialState();
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { ...createInitialState(), ...parsed };
  } catch {
    // A corrupt or unreadable state file must never crash the runner; it
    // just loses continuity and starts a fresh first-run seed.
    return createInitialState();
  }
}

export function saveState(path, state) {
  ensureDirFor(path);
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function makeLogger(logPath) {
  ensureDirFor(logPath);
  return (level, message) => {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    try { appendFileSync(logPath, `${line}\n`); } catch { /* logging must never crash the runner */ }
    if (level === 'warn') printWarning(message);
    else if (level === 'error') console.error(message);
    else printInfo(message);
  };
}

/** Read the timestamp off the last line of the log file, if any. */
function lastLogActivity(logPath) {
  try {
    if (!existsSync(logPath)) return null;
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const match = lines[lines.length - 1].match(/^\[([^\]]+)\]/);
    if (!match) return null;
    const ts = new Date(match[1]).getTime();
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectRepeatable(value, previous) {
  return (previous || []).concat([value]);
}

/**
 * Resolve slot/host defaults from the resident bootstrap profile
 * (~/.config/quox/resident-profile.json). Never throws for a missing
 * profile: --host/--slot can supply both explicitly (e.g. an operator
 * driving this from their own machine against a resident host).
 */
function loadResidentProfileSafely(explicitPath) {
  try {
    return loadResidentProfile(explicitPath);
  } catch {
    return null;
  }
}

export function registerDevSupervisorCommands(dev, ctx) {
  const { client, auth, program } = ctx;

  const supervisor = dev
    .command('supervisor')
    .description('Headless runner: answer a resident\'s slot channel with no interactive session open');

  // Split from the combined resolveTargets below (item 1a/1c, found by the
  // acceptance owner driving this on a real host, 2026-08-23) so `install`
  // can refuse cleanly on a missing slot alone, and `run --service` can
  // idle instead of crash-looping on one, without either needing a host id
  // check to also participate in that branching.
  function resolveHostId(options) {
    const profile = loadResidentProfileSafely(options.residentProfile);
    const hostId = options.host || profile?.host_id || null;
    if (!hostId) {
      throw new Error('No host id: pass --host <hostId>, or provision a resident bootstrap profile with host_id.');
    }
    return hostId;
  }

  function resolveSlotName(options) {
    const profile = loadResidentProfileSafely(options.residentProfile);
    return options.slot || profile?.slot || null;
  }

  function resolveTargets(options) {
    const hostId = resolveHostId(options);
    const slotName = resolveSlotName(options);
    if (!slotName) {
      throw new Error('No slot: pass --slot <name>, or add "slot" to the resident bootstrap profile.');
    }
    return { hostId, slotName };
  }

  supervisor
    .command('run')
    .description('Poll the resident\'s slot channel and answer new owner messages headlessly')
    .option('--slot <name>', 'slot to poll (default: resident bootstrap profile)')
    .option('--host <hostId>', 'dev host_id (default: resident bootstrap profile)')
    .option('--once', 'run a single poll pass and exit (what tests drive)')
    .option('--service', 'Option A persistence: idle instead of exit when the kill switch is off, so a systemd unit never needs a restart to resume answering')
    .option('--log <path>', 'log file path', defaultLogPath())
    .option('--state <path>', 'continuity state file path', defaultStatePath())
    .option('--resident-profile <path>', 'resident bootstrap profile path (default: ~/.config/quox/resident-profile.json)')
    .option('--from <name>', 'accept messages only from this owner name (repeatable; default: anyone but this resident\'s own posts)', collectRepeatable, [])
    .option('--history <n>', 'channel messages carried as continuity handover per turn', (v) => parseInt(v, 10), 10)
    .option('--max-age-minutes <n>', 'never answer an owner message older than this, mark it seen instead (churn guard)', (v) => parseInt(v, 10), DEFAULT_MAX_MESSAGE_AGE_MINUTES)
    .option('--pump-state <path>', 'warden pump continuity state file path (QUOXPERTICUS-REVISIT P4)', defaultPumpStatePath())
    .option('--alarm-state <path>', 'warden alarm continuity state file path (QUOXPERTICUS-REVISIT P5)', defaultAlarmStatePath())
    .action(async (options) => {
      auth.requireAuth();
      const hostId = resolveHostId(options);
      let slotName = resolveSlotName(options);
      const orgId = resolveOrgId(auth, program);
      const selfIdentity = buildSelfIdentity(hostId);
      const logPath = expandHome(options.log);
      const statePath = expandHome(options.state);
      const log = makeLogger(logPath);

      let state = loadState(statePath);

      const fetchSettings = async () => {
        const ep = resolveEndpoint('v1.dev.supervisor.get', { hostId });
        return client.get(ep.path, { service: ep.service });
      };

      if (!slotName) {
        if (!options.service) {
          throw new Error('No slot: pass --slot <name>, or add "slot" to the resident bootstrap profile.');
        }
        // LAUNCH BLOCKER FIX (item 1c, found by the acceptance owner driving
        // this on a real host, 2026-08-23): before this fix, an unresolvable
        // slot exited non-zero, and under systemd Restart=always that meant a
        // busy-loop roughly every RestartSec forever. A --service runner
        // with no slot yet has nothing to answer, but that is not a crash:
        // idle on the same slow re-check cadence as the disabled-switch
        // branch below, re-resolving from --slot/the bootstrap profile AND
        // the server-side supervisor settings (whose `slot` field needs only
        // hostId to fetch, set independently via `quox dev supervisor
        // enable --slot`), until one appears.
        log('warn', `startup: host=${hostId} no slot resolved (checked --slot and the resident bootstrap profile). service mode: idling (re-check every ${DEFAULT_IDLE_RECHECK_SECONDS}s) instead of exiting; no turns run with no slot to answer.`);
        while (!slotName) {
          if (options.once) {
            log('info', 'shutdown');
            return;
          }
          await sleep(DEFAULT_IDLE_RECHECK_SECONDS * 1000);
          slotName = resolveSlotName(options);
          if (!slotName) {
            try {
              const settings = resolveSettings(await fetchSettings());
              if (settings.slot) slotName = settings.slot;
            } catch (err) {
              log('warn', `service mode: idle slot re-check failed: ${err.message}`);
            }
          }
        }
        log('info', `service mode: slot resolved (${slotName}); resuming without a restart.`);
      }

      log('info', `startup: host=${hostId} slot=${slotName} log=${logPath} state=${statePath} once=${!!options.once} service=${!!options.service}`);

      const fetchMessages = async () => {
        const ep = resolveEndpoint('v1.slots.messages', { name: slotName });
        const data = await client.get(ep.path, { service: ep.service, query: { org_id: orgId, limit: 50 } });
        return data.messages || [];
      };
      // Long-poll primitive, same contract as `quox slot wait --once`: one
      // ~50s round trip, returns whatever landed since `cursor` (or nothing).
      // Reused here rather than shelling out to the CLI verb itself, but it
      // hits the exact same collector endpoint slot.js's `wait` command does.
      // holder_session/exclude_from mirror `slot wait --session`: this is how
      // this codebase keeps a slot's hold warm on every round trip, so the
      // resident stays visibly present (not just "answering") for as long as
      // it is actively watching.
      const fetchWait = async (cursor) => {
        const ep = resolveEndpoint('v1.slots.wait', { name: slotName });
        const query = { org_id: orgId, timeout_ms: 50000, holder_session: selfIdentity, exclude_from: selfIdentity };
        if (cursor) query.since = cursor;
        return client.get(ep.path, { service: ep.service, query, timeout: 65000 });
      };
      const postReply = async (text) => {
        const ep = resolveEndpoint('v1.slots.say', { name: slotName });
        await client.post(ep.path, { service: ep.service, body: { text, from: selfIdentity, org_id: orgId } });
      };
      // Present-but-silent seam for the idle branch below: keeps the hold
      // alive with NO cursor movement and NO message read, so nothing can be
      // lost or skipped across a disable/re-enable transition.
      const postHeartbeat = async () => {
        const ep = resolveEndpoint('v1.slots.heartbeat', { name: slotName });
        await client.post(ep.path, { service: ep.service, body: { holder_session: selfIdentity, org_id: orgId } });
      };
      // PRESENCE FIX (item 2, live outage 2026-08-23): both residents' slots
      // sat FREE while their supervisors ran, because nothing ever called
      // checkout, only heartbeat. This is a plain (non-force) checkout as
      // this resident's own identity: the collector's checkout is a
      // compare-and-swap on state='free', so it is safe to attempt on every
      // poll pass. See attemptSlotClaim in supervisorEngine.js for how a
      // 409 (already held by us, or held by someone else) is handled.
      const checkoutSlot = async () => {
        const ep = resolveEndpoint('v1.slots.checkout', { name: slotName });
        return client.post(ep.path, {
          service: ep.service,
          body: { holder_session: selfIdentity, holder_kind: 'resident', host_id: hostId, org_id: orgId, force: false },
        });
      };
      const claimState = createClaimState();
      const spawnFn = ctx.spawnFn || spawn;
      const spawnTurn = (prompt, timeoutSeconds) => runClaudeTurn({ spawnFn, prompt, timeoutSeconds });
      // QP-DASH P1: report every attempted turn as a receipt. The engine
      // wraps this fail-soft, so a collector outage never breaks answering.
      const postTurnReceipt = async (fields) => {
        const ep = resolveEndpoint('v1.dev.supervisor.turns.record', { hostId });
        await client.post(ep.path, { service: ep.service, body: { ...fields, slot_name: slotName, org_id: orgId } });
      };

      // GRIPE-797: one owner alert per auth-expiry episode, same transport
      // order as the warden alarm (tg-send.sh first, slot say fallback).
      const alertOwner = async (text) => {
        const script = ctx.tgSendScriptPath || join(homedir(), '.claude', 'skills', 'telegram-owner', 'tg-send.sh');
        await sendAlarm({
          tgSend: async (session, t) => { await (ctx.execFileAsync || promisify(execFile))('bash', [script, session, t]); },
          postSlotNotice: postReply, text, sessionName: `SUPERVISOR-${hostId}`, log,
        });
      };
      const commonPollArgs = {
        alertOwner,
        hostId,
        slot: slotName,
        selfIdentity,
        fromFilters: options.from,
        fetchSettings,
        postReply,
        spawnTurn,
        checkoutSlot,
        claimState,
        postHeartbeat,
        postTurnReceipt,
        log,
        historyWindow: options.history,
        maxAgeMinutes: Number.isInteger(options.maxAgeMinutes) ? options.maxAgeMinutes : DEFAULT_MAX_MESSAGE_AGE_MINUTES,
      };

      // QUOXPERTICUS-REVISIT P4/P5: WARDEN MODE. When this host's slot is
      // held by a FULL INTERACTIVE claude session on THIS host (the resident
      // this process wards, deployed via `quox dev resident deploy`), the
      // HOLD-IS-THE-VOICE gate inside runPollOnce already keeps this process
      // structurally silent (see supervisorEngine.js). Rather than leave
      // that silence unattended, this process becomes the WARDEN for that
      // pass: it pumps new owner messages into the resident's live pane
      // (residentPump.js) and watches the resident's health (residentAlarm.js)
      // instead of running the normal answering pass at all.
      const execFileAsync = ctx.execFileAsync || promisify(execFile);
      const pumpStatePath = expandHome(options.pumpState || defaultPumpStatePath());
      const alarmStatePath = expandHome(options.alarmState || defaultAlarmStatePath());
      let pumpState = loadNamedState(pumpStatePath, createInitialPumpState);
      let alarmState = loadNamedState(alarmStatePath, createInitialAlarmState);

      const fetchSlotRow = async () => {
        const ep = resolveEndpoint('v1.slots.list');
        const data = await client.get(ep.path, { service: ep.service, query: { org_id: orgId } });
        return ((data && data.slots) || []).find((s) => s.name === slotName) || null;
      };

      // Runs ONE warden cycle (pump + watchdog) when applicable. Returns
      // {wasWarden:false} when the slot is not held by an interactive
      // resident on this host, in which case the caller falls through to
      // the normal headless answering pass, completely unchanged. Never
      // throws: a slot lookup failure is logged and treated as "not warded
      // this pass", never as a reason to stop the runner.
      async function runWardenCycle() {
        let slotRow;
        try {
          slotRow = await fetchSlotRow();
        } catch (err) {
          log('warn', `warden: could not read slot ${slotName} to check for an interactive hold: ${err.message}`);
          return { wasWarden: false };
        }
        const isWardedResident = !!(
          slotRow && slotRow.state === 'held' && slotRow.holder_kind === 'interactive' && slotRow.host_id === hostId
        );
        if (!isWardedResident) return { wasWarden: false };

        const residentSessionId = slotRow.holder_session;
        // Default naming convention from `quox dev resident deploy`
        // (lib/commands/devResident.js defaultSessionName): a resident
        // deployed with a custom --session-name is not matched by this.
        const sessionName = `resident-${slotName}`;

        const readPane = async () => {
          const ep = resolveEndpoint('v1.dev.sessions.pane', { hostId, sessionId: residentSessionId });
          const data = await client.get(ep.path, { service: ep.service });
          return (data && data.pane) || '';
        };
        const injectKeys = async (line) => {
          const ep = resolveEndpoint('v1.dev.sessions.keys', { hostId, sessionId: residentSessionId });
          await client.post(ep.path, { service: ep.service, body: { keys: line } });
        };
        const heartbeatHold = async () => {
          const ep = resolveEndpoint('v1.slots.heartbeat', { name: slotName });
          await client.post(ep.path, { service: ep.service, body: { holder_session: residentSessionId, org_id: orgId } });
        };

        try {
          const pumpResult = await runPumpOnce({
            hostId, slot: slotName, selfIdentity, fromFilters: options.from,
            fetchMessages, readPane, injectKeys, heartbeatHold, postReply,
            state: pumpState, log,
          });
          pumpState = pumpResult.state;
          saveNamedState(pumpStatePath, pumpState);
        } catch (err) {
          log('warn', `warden: pump pass failed (never blocks the watchdog below): ${err.message}`);
        }

        const listSessions = async () => {
          const ep = resolveEndpoint('v1.dev.sessions.list', { hostId });
          const data = await client.get(ep.path, { service: ep.service });
          return (data && data.sessions) || [];
        };
        const releaseSlot = async () => {
          const ep = resolveEndpoint('v1.slots.release', { name: slotName });
          await client.post(ep.path, { service: ep.service, body: { org_id: orgId, force: true } });
        };
        // Reuses `quox dev resident deploy` (lib/commands/devResident.js)
        // via a child process rather than importing its internals: deploy's
        // closures are private to registerDevResidentCommands, and shelling
        // out exercises the exact same governed path a human would run.
        const redeploy = async () => {
          const quoxBin = ctx.quoxBin || process.argv[1] || 'quox';
          await execFileAsync(quoxBin, ['dev', 'resident', 'deploy', '--host', hostId, '--slot', slotName, '--force']);
        };
        const claimFallback = async () => attemptSlotClaim({ checkoutSlot, selfIdentity, slot: slotName, log, announceForeignHold: false, claimState, postHeartbeat });
        const tgSend = async (session, text) => {
          const script = ctx.tgSendScriptPath || join(homedir(), '.claude', 'skills', 'telegram-owner', 'tg-send.sh');
          await execFileAsync('bash', [script, session, text]);
        };

        try {
          const alarmResult = await runWardenPass({
            hostId, slot: slotName, sessionName,
            listSessions, readPane, releaseSlot, redeploy, claimFallback,
            postSlotNotice: postReply, recordTurn: postTurnReceipt, tgSend,
            stuckDialogSinceMs: pumpState.stuck_dialog_since,
            state: alarmState, log,
          });
          alarmState = alarmResult.state;
          saveNamedState(alarmStatePath, alarmState);
        } catch (err) {
          log('warn', `warden: watchdog pass failed: ${err.message}`);
        }

        return { wasWarden: true };
      }

      // Watching strategy for a continuous (non --once) run: long-poll via
      // `wait` is the primary path (requirement: no sleep loop watching for
      // messages). The very first pass of a continuous run still uses the
      // classic /messages fetch, unchanged, so first-run backlog seeding
      // stays exactly what it always was; every pass after that switches to
      // waitMode and re-waits from the cursor the previous round returned.
      // If wait fails DEFAULT_WAIT_FAILURE_THRESHOLD times in a row, this
      // permanently falls back to the original interval-poll loop for the
      // rest of THIS process's life: degrade, never die.
      const continuous = !options.once;
      let running = true;
      let pollSeconds = DEFAULT_SETTINGS.poll_seconds;
      let waitMode = false;
      let waitDisabled = false;
      let waitFailures = 0;
      let cursor = null;
      // Service mode idling: set when the server-side switch is off and
      // --service was given.
      //
      // PRESENT BUT SILENT (deliberate, on the record): while idling, this
      // resident keeps holding its slot and keeps heartbeating it, so it
      // reads as a live host that is not currently permitted to act, never
      // as an absent one. It answers NOTHING while idling: no message is
      // fetched for processing here (only the heartbeat, which reads
      // nothing) and no turn is ever spawned. Only the server-side switch
      // itself is re-checked, slowly.
      let idling = false;

      // LOOP TRIAGE FIX (diagnosed live 2026-09-10, .131): before this, the
      // ENABLED branch's only heartbeat was the `slot wait` long-poll's own
      // server-side coupling (holder_session on every wait round trip). An
      // intermittent hang on the authenticated slot path (observed:
      // "checkout attempt failed: Request timed out after 30000ms" while
      // /health stayed instant, so this is a server-side hang, not network)
      // wedged the long-poll, and NO heartbeat fired until it recovered, so
      // the hold lapsed stale (15m TTL) then free (30m) and re-claimed
      // ~45 minutes later, ~193 times over 6 days. This independent
      // heartbeat runs on its own fixed-interval timer (see
      // startIndependentHeartbeat in supervisorEngine.js), decoupled from
      // the wait long-poll, a turn spawn, or the idle branch's own recheck
      // cadence, so it keeps the hold warm through all of them. It never
      // seizes anything (postHeartbeat only warms a hold this resident
      // already has; a 409 is logged and left alone, same rule as
      // everywhere else in this file).
      const independentHeartbeat = startIndependentHeartbeat({
        postHeartbeat,
        intervalMs: DEFAULT_HEARTBEAT_INTERVAL_SECONDS * 1000,
        log,
      });

      try {
        while (running) {
        if (idling) {
          // PRESENCE FIX (item 2, live outage 2026-08-23): claim the slot
          // here too, before the heartbeat below, so idling reads as PRESENT
          // rather than present-but-silent-and-not-even-holding-it. Never
          // logs the foreign-hold case itself (announceForeignHold: false):
          // the existing heartbeat 409 handler right below already reports
          // that, unchanged, and would otherwise double-log the same event.
          const idleClaim = await attemptSlotClaim({ checkoutSlot, selfIdentity, slot: slotName, log, announceForeignHold: false, claimState, postHeartbeat });
          // HOLD-IS-THE-VOICE gate, mirrored (QUOXPERTICUS-REVISIT P2): this
          // idle loop never fetches messages or spawns turns regardless (the
          // kill switch is off here), but a foreign hold is still witnessed
          // with the same once-per-holder-per-hour receipt the engine posts
          // on an enabled pass, so "who held it and when" is legible even
          // while service mode is idling on the disabled switch.
          if (!idleClaim.claimed && idleClaim.reason === 'held_by_other') {
            const holder = idleClaim.holder || 'unknown';
            const notice = shouldPostErrorNotice(state.held_by_other_notices || [], holder, Date.now());
            state = { ...state, held_by_other_notices: notice.notices };
            if (notice.shouldPost) {
              try {
                await postTurnReceipt({ outcome: 'silent_held_by_other', held_by: holder });
              } catch (err) {
                log('warn', `silent-held receipt failed (never blocks idling): ${err.message}`);
              }
            }
            saveState(statePath, state);
          }
          try {
            await postHeartbeat();
          } catch (err) {
            // SLOT OWNERSHIP INTENT (item 3, found by the acceptance owner
            // driving this on a real host, 2026-08-23): this heartbeat is
            // read-only warmth on a hold this resident already has, never a
            // seize. If another session (human or resident) already holds
            // ${slotName}, the collector's heartbeatSlot() correctly refuses
            // (409, "not held by this session") rather than handing the hold
            // over silently. Reporting that as a generic failure buries
            // exactly the information an operator needs; call it what it is.
            // Silently seizing a hold someone else deliberately owns is the
            // same failure class as the checkoutSlot assigned_to bug fixed
            // earlier tonight (services/collector/lib/devSlotsStore.js),
            // where an assignment was ignored and a slot could be taken out
            // from under its owner — this is the CLI-side mirror of that
            // rule: never force a hold this process does not already have.
            if (err && err.status === 409) {
              log('warn', `slot ${slotName}: idle heartbeat got 409 (not held by this resident) — leaving it alone rather than seizing it. Run \`quox dev supervisor status\` to see who holds it.`);
            } else {
              log('warn', `service mode: idle heartbeat failed: ${err.message}`);
            }
          }
          await sleep(DEFAULT_IDLE_RECHECK_SECONDS * 1000);
          let settings;
          try {
            settings = resolveSettings(await fetchSettings());
          } catch (err) {
            log('warn', `service mode: idle re-check failed: ${err.message}`);
            continue;
          }
          if (!settings.enabled) continue;
          idling = false;
          log('info', 'service mode: supervisor re-enabled, resuming without a restart.');
          // Falls through into a normal pass below, same iteration.
        }

        // QUOXPERTICUS-REVISIT P4/P5: check for warden mode BEFORE the
        // normal answering pass below. When the slot is held by an
        // interactive resident on this host, this pass pumps + watches
        // instead of running runPollOnce at all (which would find the same
        // hold and just sit silent via the HOLD-IS-THE-VOICE gate). Skipped
        // while idling above (that branch already has its own foreign-hold
        // handling and re-checks the kill switch first).
        if (!idling) {
          let wardenOutcome = { wasWarden: false };
          try {
            wardenOutcome = await runWardenCycle();
          } catch (err) {
            log('warn', `warden cycle failed unexpectedly (falling through to a normal pass): ${err.message}`);
          }
          if (wardenOutcome.wasWarden) {
            if (options.once) break;
            await sleep(pollSeconds * 1000);
            continue;
          }
        }

        let result = null;
        try {
          if (continuous && waitMode) {
            const waitData = await fetchWait(cursor);
            cursor = waitData.cursor || cursor;
            waitFailures = 0;
            const waitMessages = waitData.messages || [];
            result = await runPollOnce({ ...commonPollArgs, state, fetchMessages: async () => waitMessages });
          } else {
            result = await runPollOnce({ ...commonPollArgs, state, fetchMessages });
            // Only switch to wait-mode off a pass that actually ran enabled
            // (result.stopped false): a classic pass returned early by the
            // kill switch never touched state.bootstrapped or seen_ids, so
            // treating it as the "first pass seeded the backlog" moment
            // would hand wait a bare cursor and skip the real backlog seed
            // the first ever enabled pass is required to do.
            if (continuous && !waitDisabled && result && !result.stopped) {
              cursor = new Date().toISOString();
              waitMode = true;
            }
          }
        } catch (err) {
          log('error', `poll failed: ${err.message}`);
          // #1018: a single pass that failed is a failed run, not a quiet success.
          if (options.once) process.exitCode = 1;
          if (continuous && waitMode) {
            waitFailures += 1;
            if (waitFailures >= DEFAULT_WAIT_FAILURE_THRESHOLD) {
              waitMode = false;
              waitDisabled = true;
              waitFailures = 0;
              log('warn', `wait failed ${DEFAULT_WAIT_FAILURE_THRESHOLD} times in a row; falling back to interval polling every ${pollSeconds}s.`);
            }
          }
        }

        if (result) {
          state = result.state;
          saveState(statePath, state);
          pollSeconds = result.settings.poll_seconds;
          if (result.stopped) {
            if (options.service && !options.once) {
              idling = true;
              log('info', `service mode: idling (re-check every ${DEFAULT_IDLE_RECHECK_SECONDS}s) until re-enabled; no turns run while disabled.`);
            } else {
              running = false;
            }
          }
        }

        if (options.once) break;
        if (running && !idling && !waitMode) await sleep(pollSeconds * 1000);
      }
      } finally {
        independentHeartbeat.stop();
      }

      log('info', 'shutdown');
    });

  // quox#470: the switch had a dashboard toggle but no CLI verb, so an org
  // owner at a terminal had no way to flip it and it read as unreachable.
  // Server-side this is requireHumanAdmin, so an org owner/admin passes and
  // a resident's own agent-scoped token is refused however it is called.
  function registerSwitch(name, enabled, description) {
    supervisor
      .command(name)
      .description(description)
      .option('--host <hostId>', 'dev host_id (default: resident bootstrap profile)')
      .option('--slot <name>', 'slot the runner should answer (default: resident bootstrap profile)')
      .option('--poll-seconds <n>', 'seconds between polls (5-300)', (v) => parseInt(v, 10))
      .option('--turn-timeout-seconds <n>', 'per-turn timeout (30-600)', (v) => parseInt(v, 10))
      .option('--max-turns-per-hour <n>', 'rate cap (1-120)', (v) => parseInt(v, 10))
      .option('--resident-profile <path>', 'resident bootstrap profile path')
      .action(async (options) => {
        auth.requireAuth();
        const profile = loadResidentProfileSafely(options.residentProfile);
        const hostId = options.host || profile?.host_id || null;
        if (!hostId) {
          throw new Error('No host id: pass --host <hostId>, or run where a resident bootstrap profile exists.');
        }
        const body = { enabled };
        // Only send a slot when enabling: disabling should never need one,
        // and sending undefined would clobber the stored value.
        const slotName = options.slot || profile?.slot || null;
        if (enabled && slotName) body.slot = slotName;
        if (Number.isInteger(options.pollSeconds)) body.poll_seconds = options.pollSeconds;
        if (Number.isInteger(options.turnTimeoutSeconds)) body.turn_timeout_seconds = options.turnTimeoutSeconds;
        if (Number.isInteger(options.maxTurnsPerHour)) body.max_turns_per_hour = options.maxTurnsPerHour;

        const ep = resolveEndpoint('v1.dev.supervisor.set', { hostId });
        const data = await client.put(ep.path, { service: ep.service, body });
        formatDetail(data, { format: program.opts().output, title: `Supervisor ${enabled ? 'enabled' : 'disabled'} for ${hostId}` });
        printSuccess(
          enabled
            ? `Supervisor enabled for ${hostId}. Start the runner on that host: quox dev supervisor run`
            : `Supervisor disabled for ${hostId}. A running runner exits within one poll.`
        );
      });
  }

  registerSwitch('enable', true, 'Turn the headless supervisor ON for a host (human admin only)');
  registerSwitch('disable', false, 'Turn the headless supervisor OFF for a host (kill switch)');

  // Option A persistence, delivery half. Installing this unit is deliberately
  // NOT the autonomy grant: see the governance note at the top of
  // ../core/systemdInstaller.js. The unit only ever answers a message when
  // the human-gated server-side switch above is on, so a resident installing
  // its own service on its own host (the scoped self-service pattern) still
  // leaves the "may it act" decision with a human.
  supervisor
    .command('install')
    .description('Install a systemd --user unit running this supervisor headlessly (Restart=always; survives logout/reboot with linger)')
    .option('--host <hostId>', 'baked into the unit only if given; otherwise the runner resolves it from the resident bootstrap profile at start')
    .option('--slot <name>', 'baked into the unit only if given; otherwise resolved from the resident bootstrap profile at start')
    .option('--resident-profile <path>', 'baked into the unit only if given (non-default profile path)')
    .option('--quox-bin <path>', 'path to the quox executable the unit runs (default: the stable CLI worktree ~/quox-dashboard-cli, else $QUOX_CLI_DIR, else this process\'s path with a mutable-tree warning — #619)')
    .option('--restart-sec <n>', 'systemd RestartSec for the unit', (v) => parseInt(v, 10), DEFAULT_RESTART_SEC)
    .option('--activate-now', 'acknowledge that the switch is already ON, so installing starts an autonomous responder immediately')
    .action(async (options) => {
      auth.requireAuth();

      // GOVERNANCE SEQUENCING (found by the acceptance owner driving this on
      // a real host, 2026-08-23). "Install does not grant autonomy" is true
      // only while the supervisor switch is OFF: installing then produces a
      // present-but-silent unit. If the switch is already ON, installing
      // brings an autonomous responder live in the same motion, so the act
      // of installing IS the activation. Their safety classifier correctly
      // refused to let them do that, and the boundary should live in the
      // tool rather than only in a classifier that constrains AI callers.
      //
      // So: refuse a plain install while enabled, and name both safe
      // sequences. --activate-now is the deliberate acknowledgement for a
      // human who genuinely means "install and go live right now".
      try {
        const probeHost = options.host || loadResidentProfileSafely(options.residentProfile)?.host_id || null;
        if (probeHost && !options.activateNow) {
          const ep = resolveEndpoint('v1.dev.supervisor.get', { hostId: probeHost });
          const current = resolveSettings(await client.get(ep.path, { service: ep.service }));
          if (current.enabled) {
            throw new Error(
              `Supervisor is already ENABLED for ${probeHost}, so installing now would start an autonomous responder immediately, not a silent one.\n` +
              `Either:\n` +
              `  disable it, install (present but silent), then have a human re-enable it, or\n` +
              `  have a human run this install with --activate-now to activate deliberately.\n` +
              `Turning autonomy on is always a human action by design.`
            );
          }
        }
      } catch (err) {
        // A settings lookup that genuinely failed must not silently become
        // permission to install into an unknown state.
        if (/already ENABLED/.test(err.message)) throw err;
        printWarning(`Could not confirm the supervisor switch state before installing: ${err.message}`);
      }

      // LAUNCH BLOCKER FIX (item 1a, found by the acceptance owner driving
      // this on a real host, 2026-08-23): a unit installed with no slot
      // resolvable dies at startup ("No slot: pass --slot") and, under
      // Restart=always, busy-loops roughly every RestartSec forever, which
      // hits every freshly dev-enabled host until re-enable happens to
      // carry a slot. Resolve the same way `run` does (--slot, else the
      // resident bootstrap profile) and refuse to write anything at all if
      // neither supplies one: never install a unit known to crash on start.
      const resolvedInstallSlot = resolveSlotName(options);
      if (!resolvedInstallSlot) {
        throw new Error(
          'Cannot install: no slot resolved (checked --slot and the resident bootstrap profile).\n' +
          'A unit with no slot dies at startup and busy-loops under systemd Restart=always.\n' +
          'Either pass --slot <name>, or re-run `quox dev enable` once the resident bootstrap profile carries a slot.'
        );
      }

      const extraArgs = [];
      if (options.host) extraArgs.push('--host', options.host);
      if (options.slot) extraArgs.push('--slot', options.slot);
      if (options.residentProfile) extraArgs.push('--resident-profile', options.residentProfile);

      // #619: prefer the STABLE CLI worktree over the install-time process
      // path. Baking process.argv[1] into a Restart=always unit means the unit
      // execs from whatever tree happened to run the install — a mutable dev
      // tree or session worktree there is a delayed bomb (a resident sat dark
      // ~15 days after its tree branch-switched out from under it).
      const { bin: quoxBin, source: binSource, mutable: binMutable } = resolveSupervisorBin({
        quoxBin: options.quoxBin,
        argv1: process.argv[1],
        home: homedir(),
      });
      if (binMutable) {
        printWarning(
          `Unit ExecStart will point at a MUTABLE tree: ${quoxBin}. A long-lived Restart=always unit `
          + `must NOT exec from a live working tree — a branch switch or reset there silently changes or `
          + `removes the deployed supervisor code (#619: a resident crash-looped to dark ~15 days this way). `
          + `Install from the stable CLI worktree (~/quox-dashboard-cli), set $QUOX_CLI_DIR, or pass `
          + `--quox-bin <stable path>. quox-sentry now alarms if the unit later goes dark, but pinning is the fix.`
        );
      } else {
        printInfo(`Unit ExecStart bin: ${quoxBin} (${binSource}).`);
      }

      // BAKE THE ENVIRONMENT INTO THE UNIT (item 1, live outage 2026-08-23):
      // a systemd --user unit inherits none of the shell environment that
      // reach-back URL resolution (resolveResidentBaseUrl) leans on. On a
      // LAN install the instance edge is self-signed, so every re-auth died
      // with a bare "fetch failed", the supervisor logged "Session expired"
      // every 30s, and both residents silently lost their slots. Derive the
      // fix from the same bootstrap profile the resident already trusts for
      // its own identity, so there is nothing new to keep in sync.
      const installProfile = loadResidentProfileSafely(options.residentProfile);
      const env = deriveSupervisorEnv(installProfile);
      if (!installProfile) {
        printWarning(
          'No resident bootstrap profile found: the unit is being installed with no baked-in environment. '
          + 'If this host\'s instance edge is self-signed, re-auth may fail with "fetch failed". '
          + 'Provision a bootstrap profile (or pass --resident-profile) and re-run install to fix this.'
        );
      } else if (Object.keys(env).length === 0) {
        printWarning(
          `Resident bootstrap profile at ${installProfile._path} has no instance_url: the unit is being installed with no baked-in environment. `
          + 'If this host\'s instance edge is self-signed, re-auth may fail with "fetch failed".'
        );
      } else {
        printInfo(`Unit will carry: ${Object.keys(env).join(', ')} (derived from the resident bootstrap profile).`);
      }
      const unitContent = buildUnitFile({ quoxBin, extraArgs, restartSec: options.restartSec, env });
      const unitPath = ctx.unitPath || defaultUnitPath();
      const unitDir = ctx.unitDir || defaultUnitDir();
      const execFn = ctx.execFn || realExecFn;
      const writeFileFn = ctx.writeFileFn || writeFileSync;
      const mkdirFn = ctx.mkdirFn || mkdirSync;
      const user = ctx.osUser || userInfo().username;
      const sleepFn = ctx.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

      const report = await installSupervisorService({ execFn, writeFileFn, mkdirFn, unitPath, unitDir, unitContent, user, sleepFn });

      formatDetail({ ...report, unit_content: unitContent }, { format: program.opts().output, title: `Resident supervisor service (${SERVICE_NAME})` });

      // ITEM 2 (found by the acceptance owner driving this on a real host,
      // 2026-08-23): "enable --now" succeeding only proves systemd accepted
      // the unit, never that it stayed up. A crash loop must be reported as
      // a FAILURE, with the last journal lines when they can be read, never
      // dressed up as the success block below.
      if (report.crash_loop) {
        printWarning(
          `FAILURE: ${SERVICE_NAME} was enabled but is crash-looping ` +
          `(active=${report.active}, restarts=${report.restart_count ?? 'unknown'}). It is answering nothing.`
        );
        if (report.crash_journal) {
          printWarning(`Last journal lines:\n${report.crash_journal}`);
        } else {
          printWarning('Could not read journal lines (journalctl unavailable or restricted).');
        }
      } else if (report.enabled) {
        printSuccess(`Installed and started ${SERVICE_NAME} (systemd --user, Restart=always). Verified it stayed up (active=${report.active}, restarts=${report.restart_count ?? 0}).`);
      } else {
        printWarning(`Unit written to ${unitPath} but \`systemctl --user enable --now\` failed: ${report.enable_error}`);
      }

      if (report.linger_enabled) {
        printSuccess(`Linger enabled for ${user}: the service survives logout and reboot.`);
      } else {
        printWarning(
          `Could not enable linger for ${user} (${report.linger_error}). Without linger, this unit STOPS on logout ` +
          `and will NOT come back on its own after a reboot; it only resumes at the next interactive login. ` +
          `Ask an administrator with sudo to run: loginctl enable-linger ${user}`
        );
      }
    });

  supervisor
    .command('uninstall')
    .description('Disable, stop, and remove the systemd --user unit')
    .action(async () => {
      auth.requireAuth();
      const unitPath = ctx.unitPath || defaultUnitPath();
      const execFn = ctx.execFn || realExecFn;
      const existsFn = ctx.existsFn || existsSync;
      const unlinkFn = ctx.unlinkFn || unlinkSync;

      const report = await uninstallSupervisorService({ execFn, existsFn, unlinkFn, unitPath });
      formatDetail(report, { format: program.opts().output, title: `Resident supervisor service removed (${SERVICE_NAME})` });
      if (report.disabled && report.unit_removed) {
        printSuccess(`${SERVICE_NAME} disabled, stopped, and removed.`);
      } else {
        printWarning(`Uninstall incomplete: disabled=${report.disabled} (${report.disable_error || 'ok'}), unit_removed=${report.unit_removed}.`);
      }
    });

  supervisor
    .command('turns')
    .description('List per-turn receipts (what the headless resident spent, per message)')
    .option('--host <hostId>', 'dev host_id (default: resident bootstrap profile)')
    .option('--since <ts>', 'only receipts after this ISO-8601 timestamp')
    .option('--limit <n>', 'max receipts (default 50)', (v) => parseInt(v, 10))
    .action(async (options) => {
      auth.requireAuth();
      const hostId = resolveHostId(options);
      const ep = resolveEndpoint('v1.dev.supervisor.turns.list', { hostId });
      const query = {};
      if (options.since) query.since = options.since;
      if (options.limit) query.limit = options.limit;
      const data = await client.get(ep.path, { service: ep.service, query });
      const s = data.summary || {};
      printInfo(`${hostId}: ${s.turns ?? 0} turn(s), ${s.replied ?? 0} replied, total $${(s.total_cost_usd ?? 0).toFixed(4)}`);
      formatOutput((data.turns || []).map((t) => ({
        TIME: t.created_at, OUTCOME: t.outcome, FROM: t.message_from || '-',
        CHARS: t.reply_chars ?? '-', COST: t.cost_usd != null ? `$${t.cost_usd.toFixed(4)}` : '-',
        MS: t.duration_ms ?? '-', NOTE: t.error_note || '',
      })), {
        format: program.opts().output,
        columns: ['TIME', 'OUTCOME', 'FROM', 'CHARS', 'COST', 'MS', 'NOTE'],
        emptyMessage: 'No turn receipts yet.',
        raw: data.turns || [],
      });
    });

  supervisor
    .command('status')
    .description('Show resolved supervisor settings and whether a runner appears live')
    .option('--host <hostId>', 'dev host_id (default: resident bootstrap profile)')
    .option('--slot <name>', 'slot (default: resident bootstrap profile)')
    .option('--log <path>', 'log file path', defaultLogPath())
    .option('--state <path>', 'continuity state file path', defaultStatePath())
    .option('--resident-profile <path>', 'resident bootstrap profile path')
    .action(async (options) => {
      auth.requireAuth();
      const { hostId, slotName } = resolveTargets(options);
      const orgId = resolveOrgId(auth, program);
      const selfIdentity = buildSelfIdentity(hostId);
      const ep = resolveEndpoint('v1.dev.supervisor.get', { hostId });
      const raw = await client.get(ep.path, { service: ep.service });
      const settings = resolveSettings(raw);

      // SLOT OWNERSHIP INTENT (item 3, found by the acceptance owner driving
      // this on a real host, 2026-08-23): a foreign hold must be visible
      // here, not just buried in the runner's log — this is how an operator
      // learns why a running, correctly-installed supervisor is nonetheless
      // not answering. Read-only lookup, best-effort: never let a slot-list
      // failure break the rest of `status`. See the idle-heartbeat comment
      // in `run` for the full rationale (never seize a hold another session
      // deliberately owns; same failure class as the checkoutSlot
      // assigned_to bug fixed earlier tonight).
      // FIX 3 (presence must be legible, live outage 2026-08-23): status
      // must say plainly whether THIS resident currently holds its slot,
      // not just name a foreign holder when there is one. Same read-only,
      // best-effort lookup as the foreign-hold check below.
      let foreignHolder = null;
      let heldBySelf = false;
      try {
        const listEp = resolveEndpoint('v1.slots.list');
        const listData = await client.get(listEp.path, { service: listEp.service, query: { org_id: orgId } });
        const slotRow = (listData.slots || []).find((s) => s.name === slotName);
        if (slotRow && slotRow.state === 'held' && slotRow.holder_session) {
          if (slotRow.holder_session === selfIdentity) heldBySelf = true;
          else foreignHolder = slotRow.holder_session;
        }
      } catch (_err) {
        // Best-effort; the rest of `status` still reports.
      }

      const logPath = expandHome(options.log);
      const statePath = expandHome(options.state);
      const state = loadState(statePath);
      const lastActivity = lastLogActivity(logPath);
      const staleAfterMs = Math.max(settings.poll_seconds * 3, 120) * 1000;
      const live = lastActivity != null && (Date.now() - lastActivity) < staleAfterMs;

      // Option A persistence: whether the systemd --user unit itself is
      // installed/enabled/active/lingering. Read-only, same as everything
      // else in this command; installing/removing is `install`/`uninstall`.
      let service = { installed: false, enabled: false, active: false, linger: false };
      try {
        const execFn = ctx.execFn || realExecFn;
        const existsFn = ctx.existsFn || existsSync;
        const unitPath = ctx.unitPath || defaultUnitPath();
        const user = ctx.osUser || userInfo().username;
        service = await getServiceInstallStatus({ execFn, existsFn, unitPath, user });
      } catch (err) {
        service = { installed: false, enabled: false, active: false, linger: false, error: err.message };
      }

      const report = {
        host_id: hostId,
        enabled: settings.enabled,
        slot: settings.slot,
        poll_seconds: settings.poll_seconds,
        turn_timeout_seconds: settings.turn_timeout_seconds,
        max_turns_per_hour: settings.max_turns_per_hour,
        updated_at: settings.updated_at,
        updated_by: settings.updated_by,
        runner_live: live,
        last_log_activity: lastActivity ? new Date(lastActivity).toISOString() : null,
        state_bootstrapped: state.bootstrapped,
        state_decisions_recorded: (state.decisions || []).length,
        state_updated_at: state.updated_at,
        // Defect 2 fix: the last error-shaped turn (never posted to the
        // channel), so an operator can see WHY nothing came through without
        // reading the log file.
        last_turn_error: state.last_turn_error
          ? `${state.last_turn_error.category} (${state.last_turn_error.type}) at ${state.last_turn_error.at}`
          : null,
        service_installed: service.installed,
        service_enabled: service.enabled,
        service_active: service.active,
        service_linger: service.linger,
        slot_held_by_self: heldBySelf,
        slot_held_by_other: foreignHolder,
      };

      formatDetail(report, { format: program.opts().output, title: `Supervisor status: ${hostId}` });
      if (!settings.enabled) {
        printWarning(`Supervisor is disabled for ${hostId} (server-side switch). \`quox dev supervisor run\` will exit immediately.`);
      } else if (!live) {
        printWarning(`No recent runner activity in ${logPath}. Is \`quox dev supervisor run\` actually running?`);
      } else {
        printSuccess(`Runner appears live (last activity ${report.last_log_activity}).`);
      }

      if (service.installed) {
        printInfo(`  service: installed, ${service.enabled ? 'enabled' : 'NOT enabled'}, ${service.active ? 'active' : 'not active'}, linger ${service.linger ? 'ON' : 'OFF'}.`);
        if (!service.linger) {
          printWarning('  linger is OFF: this unit will not survive a reboot until an admin runs `loginctl enable-linger <user>` (or re-run `quox dev supervisor install`).');
        }
      } else {
        printInfo(`  service: not installed. Run \`quox dev supervisor install\` for Option A persistence (survives reboot with no session open).`);
      }

      if (heldBySelf) {
        printSuccess(`  slot ${slotName}: held by this resident (present).`);
      } else if (foreignHolder) {
        printWarning(`  slot ${slotName} is held by ${foreignHolder}: this supervisor is present but not holding it (it never seizes a hold another session owns).`);
      } else {
        printWarning(`  slot ${slotName}: not held by this resident and not held by anyone else either (free). It should claim it on its next poll pass.`);
      }

      if (report.last_turn_error) {
        printWarning(`  last turn failed: ${report.last_turn_error}`);
      }
    });
}
