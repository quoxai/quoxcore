// Database initialization and connection management
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { runMigrations, findMigrationsDir } from '../lib/runMigrations.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let db = null

// Legacy one-time repair, kept OUTSIDE the declarative migration system:
// fixes team_definitions' PK (was id-only, needed (id, org_id) for
// multi-tenant) and team_instances' FK to match, on databases that predate
// the composite-PK schema. This can't be expressed as a plain numbered .sql
// migration because it's conditional on runtime schema introspection
// (SELECT sql FROM sqlite_master) rather than a fixed statement — pure
// SQLite DDL has no IF/branching. It is idempotent (self-guarding: no-ops
// once the composite PK is in place, which 000-baseline.sql already
// creates directly, so this never fires on a fresh DB) and unchanged from
// its original ad-hoc form other than being moved into its own function.
function applyLegacyTeamDefinitionsPkFix(db) {
  try {
    const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_definitions'").get()
    if (info?.sql && info.sql.includes('id TEXT PRIMARY KEY')) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE team_definitions_new (
          id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'core',
          status TEXT NOT NULL DEFAULT 'active',
          installed_by TEXT,
          installed_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (id, org_id)
        );
        INSERT OR REPLACE INTO team_definitions_new SELECT * FROM team_definitions;
        DROP TABLE team_definitions;
        ALTER TABLE team_definitions_new RENAME TO team_definitions;
        CREATE INDEX IF NOT EXISTS idx_team_defs_org ON team_definitions(org_id);
        CREATE INDEX IF NOT EXISTS idx_team_defs_status ON team_definitions(org_id, status);
        PRAGMA foreign_keys = ON;
      `)
      console.log('[Tasks DB] Migrated team_definitions to composite PK (id, org_id)')
    }
    // Also fix team_instances FK to reference composite PK
    const instInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_instances'").get()
    if (instInfo?.sql && instInfo.sql.includes('REFERENCES team_definitions(id)') && !instInfo.sql.includes('REFERENCES team_definitions(id, org_id)')) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE team_instances_new (
          id TEXT PRIMARY KEY,
          team_definition_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle',
          current_objective_id TEXT,
          shared_context_json TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (team_definition_id, org_id) REFERENCES team_definitions(id, org_id),
          FOREIGN KEY (current_objective_id) REFERENCES objectives(id) ON DELETE SET NULL
        );
        INSERT OR REPLACE INTO team_instances_new SELECT * FROM team_instances;
        DROP TABLE team_instances;
        ALTER TABLE team_instances_new RENAME TO team_instances;
        CREATE INDEX IF NOT EXISTS idx_team_inst_def ON team_instances(team_definition_id);
        CREATE INDEX IF NOT EXISTS idx_team_inst_org ON team_instances(org_id);
        CREATE INDEX IF NOT EXISTS idx_team_inst_status ON team_instances(status);
        PRAGMA foreign_keys = ON;
      `)
      console.log('[Tasks DB] Migrated team_instances FK to composite (id, org_id)')
    }
  } catch (e) { console.error('[Tasks DB] team_definitions migration:', e.message) }
}

export function initDatabase(dbPath) {
  if (db) return db

  db = new Database(dbPath, {})

  // Enable WAL mode and foreign keys
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  // TRUST-GATE Phase 3a: versioned schema migrations (schema_migrations
  // table, ordered numbered .sql files in migrations/). Replaces the
  // ad-hoc "exec db/schema.sql + flat migrations[] ALTER loop + scattered
  // CREATE TABLE IF NOT EXISTS blocks" boot sequence. See
  // migrations/000-baseline.sql (current full schema, idempotent) and
  // migrations/001..029-*.sql (folded 1:1 from the old flat ALTER array).
  runMigrations({ db, migrationsDir: findMigrationsDir(__dirname), log: console.log })

  // Runs after migrations so team_definitions/team_instances already exist
  // (created by 000-baseline.sql on a fresh DB, or pre-existing on an old DB).
  applyLegacyTeamDefinitionsPkFix(db)

  console.log('[Tasks DB] Initialized:', dbPath)
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
    console.log('[Tasks DB] Closed')
  }
}

process.on('SIGINT', closeDatabase)
process.on('SIGTERM', closeDatabase)
