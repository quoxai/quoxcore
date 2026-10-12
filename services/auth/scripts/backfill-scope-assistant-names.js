/**
 * Rename auto-generated scope assistants to breadcrumb names.
 *
 * Old generated pattern: '<Scope> Assistant' (e.g. 'Marketing Assistant'),
 * which reads as a useless bare 'Assistant' outside its own scope page.
 * New pattern (utils/scopeAssistantTemplates.js name generators):
 *   division:   '<Org> - <Division> Division Assistant'
 *   department: '<Org> - <Dept> Department Assistant'
 * Org-level assistants already match the target pattern ('<Org> Assistant')
 * and are left untouched.
 *
 * Idempotent: safe to run repeatedly; a second run changes nothing. Renames
 * ONLY assistants whose current name exactly matches the old generated
 * pattern for their scope. Custom-named assistants are never touched.
 *
 * Run inside the auth environment:
 *   node services/auth/scripts/backfill-scope-assistant-names.js [--dry-run]
 */

import { getDb, prepare } from '../db/index.js';
import {
    generateDivisionAssistantName,
    generateDepartmentAssistantName,
} from '../utils/scopeAssistantTemplates.js';

getDb();

const dryRun = process.argv.includes('--dry-run');

let renamed = 0;
let alreadyCorrect = 0;
let skippedCustom = 0;
const errors = [];

// Assistants homed on division/department scopes, with the scope chain
// (parent = division's org, or department's division; grandparent =
// department's org) resolved in one pass.
const rows = prepare(`
    SELECT a.id, a.name,
        s.scope_type, s.name_cache AS scope_name,
        p.name_cache AS parent_name,
        gp.name_cache AS grandparent_name
    FROM assistants a
    JOIN scopes s ON s.id = a.home_scope_id
    LEFT JOIN scopes p ON p.id = s.parent_scope_id
    LEFT JOIN scopes gp ON gp.id = p.parent_scope_id
    WHERE s.scope_type IN ('division', 'department')
`).all();

console.log(`Scope assistants on division/department scopes: ${rows.length}${dryRun ? ' (dry run)' : ''}`);

for (const row of rows) {
    try {
        const orgName = row.scope_type === 'division'
            ? (row.parent_name || 'Organization')
            : (row.grandparent_name || 'Organization');

        const newName = row.scope_type === 'division'
            ? generateDivisionAssistantName(row.scope_name, orgName)
            : generateDepartmentAssistantName(row.scope_name, orgName);

        if (row.name === newName) {
            alreadyCorrect++;
            continue;
        }

        // Only the exact old generated pattern is eligible. Anything else was
        // hand-named by a user and must never be overwritten.
        const oldGeneratedName = `${row.scope_name} Assistant`;
        if (row.name !== oldGeneratedName) {
            skippedCustom++;
            console.log(`  Skip custom-named: "${row.name}" (${row.scope_type} ${row.scope_name})`);
            continue;
        }

        if (!dryRun) {
            prepare("UPDATE assistants SET name = ?, updated_at = datetime('now') WHERE id = ?")
                .run(newName, row.id);
        }
        renamed++;
        console.log(`  Renamed: "${row.name}" -> "${newName}"`);
    } catch (err) {
        errors.push({ id: row.id, error: err.message });
        console.error(`  ERROR renaming ${row.id} ("${row.name}"): ${err.message}`);
    }
}

console.log(`\nDone. renamed=${renamed}${dryRun ? ' (dry run, no writes)' : ''}, alreadyCorrect=${alreadyCorrect}, skippedCustom=${skippedCustom}, errors=${errors.length}`);
if (errors.length > 0) {
    process.exitCode = 1;
}
