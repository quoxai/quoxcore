'use strict';

/**
 * Calendar-Q agenda + coverage + changes (L2-C1 U3).
 *
 * getAgenda is the ONLY read path a consumer (API route, agent tool, CLI)
 * should use to answer "what does this connection's calendar look like" —
 * it NEVER constructs an empty agenda from a failed refresh: when the most
 * recent sync attempt failed, the previously-published generation keeps
 * serving, honestly labelled 'stale' in its coverage rather than silently
 * disappearing.
 *
 * getChanges is an evidenced diff between two published generations of the
 * SAME connection, keyed by occurrenceKey (the stable identity across a
 * reschedule) and content hash (source_version / normalized payload).
 */

const store = require('./store');
const { computeWindow } = require('./syncWorker');
const { validateCalendarAgendaV1 } = require('./contracts');

function resolveTickMs() {
  const n = Number(process.env.CALENDARQ_SYNC_TICK_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}

function stripHash(payload) {
  if (!payload) return payload;
  const { _hash, ...rest } = payload;
  return rest;
}

/**
 * @param {string} orgId
 * @param {object} opts { connectionId, layerIds, nowMs }
 * @returns {object} a validated CalendarAgendaV1 payload
 * @throws Error('calendarq_connection_not_found') if connectionId does not
 *   resolve in this org — every other state (never synced, disconnected,
 *   stale, partial, empty) is reported IN the payload, never thrown.
 */
function getAgenda(orgId, { connectionId, layerIds = null, nowMs = Date.now() } = {}) {
  if (!orgId) throw new Error('getAgenda requires orgId');
  if (!connectionId) throw new Error('getAgenda requires connectionId');
  const connection = store.getConnection(orgId, connectionId);
  if (!connection) throw new Error('calendarq_connection_not_found');

  const timezone = connection.timezone || 'UTC';
  const published = store.readPublishedOccurrences(orgId, connectionId);
  const fallbackWindow = computeWindow(nowMs, timezone);

  let occurrenceRows = [];
  let generationId = 'unavailable';
  let windowStart = fallbackWindow.windowStart;
  let windowEndExclusive = fallbackWindow.windowEndExclusive;
  let complete = false;
  let watermarkTs = 0;
  let omissions = [];
  let state;

  if (!published) {
    state = connection.status === 'needs_reconnect' ? 'disconnected' : 'unavailable';
  } else {
    const gen = published.generation;
    generationId = gen.id;
    windowStart = gen.windowStart;
    windowEndExclusive = gen.windowEndExclusive;
    complete = gen.complete;
    watermarkTs = gen.watermarkTs || 0;
    omissions = (gen.stats && gen.stats.omissions) || [];
    occurrenceRows = published.occurrences;

    const latestAny = store.getLatestGenerationForConnection(orgId, connectionId);
    const newerAttemptFailed = Boolean(latestAny && latestAny.id !== gen.id && latestAny.state === 'failed');
    const watermarkTooOld = (nowMs - watermarkTs) > (2 * resolveTickMs());

    if (connection.status === 'needs_reconnect') state = 'disconnected';
    else if (omissions.length > 0) state = 'partial';
    else if (newerAttemptFailed || watermarkTooOld) state = 'stale';
    else if (occurrenceRows.length === 0) state = 'empty';
    else state = 'complete';
  }

  // Cancelled instances never show up on the agenda itself (they are still
  // fully visible via getChanges, as a status_changed entry) — a human
  // reading "what's on my calendar" should never see a cancelled meeting.
  const occurrences = occurrenceRows
    .map((row) => stripHash(row.payload))
    .filter((occ) => occ && occ.status !== 'cancelled')
    .filter((occ) => !Array.isArray(layerIds) || layerIds.length === 0 || layerIds.includes(occ.layerId));

  const coverage = {
    v: '1',
    orgId,
    connectionId,
    resourceId: connection.resourceId,
    windowStartLocalDate: windowStart,
    windowEndLocalDateExclusive: windowEndExclusive,
    timezone,
    generationId,
    complete: Boolean(complete),
    watermarkTs,
    freshnessTs: nowMs,
    omissions,
    state,
  };

  const agenda = { v: '1', orgId, coverage, occurrences };
  const validated = validateCalendarAgendaV1(agenda);
  if (!validated.ok) {
    throw new Error(`getAgenda produced an invalid CalendarAgendaV1: ${validated.errors.join('; ')}`);
  }
  return agenda;
}

/** Convenience wrapper: the coverage half of getAgenda, for callers that
 * only need the freshness/state summary (e.g. a status widget). */
function getCoverage(orgId, opts) {
  return getAgenda(orgId, opts).coverage;
}

/**
 * Evidenced diff between the generation named `sinceGenerationId` and the
 * CURRENT latest published generation of the same connection.
 *
 * @param {string} orgId
 * @param {object} opts { sinceGenerationId }
 * @returns {{orgId, connectionId, sinceGenerationId, currentGenerationId, changes: Array}}
 */
function getChanges(orgId, { sinceGenerationId } = {}) {
  if (!orgId) throw new Error('getChanges requires orgId');
  if (!sinceGenerationId) throw new Error('getChanges requires sinceGenerationId');

  const sinceGen = store.getGeneration(orgId, sinceGenerationId);
  if (!sinceGen) throw new Error('getChanges: sinceGenerationId not found');
  const connectionId = sinceGen.connectionId;

  const current = store.readPublishedOccurrences(orgId, connectionId);
  if (!current || current.generation.id === sinceGenerationId) {
    return { orgId, connectionId, sinceGenerationId, currentGenerationId: current ? current.generation.id : null, changes: [] };
  }

  const sinceOccs = store.listOccurrences(orgId, sinceGenerationId);
  const sinceByKey = new Map(sinceOccs.map((o) => [o.occurrenceKey, o]));
  const currentByKey = new Map(current.occurrences.map((o) => [o.occurrenceKey, o]));

  const changes = [];

  for (const [key, curOcc] of currentByKey) {
    const priorOcc = sinceByKey.get(key);
    if (!priorOcc) {
      changes.push({ occurrenceKey: key, kind: 'added', occurrence: stripHash(curOcc.payload) });
      continue;
    }
    const priorPayload = priorOcc.payload || {};
    const curPayload = curOcc.payload || {};
    if (priorPayload.status !== curPayload.status) {
      changes.push({
        occurrenceKey: key, kind: 'status_changed',
        from: priorPayload.status, to: curPayload.status,
        occurrence: stripHash(curPayload),
      });
      continue;
    }
    if (priorPayload.startTs !== curPayload.startTs || priorPayload.endTs !== curPayload.endTs) {
      changes.push({
        occurrenceKey: key, kind: 'time_changed',
        fromStartTs: priorPayload.startTs, toStartTs: curPayload.startTs,
        fromEndTs: priorPayload.endTs, toEndTs: curPayload.endTs,
        occurrence: stripHash(curPayload),
      });
    }
  }

  for (const [key, priorOcc] of sinceByKey) {
    if (currentByKey.has(key)) continue;
    // Absence alone is NEVER read as 'cancelled' — only an explicit status
    // field says that (handled above, while the key was still present).
    // A key missing entirely from the newer generation is reported as
    // 'no_longer_visible': it could be deleted, moved outside the window,
    // or something this sync pass simply could not see — never assumed.
    changes.push({ occurrenceKey: key, kind: 'removed', reason: 'no_longer_visible', occurrence: stripHash(priorOcc.payload) });
  }

  return { orgId, connectionId, sinceGenerationId, currentGenerationId: current.generation.id, changes };
}

module.exports = { getAgenda, getCoverage, getChanges };
