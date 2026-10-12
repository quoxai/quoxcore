/**
 * Database initialization script for Quox Auth Service
 * Run with: npm run init-db
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default to ./data/auth.db (relative to auth service root)
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');

// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

console.log(`Initializing database at: ${DB_PATH}`);

// Create database with WAL mode for better concurrency
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Read and execute schema
const schemaPath = join(__dirname, 'schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');

try {
    db.exec(schema);
    console.log('Schema applied successfully');

    // Verify tables were created
    const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table'
        ORDER BY name
    `).all();

    console.log('\nTables created:');
    tables.forEach(t => console.log(`  - ${t.name}`));

    // Count indexes
    const indexes = db.prepare(`
        SELECT COUNT(*) as count FROM sqlite_master
        WHERE type='index'
    `).get();

    console.log(`\nIndexes created: ${indexes.count}`);

} catch (err) {
    console.error('Error applying schema:', err.message);
    process.exit(1);
} finally {
    db.close();
}

console.log('\nDatabase initialization complete.');
