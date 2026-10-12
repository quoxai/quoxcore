/**
 * QUOXCHAT-PRO P1 — office-hours evaluator.
 *
 * Decides whether a widget's HUMAN operators are inside their configured
 * office hours right now. This only affects human-handoff expectations
 * (the "our team is offline" banner) — the AI keeps answering regardless.
 *
 * office_hours_json shape (stored on website_widgets, evaluated here
 * server-side so the widget never needs timezone math):
 *   {
 *     "timezone": "Europe/London",          // IANA zone, default UTC
 *     "hours": {
 *       "mon": [["09:00","17:00"]],         // list of [start, end) ranges
 *       "tue": [{"start":"09:00","end":"17:00"}],  // object form also accepted
 *       ...
 *       "sun": []                            // empty / missing day = closed
 *     }
 *   }
 *
 * Rules:
 * - null / missing / unparseable config = no schedule = always within hours
 *   (fail OPEN: a broken schedule must never flip a widget to "offline").
 * - A day key missing from `hours` = closed that day.
 * - Ranges are [start, end) in the configured timezone, "HH:MM" 24h form.
 * - Malformed individual ranges are skipped.
 */

'use strict';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function _parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Resolve "now" in the given IANA timezone to { day: 'mon', minutes: 540 }.
 * Falls back to UTC when the zone is invalid.
 */
function _nowInZone(timezone, now) {
  const d = now instanceof Date ? now : new Date();
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
  }
  let weekday = '';
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value.toLowerCase().slice(0, 3);
    else if (p.type === 'hour') hour = parseInt(p.value, 10) % 24; // "24" for midnight in some ICU versions
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  const day = DAY_KEYS.includes(weekday) ? weekday : DAY_KEYS[d.getUTCDay()];
  return { day, minutes: hour * 60 + minute };
}

/**
 * @param {object|string|null} officeHours - parsed object or JSON string
 * @param {Date} [now] - injectable for tests
 * @returns {boolean} true when inside office hours (or no valid schedule)
 */
function isWithinOfficeHours(officeHours, now) {
  let cfg = officeHours;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch { return true; }
  }
  if (!cfg || typeof cfg !== 'object') return true;
  const hours = cfg.hours;
  if (!hours || typeof hours !== 'object') return true;

  const { day, minutes } = _nowInZone(cfg.timezone, now);
  const ranges = hours[day];
  if (!Array.isArray(ranges) || ranges.length === 0) return false; // closed today

  for (const r of ranges) {
    let start = null;
    let end = null;
    if (Array.isArray(r)) { start = _parseHHMM(r[0]); end = _parseHHMM(r[1]); }
    else if (r && typeof r === 'object') { start = _parseHHMM(r.start); end = _parseHHMM(r.end); }
    if (start === null || end === null) continue; // skip malformed range
    if (minutes >= start && minutes < end) return true;
  }
  return false;
}

/**
 * Combined human-availability verdict for a widget meta row.
 * operator_online is a manual toggle (default on); office hours are the
 * schedule. Humans are available only when BOTH allow it.
 *
 * @param {object|null} meta - widget meta row ({ operator_online, office_hours_json })
 * @param {Date} [now]
 * @returns {{ operator_online: boolean, within_office_hours: boolean, human_available: boolean }}
 */
function evaluateAvailability(meta, now) {
  const operatorOnline = !meta || meta.operator_online === undefined || meta.operator_online === null
    ? true
    : !!Number(meta.operator_online);
  const withinHours = isWithinOfficeHours(meta ? meta.office_hours_json : null, now);
  return {
    operator_online: operatorOnline,
    within_office_hours: withinHours,
    human_available: operatorOnline && withinHours,
  };
}

module.exports = { isWithinOfficeHours, evaluateAvailability };
