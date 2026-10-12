/**
 * Resident alarm — QUOXPERTICUS-REVISIT P5 "warden watchdog + loud alarm".
 *
 * While the warden pumps (residentPump.js) instead of answering, it also
 * watches the resident it wards: is the tmux pane still there, has a
 * permission dialog been stuck too long to ever clear itself, has the
 * provider started refusing turns. Three independent conditions, each with
 * its own escalating alert schedule (10m, 30m, then hourly) so a wedged
 * resident is loud rather than silently absent, and each condition clears
 * itself the moment its detector stops firing (no human-ack mechanism yet:
 * clearing = the underlying thing is gone).
 *
 * Every I/O dependency (tmux session list, pane read, release/redeploy,
 * the alert transport, the turn-receipt store, the clock) is injected, same
 * contract as supervisorEngine.js and residentPump.js, so this runs under
 * vitest with no real tmux host and no real Telegram bridge.
 */

import { ERROR_NOTICE_WINDOW_MS } from './supervisorEngine.js';

// Gaps BETWEEN successive alerts for the SAME still-active condition:
// immediate on first detection (see shouldSendAlarm), then +10m, then +30m,
// then hourly forever until the condition clears.
export const ALARM_SCHEDULE_MS = [10 * 60 * 1000, 30 * 60 * 1000, ERROR_NOTICE_WINDOW_MS];

// A stuck permission dialog only becomes an alarm condition once it has sat
// unresolved this long. Below this age it is exactly what residentPump.js
// already logs: held input, not yet an incident.
export const STUCK_DIALOG_ALARM_THRESHOLD_MS = 10 * 60 * 1000;

// Pane-text scan patterns for a provider/credits failure. Deliberately
// simple substring/regex matches (this is pane TEXT, not a structured
// provider error object the way detectTurnError in supervisorEngine.js
// parses a headless turn's JSON output) — same spirit, different signal.
export const PROVIDER_ISSUE_PATTERNS = [
  { pattern: 'out of usage credits', regex: /out of usage credits/i },
  { pattern: 'usage limit', regex: /usage limit/i },
  { pattern: 'provider error', regex: /provider error/i },
];

export function scanPaneForProviderIssue(paneText) {
  const text = String(paneText || '');
  for (const { pattern, regex } of PROVIDER_ISSUE_PATTERNS) {
    if (regex.test(text)) return { matched: true, pattern };
  }
  return { matched: false, pattern: null };
}

export function createInitialAlarmCondition() {
  return { active: false, first_detected_at: null, last_alerted_at: null, alert_count: 0 };
}

export function createInitialAlarmState() {
  return {
    pane_dead_attempted: false,
    pane_dead_redeploy_failed: false,
    conditions: {
      pane_dead: createInitialAlarmCondition(),
      stuck_dialog: createInitialAlarmCondition(),
      provider_error: createInitialAlarmCondition(),
    },
  };
}

/**
 * Advance one condition's state from a single boolean detection this pass.
 * A detection while already active is a no-op (first_detected_at sticks to
 * the original onset). No detection while active is a full reset: clearing
 * a condition means the next detection is treated as a fresh onset, with
 * its own fresh alert schedule.
 */
export function updateAlarmCondition(conditionState, detected, now) {
  const current = conditionState || createInitialAlarmCondition();
  if (detected) {
    if (current.active) return current;
    return { ...current, active: true, first_detected_at: now };
  }
  if (current.active) return createInitialAlarmCondition();
  return current;
}

/**
 * Whether condition `conditionState` should alert right now. The first
 * alert for a freshly-active condition fires immediately (no delay: a dead
 * pane or a provider outage is news the moment it is confirmed). Every
 * alert after that waits at least the schedule's gap for however many
 * alerts have already fired, capped at the schedule's last (hourly) entry.
 */
export function shouldSendAlarm(conditionState, now, schedule = ALARM_SCHEDULE_MS) {
  if (!conditionState || !conditionState.active) return false;
  if (conditionState.last_alerted_at == null) return true;
  const idx = Math.min(Math.max((conditionState.alert_count || 0) - 1, 0), schedule.length - 1);
  const gap = schedule[idx];
  return (now - conditionState.last_alerted_at) >= gap;
}

export function recordAlarmSent(conditionState, now) {
  return { ...conditionState, last_alerted_at: now, alert_count: (conditionState.alert_count || 0) + 1 };
}

/**
 * Send one alarm through both transports in order, per spec: tg-send.sh
 * first (the owner's phone), `quox slot say` second as the fallback when
 * tg-send.sh is unavailable or fails — never silent, and the absence of the
 * script is itself treated as "alarm-transport-unavailable", not a reason
 * to skip the slot notice.
 */
export async function sendAlarm({ tgSend, postSlotNotice, text, sessionName = 'WARDEN', log = () => {} }) {
  let tgSent = false;
  if (tgSend) {
    try {
      await tgSend(sessionName, text);
      tgSent = true;
    } catch (err) {
      log('warn', `alarm: tg-send.sh failed, falling back to slot say: ${err.message}`);
    }
  } else {
    log('warn', 'alarm: alarm-transport-unavailable (tg-send.sh not found), falling back to slot say');
  }
  if (!tgSent) {
    try {
      await postSlotNotice(text);
    } catch (err) {
      log('error', `alarm: slot say fallback also failed: ${err.message}`);
    }
  }
  return { tg_sent: tgSent };
}

/**
 * Run one warden watchdog pass.
 *
 * Injected dependencies:
 *   listSessions()        -> array of the host's tmux sessions ({name, ...})
 *   readPane()             -> current pane text (only called while the pane
 *                             is confirmed alive)
 *   releaseSlot()           -> release the resident's slot (best-effort)
 *   redeploy()               -> run the redeploy path (reuses `quox dev
 *                             resident deploy`; throws on failure)
 *   claimFallback()          -> attempt to claim the slot as this warden's
 *                             own fallback voice (only called when redeploy
 *                             fails); returns {claimed: bool}
 *   postSlotNotice(text)     -> slot `say`
 *   recordTurn(fields)       -> turn receipt (outcome/error_note only;
 *                             NEVER a new outcome value — see
 *                             devSupervisorTurnsStore.js OUTCOMES)
 *   tgSend(session, text)    -> shells out to tg-send.sh; absent/failing is
 *                             handled by sendAlarm above, never thrown here
 *   stuckDialogSinceMs        -> residentPump.js's state.stuck_dialog_since
 *                             for this slot (single source of truth for
 *                             dialog detection; this module only ages it)
 */
export async function runWardenPass({
  hostId,
  slot,
  sessionName,
  listSessions,
  readPane,
  releaseSlot,
  redeploy,
  claimFallback,
  postSlotNotice,
  recordTurn,
  tgSend,
  stuckDialogSinceMs = null,
  state,
  log = () => {},
  now = () => Date.now(),
  schedule = ALARM_SCHEDULE_MS,
  stuckDialogThresholdMs = STUCK_DIALOG_ALARM_THRESHOLD_MS,
}) {
  const base = state || createInitialAlarmState();
  const nextState = {
    pane_dead_attempted: base.pane_dead_attempted ?? false,
    pane_dead_redeploy_failed: base.pane_dead_redeploy_failed ?? false,
    conditions: {
      pane_dead: base.conditions?.pane_dead || createInitialAlarmCondition(),
      stuck_dialog: base.conditions?.stuck_dialog || createInitialAlarmCondition(),
      provider_error: base.conditions?.provider_error || createInitialAlarmCondition(),
    },
  };

  const nowMs = now();
  const report = { pane_alive: null, redeployed: false, redeploy_error: null, fallback_claimed: false, alerts_sent: [] };

  const sessions = await listSessions();
  const paneAlive = !!(sessions || []).find((s) => s.name === sessionName);
  report.pane_alive = paneAlive;

  let paneText = null;

  if (!paneAlive) {
    if (!nextState.pane_dead_attempted) {
      nextState.pane_dead_attempted = true;
      log('warn', `warden: resident session ${sessionName} on ${hostId} is not present (pane dead); releasing the slot and redeploying.`);
      try {
        await releaseSlot();
      } catch (err) {
        log('warn', `warden: releasing ${slot} failed (continuing): ${err.message}`);
      }
      try {
        await redeploy();
        report.redeployed = true;
        nextState.pane_dead_redeploy_failed = false;
        nextState.conditions.pane_dead = createInitialAlarmCondition();
        try {
          await postSlotNotice(`Resident on ${hostId} lost its pane; redeployed automatically.`);
        } catch (err) {
          log('warn', `warden: redeploy notice failed to post: ${err.message}`);
        }
        try {
          await recordTurn({ outcome: 'error', error_note: 'pane_dead_auto_redeployed' });
        } catch (err) {
          log('warn', `warden: redeploy receipt failed to post: ${err.message}`);
        }
      } catch (err) {
        report.redeploy_error = err.message;
        nextState.pane_dead_redeploy_failed = true;
        log('error', `warden: redeploy failed for ${hostId}: ${err.message}`);
        try {
          await postSlotNotice(`Resident on ${hostId} lost its pane and automatic redeploy FAILED (${err.message}). A human should check this host.`);
        } catch (err2) {
          log('warn', `warden: failure notice failed to post: ${err2.message}`);
        }
        try {
          const fb = await claimFallback();
          report.fallback_claimed = !!(fb && fb.claimed);
        } catch (err2) {
          log('warn', `warden: fallback claim attempt failed: ${err2.message}`);
        }
      }
    }
    if (nextState.pane_dead_redeploy_failed) {
      nextState.conditions.pane_dead = updateAlarmCondition(nextState.conditions.pane_dead, true, nowMs);
    }
  } else {
    if (nextState.pane_dead_attempted || nextState.conditions.pane_dead.active) {
      log('info', `warden: resident session ${sessionName} on ${hostId} is present again; pane-dead condition cleared.`);
    }
    nextState.pane_dead_attempted = false;
    nextState.pane_dead_redeploy_failed = false;
    nextState.conditions.pane_dead = updateAlarmCondition(nextState.conditions.pane_dead, false, nowMs);

    try {
      paneText = await readPane();
    } catch (err) {
      log('warn', `warden: pane read failed on ${hostId} (skipping provider-error scan this pass): ${err.message}`);
    }
  }

  // Stuck dialog: this module never detects the dialog itself, it only ages
  // what residentPump.js already found (single source of truth).
  const dialogStuck = stuckDialogSinceMs != null && (nowMs - stuckDialogSinceMs) >= stuckDialogThresholdMs;
  nextState.conditions.stuck_dialog = updateAlarmCondition(nextState.conditions.stuck_dialog, dialogStuck, nowMs);

  if (paneText != null) {
    const scan = scanPaneForProviderIssue(paneText);
    nextState.conditions.provider_error = updateAlarmCondition(nextState.conditions.provider_error, scan.matched, nowMs);
  }

  const conditionAlerts = [
    ['pane_dead', `Resident on ${hostId}: pane is dead and automatic redeploy failed. A human should check this host.`],
    ['stuck_dialog', `Resident on ${hostId}: a permission dialog has been stuck for over ${Math.round(stuckDialogThresholdMs / 60000)} minutes and will never resolve itself; a human must approve or cancel it.`],
    ['provider_error', `Resident on ${hostId}: a provider/credits error was detected in its pane. A human should check its account/billing status.`],
  ];

  for (const [key, message] of conditionAlerts) {
    const condition = nextState.conditions[key];
    if (shouldSendAlarm(condition, nowMs, schedule)) {
      const sendResult = await sendAlarm({ tgSend, postSlotNotice, text: message, sessionName: `WARDEN-${hostId}`, log });
      nextState.conditions[key] = recordAlarmSent(condition, nowMs);
      try {
        await recordTurn({ outcome: 'error', error_note: `alarm_${key}` });
      } catch (err) {
        log('warn', `warden: alarm receipt failed for ${key}: ${err.message}`);
      }
      report.alerts_sent.push({ condition: key, tg_sent: sendResult.tg_sent });
    }
  }

  return { state: nextState, ...report };
}
