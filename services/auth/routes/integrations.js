/**
 * Integration Credentials routes for Quox Auth Service
 *
 * POST   /orgs/:orgId/integrations           - Create integration credential
 * GET    /orgs/:orgId/integrations           - List credentials (masked)
 * GET    /orgs/:orgId/integrations/types     - Get available integration types
 * GET    /orgs/:orgId/integrations/:id       - Get single credential (masked)
 * PUT    /orgs/:orgId/integrations/:id       - Update credential
 * DELETE /orgs/:orgId/integrations/:id       - Delete credential
 * POST   /orgs/:orgId/integrations/:id/test  - Test connection
 * POST   /orgs/:orgId/integrations/:id/default - Set as default
 *
 * Internal (service-to-service):
 * POST   /internal/integrations/:id/decrypt  - Get decrypted credential
 * DELETE /internal/integrations/:id          - Delete a BOOTSTRAP credential only
 */

import { Router } from 'express';
import { authenticate, requireOrg, authenticateApiKey } from '../middleware/authenticate.js';
import { requireCapability, requireAdmin, requireOrgScope } from '../middleware/authorize.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { logIntegrationEvent, AuditActions } from '../utils/audit.js';
import { validateApiKeyFormat } from '../utils/encryption.js';
import { validateUrlForSSRF, validateUrlBasic, safeFetch, DEFAULT_TIMEOUT_MS } from '../utils/urlValidation.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { clearCache as clearResolverCache } from '../services/credentialResolver.js';
import {
    createCredential,
    listCredentials,
    getCredentialById,
    getDecryptedCredential,
    updateCredential,
    deleteCredential,
    setDefault,
    updateTestStatus,
    updateLastUsed,
    labelExists,
    rotateCredential,
    getExpiring,
    listFolders,
    getFolderById,
    createFolder,
    updateFolder,
    deleteFolder,
    findCredentialsAcrossUserOrgs,
    copyCredential,
} from '../db/integrations.js';
import { getDb } from '../db/index.js';
import { writeCredentialReleaseAudit, writeLeaseAccessAudit } from '../lib/credentialReleaseAudit.js';
import { evaluateLeaseGate } from '../lib/leaseGate.js';
import { getVaultStats, runHealthScan, getVaultActivity } from '../services/credentialHealthScanner.js';
import { INTEGRATION_TYPES, getType, getTestConfig, getFieldSchema, listTypes, getTypesByCategory, getTestDepth, INTEGRATION_CATEGORIES } from '../config/integrationTypeRegistry.js';
import { testConnection, lanTargetsAllowed } from '../services/integrationHealthService.js';
import { isValidKind, isValidReleasePolicy, isReleasePolicyAllowedForKind, validateKindShape } from '../config/credentialKinds.js';

const router = Router();

// Rate limiter for internal decrypt endpoint: 10 req/min per service account
const decryptLimiter = createLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many decrypt requests — rate limited',
    keyGenerator: (req) => `decrypt:${req.serviceAccount?.id || req.ip}`
});

// Rate limiter for vault write operations: 30 req/min per user
const vaultWriteLimiter = createLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many vault write requests — rate limited',
    keyGenerator: (req) => `vault-write:${req.user?.id || req.ip}`
});

// Rate limiter for vault test/rotate operations: 10 req/min per user
const vaultTestLimiter = createLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many vault test/rotate requests — rate limited',
    keyGenerator: (req) => `vault-test:${req.user?.id || req.ip}`
});

// ============================================================================
// Helpers
// ============================================================================

function validateCredentials(integrationType, credentials) {
    const type = INTEGRATION_TYPES[integrationType];
    if (!type) {
        return { valid: false, message: `Unknown integration type: ${integrationType}` };
    }

    for (const field of type.fields) {
        if (field.required && !credentials[field.key]) {
            return { valid: false, message: `${field.label} is required` };
        }
        if (field.prefix && credentials[field.key] && !credentials[field.key].startsWith(field.prefix)) {
            return { valid: false, message: `${field.label} should start with ${field.prefix}` };
        }
    }

    return { valid: true };
}

/**
 * VAULT-AUDIT P2: validate the (credential_kind, release_policy) pair on
 * write. credential_kind defaults to 'service_api' (permissive) when
 * omitted, preserving backward compat for every existing caller that sends
 * neither field. release_policy is only checked when explicitly provided —
 * P2 stores + validates values only; release_policy BEHAVIOR is P5.
 */
function validateKindAndPolicy(credentialKind, releasePolicy, credentials) {
    const kind = credentialKind || 'service_api';

    if (!isValidKind(kind)) {
        return { valid: false, message: `Unknown credential_kind: ${kind}` };
    }

    const shapeResult = validateKindShape(kind, credentials);
    if (!shapeResult.valid) {
        return shapeResult;
    }

    if (releasePolicy !== undefined && releasePolicy !== null) {
        if (!isValidReleasePolicy(releasePolicy)) {
            return { valid: false, message: `Unknown release_policy: ${releasePolicy}` };
        }
        if (!isReleasePolicyAllowedForKind(kind, releasePolicy)) {
            return { valid: false, message: `release_policy '${releasePolicy}' is not allowed for credential_kind '${kind}'` };
        }
    }

    return { valid: true };
}

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /orgs/:orgId/integrations/test-credentials
 * Test credentials before saving (for new integrations)
 */
router.post('/orgs/:orgId/integrations/test-credentials', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), vaultTestLimiter, async (req, res) => {
    try {
        const { integration_type, credentials, endpoint_url } = req.body;

        if (!integration_type || !credentials) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'integration_type and credentials are required'
            });
        }

        if (!INTEGRATION_TYPES[integration_type]) {
            return res.status(400).json({
                error: 'validation_error',
                message: `Unknown integration type: ${integration_type}`
            });
        }

        // Validate credentials
        const validation = validateCredentials(integration_type, credentials);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: validation.message
            });
        }

        // SSRF Protection
        if (endpoint_url) {
            const urlValidation = validateUrlBasic(endpoint_url, { allowPrivate: lanTargetsAllowed(integration_type) });
            if (!urlValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Invalid endpoint URL: ${urlValidation.error}`
                });
            }
        }

        // Test connection without saving
        const result = await testConnection(integration_type, credentials, endpoint_url);

        if (result.success) {
            // VAULT-INTEG P8: pass through result_kind + the real message
            // instead of a hardcoded "Connection successful" for every
            // success — a format-only pass must not read identically to a
            // live one (result.message already carries the "(format check
            // only)" wording for format_check; default to the generic
            // string only when the health service didn't set one).
            res.json({
                success: true,
                result_kind: result.result_kind || 'live',
                message: result.message || 'Connection successful'
            });
        } else {
            res.status(422).json({
                success: false,
                result_kind: result.result_kind,
                error: 'connection_failed',
                message: result.error || 'Connection test failed'
            });
        }
    } catch (err) {
        console.error('Failed to test credentials:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to test credentials'
        });
    }
});

/**
 * GET /orgs/:orgId/integrations/types
 * Get available integration types
 */
router.get('/orgs/:orgId/integrations/types', authenticate(), requireOrgMembership, (req, res) => {
    const types = Object.values(INTEGRATION_TYPES).map(type => ({
        id: type.id,
        name: type.name,
        description: type.description,
        color: type.color,
        // category isn't set on every legacy registry entry (added
        // progressively); null here just means "uncategorised", not an error.
        category: type.category || null,
        // Surfaced for VAULT-INTEG P7 (vault_types/vault_connect_guide agent
        // tools): whether saving this type runs a live connection test, so an
        // agent can tell the user what to expect without guessing.
        // VAULT-INTEG P8: test_depth is the same fact expressed as a
        // 3-way enum ('live'|'format-only'|'none') instead of a boolean —
        // has_live_test stays for callers already depending on it.
        has_live_test: !!type.testEndpoint,
        test_depth: getTestDepth(type),
        fields: type.fields.map(f => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            default: f.default,
            placeholder: f.placeholder
        })),
        docs: type.docs
    }));

    res.json({ types });
});

/**
 * GET /orgs/:orgId/integrations/vault-stats
 * Get vault health statistics
 */
router.get('/orgs/:orgId/integrations/vault-stats', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const stats = getVaultStats(req.params.orgId);
        res.json(stats);
    } catch (err) {
        console.error('[VaultStats] Error:', err.message);
        res.status(500).json({ error: 'Failed to get vault stats' });
    }
});

/**
 * POST /orgs/:orgId/integrations/health-scan
 * Run a health scan and return issues
 */
router.post('/orgs/:orgId/integrations/health-scan', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const result = runHealthScan(req.params.orgId);
        res.json(result);
    } catch (err) {
        console.error('[HealthScan] Error:', err.message);
        res.status(500).json({ error: 'Health scan failed' });
    }
});

/**
 * GET /orgs/:orgId/integrations/activity
 * Get recent vault activity from audit log
 */
router.get('/orgs/:orgId/integrations/activity', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = parseInt(req.query.offset) || 0;
        const events = getVaultActivity(req.params.orgId, { limit, offset });
        res.json({ events, limit, offset });
    } catch (err) {
        console.error('[VaultActivity] Error:', err.message);
        res.status(500).json({ error: 'Failed to get vault activity' });
    }
});

/**
 * GET /orgs/:orgId/integrations/expiring
 * List credentials expiring within N days
 */
router.get('/orgs/:orgId/integrations/expiring', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
        const credentials = getExpiring(req.params.orgId, days);
        res.json({ credentials, days });
    } catch (err) {
        console.error('[VaultExpiring] Error:', err.message);
        res.status(500).json({ error: 'Failed to get expiring credentials' });
    }
});

/**
 * POST /orgs/:orgId/integrations
 * Create new integration credential
 */
router.post('/orgs/:orgId/integrations', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), vaultWriteLimiter, async (req, res) => {
    try {
        const { orgId } = req.params;
        const {
            integration_type,
            label,
            credentials,
            endpoint_url,
            auth_type,
            headers,
            description,
            metadata,
            is_default,
            scope_id,
            visibility,
            folder_id,
            lease_required,
            lease_max_duration_minutes,
            lease_max_uses,
            credential_kind,
            release_policy
        } = req.body;

        // Validate integration type
        if (!INTEGRATION_TYPES[integration_type]) {
            return res.status(400).json({
                error: 'validation_error',
                message: `Invalid integration type: ${integration_type}`
            });
        }

        // Default credential_kind from the integration type's declared
        // credentialKind when the caller didn't specify one, so every
        // client path (modal, CLI, InboxQ onboarding) gets the right
        // credential kind automatically for types like email providers.
        const effectiveCredentialKind = credential_kind || INTEGRATION_TYPES[integration_type]?.credentialKind || null;

        // Validate label
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

        // Validate description length
        if (description && description.length > 2000) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Description must be 2000 characters or fewer'
            });
        }

        // Validate metadata size
        if (metadata && JSON.stringify(metadata).length > 10240) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Metadata must be 10KB or smaller'
            });
        }

        // Check label uniqueness
        if (labelExists(orgId, integration_type, label.trim(), scope_id || null)) {
            return res.status(409).json({
                error: 'conflict',
                message: `An integration with label "${label}" already exists for this type`
            });
        }

        // Validate credentials
        const validation = validateCredentials(integration_type, credentials);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: validation.message
            });
        }

        // VAULT-AUDIT P2: validate credential_kind shape + release_policy
        // allow-list. Defaults to 'service_api' (permissive) when omitted.
        const kindValidation = validateKindAndPolicy(effectiveCredentialKind, release_policy, credentials);
        if (!kindValidation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: kindValidation.message
            });
        }

        // SSRF Protection: Validate endpoint_url if provided
        if (endpoint_url) {
            const urlValidation = validateUrlBasic(endpoint_url, { allowPrivate: lanTargetsAllowed(integration_type) });
            if (!urlValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Invalid endpoint URL: ${urlValidation.error}`
                });
            }
        }

        // SSRF Protection: Validate base_url in credentials if provided
        if (credentials && credentials.base_url) {
            const baseUrlValidation = validateUrlBasic(credentials.base_url, { allowPrivate: lanTargetsAllowed(integration_type) });
            if (!baseUrlValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Invalid base URL: ${baseUrlValidation.error}`
                });
            }
        }

        // Create credential
        const credential = createCredential({
            org_id: orgId,
            scope_id: scope_id || null,
            integration_type,
            label: label.trim(),
            credentials,
            endpoint_url,
            auth_type: auth_type || 'api_key',
            headers_json: headers ? JSON.stringify(headers) : '{}',
            description,
            metadata_json: metadata ? JSON.stringify(metadata) : '{}',
            is_default: is_default || false,
            created_by: req.user.id,
            visibility: visibility || 'org',
            folder_id: folder_id || null,
            lease_required: lease_required ? 1 : 0,
            lease_max_duration_minutes: lease_required ? (lease_max_duration_minutes || 120) : null,
            lease_max_uses: lease_required && lease_max_uses ? lease_max_uses : null,
            credential_kind: effectiveCredentialKind || 'service_api',
            release_policy
        });

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_CREATE,
            { type: 'user', id: req.user.id },
            orgId,
            credential.id,
            req,
            { integration_type, label: credential.label }
        );

        res.status(201).json(credential);
    } catch (err) {
        console.error('Failed to create integration:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to create integration credential'
        });
    }
});

/**
 * GET /orgs/:orgId/integrations
 * List all credentials (masked)
 */
router.get('/orgs/:orgId/integrations', authenticate(), requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { type, scope_id, visibility, folder_id } = req.query;

        const credentials = listCredentials(orgId, {
            integration_type: type,
            scope_id: scope_id,
            visibility,
            folder_id,
            user_id: req.user?.id,
            role: req.orgMembership?.role
        });

        // Parse JSON fields
        const parsed = credentials.map(cred => ({
            ...cred,
            headers: cred.headers_json ? JSON.parse(cred.headers_json) : {},
            metadata: cred.metadata_json ? JSON.parse(cred.metadata_json) : {},
            is_default: !!cred.is_default
        }));

        res.json({ credentials: parsed });
    } catch (err) {
        console.error('Failed to list integrations:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to list integration credentials'
        });
    }
});

/**
 * GET /orgs/:orgId/integrations/:id
 * Get single credential (masked)
 */
router.get('/orgs/:orgId/integrations/:id', authenticate(), requireOrgMembership, async (req, res) => {
    try {
        const { orgId, id } = req.params;

        const credential = getCredentialById(id);

        if (!credential) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Verify org ownership
        if (credential.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        res.json({
            ...credential,
            headers: credential.headers_json ? JSON.parse(credential.headers_json) : {},
            metadata: credential.metadata_json ? JSON.parse(credential.metadata_json) : {},
            is_default: !!credential.is_default
        });
    } catch (err) {
        console.error('Failed to get integration:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to get integration credential'
        });
    }
});

/**
 * PUT /orgs/:orgId/integrations/:id
 * Update credential (requires re-entering credentials)
 */
router.put('/orgs/:orgId/integrations/:id', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), vaultWriteLimiter, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        const {
            label,
            credentials, // Required for security - must re-enter
            endpoint_url,
            auth_type,
            headers,
            description,
            metadata,
            is_default,
            expires_at,
            visibility,
            folder_id,
            lease_required,
            lease_max_duration_minutes,
            lease_max_uses,
            credential_kind,
            release_policy
        } = req.body;

        // Get existing credential
        const existing = getCredentialById(id);

        if (!existing) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Verify org ownership
        if (existing.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Credentials are OPTIONAL on update — a metadata-only PUT (label,
        // description, etc.) must not force re-supplying the secret. When
        // credentials ARE re-sent, validate their shape as before.
        if (credentials !== undefined) {
            const validation = validateCredentials(existing.integration_type, credentials);
            if (!validation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: validation.message
                });
            }
        }

        // VAULT-AUDIT P2 (FIX 1): validate against the EFFECTIVE credential_kind
        // / release_policy — the request body's value if sent, otherwise the
        // ROW'S STORED value. Validating against the permissive 'service_api'
        // default (ignoring the stored kind) let a caller silently downgrade
        // an already-typed row's shape/policy guarantees on update.
        const effKind = credential_kind ?? existing.credential_kind ?? 'service_api';
        const effPolicy = release_policy ?? existing.release_policy;

        if (credentials !== undefined) {
            // Credentials were re-sent — validate full shape against effKind.
            const kindValidation = validateKindAndPolicy(effKind, effPolicy, credentials);
            if (!kindValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: kindValidation.message
                });
            }
        } else if (credential_kind !== undefined || release_policy !== undefined) {
            // credential_kind and/or release_policy is being changed without
            // re-sending credentials — there's nothing to shape-check, but
            // the kind/policy values themselves still need validating.
            if (!isValidKind(effKind)) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Unknown credential_kind: ${effKind}`
                });
            }
            if (effPolicy !== undefined && effPolicy !== null) {
                if (!isValidReleasePolicy(effPolicy)) {
                    return res.status(400).json({
                        error: 'validation_error',
                        message: `Unknown release_policy: ${effPolicy}`
                    });
                }
                if (!isReleasePolicyAllowedForKind(effKind, effPolicy)) {
                    return res.status(400).json({
                        error: 'validation_error',
                        message: `release_policy '${effPolicy}' is not allowed for credential_kind '${effKind}'`
                    });
                }
            }
        }

        // SSRF Protection: Validate endpoint_url if provided
        if (endpoint_url) {
            const urlValidation = validateUrlBasic(endpoint_url, { allowPrivate: lanTargetsAllowed(existing.integration_type) });
            if (!urlValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Invalid endpoint URL: ${urlValidation.error}`
                });
            }
        }

        // SSRF Protection: Validate base_url in credentials if provided
        if (credentials && credentials.base_url) {
            const baseUrlValidation = validateUrlBasic(credentials.base_url, { allowPrivate: lanTargetsAllowed(existing.integration_type) });
            if (!baseUrlValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Invalid base URL: ${baseUrlValidation.error}`
                });
            }
        }

        // Check label uniqueness if changing
        if (label && label.trim() !== existing.label) {
            if (labelExists(orgId, existing.integration_type, label.trim(), existing.scope_id, id)) {
                return res.status(409).json({
                    error: 'conflict',
                    message: `An integration with label "${label}" already exists for this type`
                });
            }
        }

        // Update
        const updated = updateCredential(id, {
            label: label?.trim(),
            credentials,
            endpoint_url,
            auth_type,
            headers_json: headers ? JSON.stringify(headers) : undefined,
            description,
            metadata_json: metadata ? JSON.stringify(metadata) : undefined,
            is_default,
            expires_at,
            visibility,
            folder_id,
            lease_required: lease_required !== undefined ? (lease_required ? 1 : 0) : undefined,
            lease_max_duration_minutes: lease_required !== undefined ? (lease_required ? (lease_max_duration_minutes || 120) : null) : undefined,
            lease_max_uses: lease_required !== undefined ? (lease_required && lease_max_uses ? lease_max_uses : null) : undefined,
            credential_kind,
            release_policy
        });

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_UPDATE,
            { type: 'user', id: req.user.id },
            orgId,
            id,
            req,
            { label: updated.label }
        );

        // F10: invalidate the 30s resolver cache so a revoked/updated
        // credential can't still be served as plaintext post-write.
        clearResolverCache();

        res.json({
            ...updated,
            headers: updated.headers_json ? JSON.parse(updated.headers_json) : {},
            metadata: updated.metadata_json ? JSON.parse(updated.metadata_json) : {},
            is_default: !!updated.is_default
        });
    } catch (err) {
        console.error('Failed to update integration:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to update integration credential'
        });
    }
});

/**
 * DELETE /orgs/:orgId/integrations/:id
 * Delete credential
 */
router.delete('/orgs/:orgId/integrations/:id', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), vaultWriteLimiter, async (req, res) => {
    try {
        const { orgId, id } = req.params;

        // Get existing credential for audit
        const existing = getCredentialById(id);

        if (!existing) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Verify org ownership
        if (existing.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Delete
        deleteCredential(id);

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_DELETE,
            { type: 'user', id: req.user.id },
            orgId,
            id,
            req,
            { integration_type: existing.integration_type, label: existing.label }
        );

        // F10: invalidate the 30s resolver cache so the deleted
        // credential's plaintext can't still be served post-delete.
        clearResolverCache();

        // BASTION-CRED Phase 1: every vault credential DELETE is also
        // AEE-witnessed, mirroring the quox.vault.credential.read envelope
        // emitted on decrypt (setup.js:1077-1095). Fire-and-forget; never
        // blocks the response. Never includes secret values, key_preview,
        // or ciphertext.
        try {
            const { emitEnvelope } = await import('../lib/aeeClient.js');
            emitEnvelope({
                from: `human.${req.user.id}`,
                to: 'audit.system',
                intent: 'quox.vault.credential.deleted',
                corr: `VAULT_${id}`,
                payload: {
                    credential_id: id,
                    integration_type: existing.integration_type,
                    label: existing.label,
                    org_id: orgId,
                    credential_kind: existing.credential_kind || undefined,
                    via: 'integrations-delete-route',
                },
            });
        } catch (e) { /* audit is fire-and-forget */ }

        res.status(204).send();
    } catch (err) {
        console.error('Failed to delete integration:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to delete integration credential'
        });
    }
});

/**
 * POST /orgs/:orgId/integrations/:id/rotate
 * Rotate a credential with new values
 */
router.post('/orgs/:orgId/integrations/:id/rotate', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), vaultTestLimiter, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        const { credentials, expires_at } = req.body;

        // Get existing credential
        const existing = getCredentialById(id);

        if (!existing) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Verify org ownership
        if (existing.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Credentials are required for rotation
        if (!credentials || typeof credentials !== 'object') {
            return res.status(400).json({
                error: 'validation_error',
                message: 'New credentials are required for rotation'
            });
        }

        // Validate credentials (same validation as create)
        const validation = validateCredentials(existing.integration_type, credentials);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'validation_error',
                message: validation.message
            });
        }

        // SSRF Protection: Validate base_url in credentials if provided
        if (credentials.base_url) {
            const baseUrlValidation = validateUrlBasic(credentials.base_url, { allowPrivate: lanTargetsAllowed(existing.integration_type) });
            if (!baseUrlValidation.valid) {
                return res.status(400).json({
                    error: 'validation_error',
                    message: `Invalid base URL: ${baseUrlValidation.error}`
                });
            }
        }

        // Rotate credential (re-encrypts with new IV + authTag)
        const updated = rotateCredential(id, credentials, expires_at);

        if (!updated) {
            return res.status(500).json({
                error: 'internal_error',
                message: 'Failed to rotate credential'
            });
        }

        // Optional auto-test
        if (req.query.test === 'true') {
            try {
                const decrypted = getDecryptedCredential(id);
                if (decrypted?.credentials) {
                    const testResult = await testConnection(
                        decrypted.integration_type,
                        decrypted.credentials,
                        decrypted.endpoint_url
                    );
                    updateTestStatus(id, testResult.success ? 'success' : 'failed');
                    updated.test_status = testResult.success ? 'success' : 'failed';
                }
            } catch {
                // Test failure doesn't block rotation
            }
        }

        // Audit log with old key_preview for forensic tracking
        logIntegrationEvent(
            AuditActions.INTEGRATION_ROTATE,
            { type: 'user', id: req.user.id },
            orgId,
            id,
            req,
            {
                integration_type: existing.integration_type,
                label: existing.label,
                old_key_preview: updated._oldKeyPreview || existing.key_preview,
                new_key_preview: updated.key_preview
            }
        );

        // Remove internal field before response
        delete updated._oldKeyPreview;

        res.json({
            ...updated,
            headers: updated.headers_json ? JSON.parse(updated.headers_json) : {},
            metadata: updated.metadata_json ? JSON.parse(updated.metadata_json) : {},
            is_default: !!updated.is_default
        });
    } catch (err) {
        console.error('Failed to rotate credential:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to rotate integration credential'
        });
    }
});

/**
 * POST /orgs/:orgId/integrations/:id/test
 * Test connection
 */
router.post('/orgs/:orgId/integrations/:id/test', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), vaultTestLimiter, async (req, res) => {
    try {
        const { orgId, id } = req.params;

        // Get credential with decrypted secrets (internal only)
        const credential = getDecryptedCredential(id);

        if (!credential) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Verify org ownership
        if (credential.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Test connection
        const result = await testConnection(
            credential.integration_type,
            credential.credentials,
            credential.endpoint_url
        );

        // Update test status
        updateTestStatus(id, result.success ? 'success' : 'failed');

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_TEST,
            { type: 'user', id: req.user.id },
            orgId,
            id,
            req,
            { success: result.success, error: result.error }
        );

        if (result.success) {
            // VAULT-INTEG P8: see the identical fix in /test-credentials above.
            res.json({
                success: true,
                result_kind: result.result_kind || 'live',
                message: result.message || 'Connection successful'
            });
        } else {
            res.status(422).json({
                success: false,
                result_kind: result.result_kind,
                error: 'connection_failed',
                message: result.error || 'Connection test failed'
            });
        }
    } catch (err) {
        console.error('Failed to test integration:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to test integration'
        });
    }
});

/**
 * POST /orgs/:orgId/integrations/:id/default
 * Set as default for type
 */
router.post('/orgs/:orgId/integrations/:id/default', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), async (req, res) => {
    try {
        const { orgId, id } = req.params;

        // Get existing credential
        const existing = getCredentialById(id);

        if (!existing) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Verify org ownership
        if (existing.org_id !== orgId) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Set as default
        const updated = setDefault(id);

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_SET_DEFAULT,
            { type: 'user', id: req.user.id },
            orgId,
            id,
            req,
            { integration_type: existing.integration_type, label: existing.label }
        );

        res.json({
            ...updated,
            headers: updated.headers_json ? JSON.parse(updated.headers_json) : {},
            metadata: updated.metadata_json ? JSON.parse(updated.metadata_json) : {},
            is_default: !!updated.is_default
        });
    } catch (err) {
        console.error('Failed to set default:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to set default integration'
        });
    }
});

/**
 * GET /me/cross-org-credentials?type=<integration_type>
 *
 * Returns credentials of `type` that exist in any org the authenticated
 * user belongs to. Powers the cross-org availability banner — when a
 * connector page reports "no credentials in this org", the user can
 * see at a glance whether a credential exists in a sibling org and
 * either switch context or copy it across.
 *
 * No secrets are returned — only credential metadata + org name.
 */
router.get('/me/cross-org-credentials', authenticate(), (req, res) => {
    try {
        const integrationType = req.query.type;
        if (!integrationType || typeof integrationType !== 'string') {
            return res.status(400).json({
                error: 'missing_type',
                message: 'Query parameter `type` is required'
            });
        }
        const available_in = findCredentialsAcrossUserOrgs(req.user.id, integrationType);
        res.json({ integration_type: integrationType, available_in });
    } catch (err) {
        console.error('[CrossOrgCreds] Error:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to look up cross-org credentials'
        });
    }
});

/**
 * POST /orgs/:targetOrgId/integrations/copy-from/:sourceCredentialId
 *
 * Copy an existing credential from a sibling org into the active org.
 * The caller must:
 *   - belong to the target org with SECRETS_WRITE (enforced by middleware)
 *   - belong to the source org (verified inline — no SECRETS_VIEW gate
 *     because the user is only re-using their own access, not exposing
 *     the secret material outside this trust boundary).
 *
 * The new credential is encrypted under the same instance key. Defaults
 * to is_default=true only when the target org has no existing default
 * for this integration type — copying should never silently steal an
 * existing default.
 */
router.post(
    '/orgs/:targetOrgId/integrations/copy-from/:sourceCredentialId',
    authenticate(),
    requireOrgMembership,
    requireCapability(Capabilities.SECRETS_WRITE),
    vaultWriteLimiter,
    async (req, res) => {
        try {
            const { targetOrgId, sourceCredentialId } = req.params;
            const { label, makeDefault } = req.body || {};

            // Confirm source exists and the caller is a member of its org.
            const source = getCredentialById(sourceCredentialId);
            if (!source) {
                return res.status(404).json({
                    error: 'not_found',
                    message: 'Source credential not found'
                });
            }
            if (source.org_id === targetOrgId) {
                return res.status(400).json({
                    error: 'same_org',
                    message: 'Source and target orgs are the same'
                });
            }

            const membership = getDb().prepare(
                'SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?'
            ).get(source.org_id, req.user.id);
            if (!membership) {
                return res.status(403).json({
                    error: 'forbidden',
                    message: 'You are not a member of the source organization'
                });
            }

            const created = copyCredential(sourceCredentialId, targetOrgId, req.user.id, {
                label: typeof label === 'string' && label.trim() ? label.trim() : undefined,
                makeDefault: makeDefault === true ? true : (makeDefault === false ? false : undefined),
            });

            // Audit on both ends so each org's trail records the link.
            logIntegrationEvent(
                AuditActions.INTEGRATION_CREATE,
                { type: 'user', id: req.user.id },
                targetOrgId,
                created.id,
                req,
                {
                    integration_type: created.integration_type,
                    label: created.label,
                    copied_from: { credential_id: sourceCredentialId, org_id: source.org_id },
                }
            );
            logIntegrationEvent(
                AuditActions.INTEGRATION_ACCESS,
                { type: 'user', id: req.user.id },
                source.org_id,
                sourceCredentialId,
                req,
                {
                    integration_type: source.integration_type,
                    label: source.label,
                    copied_to: { credential_id: created.id, org_id: targetOrgId },
                    via: 'cross-org-copy',
                }
            );

            res.status(201).json({
                ...created,
                headers: created.headers_json ? JSON.parse(created.headers_json) : {},
                metadata: created.metadata_json ? JSON.parse(created.metadata_json) : {},
                is_default: !!created.is_default,
            });
        } catch (err) {
            if (err.code === 'source_not_found') {
                return res.status(404).json({ error: 'source_not_found', message: err.message });
            }
            if (err.code === 'same_org') {
                return res.status(400).json({ error: 'same_org', message: err.message });
            }
            console.error('[CopyCredential] Error:', err);
            res.status(500).json({
                error: 'internal_error',
                message: 'Failed to copy credential'
            });
        }
    }
);

/**
 * POST /internal/integrations/:id/decrypt
 * Get decrypted credential (service account only, for workflow execution)
 */
router.post('/internal/integrations/:id/decrypt', authenticateApiKey(), decryptLimiter, async (req, res) => {
    try {
        const { id } = req.params;

        // Get credential with decrypted secrets
        const credential = getDecryptedCredential(id);

        if (!credential) {
            return res.status(404).json({
                error: 'not_found',
                message: 'Integration credential not found'
            });
        }

        // Verify service account has access to this org
        if (req.serviceAccount.orgId !== credential.org_id) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Service account does not have access to this credential'
            });
        }

        // VAULT-P5.G (F4): lease enforcement gate. agent_id is an optional
        // caller-supplied identity (body) used to look up an active lease;
        // the org's vault.lease_enforcement flag decides what happens when
        // the credential requires one and it's missing/expired/exhausted.
        const agentId = req.body?.agent_id || null;
        const leaseGate = evaluateLeaseGate({ orgId: credential.org_id, agentId, credentialId: credential.id });
        if (!leaseGate.allow) {
            writeLeaseAccessAudit({
                orgId: credential.org_id,
                credentialId: credential.id,
                integrationType: credential.integration_type,
                label: credential.label,
                agentId,
                outcome: 'lease_denied',
                reason: leaseGate.reason,
                callerService: req.serviceAccount?.id || 'internal',
                via: 'decrypt',
            });
            return res.status(403).json({ error: 'lease_required', message: 'An active lease is required to access this credential', reason: leaseGate.reason });
        }
        if (leaseGate.advisory) {
            writeLeaseAccessAudit({
                orgId: credential.org_id,
                credentialId: credential.id,
                integrationType: credential.integration_type,
                label: credential.label,
                agentId,
                outcome: 'lease_missing',
                reason: leaseGate.reason,
                callerService: req.serviceAccount?.id || 'internal',
                via: 'decrypt',
            });
        }

        // Update last used
        updateLastUsed(id);

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'service_account', id: req.serviceAccount.id },
            credential.org_id,
            id,
            req,
            { integration_type: credential.integration_type }
        );

        // VAULT-AUDIT P5.E: tamper-evident, WARD-witnessed release audit —
        // alongside (not replacing) the logIntegrationEvent call above.
        writeCredentialReleaseAudit({
            orgId: credential.org_id,
            credentialId: credential.id,
            integrationType: credential.integration_type,
            label: credential.label,
            authType: credential.auth_type,
            callerService: req.serviceAccount?.id || 'internal',
            via: 'decrypt',
        });

        // Return decrypted credentials
        res.json({
            id: credential.id,
            integration_type: credential.integration_type,
            label: credential.label,
            credentials: credential.credentials,
            endpoint_url: credential.endpoint_url,
            auth_type: credential.auth_type,
            headers: credential.headers_json ? JSON.parse(credential.headers_json) : {},
            metadata: credential.metadata_json ? JSON.parse(credential.metadata_json) : {}
        });
    } catch (err) {
        console.error('Failed to decrypt integration:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to decrypt integration credential'
        });
    }
});

/**
 * GET /internal/integrations/:id/service-decrypt
 * Get decrypted credential for internal services (screencap, tasks, etc.)
 * Auth: x-service-key header matching INTERNAL_SERVICE_KEY env var.
 * Query: org_id (REQUIRED for access verification — see VAULT-AUDIT P5.E/F12 below).
 *
 * Simpler than /decrypt (which requires API key auth scheme).
 *
 * VAULT-AUDIT P5.E (F12): a repo-wide AND ecosystem-wide grep for
 * "service-decrypt" (quox-dashboard, quoxflow, quoxagent, quoxmcp,
 * QuoxBastion, quoxterminal, quox-memory, quox-plugin-sdk) found ZERO live
 * callers of this route — the "Used by: screencap vaultClient" comment this
 * replaced was stale; screencap's vaultClient.resolve() actually calls
 * /api/setup/internal/credential-decrypt/:id (server.js:99), not this route.
 * With no caller to break, org_id is now MANDATORY (400 if absent) and the
 * org check is unconditional (404 on mismatch — same response shape as a
 * missing credential, so it can't be used as an existence oracle, mirroring
 * credential-decrypt's P5.A1 fix). Previously: `if (orgId && ...)` meant
 * omitting org_id silently bypassed the org check entirely (fail-open).
 */
router.get('/internal/integrations/:id/service-decrypt', decryptLimiter, async (req, res) => {
    // Service key auth
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        return res.status(401).json({ error: 'service_key_not_configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid service key' });
    }

    try {
        const { id } = req.params;
        const orgId = req.query.org_id || req.headers['x-org-id'];

        if (!orgId) {
            return res.status(400).json({ error: 'missing_org_id', message: 'org_id is required' });
        }

        const credential = getDecryptedCredential(id);
        if (!credential) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // Verify org access — unconditional (no existence oracle): a
        // cross-org caller gets the identical 404 a missing credential would.
        if (credential.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // VAULT-P6.E (F4 regression): this route decrypts a credential exactly
        // like /decrypt does, so it MUST honour the same lease gate. It was
        // missing here — a lease-required credential in an `enforced` org was
        // released in full plaintext via service-decrypt with no active lease
        // (total bypass, found by the P6 self-red-team). Same block as /decrypt.
        const agentId = req.query.agent_id || req.headers['x-agent-id'] || null;
        const leaseGate = evaluateLeaseGate({ orgId: credential.org_id, agentId, credentialId: credential.id });
        if (!leaseGate.allow) {
            writeLeaseAccessAudit({
                orgId: credential.org_id,
                credentialId: credential.id,
                integrationType: credential.integration_type,
                label: credential.label,
                agentId,
                outcome: 'lease_denied',
                reason: leaseGate.reason,
                callerService: 'internal',
                via: 'service-decrypt',
            });
            return res.status(403).json({ error: 'lease_required', message: 'An active lease is required to access this credential', reason: leaseGate.reason });
        }
        if (leaseGate.advisory) {
            writeLeaseAccessAudit({
                orgId: credential.org_id,
                credentialId: credential.id,
                integrationType: credential.integration_type,
                label: credential.label,
                agentId,
                outcome: 'lease_missing',
                reason: leaseGate.reason,
                callerService: 'internal',
                via: 'service-decrypt',
            });
        }

        // Update last used
        updateLastUsed(id);

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'internal_service', id: 'screencap' },
            credential.org_id,
            id,
            req,
            { integration_type: credential.integration_type, access_method: 'service-decrypt' }
        );

        // VAULT-AUDIT P5.E: tamper-evident, WARD-witnessed release audit —
        // alongside (not replacing) the logIntegrationEvent call above.
        writeCredentialReleaseAudit({
            orgId: credential.org_id,
            credentialId: credential.id,
            integrationType: credential.integration_type,
            label: credential.label,
            authType: credential.auth_type,
            callerService: 'internal',
            via: 'service-decrypt',
        });

        res.json({
            id: credential.id,
            integration_type: credential.integration_type,
            label: credential.label,
            org_id: credential.org_id,
            credentials: credential.credentials,
            endpoint_url: credential.endpoint_url,
        });
    } catch (err) {
        console.error('[Vault] Service decrypt error:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to decrypt credential' });
    }
});

/**
 * DELETE /internal/integrations/:id
 * BASTION-CRED Phase 1: server-to-server auto-revoke, restricted to
 * BOOTSTRAP credentials only (metadata.purpose === 'bootstrap'). Used by
 * the collector to revoke a one-time-use bootstrap SSH credential once the
 * host is enrolled — it must NEVER be able to delete a general vault
 * credential, even by a valid service-key holder.
 *
 * Auth: x-service-key header matching INTERNAL_SERVICE_KEY env var — same
 * mechanism as GET /internal/integrations/:id/service-decrypt, fail CLOSED
 * when the key is unconfigured (checked before anything else).
 * Query: org_id (REQUIRED — same 404-not-403 no-existence-oracle convention
 * as service-decrypt: missing credential and cross-org mismatch are
 * indistinguishable from the outside).
 */
router.delete('/internal/integrations/:id', decryptLimiter, async (req, res) => {
    // Service key auth — fail CLOSED.
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        return res.status(401).json({ error: 'service_key_not_configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid service key' });
    }

    try {
        const { id } = req.params;
        const orgId = req.query.org_id || req.headers['x-org-id'];

        if (!orgId) {
            return res.status(400).json({ error: 'missing_org_id', message: 'org_id is required' });
        }

        const existing = getCredentialById(id);
        if (!existing) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // No existence oracle: a cross-org caller gets the identical 404 a
        // missing credential would.
        if (existing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // LEAST PRIVILEGE: this route can only ever delete bootstrap
        // credentials. A general vault credential (or any row missing the
        // bootstrap marker) is refused, never deleted.
        let metadata = {};
        try {
            metadata = existing.metadata_json ? JSON.parse(existing.metadata_json) : {};
        } catch { /* malformed metadata treated as non-bootstrap below */ }
        if (metadata?.purpose !== 'bootstrap') {
            return res.status(403).json({ error: 'not_a_bootstrap_credential' });
        }

        const callerService = 'collector';

        deleteCredential(id);

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_DELETE,
            { type: 'service', id: callerService },
            existing.org_id,
            id,
            req,
            { integration_type: existing.integration_type, label: existing.label, via: 'internal-delete-route' }
        );

        // F10: invalidate the 30s resolver cache so the deleted
        // credential's plaintext can't still be served post-delete.
        clearResolverCache();

        // BASTION-CRED Phase 1: same AEE envelope as the user-facing delete
        // route, from the calling service instead of a human. Fire-and-forget.
        try {
            const { emitEnvelope } = await import('../lib/aeeClient.js');
            emitEnvelope({
                from: `service.${callerService}`,
                to: 'audit.system',
                intent: 'quox.vault.credential.deleted',
                corr: `VAULT_${id}`,
                payload: {
                    credential_id: id,
                    integration_type: existing.integration_type,
                    label: existing.label,
                    org_id: existing.org_id,
                    credential_kind: existing.credential_kind || undefined,
                    via: 'internal-delete-route',
                },
            });
        } catch (e) { /* audit is fire-and-forget */ }

        res.status(204).send();
    } catch (err) {
        console.error('[Vault] Internal delete error:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to delete credential' });
    }
});

/**
 * GET /internal/integrations/by-domain/:domain
 * Find credentials matching a domain (for auto-detection during browser login).
 * Auth: x-service-key header.
 * Query: org_id (required)
 */
router.get('/internal/integrations/by-domain/:domain', decryptLimiter, async (req, res) => {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        return res.status(401).json({ error: 'service_key_not_configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    try {
        const { domain } = req.params;
        const orgId = req.query.org_id || req.headers['x-org-id'];
        if (!orgId) {
            return res.status(400).json({ error: 'missing_org_id', message: 'org_id is required' });
        }

        // List all browser_login credentials for this org.
        // VAULT-AUDIT P5.I (F14): listCredentials() only ever read
        // filters.integration_type (db/integrations.js:69) — the `type` key
        // passed here was silently ignored, so this scanned ALL org
        // credentials (any integration_type) and relied solely on the
        // in-JS domain filter below, which can match non-browser_login rows
        // that merely happen to carry a `domain` key in metadata_json.
        const allCreds = listCredentials(orgId, { integration_type: 'browser_login' });

        // Filter by domain match (exact or subdomain)
        const matching = allCreds.filter(cred => {
            const credDomain = cred.metadata_json ? JSON.parse(cred.metadata_json)?.domain : null;
            if (!credDomain) return false;
            return domain === credDomain || domain.endsWith('.' + credDomain);
        });

        res.json({
            credentials: matching.map(c => ({
                id: c.id,
                label: c.label,
                domain: JSON.parse(c.metadata_json || '{}').domain,
                integration_type: c.integration_type,
            })),
            count: matching.length,
        });
    } catch (err) {
        console.error('[Vault] Domain lookup error:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to look up credentials' });
    }
});

/**
 * GET /internal/vault-health
 * Lightweight vault health summary for the platform aggregate health endpoint.
 * Auth: x-service-key header matching INTERNAL_SERVICE_KEY env var.
 * Query: org_id (optional, defaults to 'default' — same single-tenant
 * convention the collector already uses for its other internal cross-service
 * health calls, e.g. tasks/memory in server.js refreshCollectorMirror).
 * Used by: collector /api/v1/health/aggregate (consumed by PlatformPulse.jsx).
 */
router.get('/internal/vault-health', (req, res) => {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        return res.status(401).json({ error: 'service_key_not_configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    try {
        const orgId = req.query.org_id || req.headers['x-org-id'] || 'default';
        const stats = getVaultStats(orgId);
        res.json({
            total: stats.total,
            healthy: stats.healthy,
            expiring_soon: stats.expiring
        });
    } catch (err) {
        console.error('[VaultHealth] Internal error:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Failed to get vault health' });
    }
});

/**
 * POST /internal/integrations/resolve
 * Unified credential resolution — waterfall: vault → instance_config → env
 * Used by collector to resolve AI provider and notification credentials.
 *
 * Body: { org_id, providers: ['anthropic', 'openai', ...], fallback_to_instance: true }
 * Returns: { providers: { anthropic: { key, source }, ... } }
 */
router.post('/internal/integrations/resolve', authenticateApiKey(), decryptLimiter, async (req, res) => {
    try {
        const { org_id, providers = [], channels = [], fallback_to_instance = true, fallback_to_env = true } = req.body;

        if (!org_id) {
            return res.status(400).json({
                error: 'missing_org_id',
                message: 'org_id is required'
            });
        }

        // Verify service account has access to this org
        if (req.serviceAccount.orgId !== org_id) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Service account does not have access to this organization'
            });
        }

        // Lazy import to avoid circular deps
        const { resolveProviderKey, resolveClaudeKeys, resolveNotificationCredentials } = await import('../services/credentialResolver.js');

        const result = { providers: {}, channels: {} };

        // Resolve AI provider keys
        for (const provider of providers) {
            if (provider === 'claude') {
                result.providers.claude = resolveClaudeKeys(org_id);
            } else {
                result.providers[provider] = resolveProviderKey(org_id, provider, {
                    fallbackToInstance: fallback_to_instance,
                    fallbackToEnv: fallback_to_env
                });
            }
        }

        // Resolve notification channel credentials
        for (const channel of channels) {
            result.channels[channel] = resolveNotificationCredentials(org_id, channel);
        }

        // Audit log
        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'service_account', id: req.serviceAccount.id },
            org_id,
            null,
            req,
            { action: 'resolve', providers, channels }
        );

        res.json(result);
    } catch (err) {
        console.error('Failed to resolve credentials:', err);
        res.status(500).json({
            error: 'internal_error',
            message: 'Failed to resolve credentials'
        });
    }
});

// Agent Credential Assignments — moved to routes/agent-credentials.js (Phase 14)

// ============================================================================
// Credential Folders
// ============================================================================

/**
 * GET /orgs/:orgId/credential-folders
 * List all folders for an org
 */
router.get('/orgs/:orgId/credential-folders', authenticate(), requireOrgMembership, (req, res) => {
    try {
        const folders = listFolders(req.params.orgId);
        res.json({ folders });
    } catch (err) {
        console.error('Failed to list folders:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to list folders' });
    }
});

/**
 * POST /orgs/:orgId/credential-folders
 * Create a folder
 */
router.post('/orgs/:orgId/credential-folders', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const { name, parent_id, color, icon } = req.body;

        if (!name || name.trim().length < 1) {
            return res.status(400).json({ error: 'validation_error', message: 'Folder name is required' });
        }

        const folder = createFolder({
            org_id: req.params.orgId,
            name: name.trim(),
            parent_id: parent_id || null,
            color,
            icon,
            created_by: req.user.id
        });

        res.status(201).json(folder);
    } catch (err) {
        if (err.message?.includes('nesting depth')) {
            return res.status(400).json({ error: 'validation_error', message: err.message });
        }
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'conflict', message: 'A folder with that name already exists at this level' });
        }
        console.error('Failed to create folder:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to create folder' });
    }
});

/**
 * PUT /orgs/:orgId/credential-folders/:folderId
 * Update a folder
 */
router.put('/orgs/:orgId/credential-folders/:folderId', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const existing = getFolderById(req.params.folderId);
        if (!existing || existing.org_id !== req.params.orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Folder not found' });
        }

        const { name, color, icon, parent_id } = req.body;
        const folder = updateFolder(req.params.folderId, { name: name?.trim(), color, icon, parent_id });
        res.json(folder);
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'conflict', message: 'A folder with that name already exists at this level' });
        }
        console.error('Failed to update folder:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to update folder' });
    }
});

/**
 * DELETE /orgs/:orgId/credential-folders/:folderId
 * Delete a folder (moves credentials to no-folder)
 */
router.delete('/orgs/:orgId/credential-folders/:folderId', authenticate(), requireOrgMembership, requireCapability(Capabilities.SECRETS_WRITE), (req, res) => {
    try {
        const existing = getFolderById(req.params.folderId);
        if (!existing || existing.org_id !== req.params.orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Folder not found' });
        }

        deleteFolder(req.params.folderId);
        res.json({ deleted: true });
    } catch (err) {
        console.error('Failed to delete folder:', err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to delete folder' });
    }
});

export default router;
