/**
 * The scaffolding every organisation needs in order to work.
 *
 * An `orgs` row on its own is not a usable organisation. It also needs:
 *   - an org SCOPE, which is the root of the scope tree and the parent every
 *     division, department and team hangs off
 *   - an org team attached to that scope
 *   - a team scope for it
 *   - an org scope assistant, which is what populates the agent picker
 *
 * This existed only inside routes/orgs.js, so the OTHER path that creates an
 * organisation, the first-run setup wizard in routes/setup.js, produced an org
 * row with none of it. That instance then failed silently and permanently:
 * creating a division wrote the division row, logged "org scope missing" and
 * returned 201 with no scope; creating a department under it failed 500 with
 * "Division scope not found"; and no scope assistant was ever created, because
 * that INSERT is keyed on the division scope. The visible symptom is an empty
 * agent picker on every fresh install.
 *
 * Extracted here so the two paths cannot drift apart again, which is the whole
 * shape of the original bug. routes/setup.js calls it now; routes/orgs.js still
 * has its own inline copy and should be converged onto this once it can be
 * retested properly, since that path currently works and is not worth
 * destabilising in the same change that fixes the broken one.
 *
 * Idempotent by design. The setup wizard can be re-run, and a reconciler for
 * instances that already lack scaffolding needs to be safe to run repeatedly.
 */

import { getDb, prepare } from '../db/index.js';
import { createScope, getScopeForEntity } from './scopes.js';
import { ulid } from './helpers.js';
import { generateOrgAssistantPersona, generateOrgAssistantName } from './scopeAssistantTemplates.js';
import { buildAssistantPersistencePayload } from '../routes/assistantLlm.js';

function slugify(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'org';
}

/**
 * Give an existing org the scope, team and assistant it needs.
 *
 * Safe to call on an org that already has some or all of them: each piece is
 * checked before it is created, so this both bootstraps a new org and repairs
 * one that predates the fix.
 *
 * Callers may already be inside a transaction, so this deliberately does NOT
 * open one of its own; better-sqlite3 does not nest transactions.
 *
 * @param {{orgId: string, orgName: string, userId: string}} params
 * @returns {{orgScope: object, created: string[]}} what existed vs what was made
 */
export function bootstrapOrgScaffolding({ orgId, orgName, userId }) {
    if (!orgId) throw new Error('bootstrapOrgScaffolding requires an orgId');
    const db = getDb();
    const name = orgName || 'Organization';
    const created = [];

    // ---- org scope: the root everything else hangs off
    let orgScope = getScopeForEntity('org', orgId);
    if (!orgScope) {
        orgScope = createScope(orgId, 'org', orgId, null, name);
        created.push('org_scope');
    }

    // ---- org team, attached to the org scope
    let team = db.prepare(
        'SELECT * FROM teams WHERE org_id = ? AND parent_team_id IS NULL LIMIT 1'
    ).get(orgId);

    if (!team) {
        const teamId = ulid();
        prepare(`
            INSERT INTO teams (id, org_id, name, slug, description, parent_team_id, attach_scope_id, settings_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            teamId,
            orgId,
            `${name} Team`,
            `${slugify(name)}-team`,
            `Auto-created team for ${name}`,
            null,
            orgScope.id,
            JSON.stringify({ created_by: userId || 'system', auto_created: true })
        );
        created.push('org_team');
        team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);

        if (!getScopeForEntity('team', teamId)) {
            createScope(orgId, 'team', teamId, orgScope.id, `${name} Team`);
            created.push('team_scope');
        }

        if (userId) {
            prepare(`
                INSERT OR IGNORE INTO team_memberships (id, team_id, user_id, role, status)
                VALUES (?, ?, ?, 'admin', 'active')
            `).run(ulid(), teamId, userId);
        }
    }

    // ---- org scope assistant: what actually fills the agent picker
    const existingAssistant = db.prepare(
        'SELECT id FROM assistants WHERE home_scope_id = ?'
    ).get(orgScope.id);

    if (!existingAssistant) {
        const persona = generateOrgAssistantPersona(name);
        const persistence = buildAssistantPersistencePayload({ persona });
        prepare(`
            INSERT INTO assistants (id, org_id, home_scope_id, name, slug, description,
                persona_json, model_id, model_config_json, status, created_by, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
        `).run(
            ulid(),
            orgId,
            orgScope.id,
            generateOrgAssistantName(name),
            `${slugify(name)}-assistant`,
            `AI assistant for ${name}`,
            persistence.personaJson,
            persistence.modelId,
            persistence.modelConfigJson,
            userId || 'system'
        );
        created.push('org_assistant');
    }

    return { orgScope, created };
}
