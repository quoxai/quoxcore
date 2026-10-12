/**
 * Backfill scope assistants for existing scopes that don't have one.
 * Run inside the auth environment: node services/auth/scripts/backfill-scope-assistants.js
 */

import { getDb, prepare } from '../db/index.js';
import { ulid } from '../utils/helpers.js';
import {
    generateOrgAssistantPersona,
    generateDivisionAssistantPersona,
    generateDepartmentAssistantPersona,
    generateOrgAssistantName,
    generateDivisionAssistantName,
    generateDepartmentAssistantName,
} from '../utils/scopeAssistantTemplates.js';
import { buildAssistantPersistencePayload } from '../routes/assistantLlm.js';

const db = getDb();
let created = 0;

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function insertScopeAssistant({ id, orgId, scopeId, name, slug, description, persona }) {
    const persistence = buildAssistantPersistencePayload({ persona });
    prepare(`
        INSERT INTO assistants (
            id, org_id, home_scope_id, name, slug, description,
            persona_json, model_id, model_config_json, status, created_by, published_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'system', datetime('now'))
    `).run(
        id,
        orgId,
        scopeId,
        name,
        slug,
        description,
        persistence.personaJson,
        persistence.modelId,
        persistence.modelConfigJson
    );
}

// --- Org scopes ---
const orgScopes = prepare(
    "SELECT s.id, s.ref_id, s.name_cache, o.id as org_id FROM scopes s JOIN orgs o ON o.id = s.ref_id WHERE s.scope_type = 'org'"
).all();
console.log('Org scopes:', orgScopes.length);

for (const scope of orgScopes) {
    const existing = prepare('SELECT id FROM assistants WHERE home_scope_id = ?').get(scope.id);
    if (existing) {
        console.log('  Skip', scope.name_cache, '- already has assistant');
        continue;
    }

    insertScopeAssistant({
        id: ulid(),
        orgId: scope.org_id,
        scopeId: scope.id,
        name: generateOrgAssistantName(scope.name_cache),
        slug: `${slugify(scope.name_cache)}-assistant`,
        description: `AI assistant for ${scope.name_cache}`,
        persona: generateOrgAssistantPersona(scope.name_cache),
    });
    console.log('  Created org assistant:', scope.name_cache);
    created++;
}

// --- Division scopes ---
const divScopes = prepare("SELECT s.id, s.ref_id, s.name_cache, s.parent_scope_id FROM scopes s WHERE s.scope_type = 'division'").all();
console.log('Division scopes:', divScopes.length);

for (const scope of divScopes) {
    const existing = prepare('SELECT id FROM assistants WHERE home_scope_id = ?').get(scope.id);
    if (existing) continue;

    const parentScope = prepare('SELECT name_cache, ref_id FROM scopes WHERE id = ?').get(scope.parent_scope_id);
    const orgName = parentScope ? parentScope.name_cache : 'Organization';
    const orgId = parentScope ? parentScope.ref_id : null;

    insertScopeAssistant({
        id: ulid(),
        orgId,
        scopeId: scope.id,
        name: generateDivisionAssistantName(scope.name_cache, orgName),
        slug: `${slugify(scope.name_cache)}-assistant`,
        description: `AI assistant for ${scope.name_cache} division`,
        persona: generateDivisionAssistantPersona(scope.name_cache, orgName),
    });
    console.log('  Created division assistant:', scope.name_cache);
    created++;
}

// --- Department scopes ---
const deptScopes = prepare("SELECT s.id, s.ref_id, s.name_cache, s.parent_scope_id FROM scopes s WHERE s.scope_type = 'department'").all();
console.log('Department scopes:', deptScopes.length);

for (const scope of deptScopes) {
    const existing = prepare('SELECT id FROM assistants WHERE home_scope_id = ?').get(scope.id);
    if (existing) continue;

    const divScope = prepare('SELECT name_cache, parent_scope_id FROM scopes WHERE id = ?').get(scope.parent_scope_id);
    const divName = divScope ? divScope.name_cache : 'Division';
    let orgName = 'Organization';
    let orgId = null;
    if (divScope) {
        const orgScope = prepare('SELECT name_cache, ref_id FROM scopes WHERE id = ?').get(divScope.parent_scope_id);
        if (orgScope) {
            orgName = orgScope.name_cache;
            orgId = orgScope.ref_id;
        }
    }

    insertScopeAssistant({
        id: ulid(),
        orgId,
        scopeId: scope.id,
        name: generateDepartmentAssistantName(scope.name_cache, orgName),
        slug: `${slugify(scope.name_cache)}-assistant`,
        description: `AI assistant for ${scope.name_cache} department`,
        persona: generateDepartmentAssistantPersona(scope.name_cache, divName, orgName),
    });
    console.log('  Created department assistant:', scope.name_cache);
    created++;
}

console.log('\nTotal created:', created);
