/**
 * Organization Scope Utilities
 *
 * Helpers for multi-tenant database operations that ensure
 * all queries are properly scoped to the current organization.
 *
 * Phase 2: Row-level security pattern
 */

import { prepare } from '../db/index.js';

/**
 * Creates an org-scoped query wrapper that automatically adds org_id filtering.
 *
 * Usage:
 *   const scopedQuery = orgScopedQuery(req.org.id);
 *   const teams = scopedQuery.all('SELECT * FROM teams WHERE org_id = ?');
 *   // org_id is automatically bound
 *
 * @param {string} orgId - The organization ID to scope queries to
 * @returns {object} Query methods (get, all, run) that auto-scope to org
 */
export function orgScopedQuery(orgId) {
    if (!orgId) {
        throw new Error('orgId is required for scoped queries');
    }

    return {
        /**
         * Get a single row, with org_id as first parameter
         * @param {string} sql - SQL with ? placeholder for org_id as first param
         * @param {...any} params - Additional parameters after org_id
         */
        get(sql, ...params) {
            return prepare(sql).get(orgId, ...params);
        },

        /**
         * Get all rows, with org_id as first parameter
         */
        all(sql, ...params) {
            return prepare(sql).all(orgId, ...params);
        },

        /**
         * Run a statement (INSERT/UPDATE/DELETE), with org_id as first parameter
         */
        run(sql, ...params) {
            return prepare(sql).run(orgId, ...params);
        },

        /**
         * The org_id for manual use
         */
        orgId
    };
}

/**
 * Validates that a database result belongs to the specified org.
 * Throws an error if the result has a different org_id.
 *
 * Usage:
 *   const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
 *   validateOrgOwnership(team, req.org.id, 'Team');
 *
 * @param {object} result - Database result to validate
 * @param {string} orgId - Expected organization ID
 * @param {string} entityName - Name of entity for error message
 * @throws {Error} If result belongs to different org
 */
export function validateOrgOwnership(result, orgId, entityName = 'Resource') {
    if (!result) {
        return; // Let caller handle not found
    }

    if (result.org_id && result.org_id !== orgId) {
        const error = new Error(`${entityName} does not belong to this organization`);
        error.code = 'CROSS_ORG_ACCESS';
        error.statusCode = 403;
        throw error;
    }
}

/**
 * Validates an array of results all belong to the specified org.
 *
 * @param {Array} results - Array of database results
 * @param {string} orgId - Expected organization ID
 * @param {string} entityName - Name of entity for error message
 * @throws {Error} If any result belongs to different org
 */
export function validateOrgOwnershipArray(results, orgId, entityName = 'Resource') {
    if (!Array.isArray(results)) return;

    for (const result of results) {
        validateOrgOwnership(result, orgId, entityName);
    }
}

/**
 * Middleware that validates response data doesn't leak cross-org data.
 * Use as final middleware before response is sent.
 *
 * This intercepts res.json() to validate org_id fields match req.org.id.
 *
 * Usage:
 *   router.get('/orgs/:orgId/teams', requireOrgMembership, validateOrgResponse, handler);
 */
export function validateOrgResponse(req, res, next) {
    const originalJson = res.json.bind(res);

    res.json = function(data) {
        // Only validate if we have org context
        if (req.org?.id && data && typeof data === 'object') {
            try {
                validateResponseData(data, req.org.id);
            } catch (err) {
                console.error('Cross-org data leak prevented:', err.message);
                return originalJson({
                    error: 'data_validation_failed',
                    message: 'Response validation failed'
                });
            }
        }
        return originalJson(data);
    };

    next();
}

/**
 * Recursively validates response data for org_id mismatches
 */
function validateResponseData(data, orgId, path = '') {
    if (!data || typeof data !== 'object') return;

    // Check arrays
    if (Array.isArray(data)) {
        data.forEach((item, i) => validateResponseData(item, orgId, `${path}[${i}]`));
        return;
    }

    // Check if this object has org_id
    if (data.org_id && data.org_id !== orgId) {
        throw new Error(`Cross-org data at ${path || 'root'}: expected ${orgId}, got ${data.org_id}`);
    }

    // Recursively check nested objects (but skip known safe fields)
    const skipFields = new Set(['user', 'created_by', 'updated_by', 'sender']);
    for (const [key, value] of Object.entries(data)) {
        if (skipFields.has(key)) continue;
        if (value && typeof value === 'object') {
            validateResponseData(value, orgId, path ? `${path}.${key}` : key);
        }
    }
}

/**
 * SQL builder helper for org-scoped WHERE clauses
 *
 * Usage:
 *   const { whereClause, params } = buildOrgWhereClause(orgId, {
 *     status: 'active',
 *     type: ['team', 'division']
 *   });
 *   // whereClause = "org_id = ? AND status = ? AND type IN (?, ?)"
 *   // params = [orgId, 'active', 'team', 'division']
 */
export function buildOrgWhereClause(orgId, filters = {}) {
    const conditions = ['org_id = ?'];
    const params = [orgId];

    for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
            conditions.push(`${key} IN (${value.map(() => '?').join(', ')})`);
            params.push(...value);
        } else {
            conditions.push(`${key} = ?`);
            params.push(value);
        }
    }

    return {
        whereClause: conditions.join(' AND '),
        params
    };
}

export default {
    orgScopedQuery,
    validateOrgOwnership,
    validateOrgOwnershipArray,
    validateOrgResponse,
    buildOrgWhereClause
};
