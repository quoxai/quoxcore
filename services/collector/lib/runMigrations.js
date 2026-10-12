// runMigrations.js — collector schema migrations
//
// Applies SQL migration files in lexicographic order at service boot.
// Ported from services/memory/lib/runMigrations.js (TRUST-GATE Phase 3a),
// adapted to this service's CommonJS module style. Behaviour is identical:
//   - schema_migrations tracking table: id, filename, sha256, applied_at
//   - each unapplied migration runs inside its own BEGIN/COMMIT
//   - a file already recorded whose sha256 no longer matches the current
//     file content logs a loud WARNING and is SKIPPED (never re-applied,
//     never hard-fails)
//   - a genuine SQL error rolls back the transaction and throws, aborting
//     boot (fresh-DB ordering bugs must surface immediately)
//
// The collector has MULTIPLE SQLite databases (aee.db, volt.db, feedback.db,
// wazuh.db, plus self-contained tools.db/codebase.db stores). This runner is
// DB-agnostic — call it once per database, each with its own migrationsDir
// (e.g. migrations/aee/, migrations/volt/), so each DB gets its own
// independent schema_migrations table and append-only migration history.
//
// SQLite-specific addition with no Postgres equivalent: SQLite has no
// "ADD COLUMN IF NOT EXISTS", so a migration that ALTERs a column already
// present via 000-baseline.sql (fresh DB) or an earlier manual ALTER
// (already-migrated DB) throws "duplicate column name". That specific error
// — and "already exists" (belt-and-braces for any non-IF-NOT-EXISTS DDL) —
// is tolerated as a no-op rather than a failure.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TOLERATED_ERROR = /already exists|duplicate column name/i;

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {string} deps.migrationsDir
 * @param {(msg: string) => void} [deps.log]
 * @returns {{ applied: string[], skipped: string[] }}
 */
function runMigrations({ db, migrationsDir, log = console.log }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT NOT NULL UNIQUE,
      sha256     TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  const appliedRows = db.prepare('SELECT filename, sha256 FROM schema_migrations').all();
  const appliedMap = new Map(appliedRows.map((r) => [r.filename, r.sha256]));

  const applied = [];
  const skipped = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const hash = sha256(content);

    if (appliedMap.has(file)) {
      const storedHash = appliedMap.get(file);
      if (storedHash !== hash) {
        log(
          `[runMigrations] WARNING: ${file} sha256 mismatch ` +
          `(stored=${storedHash.slice(0, 12)}, current=${hash.slice(0, 12)}). ` +
          `Migration files must be append-only. Skipping.`
        );
      }
      skipped.push(file);
      continue;
    }

    log(`[runMigrations] Applying ${file} ...`);
    db.exec('BEGIN');
    try {
      try {
        db.exec(content);
      } catch (err) {
        if (TOLERATED_ERROR.test(err.message)) {
          log(`[runMigrations] ${file}: tolerated no-op (${err.message})`);
        } else {
          throw err;
        }
      }
      db.prepare('INSERT INTO schema_migrations (filename, sha256) VALUES (?, ?)').run(file, hash);
      db.exec('COMMIT');
      applied.push(file);
      log(`[runMigrations] Applied ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`[runMigrations] Failed to apply ${file}: ${err.message}`);
    }
  }

  log(`[runMigrations] Done — applied: ${applied.length}, skipped: ${skipped.length}`);
  return { applied, skipped };
}

/**
 * Resolves a per-DB migrations directory: services/collector/migrations/<dbKey>/
 * @param {string} dbKey - one of 'aee' | 'volt' | 'feedback' | 'wazuh'
 */
function migrationsDirFor(dbKey) {
  const dir = path.join(__dirname, '..', 'migrations', dbKey);
  if (fs.existsSync(dir)) return dir;
  throw new Error(`[runMigrations] Cannot locate migrations directory for "${dbKey}". Tried: ${dir}`);
}

module.exports = { runMigrations, migrationsDirFor };
