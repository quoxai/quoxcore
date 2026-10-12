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

import crypto from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database path
const DB_PATH = process.env.AUTH_DB_PATH || '/var/lib/quox/auth.db';

// Tool manifests directory (relative to project root, or override with env var)
const TOOLS_DIR = process.env.TOOLS_DIR || join(__dirname, '../../../src/config/entities/tools');

// Generate ULID-like ID using cryptographically secure randomness
function ulid() {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const time = Date.now().toString(32).toUpperCase().padStart(10, '0');
    // Use cryptographically secure random bytes
    const randomBytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) {
        rand += chars[randomBytes[i] % 32];
    }
    return time + rand;
}

// Load and parse tool manifest
function loadToolManifest(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
}

// Convert tool manifest to database rows
function manifestToRows(manifest) {
    const rows = [];

    // Check if this is a v2 manifest with nested tools
    if (manifest.tools && Array.isArray(manifest.tools)) {
        // This is a tool pack with multiple tools
        for (const tool of manifest.tools) {
            rows.push({
                id: ulid(),
                tool_id: tool.id,
                name: tool.name,
                description: tool.description,
                category: manifest.category || 'uncategorized',
                subcategory: manifest.subcategory || null,
                provider: manifest.provider || null,
                version: manifest.version || '1.0.0',
                spec_json: JSON.stringify({
                    ...tool,
                    // Include parent-level instructions and help
                    instructions: tool.instructions || manifest.instructions,
                    help: manifest.help,
                    agent_hints: manifest.agent_hints,
                    endpoints: manifest.endpoints
                }),
                risk_level: manifest.risk_level || 'low',
                sandbox_profile: manifest.sandbox_profile || 'standard',
                capabilities_json: JSON.stringify(tool.capabilities || []),
                min_access_level: tool.accessLevel || 'specialists+',
                requires_license: manifest.requires_license || null,
                requires_config: manifest.endpoints ? 1 : 0,
                status: 'available',
                is_core: 1,
                is_featured: 0,
                icon: manifest.icon || null,
                documentation_url: manifest.help?.man_url || null
            });
        }
    } else {
        // Single tool manifest (v1 style)
        rows.push({
            id: ulid(),
            tool_id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            category: manifest.category || 'uncategorized',
            subcategory: manifest.subcategory || null,
            provider: manifest.provider || null,
            version: manifest.version || '1.0.0',
            spec_json: JSON.stringify(manifest),
            risk_level: manifest.risk_level || 'low',
            sandbox_profile: manifest.sandbox_profile || 'standard',
            capabilities_json: JSON.stringify(manifest.capabilities || []),
            min_access_level: manifest.accessLevel || 'specialists+',
            requires_license: manifest.requires_license || null,
            requires_config: manifest.endpoints ? 1 : 0,
            status: 'available',
            is_core: 1,
            is_featured: 0,
            icon: manifest.icon || null,
            documentation_url: manifest.help?.man_url || null
        });
    }

    return rows;
}

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
            const manifest = loadToolManifest(filePath);
            const rows = manifestToRows(manifest);

            for (const row of rows) {
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
