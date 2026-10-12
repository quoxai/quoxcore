/**
 * run-migrations.ts — QSKL-FIX slice 1B
 *
 * Applies SQL migration files in lexicographic order at server boot.
 * Uses the same pg.Pool pattern as the rest of the codebase.
 *
 * Container path resolution: tries __dirname-relative first
 * (dev/tsx), then /app/migrations (Docker dist layout).
 * See feedback_container_path_resolution_2026_05_14.md.
 */

import pg from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const { Pool } = pg;

function findMigrationsDir(): string {
  // Dev / tsx: __dirname is src/migrations → go up two levels to repo root
  const devPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../migrations');
  if (fs.existsSync(devPath)) return devPath;

  // Docker dist: compiled output lives under /app/dist, migrations at /app/migrations
  const containerPath = '/app/migrations';
  if (fs.existsSync(containerPath)) return containerPath;

  throw new Error(
    `[run-migrations] Cannot locate migrations directory. ` +
    `Tried: ${devPath}, ${containerPath}`
  );
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface MigrationRunnerDeps {
  /** pg Pool for the quoxflow database. */
  pool: pg.Pool;
  /** Optional: override migrations directory (for testing). */
  migrationsDir?: string;
  /** Optional: override logger (for testing). */
  log?: (msg: string) => void;
}

/**
 * Runs all unapplied SQL migrations in lexicographic order.
 * Idempotent: skips files already recorded in schema_migrations.
 * Aborts with an error if any migration fails.
 */
export async function runMigrations(deps: MigrationRunnerDeps): Promise<{ applied: string[]; skipped: string[] }> {
  const { pool, log = console.log } = deps;
  const migrationsDir = deps.migrationsDir ?? findMigrationsDir();

  const client = await pool.connect();
  try {
    // Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        sha256     TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Enumerate .sql files in lex order
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Load applied rows once
    const { rows: appliedRows } = await client.query<{ filename: string; sha256: string }>(
      'SELECT filename, sha256 FROM schema_migrations'
    );
    const appliedMap = new Map(appliedRows.map((r) => [r.filename, r.sha256]));

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const hash = sha256(content);

      if (appliedMap.has(file)) {
        const storedHash = appliedMap.get(file)!;
        if (storedHash !== hash) {
          // Migration file was modified after being applied — warn loudly, skip
          log(
            `[run-migrations] WARNING: ${file} sha256 mismatch ` +
            `(stored=${storedHash.slice(0, 12)}, current=${hash.slice(0, 12)}). ` +
            `Migration files must be append-only. Skipping.`
          );
        }
        skipped.push(file);
        continue;
      }

      log(`[run-migrations] Applying ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(content);
        await client.query(
          'INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)',
          [file, hash]
        );
        await client.query('COMMIT');
        applied.push(file);
        log(`[run-migrations] Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[run-migrations] Failed to apply ${file}: ${msg}`);
      }
    }

    log(`[run-migrations] Done — applied: ${applied.length}, skipped: ${skipped.length}`);
    return { applied, skipped };
  } finally {
    client.release();
  }
}

/**
 * Creates a pg.Pool from DATABASE_URL and runs migrations.
 * Called at server boot with the same connection string used by all stores.
 */
export async function runMigrationsFromEnv(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await runMigrations({ pool });
  } finally {
    await pool.end();
  }
}
