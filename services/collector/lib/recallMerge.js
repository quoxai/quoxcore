/**
 * ONE-BRAIN Phase A2 (QuoxPlan #493) — unified recall dedup/merge.
 *
 * The three recall surfaces (memory_search → memory :3103, quoxbrain_search
 * → brain :3106, execution_intelligence search_wisdom → tasks :3104) overlap
 * with no arbiter: the same insight can come back from all three with no
 * indication they are the same thing. Phase A1 stamped brain notes with
 * `originStore`/`originId` pointing back at their canonical memory/wisdom
 * row (309 notes backfilled). This module is the arbiter: given normalized
 * hits from all three surfaces, collapse same-insight hits into ONE
 * provenance-tagged, freshness-preferred result.
 *
 * Input item shape (see recallSearch.js's normalize*Item() adapters):
 *   {
 *     surface: 'memory' | 'wisdom' | 'brain',
 *     id: string,                                    // item's own id in `surface`'s store
 *     text: string,
 *     score: number | null,
 *     updatedAt: string | null,                       // ISO-ish, freshness tie-break only
 *     origin: { store: 'memory'|'wisdom', id: string } | null,   // brain hits only
 *     meta: object,
 *   }
 *
 * Identity rule (group key), in priority order:
 *   1. origin stamp (a brain hit's originStore/originId) — this IS the
 *      canonical row's identity, so it groups under `${origin.store}:${origin.id}`.
 *   2. the item's own store+id (covers memory/wisdom hits, and brain hits
 *      with no origin stamp — e.g. notes older than the A1 backfill).
 *   3. last resort: normalized-text hash, so near-identical snippets that
 *      share neither an origin stamp nor an id still collapse into one.
 *
 * Freshness rule: when a group contains both a canonical-store item
 * (memory/wisdom) and a brain item, the canonical store's text wins — a
 * known 65-day-drift case showed brain copies can go stale. The brain
 * surface is recorded under `also_indexed_in` instead of supplying the text.
 */

'use strict';

const CANONICAL_STORES = new Set(['memory', 'wisdom']);
const SNIPPET_MAX_LEN = 480;

// CORTEX-BENCH pass 1 (ONE-BRAIN CX1): surfaces score on incompatible scales
// (brain: negative, ordered by its own hybrid fusion + rerank; wisdom: 0..1
// confidence; memory FTS: none). When the caller stamps each item with its
// 1-based rank inside its own surface, groups are ordered by weighted
// reciprocal-rank fusion instead of raw scores. The brain leg carries the most
// context (titled notes, hybrid + rerank), so it gets the highest weight.
const RRF_K = 4;
const SURFACE_WEIGHT = { brain: 1.0, memory: 0.85, wisdom: 0.6 };

// Strong identity: an origin stamp always wins (it names the canonical row
// this brain copy is OF), otherwise the item's own store+id.
function ownKey(item) {
  if (item.origin && item.origin.store && item.origin.id != null) {
    return `${item.origin.store}:${item.origin.id}`;
  }
  return `${item.surface}:${item.id}`;
}

// Last-resort identity: a small, dependency-free hash of normalized text.
// Deliberately exact-match (not fuzzy) — this is a fallback for near-
// identical snippets that already survived rules 1/2 unmerged, not a
// semantic similarity engine.
function normalizedTextHash(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return null;
  let hash = 5381;
  for (let i = 0; i < norm.length; i++) {
    hash = ((hash << 5) + hash + norm.charCodeAt(i)) | 0; // djb2
  }
  return `text:${hash}`;
}

function freshnessTimestamp(item) {
  const t = item.updatedAt || item?.meta?.updated_at || item?.meta?.created_at || item?.meta?.occurredAt;
  const parsed = t ? Date.parse(t) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

// Within a merged group, prefer a CANONICAL_STORES item over a brain copy
// (freshness rule above). Among ties (including a text-hash-only merge of
// two canonical items from different stores), prefer the most recently
// updated.
function pickCanonicalItem(items) {
  const canonicalItems = items.filter((it) => CANONICAL_STORES.has(it.surface));
  const pool = canonicalItems.length > 0 ? canonicalItems : items;
  return pool.reduce((best, it) => (freshnessTimestamp(it) >= freshnessTimestamp(best) ? it : best));
}

function isWellFormed(item) {
  return Boolean(item && item.surface && item.id != null && item.id !== '' && typeof item.text === 'string' && item.text.trim());
}

/**
 * @param {Array<object>} rawItems
 * @returns {Array<{text:string, snippet:string, score:number|null, canonical:{store:string,id:string}, surfaces:string[], also_indexed_in:string[]}>}
 */
function mergeRecallResults(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems.filter(isWellFormed) : [];
  if (items.length === 0) return [];

  // Pass 1 — group by strong identity (origin stamp, else own store+id).
  const byKey = new Map(); // identityKey -> item[]
  for (const item of items) {
    const key = ownKey(item);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }

  // Pass 2 — last-resort fold: groups that share a normalized-text hash but
  // landed under different strong-identity keys get merged together too.
  // Only the FIRST item's text per group is hashed (representative — a
  // strong-identity group is already one insight, so its members share text
  // closely enough that any member's normalized text identifies the group).
  const textHashToKey = new Map(); // textHash -> the identityKey that owns it
  const foldedInto = new Map(); // identityKey -> identityKey it was folded into
  for (const [key, group] of byKey) {
    const hash = normalizedTextHash(group[0].text);
    if (!hash) continue;
    const existingKey = textHashToKey.get(hash);
    if (existingKey && existingKey !== key) {
      foldedInto.set(key, existingKey);
    } else if (!existingKey) {
      textHashToKey.set(hash, key);
    }
  }

  const finalGroups = new Map(); // rootKey -> item[]
  for (const [key, group] of byKey) {
    let rootKey = key;
    while (foldedInto.has(rootKey)) rootKey = foldedInto.get(rootKey);
    if (!finalGroups.has(rootKey)) finalGroups.set(rootKey, []);
    finalGroups.get(rootKey).push(...group);
  }

  const results = [];
  for (const group of finalGroups.values()) {
    const canonicalItem = pickCanonicalItem(group);
    const surfaces = [...new Set(group.map((it) => it.surface))];
    const alsoIndexedIn = surfaces.filter((s) => s !== canonicalItem.surface);
    const scores = group.map((it) => it.score).filter((s) => typeof s === 'number' && Number.isFinite(s));
    const score = scores.length > 0 ? Math.max(...scores) : null;
    const text = canonicalItem.text;
    // Rank fusion: best rank per surface, weighted reciprocal rank summed.
    const bestRank = {};
    for (const it of group) {
      if (Number.isFinite(it.rank) && it.rank > 0 && it.rank < (bestRank[it.surface]?.rank ?? Infinity)) {
        bestRank[it.surface] = { rank: it.rank, weight: Number.isFinite(it.weight) ? it.weight : (SURFACE_WEIGHT[it.surface] ?? 0.5) };
      }
    }
    const ranked = Object.keys(bestRank).length > 0;
    const fused = ranked
      ? Object.values(bestRank).reduce((sum, { rank, weight }) => sum + weight / (RRF_K + rank), 0)
      : null;
    // Display fields: the brain copy knows the title/note id/kind/vault even
    // when a canonical memory row supplies the text.
    const brainMember = group.find((it) => it.surface === 'brain');
    const metaOf = (it) => (it && it.meta) || {};
    const title = metaOf(brainMember).title || metaOf(canonicalItem).title || metaOf(canonicalItem).pattern_name
      || (canonicalItem.surface === 'memory' ? `Memory (${metaOf(canonicalItem).type || 'note'})` : null);
    const snippetSource = (brainMember && typeof brainMember.passage === 'string' && brainMember.passage.length > text.length && canonicalItem === brainMember)
      ? brainMember.passage : text;
    const isCanonicalSurface = CANONICAL_STORES.has(canonicalItem.surface);

    results.push({
      ...(title ? { title } : {}),
      text,
      snippet: snippetSource.length > SNIPPET_MAX_LEN ? `${snippetSource.slice(0, SNIPPET_MAX_LEN).trim()}…` : snippetSource,
      score: ranked ? +fused.toFixed(4) : score,
      ...(ranked ? { rankFused: true } : {}),
      ...(group.every((it) => it.weak) ? { weak: true } : {}),
      source: metaOf(brainMember).source || canonicalItem.surface,
      ...(metaOf(brainMember).kind ? { kind: metaOf(brainMember).kind } : {}),
      ...(canonicalItem.updatedAt || (brainMember && brainMember.updatedAt) ? { date: canonicalItem.updatedAt || brainMember.updatedAt } : {}),
      ...(brainMember ? { noteId: metaOf(brainMember).noteId || brainMember.id } : {}),
      ...(metaOf(brainMember).relPath ? { relPath: metaOf(brainMember).relPath } : {}),
      canonical: {
        store: isCanonicalSurface ? canonicalItem.surface : (canonicalItem.origin?.store || canonicalItem.surface),
        id: isCanonicalSurface ? canonicalItem.id : (canonicalItem.origin?.id || canonicalItem.id),
      },
      surfaces,
      also_indexed_in: alsoIndexedIn,
    });
  }

  // Rank highest score first; unscored results sort last.
  results.sort((a, b) => {
    if (a.score == null && b.score == null) return 0;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score;
  });

  return results;
}

module.exports = { mergeRecallResults, normalizedTextHash };
