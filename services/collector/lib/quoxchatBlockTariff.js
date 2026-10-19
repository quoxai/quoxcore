'use strict';
/**
 * Wave 15: a per-block tariff ("a late fee of £15 is charged for each 15
 * minutes or part of 15 minutes" after 18:00). Models quoted one block for
 * 18:16 and recited the rule without a figure for 18:20 / 18:40. The block
 * count and total are computed here, handed to the prompt as a fact, and a
 * reply that states a different total is corrected after generation.
 */
const RATE_RE = /(?:for each|per|every|each)\s+(\d{1,3})\s*(?:minutes?|mins?)\b(\s+or part(?:\s+of\s+\d+\s*(?:minutes?|mins?))?)?/i;
const START_RE = /\bafter\s+(\d{1,2})[:.](\d{2})\b/i;
const MONEY_RE = /[£$€]\s?(\d[\d,]*(?:\.\d+)?)/;

function findTariffs(knowledgeTexts) {
  const out = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const seg of String(k || '').split(/\n|(?<=[a-z)])\.\s+/i)) {
      const r = RATE_RE.exec(seg); const s = START_RE.exec(seg);
      if (!r || !s) continue;
      let amount = null;
      const m = MONEY_RE.exec(seg);
      if (m) amount = parseFloat(m[1].replace(/,/g, ''));
      else { const c = /,\s*(\d+(?:\.\d+)?)\s*$/.exec(seg.trim()); if (c) amount = parseFloat(c[1]); }
      if (!(amount > 0)) continue;
      out.push({ amount, block: Number(r[1]), orPart: !!r[2], start: Number(s[1]) * 60 + Number(s[2]), startLabel: `${String(s[1]).padStart(2, '0')}:${s[2]}` });
    }
  }
  return out;
}

const TOPIC_RE = /\b(late|collect|collection|pick(?:ing)?[- ]?up|fee|charge|cost|pay)/i;
function visitorMinute(t) {
  const m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/i.exec(t);
  if (m) {
    let h = Number(m[1]); const mi = Number(m[2]);
    if (m[3]) { if (/pm/i.test(m[3]) && h < 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0; }
    if (h <= 23 && mi <= 59) return { clock: h * 60 + mi };
  }
  const p = /\b(\d{1,2})\s*(am|pm)\b/i.exec(t);
  if (p) { let h = Number(p[1]); if (/pm/i.test(p[2]) && h < 12) h += 12; if (/am/i.test(p[2]) && h === 12) h = 0; if (h <= 23) return { clock: h * 60 }; }
  const d = /\b(\d{1,3})\s*(?:minutes?|mins?)\s+(?:late|after|past|over)\b/i.exec(t);
  if (d) return { past: Number(d[1]) };
  return null;
}

function planBlockTariff(visitorTexts, knowledgeTexts) {
  const tariffs = findTariffs(knowledgeTexts);
  if (!tariffs.length) return null;
  const t = tariffs[0];
  for (const txt of [...(Array.isArray(visitorTexts) ? visitorTexts : [])]) {
    if (typeof txt !== 'string' || !TOPIC_RE.test(txt)) continue;
    const v = visitorMinute(txt);
    if (!v) continue;
    const past = v.past !== undefined ? v.past : v.clock - t.start;
    if (!(past > 0)) continue;
    const blocks = t.orPart ? Math.ceil(past / t.block) : Math.floor(past / t.block);
    if (blocks < 1) continue;
    const total = Math.round(blocks * t.amount * 100) / 100;
    const money = `£${Number.isInteger(total) ? total : total.toFixed(2)}`;
    const when = v.clock !== undefined ? `Collecting at ${String(Math.floor(v.clock / 60)).padStart(2, '0')}:${String(v.clock % 60).padStart(2, '0')} is ` : 'Collection is ';
    const fact = `${when}${past} minutes after ${t.startLabel}, which is ${blocks} block${blocks === 1 ? '' : 's'} of ${t.block} minutes${t.orPart ? ' (a part block counts as a whole one)' : ''} at £${t.amount} each, so the late fee is ${money} in total.`;
    return { blocks, total, money, rate: t.amount, fact, sentence: fact };
  }
  return null;
}

const moneyVals = (s) => [...String(s).matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
const LATE_RE = /\b(late|collect|collection|pick|fee|charge|cost|pay|total|block)/i;

function enforceBlockTariff(text, plan) {
  const src = String(text || '');
  if (!plan) return { text: src, changed: false };
  if (moneyVals(src).includes(plan.total)) return { text: src, changed: false };
  const parts = src.split(/(?<=[.!?])\s+/);
  let replaced = false;
  const out = [];
  for (const sn of parts) {
    const vals = moneyVals(sn);
    const ruleOnly = /\b(for each|per|every|each)\s+\d+\s*(minutes?|mins?)/i.test(sn) && vals.every((x) => x === plan.rate);
    if (vals.length && LATE_RE.test(sn) && !ruleOnly) {
      if (!replaced) { out.push(plan.sentence); replaced = true; }
      continue;
    }
    out.push(sn);
  }
  let res = out.join(' ').trim();
  if (!replaced) res = `${res} ${plan.sentence}`.trim();
  return { text: res, changed: true };
}

module.exports = { findTariffs, planBlockTariff, enforceBlockTariff };
