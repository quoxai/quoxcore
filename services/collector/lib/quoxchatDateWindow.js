'use strict';
/**
 * Wave 13: deterministic date-window arithmetic.
 *
 * A model told "free cancellation up to 7 days before arrival" and asked about
 * an arrival on 20 October (today 14 October) said "more than 7 days before".
 * The gap is code, not prose: this module computes the day gap from the
 * visitor's date to today in the widget's timezone, hands it to the prompt as
 * a premise, and corrects a reply sentence whose stated comparison contradicts
 * the computed gap.
 */
const { splitSentences } = require('./quoxchatGrounding');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const WD_RE = '(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const DAY_MS = 86400000;

function todayYmd(now, tz) {
  let zone = 'Europe/London';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); zone = tz || zone; } catch { /* keep default */ }
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(when);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const monthIdx = (s) => MONTHS.findIndex((mn) => mn.toLowerCase().startsWith(String(s).slice(0, 3).toLowerCase()));
const fmt = (ms) => { const dt = new Date(ms); return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`; };

/** Dates named in one text: [{ label, days, index }] (days from today, may be 0). */
function parseDates(text, now, tz) {
  const src = String(text || '');
  const t = todayYmd(now, tz);
  const today = utc(t.y, t.m, t.d);
  const out = [];
  const push = (ms, index) => out.push({ label: fmt(ms), days: Math.round((ms - today) / DAY_MS), index });
  const resolve = (d, mi, yr) => {
    let ms = utc(yr || t.y, mi + 1, d);
    if (!yr && ms < today) ms = utc(t.y + 1, mi + 1, d);
    // reject impossible dates (31 February)
    const chk = new Date(ms);
    return chk.getUTCDate() === d ? ms : null;
  };
  const consumed = [];
  const free = (i) => !consumed.some(([a, b]) => i >= a && i < b);
  for (const m of src.matchAll(new RegExp(`(?:\\b${WD_RE}\\s+(?:the\\s+)?)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi'))) {
    const ms = resolve(Number(m[2]), monthIdx(m[3]), m[4] ? Number(m[4]) : null);
    if (ms !== null) { push(ms, m.index); consumed.push([m.index, m.index + m[0].length]); }
  }
  for (const m of src.matchAll(new RegExp(`(?:\\b${WD_RE}\\s+)?\\b${MONTH_RE}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?`, 'gi'))) {
    if (!free(m.index)) continue;
    const ms = resolve(Number(m[3]), monthIdx(m[2]), m[4] ? Number(m[4]) : null);
    if (ms !== null) { push(ms, m.index); consumed.push([m.index, m.index + m[0].length]); }
  }
  // "Tuesday 20th": a weekday plus a day of month, no month named.
  for (const m of src.matchAll(new RegExp(`\\b${WD_RE}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?${MONTH_RE})`, 'gi'))) {
    if (!free(m.index)) continue;
    const wd = WEEKDAYS.findIndex((w) => w.toLowerCase() === m[1].toLowerCase());
    for (let k = 0; k <= 62; k++) {
      const ms = today + k * DAY_MS; const dt = new Date(ms);
      if (dt.getUTCDate() === Number(m[2]) && dt.getUTCDay() === wd) { push(ms, m.index); break; }
    }
  }
  for (const m of src.matchAll(/\btomorrow\b/gi)) push(today + DAY_MS, m.index);
  for (const m of src.matchAll(/\bin\s+(\d{1,3})\s+(days?|weeks?)\b/gi)) push(today + Number(m[1]) * (/^w/i.test(m[2]) ? 7 : 1) * DAY_MS, m.index);
  for (const m of src.matchAll(new RegExp(`\\b(?:next|this\\s+coming|this)\\s+${WD_RE}\\b`, 'gi'))) {
    const wd = WEEKDAYS.findIndex((w) => w.toLowerCase() === m[1].toLowerCase());
    const cur = new Date(today).getUTCDay();
    let k = (wd - cur + 7) % 7; if (k === 0) k = 7;
    if (/^next\b/i.test(m[0]) && k <= 1) k += 0; // "next Friday" is the coming one
    push(today + k * DAY_MS, m.index);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** "N days/weeks/hours before" windows in knowledge: [{ n, unit, hours, sentence, rule }]. */
const WINDOW_RE = /(\d+)\s*[- ]?\s*(hours?|days?|weeks?)\s*(?:\(\s*\d+\s*hours?\s*\)\s*)?(?:or\s+more\s+)?(?:before|prior\s+to|in\s+advance|notice|ahead\s+of)/i;
function findWindows(knowledgeTexts) {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const line of String(k || '').split('\n')) {
      const sents = splitSentences(line).map((s) => s.trim()).filter(Boolean);
      sents.forEach((sn, i) => {
        const m = WINDOW_RE.exec(sn);
        if (!m) return;
        const unit = /^h/i.test(m[2]) ? 'hours' : /^w/i.test(m[2]) ? 'weeks' : 'days';
        const n = Number(m[1]);
        const hours = unit === 'hours' ? n : unit === 'weeks' ? n * 168 : n * 24;
        const key = `${n}${unit}`;
        if (seen.has(key)) return;
        seen.add(key);
        const rule = [sn, sents[i + 1]].filter(Boolean).join(' ').slice(0, 320);
        out.push({ n, unit, hours, sentence: sn, rule });
      });
    }
  }
  return out.slice(0, 4);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function gapText(label, days, todayLabel) { return `${label} is ${plural(days, 'day')} from today (${todayLabel})`; }

/** Comparison of a gap (days) against a window. cmp: 'less'|'equal'|'more'|'unsure'. */
function compare(days, w) {
  if (w.unit === 'hours') {
    const h = days * 24;
    if (Math.abs(h - w.hours) < 24) return 'unsure';
    return h < w.hours ? 'less' : 'more';
  }
  const limit = w.hours / 24;
  return days < limit ? 'less' : days === limit ? 'equal' : 'more';
}
const winName = (w) => (w.unit === 'hours' ? plural(w.n, 'hour') : w.unit === 'weeks' ? `${plural(w.n, 'week')} (${w.n * 7} days)` : plural(w.n, 'day'));

/**
 * Premise lines for the prompt: a date the visitor named, measured against each
 * "N days before" window in KNOWLEDGE. Latest visitor turn first.
 */
function dateWindowPremises(visitorTexts, knowledgeTexts, now = new Date(), tz = 'Europe/London') {
  const wins = findWindows(knowledgeTexts);
  if (!wins.length) return [];
  const t = todayYmd(now, tz);
  const todayLabel = fmt(utc(t.y, t.m, t.d));
  let dates = [];
  for (const txt of [...(Array.isArray(visitorTexts) ? visitorTexts : [])].reverse()) {
    dates = parseDates(txt, now, tz).filter((d) => d.days >= 0);
    if (dates.length) break;
  }
  const out = [];
  for (const d of dates.slice(-2)) {
    for (const w of wins.slice(0, 2)) {
      const c = compare(d.days, w);
      const base = gapText(d.label, d.days, todayLabel);
      if (c === 'unsure') out.push(`${base}, about ${d.days * 24} hours, which is within a day of the ${winName(w)} limit, so the exact time of day decides.`);
      else if (c === 'less') out.push(`${base}, which is less than ${winName(w)}.`);
      else if (c === 'equal') out.push(`${base}, which is exactly ${winName(w)}: on the limit (a rule of "up to"/"at least" ${plural(w.n, w.unit.replace(/s$/, ''))} before includes it).`);
      else out.push(`${base}, which is more than ${winName(w)}.`);
    }
  }
  return out;
}

const CLAIM_A = /\b(more\s+than|over|at\s+least|within|less\s+than|fewer\s+than|under|no\s+more\s+than)\s+(\d+)\s*[- ]?\s*(days?|weeks?|hours?)\b/gi;
const CLAIM_B = /\b(\d+)\s*[- ]?\s*(days?|weeks?|hours?)\s+or\s+(more|less|fewer)\b/gi;
const CONCLUSION_RE = /^\s*(?:therefore|so|thus|hence|this means|that means|which means|as a result|in that case)\b/i;

function claimsIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(CLAIM_A)) out.push({ op: m[1].toLowerCase().replace(/\s+/g, ' '), n: Number(m[2]), unit: m[3].toLowerCase() });
  for (const m of sentence.matchAll(CLAIM_B)) out.push({ op: m[3].toLowerCase() === 'more' ? 'at least' : 'within', n: Number(m[1]), unit: m[2].toLowerCase() });
  return out.map((c) => ({ ...c, unit: /^h/.test(c.unit) ? 'hours' : /^w/.test(c.unit) ? 'weeks' : 'days' }));
}
function claimHolds(c, days) {
  const unitDays = c.unit === 'hours' ? c.n / 24 : c.unit === 'weeks' ? c.n * 7 : c.n;
  if (c.unit === 'hours' && Math.abs(days - unitDays) < 1) return null; // unsure
  switch (c.op) {
    case 'more than': case 'over': return days > unitDays;
    case 'at least': return days >= unitDays;
    case 'within': case 'no more than': return days <= unitDays;
    default: return days < unitDays; // less than, fewer than, under
  }
}

/**
 * Correct reply sentences that state a comparison against a KNOWLEDGE window
 * that the computed day gap contradicts. Returns { text, applied, contradicted }.
 */
function applyDateWindowGuard(reply, { visitorTexts, knowledgeTexts, now = new Date(), tz = 'Europe/London' } = {}) {
  const text = String(reply || '');
  const wins = findWindows(knowledgeTexts);
  if (!text || !wins.length) return { text, applied: false, contradicted: [] };
  const t = todayYmd(now, tz);
  const todayLabel = fmt(utc(t.y, t.m, t.d));
  let visitorDate = null;
  for (const txt of [...(Array.isArray(visitorTexts) ? visitorTexts : [])].reverse()) {
    const ds = parseDates(txt, now, tz).filter((d) => d.days >= 0);
    if (ds.length) { visitorDate = ds[ds.length - 1]; break; }
  }
  const out = [];
  const contradicted = [];
  let note = null; let unsure = false; let dropConclusions = false;
  const sents = [];
  for (const line of text.split('\n')) sents.push(...splitSentences(line).map((s, i, arr) => ({ s, nl: i === arr.length - 1 })));
  for (const { s, nl } of sents) {
    const tail = nl ? '\n' : '';
    if (dropConclusions && CONCLUSION_RE.test(s)) continue;
    dropConclusions = false;
    const own = parseDates(s, now, tz).filter((d) => d.days >= 0);
    const d = own.length ? own[own.length - 1] : visitorDate;
    const claims = d ? claimsIn(s) : [];
    let bad = null; let isUnsure = false;
    for (const c of claims) {
      const w = wins.find((x) => x.unit === c.unit && x.n === c.n);
      if (!w) continue;
      const holds = claimHolds(c, d.days);
      if (holds === false) bad = { c, w, d }; else if (holds === null) isUnsure = true;
    }
    if (!bad && !isUnsure) { out.push(s + tail); continue; }
    dropConclusions = true;
    if (bad) {
      contradicted.push(s.trim().slice(0, 160));
      if (!note) {
        const cmp = compare(bad.d.days, bad.w);
        const phrase = cmp === 'less' ? `less than ${winName(bad.w)}` : cmp === 'equal' ? `exactly ${winName(bad.w)}` : cmp === 'more' ? `more than ${winName(bad.w)}` : `within a day of ${winName(bad.w)}`;
        note = `${gapText(bad.d.label, bad.d.days, todayLabel)}, which is ${phrase}. Our terms say: "${bad.w.rule}"`;
      }
    } else unsure = true;
  }
  if (!contradicted.length && !unsure) return { text, applied: false, contradicted: [] };
  let result = out.join('').replace(/[ \t]+\n/g, '\n').trim();
  const add = note || '';
  result = [result, add, !note && unsure ? 'Please check the dates with us.' : ''].filter(Boolean).join(' ').replace(/\n /g, '\n').trim();
  return { text: result, applied: true, contradicted, unsure: unsure && !note };
}

module.exports = { parseDates, findWindows, dateWindowPremises, applyDateWindowGuard };
