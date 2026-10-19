#!/usr/bin/env node
/**
 * Seed Tool Definitions
 *
 * Reads tool manifests from src/config/entities/tools/ and inserts them
 * into the tool_definitions table.
 *
 * Usage:
 *   node scripts/seed-tools.js
 *   AUTH_DB_PATH=/path/to/db node scripts/seed-tools.js
 */

import { readFileSync, readdirSync } from 'fs';
import { manifestToRows } from '../lib/toolCatalogSeed.js';
import { getUnavailableToolIds } from '../lib/unavailableTools.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database path
const DB_PATH = process.env.AUTH_DB_PATH || '/var/lib/quox/auth.db';

// Tool manifests directory (relative to project root, or override with env var)
const TOOLS_DIR = process.env.TOOLS_DIR || join(__dirname, '../../../src/config/entities/tools');

// Row building is shared with the auth boot seed (quox#1045). This script is
// the explicit operator REFRESH: unlike the boot seed it overwrites existing
// rows from the manifests.
// Main seed function
async function seedTools() {
    console.log('Tool Definitions Seeder');
    console.log('=======================');
    console.log(`Database: ${DB_PATH}`);
    console.log(`Tools directory: ${TOOLS_DIR}`);
    console.log('');

    // Open database
    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');

    // Check if tool_definitions table exists
    const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='tool_definitions'
    `).get();

    if (!tableExists) {
        console.error('Error: tool_definitions table does not exist.');
        console.error('Please run the Phase B.2 migration first.');
        process.exit(1);
    }

    // Prepare insert statement
    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO tool_definitions (
            id, tool_id, name, description,
            category, subcategory, provider, version,
            spec_json,
            risk_level, sandbox_profile, capabilities_json,
            min_access_level, requires_license, requires_config,
            status, is_core, is_featured,
            icon, documentation_url,
            created_at, updated_at
        ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            datetime('now'), datetime('now')
        )
    `);

    // Read all tool manifests
    let files;
    try {
        files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.json'));
    } catch (err) {
        console.error(`Error reading tools directory: ${err.message}`);
        process.exit(1);
    }

    console.log(`Found ${files.length} tool manifest(s)\n`);

    let totalTools = 0;
    let errors = 0;

    // Process each manifest
    for (const file of files) {
        const filePath = join(TOOLS_DIR, file);
        console.log(`Processing ${file}...`);

        try {
            const manifest = JSON.parse(readFileSync(filePath, 'utf-8'));
            const rows = manifestToRows(manifest);

            for (const row of rows) {
                // quox #1051: declared but not implemented (501); never seed it.
                if (getUnavailableToolIds().has(row.tool_id)) {
                    console.log(`  - ${row.tool_id} (not implemented yet, not seeded)`);
                    continue;
                }
                try {
                    // Check if tool already exists
                    const existing = db.prepare('SELECT id FROM tool_definitions WHERE tool_id = ?').get(row.tool_id);

                    if (existing) {
                        // Update existing
                        row.id = existing.id;
                    }

                    insertStmt.run(
                        row.id,
                        row.tool_id,
                        row.name,
                        row.description,
                        row.category,
                        row.subcategory,
                        row.provider,
                        row.version,
                        row.spec_json,
                        row.risk_level,
                        row.sandbox_profile,
                        row.capabilities_json,
                        row.min_access_level,
                        row.requires_license,
                        row.requires_config,
                        row.status,
                        row.is_core,
                        row.is_featured,
                        row.icon,
                        row.documentation_url
                    );

                    console.log(`  + ${row.tool_id} (${row.name})`);
                    totalTools++;
                } catch (err) {
                    console.error(`  ! Error inserting ${row.tool_id}: ${err.message}`);
                    errors++;
                }
            }
        } catch (err) {
            console.error(`  ! Error processing ${file}: ${err.message}`);
            errors++;
        }
    }

    db.close();

    console.log('');
    console.log('Summary:');
    console.log(`  Total tools seeded: ${totalTools}`);
    console.log(`  Errors: ${errors}`);

    if (errors > 0) {
        process.exit(1);
    }
}

// Run
seedTools().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
