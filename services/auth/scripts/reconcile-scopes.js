/**
 * Repair orgs, divisions and departments that have no scope row.
 *
 * WHY
 * ---
 * Two paths created an organisation and only one built its scope tree.
 * routes/setup.js, the first-run wizard, wrote the orgs row and nothing else,
 * so every instance bootstrapped that way was silently broken from first boot:
 * divisions got no scope, departments failed 500 "Division scope not found",
 * and no scope assistant was ever created, which shows up as an empty agent
 * picker.
 *
 * That is fixed going forward (utils/orgScaffolding.js, used by setup.js), but
 * a fix in the creation path does nothing for rows that already exist.
 * Instances do not self-heal. This is the sweep for them.
 *
 * It also repairs divisions and departments whose scope is missing for the same
 * reason, which on the development instance is 28 divisions.
 *
 * SAFETY
 * ------
 * - DRY RUN BY DEFAULT. Pass --apply to write. These are live databases.
 * - Purely additive. Nothing is deleted or overwritten; every piece is checked
 *   before it is created, so re-running converges rather than duplicating.
 * - Skips soft-deleted rows, and skips the tombstoned __instance__ pseudo-org,
 *   which is deliberately kept out of every listing and must not be scaffolded.
 * - Each entity is repaired in its own transaction, so one bad row cannot roll
 *   back the whole sweep.
 *
 * USAGE
 * -----
 *   node scripts/reconcile-scopes.js            # report what is missing
 *   node scripts/reconcile-scopes.js --apply
 */

import { getDb, prepare } from '../db/index.js';
import { createScope, getScopeForEntity } from '../utils/scopes.js';
import { ulid } from '../utils/helpers.js';
import { bootstrapOrgScaffolding } from '../utils/orgScaffolding.js';
import {
    generateDivisionAssistantPersona,
    generateDivisionAssistantName,
    generateDepartmentAssistantPersona,
    generateDepartmentAssistantName,
} from '../utils/scopeAssistantTemplates.js';
import { buildAssistantPersistencePayload } from '../routes/assistantLlm.js';

const APPLY = process.argv.includes('--apply');
const INSTANCE_ORG_ID = '__instance__';

const db = getDb();
const tally = { orgs: 0, divisions: 0, departments: 0, assistants: 0, skipped: 0, failed: 0 };

function slugify(name) {
    return String(name || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scope';
}

/** Create a team plus its scope under an existing parent scope. */
function ensureTeam(orgId, parentScope, label, ownerId) {
    const existing = db.prepare(
        'SELECT id FROM teams WHERE org_id = ? AND attach_scope_id = ?'
    ).get(orgId, parentScope.id);
    if (existing) return existing.id;

    const teamId = ulid();
    prepare(`
        INSERT INTO teams (id, org_id, name, slug, description, parent_team_id, attach_scope_id, settings_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(teamId, orgId, `${label} Team`, `${slugify(label)}-team-${teamId.slice(-6).toLowerCase()}`,
           `Auto-created team for ${label}`, null, parentScope.id,
           JSON.stringify({ created_by: ownerId || 'system', auto_created: true, reconciled: true }));
    createScope(orgId, 'team', teamId, parentScope.id, `${label} Team`);
    return teamId;
}

/** Create the scope assistant for a scope, if it has none. */
function ensureAssistant(orgId, scope, { name, slug, description, persona }, ownerId) {
    const existing = db.prepare('SELECT id FROM assistants WHERE home_scope_id = ?').get(scope.id);
    if (existing) return false;

    const persistence = buildAssistantPersistencePayload({ persona });
    prepare(`
        INSERT INTO assistants (id, org_id, home_scope_id, name, slug, description,
            persona_json, model_id, model_config_json, status, created_by, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
    `).run(ulid(), orgId, scope.id, name, slug, description,
           persistence.personaJson, persistence.modelId, persistence.modelConfigJson,
           ownerId || 'system');
    tally.assistants += 1;
    return true;
}

console.log(`\nScope reconciler`);
console.log(`  mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}\n`);

// ---------------------------------------------------------------------- orgs
const orgs = db.prepare(
    `SELECT o.id, o.name, o.owner_user_id FROM orgs o
     WHERE o.deleted_at IS NULL AND o.id != ?
       AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.scope_type='org' AND s.ref_id=o.id)`
).all(INSTANCE_ORG_ID);

console.log(`Orgs missing scaffolding: ${orgs.length}`);
for (const org of orgs) {
    if (!APPLY) { console.log(`  + would repair org ${org.name} (${org.id})`); continue; }
    try {
        db.transaction(() => {
            const result = bootstrapOrgScaffolding({
                orgId: org.id, orgName: org.name, userId: org.owner_user_id
            });
            console.log(`  + repaired org ${org.name}: ${result.created.join(', ') || 'nothing missing'}`);
        })();
        tally.orgs += 1;
    } catch (error) {
        console.log(`  ! org ${org.name} failed: ${error.message}`);
        tally.failed += 1;
    }
}

// ----------------------------------------------------------------- divisions
const divisions = db.prepare(
    `SELECT d.id, d.org_id, d.name, d.created_by, o.name AS org_name
     FROM divisions d JOIN orgs o ON o.id = d.org_id
     WHERE d.deleted_at IS NULL AND o.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.scope_type='division' AND s.ref_id=d.id)`
).all();

console.log(`\nDivisions missing a scope: ${divisions.length}`);
for (const division of divisions) {
    const orgScope = getScopeForEntity('org', division.org_id);
    if (!orgScope) {
        // Only reachable in a dry run, where the org repair above did not
        // actually happen yet. Say so rather than looking like a failure.
        console.log(`  ? ${division.name}: org scope not present yet${APPLY ? '' : ' (expected in a dry run)'}`);
        tally.skipped += 1;
        continue;
    }
    if (!APPLY) { console.log(`  + would repair division ${division.name}`); continue; }
    try {
        db.transaction(() => {
            const scope = createScope(division.org_id, 'division', division.id, orgScope.id, division.name);
            ensureTeam(division.org_id, scope, division.name, division.created_by);
            ensureAssistant(division.org_id, scope, {
                name: generateDivisionAssistantName(division.name, division.org_name || 'Organization'),
                slug: `${slugify(division.name)}-assistant-${division.id.slice(-6).toLowerCase()}`,
                description: `AI assistant for ${division.name} division`,
                persona: generateDivisionAssistantPersona(division.name, division.org_name || 'Organization'),
            }, division.created_by);
        })();
        console.log(`  + repaired division ${division.name}`);
        tally.divisions += 1;
    } catch (error) {
        console.log(`  ! division ${division.name} failed: ${error.message}`);
        tally.failed += 1;
    }
}

// --------------------------------------------------------------- departments
const departments = db.prepare(
    `SELECT dp.id, dp.org_id, dp.name, dp.division_id, dp.created_by,
            dv.name AS division_name, o.name AS org_name
     FROM departments dp
     JOIN divisions dv ON dv.id = dp.division_id
     JOIN orgs o ON o.id = dp.org_id
     WHERE dp.deleted_at IS NULL AND dv.deleted_at IS NULL AND o.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.scope_type='department' AND s.ref_id=dp.id)`
).all();

console.log(`\nDepartments missing a scope: ${departments.length}`);
for (const department of departments) {
    const divisionScope = getScopeForEntity('division', department.division_id);
    if (!divisionScope) {
        console.log(`  ? ${department.name}: division scope not present yet${APPLY ? '' : ' (expected in a dry run)'}`);
        tally.skipped += 1;
        continue;
    }
    if (!APPLY) { console.log(`  + would repair department ${department.name}`); continue; }
    try {
        db.transaction(() => {
            const scope = createScope(department.org_id, 'department', department.id,
                                      divisionScope.id, department.name);
            ensureTeam(department.org_id, scope, department.name, department.created_by);
            ensureAssistant(department.org_id, scope, {
                name: generateDepartmentAssistantName(department.name, department.org_name || 'Organization'),
                slug: `${slugify(department.name)}-assistant-${department.id.slice(-6).toLowerCase()}`,
                description: `AI assistant for ${department.name} department`,
                persona: generateDepartmentAssistantPersona(
                    department.name, department.division_name || '', department.org_name || 'Organization'),
            }, department.created_by);
        })();
        console.log(`  + repaired department ${department.name}`);
        tally.departments += 1;
    } catch (error) {
        console.log(`  ! department ${department.name} failed: ${error.message}`);
        tally.failed += 1;
    }
}

// ------------------------------------------------------------------- summary
const remaining = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM orgs o WHERE o.deleted_at IS NULL AND o.id != '${INSTANCE_ORG_ID}'
          AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.scope_type='org' AND s.ref_id=o.id)) AS orgs,
       (SELECT COUNT(*) FROM divisions d WHERE d.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.scope_type='division' AND s.ref_id=d.id)) AS divisions,
       (SELECT COUNT(*) FROM departments dp WHERE dp.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.scope_type='department' AND s.ref_id=dp.id)) AS departments`
).get();

console.log(`\n  repaired: ${JSON.stringify(tally)}`);
console.log(`  still missing a scope: ${JSON.stringify(remaining)}`);
if (!APPLY) console.log(`\n  DRY RUN. Nothing was written. Re-run with --apply.\n`);
else console.log();

process.exit(tally.failed > 0 ? 1 : 0);
