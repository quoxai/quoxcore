'use strict';
// Current date/time line for agent turns. Injected into the CURRENT USER TURN
// only (never the system prompt) so the cacheable system prefix stays
// byte-identical between turns.

function validTimezone(tz) {
  if (typeof tz !== 'string') return null;
  const t = tz.trim();
  if (!t || t.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: t });
    return t;
  } catch {
    return null;
  }
}

function nowContext({ timezone, now = new Date() } = {}) {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tz = validTimezone(timezone);
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') {
    const d = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const p = Object.fromEntries(d.map(x => [x.type, x.value]));
    return `Current time: ${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} UTC; ${iso} UTC.`;
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `Current time: ${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.timeZoneName} (${tz}); ${iso} UTC.`;
}

// Prefix a user turn with the bracketed time line.
function withNowContext(message, opts) {
  return `[${nowContext(opts)}]\n\n${message}`;
}

module.exports = { nowContext, withNowContext, validTimezone };
