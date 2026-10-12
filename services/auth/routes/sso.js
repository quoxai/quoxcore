/**
 * ET-2 Phase A + B — SSO routes.
 *
 * Admin (Phase A, enterprise + ORG_MANAGE_SSO):
 *   GET    /orgs/:orgId/sso/providers
 *   POST   /orgs/:orgId/sso/providers
 *   GET    /orgs/:orgId/sso/providers/:providerId
 *   PATCH  /orgs/:orgId/sso/providers/:providerId
 *   DELETE /orgs/:orgId/sso/providers/:providerId
 *
 * User flow (Phase B, public — these are the login endpoints):
 *   GET  /sso/providers/:providerId/login       → 302 to IdP
 *   GET  /sso/providers/:providerId/callback    → handshake, session, 302 home
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    ensureSsoSchema,
    createSsoProvider,
    listSsoProviders,
    getSsoProvider,
    updateSsoProvider,
    deleteSsoProvider,
    findProviderByEmailDomain,
} from '../utils/ssoProviders.js';
import {
    ensureSsoAuthStateSchema,
    createAuthState,
} from '../utils/ssoAuthState.js';
import {
    generatePkceVerifier,
    codeChallengeFromVerifier,
    generateState,
    buildAuthzUrl,
    parseCallbackQuery,
} from '../utils/oidcFlow.js';
import { handleSsoCallback } from '../utils/ssoCallback.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { requirePlan } from '../middleware/requirePlan.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';

const router = Router();

function db(req) {
    return req.db || getDb();
}

function ensureAuthedOrg(req, res, next) {
    if (req.user && req.org && req.orgMembership) return next();
    return requireAuth(req, res, (err) => {
        if (err) return next(err);
        return requireOrgMembership(req, res, next);
    });
}

function requireAuthedOrg(req, res, next) {
    if (!req.user || !req.org) {
        return res.status(401).json({ error: 'unauthenticated' });
    }
    next();
}

function requireManageSso(req, res, next) {
    const role = req.orgMembership?.role;
    if (!resolveCap(req, Capabilities.ORG_MANAGE_SSO)) {
        return res.status(403).json({
            error:    'forbidden',
            required: Capabilities.ORG_MANAGE_SSO,
        });
    }
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'sso_provider', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[sso] audit insert failed:', err.message);
    }
}

const chain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('enterprise'), requireManageSso];

function lazyEnsureSchema(req) {
    // For test DBs the schema is pre-created; in prod the migration runs
    // on startup. This keeps hot-reload safe either way.
    try { ensureSsoSchema(db(req)); } catch { /* best-effort */ }
    try { ensureSsoAuthStateSchema(db(req)); } catch { /* best-effort */ }
}

function buildRedirectUri(req, providerId) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}/api/sso/providers/${providerId}/callback`;
}

// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/sso/providers', ...chain, (req, res) => {
    lazyEnsureSchema(req);
    const providers = listSsoProviders(db(req), req.org.id);
    res.json({ providers });
});

router.post('/orgs/:orgId/sso/providers', ...chain, (req, res) => {
    lazyEnsureSchema(req);
    try {
        const provider = createSsoProvider(db(req), req.org.id, req.body || {});
        emitAudit(req, 'org.sso.provider_created', provider.id, {
            provider_key: provider.provider_key,
            issuer:       provider.issuer,
        });
        res.status(201).json({ provider });
    } catch (err) {
        const msg = String(err?.message || err);
        if (/UNIQUE|already exists/i.test(msg)) {
            return res.status(409).json({ error: 'provider_exists', message: msg });
        }
        return res.status(400).json({ error: 'invalid_input', message: msg });
    }
});

router.get('/orgs/:orgId/sso/providers/:providerId', ...chain, (req, res) => {
    lazyEnsureSchema(req);
    const provider = getSsoProvider(db(req), req.org.id, req.params.providerId);
    if (!provider) return res.status(404).json({ error: 'not_found' });
    res.json({ provider });
});

router.patch('/orgs/:orgId/sso/providers/:providerId', ...chain, (req, res) => {
    lazyEnsureSchema(req);
    try {
        const provider = updateSsoProvider(db(req), req.org.id, req.params.providerId, req.body || {});
        if (!provider) return res.status(404).json({ error: 'not_found' });
        emitAudit(req, 'org.sso.provider_updated', provider.id, {
            fields: Object.keys(req.body || {}).filter(k => k !== 'clientSecret'),
            rotated_secret: 'clientSecret' in (req.body || {}),
        });
        res.json({ provider });
    } catch (err) {
        return res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }
});

// ──────────────────────────────────────────────────────────────────────
// Phase C — public SSO discovery (email domain → provider)
// ──────────────────────────────────────────────────────────────────────

/**
 * GET /sso/discover?email=...
 *
 * Given an email address, returns SSO provider info if an enabled
 * provider matches the domain. Public endpoint — only returns
 * non-sensitive fields (no client_id, no secrets). Always 200 when
 * the email is well-formed so the response can't be used as a
 * user-existence oracle.
 */
router.get('/sso/discover', (req, res) => {
    lazyEnsureSchema(req);
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!email || !email.includes('@') || email.indexOf('@') === email.length - 1) {
        return res.status(400).json({ error: 'invalid_email' });
    }
    const provider = findProviderByEmailDomain(db(req), email);
    if (!provider) {
        return res.json({ provider_id: null });
    }
    res.json({
        provider_id:   provider.id,
        provider_key:  provider.provider_key,
        display_name:  provider.display_name || provider.provider_key,
        sso_only:      !!provider.sso_only,
        login_url:     `/api/sso/providers/${provider.id}/login`,
    });
});

// ──────────────────────────────────────────────────────────────────────
// Phase B — public user flow
// ──────────────────────────────────────────────────────────────────────

/**
 * GET /sso/providers/:providerId/login?redirect_to=/dashboard
 *
 * Initiates the OIDC handshake. Stores PKCE verifier + state nonce,
 * then 302s the user to the IdP's authorization endpoint.
 *
 * Test-only hook: if req.__testRedirectUri is set, use it directly
 * (so test harnesses can fix the callback URL without parsing req.host).
 */
router.get('/sso/providers/:providerId/login', (req, res) => {
    lazyEnsureSchema(req);
    const provider = db(req).prepare(
        `SELECT id, org_id, client_id, issuer, authz_url, scopes_json, enabled
         FROM sso_providers WHERE id = ?`,
    ).get(req.params.providerId);
    if (!provider) return res.status(404).json({ error: 'provider_not_found' });
    if (!provider.enabled) return res.status(403).json({ error: 'provider_disabled' });

    const redirectTo = typeof req.query.redirect_to === 'string' ? req.query.redirect_to : '/';
    const verifier     = generatePkceVerifier();
    const challenge    = codeChallengeFromVerifier(verifier);
    const state        = generateState();
    const redirectUri  = req.__testRedirectUri || buildRedirectUri(req, provider.id);

    createAuthState(db(req), {
        providerId:   provider.id,
        state,
        codeVerifier: verifier,
        redirectTo,
        ttlSec:       600,
    });

    const authzUrl = buildAuthzUrl(
        {
            ...provider,
            scopes: provider.scopes_json ? JSON.parse(provider.scopes_json) : ['openid', 'email', 'profile'],
        },
        { state, codeChallenge: challenge, redirectUri },
    );
    res.redirect(302, authzUrl);
});

/**
 * GET /sso/providers/:providerId/callback?code=...&state=...
 *
 * Handles the provider's redirect-back. On success, the route installs
 * the session (cookies) and sends the user onward. Session issuance is
 * delegated to req.app.locals.issueSession when provided so tests can
 * assert the handler's behaviour without wiring every cookie path.
 */
router.get('/sso/providers/:providerId/callback', async (req, res) => {
    lazyEnsureSchema(req);
    const parsed = parseCallbackQuery(req.query || {});
    if (parsed.error) {
        return res.status(400).json({ error: 'sso_error', message: parsed.error });
    }
    try {
        const redirectUri = req.__testRedirectUri || buildRedirectUri(req, req.params.providerId);
        const out = await handleSsoCallback({
            db:          db(req),
            providerId:  req.params.providerId,
            code:        parsed.code,
            state:       parsed.state,
            redirectUri,
            fetchImpl:   req.app.locals?.ssoFetch,   // optional test/stub hook
        });

        const issue = req.app.locals?.issueSession;
        if (typeof issue === 'function') {
            await issue(res, { userId: out.userId, orgId: out.orgId, email: out.email, req });
        }
        // Audit (best-effort).
        try {
            db(req).prepare(`
                INSERT INTO audit_events
                    (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
                VALUES (?, ?, 'user', ?, 'auth.sso.login', 'sso_provider', ?, 'success', ?)
            `).run(ulid(), out.orgId, out.userId, req.params.providerId, JSON.stringify({ email: out.email }));
        } catch { /* audit table optional */ }

        return res.redirect(302, out.redirectTo || '/');
    } catch (err) {
        return res.status(400).json({ error: 'sso_failed', message: String(err?.message || err) });
    }
});

router.delete('/orgs/:orgId/sso/providers/:providerId', ...chain, (req, res) => {
    lazyEnsureSchema(req);
    const existing = getSsoProvider(db(req), req.org.id, req.params.providerId);
    deleteSsoProvider(db(req), req.org.id, req.params.providerId);
    if (existing) {
        emitAudit(req, 'org.sso.provider_deleted', req.params.providerId, {
            provider_key: existing.provider_key,
        });
    }
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// ET-2B Phase B — SAML flow (public)
// ──────────────────────────────────────────────────────────────────────

import { handleSamlCallback } from '../utils/samlCallback.js';

function buildSamlAcsUrl(req, providerId) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}/api/sso/providers/${providerId}/acs`;
}

async function getSamlClientForProvider(req, providerRow) {
    const factory = req.app.locals?.samlFactory;
    if (!factory) throw new Error('SAML factory not configured on this app');
    const acsUrl    = buildSamlAcsUrl(req, providerRow.id);
    const spEntityId = acsUrl.replace(/\/acs$/, '');   // per-provider SP entity id
    return factory(providerRow, { spEntityId, acsUrl });
}

/**
 * GET /sso/providers/:providerId/saml-metadata
 *
 * Returns an XML SP metadata document the IdP admin pastes into their
 * SAML app config. Public — no PII in metadata. Errors only surface
 * "provider not found" / "wrong protocol" so this can be linked from
 * admin UI without gating.
 */
router.get('/sso/providers/:providerId/saml-metadata', async (req, res) => {
    lazyEnsureSchema(req);
    const providerRow = db(req).prepare(
        `SELECT id, org_id, protocol, entity_id, sso_url, slo_url, x509_cert, nameid_format
         FROM sso_providers WHERE id = ?`,
    ).get(req.params.providerId);
    if (!providerRow)                     return res.status(404).json({ error: 'provider_not_found' });
    if (providerRow.protocol !== 'saml')  return res.status(400).json({ error: 'provider_not_saml' });
    try {
        const saml = await getSamlClientForProvider(req, providerRow);
        const xml = await saml.generateServiceProviderMetadata(null);
        res.type('application/xml').status(200).send(xml);
    } catch (err) {
        return res.status(500).json({ error: 'metadata_failed', message: String(err?.message || err) });
    }
});

/**
 * GET /sso/providers/:providerId/saml-login?redirect_to=/...
 *
 * Initiates the SP-initiated SSO flow. 302s to the IdP's SSO URL with
 * the AuthnRequest + RelayState. Public — authentication happens at
 * the IdP.
 */
router.get('/sso/providers/:providerId/saml-login', async (req, res) => {
    lazyEnsureSchema(req);
    const providerRow = db(req).prepare(
        `SELECT id, org_id, protocol, entity_id, sso_url, slo_url, x509_cert, nameid_format, enabled
         FROM sso_providers WHERE id = ?`,
    ).get(req.params.providerId);
    if (!providerRow)                     return res.status(404).json({ error: 'provider_not_found' });
    if (providerRow.protocol !== 'saml')  return res.status(400).json({ error: 'provider_not_saml' });
    if (!providerRow.enabled)             return res.status(403).json({ error: 'provider_disabled' });

    const redirectTo = typeof req.query.redirect_to === 'string' ? req.query.redirect_to : '/';

    try {
        const saml = await getSamlClientForProvider(req, providerRow);
        const url  = await saml.getAuthorizeUrl(redirectTo);
        res.redirect(302, url);
    } catch (err) {
        return res.status(500).json({ error: 'saml_login_failed', message: String(err?.message || err) });
    }
});

/**
 * POST /sso/providers/:providerId/acs
 *
 * AssertionConsumerService — IdP redirects the user here with a signed
 * SAML Response in the form body. Verify, JIT-provision, install
 * session cookies, 302 to RelayState (same-origin only).
 */
router.post('/sso/providers/:providerId/acs', async (req, res) => {
    lazyEnsureSchema(req);
    const samlResponse = req.body?.SAMLResponse;
    const relayState   = req.body?.RelayState || null;
    if (!samlResponse) return res.status(400).json({ error: 'saml_response_missing' });

    const providerRow = db(req).prepare(
        `SELECT id, org_id, protocol, entity_id, sso_url, slo_url, x509_cert, nameid_format, enabled
         FROM sso_providers WHERE id = ?`,
    ).get(req.params.providerId);
    if (!providerRow)                     return res.status(404).json({ error: 'provider_not_found' });
    if (providerRow.protocol !== 'saml')  return res.status(400).json({ error: 'provider_not_saml' });
    if (!providerRow.enabled)             return res.status(403).json({ error: 'provider_disabled' });

    try {
        const saml = await getSamlClientForProvider(req, providerRow);
        const out = await handleSamlCallback({
            db:           db(req),
            providerId:   providerRow.id,
            samlResponse,
            relayState,
            samlImpl:     saml,
        });

        const issue = req.app.locals?.issueSession;
        if (typeof issue === 'function') {
            await issue(res, { userId: out.userId, orgId: out.orgId, email: out.email, req });
        }
        try {
            db(req).prepare(`
                INSERT INTO audit_events
                    (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
                VALUES (?, ?, 'user', ?, 'auth.sso.login', 'sso_provider', ?, 'success', ?)
            `).run(ulid(), out.orgId, out.userId, req.params.providerId,
                   JSON.stringify({ email: out.email, protocol: 'saml' }));
        } catch { /* audit table optional */ }

        return res.redirect(302, out.redirectTo || '/');
    } catch (err) {
        return res.status(400).json({ error: 'saml_failed', message: String(err?.message || err) });
    }
});

export default router;
