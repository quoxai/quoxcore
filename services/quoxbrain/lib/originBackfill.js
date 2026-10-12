// originBackfill.js — ONE-BRAIN coherence Phase A1 (QuoxPlan #493)
//
// Parses a note's rel_path into {originStore, originId} for the
// migrations/009-origin-provenance.sql columns, and backfills existing rows
// on boot. Two known conventions today (see the evidence gathered before
// this stream — services/collector/lib/feedWisdomSource.js /
// feedMemorySource.js render docs with these exact relPath shapes):
//
//   tasks_execution_wisdom/<ulid>.md  -> origin_store='wisdom', origin_id=<ulid>
//   memory/<ulid>.md                  -> origin_store='memory', origin_id=<ulid>
//
// Every other rel_path (including memory/<non-ulid>.md — the "Agent Memory"
// filesystem vault uses plain filenames like memory/MEMORY.md, and
// memory/identity/<namespace>.md carries a namespace, not an id) leaves
// both columns NULL. This is deliberate: guessing an origin for a filename
// that doesn't match a known id convention would be worse than no
// provenance at all (a false link is harder to distrust later than a
// missing one).

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i

/**
 * @param {string} relPath
 * @returns {{originStore: string|null, originId: string|null}}
 */
export function parseOriginFromRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return { originStore: null, originId: null }

  const match = relPath.match(/^(tasks_execution_wisdom|memory)\/([^/]+)\.md$/)
  if (!match) return { originStore: null, originId: null }

  const [, folder, basename] = match
  if (!ULID_RE.test(basename)) return { originStore: null, originId: null }

  return { originStore: folder === 'tasks_execution_wisdom' ? 'wisdom' : 'memory', originId: basename }
}

/**
 * Backfills origin_store/origin_id for existing notes whose rel_path
 * matches a known convention (see parseOriginFromRelPath). Idempotent and
 * safe to run on every boot: only touches rows where origin_store IS NULL,
 * so a note already stamped (by a push doc that set originStore/originId
 * at write time, or a previous backfill run) is never overwritten.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {(msg: string) => void} [log]
 * @returns {{wisdom: number, memory: number, total: number}}
 */
export function backfillOrigins(db, log = console.log) {
  const rows = db.prepare('SELECT id, rel_path FROM notes WHERE origin_store IS NULL').all()

  const counts = { wisdom: 0, memory: 0, total: 0 }
  const update = db.prepare('UPDATE notes SET origin_store = ?, origin_id = ? WHERE id = ?')

  const tx = db.transaction(() => {
    for (const row of rows) {
      const { originStore, originId } = parseOriginFromRelPath(row.rel_path)
      if (!originStore) continue
      update.run(originStore, originId, row.id)
      counts[originStore] = (counts[originStore] || 0) + 1
      counts.total += 1
    }
  })
  tx()

  log(`[originBackfill] scanned ${rows.length} unstamped notes — backfilled: wisdom=${counts.wisdom}, memory=${counts.memory}, total=${counts.total}`)
  return counts
}

export default { parseOriginFromRelPath, backfillOrigins }
