/**
 * Scope Utilities for Quox Auth Service
 * Phase B.1: Unified scope system
 *
 * Scopes provide a unified hierarchy for the organization tree:
 * Org → Division → Department → Team
 *
 * Path format: /org/{orgId}/div/{divId}/dept/{deptId}/team/{teamId}
 */

import crypto from 'crypto';
import { getDb, prepare } from '../db/index.js';

// Scope types in hierarchical order
export const SCOPE_TYPES = ['org', 'division', 'department', 'team'];
export const SCOPE_DEPTH = {
    org: 0,
    division: 1,
    department: 2,
    team: 3
};

/**
 * Generate a ULID using cryptographically secure randomness
 */
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

/**
 * Create a scope entry for an entity
 *
 * @param {string} orgId - Organization ID
 * @param {string} scopeType - 'org', 'division', 'department', or 'team'
 * @param {string} refId - ID of the actual entity
 * @param {string|null} parentScopeId - Parent scope ID (null for org)
 * @param {string} name - Name for caching
 * @returns {Object} Created scope
 */
export function createScope(orgId, scopeType, refId, parentScopeId, name) {
    const db = getDb();
    const id = ulid();

    // Build path based on parent
    let path;
    let depth = SCOPE_DEPTH[scopeType];

    if (parentScopeId) {
        const parent = db.prepare('SELECT path FROM scopes WHERE id = ?').get(parentScopeId);
        if (!parent) {
            throw new Error(`Parent scope ${parentScopeId} not found`);
        }
        path = `${parent.path}/${scopeType}/${refId}`;
    } else {
        // Root org scope
        path = `/org/${refId}`;
    }

    db.prepare(`
        INSERT INTO scopes (id, org_id, scope_type, ref_id, parent_scope_id, path, name_cache, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, scopeType, refId, parentScopeId, path, name, depth);

    return { id, org_id: orgId, scope_type: scopeType, ref_id: refId, parent_scope_id: parentScopeId, path, name_cache: name, depth };
}

/**
 * Get scope by ID
 */
export function getScopeById(scopeId) {
    return prepare('SELECT * FROM scopes WHERE id = ?').get(scopeId);
}

/**
 * Get scope for an entity
 */
export function getScopeForEntity(scopeType, refId) {
    return prepare('SELECT * FROM scopes WHERE scope_type = ? AND ref_id = ?').get(scopeType, refId);
}

/**
 * Get scope path (breadcrumb)
 *
 * @param {string} scopeId - Scope ID
 * @returns {Array} Array of {id, type, name} from org to current
 */
export function getScopePath(scopeId) {
    const db = getDb();
    const scope = db.prepare('SELECT * FROM scopes WHERE id = ?').get(scopeId);
    if (!scope) return [];

    // Parse path and build breadcrumb
    const segments = scope.path.split('/').filter(Boolean);
    const breadcrumb = [];

    for (let i = 0; i < segments.length; i += 2) {
        const type = segments[i];
        const id = segments[i + 1];

        // Get scope for this segment
        const segmentScope = db.prepare('SELECT * FROM scopes WHERE scope_type = ? AND ref_id = ?').get(type, id);
        if (segmentScope) {
            breadcrumb.push({
                id: segmentScope.id,
                type: segmentScope.scope_type,
                ref_id: segmentScope.ref_id,
                name: segmentScope.name_cache
            });
        }
    }

    return breadcrumb;
}

/**
 * Get all ancestor scopes
 *
 * @param {string} scopeId - Starting scope ID
 * @returns {Array} Array of scopes from org down to parent (not including current)
 */
export function getScopeAncestors(scopeId) {
    const db = getDb();
    const ancestors = [];
    let currentId = scopeId;

    while (currentId) {
        const scope = db.prepare('SELECT * FROM scopes WHERE id = ?').get(currentId);
        if (!scope) break;

        if (scope.parent_scope_id) {
            const parent = db.prepare('SELECT * FROM scopes WHERE id = ?').get(scope.parent_scope_id);
            if (parent) {
                ancestors.unshift(parent);
            }
        }
        currentId = scope.parent_scope_id;
    }

    return ancestors;
}

/**
 * Get all descendant scopes
 *
 * @param {string} scopeId - Starting scope ID
 * @returns {Array} Array of all child scopes
 */
export function getScopeDescendants(scopeId) {
    const db = getDb();
    const scope = db.prepare('SELECT * FROM scopes WHERE id = ?').get(scopeId);
    if (!scope) return [];

    // Use path prefix matching
    return db.prepare(`
        SELECT * FROM scopes
        WHERE path LIKE ? AND id != ?
        ORDER BY depth, name_cache
    `).all(`${scope.path}/%`, scopeId);
}

/**
 * Get the org scope tree
 *
 * @param {string} orgId - Organization ID
 * @returns {Object} Nested tree structure
 */
export function getScopeTree(orgId) {
    const db = getDb();
    const scopes = db.prepare(`
        SELECT * FROM scopes
        WHERE org_id = ?
        ORDER BY depth, name_cache
    `).all(orgId);

    // Build tree
    const scopeMap = new Map();
    const root = { children: [] };

    for (const scope of scopes) {
        scopeMap.set(scope.id, { ...scope, children: [] });
    }

    for (const scope of scopes) {
        const node = scopeMap.get(scope.id);
        if (scope.parent_scope_id) {
            const parent = scopeMap.get(scope.parent_scope_id);
            if (parent) {
                parent.children.push(node);
            }
        } else {
            root.children.push(node);
        }
    }

    return root.children.length === 1 ? root.children[0] : root;
}

/**
 * Resolve scope policy by walking up the chain
 *
 * @param {string} scopeId - Scope ID
 * @returns {Object} Merged policy from ancestors
 */
export function resolveScopePolicy(scopeId) {
    const db = getDb();
    const ancestors = getScopeAncestors(scopeId);
    ancestors.push(getScopeById(scopeId));

    let mergedPolicy = {};

    for (const scope of ancestors) {
        const policy = db.prepare('SELECT * FROM scope_policies WHERE scope_id = ?').get(scope.id);
        if (policy) {
            const policyData = JSON.parse(policy.policy_json || '{}');
            if (policy.inherit_parent) {
                // Merge with parent
                mergedPolicy = { ...mergedPolicy, ...policyData };
            } else {
                // Replace entirely
                mergedPolicy = policyData;
            }
        }
    }

    return mergedPolicy;
}

/**
 * Check if a user can access a scope
 *
 * A user can access a scope if they have membership at ANY level of the scope tree
 * (org, division, department, or team)
 *
 * @param {string} userId - User ID
 * @param {string} scopeId - Scope ID to check
 * @returns {boolean} True if user has access
 */
export function canAccessScope(userId, scopeId) {
    const db = getDb();
    const scope = getScopeById(scopeId);
    if (!scope) return false;

    // Check org membership (required for any access)
    const orgMembership = db.prepare(`
        SELECT * FROM org_memberships
        WHERE org_id = ? AND user_id = ? AND status = 'active'
    `).get(scope.org_id, userId);

    if (!orgMembership) return false;

    // Owner/Admin have access to everything
    if (['owner', 'admin'].includes(orgMembership.role)) {
        return true;
    }

    // Get all ancestor scopes including current
    const scopePath = getScopePath(scopeId);

    // Check team memberships for any scope in the path
    for (const pathScope of scopePath) {
        if (pathScope.type === 'team') {
            const teamMembership = db.prepare(`
                SELECT * FROM team_memberships
                WHERE team_id = ? AND user_id = ? AND status = 'active'
            `).get(pathScope.ref_id, userId);

            if (teamMembership) return true;
        }
    }

    // For org-level scope, org membership is sufficient
    if (scope.scope_type === 'org') {
        return true;
    }

    return false;
}

/**
 * Get user's accessible scopes in an org
 *
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @returns {Array} Array of accessible scope IDs
 */
export function getUserAccessibleScopes(userId, orgId) {
    const db = getDb();

    // Check org membership
    const orgMembership = db.prepare(`
        SELECT * FROM org_memberships
        WHERE org_id = ? AND user_id = ? AND status = 'active'
    `).get(orgId, userId);

    if (!orgMembership) return [];

    // Owner/Admin have access to all scopes
    if (['owner', 'admin'].includes(orgMembership.role)) {
        return db.prepare('SELECT id FROM scopes WHERE org_id = ?').all(orgId).map(s => s.id);
    }

    // Get scopes from team memberships
    const accessibleScopes = new Set();

    // Org scope is always accessible if member
    const orgScope = db.prepare('SELECT id FROM scopes WHERE org_id = ? AND scope_type = ?').get(orgId, 'org');
    if (orgScope) accessibleScopes.add(orgScope.id);

    // Get team memberships
    const teamMemberships = db.prepare(`
        SELECT t.id as team_id, t.attach_scope_id
        FROM teams t
        JOIN team_memberships tm ON t.id = tm.team_id
        WHERE t.org_id = ? AND tm.user_id = ? AND tm.status = 'active'
    `).all(orgId, userId);

    for (const tm of teamMemberships) {
        if (tm.attach_scope_id) {
            // Add this scope and all ancestors
            const scope = getScopeById(tm.attach_scope_id);
            if (scope) {
                accessibleScopes.add(scope.id);
                const ancestors = getScopeAncestors(scope.id);
                for (const ancestor of ancestors) {
                    accessibleScopes.add(ancestor.id);
                }
            }
        }

        // Also add the team's own scope
        const teamScope = db.prepare('SELECT id FROM scopes WHERE scope_type = ? AND ref_id = ?').get('team', tm.team_id);
        if (teamScope) {
            accessibleScopes.add(teamScope.id);
        }
    }

    return Array.from(accessibleScopes);
}

/**
 * Update scope name cache (call when entity name changes)
 */
export function updateScopeNameCache(scopeType, refId, newName) {
    return prepare(`
        UPDATE scopes SET name_cache = ?
        WHERE scope_type = ? AND ref_id = ?
    `).run(newName, scopeType, refId);
}

/**
 * Delete scope and all descendants (cascade)
 */
export function deleteScope(scopeId) {
    const db = getDb();
    const scope = getScopeById(scopeId);
    if (!scope) return { changes: 0 };

    // #994: the Matrix room ledger keeps its row (keyed by node_type/node_id,
    // so deprovision still finds it) but must stop pointing at a scope that
    // is going away, or the delete fails on the FOREIGN KEY.
    const hasMatrixRooms = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'matrix_rooms'"
    ).get();
    if (hasMatrixRooms) {
        db.prepare(`
            UPDATE matrix_rooms SET scope_id = NULL
            WHERE scope_id IN (SELECT id FROM scopes WHERE id = ? OR path LIKE ?)
        `).run(scopeId, `${scope.path}/%`);
    }

    // Delete all descendants first (path prefix match)
    const descendantDelete = db.prepare(`
        DELETE FROM scopes WHERE path LIKE ?
    `).run(`${scope.path}/%`);

    // Delete the scope itself
    const selfDelete = db.prepare('DELETE FROM scopes WHERE id = ?').run(scopeId);

    return { changes: descendantDelete.changes + selfDelete.changes };
}

/**
 * Move a scope to a new parent
 */
export function moveScope(scopeId, newParentScopeId) {
    const db = getDb();
    const scope = getScopeById(scopeId);
    if (!scope) throw new Error('Scope not found');

    const newParent = newParentScopeId ? getScopeById(newParentScopeId) : null;

    // Build new path
    const newPath = newParent
        ? `${newParent.path}/${scope.scope_type}/${scope.ref_id}`
        : `/org/${scope.ref_id}`;

    const newDepth = newParent ? newParent.depth + 1 : 0;

    // Update this scope
    db.prepare(`
        UPDATE scopes SET parent_scope_id = ?, path = ?, depth = ?
        WHERE id = ?
    `).run(newParentScopeId, newPath, newDepth, scopeId);

    // Update all descendants (recalculate paths)
    const descendants = getScopeDescendants(scopeId);
    for (const desc of descendants) {
        const relativePath = desc.path.substring(scope.path.length);
        const updatedPath = newPath + relativePath;
        const updatedDepth = newDepth + (desc.depth - scope.depth);

        db.prepare('UPDATE scopes SET path = ?, depth = ? WHERE id = ?')
            .run(updatedPath, updatedDepth, desc.id);
    }

    return getScopeById(scopeId);
}

export default {
    SCOPE_TYPES,
    SCOPE_DEPTH,
    createScope,
    getScopeById,
    getScopeForEntity,
    getScopePath,
    getScopeAncestors,
    getScopeDescendants,
    getScopeTree,
    resolveScopePolicy,
    canAccessScope,
    getUserAccessibleScopes,
    updateScopeNameCache,
    deleteScope,
    moveScope
};
