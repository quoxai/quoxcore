'use strict';

/**
 * Calendar-Q sync worker (L2-C1) — fetches one connection's agenda window
 * from its provider, normalizes every event, and stages+publishes a
 * generation via the L2-C0 store.
 *
 * MANDATORY loop triad (repo CLAUDE.md, 2026-08-30 CPU incident sweep —
 * same shape as lib/inboxq/syncWorker.js):
 *   1. Failure accounting DISTINCT from empty results. A sync that throws
 *      (credential resolve, token refresh, provider fetch) increments the
 *      connection's failure streak in calendarq_sync_state. A sync that
 *      succeeds with zero changed occurrences is NOT a failure — it clears
 *      the streak and only updates last_empty_at.
 *   2. Capped exponential backoff with jitter on failure; a throttled
 *      (HTTP 429) response honours the provider's own Retry-After instead
 *      of the generic backoff ladder.
 *   3. Durable retirement after RETIRE_AFTER consecutive failures, skipped
 *      until a human resets it (store.resetSyncState).
 *
 * Eligibility (retired / inside a backoff window) is checked BEFORE the
 * credential is ever decrypted — a fully-retired or backed-off connection
 * must never keep hitting the vault.
 *
 * Zero LLM/model calls: this module has no llm/classify dependency of any
 * kind. Every string it produces (spokenForm) is a deterministic template
 * built in providers/google.js.
 */

const crypto = require('crypto');
const store = require('./store');
const { resolveGoogleCredential, getAccessToken, listEventsWindow, normalizeEvent } = require('./providers/google');

const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240];
const RETIRE_AFTER = 8;

function computeBackoffMinutes(streak) {
  const idx = Math.min(Math.max(streak, 1) - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[idx];
}

// Date.now-seeded pseudo-random, deterministic under a fixed injected clock
// (same trick as lib/inboxq/syncWorker.js) — +/- up to 20% jitter so a fleet
// of connections does not thundering-herd on the same backoff tick.
function deterministicRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function withJitterIso(baseMinutes, nowMs) {
  const jitter = 1 + ((deterministicRandom(nowMs) - 0.5) * 0.4);
  return new Date(nowMs + baseMinutes * 60 * 1000 * jitter).toISOString();
}

function recordSyncFailure({ orgId, connectionId, errorCode, nowMs, retryAfterMs = null }) {
  const current = store.getSyncState(orgId, connectionId) || { failureStreak: 0 };
  const streak = (current.failureStreak || 0) + 1;
  const retired = streak >= RETIRE_AFTER;
  const nextAttemptAt = (errorCode === 'throttled' && retryAfterMs)
    ? new Date(nowMs + retryAfterMs).toISOString()
    : withJitterIso(computeBackoffMinutes(streak), nowMs);
  store.upsertSyncState(orgId, connectionId, {
    failureStreak: streak,
    backoffStage: Math.min(streak, BACKOFF_MINUTES.length),
    nextAttemptAt,
    retired,
    lastError: errorCode,
  });
  return { connectionId, failed: true, error: errorCode, retired, nextAttemptAt };
}

// --- timezone-safe window arithmetic ----------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' of `nowMs` as read on a wall clock in `tz`. */
function todayInTz(nowMs, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).formatToParts(new Date(nowMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/** Pure calendar-date arithmetic on a 'YYYY-MM-DD' string — never touches a
 * wall clock or a timezone, so it cannot skip or duplicate a date across a
 * DST transition the way ms-based day math can. */
function addDays(dateOnly, days) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** The IANA offset (ms) such that localClockMs = utcMs + offset, at the
 * instant `utcMs`, in `tz`. */
function tzOffsetMsAt(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some locales render midnight as 24:00
  const localAsUtcMs = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return localAsUtcMs - utcMs;
}

/**
 * The UTC instant at which the wall clock in `tz` reads local midnight on
 * `dateOnly`. Fixed-point iteration over tzOffsetMsAt — converges in 2-3
 * steps for any real IANA zone, including on a DST-transition day, because
 * an offset change (at most ~1-2h) is small relative to how precisely this
 * needs to land (we only need the right INSTANT, not sub-second accuracy).
 */
function localDateStartToUtcIso(dateOnly, tz) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const localWant = Date.UTC(y, m - 1, d, 0, 0, 0);
  let utcMs = localWant;
  for (let i = 0; i < 3; i++) {
    utcMs = localWant - tzOffsetMsAt(utcMs, tz);
  }
  return new Date(utcMs).toISOString();
}

/** Compute the connection's agenda window: 7 local days back to 30 local
 * days forward (exclusive), in the connection's own timezone. */
function computeWindow(nowMs, tz) {
  const today = todayInTz(nowMs, tz);
  const windowStart = addDays(today, -7);
  const windowEndExclusive = addDays(today, 30);
  return {
    windowStart,
    windowEndExclusive,
    timeMinIso: localDateStartToUtcIso(windowStart, tz),
    timeMaxIso: localDateStartToUtcIso(windowEndExclusive, tz),
  };
}

// --- content hashing (for stats.unchanged / future model-work gating) ------

function contentHash(occurrence) {
  // Hash the full normalized shape minus occurrenceKey (the stable identity,
  // not content) — any field change (time move, title edit, status flip)
  // changes the hash, which is exactly "did this occurrence change".
  const { occurrenceKey, ...rest } = occurrence;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

// --- the sync pass -----------------------------------------------------------

// AQ-9B audit fix 5: both the scheduler tick and api.js's hSync route call
// runSync directly, so a slow upstream fetch left a window where a second
// concurrent call for the SAME (orgId, connectionId) re-did credential
// decrypt, eligibility, and generation writes in parallel with the first.
// Keyed in-process, released in a finally so a throw can never leak a stuck
// lock — the lock test is "did a second call in this SAME process overlap
// the first", nothing durable or cross-process.
const _inFlightSyncs = new Set();

/**
 * Run one sync pass for a single connection: resolve credential, fetch the
 * agenda window, normalize every event into a staged generation, and
 * publish it. Pure orchestration over injectable deps (fetchImpl, nowMs) so
 * it runs on fixtures in tests with NO live network call.
 *
 * A second call for the SAME (orgId, connectionId) arriving while the first
 * is still in flight returns {skipped:'in_flight'} immediately, before
 * touching eligibility, credential decrypt, or generations (audit fix 5).
 *
 * @returns {Promise<object>} either a skip ({skipped}), a failure
 *   ({failed:true, error}), or a success ({complete:true, stats}).
 */
async function runSync(orgId, connectionId, opts = {}) {
  const lockKey = `${orgId}:${connectionId}`;
  if (_inFlightSyncs.has(lockKey)) {
    return { connectionId, skipped: 'in_flight' };
  }
  _inFlightSyncs.add(lockKey);
  try {
    return await runSyncLocked(orgId, connectionId, opts);
  } finally {
    _inFlightSyncs.delete(lockKey);
  }
}

async function runSyncLocked(orgId, connectionId, { fetchImpl = fetch, nowMs = Date.now(), agentId = null } = {}) {
  const connection = store.getConnection(orgId, connectionId);
  if (!connection) throw new Error('calendarq_connection_not_found');

  // Eligibility BEFORE credential decrypt — a retired or backed-off
  // connection never touches the vault.
  const syncState = store.getSyncState(orgId, connectionId) || {};
  if (syncState.retired) return { connectionId, skipped: 'retired' };
  if (syncState.nextAttemptAt && new Date(syncState.nextAttemptAt).getTime() > nowMs) {
    return { connectionId, skipped: 'backoff', nextAttemptAt: syncState.nextAttemptAt };
  }

  let cred;
  try {
    cred = await resolveGoogleCredential(orgId, connection.credentialRef, { agentId, fetchImpl });
  } catch (e) {
    return recordSyncFailure({ orgId, connectionId, errorCode: e.code || 'credential_resolve_failed', nowMs });
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(cred, { fetchImpl, nowMs });
  } catch (e) {
    if (e.code === 'reauth_required') {
      // Human action required — surface it on the connection itself, never
      // silently retried forever hoping the same refresh token starts working.
      try { store.setConnectionStatus(orgId, connectionId, 'needs_reconnect'); } catch { /* non-fatal */ }
    }
    return recordSyncFailure({ orgId, connectionId, errorCode: e.code || 'token_refresh_failed', nowMs });
  }
  // A working token proves the connection is reconnected; clear a stale flag.
  if (connection.status === 'needs_reconnect') {
    try { store.setConnectionStatus(orgId, connectionId, 'active'); } catch { /* non-fatal */ }
  }

  const tz = connection.timezone || 'UTC';
  const { windowStart, windowEndExclusive, timeMinIso, timeMaxIso } = computeWindow(nowMs, tz);
  const generation = store.createGeneration({ orgId, connectionId, windowStart, windowEndExclusive, timezone: tz });

  let rawEvents;
  try {
    rawEvents = await listEventsWindow({ accessToken, calendarId: connection.resourceId, timeMinIso, timeMaxIso, fetchImpl });
  } catch (e) {
    // A partial page set must never be published as if it were complete.
    try { store.markGenerationFailed(orgId, generation.id, { reason: e.code || 'fetch_failed' }); } catch { /* non-fatal */ }
    return recordSyncFailure({ orgId, connectionId, errorCode: e.code || 'fetch_failed', nowMs, retryAfterMs: e.retryAfterMs });
  }

  // One provider layer per connection, upserted idempotently every pass.
  const layerId = `provider:${connection.id}`;
  store.upsertLayer({
    orgId, layerId, kind: 'provider', sourceRef: connection.id,
    displayName: connection.resourceLabel || connection.accountLabel || connection.resourceId,
    color: '#4285F4',
  });

  const previous = store.readPublishedOccurrences(orgId, connectionId);
  const previousHashByKey = new Map();
  if (previous) {
    for (const occ of previous.occurrences) {
      if (occ.payload && occ.payload._hash) previousHashByKey.set(occ.occurrenceKey, occ.payload._hash);
    }
  }

  const omissions = [];
  let inserted = 0;
  let unchanged = 0;
  let changed = 0;

  for (const raw of rawEvents) {
    const norm = normalizeEvent(raw, { connectionTz: tz });
    if (!norm.ok) {
      omissions.push(norm.omission);
      continue;
    }
    // L2-C4: an attendee-list truncation is a note alongside the (still
    // included) occurrence, never a reason to drop the event.
    if (norm.attendeesOmission) omissions.push(norm.attendeesOmission);
    const occurrence = { ...norm.occurrence, layerId };
    const hash = contentHash(occurrence);
    if (previousHashByKey.get(occurrence.occurrenceKey) === hash) unchanged += 1; else changed += 1;
    store.insertOccurrence({
      orgId,
      generationId: generation.id,
      occurrenceKey: occurrence.occurrenceKey,
      seriesId: occurrence.seriesId,
      providerEventId: occurrence.providerEventId,
      sourceVersion: occurrence.sourceVersion,
      payload: { ...occurrence, _hash: hash },
    });
    inserted += 1;
  }

  // By construction every raw event above either inserted or was recorded as
  // a whole-event omission (an event can ALSO carry its own attendees
  // omission note alongside being inserted, e.g. a truncated attendee
  // list) — reaching here means the whole window landed and every event is
  // accounted for, so this generation is genuinely complete. omissions.length
  // (and so coverage.state degrading to 'partial') counts both kinds: a
  // truncated attendee list is a real, honest gap in what was captured.
  const stats = { total: rawEvents.length, inserted, omitted: omissions.length, unchanged, changed, omissions };
  store.markGenerationComplete(orgId, generation.id, { watermarkTs: nowMs, stats });
  store.publishGeneration(orgId, generation.id);

  const nowIso = new Date(nowMs).toISOString();
  store.upsertSyncState(orgId, connectionId, {
    failureStreak: 0,
    backoffStage: 0,
    nextAttemptAt: null,
    retired: false,
    lastError: null,
    lastEmptyAt: changed === 0 ? nowIso : (syncState.lastEmptyAt || null),
    lastChangeAt: changed > 0 ? nowIso : (syncState.lastChangeAt || null),
  });

  return { connectionId, generationId: generation.id, complete: true, stats };
}

module.exports = {
  runSync,
  computeWindow,
  computeBackoffMinutes,
  localDateStartToUtcIso,
  addDays,
  todayInTz,
  contentHash,
  RETIRE_AFTER,
  BACKOFF_MINUTES,
  _deterministicRandom: deterministicRandom,
};
