/**
 * ET-2B Phase C — SAML group → role mapping.
 *
 * Pure helpers. The route/callback layer composes these with the
 * ssoProviders helper (which stores group_role_map_json on the
 * provider row) to optionally upgrade a user's membership role on
 * SAML login.
 */

// Higher number = more privileged. 'owner' is never set by group
// mapping; it's a sentinel we use to refuse downgrades.
export const ROLE_RANK = Object.freeze({
    owner:   5,
    admin:   4,
    builder: 3,
    runner:  2,
    auditor: 2,
    viewer:  1,
});

const VALID_ROLES = new Set(Object.keys(ROLE_RANK).filter(r => r !== 'owner'));

/**
 * Read the mapped groups attribute from a SAML profile, tolerant of
 * single-valued / multi-valued / missing shapes.
 */
export function extractProfileGroups(attributeMap = {}, profile = {}) {
    const key = attributeMap?.groups;
    if (!key) return [];
    const v = profile?.[key];
    if (v == null) return [];
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x).map(x => x);
    if (typeof v === 'string') return [v];
    return [];
}

/**
 * Given a provider's { groupName: role } map and the user's list of
 * groups (strings), return the highest-ranked role that matches, or
 * null. Case-insensitive on group name. Unknown roles are skipped.
 */
export function resolveGroupRole(map, groups) {
    if (!map || typeof map !== 'object') return null;
    if (!Array.isArray(groups) || groups.length === 0) return null;

    const lowerMap = new Map(
        Object.entries(map).map(([k, v]) => [String(k).toLowerCase(), v]),
    );

    let bestRole = null;
    let bestRank = -1;
    for (const g of groups) {
        if (typeof g !== 'string') continue;
        const role = lowerMap.get(g.toLowerCase());
        if (!role || !VALID_ROLES.has(role)) continue;
        const rank = ROLE_RANK[role] ?? -1;
        if (rank > bestRank) {
            bestRank = rank;
            bestRole = role;
        }
    }
    return bestRole;
}
