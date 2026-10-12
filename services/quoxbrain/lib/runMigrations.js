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
 * BRAIN2-W5 142: split a migration file into individual statements so a
 * tolerated error (duplicate column / already exists) skips only THAT
 * statement instead of aborting the rest of a multi-statement file.
 * Aware of quotes, comments and CREATE TRIGGER ... BEGIN ... END bodies.
 */
export function splitStatements(sql) {
  const out = []
  let cur = ''
  let i = 0
  let depth = 0 // BEGIN..END nesting (triggers, CASE handled via word match below)
  const n = sql.length
  const flush = () => {
    if (cur.replace(/--[^\n]*/g, '').trim()) out.push(cur.trim())
    cur = ''
    depth = 0
  }
  while (i < n) {
    const c = sql[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue } break }
        j++
      }
      cur += sql.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i); if (j < 0) j = n
      cur += sql.slice(i, j); i = j; continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2); j = j < 0 ? n : j + 2
      cur += sql.slice(i, j); i = j; continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++
      const word = sql.slice(i, j).toUpperCase()
      if (word === 'BEGIN' || word === 'CASE') depth++
      else if (word === 'END' && depth > 0) depth--
      cur += sql.slice(i, j); i = j; continue
    }
    if (c === ';' && depth === 0) { cur += c; flush(); i++; continue }
    cur += c; i++
  }
  flush()
  return out
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {string} deps.migrationsDir
 * @param {(msg: string) => void} [deps.log]
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations({ db, migrationsDir, log = console.log, strictDrift = process.env.QUOXBRAIN_MIGRATION_DRIFT_STRICT === '1' }) {
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
  const drifted = []

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
        drifted.push(file)
      }
      skipped.push(file)
      continue
    }

    log(`[runMigrations] Applying ${file} ...`)
    db.exec('BEGIN')
    try {
      // BRAIN2-W5 142: per-statement; a tolerated error skips only that
      // statement, the remaining statements still run. The file is recorded
      // applied only if every statement succeeded or was tolerated.
      for (const stmt of splitStatements(content)) {
        try {
          db.exec(stmt)
        } catch (err) {
          if (TOLERATED_ERROR.test(err.message)) {
            log(`[runMigrations] ${file}: tolerated no-op (${err.message})`)
          } else {
            throw err
          }
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

  // BRAIN2-W7 C 143: drift is always reported in the return value; with
  // QUOXBRAIN_MIGRATION_DRIFT_STRICT=1 it aborts boot instead of warning only.
  if (strictDrift && drifted.length > 0) {
    throw new Error(`[runMigrations] migration drift in already-applied files: ${drifted.join(', ')}`)
  }
  log(`[runMigrations] Done — applied: ${applied.length}, skipped: ${skipped.length}`)
  return { applied, skipped, drifted }
}

/** Resolves the migrations directory relative to a caller's __dirname (e.g. lib/). */
export function findMigrationsDir(callerDir) {
  const dir = path.join(callerDir, '..', 'migrations')
  if (fs.existsSync(dir)) return dir
  throw new Error(`[runMigrations] Cannot locate migrations directory. Tried: ${dir}`)
}
