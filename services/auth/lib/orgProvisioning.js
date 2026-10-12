/**
 * Organisation provisioning, shared by every path that creates an org.
 *
 * GTM-A1/B3: extracted verbatim from POST /orgs (routes/orgs.js) so that UI
 * signup can provision a workspace through the SAME code, rather than growing
 * a second, subtly-different org creation path. A live audit on 2026-09-16
 * found that a user who signed up through the product UI got an account with
 * no organisation at all: org-scoped calls fired with an empty id
 * (GET /collector/api/suggestions/list?orgId=&tier=tier_free -> 400) and the
 * sidebar silently rendered 8 items instead of 12. The org had to be created
 * out of band with `quox org create`, which nothing in the UI mentions.
 *
 * The logic here is a pure move. Behaviour for POST /orgs is unchanged: same
 * tables, same order, same single transaction, same non-fatal post-commit
 * steps. Only the call site moved.
 */

import { generateId } from '../utils/crypto.js';
import { queries, transaction, prepare } from '../db/index.js';
import { createScope } from '../utils/scopes.js';
import { ulid } from '../utils/helpers.js';
import { generateOrgAssistantPersona, generateOrgAssistantName } from '../utils/scopeAssistantTemplates.js';
import { provisionFirstPartyForNewOrg } from '../utils/firstPartyProvision.js';
import { provisionRoomForNode, provisionCommanderQRoom, isMatrixRoomsEnabled } from './matrixProvisioner.js';
import { buildAssistantPersistencePayload } from '../routes/assistantLlm.js';
import { OrgRoles } from '../utils/policy.js';

/**
 * Turn an org name into a URL slug.
 * Kept here so both callers derive slugs identically.
 */
export function generateOrgSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

/**
 * Pick a slug that is not already taken, appending a short suffix on collision.
 * Mirrors the original inline behaviour in POST /orgs.
 */
export function resolveAvailableSlug(preferredSlug) {
    let slug = preferredSlug;
    const existingOrg = queries.getOrgBySlug(slug);
    if (existingOrg) {
        slug = `${slug}-${generateId().slice(-6).toLowerCase()}`;
    }
    return slug;
}

/**
 * Create an organisation and everything a usable workspace needs: the org
 * itself, an owner membership, the org scope, an auto-created team with its
 * own scope and admin membership, and the org's scope assistant. Runs in one
 * transaction.
 *
 * @param {Object} params
 * @param {string} params.name        - display name for the org
 * @param {string} params.slug        - resolved, collision-checked slug
 * @param {string|null} params.description
 * @param {string} params.userId      - the owner
 * @returns {{ orgId: string, slug: string, name: string }}
 */
export function createOrgWithDefaults({ name, slug, description = null, userId }) {
    const orgId = generateId();
    const membershipId = generateId();

    transaction(() => {
        // Create org
        queries.createOrg({
            id: orgId,
            name,
            slug,
            description: description || null,
            owner_user_id: userId,
            plan: 'free',
            mfa_policy: 'optional',
            settings_json: '{}'
        });

        // Add creator as owner
        queries.createOrgMembership({
            id: membershipId,
            org_id: orgId,
            user_id: userId,
            role: OrgRoles.OWNER,
            status: 'active',
            invited_by: userId,
            invited_at: new Date().toISOString()
        });

        // Auto-create org scope
        const orgScope = createScope(orgId, 'org', orgId, null, name);

        // Auto-create org team attached to org scope
        const teamId = ulid();
        const teamSlug = generateOrgSlug(name) + '-team';
        prepare(`
            INSERT INTO teams (id, org_id, name, slug, description, parent_team_id, attach_scope_id, settings_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(teamId, orgId, `${name} Team`, teamSlug, `Auto-created team for ${name}`, null, orgScope.id,
               JSON.stringify({ created_by: userId, auto_created: true }));

        // Create scope for the team
        createScope(orgId, 'team', teamId, orgScope.id, `${name} Team`);

        // Add creator as team admin
        prepare(`
            INSERT INTO team_memberships (id, team_id, user_id, role, status)
            VALUES (?, ?, ?, 'admin', 'active')
        `).run(ulid(), teamId, userId);

        // Auto-create org scope assistant
        const orgAssistantId = ulid();
        const orgAssistantSlug = generateOrgSlug(name) + '-assistant';
        const orgPersona = generateOrgAssistantPersona(name);
        const orgAssistantPersistence = buildAssistantPersistencePayload({ persona: orgPersona });
        prepare(`
            INSERT INTO assistants (id, org_id, home_scope_id, name, slug, description,
                persona_json, model_id, model_config_json, status, created_by, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
        `).run(
            orgAssistantId,
            orgId,
            orgScope.id,
            generateOrgAssistantName(name),
            orgAssistantSlug,
            `AI assistant for ${name}`,
            orgAssistantPersistence.personaJson,
            orgAssistantPersistence.modelId,
            orgAssistantPersistence.modelConfigJson,
            userId
        );
    });

    return { orgId, slug, name };
}

/**
 * The non-fatal post-commit steps: first-party plugin provisioning and Matrix
 * room provisioning. Both are non-fatal by contract. A hiccup in either must
 * never fail org creation, and each has its own backstop reconciler.
 *
 * @param {Object} db - the auth database handle
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.userId
 */
export async function runPostOrgCreationProvisioning(db, { orgId, userId }) {
    if (process.env.FIRST_PARTY_PLUGINS !== 'off') {
        try {
            provisionFirstPartyForNewOrg(db, orgId);
        } catch (err) {
            console.error('[FirstParty] new-org provisioning failed (non-fatal):', err.message);
        }
    }

    try {
        if (await isMatrixRoomsEnabled(orgId)) {
            provisionRoomForNode({ orgId, nodeType: 'org', nodeId: orgId, actorId: userId })
                .catch((err) => console.error('[MatrixRooms] eager org-room provision failed (non-fatal):', err.message));
            provisionCommanderQRoom(orgId, userId)
                .catch((err) => console.error('[MatrixRooms] eager CommanderQ provision failed (non-fatal):', err.message));
        }
    } catch (err) {
        console.error('[MatrixRooms] provisioning check failed (non-fatal):', err.message);
    }
}
