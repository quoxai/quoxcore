/**
 * oauthConnectProviders.js — declarative registry for Brain2's
 * OAuth-connect providers (services/auth/routes/oauth-connect.js).
 *
 * Notion and Google Drive today (BRAIN2-OAUTH-NOTION, BRAIN2-OAUTH-GDRIVE).
 * Client id/secret are read ONLY from env — a provider whose env pair is
 * absent reports `configured: false`, and every oauth-connect route for it
 * fails loud with 409 `provider_not_configured`. Nothing is hardcoded here,
 * nothing invented when credentials are missing: no Notion or Google OAuth
 * app is provisioned on any deployment today, so `configured` is false
 * everywhere until an operator sets the matching env vars below. This is
 * also why feedSourceCatalog.js's `notion`/`gdrive` entries stay
 * `status: 'available'`, never `'live'` — see feedScheduler.js's matching
 * env-gated registration.
 *
 * Adding another provider is one more entry here, plus whatever
 * provider-specific token-response shape it needs — the routes in
 * oauth-connect.js are written against this registry generically, never
 * against a single provider id by name.
 */

/**
 * OAUTH_CONNECT_PROVIDERS[id]:
 *   id               - matches feedSourceCatalog.js's sourceType AND the
 *                       integrations model's integration_type (one
 *                       provider id used consistently end to end).
 *   integrationType  - the integrationTypeRegistry.js key the resulting
 *                       credential is stored under.
 *   label            - the credential's `label` in the integrations vault
 *                       (also the reconnect-idempotency key, via
 *                       labelExists()).
 *   authorizeUrl     - the provider's OAuth authorize endpoint.
 *   tokenUrl         - the provider's OAuth token-exchange endpoint.
 *   tokenAuthStyle   - 'basic' (HTTP Basic client auth on the token
 *                       exchange, Notion's style) — the only style needed
 *                       until a second provider is added.
 *   extraAuthzParams - provider-specific query params always added to the
 *                       authorize URL (Notion requires `owner=user`).
 *   clientIdEnv / clientSecretEnv - the env var names holding the OAuth
 *                       app's client id/secret. Read live (a getter, not a
 *                       value captured at import time) so tests and
 *                       ops changes that set these env vars at runtime are
 *                       honoured without a process restart.
 *   parseTokenResponse(json) - maps the provider's raw token-exchange
 *                       response into the credentials object stored in the
 *                       vault, matching that integration_type's own field
 *                       schema. Throws on a response missing the fields it
 *                       needs — the callback route surfaces that as a
 *                       failed connect, never silently stores junk.
 */
export const OAUTH_CONNECT_PROVIDERS = {
    notion: {
        id: 'notion',
        integrationType: 'notion',
        label: 'Notion (Brain2 OAuth)',
        authorizeUrl: 'https://api.notion.com/v1/authorize',
        tokenUrl: 'https://api.notion.com/v1/oauth/token',
        tokenAuthStyle: 'basic',
        // Notion has no OAuth scope strings — access is capability-based
        // on the integration itself (configured read-only, no comment/
        // user-email capabilities, at notion.so/my-integrations) and
        // page-grant-based at consent time (the user picks which
        // pages/workspaces to share). owner=user is mandatory.
        extraAuthzParams: { owner: 'user' },
        clientIdEnv: 'NOTION_OAUTH_CLIENT_ID',
        clientSecretEnv: 'NOTION_OAUTH_CLIENT_SECRET',
        supportsRefresh: false,
        get clientId() {
            return process.env.NOTION_OAUTH_CLIENT_ID || '';
        },
        get clientSecret() {
            return process.env.NOTION_OAUTH_CLIENT_SECRET || '';
        },
        get configured() {
            return !!(process.env.NOTION_OAUTH_CLIENT_ID && process.env.NOTION_OAUTH_CLIENT_SECRET);
        },
        parseTokenResponse(json) {
            if (!json || !json.access_token) {
                throw new Error('Notion token response missing access_token');
            }
            return {
                integration_token: json.access_token,
                workspace_id: json.workspace_id || null,
                workspace_name: json.workspace_name || null,
                bot_id: json.bot_id || null,
            };
        },
    },
    // BRAIN2-OAUTH-GDRIVE: added mirroring the notion entry above. Google's
    // token endpoint also accepts HTTP Basic client auth (RFC 6749
    // client_secret_basic), so tokenAuthStyle: 'basic' is honoured
    // identically here. access_type=offline + prompt=consent are the two
    // extra authorize params Google needs to actually issue a refresh_token
    // on first connect — stored below for a future refresh-rotation path
    // (supportsRefresh: false for now, same not-yet-built limitation noted
    // in oauth-connect.js's token broker for every provider today).
    gdrive: {
        id: 'gdrive',
        integrationType: 'gdrive',
        label: 'Google Drive (Brain2 OAuth)',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        tokenAuthStyle: 'basic',
        extraAuthzParams: {
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            access_type: 'offline',
            prompt: 'consent',
        },
        clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
        supportsRefresh: false,
        get clientId() {
            return process.env.GOOGLE_OAUTH_CLIENT_ID || '';
        },
        get clientSecret() {
            return process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
        },
        get configured() {
            return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
        },
        parseTokenResponse(json) {
            if (!json || !json.access_token) {
                throw new Error('Google token response missing access_token');
            }
            return {
                integration_token: json.access_token,
                refresh_token: json.refresh_token || null,
                expires_in: json.expires_in || null,
                scope: json.scope || null,
            };
        },
    },
};

export function getProvider(providerId) {
    return OAUTH_CONNECT_PROVIDERS[providerId] || null;
}

/** Public-safe list: provider id + configured flag only, never secrets. */
export function listProviders() {
    return Object.values(OAUTH_CONNECT_PROVIDERS).map((p) => ({
        provider: p.id,
        configured: !!p.configured,
    }));
}
