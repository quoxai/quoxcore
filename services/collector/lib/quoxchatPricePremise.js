'use strict';
const { tableFacts } = require('./quoxchatGrounding');
/**
 * Wave 15: a visitor states a price for a named item ("your £35 afternoon
 * session for 2-year-olds") and KNOWLEDGE has a CURRENT price row for that
 * item with a different amount ("2 year olds,afternoon,41.00"). The model
 * went along with the premise. The mismatch is found in code, handed to the
 * prompt as a premise, and a reply that omits the real figure gets the
 * correction prepended.
 */
const STOP = new Set(['the', 'a', 'an', 'for', 'your', 'our', 'of', 'to', 'is', 'it', 'per', 'and', 'in', 'on', 'at', 'my', 'me', 'can', 'i', 'do', 'you', 'we', 'with', 'price', 'cost', 'fee', 'fees']);
const OLD_RE = /\b(superseded|archived|replaced|no longer current|out of date|outdated|old price)/i;
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const NUMW = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' };
const toks = (s) => String(s).toLowerCase().replace(/[£$€]\s?\d[\d,]*(?:\.\d+)?/g, ' ').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map((w) => NUMW[w] || w).map(stem);

const GENERIC_HEAD = new Set(['age', 'name', 'item', 'type', 'category', 'product', 'description', 'price', 'cost', 'fee', 'fees', 'amount', 'gbp']);
const DET_RE = /^(?:a|an|the|our|your|this|that|any|each|one)\s+/i;
// Prose: "A registration deposit of £150 secures a place", "The admission fee is £12", "a £150 registration deposit".
function proseRows(line) {
  const out = [];
  for (const sn of String(line).split(/(?<=[.!?])\s+/)) {
    let m = /([A-Za-z][A-Za-z\- ]{2,50}?)\s+(?:of|is|are|costs?|will be|comes to)\s+(?:only\s+|just\s+|from\s+)?[£$€]\s?(\d[\d,]*(?:\.\d+)?)\b/.exec(sn);
    if (m) {
      let label = m[1].trim();
      while (DET_RE.test(label)) label = label.replace(DET_RE, '');
      label = label.split(/\s+/).slice(-3).join(' ');
      const t = toks(label);
      if (t.length) { out.push({ label, toks: new Set(t), head: t[t.length - 1], prose: true, amount: parseFloat(m[2].replace(/,/g, '')) }); continue; }
    }
    m = /[£$€]\s?(\d[\d,]*(?:\.\d+)?)\s+((?:[A-Za-z\-]+\s+){0,2}[A-Za-z\-]+)/.exec(sn);
    if (m) {
      const words = m[2].split(/\s+/);
      const cut = words.findIndex((w) => /^(?:to|for|is|are|will|per|secures?|applies|and|which|that|or|in|on|at)$/i.test(w));
      const label = (cut >= 0 ? words.slice(0, cut) : words).join(' ');
      const t = toks(label);
      if (t.length) out.push({ label, toks: new Set(t), head: t[t.length - 1], prose: true, amount: parseFloat(m[1].replace(/,/g, '')) });
    }
  }
  return out;
}

function priceRows(knowledgeTexts) {
  const rows = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    if (OLD_RE.test(String(k))) continue;
    let header = null;
    // W17b: markdown table / key:value rows become labelled rows ("1 hour lesson Manual").
    for (const fact of tableFacts(k)) {
      const m = /^(.*?)\s*([£$€])\s?(\d[\d,]*(?:\.\d+)?)\s*$/.exec(fact);
      if (!m) continue;
      const t = toks(m[1]);
      if (t.length >= 2) rows.push({ label: m[1].trim(), toks: new Set(t), amount: parseFloat(m[3].replace(/,/g, '')), table: true });
    }
    for (const line of String(k || '').split('\n')) {
      if (/^\s*\|/.test(line)) continue;
      const cells = line.split(',').map((x) => x.trim());
      if (cells.length >= 2 && !/\d/.test(line) && cells.every((c) => c && c.length <= 24)) header = cells.map((c) => c.toLowerCase());
      const csv = /^(.+),\s*[£$€]?\s?(\d+(?:\.\d{1,2})?)\s*$/.exec(line.trim());
      if (csv && /,/.test(line)) {
        const label = csv[1].split(',').map((x) => x.trim()).filter(Boolean);
        const t = toks(label.join(' '));
        if (t.length >= 2) {
          // Name the item type from the column header when the label lacks it ("afternoon" -> "afternoon session").
          let noun = '';
          const lc = label.length;
          if (header && header.length === lc + 1) {
            const h = header[lc - 1];
            if (h && !GENERIC_HEAD.has(h) && !t.includes(stem(h))) noun = h;
          }
          rows.push({ label: label.join(' '), noun, toks: new Set(t), amount: parseFloat(csv[2]) });
        }
        continue;
      }
      // csvToText rows: "age_band: 2 year olds | session: afternoon | price_gbp: £41.00 | notes: ..."
      if (/\s\|\s/.test(line) && /^\s*[\w ]+:\s/.test(line)) {
        const cols = line.split('|').map((x) => x.trim());
        const priced = cols.find((c) => /^[\w ]*(?:price|cost|fee|amount|gbp)\w*\s*:\s*[£$€]\s?\d/i.test(c));
        if (priced) {
          const amount = parseFloat(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)/.exec(priced)[1].replace(/,/g, ''));
          const label = cols.filter((c) => c !== priced && !/^(?:notes?|valid\w*|effective\w*)\s*:/i.test(c)).map((c) => c.replace(/^[\w ]+:\s*/, '')).filter(Boolean);
          const t = toks(label.join(' '));
          if (t.length >= 2) rows.push({ label: label.join(' '), noun: '', toks: new Set(t), amount });
          continue;
        }
      }
      const pr = /^\s*([^:£$€]{3,60}?)\s*[:\-–]\s*[£$€]\s?(\d[\d,]*(?:\.\d+)?)\b/.exec(line);
      if (pr) {
        const t = toks(pr[1]);
        if (t.length >= 2) rows.push({ label: pr[1].trim(), toks: new Set(t), amount: parseFloat(pr[2].replace(/,/g, '')) });
        continue;
      }
      if (/[£$€]\s?\d/.test(line)) rows.push(...proseRows(line));
    }
  }
  return rows;
}

const LOOSE_OPTIONAL = /^(?:\d+|hour|minute|day|week|month|year|min|hr)$/;
const fmt = (n) => `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
/** The label as the sentence will say it: row label fields joined naturally, ordered as the visitor would. */
function sentenceFor(row, claimed) {
  return `The ${row.label.replace(/,/g, ' ')}${row.noun ? ` ${row.noun}` : ''} is ${fmt(row.amount)}, not ${fmt(claimed)}.`;
}

function priceCorrections(message, knowledgeTexts) {
  const msg = String(message || '');
  if (!/[£$€]/.test(msg)) return [];
  const rows = priceRows(knowledgeTexts);
  if (!rows.length) return [];
  const out = [];
  for (const clause of msg.split(/(?<=[.!?;])\s+/)) {
    const amounts = [...clause.matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;
    const ct = new Set(toks(clause));
    // Prose rows: the item's head noun must sit within two words of a claimed amount.
    const near = new Set();
    const words = clause.toLowerCase().split(/\s+/);
    words.forEach((w, i) => {
      if (!/[£$€]\s?\d/.test(w) && !(/^\d/.test(w) && i > 0 && /[£$€]$/.test(words[i - 1]))) return;
      for (const x of words.slice(Math.max(0, i - 2), i + 3)) for (const t of toks(x)) near.add(t);
    });
    const matched = rows.filter((r) => (r.prose ? near.has(r.head) && ct.has(r.head) : [...r.toks].every((t) => ct.has(t))));
    if (!matched.length) {
      // W17b: "a manual lesson" names a column and a row type but not which row: list the current table rows it could mean.
      const loose = rows.filter((r) => r.table && [...r.toks].filter((t) => !LOOSE_OPTIONAL.test(t)).every((t) => ct.has(t)));
      const amts = [...new Set(loose.map((r) => r.amount))].sort((a, b) => a - b);
      if (loose.length >= 2 && amts.length >= 2 && !amts.some((a) => amounts.includes(a)) && !out.some((o) => o.claimed === amounts[0] && o.actuals)) {
        const rowsTxt = amts.map((a) => `the ${loose.find((r) => r.amount === a).label} is ${fmt(a)}`);
        const list = rowsTxt.length === 2 ? rowsTxt.join(' and ') : `${rowsTxt.slice(0, -1).join(', ')} and ${rowsTxt[rowsTxt.length - 1]}`;
        out.push({ claimed: amounts[0], actual: amts[0], actuals: amts, label: loose.map((r) => r.label).join('; '), sentence: `${list.charAt(0).toUpperCase()}${list.slice(1)}, not ${fmt(amounts[0])}.` });
      }
      // W17c: a generic subject ("are lessons £20?") names only the head noun: match table rows whose label ends in it.
      if (!out.length || !loose.length) {
        const groups = new Map();
        for (const r of rows.filter((x) => x.table)) {
          const words = r.label.split(/\s+/);
          if (words.length < 3) continue;
          const col = words[words.length - 1];
          const base = words.slice(0, -1).join(' ');
          const bt = toks(base);
          if (!bt.length || !ct.has(bt[bt.length - 1]) || /^\d+$/.test(bt[bt.length - 1])) continue;
          if (!groups.has(base)) groups.set(base, { base, noun: bt[bt.length - 1], cols: [] });
          groups.get(base).cols.push({ col: col.toLowerCase(), amount: r.amount });
        }
        const gl = [...groups.values()].filter((g) => g.cols.length);
        if (gl.length && !gl.some((g) => g.cols.some((c) => amounts.includes(c.amount))) && !loose.length) {
          const minLen = Math.min(...gl.map((g) => g.base.length));
          const base = gl.filter((g) => g.base.length === minLen).slice(0, 1);
          const parts = base.map((g) => `a ${g.base} is ${g.cols.map((c) => `${fmt(c.amount)} ${c.col}`).join(' or ')}`);
          const noun = base[0].noun;
          const plural = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}s`;
          const all = base.flatMap((g) => g.cols.map((c) => c.amount));
          out.push({ claimed: amounts[0], actual: all[0], actuals: all, label: base.map((g) => g.base).join('; '), sentence: `${plural} are not ${fmt(amounts[0])}: ${parts.join(' and ')}.` });
        }
      }
      continue;
    }
    const best = Math.max(...matched.map((r) => r.toks.size));
    const top = matched.filter((r) => r.toks.size === best);
    if (new Set(top.map((r) => r.amount)).size !== 1) continue;
    const row = top[0];
    if (matched.some((r) => amounts.includes(r.amount))) continue;
    const claimed = amounts[0];
    if (claimed === row.amount) continue;
    if (out.some((o) => o.actual === row.amount && o.claimed === claimed)) continue;
    out.push({ claimed, actual: row.amount, label: row.label, sentence: sentenceFor(row, claimed) });
  }
  return out.slice(0, 2);
}

function premiseFor(c) {
  if (c.actuals) return `Price correction (computed): the visitor said ${fmt(c.claimed)} for an item that KNOWLEDGE prices by row (${c.label.replace(/,/g, ' ')}). Politely correct it and state the current figures: "${c.sentence}"`;
  return `Price correction (computed): the visitor said ${fmt(c.claimed)} for an item that KNOWLEDGE prices at ${fmt(c.actual)} (${c.label.replace(/,/g, ' ')}). Politely correct it and state the current figure: "${c.sentence}"`;
}

function enforcePriceCorrections(text, corrections) {
  const src = String(text || '');
  const missing = (Array.isArray(corrections) ? corrections : []).filter((c) => !(c.actuals || [c.actual]).some((a) => src.includes(fmt(a)) || src.includes(String(a.toFixed(2)))));
  if (!missing.length) return { text: src, changed: false };
  return { text: `${missing.map((c) => c.sentence).join(' ')} ${src}`.trim(), changed: true };
}

module.exports = { priceCorrections, premiseFor, enforcePriceCorrections };
