/**
 * BRAIN2-OAUTH-NOTION — the OAuth-connect flow for Brain2's OAuth-connected
 * feed sources (Notion today; see oauthConnectProviders.js for adding more).
 *
 * Mirrors sso.js's proven OIDC handshake shape (state nonce, exact
 * redirect URI, 302 authorize, callback exchange) — reusing the pattern,
 * not the sso_auth_states table (that store is SSO-login-specific and
 * this flow's callback writes a totally different outcome: an
 * integrations-vault credential, not a session).
 *
 *   GET  /orgs/:orgId/connect/providers        - which providers exist and
 *                                                 whether this deployment
 *                                                 has an OAuth app for them
 *   GET  /orgs/:orgId/connect/:provider/start   - 302 to the provider's
 *                                                 authorize URL
 *   GET  /connect/:provider/callback            - provider redirects here;
 *                                                 unauthenticated by nature
 *                                                 (authority comes entirely
 *                                                 from the single-use state
 *                                                 row)
 *   POST /internal/oauth/:provider/access-token - the token broker: the
 *                                                 ONLY place a raw provider
 *                                                 access token is decrypted
 *                                                 and handed to a caller
 *                                                 (the collector), gated
 *                                                 identically to
 *                                                 /internal/integrations/:id/service-decrypt
 *
 * The credential itself always goes through the EXISTING integrations
 * model (db/integrations.js — createCredential/rotateCredential/
 * getDecryptedCredential), so it is Vault-encrypted, audit-logged, and
 * visible in the normal Integrations UI like every other credential — no
 * parallel token store.
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireOrgMembership } from '../middleware/org.js';
import { requireCapability } from '../middleware/authorize.js';
import { Capabilities } from '../utils/policy.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { getProvider, listProviders } from '../config/oauthConnectProviders.js';
import {
    createCredential,
    listCredentials,
    rotateCredential,
    getDecryptedCredential,
    updateLastUsed,
} from '../db/integrations.js';
import { logIntegrationEvent, AuditActions } from '../utils/audit.js';
import { writeCredentialReleaseAudit } from '../lib/credentialReleaseAudit.js';

const router = Router();

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes, same TTL as sso.js's auth-state store

function db(req) {
    return req.db || getDb();
}

function ensureOauthConnectSchema(sqliteDb) {
    sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS oauth_connect_states (
            id             TEXT PRIMARY KEY,
            provider       TEXT NOT NULL,
            org_id         TEXT NOT NULL,
            user_id        TEXT NOT NULL,
            state          TEXT NOT NULL UNIQUE,
            redirect_to    TEXT,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at_ms  INTEGER NOT NULL,
            consumed_at_ms INTEGER
        );
    `);
}

// For test DBs the schema is pre-created; in prod the migration runs on
// startup. This keeps hot-reload safe either way (mirrors sso.js's
// lazyEnsureSchema).
function lazyEnsureSchema(req) {
    try { ensureOauthConnectSchema(db(req)); } catch { /* best-effort */ }
}

function buildRedirectUri(req, providerId) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}/api/connect/${providerId}/callback`;
}

function generateState() {
    return randomBytes(24).toString('base64url');
}

const connectStartLimiter = createLimiter({
    windowMs: 60 * 1000,
    max: 20,
    message: 'Too many connect attempts — rate limited',
    keyGenerator: (req) => `oauth-connect-start:${req.user?.id || req.ip}`,
});

const tokenBrokerLimiter = createLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many token broker requests — rate limited',
    keyGenerator: (req) => `oauth-connect-broker:${req.ip}`,
});

/**
 * GET /orgs/:orgId/connect/providers
 *
 * Public-safe discovery for the connect UI: which providers exist and
 * whether THIS deployment has an OAuth app configured for them. No client
 * id, no secrets — just enough for the cockpit to distinguish "not
 * provisioned yet" from "connectable".
 */
router.get('/orgs/:orgId/connect/providers', authenticate(), requireOrgMembership, (req, res) => {
    res.json({ providers: listProviders() });
});

/**
 * GET /orgs/:orgId/connect/:provider/start?redirect_to=/settings
 *
 * Initiates the handshake: persists a single-use, TTL-bound, org+user
 * bound state row, then 302s to the provider's authorize URL. Same
 * capability gate as creating a credential directly (SECRETS_WRITE) —
 * the callback this starts WILL write a credential.
 *
 * Test-only hook: req.__testRedirectUri fixes the callback URL for test
 * harnesses, same convention as sso.js.
 */
router.get(
    '/orgs/:orgId/connect/:provider/start',
    authenticate(),
    requireOrgMembership,
    requireCapability(Capabilities.SECRETS_WRITE),
    connectStartLimiter,
    (req, res) => {
        lazyEnsureSchema(req);

        const provider = getProvider(req.params.provider);
        if (!provider) return res.status(404).json({ error: 'provider_not_found' });
        if (!provider.configured) {
            return res.status(409).json({
                error: 'provider_not_configured',
                message: `This deployment has no ${provider.id} OAuth app configured. An administrator must set the client credentials first.`,
            });
        }

        const redirectTo = typeof req.query.redirect_to === 'string' ? req.query.redirect_to : '/settings';
        const state = generateState();
        const redirectUri = req.__testRedirectUri || buildRedirectUri(req, provider.id);

        try {
            db(req).prepare(`
                INSERT INTO oauth_connect_states (id, provider, org_id, user_id, state, redirect_to, expires_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(ulid(), provider.id, req.org.id, req.user.id, state, redirectTo, Date.now() + STATE_TTL_MS);
        } catch (err) {
            return res.status(500).json({ error: 'state_persist_failed', message: String(err?.message || err) });
        }

        const authzUrl = new URL(provider.authorizeUrl);
        authzUrl.searchParams.set('client_id', provider.clientId);
        authzUrl.searchParams.set('redirect_uri', redirectUri);
        authzUrl.searchParams.set('response_type', 'code');
        authzUrl.searchParams.set('state', state);
        for (const [key, value] of Object.entries(provider.extraAuthzParams || {})) {
            authzUrl.searchParams.set(key, value);
        }

        return res.redirect(302, authzUrl.toString());
    },
);

/**
 * GET /connect/:provider/callback?code=...&state=...
 *
 * Unauthenticated by nature (a browser redirect from the provider carries
 * no session) — ALL authority comes from the single-use state row, which
 * binds this exchange to the org and user who started it. On success,
 * stores the resulting credential via the existing integrations model,
 * then writes the connection server-side into the collector's
 * feed_sources registry (so the connection survives a closed popup), and
 * 302s back to the app with a query-string result flag. Never throws to
 * the browser — every failure path redirects with an honest
 * brain2_connect_error instead.
 */
router.get('/connect/:provider/callback', async (req, res) => {
    lazyEnsureSchema(req);

    const provider = getProvider(req.params.provider);
    if (!provider) return res.status(404).json({ error: 'provider_not_found' });

    const { code, state, error: providerError, error_description: providerErrorDescription } = req.query || {};
    if (providerError) {
        const message = providerErrorDescription ? `${providerError}: ${providerErrorDescription}` : String(providerError);
        return res.redirect(302, `/settings?brain2_connect_error=${encodeURIComponent(message)}`);
    }
    if (!code || !state) {
        return res.redirect(302, '/settings?brain2_connect_error=missing_code_or_state');
    }

    let stateRow;
    try {
        stateRow = db(req).prepare('SELECT * FROM oauth_connect_states WHERE state = ? AND provider = ?').get(state, provider.id);
    } catch {
        return res.redirect(302, '/settings?brain2_connect_error=state_lookup_failed');
    }

    // Single-use + TTL-bound: an unknown, expired, or already-consumed
    // state all fail identically — no oracle for "did a state ever exist".
    const nowMs = Date.now();
    if (!stateRow || stateRow.consumed_at_ms || stateRow.expires_at_ms < nowMs) {
        return res.redirect(302, '/settings?brain2_connect_error=invalid_or_expired_state');
    }
    try {
        db(req).prepare('UPDATE oauth_connect_states SET consumed_at_ms = ? WHERE id = ?').run(nowMs, stateRow.id);
    } catch { /* best-effort single-use marking */ }

    if (!provider.configured) {
        return res.redirect(302, '/settings?brain2_connect_error=provider_not_configured');
    }

    const redirectUri = req.__testRedirectUri || buildRedirectUri(req, provider.id);
    const fetchImpl = req.app.locals?.oauthConnectFetch || fetch;

    let tokenJson;
    try {
        const basicAuth = Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64');
        const tokenRes = await fetchImpl(provider.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basicAuth}` },
            body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
        });
        if (!tokenRes.ok) {
            const body = await tokenRes.json().catch(() => null);
            throw new Error(`token exchange failed HTTP ${tokenRes.status}${body?.error ? ` — ${body.error}` : ''}`);
        }
        tokenJson = await tokenRes.json();
    } catch (err) {
        return res.redirect(302, `/settings?brain2_connect_error=${encodeURIComponent(String(err?.message || err))}`);
    }

    let credentials;
    try {
        credentials = provider.parseTokenResponse(tokenJson);
    } catch (err) {
        return res.redirect(302, `/settings?brain2_connect_error=${encodeURIComponent(String(err?.message || err))}`);
    }

    let credentialId;
    try {
        const existingRows = listCredentials(stateRow.org_id, { integration_type: provider.integrationType });
        const existing = existingRows.find((c) => c.label === provider.label);
        if (existing) {
            rotateCredential(existing.id, credentials, null);
            credentialId = existing.id;
            logIntegrationEvent(
                AuditActions.INTEGRATION_ROTATE,
                { type: 'user', id: stateRow.user_id },
                stateRow.org_id,
                credentialId,
                req,
                { integration_type: provider.integrationType, via: 'oauth_connect_reconnect' },
            );
        } else {
            const created = createCredential({
                org_id: stateRow.org_id,
                integration_type: provider.integrationType,
                label: provider.label,
                credentials,
                created_by: stateRow.user_id,
                credential_kind: 'service_api',
            });
            credentialId = created.id;
            logIntegrationEvent(
                AuditActions.INTEGRATION_CREATE,
                { type: 'user', id: stateRow.user_id },
                stateRow.org_id,
                credentialId,
                req,
                { integration_type: provider.integrationType, via: 'oauth_connect' },
            );
        }
    } catch (err) {
        return res.redirect(302, `/settings?brain2_connect_error=${encodeURIComponent(`credential_store_failed: ${err?.message || err}`)}`);
    }

    // Server-side write of the feed_sources connection: the connection
    // must survive a closed popup or an interrupted browser session, so
    // this call, not a browser step, is what makes the connection live.
    // If the collector is unreachable the credential is still safely
    // stored above — the cockpit's existing PUT /api/feed/sources path
    // can finish this connection later (see module header + design risk
    // notes: "cross-service write at callback").
    try {
        const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
        const putRes = await fetchImpl(`${collectorUrl}/api/feed/sources/${provider.integrationType}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
            body: JSON.stringify({
                org_id: stateRow.org_id,
                enabled: true,
                config: { credentialId, workspaceName: credentials.workspace_name || null },
            }),
        });
        if (!putRes.ok) {
            console.error(`[oauth-connect] org=${stateRow.org_id} provider=${provider.id}: collector PUT /api/feed/sources failed HTTP ${putRes.status}`);
            return res.redirect(302, '/settings?brain2_connect_error=collector_unreachable');
        }
    } catch (err) {
        console.error(`[oauth-connect] org=${stateRow.org_id} provider=${provider.id}: collector PUT /api/feed/sources unreachable — ${err.message}`);
        return res.redirect(302, '/settings?brain2_connect_error=collector_unreachable');
    }

    const redirectTo = stateRow.redirect_to || '/settings';
    const separator = redirectTo.includes('?') ? '&' : '?';
    return res.redirect(302, `${redirectTo}${separator}brain2_connected=${provider.id}`);
});

/**
 * POST /internal/oauth/:provider/access-token
 *
 * The token broker: the ONLY place that decrypts a Brain2 OAuth-connected
 * credential for a caller (the collector). Gated identically to
 * GET /internal/integrations/:id/service-decrypt — x-service-key header,
 * mandatory org_id, org-mismatch answered with the same 404-as-missing
 * shape (no existence oracle). Body: { credential_id, org_id }.
 *
 * Notion has no refresh token (non-expiring integration token) — this
 * returns it directly. A provider with supportsRefresh would refresh here
 * when close to expiry and persist the rotated token via rotateCredential()
 * before returning it (see oauthConnectProviders.js's supportsRefresh
 * flag) — not needed for Notion, so not built here.
 */
router.post('/internal/oauth/:provider/access-token', tokenBrokerLimiter, (req, res) => {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) return res.status(401).json({ error: 'service_key_not_configured' });

    const serviceKey = req.headers['x-service-key'];
    if (!serviceKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid service key' });
    }

    const provider = getProvider(req.params.provider);
    if (!provider) return res.status(404).json({ error: 'not_found' });

    const { credential_id: credentialId, org_id: orgId } = req.body || {};
    if (!orgId) return res.status(400).json({ error: 'missing_org_id', message: 'org_id is required' });
    if (!credentialId) return res.status(400).json({ error: 'missing_credential_id', message: 'credential_id is required' });

    let credential;
    try {
        credential = getDecryptedCredential(credentialId);
    } catch (err) {
        console.error('[oauth-connect] broker decrypt error:', err.message);
        return res.status(500).json({ error: 'internal_error' });
    }

    // Unconditional — no existence oracle: missing, cross-org, or
    // wrong-integration-type all get the identical 404.
    if (!credential || credential.org_id !== orgId || credential.integration_type !== provider.integrationType) {
        return res.status(404).json({ error: 'not_found' });
    }

    const accessToken = credential.credentials?.integration_token || credential.credentials?.oauth_token || null;
    if (!accessToken) return res.status(404).json({ error: 'not_found' });

    try { updateLastUsed(credentialId); } catch { /* best-effort */ }

    try {
        logIntegrationEvent(
            AuditActions.INTEGRATION_ACCESS,
            { type: 'internal_service', id: 'feed-oauth-broker' },
            credential.org_id,
            credential.id,
            req,
            { integration_type: credential.integration_type, access_method: 'oauth-connect-broker' },
        );
        writeCredentialReleaseAudit({
            orgId: credential.org_id,
            credentialId: credential.id,
            integrationType: credential.integration_type,
            label: credential.label,
            authType: credential.auth_type,
            callerService: 'internal',
            via: 'oauth-connect-broker',
        });
    } catch { /* best-effort audit */ }

    return res.json({ access_token: accessToken, expires_at: null });
});

export default router;
