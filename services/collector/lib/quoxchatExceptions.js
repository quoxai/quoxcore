'use strict';
/**
 * QC-BRUTALOOP-W14: exception clauses attached to figures, and conditioned
 * figures applied outside their stated window.
 *
 * Knowledge: "the retest is £20 (free for the partial-retest items listed by the
 * DVSA, such as lamps, wipers and number plates)". A visitor whose failed item
 * is a number plate must get "free", not "£20". Deterministic, no model call:
 *   - extractExceptions: figure sentences that carry an exception list
 *   - matchedExceptions: those whose list the visitor's turns mention
 *   - exceptionPremises: prompt lines naming the excepted item and its effect
 *   - enforceExceptions: rewrites a reply that applies the base figure anyway
 *   - stripOutsideWindowFigures: a figure stated "within N <unit>" is unsupported
 *     when the reply applies it "after N <unit>"
 */

const MONEY_RE = /[£$€]\s?\d[\d,]*(?:\.\d+)?/g;
const moneyKey = (m) => m.replace(/\s/g, '').replace(/,/g, '').replace(/\.00$/, '');

function stem(w) {
  let x = String(w || '').toLowerCase().replace(/'s$/, '');
  for (const suf of ['ing', 'ed', 'es', 's', 'e', 'ly']) {
    if (x.length > suf.length + 2 && x.endsWith(suf)) { x = x.slice(0, -suf.length); break; }
  }
  return x;
}
const STOP = new Set(['the', 'a', 'an', 'any', 'your', 'our', 'of', 'to', 'for', 'and', 'or', 'with', 'in', 'on', 'items', 'item']);
function wordsOf(t) { return String(t || '').toLowerCase().match(/[a-z][a-z0-9-]*/g) || []; }
const SYN = { lamp: ['light', 'headlight'], light: ['lamp'], headlight: ['lamp', 'light'] };

function sentencesOf(text) {
  return String(text || '').match(/(?:[^.!?]|[.!?]+(?=\S))+[.!?]*\s*/g) || [];
}

const CLAUSE_RES = [
  { effect: 'free', re: /\(\s*(?:free|no charge|not charged|exempt|no fee)\s+(?:for|on)\s+([^)]+)\)/i },
  { effect: 'free', re: /\b(?:free|no charge|no fee)\s+(?:for|on)\s+([^.;()]+)/i },
  { effect: 'exception', re: /\b(?:except(?:\s+for)?|unless|not\s+for|does\s+not\s+apply\s+to|doesn't\s+apply\s+to|excluding|other\s+than)\s+([^.;()]+)/i },
];

function itemsFrom(clause) {
  let c = String(clause || '').trim();
  const such = /\b(?:such as|e\.g\.?|including|like|namely)\b\s*(.+)$/i.exec(c);
  if (such) c = such[1];
  else if (wordsOf(c).length > 6) return [];
  return c.split(/,|\band\b|\bor\b|&/i)
    .map((part) => wordsOf(part).filter((w) => !STOP.has(w)).map(stem))
    .filter((ws) => ws.length > 0 && ws.length <= 3);
}

function extractExceptions(knowledgeTexts) {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const line of String(k || '').split('\n')) {
      for (const sn of sentencesOf(line)) {
        const figs = (sn.match(MONEY_RE) || []).map(moneyKey);
        if (!figs.length) continue;
        for (const { effect, re } of CLAUSE_RES) {
          const m = re.exec(sn);
          if (!m) continue;
          const items = itemsFrom(m[1]);
          if (!items.length) continue;
          const key = sn.trim();
          if (seen.has(key)) break;
          seen.add(key);
          out.push({ sentence: sn.trim(), figures: [...new Set(figs)], effect, items, clause: m[1].trim() });
          break;
        }
      }
    }
  }
  return out;
}

function itemMatches(item, tokenStems) {
  return item.every((w) => tokenStems.some((t) => t === w || (w.length >= 4 && t.endsWith(w)) || (SYN[w] || []).some((s) => t === s || t.endsWith(s))));
}

function matchedExceptions(exceptions, visitorTexts) {
  const tokenStems = wordsOf((Array.isArray(visitorTexts) ? visitorTexts : []).join(' ')).map(stem);
  const out = [];
  for (const ex of exceptions || []) {
    const hit = ex.items.find((it) => itemMatches(it, tokenStems));
    if (hit) {
      // Name the visitor's own words where possible; fall back to the list item.
      out.push({ ...ex, matched: hit.join(' ') });
    }
  }
  return out;
}

function visitorWord(ex, visitorTexts) {
  const raw = wordsOf((visitorTexts || []).join(' '));
  const ws = raw.map(stem);
  const want = ex.matched.split(' ');
  const pos = ws.findIndex((t, i) => want.length === 1 ? (t === want[0] || t.endsWith(want[0]) || (SYN[want[0]] || []).some((s) => t.endsWith(s))) : (t === want[0] && ws[i + 1] === want[1]));
  if (pos < 0) return ex.matched;
  return want.length === 1 ? raw[pos] : `${raw[pos]} ${raw[pos + 1]}`;
}

function exceptionPremises(matched, visitorTexts = []) {
  return (matched || []).map((ex) => {
    const item = visitorWord(ex, visitorTexts);
    const effect = ex.effect === 'free' ? 'free (no charge)' : 'excluded from the base rule';
    return `The visitor's item (${item}) falls under the exception in KNOWLEDGE: ${effect}. Do NOT quote the base figure(s) ${ex.figures.join(', ')} for it. Source: "${ex.sentence}"`;
  });
}

const EFFECT_RE = { free: /\b(?:free|no charge|no fee|not charged|exempt|nothing to pay|doesn't cost|does not cost)\b/i, exception: /\b(?:except|unless|exempt|does not apply|doesn't apply|not apply|excluded|excluding|different)\b/i };

function enforceExceptions(text, matched, visitorTexts = []) {
  const src = String(text || '');
  if (!matched || !matched.length) return { text: src, violated: false };
  let out = src;
  let violated = false;
  for (const ex of matched) {
    const effectRe = EFFECT_RE[ex.effect] || EFFECT_RE.exception;
    if (effectRe.test(out)) continue; // the reply states the exception somewhere
    const parts = sentencesOf(out);
    const bad = parts.filter((p) => (p.match(MONEY_RE) || []).map(moneyKey).some((f) => ex.figures.includes(f)));
    if (!bad.length) continue;
    violated = true;
    const item = visitorWord(ex, visitorTexts);
    const stmt = `Your ${item} falls under an exception in our information: ${ex.sentence}`;
    let placed = false;
    out = parts.map((p) => {
      if (!bad.includes(p)) return p;
      if (placed) return '';
      placed = true;
      return stmt + (/\s$/.test(p) ? ' ' : '');
    }).join('').trim();
  }
  return { text: violated ? out : src, violated };
}

const UNIT_RE = '(working\\s+days?|business\\s+days?|calendar\\s+days?|days?|weeks?|months?|hours?)';
const WITHIN_RE = new RegExp(`\\bwithin\\s+(?:the\\s+(?:first\\s+)?)?(\\d+)\\s+${UNIT_RE}`, 'i');
const AFTER_RE = new RegExp(`\\b(?:after|beyond|past|over|more\\s+than|outside(?:\\s+of)?|later\\s+than)\\s+(?:the\\s+)?(\\d+)\\s+${UNIT_RE}`, 'i');
const unitKey = (u) => String(u || '').toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');

function stripOutsideWindowFigures(text, knowledgeTexts) {
  const src = String(text || '');
  const windows = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const line of String(k || '').split('\n')) {
      for (const sn of sentencesOf(line)) {
        const w = WITHIN_RE.exec(sn);
        const figs = (sn.match(MONEY_RE) || []).map(moneyKey);
        if (w && figs.length) windows.push({ n: w[1], unit: unitKey(w[2]), raw: `${w[1]} ${w[2].toLowerCase()}`, figures: figs, knowledgeSentence: sn });
      }
    }
  }
  if (!windows.length) return { text: src, changed: false, removed: [] };
  const removed = [];
  let changed = false;
  const out = sentencesOf(src).map((sn) => {
    const a = AFTER_RE.exec(sn);
    if (!a) return sn;
    const figs = (sn.match(MONEY_RE) || []).map(moneyKey);
    const w = windows.find((x) => x.n === a[1] && unitKey(x.unit) === unitKey(a[2]) && x.figures.some((f) => figs.includes(f)));
    if (!w) return sn;
    changed = true;
    removed.push(sn.trim());
    const fig = (sn.match(MONEY_RE) || [])[0];
    return `I only have the ${fig} figure for within ${w.raw}; the documents do not give a price after that.${/\s$/.test(sn) ? ' ' : ''}`;
  }).join('');
  return { text: changed ? out : src, changed, removed };
}

module.exports = { extractExceptions, matchedExceptions, exceptionPremises, enforceExceptions, stripOutsideWindowFigures };
