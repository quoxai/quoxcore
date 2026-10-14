'use strict';
/**
 * QUOXCHAT-BRUTALOOP wave 8: deterministic calendar, weekday correction and
 * allergy / medical safety guard. Domain neutral; no model call.
 */
const SENTENCE_RE = /(?:[^.!?]|[.!?]+(?=\S))+[.!?]*\s*/g;
function splitSentences(line) { return String(line || '').match(SENTENCE_RE) || [String(line || '')]; }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function validZone(tz, fallback = 'UTC') {
  if (typeof tz !== 'string' || !tz) return fallback;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return fallback; }
}

// Y/M/D of an instant as seen in a zone.
function ymdInZone(now, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function weekdayOf(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

/** Widget timezone from office_hours_json (string or object); UTC when none. */
function widgetTimezone(meta) {
  let oh = meta && meta.office_hours_json;
  if (typeof oh === 'string') { try { oh = JSON.parse(oh); } catch { oh = null; } }
  // Wave 12: no configured zone means a UK business until told otherwise;
  // never silently UTC (a 23:17 BST visitor was told the practice was open).
  return validZone(oh && oh.timezone, 'Europe/London');
}

/** Local weekday and clock time of an instant in a zone. */
function localClock(now = new Date(), tz = 'Europe/London') {
  const zone = validZone(tz);
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(when);
  const hh = Number(parts.find((p) => p.type === 'hour').value);
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  const { y, m, d } = ymdInZone(when, zone);
  return { zone, weekday: WEEKDAYS[weekdayOf(y, m, d)], dow: weekdayOf(y, m, d), minutes: hh * 60 + mm, hhmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

function calendarFacts(now = new Date(), tz = 'UTC', days = 21) {
  const zone = validZone(tz);
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const { y, m, d } = ymdInZone(when, zone);
  const todayStr = `${WEEKDAYS[weekdayOf(y, m, d)]} ${d} ${MONTHS[m - 1]} ${y}`;
  const list = [];
  for (let i = 1; i <= days; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    list.push(`${WEEKDAYS[dt.getUTCDay()].slice(0, 3)} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].slice(0, 3)}`);
  }
  return { zone, todayStr, calendar: list.join(', '), year: y };
}

const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const WD_RE = '(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const DATE_A = `(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?`; // 12 October 2026
const DATE_B = `${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`; // October 12
const LINK = '(?:\\s*\\(UTC\\))?,?\\s*(?:which\\s+)?(?:(?:is|was|falls\\s+on|fell\\s+on|will\\s+be)\\s+(?:on\\s+)?an?|,?\\s*an?|is|was)\\s+';

function monthIdx(s) { return MONTHS.findIndex((mn) => mn.toLowerCase().startsWith(s.slice(0, 3).toLowerCase())); }

/**
 * Correct a wrong weekday stated next to a date. Returns { text, corrected }.
 * Year comes from the text, else the current year in the zone.
 */
function correctWeekdays(text, now = new Date(), tz = 'UTC') {
  const src = String(text || '');
  const { year } = calendarFacts(now, tz, 0);
  const corrected = [];
  const fix = (day, mon, yr, wd) => {
    const mi = monthIdx(mon);
    if (mi < 0) return null;
    const real = WEEKDAYS[weekdayOf(yr ? Number(yr) : year, mi + 1, Number(day))];
    if (real.toLowerCase() === wd.toLowerCase()) return null;
    corrected.push({ date: `${day} ${MONTHS[mi]}`, said: wd, actual: real });
    return real;
  };
  let out = src.replace(new RegExp(`${DATE_A}${LINK}${WD_RE}\\b`, 'gi'), (all, d, mo, yr, wd) => {
    const real = fix(d, mo, yr, wd);
    return real ? all.slice(0, all.length - wd.length) + real : all;
  });
  out = out.replace(new RegExp(`${DATE_B}${LINK}${WD_RE}\\b`, 'gi'), (all, mo, d, yr, wd) => {
    const real = fix(d, mo, yr, wd);
    return real ? all.slice(0, all.length - wd.length) + real : all;
  });
  // "Tuesday 12 October" / "Tuesday, October 12"
  out = out.replace(new RegExp(`\\b${WD_RE},?\\s+${DATE_A}`, 'gi'), (all, wd, d, mo, yr) => {
    const real = fix(d, mo, yr, wd);
    return real ? real + all.slice(wd.length) : all;
  });
  out = out.replace(new RegExp(`\\b${WD_RE},?\\s+${DATE_B}`, 'gi'), (all, wd, mo, d, yr) => {
    const real = fix(d, mo, yr, wd);
    return real ? real + all.slice(wd.length) : all;
  });
  return { text: out, corrected };
}

const ALLERGY_CTX_RE = /\ballerg(?:y|ies|ic|en|ens)\b|intoleran|\bcoeliac|\bceliac|anaphyla|epi-?pen/i;
const UNSAFE_RE = new RegExp([
  // Any affirmative "safe" or "suitable" on an allergy turn (wave 8 live proof:
  // "would be a safe starter option for you" passed the narrower patterns).
  // "not safe" / "isn't suitable" warnings are kept.
  "(?<!\\bnot\\s)(?<!n't\\s)(?<!\\bnever\\s)\\b(?:safe|safer|safely|suitable)\\b",
  "\\b(?:does\\s+not|doesn't|do\\s+not|don't)\\s+(?:list|mention|show)\\b",
  '\\bshould\\s+be\\s+(?:fine|ok|okay|alright)\\b',
  '\\b(?:\\w+-)free\\b',
  '\\bfree\\s+from\\b',
  "\\b(?:does\\s+not|doesn't|do\\s+not|don't|will\\s+not|won't|wouldn't)\\s+(?:contain|include|have)\\b",
  '\\bno\\s+risk\\b',
  '\\byou\\s+can\\s+(?:safely\\s+)?eat\\b',
  '\\ballergy[- ]friendly\\b',
].join('|'), 'i');

const ALLERGY_FALLBACK = "I can't confirm that any item is safe for an allergy. Please speak to the team directly before ordering.";

function allergyContext(visitorTexts) {
  return (Array.isArray(visitorTexts) ? visitorTexts : []).some((t) => typeof t === 'string' && ALLERGY_CTX_RE.test(t));
}

function sentenceAssertsSafety(s) { return UNSAFE_RE.test(String(s || '')); }

const NO_GUARANTEE_RE = /\b(?:cannot|can't|can not|unable to|do not|don't)\s+guarantee\b|\btraces?\b/i;

// The business's own allergy wording: the first sentence that mentions
// allergies plus any "cannot guarantee / traces" warning, markdown headings
// stripped (wave 8 live proof quoted "## Allergies Tell your server...").
function allergyGuidance(knowledgeTexts) {
  const picked = [];
  for (const k of knowledgeTexts || []) {
    const clean = String(k || '').replace(/^\s{0,3}#{1,6}\s+[^\n]*$/gm, ' ').replace(/\n+/g, ' ');
    for (const sn of splitSentences(clean)) {
      const t = sn.trim();
      if (!t || picked.includes(t)) continue;
      const warns = NO_GUARANTEE_RE.test(t);
      if ((ALLERGY_CTX_RE.test(t) || warns) && (warns || !sentenceAssertsSafety(t))) picked.push(t);
      if (picked.length >= 2) break;
    }
    if (picked.length >= 2) break;
  }
  return picked.length ? picked.join(' ').slice(0, 500) : null;
}

/** Remove safety / absence assertions when the visitor raised an allergy. */
function applyAllergyGuard(text, { visitorTexts = [], knowledgeTexts = [] } = {}) {
  const src = String(text || '');
  if (!src || !allergyContext(visitorTexts)) return { text: src, removed: [], guard: false };
  const removed = [];
  const lines = src.split('\n').map((line) => {
    const kept = splitSentences(line).filter((sn) => {
      if (sentenceAssertsSafety(sn)) { removed.push(sn.trim()); return false; }
      return true;
    });
    return kept.join('').replace(/[ \t]+$/, '');
  });
  if (removed.length === 0) return { text: src, removed, guard: false };
  const guidance = allergyGuidance(knowledgeTexts);
  const note = guidance ? `Please note: "${guidance.replace(/^["']|["']$/g, '')}"` : ALLERGY_FALLBACK;
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: body ? `${body}\n\n${note}` : note, removed, guard: true, source: guidance ? 'knowledge' : 'fallback' };
}

// Wave 12: emergency completeness. When the visitor describes an urgent-harm
// situation and knowledge carries an emergency / out-of-hours line with a phone
// number, the reply must carry that number. Number taken verbatim from knowledge.
const EMERGENCY_CTX_RE = new RegExp([
  '\\b(?:poison(?:ed|ing|ous)?|toxic)\\b',
  '\\b(?:ate|eaten|eating|swallowed|ingested)\\b[^.?!\\n]{0,40}\\b(?:chocolate|grapes?|raisins?|xylitol|rat\\s+(?:bait|poison)|slug\\s+pellets?|lil(?:y|ies)|antifreeze|paracetamol|ibuprofen|bleach)\\b',
  '\\bcollaps(?:e|ed|ing)\\b',
  "\\b(?:not|isn't|won't|stopped|can't|cannot)\\s+breathing\\b|\\bstopped\\s+breathing\\b|\\bcan(?:'|no)t\\s+breathe\\b|\\bstruggling\\s+to\\s+breathe\\b",
  '\\bseizures?\\b|\\bfitting\\b|\\bhaving\\s+a\\s+fit\\b',
  "\\bbleeding\\s+(?:heavily|badly|a\\s+lot|profusely)\\b|\\bwon'?t\\s+stop\\s+bleeding\\b",
  '\\bbloat(?:ed|ing)?\\b|\\bswollen\\s+(?:stomach|belly|abdomen)\\b',
  '\\bstraining\\s+to\\s+(?:pee|wee|urinate|toilet)\\b',
  '\\bemergenc(?:y|ies)\\b',
  '\\bout[-\\s]of[-\\s]hours\\b|\\bafter[-\\s]hours\\b',
  '\\bgas\\s+leak\\b|\\bburst\\s+pipe\\b|\\bflooding\\b|\\bcarbon\\s+monoxide\\b',
].join('|'), 'i');
const PHONE_RE = /(?:\+?\d[\d ()-]{7,}\d)/g;
const EMERGENCY_LINE_RE = /\b(?:emergenc(?:y|ies)|out[-\s]of[-\s]hours|after[-\s]hours|when\s+we\s+are\s+closed|24[\s/-]*(?:7|hour))/i;

const digitsOf = (s) => String(s || '').replace(/\D/g, '').replace(/^0044/, '0').replace(/^44(?=\d{10})/, '0');

function emergencyContext(visitorTexts) {
  return (Array.isArray(visitorTexts) ? visitorTexts : []).some((t) => typeof t === 'string' && EMERGENCY_CTX_RE.test(t));
}

// PDF chunks glue a heading onto the next sentence ("Out of hours When we are
// closed, ..."). Drop a short leading Title Case run that is followed by a
// recognisable sentence opener.
const HEADING_GLUE_RE = /^[A-Z][A-Za-z&-]*(?:\s+(?:of|and|the|for|to|&|[A-Z][A-Za-z&-]*|hours?)){0,3}\s+(?=(?:When|If|Our|We|The|Outside|After|Please|Call|In|For|During|Between)\s+\S)/;
function stripGluedHeading(t) {
  const m = HEADING_GLUE_RE.exec(t);
  return m ? t.slice(m[0].length) : t;
}

// First knowledge sentence that is an emergency/out-of-hours line AND has a phone number.
function emergencyContact(knowledgeTexts) {
  for (const k of knowledgeTexts || []) {
    const clean = String(k || '').replace(/^\s{0,3}#{1,6}\s+[^\n]*$/gm, ' ').replace(/\n+/g, ' ');
    for (const sn of splitSentences(clean.replace(/(\d)\.(\d)/g, '$1\u0000$2'))) {
      const t = stripGluedHeading(sn.replace(/\u0000/g, '.').trim());
      if (!EMERGENCY_LINE_RE.test(t)) continue;
      const nums = (t.match(PHONE_RE) || []).map((n) => n.trim()).filter((n) => digitsOf(n).length >= 8);
      if (nums.length) return { line: t.slice(0, 300), number: nums[0] };
    }
  }
  return null;
}

/** Append the knowledge's own emergency contact when an urgent turn's reply lacks the number. */
function applyEmergencyGuard(text, { visitorTexts = [], knowledgeTexts = [] } = {}) {
  const src = String(text || '');
  if (!src || !emergencyContext(visitorTexts)) return { text: src, guard: false };
  const c = emergencyContact(knowledgeTexts);
  if (!c) return { text: src, guard: false };
  if (digitsOf(src).includes(digitsOf(c.number))) return { text: src, guard: false };
  const line = c.line.replace(/[.!?\s]+$/, '');
  return { text: `${src.replace(/\s+$/, '')}\n\nFor an emergency or out of hours: ${line}.`, guard: true, number: c.number };
}

module.exports = { localClock, calendarFacts, widgetTimezone, correctWeekdays, allergyContext, sentenceAssertsSafety, applyAllergyGuard, applyEmergencyGuard, emergencyContext, ALLERGY_FALLBACK, WEEKDAYS };
