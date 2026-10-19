'use strict';
/**
 * QUOXCHAT hybrid retrieval: in-memory BM25 over a widget's knowledge payloads,
 * fused with the dense (Qdrant) top-k by reciprocal rank fusion.
 *
 * Dense-only top-5 missed facts the corpus holds (Compliance Suite price,
 * standard-vs-pro). BM25 catches exact terms and figures; RRF merges the two
 * rankings. Scores stay on the dense scale so prepareKnowledge (floor 0.25,
 * strong 0.55, pinned window) is unaffected. Pure functions plus a small
 * per-collection cache; every failure path fails open to dense-only.
 */

const STOP = new Set(('a an and are as at be but by can do does for from guys had has have how i if in into is it its '
  + 'me my of on or our so than that the their them then there these they this to us was we were what when where which '
  + 'who will with would you your actually really about please tell').split(' '));
// Query-side synonyms: visitors say "cost", the corpus says "price"/"pricing".
const SYN = { cost: ['price', 'pricing'], costs: ['price', 'pricing'], price: ['cost', 'pricing'], pricing: ['price', 'cost'], much: ['price'], pay: ['price'],
  plan: ['standard', 'professional'], plans: ['standard', 'professional'], tier: ['standard', 'professional'],
  replying: ['human', 'handoff'], reply: ['human', 'handoff'], respond: ['human', 'handoff'], takeover: ['human', 'handoff'] };
// Open-ended "what do you do" questions carry no content words after stopword
// removal; expand them to the company-overview vocabulary.
const OVERVIEW_RE = /\b(what\s+(do|does)\s+(you|they|quox|your\s+\w+)\b.*\bdo\b|what\s+(do|does)\s+(you|quox)\s+(guys\s+)?(actually\s+)?do|who\s+are\s+you|what\s+is\s+(this|quox)|tell\s+me\s+about\s+(you|quox|your))/i;

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(text, { expand = false } = {}) {
  const raw = String(text || '').toLowerCase().match(/\$?\d[\d,.]*|[a-z][a-z0-9]*/g) || [];
  const out = [];
  for (const t of raw) {
    if (STOP.has(t)) continue;
    const s = stem(t.replace(/[,.]+$/, ''));
    if (!s) continue;
    out.push(s);
    if (expand && SYN[t]) for (const x of SYN[t]) out.push(stem(x));
  }
  return out;
}

const K1 = 1.4;
const B = 0.75;
const Q_WEIGHT = 3; // question tokens count extra: a Q&A question names its topic

/** docs: [{ text, source, section, pinned, answer, question }] */
function buildIndex(docs) {
  const items = [];
  const df = new Map();
  let totalLen = 0;
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || typeof d.text !== 'string' || !d.text.trim()) continue;
    const qToks = d.question ? tokenize(d.question) : [];
    const bodyToks = tokenize(d.text);
    const tf = new Map();
    for (const t of bodyToks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of qToks) tf.set(t, (tf.get(t) || 0) + Q_WEIGHT);
    const len = bodyToks.length + qToks.length * Q_WEIGHT;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    totalLen += len;
    items.push({ doc: d, tf, len, qSet: new Set(qToks) });
  }
  return { items, df, avgLen: items.length ? totalLen / items.length : 0, n: items.length };
}

function search(index, query, limit = 5) {
  if (!index || !index.n) return [];
  const qtList = tokenize(query, { expand: true });
  if (OVERVIEW_RE.test(String(query))) qtList.push('quox', 'platform');
  const qt = [...new Set(qtList)];
  if (!qt.length) return [];
  const moneyQuery = /\b(cost|costs|price|pricing|much|pay|fee|fees|plan|plans|tier|tiers)\b/i.test(String(query));
  const base = OVERVIEW_RE.test(String(query)) ? ['quox'] : tokenize(query);
  const scored = [];
  for (const it of index.items) {
    let s = 0;
    for (const t of qt) {
      const f = it.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (it.len / (index.avgLen || 1)))));
    }
    if (s <= 0) continue;
    // Pricing questions favour entries that actually state a figure.
    if (moneyQuery && /\$\s?\d/.test(it.doc.text)) s *= 1.25;
    // Near-exact match of the visitor question to a Q&A question.
    let exact = 0;
    if (it.qSet.size && base.length) {
      const inter = base.filter((t) => it.qSet.has(t)).length;
      const union = new Set([...base, ...it.qSet]).size;
      exact = inter / union;
    }
    scored.push({ doc: it.doc, bm25: s, exact });
  }
  scored.sort((a, b) => (b.exact >= 0.8) - (a.exact >= 0.8) || b.bm25 - a.bm25);
  return scored.slice(0, limit);
}

const RRF_K = 60;
const FLOOR_LEX = 0.3;   // lexical-only hits clear the grounding floor (0.25)
const CAP_LEX = 0.5;     // but never read as "strong" (0.55) on BM25 alone
const RRF_WEIGHT = 0.15;
const EXACT_SCORE = 0.9; // near-exact pinned question match leads and is strong

function keyOf(c) { return `${c.source || ''}\u0000${c.section || ''}\u0000${String(c.text || '').trim().slice(0, 200)}`; }

/**
 * Fuse dense chunks (already scored) with lexical hits. Returns chunks in the
 * prepareKnowledge shape, plus lexical_only / lexical_rank markers.
 */
function fuse(dense, lexical, { limit = 8 } = {}) {
  const byKey = new Map();
  const maxRrf = 2 / (RRF_K + 1);
  (dense || []).forEach((c, i) => {
    byKey.set(keyOf(c), { ...c, _rrf: 1 / (RRF_K + i + 1), lexical_only: false });
  });
  const topBm = lexical && lexical[0] ? lexical[0].bm25 : 1;
  (lexical || []).forEach((h, i) => {
    const d = h.doc;
    const k = keyOf(d);
    const rrf = 1 / (RRF_K + i + 1);
    const ex = byKey.get(k);
    const exact = h.exact >= 0.8 && d.pinned === true;
    if (ex) {
      ex._rrf += rrf;
      ex.lexical_rank = i + 1;
      if (exact) ex._exact = true;
    } else {
      const norm = topBm > 0 ? h.bm25 / topBm : 0;
      byKey.set(k, {
        text: d.text, source: d.source || '', section: d.section || '', pinned: d.pinned === true,
        answer: d.answer || null, source_url: d.source_url || null, ...(d.suggest_superseded === true ? { suggest_superseded: true } : {}), score: FLOOR_LEX + (CAP_LEX - FLOOR_LEX) * norm,
        _rrf: rrf, lexical_only: true, lexical_rank: i + 1, _exact: exact,
      });
    }
  });
  const out = [...byKey.values()].map((c) => {
    const s = Math.min(0.99, (c.score || 0) + RRF_WEIGHT * (c._rrf / maxRrf));
    const final = c._exact ? Math.max(s, EXACT_SCORE) : s;
    const { _rrf, _exact, ...rest } = c;
    return { ...rest, score: final };
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// Per-collection cache (TTL; invalidate() is for the reconcile/knowledge-change path).
const TTL_MS = 60000;
const cache = new Map(); // collection -> { at, index }
const stats = { builds: 0, errors: 0, fallbacks: 0 };

function invalidate(collection) { if (collection) cache.delete(collection); else cache.clear(); }

/** loader: async () => payload[]. Returns the index or null (fail-open); never throws. */
async function getIndex(collection, loader, { now = Date.now(), ttlMs = TTL_MS } = {}) {
  const hit = cache.get(collection);
  if (hit && hit.index && now - hit.at < ttlMs) return hit.index;
  try {
    const docs = await loader();
    const index = buildIndex(docs);
    cache.set(collection, { at: now, index });
    stats.builds++;
    return index;
  } catch (err) {
    stats.errors++;
    console.warn('[QuoxChat] lexical index build failed (fail-open to dense):', err && err.message);
    return hit && hit.index ? hit.index : null; // stale beats nothing
  }
}

/**
 * Hybrid retrieval wrapper. Never throws: any lexical error returns the dense
 * chunks unchanged with verdict.lexical_error set.
 */
async function hybrid({ collection, query, dense, loader, limit = 8 }) {
  const t0 = Date.now();
  const verdict = { lexical: false, lexical_only_hits: 0, lexical_error: null, lexical_ms: 0 };
  try {
    const index = await getIndex(collection, loader);
    if (!index) throw new Error('index_unavailable');
    const lex = search(index, query, 5);
    const fused = fuse(dense, lex, { limit });
    verdict.lexical = true;
    verdict.lexical_only_hits = fused.filter((c) => c.lexical_only).length;
    verdict.lexical_ms = Date.now() - t0;
    return { chunks: fused, verdict };
  } catch (err) {
    stats.fallbacks++;
    verdict.lexical_error = String((err && err.message) || err).slice(0, 120);
    verdict.lexical_ms = Date.now() - t0;
    console.warn('[QuoxChat] lexical retrieval failed, dense-only:', verdict.lexical_error);
    return { chunks: dense || [], verdict };
  }
}

/** Scroll a Qdrant collection's payloads (text-bearing only). */
async function scrollPayloads({ collection, qdrantKey, fetchImpl = fetch, baseUrl = 'http://qdrant:6333' }) {
  const docs = [];
  let next = null;
  for (let i = 0; i < 200; i++) {
    const body = { limit: 256, with_payload: true, with_vector: false };
    if (next !== null && next !== undefined) body.offset = next;
    const r = await fetchImpl(`${baseUrl}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`scroll_${r.status}`);
    const d = await r.json();
    for (const p of d?.result?.points || []) {
      const pl = p.payload || {};
      if (!pl.text) continue;
      if (pl.injection_flag === 'high') continue; // W5: quarantined at ingest, never retrievable
      if (pl.superseded === true) continue; // admin marked the source reference-only: never answers or cites
      docs.push({
        text: pl.text, source: pl.source || '', section: pl.section || '',
        pinned: pl.pinned === true, answer: pl.answer || null, question: pl.question || null,
        source_url: typeof pl.source_url === 'string' ? pl.source_url : null,
        ...(pl.suggest_superseded === true ? { suggest_superseded: true } : {}),
      });
    }
    next = d?.result?.next_page_offset;
    if (next === null || next === undefined) break;
  }
  return docs;
}

module.exports = { tokenize, buildIndex, search, fuse, hybrid, getIndex, invalidate, scrollPayloads, stats };
