/**
 * RepoBrain Connections routes — QN Phase 1
 *
 * Per-org registry of RepoBrain (QuoxNucleus) backend connections. Mirrors
 * the github-mappings.js structure: the row holds no secret, credential_id
 * points at the Integrations Vault (integration_credentials table).
 *
 * GET    /orgs/:orgId/repobrain-connections                — list all connections for this org
 * POST   /orgs/:orgId/repobrain-connections                 — create a connection
 * PATCH  /orgs/:orgId/repobrain-connections/:connId         — update label/base_url/credential_id
 * POST   /orgs/:orgId/repobrain-connections/:connId/default — set as the org's default connection
 * DELETE /orgs/:orgId/repobrain-connections/:connId         — remove a connection
 */

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requireOrgMembership } from '../middleware/org.js';
import { requireCapability } from '../middleware/authorize.js';
import { Capabilities } from '../utils/policy.js';
import { getDb, transaction } from '../db/index.js';
import { generateId } from '../utils/crypto.js';
import { validateUrlScheme } from '../utils/urlValidation.js';
import { logAudit } from '../utils/audit.js';

const router = Router();

// ============================================================================
// Helpers
// ============================================================================

function getConnectionsForOrg(orgId) {
    return getDb().prepare(`
        SELECT c.*, cr.label AS credential_label, cr.key_preview, cr.test_status
        FROM repobrain_connections c
        LEFT JOIN integration_credentials cr ON c.credential_id = cr.id
        WHERE c.org_id = ?
        ORDER BY c.is_default DESC, c.label
    `).all(orgId);
}

function getConnectionById(id) {
    return getDb().prepare(`
        SELECT c.*, cr.label AS credential_label, cr.key_preview, cr.test_status
        FROM repobrain_connections c
        LEFT JOIN integration_credentials cr ON c.credential_id = cr.id
        WHERE c.id = ?
    `).get(id);
}

// QN Phase 1: hostnames/ranges the collector's forward must never reach,
// regardless of who registered the connection — the collector's own
// internal stack (never the target of a RepoBrain fetch) and loopback /
// link-local (an org admin pointing "their own backend" at the box the
// collector itself runs on, intentionally or not). Private RFC1918 ranges
// (192.168.x.x, 10.x.x.x, 172.16-31.x.x) are deliberately NOT blocked here:
// the whole point of Phase 1 is customer backends on LAN hosts, and the
// bundled default (the `repobrain` compose hostname) is itself a private
// hostname. See docs/STREAM_QUOX_REPOBRAIN_PHASE1_DESIGN.md section C.
const DENY_HOSTNAMES = new Set(['auth', 'collector', 'quox-collector', 'memory', 'localhost']);

function isDeniedRepobrainHost(hostname) {
    const h = hostname.toLowerCase();
    if (DENY_HOSTNAMES.has(h)) return true;

    const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const octets = ipv4.slice(1).map(Number);
        if (octets.some((o) => o > 255)) return true; // malformed — deny for safety
        if (octets[0] === 127) return true; // 127.0.0.0/8 loopback
        if (octets[0] === 169 && octets[1] === 254) return true; // 169.254.0.0/16 link-local
        return false;
    }

    if (h === '::1' || h === '[::1]') return true;
    if (h.startsWith('fe80:') || h.startsWith('[fe80:')) return true;

    return false;
}

/**
 * base_url is user-controlled input later fetched server-side by the
 * collector proxy — the SSRF-sensitive field. Scheme/format checks reuse
 * validateUrlScheme; the hostname denylist is bespoke (see
 * isDeniedRepobrainHost) rather than the platform-wide validateUrlBasic,
 * which blocks all private ranges outright.
 */
function validateRepobrainBaseUrl(url) {
    const schemeCheck = validateUrlScheme(url);
    if (!schemeCheck.valid) return schemeCheck;

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }

    if (!parsed.hostname) {
        return { valid: false, error: 'URL must have a hostname' };
    }

    if (parsed.username || parsed.password) {
        return { valid: false, error: 'URL must not contain embedded credentials' };
    }

    if (isDeniedRepobrainHost(parsed.hostname)) {
        return {
            valid: false,
            error: 'This hostname is reserved for internal Quox services or loopback/link-local addresses'
        };
    }

    return { valid: true, parsedUrl: parsed };
}

function normalizeBaseUrl(url) {
    return url.replace(/\/+$/, '');
}

function auditConnectionEvent(action, req, orgId, connectionId, metadata = {}) {
    logAudit({
        action,
        actor: { type: 'user', id: req.user.id },
        orgId,
        target: { type: 'repobrain_connection', id: connectionId },
        request: req,
        metadata
    });
}

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /orgs/:orgId/repobrain-connections
 * List all RepoBrain connections for this org.
 */
router.get('/orgs/:orgId/repobrain-connections', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const connections = getConnectionsForOrg(req.params.orgId).map((c) => ({
            ...c,
            is_default: !!c.is_default
        }));
        res.json({ connections });
    } catch (err) {
        console.error('[RepoBrainConnections] list failed:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list RepoBrain connections' });
    }
});

/**
 * POST /orgs/:orgId/repobrain-connections
 * Create a new RepoBrain connection.
 * Body: { label, base_url, credential_id?, is_default? }
 */
router.post('/orgs/:orgId/repobrain-connections', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { orgId } = req.params;
        const { label, base_url, credential_id, is_default } = req.body || {};

        if (!label || label.trim().length < 2) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Label must be at least 2 characters'
            });
        }
        if (label.trim().length > 255) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Label must be 255 characters or fewer'
            });
        }

        if (!base_url) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'base_url is required'
            });
        }
        const urlValidation = validateRepobrainBaseUrl(base_url);
        if (!urlValidation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: `Invalid base_url: ${urlValidation.error}`
            });
        }

        // If credential_id supplied, it must belong to this org AND be a
        // 'repobrain' credential (tightens the plain org-ownership check
        // github-mappings.js uses).
        if (credential_id) {
            const cred = getDb().prepare(`
                SELECT id FROM integration_credentials WHERE id = ? AND org_id = ? AND integration_type = 'repobrain'
            `).get(credential_id, orgId);
            if (!cred) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'credential_id not found in this organisation or is not a repobrain credential'
                });
            }
        }

        // Check label uniqueness for this org
        const existingLabel = getDb().prepare(`
            SELECT id FROM repobrain_connections WHERE org_id = ? AND label = ?
        `).get(orgId, label.trim());
        if (existingLabel) {
            return res.status(409).json({
                error: 'conflict',
                message: `A RepoBrain connection labelled "${label.trim()}" already exists for this organisation`
            });
        }

        const id = generateId();
        const normalizedUrl = normalizeBaseUrl(base_url.trim());

        // First connection for an org is always forced default — the
        // "default exists whenever any connection exists" invariant.
        const existingCount = getDb().prepare(`
            SELECT COUNT(*) AS n FROM repobrain_connections WHERE org_id = ?
        `).get(orgId).n;
        const forceDefault = existingCount === 0 || !!is_default;

        transaction(() => {
            if (forceDefault) {
                getDb().prepare(`
                    UPDATE repobrain_connections SET is_default = 0 WHERE org_id = ?
                `).run(orgId);
            }
            getDb().prepare(`
                INSERT INTO repobrain_connections (id, org_id, label, base_url, credential_id, is_default)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(id, orgId, label.trim(), normalizedUrl, credential_id || null, forceDefault ? 1 : 0);
        });

        const created = getConnectionById(id);
        auditConnectionEvent('repobrain.connection.create', req, orgId, id, { label: created.label });

        res.status(201).json({ ...created, is_default: !!created.is_default });
    } catch (err) {
        console.error('[RepoBrainConnections] create failed:', err.message);
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'conflict',
                message: 'A RepoBrain connection with this label already exists'
            });
        }
        res.status(500).json({ error: 'internal_error', message: 'Failed to create RepoBrain connection' });
    }
});

/**
 * PATCH /orgs/:orgId/repobrain-connections/:connId
 * Update label, base_url, credential_id.
 */
router.patch('/orgs/:orgId/repobrain-connections/:connId', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { orgId, connId } = req.params;
        const { label, base_url, credential_id } = req.body || {};

        const existing = getConnectionById(connId);
        if (!existing || existing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'RepoBrain connection not found' });
        }

        const fields = [];
        const values = [];

        if (label !== undefined) {
            if (!label || label.trim().length < 2) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'Label must be at least 2 characters'
                });
            }
            if (label.trim().length > 255) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: 'Label must be 255 characters or fewer'
                });
            }
            const dupe = getDb().prepare(`
                SELECT id FROM repobrain_connections WHERE org_id = ? AND label = ? AND id != ?
            `).get(orgId, label.trim(), connId);
            if (dupe) {
                return res.status(409).json({
                    error: 'conflict',
                    message: `A RepoBrain connection labelled "${label.trim()}" already exists for this organisation`
                });
            }
            fields.push('label = ?');
            values.push(label.trim());
        }

        if (base_url !== undefined) {
            const urlValidation = validateRepobrainBaseUrl(base_url);
            if (!urlValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Invalid base_url: ${urlValidation.error}`
                });
            }
            fields.push('base_url = ?');
            values.push(normalizeBaseUrl(base_url.trim()));
        }

        if (credential_id !== undefined) {
            if (credential_id !== null) {
                const cred = getDb().prepare(`
                    SELECT id FROM integration_credentials WHERE id = ? AND org_id = ? AND integration_type = 'repobrain'
                `).get(credential_id, orgId);
                if (!cred) {
                    return res.status(400).json({
                        error: 'validation_error',
                        message: 'credential_id not found in this organisation or is not a repobrain credential'
                    });
                }
            }
            fields.push('credential_id = ?');
            values.push(credential_id);
        }

        if (fields.length === 0) {
            return res.json({ ...existing, is_default: !!existing.is_default });
        }

        fields.push("updated_at = datetime('now')");
        values.push(connId);

        getDb().prepare(`
            UPDATE repobrain_connections SET ${fields.join(', ')} WHERE id = ?
        `).run(...values);

        const updated = getConnectionById(connId);
        auditConnectionEvent('repobrain.connection.update', req, orgId, connId, { label: updated.label });

        res.json({ ...updated, is_default: !!updated.is_default });
    } catch (err) {
        console.error('[RepoBrainConnections] update failed:', err.message);
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({
                error: 'conflict',
                message: 'A RepoBrain connection with this label already exists'
            });
        }
        res.status(500).json({ error: 'internal_error', message: 'Failed to update RepoBrain connection' });
    }
});

/**
 * POST /orgs/:orgId/repobrain-connections/:connId/default
 * Set a connection as the org's default. Mirrors integrations.js /:id/default.
 */
router.post('/orgs/:orgId/repobrain-connections/:connId/default', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { orgId, connId } = req.params;

        const existing = getConnectionById(connId);
        if (!existing || existing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'RepoBrain connection not found' });
        }

        transaction(() => {
            getDb().prepare(`UPDATE repobrain_connections SET is_default = 0 WHERE org_id = ?`).run(orgId);
            getDb().prepare(`
                UPDATE repobrain_connections SET is_default = 1, updated_at = datetime('now') WHERE id = ?
            `).run(connId);
        });

        const updated = getConnectionById(connId);
        auditConnectionEvent('repobrain.connection.default', req, orgId, connId, { label: updated.label });

        res.json({ ...updated, is_default: !!updated.is_default });
    } catch (err) {
        console.error('[RepoBrainConnections] set-default failed:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to set default RepoBrain connection' });
    }
});

/**
 * DELETE /orgs/:orgId/repobrain-connections/:connId
 * Remove a connection. Does NOT delete the Vault credential (it may be
 * shared by other connections). If the deleted row was the org's default
 * and other connections remain, promotes the oldest remaining row to
 * default so "a default exists whenever any connection exists" always
 * holds — the proxy never has to pick arbitrarily.
 */
router.delete('/orgs/:orgId/repobrain-connections/:connId', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { orgId, connId } = req.params;

        const existing = getConnectionById(connId);
        if (!existing || existing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'RepoBrain connection not found' });
        }

        transaction(() => {
            getDb().prepare('DELETE FROM repobrain_connections WHERE id = ?').run(connId);

            if (existing.is_default) {
                const remaining = getDb().prepare(`
                    SELECT id FROM repobrain_connections WHERE org_id = ? ORDER BY created_at ASC LIMIT 1
                `).get(orgId);
                if (remaining) {
                    getDb().prepare(`
                        UPDATE repobrain_connections SET is_default = 1, updated_at = datetime('now') WHERE id = ?
                    `).run(remaining.id);
                }
            }
        });

        auditConnectionEvent('repobrain.connection.delete', req, orgId, connId, { label: existing.label });

        res.status(204).send();
    } catch (err) {
        console.error('[RepoBrainConnections] delete failed:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to delete RepoBrain connection' });
    }
});

export default router;
