'use strict';
/**
 * Wave 13: a stay that crosses a dated rate change is charged night by night.
 * KNOWLEDGE: "Winter rates apply to nights from 1 November to 31 March. Summer
 * rates apply to nights from 1 April to 31 October. A stay that crosses the
 * change is charged night by night." A model quoted one rate x N nights for a
 * stay over 1 November. The nights and their seasons are computed here, handed
 * to the prompt as a fact, and a single seasonal rate multiplied by the whole
 * stay is flagged as an unsupported figure so the regenerate-once path fires.
 */
const { parseDates } = require('./quoxchatDateWindow');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const SEASON_RE = new RegExp(`\\b([A-Za-z]+)\\s+(?:rates?|prices?|season)\\s+(?:apply|applies|applying|run|runs)?\\s*(?:to\\s+)?(?:nights?\\s+)?(?:from\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON_RE}\\s+(?:to|until|through|-)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON_RE}`, 'gi');
const mIdx = (s) => MONTHS.findIndex((m) => m.startsWith(String(s).slice(0, 3).toLowerCase()));
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14 };
const DAY_MS = 86400000;

function findSeasons(knowledgeTexts) {
  const out = []; const seen = new Set();
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const m of String(k || '').matchAll(SEASON_RE)) {
      const name = m[1].toLowerCase();
      if (['the', 'our', 'all', 'standard', 'these', 'those'].includes(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, start: [mIdx(m[3]), Number(m[2])], end: [mIdx(m[5]), Number(m[4])] });
    }
  }
  return out.length >= 2 ? out : [];
}
const key = (mo, d) => mo * 100 + d;
function seasonOf(seasons, dt) {
  const k = key(dt.getUTCMonth(), dt.getUTCDate());
  for (const s of seasons) {
    const a = key(...s.start); const b = key(...s.end);
    if (a <= b ? (k >= a && k <= b) : (k >= a || k <= b)) return s.name;
  }
  return null;
}
/** Per-night rates the knowledge ties to a season name (same line or sentence). */
function seasonalRates(knowledgeTexts, seasons) {
  const rates = new Set();
  const names = seasons.map((s) => s.name);
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const part of String(k || '').split(/\n|(?<=[.;])\s+/)) {
      if (/\brates?\s+apply\b|crosses/i.test(part)) continue;
      if (!names.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(part))) continue;
      for (const m of part.matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)/g)) rates.add(parseFloat(m[1].replace(/,/g, '')));
    }
  }
  return rates;
}

/** The stay the visitor described: { nights, nightDates: [Date], seasons: [name per night] } or null. */
function planStay(visitorTexts, knowledgeTexts, now, tz) {
  const seasons = findSeasons(knowledgeTexts);
  if (!seasons.length) return null;
  const texts = [...(Array.isArray(visitorTexts) ? visitorTexts : [])].reverse();
  let nights = null; let startDays = null;
  for (const t of texts) {
    const ds = parseDates(t, now, tz).filter((d) => d.days >= 0);
    const nm = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)[- ]nights?\b/i.exec(t);
    const nn = nm ? (/^\d/.test(nm[1]) ? Number(nm[1]) : NUM_WORDS[nm[1].toLowerCase()]) : null;
    if (ds.length >= 2 && ds[1].days > ds[0].days) { startDays = ds[0].days; nights = ds[1].days - ds[0].days; break; }
    if (ds.length >= 1 && nn) { startDays = ds[0].days; nights = nn; break; }
  }
  if (nights === null || nights < 1 || nights > 60) return null;
  const nowD = now instanceof Date ? now : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(nowD);
  const g = (x) => Number(parts.find((p) => p.type === x).value);
  const today = Date.UTC(g('year'), g('month') - 1, g('day'));
  const nightDates = []; const names = [];
  for (let i = 0; i < nights; i++) {
    const dt = new Date(today + (startDays + i) * DAY_MS);
    nightDates.push(dt); names.push(seasonOf(seasons, dt));
  }
  const spans = new Set(names.filter(Boolean)).size > 1;
  const label = (dt) => `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()][0].toUpperCase()}${MONTHS[dt.getUTCMonth()].slice(1, 3)}`;
  const counts = {};
  names.forEach((n) => { if (n) counts[n] = (counts[n] || 0) + 1; });
  const fact = spans
    ? `The stay is ${nights} night${nights === 1 ? '' : 's'}, and it crosses a rate change: ${nightDates.map((d, i) => `night of ${label(d)} is ${names[i]}`).join('; ')}. That is ${Object.entries(counts).map(([n, c]) => `${c} night${c === 1 ? '' : 's'} at ${n} rates`).join(' and ')}. Charge night by night at each night's own rate; never multiply one rate by ${nights}.`
    : null;
  return { nights, names, spans, fact, seasons, rates: seasonalRates(knowledgeTexts, seasons) };
}

const PRODUCT_RES = [
  /([£$€]\s?\d[\d,]*(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+)(?:\s*nights?)?(?:\s*=\s*[£$€]\s?\d[\d,]*(?:\.\d+)?)?/gi,
  /\b(\d+)\s*nights?\s*(?:at|x|×|@)\s*([£$€]\s?\d[\d,]*(?:\.\d+)?)(?:\s*(?:per night|a night|each))?(?:\s*=\s*[£$€]\s?\d[\d,]*(?:\.\d+)?)?/gi,
  /([£$€]\s?\d[\d,]*(?:\.\d+)?)\s*(?:per night|a night|\/night)?\s*for\s+(\d+)\s*nights?/gi,
];
/** Strings in the reply that multiply one seasonal rate by the whole spanning stay. */
function spanningProducts(reply, plan) {
  if (!plan || !plan.spans) return [];
  const out = [];
  PRODUCT_RES.forEach((re, i) => {
    re.lastIndex = 0;
    for (const m of String(reply || '').matchAll(re)) {
      const money = i === 1 ? m[2] : m[1];
      const n = Number(i === 1 ? m[1] : m[2]);
      const rate = parseFloat(money.replace(/[£$€,\s]/g, ''));
      if (n === plan.nights && plan.rates.has(rate)) out.push(m[0].trim());
    }
  });
  return out;
}

module.exports = { findSeasons, planStay, spanningProducts };
