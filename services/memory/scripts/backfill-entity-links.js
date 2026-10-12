// backfill-entity-links.js — D4 one-time bounded backfill
//
// Entities carry no source references (attributes = {}, source_conversation_id
// NULL on all existing memories — verified live), so historical
// co-occurrence has to be reconstructed rather than replayed. For each
// (org_id, user_id) group: every non-junk entity name is FTS5-matched
// against memories_fts (scoped to that org/user); a memory row that matches
// 2+ entities becomes one co-occurrence "document". Entities that share an
// identical first_seen timestamp (same batch-insert pattern, verified live)
// become an additional document each. Every document is fed through the
// same bounded lib/entityLinker.js used by the live write paths.
//
// One-time only: guarded by a migrations-table marker
// (source='entity_link_backfill', status='completed'). Re-running after a
// successful completion is a safe no-op. Never run this from boot/cron —
// invoke manually (e.g. `docker exec <container> node scripts/backfill-entity-links.js`).
//
// Usage:
//   node scripts/backfill-entity-links.js [--dry-run]
//
// --dry-run: runs the full scan/link logic inside a transaction per group,
// then ROLLS BACK instead of committing, and does NOT record the completion
// marker (so a real run can still follow it).

import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { initDatabase, closeDatabase } from '../lib/db.js'
import * as store from '../lib/memoryStore.js'
import { linkCoOccurringEntities, isJunkEntityName } from '../lib/entityLinker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const BACKFILL_SOURCE = 'entity_link_backfill'
export const ENTITIES_PER_GROUP_CAP = 500
export const MEMORIES_PER_ENTITY = 50
export const TOTAL_NEW_ROWS_CAP = 5000

function escapeFtsPhrase(name) {
  // Wrap as a double-quoted FTS phrase, doubling embedded quotes, so names
  // containing hyphens/operators/quotes never crash MATCH syntax.
  return `"${String(name).replace(/"/g, '""')}"`
}

export function alreadyCompleted(db) {
  return db.prepare(`
    SELECT * FROM migrations WHERE source = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1
  `).get(BACKFILL_SOURCE) || null
}

function countCoOccurRows(db) {
  return db.prepare(`SELECT COUNT(*) as c FROM entity_relations WHERE relation_type = 'co_occurs_with'`).get().c
}

/**
 * Runs the bounded FTS co-mention backfill against an already-open db.
 * Testable in isolation — does not check/record the migrations-marker
 * guard itself; callers (the CLI entry point below) own that decision.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {(msg: string) => void} [opts.log]
 */
export function runBackfill(db, { dryRun = false, log = () => {} } = {}) {
  const summary = {
    groups_processed: 0,
    documents_processed: 0,
    pairs_linked: 0,
    pairs_skipped: 0,
    stopped_early: false
  }

  const rowsBefore = countCoOccurRows(db)
  const groups = db.prepare(`SELECT DISTINCT org_id, user_id FROM entities`).all()

  for (const { org_id, user_id } of groups) {
    if (summary.pairs_linked >= TOTAL_NEW_ROWS_CAP) {
      summary.stopped_early = true
      break
    }

    const entities = db.prepare(`
      SELECT id, name, entity_type, reference_count, first_seen
      FROM entities
      WHERE org_id = ? AND user_id = ?
      ORDER BY reference_count DESC
      LIMIT ?
    `).all(org_id, user_id, ENTITIES_PER_GROUP_CAP)

    const survivors = entities.filter((e) => !isJunkEntityName(e.name))
    if (survivors.length < 2) continue

    db.exec('BEGIN')
    try {
      // Document type 1: memories that FTS-co-mention 2+ survivor entities.
      const memoryEntityMap = new Map() // memory_id -> Set(entity_id)
      for (const entity of survivors) {
        try {
          const phrase = escapeFtsPhrase(entity.name)
          const hits = db.prepare(`
            SELECT m.id as memory_id
            FROM memories_fts
            JOIN memories m ON m.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ? AND m.org_id = ? AND m.user_id = ?
            LIMIT ?
          `).all(phrase, org_id, user_id, MEMORIES_PER_ENTITY)

          for (const hit of hits) {
            if (!memoryEntityMap.has(hit.memory_id)) memoryEntityMap.set(hit.memory_id, new Set())
            memoryEntityMap.get(hit.memory_id).add(entity.id)
          }
        } catch (err) {
          log(`[backfill] FTS match failed for entity "${entity.name}" (${org_id}/${user_id}): ${err.message}`)
        }
      }

      for (const [memoryId, entityIdSet] of memoryEntityMap) {
        if (entityIdSet.size < 2) continue
        if (summary.pairs_linked >= TOTAL_NEW_ROWS_CAP) { summary.stopped_early = true; break }
        const result = linkCoOccurringEntities(db, {
          org_id, user_id,
          entityIds: [...entityIdSet],
          sourceKind: 'backfill',
          sourceRef: memoryId
        })
        summary.documents_processed++
        summary.pairs_linked += result.pairs_linked
        summary.pairs_skipped += result.pairs_skipped
      }

      // Document type 2: entities sharing an identical first_seen timestamp
      // (same batch-insert pattern) — one extra co-occurrence document per
      // distinct first_seen value among survivors.
      const byFirstSeen = new Map()
      for (const e of survivors) {
        if (!byFirstSeen.has(e.first_seen)) byFirstSeen.set(e.first_seen, [])
        byFirstSeen.get(e.first_seen).push(e.id)
      }
      for (const [firstSeen, ids] of byFirstSeen) {
        if (ids.length < 2) continue
        if (summary.pairs_linked >= TOTAL_NEW_ROWS_CAP) { summary.stopped_early = true; break }
        const result = linkCoOccurringEntities(db, {
          org_id, user_id,
          entityIds: ids,
          sourceKind: 'backfill',
          sourceRef: `first_seen:${firstSeen}`
        })
        summary.documents_processed++
        summary.pairs_linked += result.pairs_linked
        summary.pairs_skipped += result.pairs_skipped
      }

      if (dryRun) {
        db.exec('ROLLBACK')
      } else {
        db.exec('COMMIT')
      }
      summary.groups_processed++
    } catch (err) {
      db.exec('ROLLBACK')
      log(`[backfill] Group ${org_id}/${user_id} failed, rolled back: ${err.message}`)
    }

    if (summary.stopped_early) break
  }

  summary.relation_rows_before = rowsBefore
  summary.relation_rows_after = dryRun ? rowsBefore : countCoOccurRows(db)
  return summary
}

// ─── CLI entry point ────────────────────────────────────────────────────────
// Only runs when executed directly: node scripts/backfill-entity-links.js
if (process.argv[1] === __filename) {
  const dryRun = process.argv.includes('--dry-run')
  const dbPath = process.env.DB_PATH
    ? resolve(process.env.DB_PATH)
    : resolve(__dirname, '..', 'data', 'memory.db')

  const db = initDatabase(dbPath)

  const existing = alreadyCompleted(db)
  if (existing) {
    console.log(`[backfill] Already completed at ${existing.completed_at} (migration id ${existing.id}). Nothing to do.`)
    closeDatabase()
    process.exit(0)
  }

  console.log(`[backfill] Starting${dryRun ? ' (DRY RUN — no changes will be committed)' : ''}...`)

  let migration = null
  if (!dryRun) {
    migration = store.createMigration({ user_id: '__system__', source: BACKFILL_SOURCE, memories_count: 0, entities_count: 0 })
  }

  try {
    const summary = runBackfill(db, { dryRun, log: console.log })
    console.log('[backfill] Summary:', JSON.stringify(summary, null, 2))

    if (!dryRun) {
      store.completeMigration(migration.id)
      console.log('[backfill] Marked complete. This script will no-op on future runs.')
    } else {
      console.log('[backfill] Dry run complete — no rows were committed, no completion marker recorded.')
    }
    closeDatabase()
  } catch (err) {
    console.error('[backfill] Failed:', err.message)
    if (migration) store.completeMigration(migration.id, err.message)
    closeDatabase()
    process.exit(1)
  }
}
