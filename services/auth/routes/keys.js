/**
 * Keys routes — SET-IA Phase 5b.
 *
 * GET /api/keys/by-provider
 *   Returns each canonical provider with the caller's visible scopes
 *   (instance / org / user) and the effective resolved key. Used by
 *   the unified Provider Keys panel under /settings#instance/provider-keys.
 *
 * Visibility rules:
 *   - instance scope shown only to instance admins (any tier).
 *   - org scope shown only when the caller has SECRETS_VIEW in the
 *     active org context.
 *   - user scope shown when keys.allow_user_byok is on, gated by the
 *     caller being authenticated.
 *
 * The endpoint never returns plaintext keys — only `key_preview` (first
 * 8 chars + "…") suitable for display. Edits go through the existing
 * scope-specific endpoints (admin.js for instance, integrations.js for
 * org, future /me/keys for user).
 */

import express from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../utils/encryption.js';
import { listCredentials } from '../db/integrations.js';
import { resolveProviderKey } from '../services/credentialResolver.js';
import { checkInstanceAdmin } from '../middleware/instanceAdmin.js';
import { PROVIDERS, getProvider } from '../utils/providers.js';
import { Capabilities, hasCapability } from '../utils/policy.js';

const router = express.Router();

router.use(authenticate());

function readPolicyFlag(db, key, defaultValue) {
    try {
        const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(key);
        if (!row?.value) return defaultValue;
        return row.value === 'true' || row.value === true || row.value === '1';
    } catch {
        return defaultValue;
    }
}

function preview(plain) {
    if (typeof plain !== 'string' || plain.length < 4) return null;
    return `${plain.slice(0, 8)}…`;
}

function readInstanceScope(db, provider) {
    // instance_config (legacy) — encrypted = 1 means decrypt before
    // previewing; both shapes are fine because we never return plaintext.
    try {
        const row = db.prepare(
            'SELECT value, encrypted, updated_at FROM instance_config WHERE key = ?'
        ).get(provider.instanceConfigKey);
        if (!row?.value) return null;
        const plain = row.encrypted ? decrypt(row.value) : row.value;
        if (!plain) return null;
        return {
            source:    'instance_config',
            keyPreview: preview(plain),
            updatedAt: row.updated_at,
        };
    } catch {
        return null;
    }
}

function readOrgScope(db, orgId, provider) {
    if (!orgId) return null;
    // Org-scoped keys live in integration_credentials, default-flagged.
    try {
        const creds = listCredentials(orgId, { type: provider.id });
        const def = creds.find(c => c.is_default) || null;
        if (!def) return null;
        const row = db.prepare(
            'SELECT ciphertext, updated_at, last_used_at FROM integration_credentials WHERE id = ?'
        ).get(def.id);
        if (!row?.ciphertext) return null;
        const credentials = JSON.parse(decrypt(row.ciphertext));
        const apiKey = credentials.api_key || credentials.token || credentials.secret;
        return {
            source:       'integration_credentials',
            credentialId: def.id,
            label:        def.label,
            keyPreview:   preview(apiKey),
            updatedAt:    row.updated_at,
            lastUsedAt:   row.last_used_at,
        };
    } catch {
        return null;
    }
}

function readUserScope(db, userId, provider) {
    if (!userId) return null;
    try {
        const row = db.prepare(`
            SELECT id, key_ciphertext, key_preview, updated_at, last_used_at, is_default
            FROM api_keys
            WHERE scope_type = 'user' AND scope_id = ? AND provider = ? AND is_active = 1
            ORDER BY is_default DESC, created_at DESC
            LIMIT 1
        `).get(userId, provider.id);
        if (!row) return null;
        let keyPreview = row.key_preview || null;
        if (!keyPreview && row.key_ciphertext) {
            try { keyPreview = preview(decrypt(row.key_ciphertext)); } catch { /* ignore */ }
        }
        return {
            source:     'api_keys_user',
            apiKeyId:   row.id,
            keyPreview,
            updatedAt:  row.updated_at,
            lastUsedAt: row.last_used_at,
        };
    } catch {
        return null;
    }
}

router.get('/by-provider', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const orgId  = req.user.orgId || null;
        const orgRole = req.user.orgRole || null;

        const isInstanceAdmin = checkInstanceAdmin(userId).isAdmin;

        const orgVisible = !!orgRole && hasCapability({ orgRole }, Capabilities.SECRETS_VIEW);

        const allowOrgOverride = readPolicyFlag(db, 'keys.allow_org_override', true);
        const allowUserBYOK    = readPolicyFlag(db, 'keys.allow_user_byok',    true);

        const providers = PROVIDERS.map(p => {
            const instance = isInstanceAdmin ? readInstanceScope(db, p) : null;
            const org      = orgVisible      ? readOrgScope(db, orgId, p) : null;
            const user     = allowUserBYOK   ? readUserScope(db, userId, p) : null;

            // Effective resolution (no userId override unless BYOK is on).
            const resolved = resolveProviderKey(orgId, p.id, {
                userId: allowUserBYOK ? userId : null,
            });

            return {
                id:           p.id,
                displayName:  p.displayName,
                purpose:      p.purpose,
                supportsTest: p.supportsTest,
                instance,
                org,
                user,
                effective: resolved.key
                    ? { source: resolved.source, keyPreview: preview(resolved.key) }
                    : null,
            };
        });

        res.json({
            providers,
            policy: {
                allowOrgOverride,
                allowUserBYOK,
            },
            scopesVisible: {
                instance: isInstanceAdmin,
                org:      orgVisible,
                user:     allowUserBYOK,
            },
            activeOrgId: orgId,
        });
    } catch (err) {
        console.error('[keys/by-provider]', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to assemble provider keys' });
    }
});

export default router;
