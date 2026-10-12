'use strict';

/**
 * QUOX-SECURITY-SCHED: native cron cadence for recurring scan schedules.
 *
 * A small, dependency-free, deterministic cron evaluator. It exists so a
 * schedule like "weekly Wednesday 03:00" can be expressed natively instead
 * of demanding a manual next_run_at alignment against an interval. No cron
 * library is pulled in (the collector has none, and this is a tiny surface).
 *
 * Everything here is PURE: nextCronTime takes a fromIso and returns an ISO
 * string, and NEVER calls Date.now() internally, so it is fully testable and
 * the caller owns the clock (same clock-injection convention as
 * securityEngagementSchedules.js).
 *
 * TIMEZONE: v1 is UTC-only by design. The schedule row stores a `timezone`
 * column, but it is NOT honored yet: all fields are evaluated in UTC. A
 * non-UTC timezone is neither silently applied nor rejected here (the store
 * simply persists the column for a future phase). Do not read the stored
 * timezone as "in effect" until this file is upgraded to honor it.
 *
 * dom/dow semantics follow standard cron: when BOTH day-of-month and
 * day-of-week are restricted (neither is "*"), a match on EITHER fires.
 */

// Mirror securityEngagementSchedules.MIN_INTERVAL_SECONDS: a cron whose two
// soonest fires are closer than this is rejected, so a misconfigured
// "* * * * *" cannot hammer a target.
const MIN_CRON_INTERVAL_SECONDS = 300;

// Bound the minute-by-minute search so a pathological (but individually
// valid) expression can never spin forever. 366 days covers every legal
// combination that will ever actually fire.
const MAX_SEARCH_MINUTES = 366 * 24 * 60;

const FIELD_BOUNDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 }, // 0 = Sunday
];

// Parse a single field into a Set of allowed integers, plus a wildcard flag.
// Supports "*", lists "a,b", ranges "a-b", steps "*/n" and "a-b/n".
function parseField(raw, bounds) {
  const { name, min, max } = bounds;
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    throw new Error(`Invalid cron: empty ${name} field`);
  }

  let isWildcard = false;
  const values = new Set();

  for (const part of trimmed.split(',')) {
    const chunk = part.trim();
    if (chunk === '') {
      throw new Error(`Invalid cron: empty term in ${name} field ("${raw}")`);
    }

    let rangePart = chunk;
    let step = 1;
    if (chunk.includes('/')) {
      const [base, stepStr] = chunk.split('/');
      if (stepStr === undefined || !/^\d+$/.test(stepStr) || Number(stepStr) < 1) {
        throw new Error(`Invalid cron: bad step in ${name} field ("${chunk}")`);
      }
      step = Number(stepStr);
      rangePart = base.trim();
    }

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
      if (step === 1) isWildcard = true;
    } else if (rangePart.includes('-')) {
      const [loStr, hiStr] = rangePart.split('-');
      if (!/^\d+$/.test(loStr) || !/^\d+$/.test(hiStr)) {
        throw new Error(`Invalid cron: bad range in ${name} field ("${chunk}")`);
      }
      lo = Number(loStr);
      hi = Number(hiStr);
    } else {
      if (!/^\d+$/.test(rangePart)) {
        throw new Error(`Invalid cron: bad value in ${name} field ("${chunk}")`);
      }
      lo = Number(rangePart);
      hi = Number(rangePart);
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron: ${name} value out of range ${min}-${max} ("${chunk}")`);
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }

  return { isWildcard, values };
}

/**
 * Validate and parse a standard 5-field cron expression.
 * @param {string} expr - "min hour dom month dow"
 * @returns {{minute, hour, dayOfMonth, month, dayOfWeek, raw:string}}
 */
function parseCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new Error('Invalid cron: expression must be a non-empty string');
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron: expected 5 fields (min hour dom month dow), got ${fields.length} ("${expr}")`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) => parseField(f, FIELD_BOUNDS[i]));
  return { minute, hour, dayOfMonth, month, dayOfWeek, raw: expr.trim() };
}

function matches(parsed, date) {
  const minuteOk = parsed.minute.values.has(date.getUTCMinutes());
  const hourOk = parsed.hour.values.has(date.getUTCHours());
  const monthOk = parsed.month.values.has(date.getUTCMonth() + 1);
  if (!minuteOk || !hourOk || !monthOk) return false;

  const domRestricted = !parsed.dayOfMonth.isWildcard;
  const dowRestricted = !parsed.dayOfWeek.isWildcard;
  const domOk = parsed.dayOfMonth.values.has(date.getUTCDate());
  const dowOk = parsed.dayOfWeek.values.has(date.getUTCDay());

  if (domRestricted && dowRestricted) {
    // Standard cron: either matches.
    return domOk || dowOk;
  }
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true; // both wildcard
}

/**
 * Next UTC ISO-8601 time strictly AFTER fromIso that matches the expression.
 * Steps minute-by-minute (seconds/millis zeroed) bounded by MAX_SEARCH_MINUTES.
 * @param {string} expr
 * @param {string} fromIso
 * @returns {string} ISO-8601 UTC (e.g. "2026-08-26T02:00:00.000Z")
 */
function nextCronTime(expr, fromIso) {
  const parsed = parseCron(expr);
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) {
    throw new Error(`Invalid fromIso passed to nextCronTime: "${fromIso}"`);
  }

  // Start at the next whole minute strictly after fromIso (zero sec/ms), so
  // a fromIso that is itself a matching instant returns the NEXT fire.
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_SEARCH_MINUTES; i += 1) {
    if (matches(parsed, cursor)) {
      return cursor.toISOString();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`No cron fire found within ${MAX_SEARCH_MINUTES} minutes for "${expr}"`);
}

/**
 * Reject a cron whose two soonest fires are less than MIN_CRON_INTERVAL_SECONDS
 * apart. Computed from a fixed reference so it is deterministic and does not
 * depend on when it is called.
 * @param {string} expr
 */
function assertCronNotTooFrequent(expr) {
  parseCron(expr); // surface malformed input as a parse error first
  const ref = '2026-01-01T00:00:00.000Z';
  const first = nextCronTime(expr, ref);
  const second = nextCronTime(expr, first);
  const gapSeconds = (new Date(second).getTime() - new Date(first).getTime()) / 1000;
  if (gapSeconds < MIN_CRON_INTERVAL_SECONDS) {
    throw new Error(
      `cron_expression "${expr}" fires too frequently: ${gapSeconds}s between runs, ` +
      `minimum is ${MIN_CRON_INTERVAL_SECONDS}s (the enforced floor)`
    );
  }
}

module.exports = {
  MIN_CRON_INTERVAL_SECONDS,
  parseCron,
  nextCronTime,
  assertCronNotTooFrequent,
};
