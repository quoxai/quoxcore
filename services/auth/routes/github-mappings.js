/**
 * GitHub Org Mappings routes — Phase R2
 *
 * Links Quox organisations to GitHub organisations.
 * Credentials are stored in the Integrations Vault (integration_credentials table).
 *
 * GET    /orgs/:orgId/github          — list all GitHub mappings for this Quox org
 * POST   /orgs/:orgId/github/link     — create a mapping
 * PATCH  /orgs/:orgId/github/:mappingId — update tracked repos / credential
 * DELETE /orgs/:orgId/github/:mappingId — unlink
 */

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requireOrgMembership } from '../middleware/org.js';
import { requireCapability } from '../middleware/authorize.js';
import { Capabilities } from '../utils/policy.js';
import { getDb } from '../db/index.js';
import { generateId } from '../utils/crypto.js';

const router = Router();

// ============================================================================
// Helpers
// ============================================================================

function getMappingsForOrg(orgId) {
    return getDb().prepare(`
        SELECT m.*, c.label AS credential_label, c.key_preview, c.test_status
        FROM github_org_mappings m
        LEFT JOIN integration_credentials c ON m.credential_id = c.id
        WHERE m.org_id = ?
        ORDER BY m.github_org_login
    `).all(orgId);
}

function getMappingById(id) {
    return getDb().prepare(`
        SELECT m.*, c.label AS credential_label, c.key_preview, c.test_status
        FROM github_org_mappings m
        LEFT JOIN integration_credentials c ON m.credential_id = c.id
        WHERE m.id = ?
    `).get(id);
}

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /orgs/:orgId/github
 * List all GitHub mappings for this Quox org.
 */
router.get('/orgs/:orgId/github', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const mappings = getMappingsForOrg(req.params.orgId);
        // Parse tracked_repos JSON
        const parsed = mappings.map(m => ({
            ...m,
            tracked_repos: m.tracked_repos ? JSON.parse(m.tracked_repos) : [],
        }));
        res.json({ mappings: parsed });
    } catch (err) {
        console.error('[GitHubMappings] list failed:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list GitHub mappings' });
    }
});

/**
 * GET /internal/orgs/:orgId/github/mappings  (service key only)
 * The collector's GitHub credential resolution (getGitHubToken) called the
 * user-authenticated route above WITHOUT a user token, so it always got 401 and
 * no org ever used its OWN GitHub credential (everything fell through to the
 * shared fallback). Found 2026-10-05 wiring RepoBrain private repos. Returns
 * mapping metadata (credential ids, never secrets).
 */
export function internalGithubMappingsHandler(req, res) {
    const expected = process.env.INTERNAL_SERVICE_KEY;
    const got = req.headers['x-service-key'];
    if (!expected || !got || got !== expected) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const mappings = getMappingsForOrg(req.params.orgId).map((m) => ({
            ...m,
            tracked_repos: m.tracked_repos ? JSON.parse(m.tracked_repos) : [],
        }));
        res.json({ mappings });
    } catch (err) {
        console.error('[GitHubMappings] internal list failed:', err.message);
        res.status(500).json({ error: 'internal_error' });
    }
}
// Registered in server.js BEFORE the /api/internal routers (one of them requires a
// user login for everything it sees, which shadowed this route when mounted later).
router.get('/internal/orgs/:orgId/github/mappings', internalGithubMappingsHandler);

/**
 * POST /orgs/:orgId/github/link
 * Create a new GitHub org mapping.
 * Body: { github_org_login, github_org_id, credential_id?, tracked_repos? }
 */
router.post('/orgs/:orgId/github/link', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { orgId } = req.params;
        const { github_org_login, github_org_id, credential_id, tracked_repos } = req.body;

        if (!github_org_login || !github_org_id) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'github_org_login and github_org_id are required',
            });
        }

        // Check uniqueness
        const existing = getDb().prepare(`
            SELECT id FROM github_org_mappings WHERE org_id = ? AND github_org_login = ?
        `).get(orgId, github_org_login);

        if (existing) {
            return res.status(409).json({
                error: 'conflict',
                message: `GitHub org "${github_org_login}" is already linked to this organisation`,
            });
        }

        // If credential_id supplied, verify it belongs to this org
        if (credential_id) {
            const cred = getDb().prepare(`
                SELECT id FROM integration_credentials WHERE id = ? AND org_id = ?
            `).get(credential_id, orgId);
            if (!cred) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'credential_id not found in this organisation',
                });
            }
        }

        const id = generateId();
        const trackedReposJson = JSON.stringify(tracked_repos || []);

        getDb().prepare(`
            INSERT INTO github_org_mappings (id, org_id, github_org_login, github_org_id, credential_id, tracked_repos)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, orgId, github_org_login, github_org_id, credential_id || null, trackedReposJson);

        const created = getMappingById(id);
        res.status(201).json({
            ...created,
            tracked_repos: created.tracked_repos ? JSON.parse(created.tracked_repos) : [],
        });
    } catch (err) {
        console.error('[GitHubMappings] link failed:', err.message);
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'conflict',
                message: 'This GitHub org is already linked',
            });
        }
        res.status(500).json({ error: 'internal_error', message: 'Failed to link GitHub org' });
    }
});

/**
 * PATCH /orgs/:orgId/github/:mappingId
 * Update a mapping (tracked_repos, credential_id, sync_interval).
 */
router.patch('/orgs/:orgId/github/:mappingId', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { orgId, mappingId } = req.params;
        const { tracked_repos, credential_id, sync_interval } = req.body;

        const existing = getMappingById(mappingId);
        if (!existing || existing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Mapping not found' });
        }

        const fields = [];
        const values = [];

        if (tracked_repos !== undefined) {
            fields.push('tracked_repos = ?');
            values.push(JSON.stringify(tracked_repos));
        }

        if (credential_id !== undefined) {
            // Verify credential belongs to org (null means unlink credential)
            if (credential_id !== null) {
                const cred = getDb().prepare(`
                    SELECT id FROM integration_credentials WHERE id = ? AND org_id = ?
                `).get(credential_id, orgId);
                if (!cred) {
                    return res.status(400).json({
                        error: 'validation_error',
                        message: 'credential_id not found in this organisation',
                    });
                }
            }
            fields.push('credential_id = ?');
            values.push(credential_id);
        }

        if (sync_interval !== undefined) {
            const interval = parseInt(sync_interval, 10);
            if (isNaN(interval) || interval < 1 || interval > 1440) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'sync_interval must be between 1 and 1440 minutes',
                });
            }
            fields.push('sync_interval = ?');
            values.push(interval);
        }

        if (fields.length === 0) {
            return res.json({
                ...existing,
                tracked_repos: existing.tracked_repos ? JSON.parse(existing.tracked_repos) : [],
            });
        }

        fields.push("updated_at = datetime('now')");
        values.push(mappingId);

        getDb().prepare(`
            UPDATE github_org_mappings SET ${fields.join(', ')} WHERE id = ?
        `).run(...values);

        const updated = getMappingById(mappingId);
        res.json({
            ...updated,
            tracked_repos: updated.tracked_repos ? JSON.parse(updated.tracked_repos) : [],
        });
    } catch (err) {
        console.error('[GitHubMappings] update failed:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to update mapping' });
    }
});

/**
 * DELETE /orgs/:orgId/github/:mappingId
 * Unlink a GitHub org.
 */
router.delete('/orgs/:orgId/github/:mappingId', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { orgId, mappingId } = req.params;

        const existing = getMappingById(mappingId);
        if (!existing || existing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Mapping not found' });
        }

        getDb().prepare('DELETE FROM github_org_mappings WHERE id = ?').run(mappingId);
        res.status(204).send();
    } catch (err) {
        console.error('[GitHubMappings] delete failed:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to unlink GitHub org' });
    }
});

export default router;
