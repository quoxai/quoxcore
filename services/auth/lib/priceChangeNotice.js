/**
 * QC-BRUTALOOP-W18 #4: admin visibility for price-change notices. A notice
 * ("From 1 January 2026, all room hire prices rise by 10% ...") changes figures
 * listed in a SIBLING source that never mentions the new date. Nothing in the
 * old file says so, so Go live passed with no warning. Pure; no I/O.
 *
 * Minimal duplicate of the collector's lib/quoxchatPriceChange.js notice
 * detection (the services do not share code); both are pinned by the same
 * fixture, services/collector/test/fixtures/w18-price-change-corpus.json.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const STOP = new Set(['all', 'the', 'a', 'an', 'our', 'your', 'and', 'of', 'are', 'is', 'unchanged', 'price', 'prices', 'fee', 'fees', 'rate', 'rates', 'per', 'for', 'will', 'remain', 'stay', 'same', 'not', 'change', 'changed']);
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
const VERB = '(?:rise|rises|increase|increases|go(?:es)? up|fall|falls|decrease|decreases|drop|drops)';
const NOTICE_RE = new RegExp(`(?:^|[\\s,])(?:all\\s+)?([a-z][a-z \\-]{2,40}?)\\s+(?:prices?|rates?|fees?|charges?)\\s+${VERB}\\s+by\\s+\\d+(?:\\.\\d+)?\\s*%`, 'i');
const TO_RE = /(?:^|[\s,])(?:the\s+)?([a-z][a-z \-]{2,40}?)\s+(?:prices?|rates?|fees?)\s+(?:rises?|changes?|increases?|goes?\s+up|falls?)\s+to\s+£\s?\d/i;

function isoOf(y, mi, d) {
  return `${String(y).padStart(4, '0')}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const monIdx = (s) => MONTHS.indexOf(String(s).slice(0, 3).toLowerCase());
/** All dates in a text as ISO strings (month-only dates use day 1). */
export function datesIn(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b\\.?,?\\s+(\\d{4})\\b`, 'gi'))) out.push(isoOf(m[3], monIdx(m[2]), Number(m[1])));
  for (const m of s.matchAll(new RegExp(`\\b${MON}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) out.push(isoOf(m[3], monIdx(m[1]), Number(m[2])));
  for (const m of s.matchAll(new RegExp(`\\b${MON}\\b\\.?,?\\s+(\\d{4})\\b`, 'gi'))) out.push(isoOf(m[2], monIdx(m[1]), 1));
  return [...new Set(out)].sort();
}

function parseNotice(text) {
  const sents = String(text || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const exclusions = new Set();
  for (const s of sents) {
    if (/\bunchanged\b|\bunaffected\b/i.test(s)) for (const w of words(s.replace(/\b(?:unchanged|unaffected)\b/ig, ''))) if (!STOP.has(w)) exclusions.add(w);
  }
  for (const s of sents) {
    const m = NOTICE_RE.exec(s) || TO_RE.exec(s);
    if (!m) continue;
    const cat = m[1].replace(/^(?:from\b.*?,\s*)/i, '').replace(/^(?:all|the|our)\s+/i, '').trim();
    const catWords = words(cat).filter((w) => !STOP.has(w));
    const d = datesIn(s)[0];
    if (!catWords.length || !d) continue;
    return { cat_words: catWords, effective: d, exclusions: [...exclusions], sentence: s.slice(0, 300) };
  }
  return null;
}

/** What a file contributes to the check: { price_notice, price_digest } (either may be null). */
export function extractPriceInfo({ filename = '', text = '' } = {}) {
  const t = String(text || '').slice(0, 200000);
  const lines = t.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) || '';
  const priced = lines.filter((l) => /[£$€]\s?\d/.test(l)).slice(0, 40).map((l) => l.trim().slice(0, 200));
  return {
    price_notice: parseNotice(t),
    price_digest: priced.length ? {
      title_words: words(`${String(filename).replace(/\.[a-z0-9]{1,5}$/i, '')} ${first}`).slice(0, 20),
      lines: priced,
      dates: datesIn(t).slice(0, 20),
    } : null,
  };
}

const cfgOf = (r) => {
  let c = r?.config_json;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
  return c && typeof c === 'object' ? c : {};
};

/**
 * Rows ({ id?, name, config_json }) -> [{ name, notice }] for each priced, still
 * active source whose category a later notice changes and which carries no date
 * on or after the notice's effective date.
 */
export function sourcesChangedByNotice(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const n of list) {
    const nc = cfgOf(n);
    const notice = nc.price_notice;
    if (!notice || nc.superseded === true || !Array.isArray(notice.cat_words)) continue;
    const excl = new Set(notice.exclusions || []);
    for (const s of list) {
      if (s === n) continue;
      const sc = cfgOf(s);
      const dg = sc.price_digest;
      if (!dg || sc.superseded === true || sc.price_notice) continue;
      if ((dg.dates || []).some((d) => d >= notice.effective)) continue;
      const titleHit = notice.cat_words.every((w) => (dg.title_words || []).includes(w));
      const live = (dg.lines || []).filter((l) => { const lw = new Set(words(l)); return ![...excl].some((x) => lw.has(x)); });
      if (!live.length) continue;
      const lineHit = live.some((l) => { const lw = new Set(words(l)); return notice.cat_words.every((w) => lw.has(w)); });
      if (!titleHit && !lineHit) continue;
      out.push({ id: s.id, name: s.name, notice: n.name, notice_id: n.id });
    }
  }
  return out;
}

export const priceChangeMessage = (name, notice) => `${name} lists figures a later notice changes (${notice}): add current figures or mark the old file reference-only`;
