// entityLinker.js — D4 co-occurrence entity linker
//
// Revives the knowledge graph by linking entities that were extracted
// together (same batch/migrate/summary "document") into a weighted
// `co_occurs_with` relation. See migrations/002-entity-relation-weight.sql
// for the schema this depends on.
//
// Bounded by design (no quadratic blowup):
//   - MAX_ENTITIES_PER_DOC: only the top-N (by reference_count) survivors
//     of the junk filter are paired at all -> C(N,2) upserts max per call.
//   - PAIR_CAP: absolute belt-and-braces ceiling on pairs processed per call.
//   - DEGREE_CAP: hub entities (e.g. docker01) stop accumulating brand NEW
//     edges once their co_occurs_with degree crosses the cap, though
//     existing edges still get their weight incremented.
//
// Never throws: a linking failure must never fail the write that
// triggered it. Callers may still wrap calls in try/catch as belt and
// braces (per the design), but this module also guards internally so a
// bad input here can't propagate into an aborted transaction upstream.

import { upsertCoOccurrence } from './memoryStore.js'

export const MAX_ENTITIES_PER_DOC = 12
export const PAIR_CAP = 100
export const DEGREE_CAP = 50

// Junk names seen live in the entities table (bad extractor output) plus
// common English stopwords/generic field names that would otherwise become
// universal hub nodes once the FTS backfill runs. Cleaning up the underlying
// junk *rows* is out of scope for D4 — this filter only prevents the linker
// from wiring them into the graph.
const JUNK_STOPWORDS = new Set([
  'with', 'or', 'if', 'the', 'and', 'name', 'key', 'table', 'status',
  'a', 'an', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were',
  'be', 'been', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'by',
  'at', 'from', 'not', 'but', 'so', 'no', 'yes', 'ok', 'true', 'false',
  'null', 'none', 'n/a', 'na', 'unknown', 'value', 'type', 'data', 'info',
  'item', 'list', 'id', 'row', 'col', 'field', 'record'
])

/**
 * Returns true if a name is too generic/junk to be worth linking in the
 * knowledge graph (short, stopword, or has no alphanumeric content).
 */
export function isJunkEntityName(name) {
  if (typeof name !== 'string') return true
  const trimmed = name.trim()
  if (trimmed.length < 3) return true
  if (!/[a-zA-Z0-9]/.test(trimmed)) return true
  if (JUNK_STOPWORDS.has(trimmed.toLowerCase())) return true
  return false
}

function buildContext(sourceKind, sourceRef) {
  let ctx = `auto:cooccur:${sourceKind || 'unknown'}`
  if (sourceRef) ctx += `:${sourceRef}`
  return ctx.slice(0, 200)
}

/**
 * Links entities that co-occurred in the same "document" (one batch call,
 * one migrate call, one conversation summary, or one backfill-generated
 * group) into weighted co_occurs_with relations.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.org_id
 * @param {string} opts.user_id
 * @param {string[]} opts.entityIds - candidate entity ids (deduped/verified internally)
 * @param {'batch'|'migrate'|'summary'|'backfill'} opts.sourceKind
 * @param {string} [opts.sourceRef] - optional short ref appended to context (e.g. conversation id)
 * @returns {{ pairs_linked: number, pairs_skipped: number }}
 */
export function linkCoOccurringEntities(db, { org_id, user_id, entityIds, sourceKind, sourceRef } = {}) {
  const result = { pairs_linked: 0, pairs_skipped: 0 }

  try {
    if (!db || !org_id || !user_id || !Array.isArray(entityIds)) return result

    const dedupedIds = [...new Set(entityIds.filter((id) => typeof id === 'string' && id))]
    if (dedupedIds.length < 2) return result

    // Ownership verification: only ids that actually belong to (org_id, user_id)
    // survive this SELECT — defense in depth even though callers already pass
    // req-scoped ids. This is also the org-scoping guarantee: entities from
    // another org can never appear in the pairing set below.
    const placeholders = dedupedIds.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT id, name, reference_count
      FROM entities
      WHERE org_id = ? AND user_id = ? AND id IN (${placeholders})
    `).all(org_id, user_id, ...dedupedIds)

    // Junk filter (stopwords / too-short names never get linked)
    const survivors = rows.filter((r) => !isJunkEntityName(r.name))

    // Bound #1: cap the candidate pool to the top-N by reference_count so
    // worst case is C(MAX_ENTITIES_PER_DOC, 2) upserts, not quadratic on
    // whatever a caller passes in.
    survivors.sort((a, b) => (b.reference_count || 0) - (a.reference_count || 0))
    const bounded = survivors.slice(0, MAX_ENTITIES_PER_DOC)

    if (bounded.length < 2) return result

    // Canonical undirected pair ordering: lexicographically smaller id is
    // always source_entity_id, so A-B and B-A collapse to one row.
    const pairs = []
    for (let i = 0; i < bounded.length; i++) {
      for (let j = i + 1; j < bounded.length; j++) {
        const aId = bounded[i].id
        const bId = bounded[j].id
        pairs.push(aId < bId ? [aId, bId] : [bId, aId])
      }
    }

    // Bound #2: absolute pair ceiling, belt-and-braces if MAX_ENTITIES_PER_DOC
    // is ever raised.
    let boundedPairs = pairs
    if (boundedPairs.length > PAIR_CAP) {
      result.pairs_skipped += boundedPairs.length - PAIR_CAP
      boundedPairs = boundedPairs.slice(0, PAIR_CAP)
    }

    const context = buildContext(sourceKind, sourceRef)

    // fleet #383: a soft-deleted relation must not count as "existing" (it
    // would suppress the resurrect-on-recreate upsert below) or toward the
    // degree cap (a deleted edge should not block a hub entity from
    // acquiring new ones).
    const existsStmt = db.prepare(`
      SELECT id FROM entity_relations
      WHERE source_entity_id = ? AND relation_type = 'co_occurs_with' AND target_entity_id = ? AND deleted_at IS NULL
    `)
    const degreeStmt = db.prepare(`
      SELECT COUNT(*) as c FROM entity_relations
      WHERE relation_type = 'co_occurs_with' AND (source_entity_id = ? OR target_entity_id = ?) AND deleted_at IS NULL
    `)

    for (const [sourceId, targetId] of boundedPairs) {
      const existing = existsStmt.get(sourceId, targetId)

      if (!existing) {
        // Bound #3: per-entity degree cap. Hub entities stop accumulating
        // brand new edges once they cross the cap; existing edges still
        // get their weight incremented (handled in the `existing` branch
        // above / the upsert call below, which always runs).
        const degA = degreeStmt.get(sourceId, sourceId).c
        const degB = degreeStmt.get(targetId, targetId).c
        if (degA >= DEGREE_CAP || degB >= DEGREE_CAP) {
          result.pairs_skipped++
          continue
        }
      }

      upsertCoOccurrence({ org_id, a_id: sourceId, b_id: targetId, context })
      result.pairs_linked++
    }

    return result
  } catch (err) {
    // Never-throw: linking is a bonus signal, not a critical path. Log and
    // return zero-counts rather than letting a linker bug fail the parent
    // write (memory_save / batch / migrate / summary).
    console.warn('[entityLinker] linkCoOccurringEntities failed (non-fatal):', err.message)
    return result
  }
}
