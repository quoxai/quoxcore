'use strict';
/**
 * QC-BRUTALOOP-W15b: dated-version arbitration at answer time.
 *
 * Two uploaded sources can price the same items for different periods
 * (fees-sheet "from 1 September 2025" vs fees-2026-27.csv). The bot quoted the
 * 2025 sheet as current. When retrieved chunks come from 2+ sources that carry
 * a validity date and overlap in priced items, the OLDER source (a newer one is
 * already in effect) is marked history: its text gets the same "superseded"
 * marker the Wave 12 archived path keys on, so the figure gate does not bind
 * subjects to it and the prompt reads it as history.
 */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const LEAD = '(?:(?:last\\s+)?updated|revised|valid\\s+from|valid\\s+until\\s+replaced\\s+from|effective(?:\\s+from)?|(?:prices|fees|rates|charges|tariff|price\\s+list)\\s+(?:valid\\s+)?from|from|w\\.?e\\.?f\\.?)';
const DATE_RE = new RegExp(`\\b${LEAD}[:\\s]+(?:the\\s+)?(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+)?${MON}\\.?,?\\s+(\\d{4})\\b`, 'ig');
const ISO_RE = new RegExp(`\\b${LEAD}[:\\s]+(\\d{4})-(\\d{2})-(\\d{2})\\b`, 'ig');
// W17: version token in a title ("Greenlight prices (v2)") when no dates exist.
const VER_RE = /(?:^|[^a-z0-9])(?:v|ver|version|rev|revision|r|edition|ed)[.\s_-]*(\d{1,3})(?:\.\d+)*(?![0-9a-z])/i;
function versionOf(line) {
  const t = String(line || '').replace(/^[#\s>*]+/, '').slice(0, 200);
  const m = VER_RE.exec(t);
  if (!m) return null;
  const key = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key ? { n: Number(m[1]), key } : null;
}
const RANGE_RE = /\b(20\d{2})\s*[-–\/]\s*(\d{2}|20\d{2})\b/;

function allDates(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(DATE_RE)) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 4) === 'sept' ? 'sept' : m[2].toLowerCase().slice(0, 3)];
    out.push({ at: m.index, date: new Date(Date.UTC(Number(m[3]), mon, m[1] ? Number(m[1]) : 1)) });
  }
  for (const m of s.matchAll(ISO_RE)) out.push({ at: m.index, date: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) });
  return out.sort((a, b) => a.at - b.at);
}

/** { from: Date, header: boolean } for text carrying a validity date, else null. */
function validityOf(text) {
  const s = String(text || '');
  const lines = s.split('\n').filter((l) => l.trim());
  // W16: a dated heading ("(updated April 2026)", html <h1>) and a footer ("Last updated March 2025") both state the version.
  const footer = lines.slice(-3).filter((l) => /\b(?:last\s+)?updated|revised|valid\s+from|effective\b/i.test(l));
  const head = [lines[0], ...lines.slice(1).filter((l) => /^\s*(?:#|<h[1-3])/i.test(l)), ...footer].filter(Boolean).join('\n');
  const headDates = allDates(head);
  if (headDates.length) return { from: headDates[0].date, header: true };
  const rm = RANGE_RE.exec(head);
  if (rm) return { from: new Date(Date.UTC(Number(rm[1]), 7, 1)), header: true };
  const dates = allDates(s);
  if (dates.length) return { from: new Date(Math.max(...dates.map((d) => d.date.getTime()))), header: false };
  const ver = versionOf(lines[0]);
  if (ver) return { from: null, header: true, version: ver.n, key: ver.key };
  return null;
}

const STOP = new Set(['the', 'a', 'an', 'for', 'of', 'to', 'is', 'per', 'and', 'in', 'on', 'at', 'from', 'price', 'fee', 'fees', 'age', 'session', 'valid', 'effective']);
const MONTH_WORDS = new Set(Object.keys(MONTHS).concat(['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december']));
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
function pricedLabelSets(text) {
  const sets = [];
  for (const line of String(text || '').split('\n')) {
    if (!/[£$€]\s?\d|,\s*[£$€]?\d+(?:\.\d{1,2})?\s*(?:,|$)/.test(line)) continue;
    const cleaned = line.replace(/[£$€]\s?\d[\d,]*(?:\.\d+)?/g, ' ').replace(/\b\d+\.\d{2}\b/g, ' ').replace(DATE_RE, ' ').replace(/\b20\d{2}\b/g, ' ');
    const t = cleaned.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w) && !MONTH_WORDS.has(w)).map(stem);
    if (t.length) sets.push(new Set(t));
  }
  return sets;
}
// "key: value | key: value" rows (csvToText): label tokens come from the non-price values only.
function pricedLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!/[£$€]\s?\d/.test(line)) continue;
    const amounts = [...line.matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
    let body = line;
    if (/\s\|\s/.test(line) && /^\s*[\w ]+:\s/.test(line)) {
      body = line.split('|').map((x) => x.trim()).filter((x) => !/^(?:price\w*|notes?|valid\w*|effective\w*)\s*:/i.test(x)).map((x) => x.replace(/^[\w ]+:\s*/, '')).join(' ');
    }
    const cleaned = body.replace(/[£$€]\s?\d[\d,]*(?:\.\d+)?/g, ' ').replace(DATE_RE, ' ').replace(/\b20\d{2}\b/g, ' ');
    const toks = new Set(cleaned.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w) && !MONTH_WORDS.has(w)).map(stem));
    if (toks.size) out.push({ toks, amounts });
  }
  return out;
}
// An undated line states a different figure than a current row for the same item.
function conflicts(aLines, bLines) {
  for (const a of aLines) for (const b of bLines) {
    if (b.toks.size < 3 || b.amounts.length !== 1) continue;
    let sub = true;
    for (const t of b.toks) if (!a.toks.has(t)) { sub = false; break; }
    if (sub && !a.amounts.includes(b.amounts[0])) return true;
  }
  return false;
}
function overlaps(a, b) {
  for (const x of a) for (const y of b) {
    let n = 0;
    for (const t of x) if (y.has(t)) n++;
    if (n >= 2) return true;
  }
  return false;
}

const HISTORY_MARK = '(superseded: replaced by a newer dated version, history only)\n';

/**
 * Returns a new chunk array; older-dated overlapping sources are copied with
 * history:true and a superseded marker prefixed to their text. Inputs are not mutated.
 */
function markHistoryChunks(chunks, { now = new Date() } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const bySource = new Map();
  for (const c of list) {
    if (!c || typeof c.text !== 'string' || !c.source) continue;
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push(c);
  }
  if (bySource.size < 2) return list;
  const info = new Map();
  for (const [src, cs] of bySource) {
    let headerFrom = null; let rowFrom = null; let version = null;
    const rowDates = [];
    for (const c of cs) {
      const v = validityOf(c.text);
      if (!v) continue;
      if (v.version !== undefined) { if (!version || v.version > version.n) version = { n: v.version, key: v.key }; continue; }
      if (v.header) { if (!headerFrom || v.from > headerFrom) headerFrom = v.from; }
      for (const d of allDates(c.text)) rowDates.push(d.date);
    }
    // Row-carried dates (csv "notes: from <date>"): the latest one already in effect is the source's date.
    const inEffect = rowDates.filter((d) => d <= now);
    if (inEffect.length) rowFrom = new Date(Math.max(...inEffect.map((d) => d.getTime())));
    else if (rowDates.length) rowFrom = new Date(Math.max(...rowDates.map((d) => d.getTime())));
    const maxFrom = rowFrom;
    const labels = cs.flatMap((c) => pricedLabelSets(c.text));
    const lines = cs.flatMap((c) => pricedLines(c.text));
    info.set(src, { version, from: headerFrom || maxFrom, headerFrom, labels, lines, suggest: cs.some((c) => c.suggest_superseded === true) });
  }
  const history = new Set();
  for (const [src, a] of info) {
    for (const [other, b] of info) {
      if (src === other) continue;
      // W17: undated sources ordered by a version token in the title.
      if (a.version && b.version && !a.headerFrom && !b.headerFrom && a.version.key === b.version.key && a.version.n < b.version.n) { history.add(src); continue; }
      if (!b.from || b.from > now) continue;
      if (a.suggest && !a.from) { history.add(src); continue; } // possibly outdated + a newer-dated sibling is in effect
      // Only a header date (first lines / year range) marks a source's own period;
      // dated rows inside a source are seasons, not a version.
      if (!a.from && conflicts(a.lines, b.lines)) { history.add(src); continue; } // undated, contradicted by a source in effect
      if (!a.headerFrom || a.headerFrom >= b.from) continue;
      if (overlaps(a.labels, b.labels)) history.add(src);
    }
  }
  if (!history.size) return list;
  return list.map((c) => (c && history.has(c.source)
    ? { ...c, history: true, text: HISTORY_MARK + c.text }
    : c));
}

module.exports = { markHistoryChunks, validityOf, HISTORY_MARK };
