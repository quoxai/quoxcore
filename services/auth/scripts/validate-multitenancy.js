#!/usr/bin/env node
/**
 * Multi-tenancy Migration Validation Script
 * Phase 2: Validates org_id population across all tenant-scoped tables
 *
 * Usage:
 *   node services/auth/scripts/validate-multitenancy.js
 *   node services/auth/scripts/validate-multitenancy.js --fix  # Auto-fix orphaned records
 */

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');

const FIX_MODE = process.argv.includes('--fix');

// Tables that should have org_id with their parent table reference
const TABLES_TO_VALIDATE = [
    // Tier 1: Critical
    { table: 'team_memberships', parent: 'teams', parentIdCol: 'team_id' },
    { table: 'message_reactions', parent: 'messages', parentIdCol: 'message_id' },
    { table: 'conversation_participants', parent: 'conversations', parentIdCol: 'conversation_id' },

    // Tier 2: Version tables
    { table: 'tool_versions', parent: 'tools', parentIdCol: 'tool_id' },
    { table: 'workflow_versions', parent: 'workflows', parentIdCol: 'workflow_id' },
    { table: 'assistant_versions', parent: 'assistants', parentIdCol: 'assistant_id' },
    { table: 'workflow_steps', parent: 'workflows', parentIdCol: 'workflow_id' },

    // Tier 2: HITL/Inbox
    { table: 'run_events', parent: 'runs', parentIdCol: 'run_id' },
    {
        table: 'inbox_item_assignees',
        parent: null, // Complex join
        fixQuery: `
            UPDATE inbox_item_assignees
            SET org_id = (
                SELECT i.org_id FROM inbox_items ii
                JOIN inboxes i ON ii.inbox_id = i.id
                WHERE ii.id = inbox_item_assignees.inbox_item_id
            )
            WHERE org_id IS NULL
        `
    },
    {
        table: 'escalation_stages',
        parent: null, // Complex join
        fixQuery: `
            UPDATE escalation_stages
            SET org_id = (
                SELECT i.org_id FROM inbox_items ii
                JOIN inboxes i ON ii.inbox_id = i.id
                WHERE ii.id = escalation_stages.inbox_item_id
            )
            WHERE org_id IS NULL
        `
    },

    // Tier 2: Other
    { table: 'asset_tags', parent: null } // Manual backfill needed
];

// Tables that should always have org_id (parent tables)
const PARENT_TABLES = [
    'orgs',           // Self-referential
    'teams',
    'conversations',
    'messages',
    'tools',
    'workflows',
    'assistants',
    'runs',
    'inboxes',
    'inbox_items'
];

function main() {
    if (!existsSync(DB_PATH)) {
        console.error(`Database not found at ${DB_PATH}`);
        process.exit(1);
    }

    const db = new Database(DB_PATH, { readonly: !FIX_MODE });

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  QUOX MULTI-TENANCY MIGRATION VALIDATION');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Database: ${DB_PATH}`);
    console.log(`Mode: ${FIX_MODE ? 'FIX (will update records)' : 'VALIDATE (read-only)'}`);
    console.log('');

    let totalIssues = 0;
    let totalFixed = 0;

    // 1. Check parent tables have org_id column
    console.log('1. CHECKING PARENT TABLES HAVE org_id COLUMN');
    console.log('───────────────────────────────────────────────────────────────');

    for (const table of PARENT_TABLES) {
        const tableExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name=?
        `).get(table);

        if (!tableExists) {
            console.log(`   ⚪ ${table} - table does not exist (OK if feature not used)`);
            continue;
        }

        const hasOrgId = db.prepare(`
            SELECT 1 FROM pragma_table_info(?) WHERE name = 'org_id'
        `).get(table);

        if (hasOrgId) {
            console.log(`   ✓ ${table} - has org_id column`);
        } else if (table === 'orgs') {
            console.log(`   ✓ ${table} - is the org table itself`);
        } else {
            console.log(`   ✗ ${table} - MISSING org_id column`);
            totalIssues++;
        }
    }
    console.log('');

    // 2. Check child tables have org_id and are populated
    console.log('2. CHECKING CHILD TABLES org_id POPULATION');
    console.log('───────────────────────────────────────────────────────────────');

    for (const config of TABLES_TO_VALIDATE) {
        const { table, parent, parentIdCol, fixQuery } = config;

        const tableExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name=?
        `).get(table);

        if (!tableExists) {
            console.log(`   ⚪ ${table} - table does not exist (OK if feature not used)`);
            continue;
        }

        const hasOrgId = db.prepare(`
            SELECT 1 FROM pragma_table_info(?) WHERE name = 'org_id'
        `).get(table);

        if (!hasOrgId) {
            console.log(`   ✗ ${table} - MISSING org_id column (run migration)`);
            totalIssues++;
            continue;
        }

        // Count total and null org_id records
        const counts = db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN org_id IS NULL THEN 1 ELSE 0 END) as null_count
            FROM ${table}
        `).get();

        if (counts.total === 0) {
            console.log(`   ✓ ${table} - empty table`);
            continue;
        }

        if (counts.null_count === 0) {
            console.log(`   ✓ ${table} - ${counts.total} records, all have org_id`);
            continue;
        }

        // Has records with null org_id
        console.log(`   ⚠ ${table} - ${counts.null_count}/${counts.total} records have NULL org_id`);
        totalIssues += counts.null_count;

        // Try to fix if in fix mode
        if (FIX_MODE) {
            if (fixQuery) {
                // Use custom fix query
                const result = db.prepare(fixQuery).run();
                console.log(`     → Fixed ${result.changes} records with custom query`);
                totalFixed += result.changes;
            } else if (parent && parentIdCol) {
                // Use standard parent lookup
                const result = db.prepare(`
                    UPDATE ${table}
                    SET org_id = (SELECT org_id FROM ${parent} WHERE ${parent}.id = ${table}.${parentIdCol})
                    WHERE org_id IS NULL
                `).run();
                console.log(`     → Fixed ${result.changes} records from ${parent}.${parentIdCol}`);
                totalFixed += result.changes;
            } else {
                console.log(`     → Cannot auto-fix: no parent relationship defined`);
            }
        }
    }
    console.log('');

    // 3. Check for orphaned records (child records with no matching parent)
    console.log('3. CHECKING FOR ORPHANED RECORDS');
    console.log('───────────────────────────────────────────────────────────────');

    const orphanChecks = [
        { table: 'team_memberships', parent: 'teams', col: 'team_id' },
        { table: 'message_reactions', parent: 'messages', col: 'message_id' },
        { table: 'conversation_participants', parent: 'conversations', col: 'conversation_id' },
        { table: 'tool_versions', parent: 'tools', col: 'tool_id' },
        { table: 'workflow_versions', parent: 'workflows', col: 'workflow_id' },
        { table: 'workflow_steps', parent: 'workflows', col: 'workflow_id' },
        { table: 'run_events', parent: 'runs', col: 'run_id' }
    ];

    for (const { table, parent, col } of orphanChecks) {
        const tableExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name=?
        `).get(table);

        const parentExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name=?
        `).get(parent);

        if (!tableExists || !parentExists) continue;

        const orphans = db.prepare(`
            SELECT COUNT(*) as count FROM ${table}
            WHERE ${col} NOT IN (SELECT id FROM ${parent})
        `).get();

        if (orphans.count === 0) {
            console.log(`   ✓ ${table} - no orphaned records`);
        } else {
            console.log(`   ⚠ ${table} - ${orphans.count} orphaned records (no matching ${parent})`);
            totalIssues += orphans.count;
        }
    }
    console.log('');

    // 4. Check indexes exist
    console.log('4. CHECKING INDEXES');
    console.log('───────────────────────────────────────────────────────────────');

    for (const config of TABLES_TO_VALIDATE) {
        const { table } = config;

        const tableExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name=?
        `).get(table);

        if (!tableExists) continue;

        const hasIndex = db.prepare(`
            SELECT name FROM sqlite_master
            WHERE type='index' AND tbl_name=? AND name LIKE '%org%'
        `).get(table);

        if (hasIndex) {
            console.log(`   ✓ ${table} - has org index (${hasIndex.name})`);
        } else {
            console.log(`   ⚠ ${table} - missing org index (may impact query performance)`);
        }
    }
    console.log('');

    // Summary
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');

    if (totalIssues === 0) {
        console.log('  ✓ All checks passed! Multi-tenancy migration is complete.');
    } else {
        console.log(`  ⚠ Found ${totalIssues} issues.`);
        if (FIX_MODE) {
            console.log(`  ✓ Fixed ${totalFixed} records.`);
            if (totalIssues - totalFixed > 0) {
                console.log(`  ⚠ ${totalIssues - totalFixed} issues remain (may need manual intervention).`);
            }
        } else {
            console.log('  Run with --fix to auto-repair where possible.');
        }
    }
    console.log('');

    db.close();
    process.exit(totalIssues === 0 || (FIX_MODE && totalFixed === totalIssues) ? 0 : 1);
}

main();
