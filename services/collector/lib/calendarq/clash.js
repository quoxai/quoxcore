'use strict';

/**
 * Calendar-Q clash engine (L2-C1b U3) — detects human_double_book clashes
 * across the occurrences+layers that getOverlay() returned. A pure function
 * over its inputs: no store reads, no network, no LLM calls — the caller
 * (the overlay/clashes API route or an agent tool) is responsible for
 * fetching occurrences via layers.getOverlay first.
 *
 * v1 scope, deliberately narrow:
 *   - human_double_book ONLY. resource/declared_constraint classes exist in
 *     the CalendarClashV1 contract's enum but are NOT implemented here.
 *   - a machine layer (team_schedules / workflow_cron) NEVER produces a
 *     clash in v1, not even against a human occurrence — a cron firing
 *     during a meeting is not "double-booked", it has no human attending it
 *     to be double-booked.
 *   - two occurrences from the SAME series (a recurring event's own
 *     instances) never clash with each other.
 *
 * Every clash is stamped with the windowCoverageStatement the caller
 * supplies, so a clash claim is bounded by what was actually checked at
 * detection time, not a silent assumption that every layer was fresh.
 */

const crypto = require('crypto');
const { validateCalendarClashV1 } = require('./contracts');

const HUMAN_LAYER_KINDS = new Set(['provider', 'internal_events']);

function layerKindById(layers) {
  const map = new Map();
  for (const l of layers || []) map.set(l.layerId, l.kind);
  return map;
}

/** True for an occurrence that represents an actual human commitment: on a
 * human layer (provider/internal_events), not cancelled, and not marked
 * transparent (busy: false). Tentative still counts — a tentative hold is
 * still a double-book risk, just annotated as tentative in the UI. */
function isHumanBusy(occ, kindById) {
  const kind = kindById.get(occ.layerId);
  if (!HUMAN_LAYER_KINDS.has(kind)) return false;
  if (occ.status === 'cancelled') return false;
  if (occ.busy === false) return false;
  return true;
}

function occurrenceRange(occ) {
  if (occ.allDay && occ.dateOnlyStart) {
    const startKey = occ.dateOnlyStart;
    const endKey = typeof occ.endTs === 'number' ? new Date(occ.endTs).toISOString().slice(0, 10) : startKey;
    return { kind: 'date', startKey, endKey };
  }
  return { kind: 'ts', startMs: occ.startTs, endMs: occ.endTs };
}

function dateOverlapsTs(dateRange, tsRange) {
  const tsStartDate = new Date(tsRange.startMs).toISOString().slice(0, 10);
  const tsEndDate = new Date(tsRange.endMs).toISOString().slice(0, 10);
  return dateRange.startKey <= tsEndDate && tsStartDate < dateRange.endKey;
}

/** True iff the two occurrences' time ranges overlap. All-day occurrences
 * occupy their local DATES (string comparison), never a ms instant — a
 * timed occurrence compares against a date-only range via its own UTC date. */
function rangesOverlap(a, b) {
  if (a.kind === 'date' && b.kind === 'date') return a.startKey < b.endKey && b.startKey < a.endKey;
  if (a.kind === 'date') return dateOverlapsTs(a, b);
  if (b.kind === 'date') return dateOverlapsTs(b, a);
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function stableClashId(occurrenceKeys) {
  const sorted = [...occurrenceKeys].sort();
  return `clash:${crypto.createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 24)}`;
}

/**
 * @param {string} orgId
 * @param {object} opts { occurrences, layers, windowCoverageStatement, nowMs }
 * @returns {object[]} CalendarClashV1[]
 */
function detectClashes(orgId, { occurrences = [], layers = [], windowCoverageStatement, nowMs = Date.now() } = {}) {
  if (!orgId) throw new Error('detectClashes requires orgId');
  if (!windowCoverageStatement) throw new Error('detectClashes requires windowCoverageStatement');

  const kindById = layerKindById(layers);
  const candidates = occurrences.filter((occ) => isHumanBusy(occ, kindById));

  const clashes = [];
  const seenPairs = new Set();

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.occurrenceKey === b.occurrenceKey) continue;
      if (a.seriesId && a.seriesId === b.seriesId) continue;
      if (!rangesOverlap(occurrenceRange(a), occurrenceRange(b))) continue;

      const occurrenceKeys = [a.occurrenceKey, b.occurrenceKey].sort();
      const pairKey = occurrenceKeys.join('|');
      if (seenPairs.has(pairKey)) continue; // symmetric dedupe
      seenPairs.add(pairKey);

      const layerIds = [...new Set([a.layerId, b.layerId])];
      const clash = {
        v: '1',
        orgId,
        clashId: stableClashId(occurrenceKeys),
        class: 'human_double_book',
        occurrenceKeys,
        layerIds,
        windowCoverageStatement,
        detectedAt: nowMs,
      };
      const validated = validateCalendarClashV1(clash);
      if (!validated.ok) {
        throw new Error(`detectClashes produced an invalid CalendarClashV1: ${validated.errors.join('; ')}`);
      }
      clashes.push(clash);
    }
  }

  return clashes;
}

module.exports = { detectClashes, isHumanBusy };
