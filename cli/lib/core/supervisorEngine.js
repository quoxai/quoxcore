/**
 * `quox dev supervisor` engine, DEVSUITE-DEVMODE (quox#453 phase 15 follow-on).
 *
 * The headless runner that lets a dev host's resident agent answer its slot
 * channel with no interactive session open. Everything here is pure or takes
 * its side effects (HTTP, child-process spawn, the clock) as injected
 * functions, so the CLI command layer (`lib/commands/devSupervisor.js`) is a
 * thin wrapper and the logic below can be driven directly from tests without
 * spawning a real `claude` process or hitting a real collector.
 *
 * Contract this reads (a separate agent owns the write side):
 *   GET {collector}/api/v1/dev-servers/:hostId/supervisor
 *     -> {host_id, enabled, slot, poll_seconds, turn_timeout_seconds,
 *         max_turns_per_hour, updated_at, updated_by}
 *   Always returns a shape (enabled false + defaults) even for an unknown
 *   host. This module never writes to that endpoint.
 */

// CLI-side fallback only. The collector's default is authoritative; these
// are used only if a field is missing or malformed in the response, so a
// half-formed settings payload never turns into "spawn as fast as possible".
export const DEFAULT_SETTINGS = {
  enabled: false,
  poll_seconds: 30,
  turn_timeout_seconds: 120,
  max_turns_per_hour: 6,
};

const ONE_HOUR_MS = 60 * 60 * 1000;

// DEFECT FIX (2026-08-23, live incident: ~6 USD of paid turns burned working
// through hours-old backlog after a disabled -> enabled transition). Any
// owner message older than this is never eligible for a turn, however it
// became eligible. Belt to the disabled->enabled reseed's braces below:
// bounds paid churn even if some future code path reintroduces an unseeded
// cursor. Overridable via `--max-age-minutes` in the CLI command layer.
export const DEFAULT_MAX_MESSAGE_AGE_MINUTES = 15;

// How often the same distinct turn-error signature is allowed to post its
// one honest "I can't answer right now" notice into the channel. Silence
// forever is also a failure mode; this caps it to one signal per hour per
// distinct error, not spam and not nothing.
export const ERROR_NOTICE_WINDOW_MS = ONE_HOUR_MS;

// Option A persistence (service mode, DEVSUITE-DEVMODE follow-on).
//
// How long a `--service` runner idles between re-checks of the server-side
// switch once it finds itself disabled. Slow on purpose: this is a "did a
// human turn it back on" poll, not the message-latency path, so it costs
// nothing to keep long.
export const DEFAULT_IDLE_RECHECK_SECONDS = 60;

// How many consecutive long-poll (`slot wait`) failures the continuous run
// loop tolerates before it gives up on waiting and falls back to the
// original interval-poll loop for the rest of this process's life. This is
// the degrade-not-die seam: a collector that stops answering `/wait` must
// not take the runner down with it.
export const DEFAULT_WAIT_FAILURE_THRESHOLD = 3;

// LOOP TRIAGE FIX (diagnosed live 2026-09-10, .131): the resident supervisor
// held its QuoxSlot only via the `slot wait` long-poll's server-side
// heartbeat coupling, so an intermittent hang on the authenticated slot path
// (observed: "checkout attempt failed: Request timed out after 30000ms"
// while /health stayed instant, so this is a server-side hang, not a network
// one) wedged the long-poll and heartbeated nothing until it recovered. The
// hold then lapsed stale (15m TTL) then free (30m), and re-claimed roughly
// 45 minutes later: ~193 times over 6 days. This is the interval this
// module's independent heartbeat (see startIndependentHeartbeat below) ticks
// on: well under the 15m held-TTL so even a long stall is covered by many
// ticks, and independent of any single request's lifecycle.
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 20;

// How often the SAME independent-heartbeat failure signature (a 409, or a
// given error message) is allowed to log again. Same shape as
// ERROR_NOTICE_WINDOW_MS above but a much shorter window: this is a local
// log line, not an owner-facing channel notice, so it can afford to remind
// more often without being spam, while never logging once per 20s tick for
// the whole length of an outage.
export const HEARTBEAT_FAILURE_LOG_WINDOW_MS = 5 * 60 * 1000;

/**
 * Start an independent, self-scheduling heartbeat that keeps a slot hold
 * warm on its OWN timer, decoupled from every other loop in this runner
 * (the `slot wait` long-poll, a turn spawn, an idle re-check). Every tick is
 * its own function call scheduled directly by the interval, not chained
 * after the previous tick's promise settles, so a hung or slow
 * postHeartbeat call on one tick can never block or cancel the next tick.
 *
 * 409 semantics are preserved exactly as elsewhere in this module (see
 * attemptSlotClaim above and the idle-heartbeat handling in
 * devSupervisor.js): a 409 means "not held by this resident" and is logged,
 * never seized. This function never calls checkoutSlot or anything else
 * that could take a hold from another session; it only ever heartbeats a
 * hold this resident already has.
 *
 * Failure accounting follows the loop triad (see CLAUDE.md Loop & Restart
 * Hygiene): successes and failures are counted distinctly (getCounts()),
 * and a repeated identical failure logs at most once per
 * HEARTBEAT_FAILURE_LOG_WINDOW_MS, never once per tick, so a long outage
 * cannot spam the log forever while still never going silent for its whole
 * duration.
 *
 * setIntervalFn/clearIntervalFn/now are injected so tests can drive and
 * verify this with no real timer and full control over tick timing.
 */
export function startIndependentHeartbeat({
  postHeartbeat,
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_SECONDS * 1000,
  log = () => {},
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let successCount = 0;
  let failureCount = 0;
  let notices = [];

  const tick = async () => {
    try {
      await postHeartbeat();
      successCount += 1;
      if (notices.length > 0) {
        log('info', 'independent heartbeat: recovered, ticking cleanly again.');
        notices = [];
      }
    } catch (err) {
      failureCount += 1;
      const is409 = !!(err && err.status === 409);
      const signature = is409 ? 'heartbeat_409' : `heartbeat_error:${err && err.message}`;
      const notice = shouldPostErrorNotice(notices, signature, now(), HEARTBEAT_FAILURE_LOG_WINDOW_MS);
      notices = notice.notices;
      if (notice.shouldPost) {
        if (is409) {
          log('warn', 'independent heartbeat: 409 (not held by this resident), leaving it alone rather than seizing it.');
        } else {
          log('warn', `independent heartbeat failed, never stops ticking (will keep retrying every ${Math.round(intervalMs / 1000)}s): ${err && err.message}`);
        }
      }
    }
  };

  // Each tick is its own call, scheduled by the interval itself: a hung
  // tick's promise is never awaited here, so the interval keeps firing on
  // schedule regardless of how long, or whether, any single tick settles.
  const timer = setIntervalFn(() => tick(), intervalMs);
  if (timer && typeof timer.unref === 'function') {
    try { timer.unref(); } catch { /* fake timers may not implement unref; harmless either way */ }
  }

  return {
    stop: () => clearIntervalFn(timer),
    getCounts: () => ({ successCount, failureCount }),
  };
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** Resolve settings with the CLI-side fallback applied per-field. */
export function resolveSettings(raw) {
  const s = raw || {};
  return {
    host_id: s.host_id ?? null,
    enabled: s.enabled === true,
    slot: s.slot ?? null,
    poll_seconds: numberOr(s.poll_seconds, DEFAULT_SETTINGS.poll_seconds),
    turn_timeout_seconds: numberOr(s.turn_timeout_seconds, DEFAULT_SETTINGS.turn_timeout_seconds),
    max_turns_per_hour: numberOr(s.max_turns_per_hour, DEFAULT_SETTINGS.max_turns_per_hour),
    updated_at: s.updated_at ?? null,
    updated_by: s.updated_by ?? null,
  };
}

/**
 * Owner-match rule (final, per spec, read this before touching the
 * filtering below):
 *
 *   1. Any message with source === 'say' is NEVER a candidate. That source
 *      means it was posted through the slot `say` seam, which is exactly
 *      the seam this runner posts its own replies through.
 *   2. If one or more --from names were given, a message is a candidate
 *      only when its `from` case-insensitively matches one of them. This is
 *      the configurable "who counts as the owner" allowlist.
 *   3. With no --from given, a message is a candidate only when it fails
 *      BOTH self-checks: its `author_identity` (server-derived, unforgeable
 *      — see devSlotMessagesStore.deriveCallerIdentity) does not equal
 *      `selfIdentity`, AND its `from` label does not equal `selfIdentity`
 *      either. `author_identity` is the primary, trustworthy check: `from`
 *      is caller-controlled free text with no server-side check, so a
 *      message can claim to be from anyone while its author_identity still
 *      names this resident. That is the impersonation case this must catch
 *      to avoid a self-loop (a session's own posts rendering under a
 *      different session's name, found live 2026-08-23). The `from` check
 *      stays as an additional filter, not the removed primary one, since a
 *      message with no author_identity at all (rows written before
 *      migrations/aee/022, or by callers that predate identity resolution)
 *      still needs a check to fall back on.
 *
 * The invariant that must hold across both branches: this can never answer
 * its own post, and (enforced by the caller, pickNewMessages) never
 * re-answers a message id it has already seen.
 */
export function isOwnerMessage(message, { selfIdentity, fromFilters = [] } = {}) {
  if (!message) return false;
  // `source === 'say'` used to be excluded outright, because that is the seam
  // the runner posts its own replies through and there was no trustworthy way
  // to tell its posts from anyone else's. The cost, found live 2026-08-23:
  // a HUMAN using `quox slot say` could never reach a resident at all, which
  // makes the CLI useless for talking to one. Now that author_identity is
  // server-stamped and unforgeable (mig 022), exclude the actual thing that
  // must be excluded (posts THIS resident wrote) rather than everything that
  // used the CLI. Legacy rows carry no author_identity, so for those the old
  // blunt rule still applies: with no verifiable author there is no safe way
  // to tell a self-post from a human's, and a self-loop is the worse failure.
  if (message.source === 'say' && message.author_identity == null) return false;
  if (fromFilters && fromFilters.length > 0) {
    const from = String(message.from || '').toLowerCase();
    return fromFilters.some((f) => String(f).toLowerCase() === from);
  }
  const self = String(selfIdentity || '');
  const isSelfByIdentity = message.author_identity != null && String(message.author_identity) === self;
  const isSelfByLabel = String(message.from || '') === self;
  return !isSelfByIdentity && !isSelfByLabel;
}

/** The identity this runner posts its own replies as. See isOwnerMessage. */
export function buildSelfIdentity(hostId) {
  return `resident:${hostId}`;
}

export const CLAIM_SAFETY_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Local "I hold this slot" memory shared across poll passes (HOT LOOP FIX,
 * 2026-10-11: the collector returns success for a same-holder checkout, so
 * calling checkout on every 15 s pass cost a full checkout each time).
 * After a successful claim, attemptSlotClaim only heartbeats; it re-checks
 * out when the heartbeat says 409/404 or after CLAIM_SAFETY_INTERVAL_MS.
 */
export function createClaimState() {
  return { held: false, claimedAt: 0 };
}

/**
 * PRESENCE FIX (item 2, live outage 2026-08-23): both residents' slots sat
 * FREE the whole time their supervisors were running, because nothing in
 * this runner ever called checkout, only heartbeat, and heartbeat requires
 * an existing hold and does nothing when the slot is free. Presence is half
 * the point of a resident; a supervisor that runs but never holds its slot
 * reads as absent to anyone watching.
 *
 * Attempts to check the slot out as `selfIdentity`. The collector's
 * checkoutSlot is itself a compare-and-swap on `state = 'free'`, so this is
 * safe to call unconditionally on every poll pass: a slot that is already
 * free gets claimed, a slot this resident already holds 409s harmlessly
 * (the row is `held`, not `free`, whoever holds it), and a slot held by a
 * DIFFERENT session also 409s, never seized, exactly the rule already in
 * force for the idle heartbeat 409 below. `checkoutSlot` is optional so
 * every existing caller that does not pass one keeps working unchanged.
 *
 * Never throws: any failure (409 or otherwise) is caught, logged, and
 * treated as "did not claim this pass", so a claim attempt can never take
 * the runner down.
 */
export async function attemptSlotClaim({
  checkoutSlot, selfIdentity, slot, log = () => {}, announceForeignHold = true,
  claimState = null, postHeartbeat = null, now = () => Date.now(), safetyIntervalMs = CLAIM_SAFETY_INTERVAL_MS,
}) {
  if (!checkoutSlot) return { claimed: false, reason: 'no_checkout_fn' };
  if (claimState && claimState.held && postHeartbeat && now() - claimState.claimedAt < safetyIntervalMs) {
    try {
      await postHeartbeat();
      return { claimed: false, reason: 'already_held' };
    } catch (err) {
      if (!(err && (err.status === 409 || err.status === 404))) {
        log('warn', `slot ${slot}: claim-pass heartbeat failed: ${err && err.message}`);
        return { claimed: false, reason: 'error', error: err };
      }
      claimState.held = false;
      claimState.lapsed = true;
    }
  }
  try {
    const wasHeld = !!(claimState && claimState.everHeld);
    const res = await checkoutSlot();
    if (claimState) { claimState.held = true; claimState.everHeld = true; claimState.claimedAt = now(); }
    const refreshed = !!(res && res.refreshed);
    // GRIPE-797: log state transitions only. A periodic safety re-checkout
    // of a hold this process already had is a renewal, not a new claim.
    if (wasHeld && claimState && !claimState.lapsed) return { claimed: true, refreshed: true };
    if (claimState) claimState.lapsed = false;
    log('info', refreshed
      ? `slot ${slot}: already held by this resident, refreshed.`
      : `slot ${slot}: claimed (was free), now present.`);
    return refreshed ? { claimed: true, refreshed } : { claimed: true };
  } catch (err) {
    if (claimState) { claimState.held = false; claimState.lapsed = true; }
    if (err && err.status === 409) {
      const holder = err.detail?.holder_session || null;
      if (holder && holder !== selfIdentity) {
        if (announceForeignHold) {
          log('warn', `slot ${slot}: checkout refused (409), held by ${holder}, leaving it alone rather than seizing it. Run \`quox dev supervisor status\` to see who holds it.`);
        }
        return { claimed: false, reason: 'held_by_other', holder };
      }
      // Held by us already (older collectors 409 a same-holder checkout).
      if (claimState) { claimState.held = true; claimState.claimedAt = now(); }
      return { claimed: false, reason: 'already_held' };
    }
    log('warn', `slot ${slot}: checkout attempt failed: ${err.message}`);
    return { claimed: false, reason: 'error', error: err };
  }
}

/**
 * Pick which messages are new answerable owner turns.
 *
 * On the very first run for a fresh state file (firstRun: true), every
 * currently-visible message id is seeded into the seen-set and NOTHING is
 * answered: a resident that just came under supervision must not suddenly
 * reply to a channel's entire backlog.
 */
export function pickNewMessages({ messages, seenIds, selfIdentity, fromFilters = [], firstRun }) {
  const seen = new Set(seenIds || []);
  const list = Array.isArray(messages) ? messages : [];
  const allIds = list.map((m) => m.id).filter((id) => id != null);

  if (firstRun) {
    return {
      toAnswer: [],
      seenIds: Array.from(new Set([...seen, ...allIds])),
      allSeen: allIds,
    };
  }

  const toAnswer = [];
  for (const m of list) {
    if (m.id == null || seen.has(m.id)) continue;
    if (isOwnerMessage(m, { selfIdentity, fromFilters })) toAnswer.push(m);
  }
  return {
    toAnswer,
    seenIds: Array.from(new Set([...seen, ...allIds])),
    allSeen: allIds,
  };
}

// Bounding helpers. Keep the continuity state file flat over a resident's
// whole life so per-turn cost (prompt size) stays constant.

export function boundSeenIds(ids, max = 500) {
  const arr = Array.from(new Set(ids || []));
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

export function boundDecisions(list, max = 20) {
  const arr = list || [];
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

export function boundExchanges(list, max = 10) {
  const arr = list || [];
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

// Rate limiting.

export function pruneOldTurns(timestamps, now, windowMs = ONE_HOUR_MS) {
  return (timestamps || []).filter((t) => now - t < windowMs);
}

/**
 * Age of a message in ms, or null when it carries no usable timestamp.
 * Never treats "no timestamp" as stale: that would silently swallow
 * messages from a source that just doesn't send one, which is a worse
 * failure than the churn this guard exists to prevent.
 */
export function messageAgeMs(message, now) {
  const ts = message?.created_at ?? message?.timestamp ?? message?.ts ?? null;
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? now - t : null;
}

// Distinct-signature dedup for the turn-error notice (defect 2). Same shape
// as pruneOldTurns but keyed on {signature, at} pairs rather than bare
// timestamps, since dedup is per-signature, not a flat rate cap.
export function pruneErrorNotices(notices, now, windowMs = ERROR_NOTICE_WINDOW_MS) {
  return (notices || []).filter((n) => n && Number.isFinite(n.at) && now - n.at < windowMs);
}

/**
 * Decide whether a turn-error notice for `signature` may post right now.
 * Returns the pruned+updated notices list either way, so the caller always
 * persists a clean list (this is also where the "pruned" half of "tracked
 * in state and pruned" happens, on every error, not just on dedup hits).
 */
export function shouldPostErrorNotice(notices, signature, now, windowMs = ERROR_NOTICE_WINDOW_MS) {
  const pruned = pruneErrorNotices(notices, now, windowMs);
  const alreadyNotified = pruned.some((n) => n.signature === signature);
  if (alreadyNotified) return { shouldPost: false, notices: pruned };
  return { shouldPost: true, notices: [...pruned, { signature, at: now }] };
}

// Turn prompt.
//
// SUPERVISOR_TURN_PROMPT is built by buildTurnPrompt below and is the exact
// text sent to every headless `claude -p` turn. Kept as one clearly-marked,
// reviewable function: every safeguard promised for this runner (proof
// before claim, no fabrication, no em dashes, reply text only) is enforced
// here or nowhere.
export function buildTurnPrompt({ hostId, slot, message, history, state }) {
  const historyBlock = (history || [])
    .map((h) => `${h.from}: ${h.text}${h.reply ? `\n  (you replied: ${h.reply})` : ''}`)
    .join('\n') || '(no prior channel history)';
  const decisionsBlock = (state?.decisions || [])
    .slice(-5)
    .map((d) => `- ${d.at}: replied to ${d.from} (${d.reply_excerpt})`)
    .join('\n') || '(none recorded yet)';

  return [
    `You are the resident agent for dev host "${hostId}", answering its slot channel "${slot}" with no interactive session open.`,
    '',
    'Recent channel history (most recent last):',
    historyBlock,
    '',
    'Recent decisions/focus you recorded:',
    decisionsBlock,
    '',
    'The owner just said:',
    `${message.from}: ${message.text}`,
    '',
    'Rules:',
    '- Prove any claim before making it. State what you actually checked, never assume or fabricate a result.',
    '- Never use em dashes or double hyphens in your reply.',
    '- Reply with the message text only: no preamble, no headers, no code fences unless the reply itself is code.',
    '- If you are not sure, say so plainly rather than guessing.',
  ].join('\n');
}

/**
 * DEFECT FIX (2026-08-23, live incident: a raw provider error, e.g.
 * `{"type":"not_found_error","message":"model: fable"}` from a
 * misconfigured headless model, got posted verbatim into the slot channel
 * as the resident's reply).
 *
 * Detects a failed or error-shaped turn by three independent signals (any
 * one is enough): a non-zero exit code, an `is_error`/`error` field in the
 * parsed JSON output, or a body that parses (directly, or embedded in a
 * non-JSON stdout such as a "API Error: 404 {...}" preamble the CLI can
 * print on error paths) as a provider error object shaped
 * `{type: "..._error", message: "..."}`. Returns null for a clean turn.
 */
export function detectTurnError(result) {
  if (!result || result.timedOut || result.error) return null;

  const raw = result.raw;
  let errorObj = null;
  if (raw && typeof raw === 'object') {
    if (raw.is_error === true) errorObj = (raw.error && typeof raw.error === 'object') ? raw.error : raw;
    else if (raw.error && typeof raw.error === 'object') errorObj = raw.error;
    else if (typeof raw.type === 'string' && /_error$/i.test(raw.type)) errorObj = raw;
  }

  if (!errorObj) {
    // Fallback: the provider error object may be embedded in non-JSON
    // stdout (a preamble broke JSON.parse), in either field order.
    const candidate = String(result.text || result.stdout || '');
    const m = candidate.match(/"type"\s*:\s*"([a-z_]+_error)"[^{}]*"message"\s*:\s*"([^"]*)"/i)
      || candidate.match(/"message"\s*:\s*"([^"]*)"[^{}]*"type"\s*:\s*"([a-z_]+_error)"/i);
    if (m) {
      const [, a, b] = m;
      errorObj = /_error$/i.test(a) ? { type: a, message: b } : { type: b, message: a };
    }
  }

  const nonZeroExit = Number.isInteger(result.exitCode) && result.exitCode !== 0;
  if (!errorObj && !nonZeroExit) return null;

  const type = errorObj?.type || 'nonzero_exit';
  const message = errorObj?.message || `claude exited with code ${result.exitCode}`;
  const category = /model/i.test(`${type} ${message}`) ? 'model configuration problem' : 'provider error';
  const signature = `${type}:${message}`.slice(0, 200);
  return { type, message, category, signature };
}

/**
 * GRIPE-797: an expired provider login (claude "Failed to authenticate:
 * OAuth session expired and could not be refreshed", codex "not logged in"
 * or a 401) is NOT a generic provider error: the fix is a human running a
 * login command on this host. Returns {provider, command} or null.
 */
export function detectAuthExpiry(result) {
  if (!result || result.timedOut || result.error) return null;
  // Only a FAILED turn can be an expiry: a successful reply that merely
  // talks about logins or 401s is a reply, never an alert.
  if (!detectTurnError(result)) return null;
  const parts = [result.text, result.stdout, result.stderr];
  const raw = result.raw;
  if (raw && typeof raw === 'object') {
    parts.push(raw.result, raw.message, raw.error && (raw.error.message || raw.error));
  }
  const blob = parts.filter((x) => typeof x === 'string').join('\n');
  if (!blob) return null;
  if (/failed to authenticate|oauth session expired|could not be refreshed|invalid authentication credentials|please run \/login/i.test(blob)) {
    return { provider: 'claude', command: 'claude /login' };
  }
  if (/not logged in|codex login|401 unauthorized|\b401\b[^\n]{0,40}(unauthorized|authentication)|token (has )?expired/i.test(blob)) {
    const claudeish = /claude/i.test(blob) && !/codex/i.test(blob);
    return claudeish ? { provider: 'claude', command: 'claude /login' } : { provider: 'codex', command: 'codex login' };
  }
  return null;
}

export function buildAuthExpiryNoticeText(hostId, auth) {
  const cmd = auth && auth.provider === 'codex' ? 'codex login' : 'claude /login';
  const alt = auth && auth.provider === 'codex' ? '(or `claude /login`)' : '(or `codex login`)';
  return `My login on ${hostId} has expired; run \`${cmd}\` ${alt} on ${hostId}.`;
}

/**
 * One short, plain-language, single-sentence notice: no stack, no JSON, no
 * raw provider payload. This is the ONE honest signal an operator gets per
 * distinct error signature per hour; silence forever is also wrong.
 */
export function buildErrorNoticeText(category) {
  return `I cannot answer right now because of a ${category}; a human should check this host's configuration.`;
}

// Turn execution.

/**
 * Parse the output of `claude -p ... --output-format json`. Falls back to
 * treating raw stdout as the reply text when it is not valid JSON.
 */
export function parseTurnOutput(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return { text: '', session_id: null, total_cost_usd: null, raw: null };
  try {
    const json = JSON.parse(trimmed);
    const text = typeof json.result === 'string' ? json.result
      : typeof json.response === 'string' ? json.response
      : typeof json.text === 'string' ? json.text
      : '';
    return {
      text,
      session_id: json.session_id || null,
      total_cost_usd: typeof json.total_cost_usd === 'number' ? json.total_cost_usd : null,
      raw: json,
    };
  } catch {
    return { text: trimmed, session_id: null, total_cost_usd: null, raw: null };
  }
}

/**
 * Run ONE bounded headless turn via `claude -p <prompt> --output-format
 * json`, killed at timeoutSeconds. spawnFn is injected (defaults to
 * node:child_process spawn in the command layer) so tests never execute a
 * real claude process.
 *
 * NEVER sets ANTHROPIC_API_KEY or reads it: the spawned process inherits
 * whatever the deploying user has already configured for the claude CLI
 * (subscription/OAuth by default).
 */
export function runClaudeTurn({ spawnFn, prompt, timeoutSeconds = DEFAULT_SETTINGS.turn_timeout_seconds }) {
  return new Promise((resolve) => {
    let child;
    try {
      // QUOX_SUPERVISOR_TURN marks this claude process as a headless
      // supervisor turn, so user-level SessionStart hooks can stay silent
      // (2026-08-23 incident: a wake hook on .131 fired on every turn and
      // posted its "awake" announcement per inbound message all morning).
      child = spawnFn('claude', ['-p', prompt, '--output-format', 'json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, QUOX_SUPERVISOR_TURN: '1' },
      });
    } catch (err) {
      resolve({ timedOut: false, error: err, text: '', session_id: null, total_cost_usd: null, raw: null });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone, nothing to clean up */ }
      resolve({ timedOut: true, stdout, stderr, text: '', session_id: null, total_cost_usd: null, raw: null });
    }, Math.max(1, timeoutSeconds) * 1000);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, error: err, stdout, stderr, text: '', session_id: null, total_cost_usd: null, raw: null });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, exitCode: code, stdout, stderr, ...parseTurnOutput(stdout) });
    });
  });
}

// State.

export function createInitialState() {
  return {
    bootstrapped: false,
    seen_ids: [],
    turn_timestamps: [],
    decisions: [],
    recent_exchanges: [],
    host_id: null,
    slot: null,
    updated_at: null,
    // last_enabled_state (defect 1 fix): null until the first pass ever
    // observes the switch. Recognises a disabled -> enabled transition
    // across process restarts (persisted, so a --service unit stopped or
    // rebooted while disabled still reseeds on its very next enabled pass,
    // rather than replaying the whole backlog it was away for).
    last_enabled_state: null,
    // last_turn_error / error_notices (defect 2 fix): the most recent
    // error-shaped turn (for `status` to surface "last turn failed: ..."),
    // and the per-signature once-per-hour notice dedup list.
    last_turn_error: null,
    error_notices: [],
    // held_by_other_notices (QUOXPERTICUS-REVISIT P2, HOLD-IS-THE-VOICE
    // gate): same per-signature once-per-hour dedup shape as error_notices
    // above, keyed on the foreign holder's session id, so a supervisor
    // sitting silent while another session holds its slot posts one
    // witnessed receipt per holder-change or per hour, never one per poll.
    held_by_other_notices: [],
  };
}

/** Apply every bounding rule at once. Call before persisting state. */
export function boundState(state, { maxSeenIds = 500, maxDecisions = 20, maxExchanges = 10 } = {}) {
  return {
    ...state,
    seen_ids: boundSeenIds(state.seen_ids, maxSeenIds),
    decisions: boundDecisions(state.decisions, maxDecisions),
    recent_exchanges: boundExchanges(state.recent_exchanges, maxExchanges),
  };
}

function truncate(text, max = 120) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Run one full poll pass: fetch settings (kill-switch check), fetch
 * messages, pick new owner turns, spawn one bounded headless turn per
 * message (sequential, never concurrent), post replies, and update state.
 *
 * Every I/O dependency is injected so this can run under vitest with no
 * real network, no real collector, and no real claude process:
 *   fetchSettings()        -> raw settings object (per the contract)
 *   fetchMessages()        -> array of slot messages
 *   postReply(text)        -> posts the reply via slot say
 *   spawnTurn(prompt, s)   -> runs one headless turn, returns runClaudeTurn's shape
 *   log(level, message)    -> logger (startup/inbound/replies/skips/rate-limit/shutdown)
 */
export async function runPollOnce({
  hostId,
  slot,
  selfIdentity,
  fromFilters = [],
  fetchSettings,
  fetchMessages,
  postReply,
  spawnTurn,
  checkoutSlot = null,
  claimState = null,
  postHeartbeat = null,
  postTurnReceipt = null,
  alertOwner = null,
  state,
  log = () => {},
  now = () => Date.now(),
  historyWindow = 10,
  maxDecisions = 20,
  maxSeenIds = 500,
  maxAgeMinutes = DEFAULT_MAX_MESSAGE_AGE_MINUTES,
}) {
  // PRESENCE FIX (item 2, live outage 2026-08-23): attempted on every poll
  // pass, enabled or disabled, so a free slot is claimed the moment it is
  // seen free rather than staying present-but-never-holding. See
  // attemptSlotClaim above for the full rationale; this never throws.
  const claimResult = await attemptSlotClaim({ checkoutSlot, selfIdentity, slot, log, claimState, postHeartbeat });

  // QP-DASH P1: every ATTEMPTED turn posts a receipt (outcome + cost +
  // duration) so spend is legible server-side; the 2026-08-23 backlog churn
  // (~$6) was invisible without this. Strictly fail-soft: a receipts outage
  // must never break answering.
  const receipt = async (fields) => {
    if (!postTurnReceipt) return;
    try {
      await postTurnReceipt(fields);
    } catch (err) {
      log('warn', `turn receipt failed (never blocks the turn): ${err.message}`);
    }
  };
  const rawSettings = await fetchSettings();
  const settings = resolveSettings(rawSettings);

  if (!settings.enabled) {
    // This IS the kill switch. Honour it promptly: no messages are fetched,
    // no turn is spawned, and the caller (the CLI's `run` loop) is told to
    // stop rather than sleep-and-retry. Record last_enabled_state:false so
    // the NEXT enabled pass (even after a process restart while disabled;
    // this is persisted state, not in-memory) recognises itself as a
    // disabled -> enabled transition and reseeds instead of replaying the
    // backlog it was away for (defect 1).
    log('info', `kill switch: supervisor disabled for ${hostId} (enabled=false). Exiting cleanly.`);
    return { state: { ...state, last_enabled_state: false }, settings, stopped: true, turnsRun: 0 };
  }

  // HOLD-IS-THE-VOICE gate (QUOXPERTICUS-REVISIT P2): the supervisor must be
  // structurally SILENT while any OTHER session holds its slot; it answers
  // only while it holds the slot itself (claimed just now, or already_held
  // from a prior pass). attemptSlotClaim above already never seizes a
  // foreign hold; this is what makes that refusal ALSO mean "never fetch,
  // never spawn, never reply", not just "never checkout". Placed after the
  // kill-switch check above (so a disabled pass still returns there,
  // unchanged) and strictly before fetchMessages: no message is ever read
  // while another session holds the slot, so nothing can be answered by
  // accident. Deduped per foreign holder, once per hour (reuses the
  // error-notice dedup shape), so a poll every 30s does not spam a receipt
  // every pass while the same other session sits on the slot for hours.
  if (!claimResult.claimed && claimResult.reason === 'held_by_other') {
    const holder = claimResult.holder || 'unknown';
    const notice = shouldPostErrorNotice(state.held_by_other_notices || [], holder, now());
    const heldState = { ...state, held_by_other_notices: notice.notices };
    if (notice.shouldPost) {
      log('info', `slot ${slot}: held by ${holder}, staying silent (no messages fetched, no turns run) until this resident holds it.`);
      await receipt({ outcome: 'silent_held_by_other', held_by: holder });
    }
    return { state: heldState, settings, stopped: false, turnsRun: 0 };
  }

  // Defect 1 fix, part (a): a pass that finds itself going disabled ->
  // enabled must reseed exactly like a first run (seed the seen-set from
  // whatever is currently visible, answer none of it), never treat the
  // whole backlog as fresh. wasDisabled is read from state BEFORE any
  // mutation below, and survives a process restart because it was
  // persisted on the disabled pass above.
  const firstRun = state.bootstrapped !== true;
  const wasDisabled = state.last_enabled_state === false;
  const reenableReseed = !firstRun && wasDisabled;
  const seedPass = firstRun || reenableReseed;

  const messages = await fetchMessages();
  const picked = pickNewMessages({
    messages,
    seenIds: state.seen_ids,
    selfIdentity,
    fromFilters,
    firstRun: seedPass,
  });

  let nextState = { ...state, seen_ids: boundSeenIds(picked.seenIds, maxSeenIds) };

  if (firstRun) {
    nextState = { ...nextState, bootstrapped: true };
    log('info', `first run: seeded seen-set with ${picked.allSeen.length} existing message id(s), answering none.`);
  } else if (reenableReseed) {
    log('info', `re-enabled after being disabled: seeded seen-set with ${picked.allSeen.length} message id(s) visible right now, answering none (stale-backlog churn guard, defect fixed 2026-08-23).`);
  }

  let turnsRun = 0;
  let staleSkipped = 0;
  for (const message of picked.toAnswer) {
    // Defect 1 fix, part (b): the absolute max-age guard. Belt to (a)'s
    // braces, independent of how the message became eligible: a message
    // older than maxAgeMinutes is marked seen (already folded into
    // seen_ids above) and skipped, never answered, regardless of the
    // disabled/enabled transition logic.
    const ageMs = messageAgeMs(message, now());
    if (ageMs != null && ageMs > maxAgeMinutes * 60 * 1000) {
      staleSkipped += 1;
      log('warn', `message ${message.id} from ${message.from} skipped as stale (age ${Math.round(ageMs / 60000)}m, max ${maxAgeMinutes}m): marked seen, never answered.`);
      await receipt({ outcome: 'stale_skipped', message_id: message.id, message_from: message.from });
      continue;
    }

    let timestamps = pruneOldTurns(nextState.turn_timestamps, now());
    if (timestamps.length >= settings.max_turns_per_hour) {
      log('warn', `rate limit hit: ${settings.max_turns_per_hour} turn(s)/hour reached, skipping message ${message.id} without spawning.`);
      nextState = { ...nextState, turn_timestamps: timestamps };
      await receipt({ outcome: 'rate_limited', message_id: message.id, message_from: message.from });
      continue;
    }

    log('info', `inbound message ${message.id} from ${message.from}: ${truncate(message.text)}`);

    const prompt = buildTurnPrompt({ hostId, slot, message, history: nextState.recent_exchanges.slice(-historyWindow), state: nextState });
    const turnStartedMs = Date.now();
    const result = await spawnTurn(prompt, settings.turn_timeout_seconds);
    const durationMs = Date.now() - turnStartedMs;
    timestamps = [...timestamps, now()];
    nextState = { ...nextState, turn_timestamps: timestamps };
    turnsRun += 1;

    if (result.timedOut) {
      log('warn', `turn timed out after ${settings.turn_timeout_seconds}s for message ${message.id}; skipping reply (never posted).`);
      await receipt({ outcome: 'timeout', message_id: message.id, message_from: message.from, duration_ms: durationMs });
      continue;
    }
    if (result.error) {
      log('warn', `turn failed to spawn for message ${message.id}: ${result.error.message}; skipping reply.`);
      await receipt({ outcome: 'error', message_id: message.id, message_from: message.from, duration_ms: durationMs, error_note: `spawn: ${result.error.message}` });
      continue;
    }

    // Defect 2 fix: never post an error-shaped turn as if it were the
    // resident's own reply. Log the full error, record it in state for
    // `status` to surface, and post at most one short plain-language
    // notice per distinct error signature per hour.
    const authExpiry = detectAuthExpiry(result);
    if (authExpiry) {
      log('error', `turn auth expiry for message ${message.id}: provider=${authExpiry.provider} (login expired; never posted raw)`);
      await receipt({ outcome: 'error', message_id: message.id, message_from: message.from, duration_ms: durationMs, error_note: `auth_expired: ${authExpiry.provider}` });
      const noticeText = buildAuthExpiryNoticeText(hostId, authExpiry);
      nextState = {
        ...nextState,
        last_turn_error: { type: 'auth_expired', message: noticeText, category: 'auth expiry', signature: `auth_expired:${authExpiry.provider}`, at: new Date(now()).toISOString() },
      };
      // ONE slot reply + ONE owner alert per expiry episode; the flag is
      // cleared only by a successful reply below.
      if (!nextState.auth_expiry_alerted_at) {
        await postReply(noticeText);
        if (alertOwner) {
          try { await alertOwner(noticeText); } catch (err) { log('warn', `auth-expiry owner alert failed: ${err.message}`); }
        }
        nextState = { ...nextState, auth_expiry_alerted_at: new Date(now()).toISOString() };
        log('warn', `posted auth-expiry notice and owner alert (once per episode): ${noticeText}`);
      } else {
        log('warn', 'auth-expiry notice suppressed (already alerted this episode; clears on next successful turn).');
      }
      continue;
    }
    const turnError = detectTurnError(result);
    if (turnError) {
      log('error', `turn error for message ${message.id}: type=${turnError.type} message=${turnError.message} (never posted to the channel)`);
      await receipt({ outcome: 'error', message_id: message.id, message_from: message.from, duration_ms: durationMs, error_note: `${turnError.type}: ${turnError.message}`, cost_usd: result.total_cost_usd ?? undefined, session_id: result.session_id || undefined });
      nextState = {
        ...nextState,
        last_turn_error: { type: turnError.type, message: turnError.message, category: turnError.category, signature: turnError.signature, at: new Date(now()).toISOString() },
      };
      const notice = shouldPostErrorNotice(nextState.error_notices, turnError.signature, now());
      nextState = { ...nextState, error_notices: notice.notices };
      if (notice.shouldPost) {
        const noticeText = buildErrorNoticeText(turnError.category);
        await postReply(noticeText);
        log('warn', `posted one-per-hour error notice for signature "${turnError.signature}": ${noticeText}`);
      } else {
        log('warn', `error notice suppressed for signature "${turnError.signature}" (already notified within the last hour).`);
      }
      continue;
    }

    const replyText = (result.text || '').trim();
    if (!replyText) {
      log('warn', `empty reply for message ${message.id}; skipping (never posted).`);
      await receipt({ outcome: 'error', message_id: message.id, message_from: message.from, duration_ms: durationMs, error_note: 'empty reply', cost_usd: result.total_cost_usd ?? undefined, session_id: result.session_id || undefined });
      continue;
    }

    if (nextState.auth_expiry_alerted_at) {
      const { auth_expiry_alerted_at: _cleared, ...rest } = nextState;
      nextState = rest;
      log('info', 'auth recovered: successful turn, auth-expiry alert re-armed.');
    }
    await postReply(replyText);
    log('info', `replied to ${message.id} (${replyText.length} chars, session_id=${result.session_id || 'n/a'}, cost_usd=${result.total_cost_usd ?? 'n/a'})`);
    await receipt({
      outcome: 'replied', message_id: message.id, message_from: message.from,
      reply_chars: replyText.length, cost_usd: result.total_cost_usd ?? undefined,
      duration_ms: durationMs, session_id: result.session_id || undefined,
    });

    const decisions = boundDecisions([
      ...nextState.decisions,
      {
        at: new Date(now()).toISOString(),
        message_id: message.id,
        from: message.from,
        reply_excerpt: truncate(replyText, 200),
        session_id: result.session_id || null,
        cost_usd: result.total_cost_usd ?? null,
      },
    ], maxDecisions);

    const recentExchanges = boundExchanges([
      ...nextState.recent_exchanges,
      { from: message.from, text: message.text, reply: replyText },
    ], historyWindow);

    nextState = { ...nextState, decisions, recent_exchanges: recentExchanges };
  }

  if (staleSkipped > 0) {
    log('warn', `stale-skip summary: ${staleSkipped} message(s) skipped as too old to answer (max age ${maxAgeMinutes}m), never answered.`);
    // OWNER-FACING HONESTY (2026-08-24 incident): silence here ATE five real
    // owner messages, including two direct work orders, after a downtime.
    // The churn guard protecting spend must never read as the resident
    // ignoring its owner: post ONE plain line saying what was dropped and
    // that a human/session needs to pick it up. One line per pass, never per
    // message, so the spend cost of honesty is a single say.
    try {
      await postReply(
        `I was unable to answer ${staleSkipped} message(s) in time (older than my ${maxAgeMinutes}m auto-answer window). `
        + 'They are marked seen, not actioned: please re-send anything still needed, or a full session should pick them up.'
      );
    } catch (err) {
      log('warn', `stale-skip notice failed to post: ${err.message}`);
    }
  }

  nextState = { ...nextState, host_id: hostId, slot, updated_at: new Date(now()).toISOString(), last_enabled_state: true };
  return { state: nextState, settings, stopped: false, turnsRun };
}
