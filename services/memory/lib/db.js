// Database initialization and connection management
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { runMigrations, findMigrationsDir } from './runMigrations.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let db = null

export function initDatabase(dbPath) {
  if (db) return db

  db = new Database(dbPath, {
    // Enable WAL mode for better concurrent access
    // verbose: process.env.NODE_ENV === 'development' ? console.log : null
  })

  // Enable WAL mode and foreign keys
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  // TRUST-GATE Phase 3a: versioned schema migrations (schema_migrations
  // table, ordered numbered .sql files in migrations/). Replaces the
  // ad-hoc "exec db/schema.sql + catch-and-ignore ALTER" boot sequence.
  // See migrations/000-baseline.sql (current full schema, idempotent) and
  // migrations/001-memory-role-column.sql (folded from the old ad-hoc block).
  runMigrations({ db, migrationsDir: findMigrationsDir(__dirname), log: console.log })

  console.log('[Memory DB] Initialized:', dbPath)
  return db
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.')
  }
  return db
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
    console.log('[Memory DB] Closed')
  }
}

// Graceful shutdown
process.on('SIGINT', closeDatabase)
process.on('SIGTERM', closeDatabase)
