/**
 * Scope Routes for Quox Auth Service
 * Phase B.1: Unified scope navigation
 *
 * Scopes provide a unified view of the org hierarchy tree.
 */

import { Router } from 'express';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import {
    getScopeById,
    getScopePath,
    getScopeTree,
    getScopeDescendants,
    getUserAccessibleScopes,
    getScopeForEntity
} from '../utils/scopes.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /orgs/:orgId/scopes
 * Get the full scope tree for an org
 */
router.get('/orgs/:orgId/scopes', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { flat } = req.query;

        if (flat === 'true') {
            // Return flat list
            const scopes = prepare(`
                SELECT * FROM scopes
                WHERE org_id = ?
                ORDER BY depth, name_cache
            `).all(orgId);

            return res.json({ scopes });
        }

        // Return nested tree
        const tree = getScopeTree(orgId);
        res.json({ tree });
    } catch (error) {
        console.error('Error getting scope tree:', error);
        res.status(500).json({ error: 'Failed to get scope tree' });
    }
});

/**
 * GET /orgs/:orgId/scopes/:scopeId
 * Get a single scope with details
 */
router.get('/orgs/:orgId/scopes/:scopeId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, scopeId } = req.params;

        const scope = getScopeById(scopeId);

        if (!scope || scope.org_id !== orgId) {
            return res.status(404).json({ error: 'Scope not found' });
        }

        // Get entity details based on scope type
        let entity = null;
        switch (scope.scope_type) {
            case 'org':
                entity = prepare('SELECT * FROM orgs WHERE id = ?').get(scope.ref_id);
                break;
            case 'division':
                entity = prepare('SELECT * FROM divisions WHERE id = ?').get(scope.ref_id);
                break;
            case 'department':
                entity = prepare('SELECT * FROM departments WHERE id = ?').get(scope.ref_id);
                break;
            case 'team':
                entity = prepare('SELECT * FROM teams WHERE id = ?').get(scope.ref_id);
                break;
        }

        res.json({
            scope: {
                ...scope,
                entity
            }
        });
    } catch (error) {
        console.error('Error getting scope:', error);
        res.status(500).json({ error: 'Failed to get scope' });
    }
});

/**
 * GET /orgs/:orgId/scopes/:scopeId/path
 * Get the breadcrumb path to a scope
 */
router.get('/orgs/:orgId/scopes/:scopeId/path', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, scopeId } = req.params;

        const scope = getScopeById(scopeId);

        if (!scope || scope.org_id !== orgId) {
            return res.status(404).json({ error: 'Scope not found' });
        }

        const path = getScopePath(scopeId);
        res.json({ path });
    } catch (error) {
        console.error('Error getting scope path:', error);
        res.status(500).json({ error: 'Failed to get scope path' });
    }
});

/**
 * GET /orgs/:orgId/scopes/:scopeId/children
 * Get direct children of a scope
 */
router.get('/orgs/:orgId/scopes/:scopeId/children', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, scopeId } = req.params;

        const scope = getScopeById(scopeId);

        if (!scope || scope.org_id !== orgId) {
            return res.status(404).json({ error: 'Scope not found' });
        }

        const children = prepare(`
            SELECT * FROM scopes
            WHERE parent_scope_id = ?
            ORDER BY scope_type, name_cache
        `).all(scopeId);

        res.json({ children });
    } catch (error) {
        console.error('Error getting scope children:', error);
        res.status(500).json({ error: 'Failed to get scope children' });
    }
});

/**
 * GET /orgs/:orgId/scopes/:scopeId/descendants
 * Get all descendants of a scope
 */
router.get('/orgs/:orgId/scopes/:scopeId/descendants', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, scopeId } = req.params;

        const scope = getScopeById(scopeId);

        if (!scope || scope.org_id !== orgId) {
            return res.status(404).json({ error: 'Scope not found' });
        }

        const descendants = getScopeDescendants(scopeId);
        res.json({ descendants });
    } catch (error) {
        console.error('Error getting scope descendants:', error);
        res.status(500).json({ error: 'Failed to get scope descendants' });
    }
});

/**
 * GET /orgs/:orgId/my-scopes
 * Get scopes the current user has access to
 */
router.get('/orgs/:orgId/my-scopes', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;

        const scopeIds = getUserAccessibleScopes(userId, orgId);

        const scopes = prepare(`
            SELECT * FROM scopes
            WHERE id IN (${scopeIds.map(() => '?').join(',') || "''"})
            ORDER BY depth, name_cache
        `).all(...scopeIds);

        res.json({ scopes });
    } catch (error) {
        console.error('Error getting user scopes:', error);
        res.status(500).json({ error: 'Failed to get user scopes' });
    }
});

/**
 * GET /orgs/:orgId/scope-by-entity
 * Get scope for a specific entity
 */
router.get('/orgs/:orgId/scope-by-entity', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { type, id } = req.query;

        if (!type || !id) {
            return res.status(400).json({ error: 'type and id are required query parameters' });
        }

        if (!['org', 'division', 'department', 'team'].includes(type)) {
            return res.status(400).json({ error: 'Invalid scope type' });
        }

        const scope = getScopeForEntity(type, id);

        if (!scope || scope.org_id !== orgId) {
            return res.status(404).json({ error: 'Scope not found' });
        }

        res.json({ scope });
    } catch (error) {
        console.error('Error getting scope by entity:', error);
        res.status(500).json({ error: 'Failed to get scope' });
    }
});

export default router;
