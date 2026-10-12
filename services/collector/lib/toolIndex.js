'use strict';

/**
 * TOOL-RETRIEVAL P2 — tool-RAG index.
 *
 * Embeds every tool's name+description into a Qdrant collection so P3 can
 * retrieve the top-K relevant tools for a message instead of loading all ~300
 * (OpenAI truncates at 128; the delegate-first work in P1 got quox under the
 * cap, this is the query-aware layer on top). Mirrors the embed→upsert→search
 * pattern already proven in lib/conversationRecall.js and routes/quoxchat.js
 * (embedText → OpenAI text-embedding-3-small at QDRANT_VECTOR_SIZE dims).
 *
 * Pure helpers (buildCorpus, pointId) are dependency-free and unit-tested.
 * indexTools / searchTools take injected deps (embedText, providerKeys,
 * qdrantUrl, fetchImpl) so they are testable and match the house DI style.
 *
 * LIVE GATE: building the index needs a platform embedding key resolvable by
 * embedText and a reachable Qdrant. Until a platform-scoped embedding key is
 * wired, indexTools() returns {indexed:0, reason:'no_embedding_key'} rather
 * than failing — honest-absent, same posture as quoxchat RAG when no BYOK
 * key is configured. Verified end-to-end 2026-08-08 (scripts/index-tools.js).
 */

const TOOL_COLLECTION = 'tool-index';
const DEFAULT_VECTOR_SIZE = Number(process.env.QDRANT_VECTOR_SIZE) || 1536;

// Same key resolution as routes/quoxchat.js's resolveQdrantKey() /
// conversationRecall.js's _resolveQdrantKey() — duplicated rather than
// imported to avoid a circular require (routes/quoxchat.js already requires
// this module's sibling pattern elsewhere); keep in sync if semantics change.
// Every Qdrant call in this file was missing this header entirely until the
// first real end-to-end run (2026-08-08) surfaced it as a 401 — the tests
// below assert it now so this can't silently regress.
function _resolveQdrantKey() {
  const key = process.env.QDRANT_API_KEY;
  if (key) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('QDRANT_API_KEY not configured — refusing to use the dev-qdrant-key default in production');
  }
  return 'dev-qdrant-key';
}

/** Stable non-negative int id for a tool name (djb2), so re-index upserts in place. */
function pointId(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return h;
}

/** One embeddable document per tool: name carries signal, description carries intent. */
function buildCorpus(TOOL_DEFS) {
  const out = [];
  for (const [name, def] of Object.entries(TOOL_DEFS || {})) {
    if (!def || typeof def.execute !== 'function') continue;
    const desc = (def.description || '').trim();
    out.push({
      name,
      text: desc ? `${name}: ${desc}` : name,
      category: def._category || def._provider || null,
    });
  }
  return out;
}

async function ensureCollection(deps, size) {
  const { qdrantUrl, fetchImpl = fetch } = deps;
  const resp = await fetchImpl(`${qdrantUrl}/collections/${TOOL_COLLECTION}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': _resolveQdrantKey() },
    body: JSON.stringify({ vectors: { size, distance: 'Cosine' } }),
  });
  // 200 = created, 409/pre-existing is fine.
  return resp.ok || resp.status === 409;
}

/**
 * Embed + upsert the whole tool surface. Idempotent (stable ids).
 * @returns {Promise<{indexed:number, skipped:number, reason?:string}>}
 */
async function indexTools(TOOL_DEFS, deps = {}) {
  const { embedText, providerKeys = {}, qdrantUrl = process.env.QDRANT_URL || 'http://qdrant:6333', fetchImpl = fetch } = deps;
  if (typeof embedText !== 'function') return { indexed: 0, skipped: 0, reason: 'no_embedText' };
  const corpus = buildCorpus(TOOL_DEFS);
  if (!corpus.length) return { indexed: 0, skipped: 0, reason: 'empty_corpus' };

  // Probe one embedding to learn the vector size + confirm a key resolves.
  const probe = await embedText(corpus[0].text, providerKeys, {});
  if (!probe || !Array.isArray(probe.vector) || !probe.vector.length) {
    return { indexed: 0, skipped: corpus.length, reason: 'no_embedding_key' };
  }
  await ensureCollection({ qdrantUrl, fetchImpl }, probe.vector.length);

  const points = [{ id: pointId(corpus[0].name), vector: probe.vector, payload: { name: corpus[0].name, category: corpus[0].category } }];
  let skipped = 0;
  for (const doc of corpus.slice(1)) {
    const e = await embedText(doc.text, providerKeys, {});
    if (!e || !Array.isArray(e.vector) || !e.vector.length) { skipped++; continue; }
    points.push({ id: pointId(doc.name), vector: e.vector, payload: { name: doc.name, category: doc.category } });
  }
  const up = await fetchImpl(`${qdrantUrl}/collections/${TOOL_COLLECTION}/points?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': _resolveQdrantKey() },
    body: JSON.stringify({ points }),
  });
  if (!up.ok) return { indexed: 0, skipped, reason: `upsert_failed_${up.status}` };
  return { indexed: points.length, skipped };
}

/**
 * Retrieve the top-K tools most relevant to a query.
 * @returns {Promise<{tools:Array<{name:string,score:number,category:?string}>, reason?:string}>}
 */
async function searchTools(query, deps = {}, k = 12) {
  const { embedText, providerKeys = {}, qdrantUrl = process.env.QDRANT_URL || 'http://qdrant:6333', fetchImpl = fetch } = deps;
  if (typeof embedText !== 'function') return { tools: [], reason: 'no_embedText' };
  const e = await embedText(String(query || ''), providerKeys, {});
  if (!e || !Array.isArray(e.vector) || !e.vector.length) return { tools: [], reason: 'no_embedding_key' };
  const resp = await fetchImpl(`${qdrantUrl}/collections/${TOOL_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': _resolveQdrantKey() },
    body: JSON.stringify({ vector: e.vector, limit: k, with_payload: true }),
  });
  if (!resp.ok) return { tools: [], reason: `search_failed_${resp.status}` };
  const data = await resp.json();
  const tools = (data?.result || []).map((r) => ({ name: r.payload?.name, score: r.score, category: r.payload?.category || null })).filter((t) => t.name);
  return { tools };
}

module.exports = { buildCorpus, pointId, ensureCollection, indexTools, searchTools, TOOL_COLLECTION, DEFAULT_VECTOR_SIZE };
