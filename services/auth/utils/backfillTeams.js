/**
 * Backfill Teams — Creates auto-teams for existing scopes that don't have them.
 *
 * Idempotent: safe to run multiple times. Skips scopes that already have teams attached.
 *
 * Usage:
 *   import { backfillTeams } from './backfillTeams.js';
 *   const result = backfillTeams();
 *   // { created: 5, skipped: 3, errors: [] }
 */

import { getDb, prepare } from '../db/index.js';
import { createScope } from './scopes.js';
import { ulid } from './helpers.js';

function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

/**
 * Backfill teams for all scopes (org, division, department) that don't have one.
 *
 * @param {string} [adminUserId] - User ID to assign as team admin (optional)
 * @returns {{ created: number, skipped: number, errors: string[] }}
 */
export function backfillTeams(adminUserId) {
    const db = getDb();
    const errors = [];
    let created = 0;
    let skipped = 0;

    // Get all org/division/department scopes
    const scopes = prepare(`
        SELECT s.*, o.name as org_name
        FROM scopes s
        LEFT JOIN orgs o ON s.org_id = o.id
        WHERE s.scope_type IN ('org', 'division', 'department')
        ORDER BY s.depth ASC, s.created_at ASC
    `).all();

    for (const scope of scopes) {
        // Check if a team is already attached to this scope
        const existingTeam = prepare(
            'SELECT id FROM teams WHERE attach_scope_id = ? AND org_id = ?'
        ).get(scope.id, scope.org_id);

        if (existingTeam) {
            skipped++;
            continue;
        }

        try {
            const scopeName = scope.name_cache || 'Unnamed';
            const teamName = `${scopeName} Team`;
            const teamSlug = generateSlug(scopeName) + '-team';
            const teamId = ulid();

            // Determine parent team based on scope hierarchy
            let parentTeamId = null;
            if (scope.parent_scope_id) {
                const parentTeam = prepare(
                    'SELECT id FROM teams WHERE attach_scope_id = ? AND org_id = ?'
                ).get(scope.parent_scope_id, scope.org_id);
                parentTeamId = parentTeam?.id || null;
            }

            // Check for slug collision and make unique if needed
            const slugExists = prepare(
                'SELECT id FROM teams WHERE org_id = ? AND slug = ?'
            ).get(scope.org_id, teamSlug);

            const finalSlug = slugExists
                ? `${teamSlug}-${teamId.slice(-6).toLowerCase()}`
                : teamSlug;

            db.transaction(() => {
                // Create team
                prepare(`
                    INSERT INTO teams (id, org_id, name, slug, description, parent_team_id, attach_scope_id, settings_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(teamId, scope.org_id, teamName, finalSlug,
                       `Auto-created team for ${scopeName}`,
                       parentTeamId, scope.id,
                       JSON.stringify({ auto_created: true, backfilled: true }));

                // Create team scope
                createScope(scope.org_id, 'team', teamId, scope.id, teamName);

                // Add admin user if provided
                if (adminUserId) {
                    prepare(`
                        INSERT INTO team_memberships (id, team_id, user_id, role, status)
                        VALUES (?, ?, ?, 'admin', 'active')
                    `).run(ulid(), teamId, adminUserId);
                }
            })();

            created++;
        } catch (err) {
            errors.push(`Scope ${scope.id} (${scope.name_cache || 'unnamed'}): ${err.message}`);
        }
    }

    return { created, skipped, errors };
}

export default { backfillTeams };
