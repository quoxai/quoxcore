'use strict';
/**
 * QC-BRUTALOOP-W18: a dated price-change NOTICE modifies figures listed in OTHER
 * sources. "From 1 January 2026, all room hire prices rise by 10% for events on
 * or after that date" does not edit room-hire-prices.txt, so the bot quoted the
 * undated list as "the current pricing" and the verifier stripped the correct
 * computed figure. This module finds the notice, links it to the category lines
 * in sibling chunks, and (for a question with no event date, or an event on or
 * after the effective date) returns:
 *   - the category lines split out of their chunk and marked history (not support),
 *   - a synthetic chunk carrying the computed current figures (supported verbatim),
 *   - a premise stating them.
 * Events before the effective date keep the listed figures (no change).
 */
const { MONTH_RE, monthIdx, parseDate, fmtDate, grandfatherRules } = require('./quoxchatConditions');
const { HISTORY_MARK } = require('./quoxchatVersionArbiter');

const STOP = new Set(['all', 'the', 'a', 'an', 'our', 'your', 'and', 'of', 'are', 'is', 'unchanged', 'price', 'prices', 'fee', 'fees', 'rate', 'rates', 'per', 'for', 'will', 'remain', 'stay', 'same', 'not', 'change', 'changed']);
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
const VERB = '(rise|rises|increase|increases|go(?:es)? up|fall|falls|decrease|decreases|drop|drops)';
const NOTICE_RE = new RegExp(`(?:^|[\\s,])(?:all\\s+)?([a-z][a-z \\-]{2,40}?)\\s+(?:prices?|rates?|fees?|charges?)\\s+${VERB}\\s+by\\s+(\\d+(?:\\.\\d+)?)\\s*%`, 'i');
const TO_RE = new RegExp(`(?:^|[\\s,])(?:the\\s+)?([a-z][a-z \\-]{2,40}?)\\s+(?:prices?|rates?|fees?)\\s+(?:rises?|changes?|increases?|goes?\\s+up|falls?)\\s+to\\s+£\\s?(\\d[\\d,]*(?:\\.\\d+)?)`, 'i');

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}
const down = (v) => /^(fall|decrease|drop)/i.test(v);

/** Notices in the retrieved chunks: [{ cat, catWords, pct, to, effective, basis, exclusions:Set, grandfather, source, sentence }] */
function parseNotices(chunks) {
  const out = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (!c || typeof c.text !== 'string') continue;
    const sents = sentencesOf(c.text);
    const exclusions = new Set();
    for (const s of sents) {
      if (/\b(?:are|is|remain|stay)\s+(?:all\s+)?(?:unchanged|the same|unaffected)\b/i.test(s) || /\bunchanged\b/i.test(s)) {
        for (const w of words(s.replace(/\b(?:unchanged|unaffected)\b/ig, ''))) if (!STOP.has(w)) exclusions.add(w);
      }
    }
    const gf = grandfatherRules(c.text);
    for (const s of sents) {
      let m = NOTICE_RE.exec(s);
      let to = null; let pct = null; let cat; let verb;
      if (m) { cat = m[1]; verb = m[2]; pct = parseFloat(m[3]); } else {
        m = TO_RE.exec(s);
        if (!m) continue;
        cat = m[1]; to = parseFloat(m[2].replace(/,/g, ''));
      }
      cat = cat.replace(/^(?:from\b.*?,\s*)/i, '').replace(/^(?:all|the|our)\s+/i, '').replace(/^(?:from\s+[^,]*,\s*)/i, '').trim();
      const d = parseDate(s);
      if (!d || d.partial) continue;
      const basis = /\bfor\s+(?:new\s+)?(?:bookings?|reservations?)\b|\bbookings?\s+(?:made|taken)\b|\bbooked\s+on or after\b/i.test(s) ? 'booking' : 'event';
      const catWords = words(cat).filter((w) => !STOP.has(w));
      if (!catWords.length) continue;
      out.push({ cat, catWords, pct: pct === null ? null : (verb && down(verb) ? -pct : pct), to, effective: d.date, basis, exclusions, grandfather: gf[0] || null, source: c.source, sentence: s });
    }
  }
  return out;
}

const money = (n) => {
  const r = Math.round(n * 100) / 100;
  return `£${Number.isInteger(r) ? r.toLocaleString('en-GB') : r.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const MONEY_G = /£\s?(\d[\d,]*(?:\.\d+)?)/g;
const amountsIn = (line) => [...line.matchAll(MONEY_G)].map((m) => parseFloat(m[1].replace(/,/g, '')));

function lineQualifies(line, notice, sourceMatches) {
  if (!/£\s?\d/.test(line)) return false;
  const lw = new Set(words(line));
  for (const x of notice.exclusions) if (lw.has(x)) return false;
  if (notice.catWords.every((w) => lw.has(w))) return true;
  if (!sourceMatches) return false;
  if (notice.exclusions.size) return true;
  return /^\W*(?:the\s+)?[A-Z][\w' -]{1,40}?(?:room|hall|suite|orangery|barn|marquee|studio|lounge|pavilion|terrace|house|venue|garden)\b/i.test(line);
}

/** Does this chunk's source name or title carry the notice category? */
function sourceCarries(chunk, notice) {
  const title = `${String(chunk.source || '').replace(/\.[a-z0-9]+$/i, '')} ${String(chunk.text || '').split('\n').find((l) => l.trim()) || ''}`;
  const tw = new Set(words(title));
  return notice.catWords.every((w) => tw.has(w));
}

function eventDateFrom(texts, now) {
  for (const t of Array.isArray(texts) ? texts : []) {
    const s = String(t || '');
    if (/premise|computed/i.test(s.slice(0, 40))) continue;
    for (const m of s.matchAll(new RegExp(`(?:\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?)?\\b${MONTH_RE}\\b\\.?,?(?:\\s+(\\d{4}))?`, 'gi'))) {
      const mon = monthIdx(m[2]);
      if (mon < 0) continue;
      const day = m[1] ? Number(m[1]) : null;
      let year = m[3] ? Number(m[3]) : null;
      // "may" is a modal verb unless a day or year anchors it.
      if (/^may$/i.test(m[2]) && !day && !year) continue;
      if (!year) { year = now.getUTCFullYear(); if (Date.UTC(year, mon + 1, 0) < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) year += 1; }
      return { start: Date.UTC(year, mon, day || 1), end: day ? Date.UTC(year, mon, day) : Date.UTC(year, mon + 1, 0) };
    }
  }
  return null;
}

/**
 * Returns { chunks, premise, applied:[{source, cat, effective, pct}] }. Input chunks are not mutated.
 */
function applyPriceChange(chunks, { visitorTexts = [], now = new Date() } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const notices = parseNotices(list);
  if (!notices.length) return { chunks: list, premise: null, applied: [] };
  const ev = eventDateFrom(visitorTexts, now);
  const nowMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let out = list.slice();
  const premises = []; const applied = [];
  for (const n of notices) {
    const eff = n.effective.getTime();
    // Which side of the effective date is this question on?
    const after = n.basis === 'booking' ? nowMs >= eff : (ev ? ev.end >= eff : true);
    if (!after) continue;
    const next = [];
    const computed = [];
    for (const c of out) {
      if (!c || typeof c.text !== 'string') { next.push(c); continue; }
      if (c.text.startsWith(HISTORY_MARK) && c.history) { next.push(c); continue; }
      const srcOk = sourceCarries(c, n);
      const lines = c.text.split('\n');
      const catLines = []; const rest = [];
      for (const ln of lines) {
        if (lineQualifies(ln, n, srcOk) && !/\b(?:rise|increase|fall|decrease|drop)s?\s+(?:by|to)\b/i.test(ln)) catLines.push(ln); else rest.push(ln);
      }
      if (!catLines.length) { next.push(c); continue; }
      let ok = true;
      const cur = catLines.map((ln) => {
        const am = amountsIn(ln);
        if (n.to !== null) { if (am.length !== 1) { ok = false; return ln; } return ln.replace(MONEY_G, money(n.to)); }
        return ln.replace(MONEY_G, (_, v) => money(parseFloat(v.replace(/,/g, '')) * (1 + n.pct / 100)));
      });
      if (!ok) { next.push(c); continue; }
      next.push({ ...c, history: true, text: HISTORY_MARK + catLines.join('\n') });
      if (rest.some((l) => l.trim())) next.push({ ...c, text: rest.join('\n') });
      computed.push(...cur);
    }
    if (!computed.length) continue;
    const pctTxt = n.pct === null ? '' : ` (${n.pct > 0 ? '+' : ''}${n.pct}%)`;
    const basisTxt = n.basis === 'booking' ? 'bookings made' : 'events taking place';
    const head = `${n.cat.charAt(0).toUpperCase()}${n.cat.slice(1)} from ${fmtDate(eff)}${pctTxt}, for ${basisTxt} on or after that date (computed from the price list and the price-change notice):`;
    const top = Math.max(0, ...out.map((x) => (x && x.score) || 0));
    next.push({ source: `${n.source || 'price-change'} (computed)`, text: `${head}\n${computed.join('\n')}`, score: top, computed: true });
    out = next;
    let p = `${head} ${computed.map((l) => l.replace(/\s+/g, ' ').trim()).join('; ')}.`;
    if (n.exclusions.size) p += ` Other prices the notice lists as unchanged (${[...n.exclusions].join(', ')}) keep their listed figures.`;
    p += ` The pre-change ${n.cat} figures are history: do not quote them as the current price.`;
    if (n.grandfather) p += ` Exception: ${n.grandfather.sentence.replace(/\s+/g, ' ').trim()} Apply it only if the visitor says they booked before ${fmtDate(n.grandfather.before.getTime())}.`;
    premises.push(p);
    applied.push({ source: n.source, cat: n.cat, effective: fmtDate(eff), pct: n.pct });
  }
  return { chunks: out, premise: premises.length ? premises.join(' ') : null, applied };
}

module.exports = { parseNotices, applyPriceChange, eventDateFrom, sourceCarries, lineQualifies };
