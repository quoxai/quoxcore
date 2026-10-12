/**
 * Resident pump — QUOXPERTICUS-REVISIT P4 "steer pump".
 *
 * When a resident's slot is held by a FULL INTERACTIVE claude session (the
 * resident itself, deployed via `quox dev resident deploy`), the warden
 * process never answers (see the HOLD-IS-THE-VOICE gate in
 * supervisorEngine.js): the resident already holds the voice. What the
 * warden does instead, while that hold lasts, is PUMP: relay new owner
 * messages from the slot channel into the resident's live tmux pane via the
 * dev-sessions `keys` route (services/collector/lib/devSessionsProxy.js), so
 * the interactive session hears its owner without anyone opening the pane
 * by hand.
 *
 * Live-spike findings this reads (2026-09-04, real injection into a real
 * claude TUI on .131 via tmux send-keys):
 *   - Text injected mid-turn queues cleanly in the composer and submits when
 *     the turn ends. Injection mid-turn is SAFE.
 *   - A permission dialog ("Do you want to proceed? ... Esc to cancel")
 *     BLOCKS the pipeline indefinitely. Queued input survives but does not
 *     process. This pump NEVER injects bare Enter or any control key to
 *     resolve one; a stuck dialog is a residentAlarm.js condition, not
 *     something this module resolves. See paneHasDialog below.
 *   - `keys` is one line, max 4096 chars (the collector's MAX_KEYS_LENGTH),
 *     and the collector appends Enter itself.
 *
 * Every I/O dependency (fetch, pane read, key injection, heartbeat, the
 * clock, sleep) is injected, matching supervisorEngine.js's contract, so
 * this runs under vitest with no real network, no real tmux pane.
 */

import { pickNewMessages, boundSeenIds, pruneOldTurns, shouldPostErrorNotice, ERROR_NOTICE_WINDOW_MS, DEFAULT_SETTINGS } from './supervisorEngine.js';

// The exact literal markers a Claude Code permission dialog shows
// ("Do you want to proceed? 1. Yes 2. No ... Esc to cancel"). Either marker
// alone is enough to hold injection: better to over-detect (delay a message
// one pass) than under-detect and blind-inject into a live approval prompt.
export const DIALOG_MARKERS = ['Do you want to proceed?', 'Esc to cancel'];

export function paneHasDialog(paneText) {
  const text = String(paneText || '');
  return DIALOG_MARKERS.some((marker) => text.includes(marker));
}

function sanitizeOneLine(text) {
  return String(text || '').replace(/\r?\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Build the `keys` line(s) for one owner message: `[slot:<name> owner]
 * <text>`, newlines collapsed to spaces (a literal newline mid-line would
 * submit a half-typed line early — same reasoning as residentSeed.js's
 * oneLine()). A message that overflows maxLen is CHUNKED, never truncated
 * (silent data loss is worse than several turns): each chunk carries its
 * own prefix and a `(i/n)` suffix so the resident can read each line
 * standalone.
 */
export function buildPumpLines({ slotName, text, maxLen = 4000 }) {
  const prefix = `[slot:${slotName} owner] `;
  const sanitized = sanitizeOneLine(text);
  if (prefix.length + sanitized.length <= maxLen) {
    return [`${prefix}${sanitized}`];
  }
  // Reserve headroom for the ` (NN/NN)` suffix appended to every chunk.
  const suffixReserve = 10;
  const available = Math.max(1, maxLen - prefix.length - suffixReserve);
  const parts = [];
  for (let i = 0; i < sanitized.length; i += available) {
    parts.push(sanitized.slice(i, i + available));
  }
  return parts.map((part, i) => `${prefix}${part} (${i + 1}/${parts.length})`);
}

export function createInitialPumpState() {
  return {
    bootstrapped: false,
    seen_ids: [],
    // Owner messages picked up from the channel but not yet delivered to
    // the pane: held back by a stuck dialog, or by the per-hour cap. A
    // message only ever leaves `pending` by being injected, never dropped.
    pending: [],
    injection_timestamps: [],
    overflow_notices: [],
    // Set the moment a permission dialog is first observed; cleared the
    // moment it is no longer observed. residentAlarm.js reads the age of
    // this field to decide whether the stuck-dialog condition should alarm.
    stuck_dialog_since: null,
  };
}

/**
 * Heartbeat the resident's slot hold with retry/backoff. The pump must not
 * rely on the wait long-poll alone to keep the hold warm: a failed poll
 * pass must never stop heartbeats while the collector is genuinely
 * reachable, so this is a small standalone retry loop, called every pump
 * pass regardless of what else happens this pass.
 */
export async function heartbeatWithBackoff({
  heartbeatHold,
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 3,
  baseDelayMs = 2000,
}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await heartbeatHold();
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      log('warn', `pump: heartbeat attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }
  log('warn', `pump: heartbeat failed after ${maxAttempts} attempt(s), giving up this pass (hold may lapse): ${lastErr ? lastErr.message : 'unknown error'}`);
  return { ok: false, attempts: maxAttempts, error: lastErr };
}

/**
 * Run one pump pass: heartbeat the resident's hold, read the pane for a
 * stuck permission dialog, pick up new owner messages, and inject whatever
 * is safe to inject this pass (never while a dialog is visible, never past
 * the per-hour cap).
 *
 * Injected dependencies:
 *   fetchMessages()      -> array of slot messages (same shape the engine
 *                           uses; a `wait`-mode caller can pass the same
 *                           closure it already built for the headless path)
 *   readPane()            -> current pane text (string)
 *   injectKeys(line)      -> POST one `keys` line to the resident's pane
 *   heartbeatHold()       -> heartbeat the slot AS the resident's own
 *                           holder_session (not this warden's identity)
 *   postReply(text)       -> slot `say`, used only for the once-per-hour
 *                           overflow notice
 */
export async function runPumpOnce({
  hostId,
  slot,
  selfIdentity,
  fromFilters = [],
  fetchMessages,
  readPane,
  injectKeys,
  heartbeatHold,
  postReply,
  state,
  log = () => {},
  now = () => Date.now(),
  maxSeenIds = 500,
  maxTurnsPerHour = DEFAULT_SETTINGS.max_turns_per_hour,
  maxLineLen = 4000,
  heartbeatMaxAttempts = 3,
  heartbeatBaseDelayMs = 2000,
  sleep,
}) {
  const heartbeat = await heartbeatWithBackoff({
    heartbeatHold, log, sleep, maxAttempts: heartbeatMaxAttempts, baseDelayMs: heartbeatBaseDelayMs,
  });

  const paneText = await readPane();
  const dialogPresent = paneHasDialog(paneText);

  let nextState = { ...state, pending: [...(state.pending || [])] };

  if (dialogPresent) {
    if (nextState.stuck_dialog_since == null) {
      nextState.stuck_dialog_since = now();
      log('warn', `slot ${slot}: permission dialog detected in the resident's pane on ${hostId}; holding owner messages until it clears (never injecting Enter to resolve it).`);
    }
  } else if (nextState.stuck_dialog_since != null) {
    log('info', `slot ${slot}: permission dialog cleared after ${Math.round((now() - nextState.stuck_dialog_since) / 1000)}s; resuming injection.`);
    nextState.stuck_dialog_since = null;
  }

  const messages = await fetchMessages();
  const firstRun = nextState.bootstrapped !== true;
  const picked = pickNewMessages({ messages, seenIds: nextState.seen_ids, selfIdentity, fromFilters, firstRun });
  nextState.seen_ids = boundSeenIds(picked.seenIds, maxSeenIds);
  if (firstRun) {
    nextState.bootstrapped = true;
    log('info', `pump first run on ${slot}: seeded seen-set with ${picked.allSeen.length} existing message id(s), queuing none for injection.`);
  }

  const newPending = picked.toAnswer.filter((m) => !nextState.pending.some((p) => p.id === m.id));
  nextState.pending = [...nextState.pending, ...newPending];
  if (newPending.length > 0) {
    log('info', `pump: queued ${newPending.length} new owner message(s) for ${slot}'s resident.`);
  }

  let injected = 0;
  let capHit = false;

  if (!dialogPresent) {
    let timestamps = pruneOldTurns(nextState.injection_timestamps, now(), ERROR_NOTICE_WINDOW_MS);
    const stillPending = [];
    for (const message of nextState.pending) {
      if (timestamps.length >= maxTurnsPerHour) {
        capHit = true;
        stillPending.push(message);
        continue;
      }
      const lines = buildPumpLines({ slotName: slot, text: message.text, maxLen: maxLineLen });
      for (const line of lines) {
        await injectKeys(line);
      }
      timestamps = [...timestamps, now()];
      injected += 1;
      log('info', `pump: injected message ${message.id} from ${message.from} into ${slot}'s resident pane (${lines.length} line(s)).`);
    }
    nextState.pending = stillPending;
    nextState.injection_timestamps = timestamps;
  } else if (nextState.pending.length > 0) {
    log('warn', `pump: ${nextState.pending.length} owner message(s) on ${slot} held, waiting for the permission dialog to clear.`);
  }

  if (capHit && nextState.pending.length > 0) {
    const notice = shouldPostErrorNotice(nextState.overflow_notices, 'pump_rate_cap', now(), ERROR_NOTICE_WINDOW_MS);
    nextState.overflow_notices = notice.notices;
    if (notice.shouldPost) {
      const text = `Pump injection cap reached (${maxTurnsPerHour}/hour) on slot ${slot}: ${nextState.pending.length} owner message(s) still queued, will resume as the hour rolls over.`;
      await postReply(text);
      log('warn', `pump: posted once-per-hour overflow notice on ${slot} (${nextState.pending.length} still queued).`);
    }
  }

  return { state: nextState, injected, dialogPresent, pendingCount: nextState.pending.length, heartbeat };
}
