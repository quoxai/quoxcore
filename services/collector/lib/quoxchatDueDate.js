'use strict';
/**
 * QC-BRUTALOOP-W18 (Fix 5, quoxchatDueDate): relative deadlines and day-count bands, computed.
 * "The balance is due 8 weeks before the event" + a wedding on 12 Dec 2026 ->
 * 17 Oct 2026. The bot said "59 days from today ... 7 October 2026". The date
 * is computed here, handed to the prompt as a premise, and a reply sentence
 * stating a different date for that deadline is rewritten. Tiered rules
 * ("More than 180 days before / 90 to 180 days / Fewer than 90 days") get the
 * band for the visitor's event date as a premise.
 */
const { splitSentences } = require('./quoxchatGrounding');
const { parseDates } = require('./quoxchatDateWindow');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 86400000;
const WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = '(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const num = (s) => (WORDNUM[String(s).toLowerCase()] || Number(s));
const short = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`; };
const long = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

function todayOf(now, tz) {
  let zone = 'Europe/London';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); zone = tz || zone; } catch { /* default */ }
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now instanceof Date ? now : new Date());
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'));
}

/** The visitor's event date (latest turn first): { ms, days } or null. */
function eventDate(visitorTexts, now, tz) {
  const today = todayOf(now, tz);
  for (const txt of [...(Array.isArray(visitorTexts) ? visitorTexts : [])].reverse()) {
    const ds = parseDates(txt, now, tz).filter((d) => d.days >= 0);
    if (ds.length) { const d = ds[ds.length - 1]; return { ms: today + d.days * DAY_MS, days: d.days, today }; }
  }
  return null;
}

const DUE_RE = new RegExp(`\\b(?:due|payable|must\\s+be\\s+paid|to\\s+be\\s+paid|needed|required|owed|settled)\\b[^.!?\\n]{0,40}?\\b${NUM}[-\\s](day|week|month)s?\\s+(?:before|prior\\s+to|ahead\\s+of)\\s+(?:the\\s+|your\\s+|our\\s+)?([a-z][a-z -]{2,30}?)(?=[\\s.,;:!?]|$)`, 'i');
/** [{ subject, n, unit, anchor, sentence }] */
function deadlineRules(knowledgeTexts) {
  const out = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const line of String(k || '').split('\n')) {
      for (const sn of splitSentences(line).map((s) => s.trim()).filter(Boolean)) {
        const m = DUE_RE.exec(sn);
        if (!m) continue;
        const head = sn.slice(0, m.index).replace(/^\W+/, '').replace(/^(?:the|your|our)\s+/i, '').replace(/\s+(?:is|are|must|should|will|needs?\s+to)\s*(?:be\s*)?$/i, '').trim();
        const subject = head && head.length <= 40 ? head : 'payment';
        out.push({ subject, n: num(m[1]), unit: m[2].toLowerCase(), anchor: m[3].trim(), sentence: sn });
      }
    }
  }
  return out.slice(0, 3);
}
function minus(ms, n, unit) {
  const d = new Date(ms);
  if (unit === 'month') {
    const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.getTime();
  }
  return ms - n * (unit === 'week' ? 7 : 1) * DAY_MS;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const away = (days) => (days > 0 ? `${plural(days, 'day')} from today` : days === 0 ? 'today' : `${plural(-days, 'day')} ago`);

/** Computed deadline plans: [{ subject, date, days, premise, sentence }] */
function deadlinePlans(visitorTexts, knowledgeTexts, now = new Date(), tz = 'Europe/London') {
  const rules = deadlineRules(knowledgeTexts);
  if (!rules.length) return [];
  const ev = eventDate(visitorTexts, now, tz);
  if (!ev) return [];
  return rules.map((r) => {
    const ms = minus(ev.ms, r.n, r.unit);
    const days = Math.round((ms - ev.today) / DAY_MS);
    const rel = `${plural(r.n, r.unit)} before ${short(ev.ms)}`;
    const premise = `${cap(r.subject)} due date: ${rel} = ${short(ms)} (${away(days)}, ${short(ev.today)}). State this date and no other for it.${days < 0 ? ' It has already passed.' : ''}`;
    const sentence = `The ${r.subject} is due on ${long(ms)} (${rel.replace(short(ev.ms), long(ev.ms))}).`;
    return { subject: r.subject, ms, days, ev, premise, sentence, words: r.subject.toLowerCase().split(/\s+/).filter((w) => w.length > 3) };
  });
}
const deadlinePremises = (...a) => deadlinePlans(...a).map((p) => p.premise);

/** Rewrites a reply sentence that states a different date (or day count) for a computed deadline. */
function enforceDeadline(text, plans, { now = new Date(), tz = 'Europe/London' } = {}) {
  const src = String(text || '');
  if (!plans || !plans.length || !src) return { text: src, changed: false };
  const today = todayOf(now, tz);
  let changed = false;
  const done = new Set();
  const outLines = src.split('\n').map((line) => splitSentences(line).map((s) => {
    for (const p of plans) {
      const related = p.words.some((w) => new RegExp(`\\b${w}`, 'i').test(s)) || (!p.words.length && /\b(pay|payment|due)\b/i.test(s));
      if (!related) continue;
      const ds = parseDates(s, now, tz).map((d) => today + d.days * DAY_MS).filter((ms) => ms !== p.ev.ms);
      const dayClaims = [...s.matchAll(/\b(\d{1,3})\s+days?\s+(?:from\s+today|from\s+now|away|to\s+go)\b/gi)].map((m) => Number(m[1]));
      const wrongDate = ds.length > 0 && !ds.includes(p.ms);
      const wrongDays = dayClaims.length > 0 && !dayClaims.includes(p.days);
      if (wrongDate || wrongDays) {
        changed = true;
        if (done.has(p.subject)) return '';
        done.add(p.subject);
        return p.sentence;
      }
    }
    return s;
  }).filter((x) => x !== '').join(' '));
  return { text: changed ? outLines.join('\n') : src, changed };
}

// ---- tiered day-count bands ----------------------------------------------
const BANDS = [
  { re: /\b(\d{1,4})\s*(?:to|-|–|and)\s*(\d{1,4})\s+days?\b/i, make: (m) => ({ lo: Number(m[1]), hi: Number(m[2]), label: `${m[1]} to ${m[2]} days`, test: (d) => d >= Number(m[1]) && d <= Number(m[2]) }) },
  { re: /\b(?:more\s+than|over|beyond)\s+(\d{1,4})\s+days?\b/i, make: (m) => ({ label: `more than ${m[1]} days`, test: (d) => d > Number(m[1]) }) },
  { re: /\b(?:at\s+least)\s+(\d{1,4})\s+days?\b/i, make: (m) => ({ label: `at least ${m[1]} days`, test: (d) => d >= Number(m[1]) }) },
  { re: /\b(?:fewer\s+than|less\s+than|under)\s+(\d{1,4})\s+days?\b/i, make: (m) => ({ label: `fewer than ${m[1]} days`, test: (d) => d < Number(m[1]) }) },
];
function bandRules(knowledgeTexts) {
  const out = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const raw of String(k || '').split('\n')) {
      for (const sn of splitSentences(raw).map((s) => s.trim()).filter(Boolean)) {
        if (!/\bbefore\b|\bprior\b|\bnotice\b/i.test(sn)) continue;
        for (const b of BANDS) {
          const m = b.re.exec(sn);
          if (!m) continue;
          const band = b.make(m);
          const rest = sn.slice(m.index + m[0].length).replace(/^\s*(?:before|prior to)?\s*(?:the\s+|your\s+)?(?:event|wedding|arrival|start|date)?\s*[:\-–,]?\s*/i, '').replace(/[.]+$/, '').trim();
          out.push({ ...band, rule: rest });
          break;
        }
      }
    }
  }
  return out;
}
function ruleBrief(rule) {
  const pct = /(\d{1,3})\s*%/.exec(rule);
  if (pct && /\bpay\b/i.test(rule)) return `pay ${pct[1]}%`;
  return rule.length > 90 ? `${rule.slice(0, 90).trim()}...` : rule;
}
/** "Event 20 Mar 2027 is 157 days away: the 90 to 180 days band applies (pay 50%)." */
function bandPremises(visitorTexts, knowledgeTexts, now = new Date(), tz = 'Europe/London') {
  const rules = bandRules(knowledgeTexts);
  if (rules.length < 2) return [];
  const ev = eventDate(visitorTexts, now, tz);
  if (!ev) return [];
  // Range bands first so a boundary day (180) lands in the range, not "more than 180".
  const hit = rules.filter((r) => r.lo !== undefined).find((r) => r.test(ev.days)) || rules.find((r) => r.test(ev.days));
  if (!hit) return [];
  return [`Event ${short(ev.ms)} is ${plural(ev.days, 'day')} away: the ${hit.label} band applies${hit.rule ? ` (${ruleBrief(hit.rule)})` : ''}. Quote only this band for the visitor.`];
}

module.exports = { deadlineRules, deadlinePlans, deadlinePremises, enforceDeadline, bandRules, bandPremises };
