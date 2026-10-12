'use strict';

/**
 * Calendar-Q cron projection (L2-C1b U1) — expands a standard 5-field cron
 * expression into concrete UTC occurrence instants over a local-date window,
 * timezone-aware so a "09:00 daily" cron keeps firing at 09:00 on the WALL
 * CLOCK through a DST transition, not at a fixed UTC offset.
 *
 * No cron parsing dependency is reachable from the collector or shared libs
 * (grepped services/collector + services/shared for require('cron') /
 * cronParser / getNextCronRun — none found; the tasks service has its own
 * lib/cronParser.js but that lives in a different process and is not a
 * collector dependency). This module is a minimal, STRICT 5-field expander:
 * numbers, ranges (a-b), steps (a-b/c or star-slash-c) and comma lists only. Anything
 * else (the six @keywords, a 6-field seconds form, L/W/# day syntax, month
 * or weekday NAMES) is rejected explicitly via { unsupported: true } rather
 * than guessed at — a silently-wrong occurrence is worse than an honestly
 * declined one.
 *
 * Zero LLM/model calls: every value here is deterministic arithmetic.
 */

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 }, // 0 and 7 both mean Sunday; normalized below.
];

// Only digits, commas, hyphens, slashes and '*' are supported syntax. A
// field using anything else (letters for month/weekday names, 'L', 'W', '#')
// is unsupported syntax, not a parse to attempt.
const FIELD_SHAPE_RE = /^[0-9,\-*/]+$/;

function pad2(n) { return String(n).padStart(2, '0'); }

/** Parse one cron field into the Set of concrete values it matches, or null
 * if the field uses syntax this expander does not support. */
function parseField(field, min, max) {
  if (!FIELD_SHAPE_RE.test(field)) return null;
  const values = new Set();
  for (const part of field.split(',')) {
    if (part === '') return null;
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return null;
    const [, base, rangeEnd, stepStr] = m;
    let start;
    let end;
    if (base === '*') {
      if (rangeEnd !== undefined) return null; // '*-n' is not valid cron syntax
      start = min;
      end = max;
    } else {
      start = Number(base);
      end = rangeEnd !== undefined ? Number(rangeEnd) : start;
    }
    if (start < min || start > max || end < min || end > max || end < start) return null;
    const step = stepStr !== undefined ? Number(stepStr) : 1;
    if (step <= 0) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

/**
 * Parse a 5-field cron expression. Returns { ok: true, fields: {minute,
 * hour, dom, month, dow, domWild, dowWild} } or { ok: false }.
 */
function parseCron(cronExpr) {
  if (typeof cronExpr !== 'string') return { ok: false };
  const trimmed = cronExpr.trim();
  if (trimmed.startsWith('@')) return { ok: false }; // @daily, @hourly, etc — unsupported
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { ok: false }; // rejects 6-field (seconds) forms too

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;
  const minute = parseField(minuteStr, FIELD_RANGES[0].min, FIELD_RANGES[0].max);
  const hour = parseField(hourStr, FIELD_RANGES[1].min, FIELD_RANGES[1].max);
  const dom = parseField(domStr, FIELD_RANGES[2].min, FIELD_RANGES[2].max);
  const month = parseField(monthStr, FIELD_RANGES[3].min, FIELD_RANGES[3].max);
  const dow = parseField(dowStr, FIELD_RANGES[4].min, FIELD_RANGES[4].max);
  if (!minute || !hour || !dom || !month || !dow) return { ok: false };

  // Normalize dow 7 -> 0 (both Sunday).
  if (dow.has(7)) { dow.delete(7); dow.add(0); }

  return {
    ok: true,
    fields: {
      minute, hour, dom, month, dow,
      domWild: domStr === '*',
      dowWild: dowStr === '*',
    },
  };
}

/** Pure calendar-date arithmetic on a 'YYYY-MM-DD' string (never touches a
 * wall clock or timezone — matches lib/calendarq/syncWorker.js's addDays). */
function addDays(dateOnly, days) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** The IANA offset (ms) such that localClockMs = utcMs + offset, at the
 * instant `utcMs`, in `tz` (matches lib/calendarq/syncWorker.js's helper of
 * the same name — duplicated here so this module has no cross-file
 * coupling of its own). */
function tzOffsetMsAt(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const localAsUtcMs = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return localAsUtcMs - utcMs;
}

/** The UTC instant at which the wall clock in `tz` reads `hour`:`minute` on
 * local date `dateOnly`. Fixed-point iteration, same technique as
 * syncWorker's localDateStartToUtcIso, generalized to an arbitrary
 * hour/minute rather than just local midnight. */
function localWallClockToUtcMs(dateOnly, hour, minute, tz) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const localWant = Date.UTC(y, m - 1, d, hour, minute, 0);
  let utcMs = localWant;
  for (let i = 0; i < 3; i++) {
    utcMs = localWant - tzOffsetMsAt(utcMs, tz);
  }
  return utcMs;
}

/** True iff `utcMs`, read on a wall clock in `tz`, actually reads back as
 * `dateOnly` `hour`:`minute`. A spring-forward DST gap makes some local
 * wall-clock times NOT EXIST — this is how that is detected, so a
 * non-existent local time is skipped rather than silently shifted. */
function roundTripsToLocal(utcMs, dateOnly, hour, minute, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  let h = Number(map.hour);
  if (h === 24) h = 0;
  const gotDate = `${map.year}-${map.month}-${map.day}`;
  return gotDate === dateOnly && h === hour && Number(map.minute) === minute;
}

/**
 * Expand a standard 5-field cron expression into concrete occurrence
 * instants, timezone-aware, over [windowStartLocalDate,
 * windowEndLocalDateExclusive) local dates in `timezone`.
 *
 * @returns {{occurrences:Array<{startTs:number,dateOnly:false}>}|{unsupported:true}}
 */
function expandCronOverWindow(cronExpr, timezone, windowStartLocalDate, windowEndLocalDateExclusive, { maxOccurrences = 500 } = {}) {
  const parsed = parseCron(cronExpr);
  if (!parsed.ok) return { unsupported: true };
  const { minute, hour, dom, month, dow, domWild, dowWild } = parsed.fields;

  const sortedHours = [...hour].sort((a, b) => a - b);
  const sortedMinutes = [...minute].sort((a, b) => a - b);

  const occurrences = [];
  let cursor = windowStartLocalDate;
  while (cursor < windowEndLocalDateExclusive && occurrences.length < maxOccurrences) {
    const [y, m, d] = cursor.split('-').map(Number);
    // Day-of-week is pure calendar arithmetic (date-only), never tz-dependent
    // — the calendar date's weekday is the same regardless of what instant
    // of the day it is read at.
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

    if (month.has(m)) {
      const domMatches = dom.has(d);
      const dowMatches = dow.has(weekday);
      // Standard cron DOM+DOW union semantics: when BOTH fields are
      // restricted (neither is '*'), a day matches if EITHER matches. When
      // one is '*', only the other constrains the day.
      let dayMatches;
      if (domWild && dowWild) dayMatches = true;
      else if (domWild) dayMatches = dowMatches;
      else if (dowWild) dayMatches = domMatches;
      else dayMatches = domMatches || dowMatches;

      if (dayMatches) {
        for (const h of sortedHours) {
          for (const min of sortedMinutes) {
            if (occurrences.length >= maxOccurrences) break;
            const utcMs = localWallClockToUtcMs(cursor, h, min, timezone);
            if (!roundTripsToLocal(utcMs, cursor, h, min, timezone)) continue; // DST gap: this local time never happened
            occurrences.push({ startTs: utcMs, dateOnly: false });
          }
          if (occurrences.length >= maxOccurrences) break;
        }
      }
    }
    cursor = addDays(cursor, 1);
  }

  return { occurrences };
}

module.exports = {
  expandCronOverWindow,
  // exported for unit tests / reuse elsewhere in this phase
  parseCron,
  localWallClockToUtcMs,
  roundTripsToLocal,
};
