'use strict';

/**
 * Calendar-Q layer adapters + merged overlay (L2-C1b U2).
 *
 * Four layer kinds, each fetched through its own adapter so one feed's
 * outage NEVER poisons the other layers (2026-08-30 CPU incident sweep —
 * failure accounting distinct from empty results, same discipline as
 * syncWorker.js, just scoped per-layer instead of per-connection):
 *   - provider        — already-normalized occurrences from the L2-C0 store
 *                        (store.readPublishedOccurrences).
 *   - internal_events — tasks service calendar_events, fetched WIDE (no
 *                        range params) and window-overlap filtered +
 *                        recurrence-expanded HERE, because the tasks API's
 *                        own range filter misses events that started before
 *                        the window but overlap it, and never expands
 *                        recurring rows itself. Compensating for an upstream
 *                        bug in the adapter, not patching the tasks service.
 *   - team_schedules   — tasks service GET /api/schedules, filtered to the
 *                        non-workflow rows, projected via cronProject.
 *   - workflow_cron    — quoxflow's own GET /api/schedules (live registered
 *                        Cron jobs, with nextRun/active), projected via
 *                        cronProject. A DIFFERENT endpoint from
 *                        team_schedules's (which also happens to embed
 *                        workflow rows derived from static workflow JSON —
 *                        using quoxflow's own live schedule list instead
 *                        avoids double-counting the same schedule twice).
 *
 * Zero LLM/model calls: every occurrence here is either passed through
 * unchanged from a provider generation, or built from a deterministic
 * template string.
 */

const store = require('./store');
const { getCoverage } = require('./agenda');
const { localDateStartToUtcIso } = require('./syncWorker');
const { expandCronOverWindow } = require('./cronProject');
const { buildInternalServiceHeaders } = require('../internalServiceHeaders');
const { sanitizeText } = require('./textSanitize');

const TASKS_URL = () => `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
const QUOXFLOW_URL = () => process.env.QUOXFLOW_URL || 'http://quoxflow:3200';

const DEFAULT_MAX_PROJECTED = 200;

function stripHash(payload) {
  if (!payload) return payload;
  const { _hash, ...rest } = payload;
  return rest;
}

function windowBoundsMs(windowStartLocalDate, windowEndLocalDateExclusive, timezone) {
  return {
    windowStartMs: new Date(localDateStartToUtcIso(windowStartLocalDate, timezone)).getTime(),
    windowEndMs: new Date(localDateStartToUtcIso(windowEndLocalDateExclusive, timezone)).getTime(),
  };
}

function overlaps(startMs, endMs, windowStartMs, windowEndMs) {
  return startMs < windowEndMs && endMs > windowStartMs;
}

/** A coverage object that satisfies CalendarCoverageV1's required fields for
 * a layer that has no real "generation" concept of its own (internal_events
 * / team_schedules / workflow_cron) — connectionId/resourceId are synthetic
 * (the layer's own id), generationId is a per-fetch token. */
function syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state, omissions = [] }) {
  return {
    v: '1',
    orgId,
    connectionId: layer.sourceRef || layer.layerId,
    resourceId: layer.sourceRef || layer.layerId,
    windowStartLocalDate,
    windowEndLocalDateExclusive,
    timezone,
    generationId: `layer-fetch:${layer.layerId}:${nowMs}`,
    complete: state === 'complete' || state === 'empty',
    watermarkTs: nowMs,
    freshnessTs: nowMs,
    omissions,
    state,
  };
}

// --- provider ----------------------------------------------------------------

function listProviderOccurrences(orgId, { layer, windowStartLocalDate, windowEndLocalDateExclusive, nowMs }) {
  const connectionId = layer.sourceRef;
  if (!connectionId) {
    return {
      occurrences: [],
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone: 'UTC', nowMs, state: 'unavailable', omissions: [{ kind: 'missing_source_ref', detail: 'provider layer has no connection id' }] }),
    };
  }
  try {
    const coverage = getCoverage(orgId, { connectionId, nowMs });
    const published = store.readPublishedOccurrences(orgId, connectionId);
    const occurrences = (published ? published.occurrences : []).map((row) => stripHash(row.payload));
    return { occurrences, coverage };
  } catch (e) {
    return {
      occurrences: [],
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone: 'UTC', nowMs, state: 'unavailable', omissions: [{ kind: 'provider_fetch_failed', detail: e.message }] }),
    };
  }
}

// --- internal_events -----------------------------------------------------------

async function fetchInternalEventsRaw(orgId, { userId, fetchImpl }) {
  const headers = buildInternalServiceHeaders({ 'X-Org-Id': orgId, 'X-User-Id': userId || 'service', 'Content-Type': 'application/json' });
  // Deliberately WIDE: no from/to params. The tasks service's own range
  // filter — (recurrence_cron IS NOT NULL OR start_at >= from) — drops a
  // non-recurring event that started before `from` but overlaps it, and it
  // never expands a recurring row into instances at all. Compensated below.
  const url = `${TASKS_URL()}/api/calendar/events`;
  const resp = await fetchImpl(url, { headers });
  if (!resp.ok) throw new Error(`tasks calendar/events ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.events) ? data.events : [];
}

function internalEventOccurrenceSpokenForm(title, startMs) {
  return `${title}, starting ${new Date(startMs).toISOString()}`;
}

function projectInternalEvent(row, layerId, { windowStartLocalDate, windowEndLocalDateExclusive, windowStartMs, windowEndMs, timezone }) {
  // Audit fix 2: row.title is user-supplied text from the tasks service —
  // strip control chars/ANSI before it reaches a projected occurrence.
  const title = sanitizeText(row.title || '');
  const tz = row.timezone || timezone;
  const startMs = Date.parse(row.start_at);
  const endMs = row.end_at ? Date.parse(row.end_at) : startMs + 60 * 60 * 1000;
  const allDay = Boolean(row.all_day);

  if (!row.recurrence_cron) {
    if (!overlaps(startMs, endMs, windowStartMs, windowEndMs)) return { occurrences: [], omission: null };
    return {
      occurrences: [{
        occurrenceKey: `internal:${row.id}`,
        seriesId: null,
        layerId,
        title,
        startTs: startMs,
        endTs: endMs,
        allDay,
        timezone: tz,
        status: 'confirmed',
        busy: true,
        spokenForm: internalEventOccurrenceSpokenForm(title, startMs),
      }],
      omission: null,
    };
  }

  const durationMs = endMs - startMs;
  const expanded = expandCronOverWindow(row.recurrence_cron, tz, windowStartLocalDate, windowEndLocalDateExclusive, { maxOccurrences: DEFAULT_MAX_PROJECTED });
  if (expanded.unsupported) {
    return { occurrences: [], omission: { kind: 'unsupported_recurrence_cron', detail: `event ${row.id} has an unsupported recurrence_cron "${row.recurrence_cron}"` } };
  }
  const occurrences = expanded.occurrences.map((occ) => ({
    occurrenceKey: `internal:${row.id}:${occ.startTs}`,
    seriesId: row.id,
    layerId,
    title,
    startTs: occ.startTs,
    endTs: occ.startTs + durationMs,
    allDay,
    timezone: tz,
    status: 'confirmed',
    busy: true,
    spokenForm: internalEventOccurrenceSpokenForm(title, occ.startTs),
  }));
  return { occurrences, omission: null };
}

async function listInternalEventsOccurrences(orgId, { layer, userId, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs }) {
  const { windowStartMs, windowEndMs } = windowBoundsMs(windowStartLocalDate, windowEndLocalDateExclusive, timezone);
  try {
    const rows = await fetchInternalEventsRaw(orgId, { userId, fetchImpl });
    const occurrences = [];
    const omissions = [];
    for (const row of rows) {
      const { occurrences: occs, omission } = projectInternalEvent(row, layer.layerId, { windowStartLocalDate, windowEndLocalDateExclusive, windowStartMs, windowEndMs, timezone });
      occurrences.push(...occs);
      if (omission) omissions.push(omission);
    }
    const state = omissions.length > 0 ? 'partial' : (occurrences.length === 0 ? 'empty' : 'complete');
    return {
      occurrences,
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state, omissions }),
    };
  } catch (e) {
    return {
      occurrences: [],
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state: 'unavailable', omissions: [{ kind: 'fetch_failed', detail: e.message }] }),
    };
  }
}

// --- team_schedules --------------------------------------------------------

async function fetchTeamSchedulesRaw(orgId, { fetchImpl }) {
  const headers = buildInternalServiceHeaders({ 'X-Org-Id': orgId, 'X-User-Id': 'service', 'Content-Type': 'application/json' });
  const resp = await fetchImpl(`${TASKS_URL()}/api/schedules`, { headers });
  if (!resp.ok) throw new Error(`tasks schedules ${resp.status}`);
  const data = await resp.json();
  const rows = Array.isArray(data.schedules) ? data.schedules : [];
  // The tasks GET /api/schedules endpoint ALSO embeds quoxflow-derived
  // workflow rows (kind === 'workflow') alongside genuine team_schedules
  // rows. workflow_cron's own adapter below reads quoxflow directly (the
  // live registered Cron jobs), so team_schedules excludes those rows here
  // to avoid surfacing the same workflow schedule under two layer kinds.
  return rows.filter((r) => r.kind !== 'workflow');
}

function projectTeamSchedule(row, layerId, { windowStartLocalDate, windowEndLocalDateExclusive, timezone }) {
  if (!row.enabled || !row.cron_expression) return { occurrences: [], omission: null };
  const tz = row.timezone || timezone;
  const expanded = expandCronOverWindow(row.cron_expression, tz, windowStartLocalDate, windowEndLocalDateExclusive, { maxOccurrences: DEFAULT_MAX_PROJECTED });
  if (expanded.unsupported) {
    return { occurrences: [], omission: { kind: 'unsupported_cron', detail: `schedule ${row.id} has an unsupported cron_expression "${row.cron_expression}"` } };
  }
  // Audit fix 2: row.name is a user-supplied schedule name.
  const title = sanitizeText(row.name || row.id);
  const occurrences = expanded.occurrences.map((occ) => ({
    occurrenceKey: `sched:${row.id}:${occ.startTs}`,
    seriesId: row.id,
    layerId,
    title,
    startTs: occ.startTs,
    endTs: occ.startTs,
    allDay: false,
    timezone: tz,
    status: 'confirmed',
    busy: false,
    deepLink: '/triggers?tab=schedules',
    spokenForm: `${title}, scheduled ${new Date(occ.startTs).toISOString()}`,
  }));
  return { occurrences, omission: null };
}

async function listTeamSchedulesOccurrences(orgId, { layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs }) {
  try {
    const rows = await fetchTeamSchedulesRaw(orgId, { fetchImpl });
    const occurrences = [];
    const omissions = [];
    for (const row of rows) {
      const { occurrences: occs, omission } = projectTeamSchedule(row, layer.layerId, { windowStartLocalDate, windowEndLocalDateExclusive, timezone });
      occurrences.push(...occs);
      if (omission) omissions.push(omission);
    }
    const state = omissions.length > 0 ? 'partial' : (occurrences.length === 0 ? 'empty' : 'complete');
    return {
      occurrences,
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state, omissions }),
    };
  } catch (e) {
    return {
      occurrences: [],
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state: 'unavailable', omissions: [{ kind: 'fetch_failed', detail: e.message }] }),
    };
  }
}

// --- workflow_cron -----------------------------------------------------------

async function fetchWorkflowSchedulesRaw(orgId, { fetchImpl }) {
  const headers = buildInternalServiceHeaders({ 'X-Org-Id': orgId, 'Content-Type': 'application/json' });
  const resp = await fetchImpl(`${QUOXFLOW_URL()}/api/schedules`, { headers });
  if (!resp.ok) throw new Error(`quoxflow schedules ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.data) ? data.data : [];
}

function projectWorkflowSchedule(row, layerId, { windowStartLocalDate, windowEndLocalDateExclusive, timezone }) {
  if (!row.active || !row.expression) return { occurrences: [], omission: null };
  const tz = row.timezone || timezone;
  const expanded = expandCronOverWindow(row.expression, tz, windowStartLocalDate, windowEndLocalDateExclusive, { maxOccurrences: DEFAULT_MAX_PROJECTED });
  const scheduleId = `${row.workflowId}:${row.nodeId}`;
  if (expanded.unsupported) {
    return { occurrences: [], omission: { kind: 'unsupported_cron', detail: `workflow schedule ${scheduleId} has an unsupported expression "${row.expression}"` } };
  }
  // Audit fix 2: workflowId/nodeId are quoxflow-controlled identifiers.
  const title = sanitizeText(`Workflow ${row.workflowId} (${row.nodeId})`);
  const occurrences = expanded.occurrences.map((occ) => ({
    occurrenceKey: `wf:${scheduleId}:${occ.startTs}`,
    seriesId: scheduleId,
    layerId,
    title,
    startTs: occ.startTs,
    endTs: occ.startTs,
    allDay: false,
    timezone: tz,
    status: 'confirmed',
    busy: false,
    deepLink: '/triggers?tab=schedules',
    spokenForm: `${title}, scheduled ${new Date(occ.startTs).toISOString()}`,
  }));
  return { occurrences, omission: null };
}

async function listWorkflowCronOccurrences(orgId, { layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs }) {
  try {
    const rows = await fetchWorkflowSchedulesRaw(orgId, { fetchImpl });
    const occurrences = [];
    const omissions = [];
    for (const row of rows) {
      const { occurrences: occs, omission } = projectWorkflowSchedule(row, layer.layerId, { windowStartLocalDate, windowEndLocalDateExclusive, timezone });
      occurrences.push(...occs);
      if (omission) omissions.push(omission);
    }
    const state = omissions.length > 0 ? 'partial' : (occurrences.length === 0 ? 'empty' : 'complete');
    return {
      occurrences,
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state, omissions }),
    };
  } catch (e) {
    return {
      occurrences: [],
      coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state: 'unavailable', omissions: [{ kind: 'fetch_failed', detail: e.message }] }),
    };
  }
}

// --- dispatch + merged overlay ------------------------------------------------

/**
 * Fetch one layer's occurrences + coverage, dispatching on layer.kind. NEVER
 * throws — every branch catches its own fetch/parse failures and reports
 * coverage.state 'unavailable' instead, so one feed failing can never poison
 * a caller iterating multiple layers (see getOverlay below).
 */
async function listLayerOccurrences(orgId, { layer, userId = null, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (!orgId) throw new Error('listLayerOccurrences requires orgId');
  if (!layer) throw new Error('listLayerOccurrences requires layer');
  switch (layer.kind) {
    case 'provider':
      return listProviderOccurrences(orgId, { layer, windowStartLocalDate, windowEndLocalDateExclusive, nowMs });
    case 'internal_events':
      return listInternalEventsOccurrences(orgId, { layer, userId, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs });
    case 'team_schedules':
      return listTeamSchedulesOccurrences(orgId, { layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs });
    case 'workflow_cron':
      return listWorkflowCronOccurrences(orgId, { layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs });
    default:
      return {
        occurrences: [],
        coverage: syntheticCoverage({ orgId, layer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state: 'unavailable', omissions: [{ kind: 'unsupported_layer_kind', detail: layer.kind }] }),
      };
  }
}

/** Ensure the org's (and this user's) default layer set exists — one row per
 * connected provider connection + internal_events + team_schedules +
 * workflow_cron. Idempotent: only inserts a layer that does not already
 * exist, never overwrites a user's existing color/visible/displayName
 * choice on a repeat call. */
function seedDefaultLayers(orgId, userId) {
  const connections = store.listConnections(orgId);
  for (const conn of connections) {
    const layerId = `provider:${conn.id}`;
    if (!store.getLayer(orgId, layerId, null)) {
      store.upsertLayer({
        orgId, layerId, kind: 'provider', sourceRef: conn.id,
        displayName: conn.resourceLabel || conn.accountLabel || conn.resourceId,
        color: '#4285F4', visible: true, scope: 'org',
      });
    }
  }
  if (userId && !store.getLayer(orgId, 'internal_events', userId)) {
    store.upsertLayer({ orgId, layerId: 'internal_events', kind: 'internal_events', displayName: 'My events', color: '#8E44AD', visible: true, scope: 'user', userId });
  }
  if (!store.getLayer(orgId, 'team_schedules', null)) {
    store.upsertLayer({ orgId, layerId: 'team_schedules', kind: 'team_schedules', displayName: 'Team schedules', color: '#16A085', visible: true, scope: 'org' });
  }
  if (!store.getLayer(orgId, 'workflow_cron', null)) {
    store.upsertLayer({ orgId, layerId: 'workflow_cron', kind: 'workflow_cron', displayName: 'Workflow cron', color: '#E67E22', visible: true, scope: 'org' });
  }
}

/** Strip the store-internal userId field (not part of CalendarLayerV1) and
 * stamp the just-fetched coverage onto the layer record for the response. */
function toLayerPayload(layerRow, coverage) {
  return {
    v: '1',
    orgId: layerRow.orgId,
    layerId: layerRow.layerId,
    kind: layerRow.kind,
    sourceRef: layerRow.sourceRef,
    displayName: layerRow.displayName,
    color: layerRow.color || '#999999',
    visible: layerRow.visible,
    scope: layerRow.scope,
    coverage,
  };
}

/**
 * THE merged overlay read path: resolves the org/user layer set (seeding
 * defaults on first call), fetches every layer concurrently with per-layer
 * failure isolation, and returns {layers, occurrences, generatedAt}.
 *
 * An invisible layer (visible: false) is still listed with its coverage —
 * only its occurrences are omitted from the merged feed.
 */
async function getOverlay(orgId, { userId = null, windowStartLocalDate, windowEndLocalDateExclusive, timezone = 'UTC', fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (!orgId) throw new Error('getOverlay requires orgId');
  seedDefaultLayers(orgId, userId);

  const allLayers = store.listLayers(orgId);
  const scopedLayers = allLayers.filter((l) => l.scope === 'org' || l.userId === userId);

  const results = await Promise.all(scopedLayers.map((layerRow) =>
    listLayerOccurrences(orgId, { layer: layerRow, userId, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs })
  ));

  const layers = [];
  const occurrences = [];
  scopedLayers.forEach((layerRow, i) => {
    const { occurrences: layerOccs, coverage } = results[i];
    layers.push(toLayerPayload(layerRow, coverage));
    if (layerRow.visible) occurrences.push(...layerOccs);
  });

  return { layers, occurrences, generatedAt: nowMs };
}

/** A short, human-readable summary of what was actually checked — every
 * CalendarClashV1 cites this so a clash claim is bounded by its coverage. */
function buildWindowCoverageStatement(layers) {
  if (!Array.isArray(layers) || layers.length === 0) return 'No layers checked.';
  return layers
    .map((l) => `${l.displayName} (${l.coverage ? l.coverage.state : 'unknown'})`)
    .join('; ');
}

/** calendar_schedules_overview tool support: team_schedules + workflow_cron
 * summarised (counts, next 5 upcoming, paused/retired flags where the feed
 * exposes them) without surfacing raw per-occurrence detail. */
async function listSchedulesSummary(orgId, { timezone = 'UTC', windowStartLocalDate, windowEndLocalDateExclusive, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (!orgId) throw new Error('listSchedulesSummary requires orgId');

  function summarise(occurrences, coverage, kind, rawCount, activeCount, pausedCount) {
    const upcoming = occurrences
      .filter((o) => o.startTs >= nowMs)
      .sort((a, b) => a.startTs - b.startTs)
      .slice(0, 5)
      .map((o) => ({ occurrenceKey: o.occurrenceKey, title: o.title, startTs: o.startTs }));
    return { kind, coverage, scheduleCount: rawCount, activeCount, pausedCount, upcoming };
  }

  const teamLayer = { orgId, layerId: 'team_schedules', kind: 'team_schedules', sourceRef: null, displayName: 'Team schedules', scope: 'org' };
  const workflowLayer = { orgId, layerId: 'workflow_cron', kind: 'workflow_cron', sourceRef: null, displayName: 'Workflow cron', scope: 'org' };

  let teamRaw = [];
  let teamFetchError = null;
  try { teamRaw = await fetchTeamSchedulesRaw(orgId, { fetchImpl }); } catch (e) { teamFetchError = e; }

  let workflowRaw = [];
  let workflowFetchError = null;
  try { workflowRaw = await fetchWorkflowSchedulesRaw(orgId, { fetchImpl }); } catch (e) { workflowFetchError = e; }

  const teamResult = teamFetchError
    ? { occurrences: [], coverage: syntheticCoverage({ orgId, layer: teamLayer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state: 'unavailable', omissions: [{ kind: 'fetch_failed', detail: teamFetchError.message }] }) }
    : await listTeamSchedulesOccurrences(orgId, { layer: teamLayer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs });

  const workflowResult = workflowFetchError
    ? { occurrences: [], coverage: syntheticCoverage({ orgId, layer: workflowLayer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, nowMs, state: 'unavailable', omissions: [{ kind: 'fetch_failed', detail: workflowFetchError.message }] }) }
    : await listWorkflowCronOccurrences(orgId, { layer: workflowLayer, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs });

  const teamActive = teamRaw.filter((r) => r.enabled).length;
  const teamPaused = teamRaw.filter((r) => !r.enabled).length;
  const workflowActive = workflowRaw.filter((r) => r.active).length;
  const workflowPaused = workflowRaw.filter((r) => !r.active).length;

  return {
    team_schedules: summarise(teamResult.occurrences, teamResult.coverage, 'team_schedules', teamRaw.length, teamActive, teamPaused),
    workflow_cron: summarise(workflowResult.occurrences, workflowResult.coverage, 'workflow_cron', workflowRaw.length, workflowActive, workflowPaused),
  };
}

module.exports = {
  listLayerOccurrences,
  getOverlay,
  buildWindowCoverageStatement,
  listSchedulesSummary,
};
