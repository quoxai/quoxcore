'use strict';
/**
 * QC-BRUTALOOP-W17: a validity window ("valid for 12 months from the date of
 * purchase", "must be used within 6 months of payment") applied to a purchase
 * date the visitor stated. A model told a 1 Sep 2025 voucher "can be used
 * until 1 September 2026" and "can still use it now" on 14 Oct 2026. Expiry
 * is computed here, handed to the prompt as a fact, and a reply that
 * contradicts it is rewritten after generation.
 */
const { splitSentences } = require('./quoxchatGrounding');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, twenty: 20, thirty: 30, sixty: 60, ninety: 90 };
const NUM = '(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|thirty|sixty|ninety)';
const UNIT = '(day|week|month|year)s?';
const EVENT = '(?:purchase|issue|payment|booking|order|sale|activation|buying|being\\s+(?:bought|purchased|issued|paid\\s+for))';
const RULES = [
  new RegExp(`\\b(?:valid|good|usable|redeemable|available)\\s+for\\s+${NUM}[-\\s]${UNIT}\\s+(?:from|after|of|since)\\s+(?:the\\s+)?(?:date\\s+of\\s+)?${EVENT}`, 'i'),
  new RegExp(`\\b(?:used|redeemed|taken|claimed|spent|booked)\\s+within\\s+${NUM}[-\\s]${UNIT}\\s+(?:from|after|of)\\s+(?:the\\s+)?(?:date\\s+of\\s+)?${EVENT}`, 'i'),
  new RegExp(`\\bexpires?\\s+${NUM}[-\\s]${UNIT}\\s+(?:from|after)\\s+(?:the\\s+)?(?:date\\s+of\\s+)?${EVENT}`, 'i'),
];
const BOUGHT_RE = /\b(?:bought|purchased|paid|ordered|booked|got|received|was\s+(?:given|issued)|were\s+(?:given|issued)|issued|purchase|payment)\b/i;

const utc = (y, m, d) => Date.UTC(y, m, d);
const monthIdx = (s) => MONTHS.findIndex((mn) => mn.toLowerCase().startsWith(String(s).slice(0, 3).toLowerCase()));
const fmtShort = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`; };
const fmtLong = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

function todayMs(now, tz) {
  let zone = 'Europe/London';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); zone = tz || zone; } catch { /* default */ }
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(when);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return utc(g('year'), g('month') - 1, g('day'));
}

function findRule(knowledgeTexts) {
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const re of RULES) {
      const m = re.exec(String(k || ''));
      if (!m) continue;
      const n = /^\d/.test(m[1]) ? Number(m[1]) : WORDNUM[m[1].toLowerCase()];
      if (n > 0) return { n, unit: m[2].toLowerCase() };
    }
  }
  return null;
}

function validDate(y, mi, d) { const c = new Date(utc(y, mi, d)); return c.getUTCDate() === d && c.getUTCMonth() === mi; }

function findStart(text, today) {
  const src = String(text || '');
  const tdy = new Date(today);
  const cands = [];
  const re1 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi');
  const re2 = new RegExp(`\\b${MON}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?`, 'gi');
  for (const m of src.matchAll(re1)) cands.push({ i: m.index, d: Number(m[1]), mi: monthIdx(m[2]), y: m[3] ? Number(m[3]) : null });
  for (const m of src.matchAll(re2)) cands.push({ i: m.index, d: Number(m[2]), mi: monthIdx(m[1]), y: m[3] ? Number(m[3]) : null });
  cands.sort((a, b) => a.i - b.i);
  for (const c of cands) {
    let y = c.y;
    if (!y) {
      y = tdy.getUTCFullYear();
      if (utc(y, c.mi, c.d) > today) y -= 1; // most recent past occurrence
    }
    if (!validDate(y, c.mi, c.d)) continue;
    return utc(y, c.mi, c.d);
  }
  return null;
}

function addWindow(start, n, unit) {
  const s = new Date(start);
  if (unit === 'day') return start + n * 86400000;
  if (unit === 'week') return start + n * 7 * 86400000;
  const months = unit === 'year' ? n * 12 : n;
  const total = s.getUTCMonth() + months;
  const y = s.getUTCFullYear() + Math.floor(total / 12);
  const mi = ((total % 12) + 12) % 12;
  const last = new Date(utc(y, mi + 1, 0)).getUTCDate();
  return utc(y, mi, Math.min(s.getUTCDate(), last));
}

function planValidity(visitorTexts, knowledgeTexts, now = new Date(), tz = 'Europe/London') {
  const rule = findRule(knowledgeTexts);
  if (!rule) return null;
  const today = todayMs(now, tz);
  for (const t of Array.isArray(visitorTexts) ? visitorTexts : []) {
    if (typeof t !== 'string' || !BOUGHT_RE.test(t)) continue;
    const start = findStart(t, today);
    if (start === null || start > today) continue;
    const expiry = addWindow(start, rule.n, rule.unit);
    const expired = expiry < today;
    const span = `${rule.n} ${rule.unit}${rule.n === 1 ? '' : 's'}`;
    const status = expired ? `expired on ${fmtShort(expiry)}` : `valid until ${fmtShort(expiry)}`;
    const fact = `Validity: bought ${fmtShort(start)}, valid ${span}, ${status} (today ${fmtShort(today)}).`;
    const sentence = expired
      ? `That expired on ${fmtLong(expiry)} (${span} after ${fmtLong(start)}), so it can no longer be used.`
      : `It is valid until ${fmtLong(expiry)}.`;
    return { expired, expiry: fmtLong(expiry), start: fmtLong(start), fact, sentence };
  }
  return null;
}

const NEG_RE = /\b(?:expired|has\s+expired|no\s+longer|not\s+(?:be\s+)?(?:valid|usable|used|redeem\w*)|cannot|can't|can\s?not|isn't|invalid|lapsed|out\s+of\s+date)\b/i;
const POS_RE = /\b(?:can|could|may)\s+(?:still\s+)?(?:be\s+)?(?:use[ds]?|redeem(?:ed)?|spen[dt]|book)\b|\bstill\s+(?:valid|usable|good|redeemable|ok|okay|within)\b|\b(?:is|are|remains?)\s+(?:still\s+)?valid\b|\bvalid\s+until\b|\busable\b|\bwithin\s+(?:the|its|your)\s+(?:validity|window)\b|\bhasn't\s+expired\b|\bnot\s+(?:yet\s+)?expired\b/i;
const NEG_CLAIM_RE = /\b(?:has\s+|have\s+)?expired\b|\bno\s+longer\s+(?:be\s+)?(?:valid|usable|used)\b|\b(?:cannot|can't|can\s?not)\s+(?:be\s+)?(?:use[ds]?|redeemed)\b|\bno\s+longer\s+valid\b/i;

function enforceValidity(text, plan) {
  const src = String(text || '');
  if (!plan) return { text: src, changed: false };
  const parts = src.split('\n').map((line) => splitSentences(line));
  let changed = false; let placed = false;
  const lines = parts.map((sents) => {
    const out = [];
    for (const sn of sents) {
      const bad = plan.expired
        ? POS_RE.test(sn) && !(NEG_RE.test(sn) && !/\bnot\s+(?:yet\s+)?expired|hasn't\s+expired/i.test(sn))
        : NEG_CLAIM_RE.test(sn) && !/\bnot\s+(?:yet\s+)?expired|hasn't\s+expired/i.test(sn);
      if (bad) { changed = true; if (!placed) { out.push(plan.sentence); placed = true; } continue; }
      out.push(sn);
    }
    return out.join(' ');
  });
  if (!changed) return { text: src, changed: false };
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), changed: true };
}

module.exports = { planValidity, enforceValidity };
