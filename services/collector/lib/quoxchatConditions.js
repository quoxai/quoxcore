'use strict';
/**
 * QC-BRUTALOOP-W18: deterministic condition checks the model got wrong.
 *  (a) grandfather / eligibility dates: "Couples who booked before 1 November
 *      2025 keep the room hire price they were quoted" + a visitor who says they
 *      booked in December 2025 -> "Booking date ... is AFTER ..., so the old
 *      price does NOT apply" (premise), and a reply asserting the opposite is
 *      rewritten.
 *  (b) capacity: "up to 120 seated" for a named room + a visitor's 130 seated.
 */
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthIdx = (s) => MONTHS.findIndex((m) => m.toLowerCase().startsWith(String(s).slice(0, 3).toLowerCase()));
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

/** First date in a text: { date: Date, partial } (partial = month and year only). */
function parseDate(text) {
  const s = String(text || '');
  let m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b\\.?,?\\s+(\\d{4})\\b`, 'i').exec(s);
  if (m) return { date: new Date(Date.UTC(Number(m[3]), monthIdx(m[2]), Number(m[1]))), partial: false, index: m.index, len: m[0].length };
  m = new RegExp(`\\b${MONTH_RE}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i').exec(s);
  if (m) return { date: new Date(Date.UTC(Number(m[3]), monthIdx(m[1]), Number(m[2]))), partial: false, index: m.index, len: m[0].length };
  m = new RegExp(`\\b${MONTH_RE}\\b\\.?,?\\s+(\\d{4})\\b`, 'i').exec(s);
  if (m) return { date: new Date(Date.UTC(Number(m[2]), monthIdx(m[1]), 1)), partial: true, index: m.index, len: m[0].length };
  return null;
}

const GF_RE = new RegExp(`([^.!?\\n]*?)\\b(?:who\\s+)?(booked|bought|joined|signed\\s+up|reserved|ordered|enrolled)\\s+(?:on or\\s+)?before\\s+((?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?)?${MONTH_RE}\\.?,?\\s+(?:\\d{1,2},?\\s+)?\\d{4})\\s*,?\\s*(keep|keeps|get|gets|retain|retains|pay|receive|receives|stay on|are charged|remain on)\\s+([^.!?\\n]*)`, 'i');

/** Grandfather rules: [{ before: Date, verb, obj, sentence }]. */
function grandfatherRules(text) {
  const out = [];
  for (const s of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const m = GF_RE.exec(s);
    if (!m) continue;
    const d = parseDate(m[3]);
    if (!d) continue;
    let obj = m[6].replace(/\b(?:whatever|regardless|irrespective|no matter)\b.*$/i, '').replace(/\s+(?:they|you|that|which)\b.*$/i, '').replace(/[,;]\s*$/, '').replace(/^(?:the|their|your)\s+/i, '').trim();
    if (!obj) continue;
    out.push({ before: d.date, verb: m[5], obj, booked: m[2], sentence: s.trim() });
  }
  return out;
}

const PAST_BOOK = /\b(?:we|i|they|have|had|already|just)\s+(?:\w+\s+){0,2}?(booked|reserved|signed\s+up|joined|bought|ordered|enrolled|paid\s+(?:our|my|the)\s+deposit)|\b(?:booking|reservation)\s+(?:was|were)\s+made|\bour\s+booking\s+(?:is|was)\s+from|\bmade\s+(?:our|my|the)\s+booking\b|\bbooked\s+(?:on|in|back\s+in)\b/i;
/** The visitor's stated booking date: { start, end, label } or null (day-less dates span the month). */
function bookingDateFrom(texts) {
  for (const t of Array.isArray(texts) ? texts : []) {
    for (const s of String(t || '').split(/(?<=[.!?])\s+|\n+/)) {
      if (!PAST_BOOK.test(s)) continue;
      const m = new RegExp(`(?:\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?)?\\b${MONTH_RE}\\b\\.?,?\\s+(\\d{4})\\b`, 'i').exec(s);
      if (!m) continue;
      const mon = monthIdx(m[2]); const yr = Number(m[3]);
      if (m[1]) { const ms = Date.UTC(yr, mon, Number(m[1])); return { start: ms, end: ms, label: fmtDate(ms) }; }
      return { start: Date.UTC(yr, mon, 1), end: Date.UTC(yr, mon + 1, 0), label: `${MONTHS[mon]} ${yr}` };
    }
  }
  return null;
}

/** [{ rule, side:'before'|'after', premise, sentence }] for each rule the visitor's booking date decides. */
function eligibilityChecks(visitorTexts, knowledgeTexts) {
  const bd = bookingDateFrom(visitorTexts);
  if (!bd) return [];
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const r of grandfatherRules(k)) {
      const key = `${r.before.getTime()}|${r.obj}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cut = r.before.getTime();
      let side;
      if (bd.end < cut) side = 'before'; else if (bd.start >= cut) side = 'after'; else continue;
      const old = /\b(?:price|rate|fee|tariff|charge)\b/i.test(r.obj) ? `the old ${r.obj}` : `the ${r.obj}`;
      const cutTxt = fmtDate(cut);
      const premise = side === 'after'
        ? `Booking date ${bd.label} is AFTER ${cutTxt}, so ${old} does NOT apply (only those who booked before ${cutTxt} ${r.verb.replace(/s$/, '')} it). Do not tell this visitor they keep it.`
        : `Booking date ${bd.label} is BEFORE ${cutTxt}, so this visitor DOES ${r.verb.replace(/s$/, '')} ${old.replace(/^the old /, 'the ')} (${r.sentence.replace(/\s+/g, ' ').trim()}).`;
      const sentence = side === 'after'
        ? `Because you booked in ${bd.label}, which is after ${cutTxt}, ${old} does not apply to you.`
        : `Because you booked in ${bd.label}, before ${cutTxt}, you ${r.verb.replace(/s$/, '')} ${old.replace(/^the old /, 'the ')}.`;
      out.push({ rule: r, side, premise, sentence, bd });
    }
  }
  return out;
}

const NEG = /\b(?:not|n't|no longer|never|cannot|can't|isn't|aren't|doesn't|don't|won't)\b/i;
const KEEP = /\b(?:keep|keeps|kept|retain|retains|still (?:pay|get|qualif\w*)|locked in|grandfather\w*|honou?r\w*|original (?:quoted )?price|old (?:room hire )?prices?|price you were quoted|quoted price)\b/i;
const NEWP = /\b(?:new|increased|updated|higher)\s+(?:room hire\s+)?(?:prices?|rates?)\s+(?:applies|apply)\b/i;
const sentSplit = (t) => String(t || '').split(/(?<=[.!?])(\s+)/);

/** Rewrites reply sentences that assert the opposite of the computed eligibility (or "booked AFTER <cutoff> keep"). */
function enforceEligibility(text, checks, knowledgeTexts) {
  const src = String(text || '');
  const parts = sentSplit(src);
  let changed = false;
  const rules = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) rules.push(...grandfatherRules(k));
  const fixed = parts.map((p) => {
    if (!p.trim()) return p;
    for (const c of checks) {
      const objHit = c.rule.obj.split(/\s+/).filter((w) => w.length > 3).some((w) => new RegExp(`\\b${w}`, 'i').test(p)) || /\bprice\b/i.test(p);
      if (!objHit) continue;
      if (c.side === 'after' && ((KEEP.test(p) && !NEG.test(p)) || (NEWP.test(p) && /\bnot\b/i.test(p)))) { changed = true; return c.sentence; }
      if (c.side === 'before' && ((KEEP.test(p) && NEG.test(p)) || NEWP.test(p))) { changed = true; return c.sentence; }
    }
    // Generic: "couples who booked AFTER <cutoff> keep ..." contradicts the rule, whoever asked.
    for (const r of rules) {
      const cut = fmtDate(r.before.getTime());
      const re = new RegExp(`\\b(?:booked|bought|joined|signed up|reserved)\\s+(?:on or\\s+)?after\\s+(?:${cut.replace(/^(\d+)\s+(\w+)\s+(\d+)$/, (_, d, mo, y) => `0?${d}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mo.slice(0, 3)}\\w*\\.?,?\\s+${y}`)})`, 'i');
      if (re.test(p) && KEEP.test(p) && !NEG.test(p)) { changed = true; return `${r.sentence.replace(/\s+/g, ' ').trim()}`; }
    }
    return p;
  });
  return { text: changed ? fixed.join('') : src, changed };
}

// ---- (b) capacity ---------------------------------------------------------
const CAP_UNIT = '(seated|standing|seats|guests|people|persons|delegates)';
/** [{ room, last, mode, n }] capacities per named room. */
function capacityRules(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+|(?<=[.!?])\s+/)) {
    const hm = /^\W*(?:the\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})\s*(?::|-|–|\b(?:seats|holds|accommodates|sleeps|has\s+a\s+(?:maximum\s+)?capacity\s+of|can\s+(?:seat|hold|take)|takes))/.exec(line);
    if (!hm) continue;
    const room = hm[1].trim().replace(/^The\s+/, '');
    const rest = line.slice(hm[0].length);
    const caps = [];
    for (const m of rest.matchAll(new RegExp(`(?:up\\s+to\\s+|maximum(?:\\s+of)?\\s+|max\\.?\\s+|capacity\\s+of\\s+)?(\\d{1,4})\\s*${CAP_UNIT}`, 'gi'))) {
      if (!/up\s+to|maximum|max|capacity/i.test(m[0]) && !/^(seated|standing)$/i.test(m[2])) continue;
      const u = m[2].toLowerCase();
      caps.push({ room, last: room.split(/\s+/).pop().toLowerCase(), mode: u === 'seated' || u === 'standing' ? u : 'any', n: Number(m[1]) });
    }
    out.push(...caps);
  }
  return out;
}

function capacityPremises(visitorTexts, knowledgeTexts) {
  const rules = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) rules.push(...capacityRules(k));
  if (!rules.length) return [];
  const out = []; const seen = new Set();
  for (const t of Array.isArray(visitorTexts) ? visitorTexts : []) {
    for (const s of String(t || '').split(/(?<=[.!?])\s+|\n+/)) {
      const low = s.toLowerCase();
      for (const room of new Set(rules.map((r) => r.last))) {
        if (!new RegExp(`\\b${room}\\b`).test(low)) continue;
        const caps = rules.filter((r) => r.last === room);
        const name = caps[0].room;
        for (const m of s.matchAll(new RegExp(`(?<![£$€\\d.,])\\b(\\d{1,4})\\s*(?:${CAP_UNIT}|of us|adults|diners)?\\b(?!\\s*(?:%|st|nd|rd|th|${MONTH_RE.slice(1, -1)}|pm|am))`, 'gi'))) {
          const n = Number(m[1]);
          if (n < 10 || (n >= 1990 && n <= 2100)) continue;
          const u = (m[2] || '').toLowerCase();
          const mode = u === 'seated' || u === 'standing' ? u : 'any';
          let relevant;
          if (mode === 'any') {
            const sitting = /\b(?:sit[- ]?down|seated|dinner|breakfast|banquet)\b/i.test(s);
            relevant = caps.filter((c) => (sitting ? c.mode === 'seated' : false));
            if (!relevant.length && caps.length && n > Math.max(...caps.map((c) => c.n))) relevant = caps;
          } else relevant = caps.filter((c) => c.mode === mode || c.mode === 'any');
          if (!relevant.length) continue;
          const cap = relevant.reduce((a, b) => (b.n > a.n ? b : a));
          const key = `${room}|${mode}|${n}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const lbl = mode === 'any' ? (cap.mode === 'any' ? '' : ` ${cap.mode}`) : ` ${mode}`;
          out.push(n > cap.n
            ? `${n}${lbl} exceeds the ${name}'s ${cap.n}${cap.mode === 'any' ? '' : ` ${cap.mode}`} capacity (the limit is ${cap.n}). Do not say it fits; offer a larger space or a smaller guest list if KNOWLEDGE gives one.`
            : `${n}${lbl} is within the ${name}'s ${cap.n}${cap.mode === 'any' ? '' : ` ${cap.mode}`} capacity.`);
        }
      }
    }
  }
  return out;
}

module.exports = { MONTH_RE, monthIdx, parseDate, fmtDate, grandfatherRules, bookingDateFrom, eligibilityChecks, enforceEligibility, capacityRules, capacityPremises };
