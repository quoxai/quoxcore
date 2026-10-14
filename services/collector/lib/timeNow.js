'use strict';
/**
 * QUOXON: the core read-only clock tool `time_now(timezone?, location?)`.
 *
 * Models do not know the time and guess DST badly (evidence: "what time is it in Panama?"
 * on Ollama, a wrong DST guess and no tool call). This answers from the server clock and
 * Intl (the runtime's tz database). No network, no org data, no effect.
 *
 * A place name maps through a small built-in table (countries and major cities, with
 * accents and case ignored); anything else must be an IANA zone ("America/Panama").
 */

// Lowercase, accent-free place -> IANA zone. Keep it small; IANA names always work.
const PLACES = Object.freeze({
  utc: 'UTC', gmt: 'UTC', zulu: 'UTC',
  // Americas
  panama: 'America/Panama', 'panama city': 'America/Panama',
  'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York', washington: 'America/New_York', miami: 'America/New_York', toronto: 'America/Toronto', montreal: 'America/Toronto',
  chicago: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', denver: 'America/Denver', phoenix: 'America/Phoenix',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', seattle: 'America/Los_Angeles', vancouver: 'America/Vancouver',
  anchorage: 'America/Anchorage', honolulu: 'Pacific/Honolulu', hawaii: 'Pacific/Honolulu',
  'mexico city': 'America/Mexico_City', mexico: 'America/Mexico_City', 'costa rica': 'America/Costa_Rica', colombia: 'America/Bogota', bogota: 'America/Bogota',
  peru: 'America/Lima', lima: 'America/Lima', chile: 'America/Santiago', santiago: 'America/Santiago', argentina: 'America/Argentina/Buenos_Aires', 'buenos aires': 'America/Argentina/Buenos_Aires',
  brazil: 'America/Sao_Paulo', 'sao paulo': 'America/Sao_Paulo', 'rio de janeiro': 'America/Sao_Paulo', venezuela: 'America/Caracas', caracas: 'America/Caracas',
  jamaica: 'America/Jamaica', cuba: 'America/Havana', havana: 'America/Havana', 'puerto rico': 'America/Puerto_Rico',
  // Europe / Africa
  london: 'Europe/London', uk: 'Europe/London', 'united kingdom': 'Europe/London', england: 'Europe/London', scotland: 'Europe/London', wales: 'Europe/London', edinburgh: 'Europe/London', manchester: 'Europe/London',
  ireland: 'Europe/Dublin', dublin: 'Europe/Dublin', lisbon: 'Europe/Lisbon', portugal: 'Europe/Lisbon',
  paris: 'Europe/Paris', france: 'Europe/Paris', berlin: 'Europe/Berlin', germany: 'Europe/Berlin', madrid: 'Europe/Madrid', spain: 'Europe/Madrid',
  rome: 'Europe/Rome', italy: 'Europe/Rome', amsterdam: 'Europe/Amsterdam', netherlands: 'Europe/Amsterdam', brussels: 'Europe/Brussels', belgium: 'Europe/Brussels',
  zurich: 'Europe/Zurich', switzerland: 'Europe/Zurich', vienna: 'Europe/Vienna', austria: 'Europe/Vienna', stockholm: 'Europe/Stockholm', sweden: 'Europe/Stockholm',
  oslo: 'Europe/Oslo', norway: 'Europe/Oslo', copenhagen: 'Europe/Copenhagen', denmark: 'Europe/Copenhagen', helsinki: 'Europe/Helsinki', finland: 'Europe/Helsinki',
  warsaw: 'Europe/Warsaw', poland: 'Europe/Warsaw', prague: 'Europe/Prague', athens: 'Europe/Athens', greece: 'Europe/Athens',
  istanbul: 'Europe/Istanbul', turkey: 'Europe/Istanbul', kyiv: 'Europe/Kyiv', kiev: 'Europe/Kyiv', ukraine: 'Europe/Kyiv', moscow: 'Europe/Moscow', russia: 'Europe/Moscow',
  cairo: 'Africa/Cairo', egypt: 'Africa/Cairo', lagos: 'Africa/Lagos', nigeria: 'Africa/Lagos', nairobi: 'Africa/Nairobi', kenya: 'Africa/Nairobi',
  johannesburg: 'Africa/Johannesburg', 'south africa': 'Africa/Johannesburg', 'cape town': 'Africa/Johannesburg', morocco: 'Africa/Casablanca', casablanca: 'Africa/Casablanca',
  // Asia / Oceania
  dubai: 'Asia/Dubai', uae: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', riyadh: 'Asia/Riyadh', 'saudi arabia': 'Asia/Riyadh', israel: 'Asia/Jerusalem', jerusalem: 'Asia/Jerusalem', 'tel aviv': 'Asia/Jerusalem',
  tehran: 'Asia/Tehran', iran: 'Asia/Tehran', karachi: 'Asia/Karachi', pakistan: 'Asia/Karachi',
  india: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', bangalore: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata', kolkata: 'Asia/Kolkata',
  nepal: 'Asia/Kathmandu', kathmandu: 'Asia/Kathmandu', dhaka: 'Asia/Dhaka', bangladesh: 'Asia/Dhaka',
  bangkok: 'Asia/Bangkok', thailand: 'Asia/Bangkok', vietnam: 'Asia/Ho_Chi_Minh', jakarta: 'Asia/Jakarta', indonesia: 'Asia/Jakarta',
  singapore: 'Asia/Singapore', 'kuala lumpur': 'Asia/Kuala_Lumpur', malaysia: 'Asia/Kuala_Lumpur', manila: 'Asia/Manila', philippines: 'Asia/Manila',
  'hong kong': 'Asia/Hong_Kong', china: 'Asia/Shanghai', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai', taiwan: 'Asia/Taipei', taipei: 'Asia/Taipei',
  seoul: 'Asia/Seoul', korea: 'Asia/Seoul', 'south korea': 'Asia/Seoul', tokyo: 'Asia/Tokyo', japan: 'Asia/Tokyo',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', brisbane: 'Australia/Brisbane', perth: 'Australia/Perth', adelaide: 'Australia/Adelaide',
  auckland: 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland', wellington: 'Pacific/Auckland', fiji: 'Pacific/Fiji',
});

function normPlace(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9/_+\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isValidZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** IANA zone for a timezone or place string, or null. */
function resolveZone(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  const n = normPlace(raw);
  if (PLACES[n]) return PLACES[n];
  if (raw.includes('/') || /^(utc|gmt|etc\/)/i.test(raw)) {
    if (isValidZone(raw)) return raw;
  }
  // "Panama, Central America" / "Panama City, Panama": try each comma part.
  for (const part of raw.split(',')) { const p = normPlace(part); if (PLACES[p]) return PLACES[p]; }
  return null;
}

/** Offset in minutes (local - UTC) for a zone at an instant. */
function offsetMinutes(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

const fmtOffset = (m) => `${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
const pad = (n) => String(n).padStart(2, '0');

/**
 * -> { success, utc, timezone, offset, local, local_date, local_time, weekday, dst_today, observes_dst, standard_offset }
 * On an unknown place: { success:false, error, utc } (UTC still given, never a guess).
 */
function timeNow(input = {}, { now } = {}) {
  const date = now instanceof Date ? now : new Date();
  const utc = date.toISOString();
  const asked = (input && (input.timezone || input.location)) || '';
  let tz = 'UTC';
  if (asked) {
    tz = resolveZone(input.timezone) || resolveZone(input.location);
    if (!tz) {
      return {
        success: false,
        error: `Unknown timezone or place "${String(asked).slice(0, 80)}". Pass an IANA timezone such as "America/Panama" or "Europe/London".`,
        utc,
      };
    }
  }
  const off = offsetMinutes(tz, date);
  const y = date.getUTCFullYear();
  const jan = offsetMinutes(tz, new Date(Date.UTC(y, 0, 1, 12)));
  const jul = offsetMinutes(tz, new Date(Date.UTC(y, 6, 1, 12)));
  const std = Math.min(jan, jul);
  const observes = jan !== jul;
  const local = new Date(date.getTime() + off * 60000);
  const localDate = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const localTime = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return {
    success: true,
    utc,
    timezone: tz,
    offset: fmtOffset(off),
    local: `${localDate}T${localTime}${fmtOffset(off)}`,
    local_date: localDate,
    local_time: localTime,
    weekday: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(date),
    dst_today: observes && off !== std,
    observes_dst: observes,
    standard_offset: fmtOffset(std),
  };
}

const TIME_NOW_TOOL = Object.freeze({
  name: 'time_now',
  description: 'Current date and time from the server clock: UTC, plus local time, UTC offset and whether daylight saving applies today for an IANA timezone or a place name (city or country). Use it for any question about the current time or date anywhere; never guess offsets or DST.',
  input_schema: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA timezone, e.g. "America/Panama". Optional.' },
      location: { type: 'string', description: 'A city or country, e.g. "Panama" or "Tokyo". Optional.' },
    },
    required: [],
  },
});

module.exports = { timeNow, resolveZone, TIME_NOW_TOOL, PLACES };
