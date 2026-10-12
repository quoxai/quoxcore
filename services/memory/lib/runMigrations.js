// runMigrations.js — TRUST-GATE Phase 3a
//
// Applies SQL migration files in lexicographic order at service boot.
// Mirrors quoxflow's src/migrations/run-migrations.ts contract, adapted for
// better-sqlite3 (synchronous) instead of pg (async):
//   - schema_migrations tracking table: id, filename, sha256, applied_at
//   - each unapplied migration runs inside its own BEGIN/COMMIT
//   - a file already recorded whose sha256 no longer matches the current
//     file content logs a loud WARNING and is SKIPPED (never re-applied,
//     never hard-fails) — same append-only contract as quoxflow
//   - a genuine SQL error rolls back the transaction and throws, aborting
//     boot (this is the point of the exercise: fresh-DB ordering bugs must
//     surface immediately, not get silently swallowed into a crash-loop)
//
// SQLite-specific addition with no Postgres equivalent: SQLite has no
// "ADD COLUMN IF NOT EXISTS" (Postgres does), so a migration that ALTERs a
// column already present via 000-baseline.sql (fresh DB) or an earlier
// manual ALTER (already-migrated DB) throws "duplicate column name". That
// specific error — and "already exists" (belt-and-braces for any
// non-IF-NOT-EXISTS DDL) — is tolerated as a no-op rather than a failure.
// This mirrors the try/catch every ad-hoc ALTER in this codebase already
// used before this runner existed (see services/memory/lib/db.js history).

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const TOLERATED_ERROR = /already exists|duplicate column name/i

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {string} deps.migrationsDir
 * @param {(msg: string) => void} [deps.log]
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations({ db, migrationsDir, log = console.log }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT NOT NULL UNIQUE,
      sha256     TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

  const appliedRows = db.prepare('SELECT filename, sha256 FROM schema_migrations').all()
  const appliedMap = new Map(appliedRows.map((r) => [r.filename, r.sha256]))

  const applied = []
  const skipped = []

  for (const file of files) {
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    const hash = sha256(content)

    if (appliedMap.has(file)) {
      const storedHash = appliedMap.get(file)
      if (storedHash !== hash) {
        log(
          `[runMigrations] WARNING: ${file} sha256 mismatch ` +
          `(stored=${storedHash.slice(0, 12)}, current=${hash.slice(0, 12)}). ` +
          `Migration files must be append-only. Skipping.`
        )
      }
      skipped.push(file)
      continue
    }

    log(`[runMigrations] Applying ${file} ...`)
    db.exec('BEGIN')
    try {
      try {
        db.exec(content)
      } catch (err) {
        if (TOLERATED_ERROR.test(err.message)) {
          log(`[runMigrations] ${file}: tolerated no-op (${err.message})`)
        } else {
          throw err
        }
      }
      db.prepare('INSERT INTO schema_migrations (filename, sha256) VALUES (?, ?)').run(file, hash)
      db.exec('COMMIT')
      applied.push(file)
      log(`[runMigrations] Applied ${file}`)
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`[runMigrations] Failed to apply ${file}: ${err.message}`)
    }
  }

  log(`[runMigrations] Done — applied: ${applied.length}, skipped: ${skipped.length}`)
  return { applied, skipped }
}

/** Resolves the migrations directory relative to a caller's __dirname (e.g. lib/). */
export function findMigrationsDir(callerDir) {
  const dir = path.join(callerDir, '..', 'migrations')
  if (fs.existsSync(dir)) return dir
  throw new Error(`[runMigrations] Cannot locate migrations directory. Tried: ${dir}`)
}
