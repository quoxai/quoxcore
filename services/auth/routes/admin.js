/**
 * Instance Admin routes for Quox Auth Service
 *
 * All routes require instance admin authentication.
 *
 * GET    /admin/config              List all config
 * PATCH  /admin/config/:key         Update config value
 * GET    /admin/admins              List instance admins
 * POST   /admin/admins              Grant admin role
 * DELETE /admin/admins/:userId      Revoke admin role
 * GET    /admin/keys                List system API keys
 * POST   /admin/keys                Create system API key
 * PATCH  /admin/keys/:id            Update key
 * DELETE /admin/keys/:id            Delete key
 * POST   /admin/keys/:id/test       Test key validity
 * GET    /admin/services            List registered services
 * POST   /admin/services/:id/check  Trigger health check
 * GET    /admin/logs                Query system logs
 * GET    /admin/stats               Instance statistics
 */

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import {
    requireInstanceAdmin,
    listInstanceAdmins,
    grantInstanceAdmin,
    revokeInstanceAdmin,
    checkInstanceAdmin
} from '../middleware/instanceAdmin.js';
import { encrypt, decrypt, getKeyPreview, validateApiKeyFormat, validateMasterKey } from '../utils/encryption.js';
import { getRotatableStores, reencryptStore } from '../config/encryptedStores.js';
import { generateId } from '../utils/crypto.js';
import { logAudit, logAdminAccess, AuditActions } from '../utils/audit.js';
import { getDb } from '../db/index.js';
import { probeServiceHealth } from '../utils/serviceHealthClassifier.js';

const router = Router();

// All admin routes require authentication + instance admin
router.use(authenticate());
router.use(requireInstanceAdmin('readonly'));

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * GET /admin/config
 * List all instance configuration
 */
router.get('/config', (req, res) => {
    try {
        const db = getDb();
        const configs = db.prepare(`
            SELECT key, value, value_type, encrypted, description, updated_at
            FROM instance_config
            ORDER BY key
        `).all();

        // Don't return encrypted values
        const safeConfigs = configs.map(c => ({
            ...c,
            value: c.encrypted ? '[ENCRYPTED]' : c.value
        }));

        // Security Issue #75: Log admin data access
        logAdminAccess(
            AuditActions.ADMIN_VIEW_CONFIG,
            { type: 'user', id: req.user.id },
            req,
            { type: 'config', id: 'all' },
            { configCount: configs.length }
        );

        res.json({ config: safeConfigs });
    } catch (err) {
        console.error('Get config error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch config' });
    }
});

/**
 * POST /admin/agent-identities
 * QUOXPERTICUS P2: mint (or rotate) an AGENT identity — an actor_type=agent
 * user, its org membership, and an mcp_token bound to the agent id on the
 * token row. Instance-admin only; the raw token is returned exactly once,
 * and the admin places it in the resident supervisor's root-only config.
 * Body: { agent_id, org_id, rotate? }.
 */
router.post('/agent-identities', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { agent_id, org_id, rotate } = req.body || {};
        const { mintAgentIdentity } = await import('../lib/agentIdentity.js');
        const result = mintAgentIdentity(getDb(), { agentId: agent_id, orgId: org_id, rotate: rotate === true });
        logAudit({
            action: 'admin.agent_identity.mint',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'agent_identity', id: result.agent_id },
            request: req,
            metadata: { org_id, user_id: result.user_id, token_id: result.token_id, rotated: result.rotated }
        });
        return res.status(201).json({
            agent_id: result.agent_id,
            user_id: result.user_id,
            token_id: result.token_id,
            rotated: result.rotated,
            // Returned exactly once; never stored or logged in the clear.
            token: result.raw_token,
        });
    } catch (error) {
        const msg = error.message || 'mint failed';
        const status = /already exists/i.test(msg) ? 409 : /invalid|required|unknown org/i.test(msg) ? 400 : 500;
        return res.status(status).json({ error: 'agent_identity_mint_failed', message: msg });
    }
});

/**
 * PATCH /admin/config/:key
 * Update a config value
 */
router.patch('/config/:key', requireInstanceAdmin('admin'), (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        if (value === undefined) {
            return res.status(400).json({ error: 'value_required', message: 'Value is required' });
        }

        const db = getDb();
        const existing = db.prepare('SELECT * FROM instance_config WHERE key = ?').get(key);

        if (!existing) {
            return res.status(404).json({ error: 'not_found', message: 'Config key not found' });
        }

        // Store value (encrypt if needed)
        const storedValue = existing.encrypted ? encrypt(String(value)) : String(value);

        db.prepare(`
            UPDATE instance_config
            SET value = ?, updated_at = datetime('now'), updated_by = ?
            WHERE key = ?
        `).run(storedValue, req.user.id, key);

        logAudit({
            action: 'admin.config.update',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: key },
            request: req,
            metadata: { key }
        });

        res.json({ success: true, key, updated: true });
    } catch (err) {
        console.error('Update config error:', err);
        res.status(500).json({ error: 'update_failed', message: 'Failed to update config' });
    }
});

/**
 * POST /admin/config/integration
 * Save an AI provider API key (post-setup). Handles encryption, vault ID tracking,
 * and dual-write to vault for the active org.
 *
 * Body: { field: 'anthropicKey', value: 'sk-ant-...', vaultCredentialId?: 'cred-xxx' | null }
 */
const INTEGRATION_FIELD_MAP = {
    anthropicKey:   { configKey: 'anthropic_api_key',   vaultIdKey: 'anthropic_vault_credential_id',   encrypt: true },
    openaiKey:      { configKey: 'openai_api_key',      vaultIdKey: 'openai_vault_credential_id',      encrypt: true },
    elevenlabsKey:  { configKey: 'elevenlabs_api_key',  vaultIdKey: 'elevenlabs_vault_credential_id',  encrypt: true },
    perplexityKey:  { configKey: 'perplexity_api_key',  vaultIdKey: 'perplexity_vault_credential_id',  encrypt: true },
    geminiKey:      { configKey: 'gemini_api_key',      vaultIdKey: 'gemini_vault_credential_id',      encrypt: true },
    codexKey:       { configKey: 'codex_api_key',       vaultIdKey: 'codex_vault_credential_id',       encrypt: true },
    claudeToken:    { configKey: 'claude_oauth_token',  vaultIdKey: null,                              encrypt: true },
    qdrantUrl:      { configKey: 'qdrant_url',          vaultIdKey: null,                              encrypt: false },
};

router.post('/config/integration', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { field, value, vaultCredentialId } = req.body || {};

        if (!field || !INTEGRATION_FIELD_MAP[field]) {
            return res.status(400).json({ error: 'invalid_field', message: `Unknown field: ${field}` });
        }

        const mapping = INTEGRATION_FIELD_MAP[field];

        // Resolve the actual key value — either provided directly or from vault
        let keyValue = value;
        if (!keyValue && vaultCredentialId) {
            // Resolve from vault server-side (no need for frontend to call internal endpoint)
            const { getDecryptedCredential } = await import('../db/integrations.js');
            const decrypted = getDecryptedCredential(vaultCredentialId);
            if (!decrypted) {
                return res.status(404).json({ error: 'credential_not_found', message: 'Vault credential not found' });
            }
            // getDecryptedCredential returns full row with nested credentials object
            const credObj = decrypted.credentials || (typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted);
            keyValue = credObj.api_key || credObj.token || credObj.secret;
            if (!keyValue) {
                return res.status(400).json({ error: 'no_key_in_credential', message: 'Vault credential has no API key' });
            }
        }

        if (!keyValue) {
            return res.status(400).json({ error: 'value_required', message: 'Provide a value or vaultCredentialId' });
        }
        const db = getDb();

        // Upsert the key value (with encryption if needed)
        const storedValue = mapping.encrypt ? encrypt(String(keyValue)) : String(keyValue);
        const encrypted = mapping.encrypt ? 1 : 0;

        db.prepare(`
            INSERT INTO instance_config (key, value, encrypted, updated_at, updated_by)
            VALUES (?, ?, ?, datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET value = ?, encrypted = ?, updated_at = datetime('now'), updated_by = ?
        `).run(mapping.configKey, storedValue, encrypted, req.user.id, storedValue, encrypted, req.user.id);

        // Track which vault credential was used (or clear if manual)
        if (mapping.vaultIdKey) {
            if (vaultCredentialId) {
                db.prepare(`
                    INSERT INTO instance_config (key, value, encrypted, updated_at, updated_by)
                    VALUES (?, ?, 0, datetime('now'), ?)
                    ON CONFLICT(key) DO UPDATE SET value = ?, encrypted = 0, updated_at = datetime('now'), updated_by = ?
                `).run(mapping.vaultIdKey, vaultCredentialId, req.user.id, vaultCredentialId, req.user.id);
            } else {
                // Manual key entry — clear any vault credential reference
                db.prepare('DELETE FROM instance_config WHERE key = ?').run(mapping.vaultIdKey);
            }
        }

        logAudit({
            action: AuditActions.CONFIG_API_KEY_SET || 'admin.config.integration.update',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: mapping.configKey },
            request: req,
            metadata: { field, source: vaultCredentialId ? 'vault' : 'manual' }
        });

        res.json({ success: true, field, updatedAt: new Date().toISOString() });
    } catch (err) {
        console.error('Integration config save error:', err);
        res.status(500).json({ error: 'save_failed', message: err.message || 'Failed to save integration config' });
    }
});

/**
 * POST /admin/config/integration/test
 * Test an API key against the provider's API.
 *
 * Body: { provider: 'anthropic', key?: 'sk-ant-...' }
 * If key omitted, tests the currently stored key.
 */
// ============================================================================
// EMAIL / SMTP (QCPRO-SMTP — instance email onboarding)
// ============================================================================

/**
 * GET /admin/email/status
 * Sanitised SMTP state for the onboarding surface: configured?, host, from,
 * last test-send outcome. Never returns credentials.
 */
router.get('/email/status', async (req, res) => {
    try {
        const { getSmtpStatus } = await import('../utils/emailService.js');
        res.json(getSmtpStatus());
    } catch (err) {
        console.error('Email status error:', err);
        res.status(500).json({ error: 'status_failed', message: 'Failed to read email status' });
    }
});

/**
 * PUT /admin/email/smtp
 * Upsert the instance SMTP config (canonical smtp_* keys; password
 * encrypted at rest; blank password keeps the stored one). Resets the
 * send-path cache so the change takes effect immediately.
 *
 * Body: { host, port, user, pass, from, secure }
 */
router.put('/email/smtp', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { upsertSmtpConfig } = await import('../utils/emailService.js');
        const result = upsertSmtpConfig(req.body || {}, { userId: req.user.id });
        if (!result.ok) {
            return res.status(400).json({ error: 'invalid_smtp_config', fields: result.errors });
        }
        logAudit({
            action: 'admin.email.smtp.update',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: 'smtp' },
            request: req,
            metadata: { host: (req.body || {}).host },
        });
        res.json({ success: true });
    } catch (err) {
        console.error('SMTP config error:', err);
        res.status(500).json({ error: 'smtp_save_failed', message: 'Failed to save SMTP config' });
    }
});

/**
 * POST /admin/email/test
 * Send a test email (default: to the calling admin) and record the honest
 * outcome for the status surface. A failed send returns delivered:false
 * with the transport error, never a fake success.
 *
 * Body: { to? }
 */
router.post('/email/test', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { sendEmail, recordEmailTestResult, getSmtpStatus } = await import('../utils/emailService.js');
        const db = getDb();
        const to = (req.body && req.body.to) || req.user.email;
        if (!to) return res.status(400).json({ error: 'no_recipient', message: 'No recipient email available' });

        let outcome;
        try {
            outcome = await sendEmail({
                to,
                subject: 'QuoxCORE email test',
                text: 'This is a test email from your QuoxCORE instance. Email delivery is working.',
            });
        } catch (err) {
            outcome = { delivered: false, reason: err.message };
        }
        recordEmailTestResult(db, { ok: !!outcome.delivered, detail: outcome.delivered ? null : (outcome.reason || 'unknown_error') });
        logAudit({
            action: 'admin.email.test_send',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: 'smtp' },
            request: req,
            metadata: { to, delivered: !!outcome.delivered },
        });
        res.json({ ...outcome, status: getSmtpStatus() });
    } catch (err) {
        console.error('Email test error:', err);
        res.status(500).json({ error: 'test_failed', message: 'Failed to run email test' });
    }
});

router.post('/config/integration/test', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { provider, key } = req.body || {};

        if (!provider) {
            return res.status(400).json({ error: 'provider_required', message: 'Provider name is required' });
        }

        let apiKey = key;

        // If no key provided, resolve from stored credentials
        if (!apiKey) {
            const { resolveProviderKey } = await import('../services/credentialResolver.js');
            const resolved = resolveProviderKey('default', provider);
            if (!resolved?.key) {
                // Try finding any org's default like voice-keys does
                const db = getDb();
                const firstOrg = db.prepare(
                    "SELECT DISTINCT org_id FROM integration_credentials WHERE integration_type = ? AND is_default = 1 LIMIT 1"
                ).get(provider);
                if (firstOrg?.org_id) {
                    const orgResolved = resolveProviderKey(firstOrg.org_id, provider);
                    apiKey = orgResolved?.key;
                }
            } else {
                apiKey = resolved.key;
            }
        }

        if (!apiKey) {
            return res.status(400).json({ error: 'no_key', message: `No ${provider} API key configured or provided` });
        }

        const { testConnection } = await import('../services/integrationHealthService.js');
        const startTime = Date.now();
        const result = await testConnection(provider, { api_key: apiKey });
        const latencyMs = Date.now() - startTime;

        res.json({
            success: result.success,
            latencyMs,
            error: result.error || undefined,
            message: result.message || undefined,
        });
    } catch (err) {
        console.error('Integration test error:', err);
        res.status(500).json({ error: 'test_failed', message: err.message || 'Test failed' });
    }
});

// ============================================================================
// INSTANCE ADMINS
// ============================================================================

/**
 * GET /admin/admins
 * List all instance administrators
 */
router.get('/admins', (req, res) => {
    try {
        const admins = listInstanceAdmins();

        // Security Issue #75: Log admin data access
        logAdminAccess(
            AuditActions.ADMIN_VIEW_ADMINS,
            { type: 'user', id: req.user.id },
            req,
            { type: 'admin_list', id: 'all' },
            { adminCount: admins.length }
        );

        res.json({ admins });
    } catch (err) {
        console.error('List admins error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch admins' });
    }
});

/**
 * POST /admin/admins
 * Grant instance admin role
 */
router.post('/admins', requireInstanceAdmin('superadmin'), (req, res) => {
    try {
        const { user_id, role = 'admin' } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'user_id_required', message: 'User ID required' });
        }

        if (!['admin', 'readonly', 'superadmin'].includes(role)) {
            return res.status(400).json({ error: 'invalid_role', message: 'Invalid admin role' });
        }

        // Only superadmin can grant superadmin
        if (role === 'superadmin' && req.instanceAdmin.role !== 'superadmin') {
            return res.status(403).json({ error: 'forbidden', message: 'Only superadmin can grant superadmin' });
        }

        const result = grantInstanceAdmin(user_id, role, req.user.id);

        if (!result.success) {
            return res.status(400).json({ error: 'grant_failed', message: result.message });
        }

        logAudit({
            action: 'admin.grant',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'user', id: user_id },
            request: req,
            metadata: { role }
        });

        res.json({ success: true, action: result.action });
    } catch (err) {
        console.error('Grant admin error:', err);
        res.status(500).json({ error: 'grant_failed', message: 'Failed to grant admin' });
    }
});

/**
 * DELETE /admin/admins/:userId
 * Revoke instance admin role
 */
router.delete('/admins/:userId', requireInstanceAdmin('superadmin'), (req, res) => {
    try {
        const { userId } = req.params;

        const result = revokeInstanceAdmin(userId, req.user.id);

        if (!result.success) {
            return res.status(400).json({ error: 'revoke_failed', message: result.message });
        }

        logAudit({
            action: 'admin.revoke',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'user', id: userId },
            request: req
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Revoke admin error:', err);
        res.status(500).json({ error: 'revoke_failed', message: 'Failed to revoke admin' });
    }
});

// ============================================================================
// API KEYS
// ============================================================================

/**
 * GET /admin/keys
 * List system API keys
 */
router.get('/keys', (req, res) => {
    try {
        const db = getDb();
        const keys = db.prepare(`
            SELECT id, provider, name, key_preview, model_config_json,
                   is_default, is_active, usage_count, last_used_at, last_error,
                   created_at, updated_at
            FROM api_keys
            WHERE scope_type = 'instance' AND scope_id IS NULL
            ORDER BY provider, name
        `).all();

        // Security Issue #75: Log admin data access - viewing API keys is sensitive
        logAdminAccess(
            AuditActions.ADMIN_VIEW_API_KEYS,
            { type: 'user', id: req.user.id },
            req,
            { type: 'api_keys', id: 'all' },
            { keyCount: keys.length, providers: [...new Set(keys.map(k => k.provider))] }
        );

        res.json({
            keys: keys.map(k => ({
                ...k,
                model_config: JSON.parse(k.model_config_json || '{}')
            }))
        });
    } catch (err) {
        console.error('List keys error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch keys' });
    }
});

/**
 * POST /admin/keys
 * Create system API key
 */
router.post('/keys', requireInstanceAdmin('admin'), (req, res) => {
    try {
        const { provider, name, api_key, model_config, is_default } = req.body;

        if (!provider || !name || !api_key) {
            return res.status(400).json({
                error: 'validation_error',
                message: 'Provider, name, and api_key are required'
            });
        }

        // Validate key format
        const validation = validateApiKeyFormat(provider, api_key);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'invalid_key_format',
                message: validation.message
            });
        }

        const db = getDb();

        // Check for duplicate
        const existing = db.prepare(`
            SELECT id FROM api_keys
            WHERE scope_type = 'instance' AND scope_id IS NULL
            AND provider = ? AND name = ?
        `).get(provider, name);

        if (existing) {
            return res.status(409).json({
                error: 'key_exists',
                message: 'A key with this provider and name already exists'
            });
        }

        // Encrypt and store
        const keyId = generateId();
        const keyCiphertext = encrypt(api_key);
        const keyPreview = getKeyPreview(api_key);

        // If setting as default, unset other defaults for this provider
        if (is_default) {
            db.prepare(`
                UPDATE api_keys SET is_default = 0
                WHERE scope_type = 'instance' AND scope_id IS NULL AND provider = ?
            `).run(provider);
        }

        db.prepare(`
            INSERT INTO api_keys (id, scope_type, scope_id, provider, name, key_ciphertext, key_preview, model_config_json, is_default, created_by)
            VALUES (?, 'instance', NULL, ?, ?, ?, ?, ?, ?, ?)
        `).run(keyId, provider, name, keyCiphertext, keyPreview, JSON.stringify(model_config || {}), is_default ? 1 : 0, req.user.id);

        logAudit({
            action: 'admin.key.create',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'api_key', id: keyId },
            request: req,
            metadata: { provider, name }
        });

        res.status(201).json({
            success: true,
            key: {
                id: keyId,
                provider,
                name,
                key_preview: keyPreview,
                is_default: !!is_default
            }
        });
    } catch (err) {
        console.error('Create key error:', err);
        res.status(500).json({ error: 'create_failed', message: 'Failed to create key' });
    }
});

/**
 * PATCH /admin/keys/:id
 * Update API key
 */
router.patch('/keys/:id', requireInstanceAdmin('admin'), (req, res) => {
    try {
        const { id } = req.params;
        const { name, api_key, model_config, is_default, is_active } = req.body;

        const db = getDb();
        const existing = db.prepare(`
            SELECT * FROM api_keys WHERE id = ? AND scope_type = 'instance'
        `).get(id);

        if (!existing) {
            return res.status(404).json({ error: 'not_found', message: 'Key not found' });
        }

        const updates = [];
        const values = [];

        if (name !== undefined) {
            updates.push('name = ?');
            values.push(name);
        }

        if (api_key) {
            const validation = validateApiKeyFormat(existing.provider, api_key);
            if (!validation.valid) {
                return res.status(400).json({ error: 'invalid_key_format', message: validation.message });
            }
            updates.push('key_ciphertext = ?', 'key_preview = ?');
            values.push(encrypt(api_key), getKeyPreview(api_key));
        }

        if (model_config !== undefined) {
            updates.push('model_config_json = ?');
            values.push(JSON.stringify(model_config));
        }

        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active ? 1 : 0);
        }

        if (is_default !== undefined) {
            if (is_default) {
                // Unset other defaults
                db.prepare(`
                    UPDATE api_keys SET is_default = 0
                    WHERE scope_type = 'instance' AND provider = ? AND id != ?
                `).run(existing.provider, id);
            }
            updates.push('is_default = ?');
            values.push(is_default ? 1 : 0);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'no_updates', message: 'No updates provided' });
        }

        updates.push('updated_at = datetime(\'now\')');
        values.push(id);

        db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        logAudit({
            action: 'admin.key.update',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'api_key', id },
            request: req,
            metadata: { updates: Object.keys(req.body) }
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Update key error:', err);
        res.status(500).json({ error: 'update_failed', message: 'Failed to update key' });
    }
});

/**
 * DELETE /admin/keys/:id
 * Delete API key
 */
router.delete('/keys/:id', requireInstanceAdmin('admin'), (req, res) => {
    try {
        const { id } = req.params;

        const db = getDb();
        const existing = db.prepare(`
            SELECT provider, name FROM api_keys WHERE id = ? AND scope_type = 'instance'
        `).get(id);

        if (!existing) {
            return res.status(404).json({ error: 'not_found', message: 'Key not found' });
        }

        db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

        logAudit({
            action: 'admin.key.delete',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'api_key', id },
            request: req,
            metadata: { provider: existing.provider, name: existing.name }
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Delete key error:', err);
        res.status(500).json({ error: 'delete_failed', message: 'Failed to delete key' });
    }
});

/**
 * POST /admin/keys/:id/test
 * Test API key validity
 */
router.post('/keys/:id/test', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const db = getDb();
        const key = db.prepare(`
            SELECT * FROM api_keys WHERE id = ? AND scope_type = 'instance'
        `).get(id);

        if (!key) {
            return res.status(404).json({ error: 'not_found', message: 'Key not found' });
        }

        // Decrypt key
        const apiKey = decrypt(key.key_ciphertext);

        // Test based on provider
        let testResult = { success: false, message: 'Unknown provider' };

        try {
            switch (key.provider) {
                case 'anthropic':
                    testResult = await testAnthropicKey(apiKey);
                    break;
                case 'openai':
                    testResult = await testOpenAIKey(apiKey);
                    break;
                default:
                    testResult = { success: true, message: 'Key format validated (no API test available)' };
            }
        } catch (testErr) {
            testResult = { success: false, message: testErr.message };
        }

        // Update last_error if failed
        if (!testResult.success) {
            db.prepare(`
                UPDATE api_keys SET last_error = ?, updated_at = datetime('now') WHERE id = ?
            `).run(testResult.message, id);
        } else {
            db.prepare(`
                UPDATE api_keys SET last_error = NULL, updated_at = datetime('now') WHERE id = ?
            `).run(id);
        }

        // Security Issue #75: Log API key test (involves decrypting and using key)
        logAdminAccess(
            AuditActions.ADMIN_TEST_API_KEY,
            { type: 'user', id: req.user.id },
            req,
            { type: 'api_key', id },
            { provider: key.provider, testSuccess: testResult.success }
        );

        res.json(testResult);
    } catch (err) {
        console.error('Test key error:', err);
        res.status(500).json({ error: 'test_failed', message: 'Failed to test key' });
    }
});

// Key testing helpers
async function testAnthropicKey(apiKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }]
        }),
        // STABILITY-AUDITS: a hung provider must not hang this admin route.
        signal: AbortSignal.timeout(10_000)
    });

    if (response.ok) {
        return { success: true, message: 'Anthropic API key is valid' };
    }

    const error = await response.json().catch(() => ({}));
    if (response.status === 401) {
        return { success: false, message: 'Invalid API key' };
    }
    return { success: false, message: error.error?.message || `API error: ${response.status}` };
}

async function testOpenAIKey(apiKey) {
    const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        // STABILITY-AUDITS: a hung provider must not hang this admin route.
        signal: AbortSignal.timeout(10_000)
    });

    if (response.ok) {
        return { success: true, message: 'OpenAI API key is valid' };
    }

    if (response.status === 401) {
        return { success: false, message: 'Invalid API key' };
    }
    return { success: false, message: `API error: ${response.status}` };
}

// ============================================================================
// SERVICES
// ============================================================================

/**
 * GET /admin/services
 * List registered services
 */
router.get('/services', (req, res) => {
    try {
        const db = getDb();
        const services = db.prepare(`
            SELECT * FROM services ORDER BY name
        `).all();

        // Security Issue #75: Log admin data access
        logAdminAccess(
            AuditActions.ADMIN_VIEW_SERVICES,
            { type: 'user', id: req.user.id },
            req,
            { type: 'services', id: 'all' },
            { serviceCount: services.length }
        );

        res.json({
            services: services.map(s => ({
                ...s,
                config: JSON.parse(s.config_json || '{}')
            }))
        });
    } catch (err) {
        console.error('List services error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch services' });
    }
});

/**
 * POST /admin/services/:id/check
 * Trigger health check for a service
 */
router.post('/services/:id/check', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const db = getDb();
        const service = db.prepare('SELECT * FROM services WHERE id = ?').get(id);

        if (!service) {
            return res.status(404).json({ error: 'not_found', message: 'Service not found' });
        }

        if (!service.health_endpoint) {
            return res.status(400).json({ error: 'no_endpoint', message: 'Service has no health endpoint' });
        }

        // FALSE-NEGATIVE FIX: services that are legitimately not part of this
        // deployment (e.g. n8n under the optional with-n8n compose profile)
        // classify as 'disabled' (not configured) rather than 'unhealthy' on
        // a network-level failure — see serviceHealthClassifier.js.
        //
        // probeServiceHealth() is the shared fetch+classify step, also reused
        // by the periodic serviceHealthScheduler.js background job.
        const { status, statusMessage } = await probeServiceHealth(service);

        // Update service status
        const updateSql = status === 'healthy'
            ? `UPDATE services SET status = ?, status_message = ?, last_check_at = datetime('now'), last_healthy_at = datetime('now') WHERE id = ?`
            : `UPDATE services SET status = ?, status_message = ?, last_check_at = datetime('now') WHERE id = ?`;

        db.prepare(updateSql).run(status, statusMessage, id);

        // Security Issue #75: Log service health check action
        logAdminAccess(
            AuditActions.ADMIN_SERVICE_HEALTH_CHECK,
            { type: 'user', id: req.user.id },
            req,
            { type: 'service', id },
            { serviceName: service.name, status, statusMessage }
        );

        res.json({
            id,
            name: service.name,
            status,
            status_message: statusMessage,
            last_check_at: new Date().toISOString()
        });
    } catch (err) {
        console.error('Check service error:', err);
        res.status(500).json({ error: 'check_failed', message: 'Failed to check service' });
    }
});

// ============================================================================
// LOGS
// ============================================================================

/**
 * GET /admin/logs
 * Query system logs
 */
router.get('/logs', (req, res) => {
    try {
        const { service, level, limit = 100, offset = 0 } = req.query;

        const db = getDb();
        let sql = 'SELECT * FROM system_logs WHERE 1=1';
        const params = [];

        if (service) {
            sql += ' AND service = ?';
            params.push(service);
        }

        if (level) {
            sql += ' AND level = ?';
            params.push(level);
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        const parsedLimit = Math.min(parseInt(limit) || 100, 1000);
        const parsedOffset = parseInt(offset) || 0;
        params.push(parsedLimit, parsedOffset);

        const logs = db.prepare(sql).all(...params);

        // Security Issue #75: Log admin viewing system logs (sensitive data access)
        logAdminAccess(
            AuditActions.ADMIN_VIEW_LOGS,
            { type: 'user', id: req.user.id },
            req,
            { type: 'system_logs', id: 'query' },
            {
                filters: { service: service || null, level: level || null },
                limit: parsedLimit,
                offset: parsedOffset,
                resultCount: logs.length
            }
        );

        res.json({
            logs: logs.map(l => ({
                ...l,
                metadata: JSON.parse(l.metadata_json || '{}')
            }))
        });
    } catch (err) {
        console.error('Get logs error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch logs' });
    }
});

// ============================================================================
// ENCRYPTION KEY ROTATION
// ============================================================================

/**
 * POST /admin/rotate-encryption-key
 * Rotate the master encryption key
 *
 * This re-encrypts all encrypted values with a new key:
 * - All integration_credentials
 * - All encrypted instance_config values
 * - All api_keys
 *
 * IMPORTANT: After rotation, you MUST update MASTER_ENCRYPTION_KEY env var
 * to the new key before restarting the service.
 */
router.post('/rotate-encryption-key', requireInstanceAdmin('superadmin'), async (req, res) => {
    try {
        const { newKey, confirmRotation } = req.body;

        // Safety check - require explicit confirmation
        if (!confirmRotation) {
            return res.status(400).json({
                error: 'confirmation_required',
                message: 'Set confirmRotation: true to proceed with key rotation'
            });
        }

        // Validate new key
        const validation = validateMasterKey(newKey);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'invalid_key',
                message: validation.message
            });
        }

        // Get current master key
        const currentKey = process.env.MASTER_ENCRYPTION_KEY;
        if (!currentKey) {
            return res.status(400).json({
                error: 'no_current_key',
                message: 'MASTER_ENCRYPTION_KEY not set - cannot rotate'
            });
        }

        // FIX 2 (VAULT P1): normalize master keys to EXACTLY 32 bytes, matching
        // getMasterKey()/normalizeMaster() which truncate keys longer than 32
        // bytes. Without this, a rotation key that base64-decodes to >32 bytes
        // derives its KEK from the full buffer here, but after restart
        // getMasterKey() truncates to 32 → a different KEK → every v2 row becomes
        // silently undecryptable (total vault loss). validateMasterKey() accepts
        // >32-byte keys, so this would otherwise pass validation unnoticed.
        const truncate32 = (buf) => (buf.length > 32 ? buf.subarray(0, 32) : buf);
        const oldKeyBuffer = truncate32(Buffer.from(currentKey, 'base64'));
        const newKeyBuffer = truncate32(Buffer.from(newKey, 'base64'));

        const db = getDb();
        // F2: rotation re-encrypts EVERY master-key store from a single source
        // of truth (config/encryptedStores.js) instead of hardcoding table
        // names — this is what previously orphaned the `secrets` KV store.
        // Keyed by table so audit metadata + response can report per-store.
        const results = {};

        // VAULT-AUDIT P1: v2 rows rotate via a DEK re-wrap under a KEK derived
        // from the master + the STABLE vault salt. Resolve the salt + current
        // vault KEK version so reencryptStore can rewrap v2 rows (and bump their
        // kekVer) while legacy 3-part rows fall back to a full re-encrypt.
        const vaultSaltRow = db.prepare("SELECT value FROM instance_config WHERE key = 'vault_kek_salt'").get();
        const vaultVersionRow = db.prepare("SELECT value FROM instance_config WHERE key = 'vault_kek_version'").get();
        const vaultSalt = vaultSaltRow ? Buffer.from(vaultSaltRow.value, 'hex') : null;
        const oldVaultVersion = vaultVersionRow ? parseInt(vaultVersionRow.value, 10) : 1;
        const newVaultVersion = oldVaultVersion + 1;
        const prevMasterB64 = process.env.MASTER_ENCRYPTION_KEY_PREVIOUS;
        // FIX 2: normalize the previous master to 32 bytes too (same reason).
        const prevKeyBuffer = prevMasterB64 ? truncate32(Buffer.from(prevMasterB64, 'base64')) : null;

        const keyCtx = {
            oldKey: oldKeyBuffer,
            newKey: newKeyBuffer,
            salt: vaultSalt,
            oldVersion: oldVaultVersion,
            newVersion: newVaultVersion,
            prevKey: prevKeyBuffer,
        };

        // Use transaction for atomicity
        const rotateAll = db.transaction(() => {
            // Re-encrypt every rotatable encrypted store in the registry.
            for (const store of getRotatableStores()) {
                const { table, count, errors } = reencryptStore(db, store, keyCtx);
                results[table] = { count, errors };
            }

            // VAULT-AUDIT P1: bump the vault KEK version alongside the legacy
            // encryption_key_version so newly-rotated v2 envelopes are stamped
            // with (and resolvable at) the new version. Kept encrypted=0 (it is
            // plaintext metadata; the salt itself is stable across rotations).
            db.prepare(`
                INSERT OR REPLACE INTO instance_config (key, value, value_type, encrypted, description, updated_at, updated_by)
                VALUES ('vault_kek_version', ?, 'number', 0, 'Current vault KEK version', datetime('now'), ?)
            `).run(String(newVaultVersion), req.user.id);

            // Update key version in instance_config
            const keyVersion = db.prepare(`
                SELECT value FROM instance_config WHERE key = 'encryption_key_version'
            `).get();

            const newVersion = keyVersion ? parseInt(keyVersion.value) + 1 : 2;

            db.prepare(`
                INSERT OR REPLACE INTO instance_config (key, value, value_type, encrypted, description, updated_at, updated_by)
                VALUES ('encryption_key_version', ?, 'integer', 0, 'Current encryption key version', datetime('now'), ?)
            `).run(String(newVersion), req.user.id);

            db.prepare(`
                INSERT OR REPLACE INTO instance_config (key, value, value_type, encrypted, description, updated_at, updated_by)
                VALUES ('encryption_key_rotated_at', datetime('now'), 'datetime', 0, 'Last encryption key rotation', datetime('now'), ?)
            `).run(req.user.id);

            return newVersion;
        });

        // Execute transaction
        const newVersion = rotateAll();

        // Aggregate per-store results (registry-driven — covers every store).
        const rotatedCounts = {};
        const allErrors = [];
        for (const [table, r] of Object.entries(results)) {
            rotatedCounts[table] = r.count;
            for (const e of r.errors) allErrors.push({ table, ...e });
        }
        const totalErrors = allErrors.length;

        // Log audit event
        logAudit({
            action: AuditActions.CONFIG_ENCRYPTION_ROTATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: 'encryption_key' },
            request: req,
            metadata: {
                newKeyVersion: newVersion,
                rotatedCounts,
                // Back-compat convenience fields for existing dashboards/log parsers.
                credentialsRotated: rotatedCounts.integration_credentials || 0,
                secretsRotated: rotatedCounts.secrets || 0,
                configsRotated: rotatedCounts.instance_config || 0,
                apiKeysRotated: rotatedCounts.api_keys || 0,
                errors: allErrors
            }
        });

        // FIX 3 (VAULT P1): the operator MUST also set
        // MASTER_ENCRYPTION_KEY_PREVIOUS to the OLD key for the dual-key window,
        // and restart promptly. In-process crypto keeps using the OLD boot key
        // until restart, so any credential written during the rotation window is
        // stamped at the OLD kekVer under the OLD KEK. Without _PREVIOUS on
        // restart those rows — and any rows not yet re-wrapped — become
        // undecryptable.
        const nextSteps = [
            'Set MASTER_ENCRYPTION_KEY to the NEW key.',
            'Set MASTER_ENCRYPTION_KEY_PREVIOUS to the OLD key (needed for the dual-key window so credentials written during rotation, and any rows not yet re-wrapped, stay decryptable).',
            'Restart the service promptly — in-process crypto keeps using the OLD key until restart.',
        ];
        const warning = 'IMPORTANT: Before restarting, set MASTER_ENCRYPTION_KEY to the new key AND ' +
            'MASTER_ENCRYPTION_KEY_PREVIOUS to the old key (dual-key window), then restart the service ' +
            'promptly. In-process crypto keeps using the old key until restart, so credentials written ' +
            'during the rotation window need MASTER_ENCRYPTION_KEY_PREVIOUS to remain decryptable.';

        res.json({
            success: totalErrors === 0,
            message: totalErrors === 0
                ? 'Key rotation complete. Set MASTER_ENCRYPTION_KEY to the new key and MASTER_ENCRYPTION_KEY_PREVIOUS to the old key, then restart the service.'
                : 'Key rotation completed with errors. Review errors, then set MASTER_ENCRYPTION_KEY (new) and MASTER_ENCRYPTION_KEY_PREVIOUS (old) and restart.',
            keyVersion: newVersion,
            results,
            nextSteps,
            warning
        });
    } catch (err) {
        console.error('Key rotation error:', err);

        logAudit({
            action: AuditActions.CONFIG_ENCRYPTION_ROTATE,
            actor: { type: 'user', id: req.user.id },
            target: { type: 'config', id: 'encryption_key' },
            status: 'failure',
            request: req,
            metadata: { error: err.message }
        });

        res.status(500).json({
            error: 'rotation_failed',
            message: 'Key rotation failed - no changes made',
            detail: err.message
        });
    }
});

// ============================================================================
// STATS
// ============================================================================

/**
 * GET /admin/stats
 * Get instance statistics
 */
router.get('/stats', (req, res) => {
    try {
        const db = getDb();

        const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE status = \'active\'').get();
        const orgCount = db.prepare('SELECT COUNT(*) as count FROM orgs WHERE deleted_at IS NULL').get();
        const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE revoked_at IS NULL AND expires_at > datetime(\'now\')').get();
        const keyCount = db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE scope_type = \'instance\' AND is_active = 1').get();

        const recentLogins = db.prepare(`
            SELECT COUNT(*) as count FROM audit_events
            WHERE action = 'auth.login' AND created_at > datetime('now', '-24 hours')
        `).get();

        const errorCount = db.prepare(`
            SELECT COUNT(*) as count FROM system_logs
            WHERE level = 'error' AND created_at > datetime('now', '-24 hours')
        `).get();

        const stats = {
            users: userCount.count,
            organizations: orgCount.count,
            active_sessions: sessionCount.count,
            system_api_keys: keyCount.count,
            logins_24h: recentLogins.count,
            errors_24h: errorCount.count
        };

        // Security Issue #75: Log admin viewing instance statistics
        logAdminAccess(
            AuditActions.ADMIN_VIEW_STATS,
            { type: 'user', id: req.user.id },
            req,
            { type: 'instance_stats', id: 'all' },
            { statsRetrieved: Object.keys(stats) }
        );

        res.json({ stats });
    } catch (err) {
        console.error('Get stats error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch stats' });
    }
});

// ==========================================================================
// Backfill: Auto-create teams for existing scopes
// ==========================================================================

/**
 * POST /admin/backfill-teams
 * Create auto-teams for existing scopes that don't have them.
 * Idempotent — safe to run multiple times.
 */
router.post('/backfill-teams', requireInstanceAdmin('admin'), async (req, res) => {
    try {
        const { backfillTeams } = await import('../utils/backfillTeams.js');
        const result = backfillTeams(req.user.id);

        logAdminAccess(
            'admin.backfill_teams',
            req.user.id,
            { type: 'system', id: 'backfill' },
            { created: result.created, skipped: result.skipped, errors: result.errors.length }
        );

        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        console.error('Backfill teams error:', err);
        res.status(500).json({ error: 'backfill_failed', message: err.message });
    }
});

export default router;
