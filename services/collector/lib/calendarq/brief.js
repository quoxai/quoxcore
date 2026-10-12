'use strict';

/**
 * Calendar-Q morning-brief data contract (L2-C3 U2) — the deterministic,
 * zero-LLM structured payload AssistantQ's morning brief renders natural
 * language from at chat time. buildBriefInput computes it fresh from the
 * SAME governed read paths every other Calendar-Q surface uses
 * (layers.getOverlay, clash.detectClashes, agenda.getChanges, prep.getPrep,
 * store's own operation rows) and persists ONE row per (org, workday,
 * scheduleVersion) so a same-day re-read never silently recomputes a
 * different answer.
 *
 * PERSISTED vs ENRICHED split: contracts.js's CalendarBriefInputV1 pins
 * `upcoming` as an array of bare occurrenceKey strings (see contracts.js's
 * briefInputFields) — there is no per-item object shape for a prep reference
 * list in the validated, persisted contract. Meeting prep (prep.js) reads
 * LIVE InboxQ state at call time, so persisting it inside a brief row would
 * go stale the moment a new email arrives — the wrong trade for a durable
 * row. buildBriefInput therefore returns TWO things: `brief` (the exact
 * validated/persisted CalendarBriefInputV1) and `upcomingPrep` (a sibling,
 * NEVER persisted, freshly-computed array of { occurrenceKey, prep, error }
 * — the up-to-3 prep references per upcoming occurrence the phase asks for,
 * with per-item errors isolated rather than failing the whole brief).
 *
 * ABSENCE RULE: an empty `clashes` or `changes` array is only ever emitted
 * bare when the coverage backing it is fully known (every layer 'complete'
 * or 'empty'). Otherwise a marker object ({ state: 'partial', note }) is
 * pushed into that array instead of leaving a bare [] that could be misread
 * as a verified "nothing here" — `clashes`/`changes` are deliberately
 * unconstrained-item arrays at the contract layer precisely so this marker
 * shape is legal (see contracts.js's comment on briefInputFields). The one
 * case NOT covered by an in-array marker is the very first brief ever built
 * for an org: there `changes` genuinely IS [] (no previous brief exists to
 * diff against at all), and the "no baseline" fact is instead recorded as a
 * synthetic CalendarCoverageV1 entry appended to `coverage` (a coverage
 * omission, not a changes-array marker) — matching the phase brief's literal
 * wording: "first brief -> changes:[] + a coverage omission noting no
 * baseline".
 *
 * Zero LLM calls: every field here is assembled from store reads, pure date
 * arithmetic, and the existing layers/clash/agenda/prep modules.
 */

const store = require('./store');
const { getOverlay, buildWindowCoverageStatement } = require('./layers');
const { detectClashes, isHumanBusy } = require('./clash');
const { getChanges } = require('./agenda');
const { getPrep } = require('./prep');
const { addDays, localDateStartToUtcIso } = require('./syncWorker');
const { validateCalendarBriefInputV1 } = require('./contracts');

const MAX_UPCOMING = 3;
const MAX_REFS_PER_UPCOMING = 3;
const MAX_CHANGES = 20;
const FORWARD_WINDOW_DAYS = 30;

const RECEIPT_STATE_FIELDS = { proposed: 'proposed', confirmed: 'confirmed', outcome_unknown: 'outcomeUnknown' };

function isCoverageKnown(c) {
  return c.state === 'complete' || c.state === 'empty';
}

function syntheticNoBaselineCoverage(orgId, workday, timezone, nowMs) {
  return {
    v: '1',
    orgId,
    connectionId: 'calendarq-brief-changes',
    resourceId: 'calendarq-brief-changes',
    windowStartLocalDate: workday,
    windowEndLocalDateExclusive: workday,
    timezone,
    generationId: `brief-changes:${workday}`,
    complete: false,
    watermarkTs: nowMs,
    freshnessTs: nowMs,
    omissions: [{ kind: 'no_baseline', detail: 'No previous Calendar-Q brief exists for this org yet, so changes could not be diffed against a prior snapshot.' }],
    state: 'partial',
  };
}

/** Receipt-backed by construction: these are not invented numbers, they are
 * plain counts of operations already persisted in the trust-critical
 * calendarq_operations store, so by construction they can never drift from
 * what the operations table says happened. */
function receiptCounts(orgId) {
  const ops = store.listOperations(orgId).filter((op) => op.kind === 'create_event');
  const counts = { proposed: 0, confirmed: 0, outcomeUnknown: 0 };
  for (const op of ops) {
    const field = RECEIPT_STATE_FIELDS[op.state];
    if (field) counts[field] += 1;
  }
  return counts;
}

function withinDay(occ, dayStartMs, dayEndMs) {
  const startTs = typeof occ.startTs === 'number' ? occ.startTs : null;
  if (startTs == null) return false;
  const endTs = typeof occ.endTs === 'number' ? occ.endTs : startTs;
  return startTs < dayEndMs && endTs > dayStartMs;
}

/** Up-to-3 prep references per upcoming occurrence, computed FRESH on every
 * read (never persisted — see the module doc comment above). Errors are
 * isolated per occurrence: one occurrence's prep failing (e.g. it came from
 * a synthetic internal_events/team_schedules/workflow_cron layer, which has
 * no generation for getPrep to resolve, so it throws occurrence_not_found)
 * never fails the brief or any other occurrence's prep. */
function buildUpcomingPrep(orgId, occurrenceKeys, nowMs) {
  const out = [];
  for (const occurrenceKey of occurrenceKeys || []) {
    try {
      const prep = getPrep(orgId, { occurrenceKey, nowMs });
      out.push({ occurrenceKey, prep: { ...prep, references: prep.references.slice(0, MAX_REFS_PER_UPCOMING) }, error: null });
    } catch (e) {
      out.push({ occurrenceKey, prep: null, error: e.message });
    }
  }
  return out;
}

/**
 * @param {string} orgId
 * @param {object} opts { workday 'YYYY-MM-DD', timezone, nowMs, fetchImpl, force }
 * @returns {Promise<{brief: object, upcomingPrep: object[], created: boolean}>}
 */
async function buildBriefInput(orgId, { workday, timezone = 'UTC', nowMs = Date.now(), fetchImpl = fetch, force = false } = {}) {
  if (!orgId) throw new Error('buildBriefInput requires orgId');
  if (!workday) throw new Error('buildBriefInput requires workday');

  const existing = store.getLatestBriefForWorkday(orgId, workday);
  if (existing && !force) {
    return { brief: existing.payload, upcomingPrep: buildUpcomingPrep(orgId, existing.payload.upcoming, nowMs), created: false };
  }

  // The previous brief this build diffs `changes` against — the most
  // recently created brief for this ORG overall (any workday), never
  // assumed to be for the same workday. On a force rebuild this is, in
  // practice, the very brief being superseded.
  const previous = store.getLatestBriefOverall(orgId);

  const windowEndExclusive = addDays(workday, FORWARD_WINDOW_DAYS);
  const overlay = await getOverlay(orgId, { userId: null, windowStartLocalDate: workday, windowEndLocalDateExclusive: windowEndExclusive, timezone, fetchImpl, nowMs });
  const coverage = overlay.layers.map((l) => l.coverage);

  const workdayStartMs = new Date(localDateStartToUtcIso(workday, timezone)).getTime();
  const workdayEndMs = new Date(localDateStartToUtcIso(addDays(workday, 1), timezone)).getTime();
  const kindById = new Map(overlay.layers.map((l) => [l.layerId, l.kind]));

  // --- upcoming: next 3 human-busy occurrences from the workday onward ----
  const upcomingOccs = overlay.occurrences
    .filter((o) => isHumanBusy(o, kindById) && typeof o.startTs === 'number' && o.startTs >= workdayStartMs)
    .sort((a, b) => a.startTs - b.startTs)
    .slice(0, MAX_UPCOMING);
  const upcoming = upcomingOccs.map((o) => o.occurrenceKey);

  // --- clashes: scoped to the workday window only (per the phase brief) --
  const dayOccurrences = overlay.occurrences.filter((o) => withinDay(o, workdayStartMs, workdayEndMs));
  const windowCoverageStatement = buildWindowCoverageStatement(overlay.layers);
  let clashes = detectClashes(orgId, { occurrences: dayOccurrences, layers: overlay.layers, windowCoverageStatement, nowMs });

  const coverageFullyKnown = coverage.every(isCoverageKnown);
  if (clashes.length === 0 && !coverageFullyKnown) {
    clashes = [{ state: 'partial', note: 'Clashes could not be fully checked: at least one calendar layer is not complete.', windowCoverageStatement }];
  }

  // --- changes: vs the PREVIOUS persisted brief's generation watermark ----
  let changes = [];
  if (!previous) {
    coverage.push(syntheticNoBaselineCoverage(orgId, workday, timezone, nowMs));
  } else {
    const providerLayers = overlay.layers.filter((l) => l.kind === 'provider' && l.sourceRef);
    for (const layer of providerLayers) {
      // A connection absent from the previous brief's watermark map (e.g. it
      // was connected after that brief was built) has no honest baseline to
      // diff against yet — skipped rather than fabricating a "0 changes".
      const sinceGenerationId = previous.generationWatermarks[layer.sourceRef];
      if (!sinceGenerationId) continue;
      try {
        const diff = getChanges(orgId, { sinceGenerationId });
        changes.push(...diff.changes);
      } catch {
        // Isolated per-connection failure — never fails the whole brief.
      }
    }
    const totalChangesFound = changes.length;
    if (totalChangesFound > MAX_CHANGES) {
      changes = changes.slice(0, MAX_CHANGES - 1);
      changes.push({ omission: true, note: `${totalChangesFound - (MAX_CHANGES - 1)} more change(s) omitted (capped at ${MAX_CHANGES}).` });
    } else if (changes.length === 0 && !coverageFullyKnown) {
      changes = [{ state: 'partial', note: 'Changes could not be fully checked: at least one calendar layer is not complete.' }];
    }
  }

  // --- receipts: counts by op state, receipt-backed by construction -------
  const receipts = receiptCounts(orgId);

  // --- generation watermarks the NEXT brief will diff against -------------
  const generationWatermarks = {};
  for (const layer of overlay.layers) {
    if (layer.kind === 'provider' && layer.sourceRef && layer.coverage
      && typeof layer.coverage.generationId === 'string' && layer.coverage.generationId.startsWith('calgen_')) {
      generationWatermarks[layer.sourceRef] = layer.coverage.generationId;
    }
  }

  const scheduleVersion = existing ? String(Number(existing.scheduleVersion) + 1) : '1';

  const brief = { v: '1', orgId, workday, scheduleVersion, coverage, upcoming, changes, clashes, receipts };

  const validated = validateCalendarBriefInputV1(brief);
  if (!validated.ok) {
    throw new Error(`buildBriefInput produced an invalid CalendarBriefInputV1: ${validated.errors.join('; ')}`);
  }

  store.createBrief({ orgId, workday, scheduleVersion, payload: brief, generationWatermarks });

  return { brief, upcomingPrep: buildUpcomingPrep(orgId, upcoming, nowMs), created: true };
}

module.exports = { buildBriefInput };
