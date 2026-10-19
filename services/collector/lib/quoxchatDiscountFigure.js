'use strict';
/**
 * Wave 16b: a reply that states a percentage discount and the base price
 * ("Students get 15% off ... a Locker is £12 per week") but no resulting figure,
 * to a visitor who asked for a price, gets the computed figure appended.
 * Deterministic: base x (1 - p/100), rounded to pennies. Only when the reply
 * carries exactly one percentage and exactly one money value, both stated in
 * the knowledge.
 */
const PCT_RE = /(\d{1,3}(?:\.\d+)?)\s?%\s*(?:off|discount|reduction|cheaper|less)|(?:discount|reduction)\s+of\s+(\d{1,3}(?:\.\d+)?)\s?%/gi;
const MONEY_RE = /([£$€])\s?(\d[\d,]*(?:\.\d+)?)/g;
const ASK_PRICE_RE = /\b(?:how much|price|cost|pay|charge|fee|rate|per\s+(?:week|month|day|night|year)|a\s+(?:week|month|day|night|year)|£|\$|€)/i;
const PERIOD_RE = /\b(?:per|a|each|every)\s+(week|month|day|night|year|hour)\b|\b(weekly|monthly|daily|nightly|yearly|annual)\b/i;
const PERIOD_ADJ = { weekly: 'week', monthly: 'month', daily: 'day', nightly: 'night', yearly: 'year', annual: 'year' };

function completeDiscountFigure(text, { visitorTexts = [], knowledgeTexts = [] } = {}) {
  const src = String(text || '');
  const unchanged = { text: src, changed: false };
  const lastAsk = [...(Array.isArray(visitorTexts) ? visitorTexts : [])].reverse().find((t) => typeof t === 'string' && t.trim());
  if (!lastAsk || !ASK_PRICE_RE.test(lastAsk)) return unchanged;
  const pcts = [...src.matchAll(PCT_RE)].map((m) => parseFloat(m[1] || m[2]));
  const monies = [...src.matchAll(MONEY_RE)].map((m) => ({ sym: m[1], v: parseFloat(m[2].replace(/,/g, '')) }));
  if (pcts.length !== 1 || monies.length !== 1) return unchanged;
  const p = pcts[0]; const base = monies[0];
  if (!(p > 0 && p < 100) || !(base.v > 0)) return unchanged;
  const know = (Array.isArray(knowledgeTexts) ? knowledgeTexts : []).join('\n');
  const kMonies = [...know.matchAll(MONEY_RE)].map((m) => parseFloat(m[2].replace(/,/g, '')));
  const kPcts = [...know.matchAll(PCT_RE)].map((m) => parseFloat(m[1] || m[2]));
  if (!kMonies.includes(base.v) || !kPcts.includes(p)) return unchanged;
  const result = Math.round(base.v * (100 - p)) / 100;
  const money = `${base.sym}${Number.isInteger(result) ? result : result.toFixed(2)}`;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  if (src.includes(`${base.sym}${fmt(result)}`) || src.includes(money)) return unchanged;
  const pm = PERIOD_RE.exec(src);
  const period = pm ? (pm[1] || PERIOD_ADJ[String(pm[2]).toLowerCase()]) : null;
  const sentence = `That makes it ${money}${period ? ` per ${period}` : ''}.`;
  return { text: `${src.replace(/\s+$/, '')} ${sentence}`, changed: true, result, sentence };
}

module.exports = { completeDiscountFigure };
