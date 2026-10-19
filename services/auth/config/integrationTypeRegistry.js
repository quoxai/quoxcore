/**
 * Integration Type Registry
 *
 * Single source of truth for all integration type definitions.
 * Extracted from integrations.js to decouple vault from provider-specific logic.
 *
 * Each type defines:
 *   - id, name, description, color — display metadata
 *   - fields — credential form schema (key, label, type, required, prefix, placeholder)
 *   - testEndpoint, testMethod, testHeaders, testBody, testParams — connection test config
 *   - validateCredentials — optional format-only validation (for types without test endpoints)
 *   - docs — external documentation link
 */

import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 5849 percent-encoding — encodeURIComponent leaves !*'() unescaped,
 * OAuth 1.0a requires them escaped too.
 * @param {string} str
 * @returns {string}
 */
function oauth1PercentEncode(str) {
    return encodeURIComponent(str).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build a signed OAuth 1.0a Authorization header for a GET request with no
 * query parameters (VAULT-INTEG twitter/X reshape) — HMAC-SHA1 per RFC 5849.
 * Kept deliberately narrow (GET, no query string) to match the one live
 * test call site (testEndpoint below); a general-purpose OAuth1 signer for
 * arbitrary methods/params belongs to the posting capability, not this
 * connection-test helper.
 * @param {{api_key:string, api_secret:string, access_token:string, access_secret:string}} creds
 * @param {string} url
 * @param {string} [method]
 * @returns {string} Authorization header value
 */
function buildTwitterOAuth1Header(creds, url, method = 'GET') {
    const oauthParams = {
        oauth_consumer_key: creds.api_key,
        oauth_nonce: randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: String(Math.floor(Date.now() / 1000)),
        oauth_token: creds.access_token,
        oauth_version: '1.0'
    };

    const paramString = Object.keys(oauthParams)
        .sort()
        .map((key) => `${oauth1PercentEncode(key)}=${oauth1PercentEncode(oauthParams[key])}`)
        .join('&');

    const baseString = [method.toUpperCase(), oauth1PercentEncode(url), oauth1PercentEncode(paramString)].join('&');
    const signingKey = `${oauth1PercentEncode(creds.api_secret)}&${oauth1PercentEncode(creds.access_secret)}`;
    const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

    const headerParams = { ...oauthParams, oauth_signature: signature };
    const header = Object.keys(headerParams)
        .sort()
        .map((key) => `${oauth1PercentEncode(key)}="${oauth1PercentEncode(headerParams[key])}"`)
        .join(', ');

    return `OAuth ${header}`;
}

// CLI-QUOX B5: an OpenAI-compatible server root from an operator-entered URL: trailing slashes
// and a pasted /chat/completions or /models suffix dropped; a bare origin is served at /v1.
function openAiCompatRoot(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return String(raw || '').replace(/\/+$/, ''); }
    let p = u.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/i, '').replace(/\/+$/, '');
    if (!p) p = '/v1';
    return `${u.origin}${p}`;
}

export const INTEGRATION_TYPES = {
    // VAULT-INTEG P3: added first so WARD's sink credential resolver
    // (services/ward/lib/sinkCredentials.js) has a real integration_type to
    // resolve 'gitea' against — sinks.js previously read WARD_GITEA_TOKEN
    // straight from env with no vault type registered at all.
    npm: {
        id: 'npm',
        name: 'npm',
        description: 'npm registry: package metadata, dist-tags, search, and token identity (publishing rides OIDC trusted publishing, not this token)',
        color: '#CB3837',
        category: 'devops',
        fields: [
            { key: 'token', label: 'Access Token', type: 'password', required: true, placeholder: 'npm granular or automation access token' }
        ],
        testEndpoint: 'https://registry.npmjs.org/-/whoami',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://docs.npmjs.com/about-access-tokens'
    },
    pypi: {
        id: 'pypi',
        name: 'PyPI',
        description: 'PyPI upload token (format check only: PyPI API tokens authorize uploads and have no read endpoint to live-test against)',
        color: '#3775A9',
        category: 'devops',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'pypi-...' }
        ],
        // Format-check only, deliberately: a PyPI API token authorizes
        // uploads and PyPI exposes no read endpoint that accepts it, so a
        // live test is impossible by design (same class as aws/gcp).
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (typeof creds.api_token !== 'string' || !creds.api_token.startsWith('pypi-')) {
                return { valid: false, error: 'PyPI API tokens start with "pypi-"' };
            }
            return { valid: true };
        },
        docs: 'https://pypi.org/help/#apitoken'
    },
    // SETEC S4 (2026-10-09): WARD evidence webhook. A DEDICATED type, not the
    // generic notification 'webhook': WARD resolves this at INSTANCE scope and
    // posts every witnessed evidence tip to it, so it must never pick up an
    // ordinary chat/notification webhook by accident.
    ward_webhook: {
        id: 'ward_webhook',
        name: 'WARD Evidence Webhook',
        description: 'Endpoint that receives each witnessed WARD evidence tip as it is published.',
        color: '#7c3aed',
        category: 'devops',
        fields: [
            { key: 'url', label: 'Endpoint URL', type: 'url', required: true, placeholder: 'https://evidence.example.com/ward' },
            { key: 'auth_header', label: 'Authorization header value', type: 'password', required: false, placeholder: 'Sent as the Authorization header, e.g. Bearer <token>' }
        ],
        docs: 'https://quox.ai/docs'
    },

    gitea: {
        id: 'gitea',
        name: 'Gitea',
        description: 'Self-hosted Git service',
        color: '#609926',
        category: 'devops',
        fields: [
            { key: 'token', label: 'Access Token', type: 'password', required: true, placeholder: 'Gitea personal/project access token' },
            { key: 'base_url', label: 'Gitea URL', type: 'url', required: true, placeholder: 'https://gitea.example.com' }
        ],
        testEndpoint: (creds) => `${String(creds.base_url).replace(/\/$/, '')}/api/v1/version`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `token ${creds.token}` }),
        docs: 'https://docs.gitea.com/development/api-usage'
    },

    // VAULT-INTEG P2: registry truth pass. credentialResolver.js's
    // PROVIDER_TYPE_MAP / NOTIFICATION_ENV_MAP have targeted these
    // integration_type ids for multiple phases, but nobody registered them
    // here — so the vault UI had no form to create the credential the
    // resolver was already trying to resolve. IDs below match the resolver
    // maps verbatim (including the 'google-chat' hyphen).
    smtp: {
        id: 'smtp',
        name: 'Email Account (IMAP + SMTP)',
        description: 'Send-only SMTP transport for transactional email, HITL notifications and QuoxChat transcripts, plus optional IMAP fields for the email_read tool executor. Field names match the email_account credential kind used by the instance email panel (EMAIL-UNIFY P2).',
        color: '#EA580C',
        category: 'notification',
        credentialKind: 'email_account',
        fields: [
            { key: 'smtp_host', label: 'SMTP Host', type: 'text', required: true, placeholder: 'smtp.example.com' },
            { key: 'smtp_port', label: 'SMTP Port', type: 'number', required: true, default: '587', placeholder: '587' },
            { key: 'smtp_secure', label: 'Use TLS (SMTPS)', type: 'boolean', required: false, default: false },
            { key: 'username', label: 'Username', type: 'text', required: false, placeholder: 'Optional — omit for unauthenticated relays' },
            { key: 'password', label: 'Password', type: 'password', required: false, placeholder: 'Optional' },
            { key: 'from', label: 'From Address', type: 'text', required: true, placeholder: 'notifications@example.com' },
            { key: 'imap_host', label: 'IMAP Host', type: 'text', required: false, placeholder: 'imap.example.com' },
            { key: 'imap_port', label: 'IMAP Port', type: 'number', required: false, default: '993', placeholder: '993' }
        ],
        // There is no generic reachable endpoint for an arbitrary SMTP host
        // without actually opening an SMTP session, so this stays format-check
        // only — testConnection()'s validateCredentials-only branch already
        // reports the result as "Credentials validated (format check only)".
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.smtp_host) return { valid: false, error: 'SMTP Host is required (format check only — no live SMTP handshake is performed)' };
            if (!creds.from) return { valid: false, error: 'From Address is required (format check only — no live SMTP handshake is performed)' };
            return { valid: true };
        },
        docs: 'https://nodemailer.com/smtp/'
    },
    gmail: {
        id: 'gmail',
        name: 'Gmail',
        description: 'Connect a Gmail or Google Workspace mailbox over IMAP using an app-specific password (Google blocks your normal password for third-party IMAP, so 2-Step Verification must be on). Host and ports are pre-filled.',
        color: '#EA4335',
        category: 'email',
        credentialKind: 'email_account',
        fields: [
            { key: 'username', label: 'Email Address', type: 'text', required: true, placeholder: 'you@gmail.com' },
            { key: 'password', label: 'App Password', type: 'password', required: true, placeholder: '16-character app password' },
            { key: 'imap_host', label: 'IMAP Host', type: 'text', required: false, default: 'imap.gmail.com', placeholder: 'imap.gmail.com' },
            { key: 'imap_port', label: 'IMAP Port', type: 'number', required: false, default: '993', placeholder: '993' },
            { key: 'smtp_host', label: 'SMTP Host', type: 'text', required: false, default: 'smtp.gmail.com', placeholder: 'smtp.gmail.com' },
            { key: 'smtp_port', label: 'SMTP Port', type: 'number', required: false, default: '465', placeholder: '465' },
            { key: 'smtp_secure', label: 'Use TLS (SMTPS)', type: 'boolean', required: false, default: true },
            { key: 'from', label: 'From Address', type: 'text', required: false, placeholder: 'Defaults to your email address' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.username) return { valid: false, error: 'Email address is required' };
            if (!creds.password) return { valid: false, error: 'App password is required: create one at myaccount.google.com/apppasswords with 2-Step Verification on' };
            return { valid: true };
        },
        docs: 'https://support.google.com/accounts/answer/185833'
    },
    icloud: {
        id: 'icloud',
        name: 'iCloud Mail',
        description: 'Connect an iCloud (@icloud.com/@me.com/@mac.com) mailbox over IMAP using an Apple app-specific password (requires two-factor auth on the Apple ID). Host and ports are pre-filled.',
        color: '#3D9BE9',
        category: 'email',
        credentialKind: 'email_account',
        fields: [
            { key: 'username', label: 'Email Address', type: 'text', required: true, placeholder: 'you@icloud.com' },
            { key: 'password', label: 'App-Specific Password', type: 'password', required: true, placeholder: 'app-specific password from appleid.apple.com' },
            { key: 'imap_host', label: 'IMAP Host', type: 'text', required: false, default: 'imap.mail.me.com', placeholder: 'imap.mail.me.com' },
            { key: 'imap_port', label: 'IMAP Port', type: 'number', required: false, default: '993', placeholder: '993' },
            { key: 'smtp_host', label: 'SMTP Host', type: 'text', required: false, default: 'smtp.mail.me.com', placeholder: 'smtp.mail.me.com' },
            { key: 'smtp_port', label: 'SMTP Port', type: 'number', required: false, default: '587', placeholder: '587' },
            { key: 'smtp_secure', label: 'Use TLS', type: 'boolean', required: false, default: true },
            { key: 'from', label: 'From Address', type: 'text', required: false, placeholder: 'Defaults to your email address' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.username) return { valid: false, error: 'Email address is required' };
            if (!creds.password) return { valid: false, error: 'App-specific password is required: generate one at appleid.apple.com under Sign-In & Security' };
            return { valid: true };
        },
        docs: 'https://support.apple.com/en-us/102654'
    },
    icloud_contacts: {
        id: 'icloud_contacts',
        name: 'iCloud Contacts',
        description: 'Pull your iCloud address book into ContactsQ over CardDAV, one way and read only. Use your Apple ID and an app-specific password (requires two-factor auth on the Apple ID).',
        color: '#3D9BE9',
        category: 'productivity',
        credentialKind: 'carddav_account',
        fields: [
            { key: 'username', label: 'Apple ID', type: 'text', required: true, placeholder: 'you@icloud.com' },
            { key: 'password', label: 'App-Specific Password', type: 'password', required: true, placeholder: 'xxxx-xxxx-xxxx-xxxx', help: 'Create one at account.apple.com > Sign-In and Security > App-Specific Passwords' },
            { key: 'server_url', label: 'Server URL', type: 'text', required: false, default: 'https://contacts.icloud.com', placeholder: 'https://contacts.icloud.com' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.username) return { valid: false, error: 'Apple ID is required' };
            if (!creds.password) return { valid: false, error: 'App-specific password is required: create one at account.apple.com under Sign-In and Security' };
            return { valid: true };
        },
        docs: 'https://support.apple.com/en-us/102654'
    },
    carddav: {
        id: 'carddav',
        name: 'CardDAV Address Book',
        description: 'Pull a CardDAV address book (Fastmail, Nextcloud and others) into ContactsQ, one way and read only.',
        color: '#64748B',
        category: 'productivity',
        credentialKind: 'carddav_account',
        fields: [
            { key: 'server_url', label: 'Server URL', type: 'text', required: true, placeholder: 'https://carddav.fastmail.com' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'you@example.com' },
            { key: 'password', label: 'Password or App Password', type: 'password', required: true, placeholder: 'app password' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.server_url) return { valid: false, error: 'Server URL is required' };
            if (!/^https:\/\//i.test(String(creds.server_url))) return { valid: false, error: 'Server URL must start with https://' };
            if (!creds.username) return { valid: false, error: 'Username is required' };
            if (!creds.password) return { valid: false, error: 'Password is required' };
            return { valid: true };
        },
        docs: 'https://datatracker.ietf.org/doc/html/rfc6352'
    },
    outlook: {
        id: 'outlook',
        name: 'Outlook / Microsoft 365',
        description: 'Connect an Outlook.com or Microsoft 365 mailbox over IMAP using an app password (requires two-step verification). Host and ports are pre-filled.',
        color: '#0F6CBD',
        category: 'email',
        credentialKind: 'email_account',
        fields: [
            { key: 'username', label: 'Email Address', type: 'text', required: true, placeholder: 'you@outlook.com' },
            { key: 'password', label: 'App Password', type: 'password', required: true, placeholder: 'app password from account.microsoft.com/security' },
            { key: 'imap_host', label: 'IMAP Host', type: 'text', required: false, default: 'outlook.office365.com', placeholder: 'outlook.office365.com' },
            { key: 'imap_port', label: 'IMAP Port', type: 'number', required: false, default: '993', placeholder: '993' },
            { key: 'smtp_host', label: 'SMTP Host', type: 'text', required: false, default: 'smtp.office365.com', placeholder: 'smtp.office365.com' },
            { key: 'smtp_port', label: 'SMTP Port', type: 'number', required: false, default: '587', placeholder: '587' },
            { key: 'smtp_secure', label: 'Use TLS', type: 'boolean', required: false, default: true },
            { key: 'from', label: 'From Address', type: 'text', required: false, placeholder: 'Defaults to your email address' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.username) return { valid: false, error: 'Email address is required' };
            if (!creds.password) return { valid: false, error: 'App password is required: create one at account.microsoft.com/security' };
            return { valid: true };
        },
        docs: 'https://support.microsoft.com/en-us/account-billing/create-app-passwords-d385a87e-9c48-4204-b8ba-d4f57c5b6c0e'
    },
    webhook: {
        id: 'webhook',
        name: 'Generic Webhook',
        description: 'Outgoing webhook for a custom notification target not covered by a named provider.',
        color: '#64748B',
        category: 'notification',
        fields: [
            { key: 'url', label: 'Webhook URL', type: 'url', required: true, placeholder: 'https://example.com/hooks/quox' },
            { key: 'secret', label: 'Shared Secret', type: 'password', required: false, placeholder: 'Optional — sent as a signing header if set' }
        ],
        // HEAD only — a POST here would be indistinguishable from a real
        // notification landing on the target endpoint.
        testEndpoint: (creds) => creds.url,
        testMethod: 'HEAD',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            try { new URL(creds.url); } catch { return { valid: false, error: 'Webhook URL must be a valid absolute URL' }; }
            if (!/^https?:\/\//i.test(creds.url)) return { valid: false, error: 'Webhook URL must be http or https' };
            return { valid: true };
        }
    },
    mattermost: {
        id: 'mattermost',
        name: 'Mattermost',
        description: 'Mattermost incoming webhook notifications',
        color: '#0058CC',
        category: 'notification',
        fields: [
            { key: 'webhook_url', label: 'Incoming Webhook URL', type: 'password', required: true, placeholder: 'https://mattermost.example.com/hooks/...' }
        ],
        // No token to check independently of the webhook itself — ping the
        // server's public, unauthenticated System API (proves the server is
        // reachable) rather than posting a real message through the hook,
        // same "reachability, not the secret" compromise ntfy's health check
        // makes below.
        testEndpoint: (creds) => `${new URL(creds.webhook_url).origin}/api/v4/system/ping`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://developers.mattermost.com/integrate/webhooks/incoming/'
    },
    'google-chat': {
        id: 'google-chat',
        name: 'Google Chat',
        description: 'Google Chat space incoming webhook notifications',
        color: '#00AC47',
        category: 'notification',
        fields: [
            { key: 'webhook_url', label: 'Incoming Webhook URL', type: 'password', required: true, placeholder: 'https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...' }
        ],
        // Google Chat's webhook endpoint only accepts POST — a GET/HEAD probe
        // returns a Google API error, not a health signal — and POSTing a
        // real Card V2 payload to "test" a credential would spam the space.
        // Format check only, same pattern as slack_webhook/discord_webhook below.
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.webhook_url?.startsWith('https://chat.googleapis.com/')) return { valid: false, error: 'Must be a valid Google Chat webhook URL' };
            return { valid: true };
        },
        docs: 'https://developers.google.com/workspace/chat/quickstart/webhooks'
    },
    gotify: {
        id: 'gotify',
        name: 'Gotify',
        description: 'Self-hosted push notification server',
        color: '#3A4D9F',
        category: 'notification',
        fields: [
            { key: 'server_url', label: 'Server URL', type: 'url', required: true, placeholder: 'https://gotify.example.com' },
            { key: 'app_token', label: 'Application Token', type: 'password', required: true, placeholder: 'Gotify app token' }
        ],
        // /health is public and unauthenticated — proves the server is
        // reachable without spending the app token on a real push message.
        testEndpoint: (creds) => `${(creds.server_url || '').replace(/\/$/, '')}/health`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://gotify.net/api-docs'
    },
    rocketchat: {
        id: 'rocketchat',
        name: 'Rocket.Chat',
        description: 'Rocket.Chat incoming webhook notifications',
        color: '#F5455C',
        category: 'notification',
        fields: [
            { key: 'webhook_url', label: 'Incoming Webhook URL', type: 'password', required: true, placeholder: 'https://rocketchat.example.com/hooks/...' }
        ],
        // /api/info is Rocket.Chat's public, unauthenticated server-info
        // endpoint — proves the server behind the webhook is reachable.
        testEndpoint: (creds) => `${new URL(creds.webhook_url).origin}/api/info`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://developer.rocket.chat/docs/webhooks'
    },

    // VAULT-INTEG P2: DataForSEO — keyword volume/difficulty/CPC + true SERP
    // rank tracking, QuoxSEO's paid data layer. Was created without a
    // `category`, which silently defaulted to Custom on the Browse page;
    // 'data' (Data & Analytics) is the category the registry's other
    // data-provider entries above (upstash, mysql, etc.) already use.
    dataforseo: {
        id: 'dataforseo',
        name: 'DataForSEO',
        description: 'Keyword volume, difficulty and CPC data, plus true SERP rank tracking. Powers the QuoxSEO paid keyword and rank data layer.',
        color: '#2b6cb0',
        category: 'data',
        fields: [
            { key: 'login', label: 'API Login (account email)', type: 'text', required: true, placeholder: 'you@example.com' },
            { key: 'password', label: 'API Password', type: 'password', required: true, placeholder: 'DataForSEO dashboard → API Access' }
        ],
        // Account/balance endpoint: a Basic-auth GET that proves the credential
        // works (and returns the remaining balance) without spending on a task.
        testEndpoint: 'https://api.dataforseo.com/v3/appendix/user_data',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString('base64')}` }),
        docs: 'https://docs.dataforseo.com/v3/'
    },

    openai: {
        id: 'openai',
        name: 'OpenAI',
        description: 'GPT models, embeddings, and DALL-E',
        color: '#00A67E',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'sk-', placeholder: 'sk-...' }
        ],
        testEndpoint: 'https://api.openai.com/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://platform.openai.com/docs/api-reference'
    },
    anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        description: 'Claude models and API',
        color: '#D4A574',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'sk-ant-', placeholder: 'sk-ant-...' }
        ],
        testEndpoint: 'https://api.anthropic.com/v1/messages',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'x-api-key': creds.api_key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        }),
        testBody: { model: 'claude-3-5-haiku-20241022', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] },
        docs: 'https://docs.anthropic.com/en/api'
    },
    gemini: {
        id: 'gemini',
        name: 'Google Gemini',
        description: 'Gemini models and Vertex AI',
        color: '#4285F4',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'AIza...' }
        ],
        testEndpoint: 'https://generativelanguage.googleapis.com/v1/models',
        testMethod: 'GET',
        testHeaders: () => ({}),
        testParams: (creds) => ({ key: creds.api_key }),
        docs: 'https://ai.google.dev/docs'
    },
    elevenlabs: {
        id: 'elevenlabs',
        name: 'ElevenLabs',
        description: 'Text-to-speech and voice cloning',
        color: '#000000',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.elevenlabs.io/v1/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'xi-api-key': creds.api_key }),
        docs: 'https://docs.elevenlabs.io/api-reference'
    },
    cohere: {
        id: 'cohere',
        name: 'Cohere',
        description: 'Command, Embed, and Rerank models',
        color: '#39594D',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.cohere.com/v2/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.cohere.com/'
    },
    mistral: {
        id: 'mistral',
        name: 'Mistral AI',
        description: 'Mistral and Mixtral models',
        color: '#FF7000',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.mistral.ai/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.mistral.ai/'
    },
    groq: {
        id: 'groq',
        name: 'Groq',
        description: 'Ultra-fast LPU inference (Llama, Mixtral)',
        color: '#F55036',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'gsk_', placeholder: 'gsk_...' }
        ],
        testEndpoint: 'https://api.groq.com/openai/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://console.groq.com/docs'
    },
    xai: {
        id: 'xai',
        name: 'xAI (Grok)',
        description: 'Grok models from xAI',
        color: '#000000',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'xai-', placeholder: 'xai-...' }
        ],
        testEndpoint: 'https://api.x.ai/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.x.ai/'
    },
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        description: 'DeepSeek Coder and Chat models',
        color: '#4D6BFE',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'sk-', placeholder: 'sk-...' }
        ],
        testEndpoint: 'https://api.deepseek.com/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://platform.deepseek.com/api-docs'
    },
    together: {
        id: 'together',
        name: 'Together AI',
        description: 'Open-source model inference (Llama, Mistral, etc.)',
        color: '#0F6FFF',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.together.xyz/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.together.ai/'
    },
    replicate: {
        id: 'replicate',
        name: 'Replicate',
        description: 'Run open-source models in the cloud',
        color: '#000000',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, prefix: 'r8_', placeholder: 'r8_...' }
        ],
        testEndpoint: 'https://api.replicate.com/v1/collections',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token ${creds.api_token}` }),
        docs: 'https://replicate.com/docs'
    },
    huggingface: {
        id: 'huggingface',
        name: 'Hugging Face',
        description: 'Inference API and model hub',
        color: '#FFD21E',
        fields: [
            { key: 'api_token', label: 'Access Token', type: 'password', required: true, prefix: 'hf_', placeholder: 'hf_...' }
        ],
        testEndpoint: 'https://huggingface.co/api/whoami-v2',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://huggingface.co/docs/api-inference'
    },
    perplexity: {
        id: 'perplexity',
        name: 'Perplexity',
        description: 'Sonar search-augmented models',
        color: '#20808D',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'pplx-', placeholder: 'pplx-...' }
        ],
        testEndpoint: 'https://api.perplexity.ai/chat/completions',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.api_key}`,
            'Content-Type': 'application/json'
        }),
        testBody: { model: 'sonar', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 },
        docs: 'https://docs.perplexity.ai/'
    },
    fireworks: {
        id: 'fireworks',
        name: 'Fireworks AI',
        description: 'Fast inference for open models',
        color: '#FF6B35',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'fw_', placeholder: 'fw_...' }
        ],
        testEndpoint: 'https://api.fireworks.ai/inference/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.fireworks.ai/'
    },
    openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        description: 'One key, 300+ LLMs (OpenAI-compatible)',
        color: '#6467F2',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-or-...' }
        ],
        testEndpoint: 'https://openrouter.ai/api/v1/key',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://openrouter.ai/docs'
    },
    deepgram: {
        id: 'deepgram',
        name: 'Deepgram',
        description: 'Speech-to-text: streaming/latency-leading transcription',
        color: '#13EF93',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Deepgram API key' }
        ],
        testEndpoint: 'https://api.deepgram.com/v1/projects',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token ${creds.api_key}` }),
        docs: 'https://developers.deepgram.com/reference/'
    },
    exa: {
        id: 'exa',
        name: 'Exa',
        description: 'Neural web search + contents for agent grounding',
        color: '#1F2937',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Exa API key' }
        ],
        // Format-check only, deliberately: Exa has no cheap authed GET (its
        // read surface is search/contents/findSimilar, all billable POSTs),
        // so a live test is impossible without spending a search credit.
        // The connector's own /search POST carries the real auth proof.
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (typeof creds.api_key !== 'string' || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            return { valid: true };
        },
        docs: 'https://docs.exa.ai'
    },
    tavily: {
        id: 'tavily',
        name: 'Tavily',
        description: 'Agent-search default, 1000 free credits/mo',
        color: '#3B82F6',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'tvly-', placeholder: 'tvly-...' }
        ],
        // Format-check only, deliberately: Tavily is POST-only (search /
        // extract), no cheap authed GET exists. The connector's own /search
        // POST carries the real auth proof.
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (typeof creds.api_key !== 'string' || !creds.api_key.startsWith('tvly-')) {
                return { valid: false, error: 'Key should start with tvly-' };
            }
            return { valid: true };
        },
        docs: 'https://docs.tavily.com'
    },
    fal: {
        id: 'fal',
        name: 'fal.ai',
        description: '1000+ image/video/audio models, one key',
        color: '#EC4899',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your fal API key' }
        ],
        // Format-check only, deliberately: fal has no cheap authed account/model
        // GET (its poll endpoints need a real request_id from a real, billable
        // submit), so a live test is impossible without spending on a job.
        // The connector's own get_status poll carries the real auth proof.
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (typeof creds.api_key !== 'string' || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            return { valid: true };
        },
        docs: 'https://docs.fal.ai'
    },

    // ========================================================================
    // AI Image Generation
    // ========================================================================
    stability: {
        id: 'stability',
        name: 'Stability AI',
        description: 'Stable Diffusion image generation',
        color: '#9B59B6',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'sk-', placeholder: 'sk-...' }
        ],
        testEndpoint: 'https://api.stability.ai/v1/user/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://platform.stability.ai/docs/api-reference'
    },
    leonardo: {
        id: 'leonardo',
        name: 'Leonardo AI',
        description: 'AI image generation and editing',
        color: '#7B68EE',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'leonardo_', placeholder: 'leonardo_...' }
        ],
        testEndpoint: 'https://cloud.leonardo.ai/api/rest/v1/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.leonardo.ai/'
    },
    ideogram: {
        id: 'ideogram',
        name: 'Ideogram',
        description: 'AI image generation with text rendering',
        color: '#FF6B6B',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Api-Key': creds.api_key }),
        validateCredentials: (creds) => {
            if (!creds.api_key || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            return { valid: true };
        },
        docs: 'https://developer.ideogram.ai/api-reference'
    },
    midjourney: {
        id: 'midjourney',
        name: 'Midjourney',
        description: 'Midjourney image generation (via proxy)',
        color: '#000000',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your proxy API key' },
            { key: 'base_url', label: 'Proxy URL', type: 'url', required: true, placeholder: 'https://api.yourproxy.com' }
        ],
        // Midjourney uses proxies, test by hitting the proxy's health/status endpoint
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        validateCredentials: (creds) => {
            if (!creds.api_key || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            if (!creds.base_url) {
                return { valid: false, error: 'Proxy URL is required' };
            }
            try {
                new URL(creds.base_url);
            } catch {
                return { valid: false, error: 'Invalid proxy URL format' };
            }
            return { valid: true };
        },
        docs: 'https://docs.midjourney.com/'
    },
    dalleapi: {
        id: 'dalleapi',
        name: 'DALL-E API',
        description: 'OpenAI DALL-E image generation (standalone)',
        color: '#00A67E',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'sk-', placeholder: 'sk-...' }
        ],
        testEndpoint: 'https://api.openai.com/v1/models',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://platform.openai.com/docs/api-reference/images'
    },

    // ========================================================================
    // AI Video Generation
    // ========================================================================
    runway: {
        id: 'runway',
        name: 'Runway ML',
        description: 'Gen-2, Gen-3 video generation',
        color: '#00D4FF',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.dev.runwayml.com/v1/organization',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}`, 'X-Runway-Version': '2024-11-06' }),
        docs: 'https://docs.runwayml.com/'
    },
    pika: {
        id: 'pika',
        name: 'Pika Labs',
        description: 'AI video generation',
        color: '#FF69B4',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        // Pika Labs API is not publicly documented, use validateCredentials
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.api_key || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            return { valid: true };
        },
        docs: 'https://pika.art/'
    },
    luma: {
        id: 'luma',
        name: 'Luma AI',
        description: 'Dream Machine video generation',
        color: '#8B5CF6',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.lumalabs.ai/dream-machine/v1/generations',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.lumalabs.ai/'
    },
    kling: {
        id: 'kling',
        name: 'Kling AI',
        description: 'AI video generation (China-based)',
        color: '#E11D48',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' },
            { key: 'base_url', label: 'API Base URL', type: 'url', required: true, placeholder: 'https://api.klingai.com' }
        ],
        // Kling uses base_url since it requires proxy for most regions
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        validateCredentials: (creds) => {
            if (!creds.api_key || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            if (!creds.base_url) {
                return { valid: false, error: 'API Base URL is required' };
            }
            try {
                new URL(creds.base_url);
            } catch {
                return { valid: false, error: 'Invalid base URL format' };
            }
            return { valid: true };
        },
        docs: 'https://klingai.com/'
    },
    heygen: {
        id: 'heygen',
        name: 'HeyGen',
        description: 'AI video avatars and talking heads',
        color: '#6366F1',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.heygen.com/v3/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'x-api-key': creds.api_key }),
        docs: 'https://docs.heygen.com/'
    },

    // ========================================================================
    // AI Audio/Music Generation
    // ========================================================================
    suno: {
        id: 'suno',
        name: 'Suno AI',
        description: 'AI music and song generation',
        color: '#F59E0B',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        // Suno API is not publicly documented, use validateCredentials only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.api_key || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            return { valid: true };
        },
        docs: 'https://suno.ai/'
    },
    zapier: {
        id: 'zapier',
        name: 'Zapier',
        description: 'Automation platform connecting 5000+ apps',
        color: '#FF4A00',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Zapier NLA API key' }
        ],
        testEndpoint: 'https://actions.zapier.com/api/v2/check/',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'x-api-key': creds.api_key }),
        docs: 'https://actions.zapier.com/docs/platform/api'
    },
    make: {
        id: 'make',
        name: 'Make (Integromat)',
        description: 'Visual automation platform for workflows',
        color: '#6D00CC',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Make API token' },
            { key: 'team_id', label: 'Team ID', type: 'text', required: true, placeholder: 'Your team ID' }
        ],
        testEndpoint: 'https://us1.make.com/api/v2/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token ${creds.api_token}` }),
        docs: 'https://www.make.com/en/api-documentation'
    },
    ifttt: {
        id: 'ifttt',
        name: 'IFTTT',
        description: 'Simple automation for everyday tasks',
        color: '#000000',
        fields: [
            { key: 'service_key', label: 'Service Key', type: 'password', required: true, placeholder: 'Your IFTTT Webhooks service key' }
        ],
        testEndpoint: (creds) => `https://maker.ifttt.com/trigger/test/with/key/${creds.service_key}`,
        testMethod: 'POST',
        testHeaders: () => ({}),
        docs: 'https://ifttt.com/docs'
    },
    pipedream: {
        id: 'pipedream',
        name: 'Pipedream',
        description: 'Developer-first automation platform',
        color: '#1E88E5',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Pipedream API key' }
        ],
        testEndpoint: 'https://api.pipedream.com/v1/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://pipedream.com/docs/api/'
    },
    activepieces: {
        id: 'activepieces',
        name: 'Activepieces',
        description: 'Open-source automation platform',
        color: '#6E41E2',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Activepieces API key' },
            { key: 'base_url', label: 'Instance URL', type: 'url', required: true, placeholder: 'https://activepieces.example.com' }
        ],
        testEndpoint: '/api/v1/authentication/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://www.activepieces.com/docs'
    },
    tray: {
        id: 'tray',
        name: 'Tray.io',
        description: 'Enterprise automation platform',
        color: '#12B886',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Tray.io access token' }
        ],
        testEndpoint: 'https://api.tray.io/core/v1/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://tray.io/documentation'
    },
    workato: {
        id: 'workato',
        name: 'Workato',
        description: 'Enterprise automation and integration platform',
        color: '#00538B',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Workato API token' }
        ],
        testEndpoint: 'https://www.workato.com/api/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.workato.com/workato-api.html'
    },
    power_automate: {
        id: 'power_automate',
        name: 'Power Automate',
        description: 'Microsoft Power Automate (Flow)',
        color: '#0066FF',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Azure AD Application ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' },
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Azure AD Tenant ID' }
        ],
        // Power Automate uses Azure OAuth flow (same as MS Teams)
        testEndpoint: (creds) => `https://login.microsoftonline.com/${creds.tenant_id}/oauth2/v2.0/token`,
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        testBody: (creds) => new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            scope: 'https://service.flow.microsoft.com/.default'
        }).toString(),
        docs: 'https://learn.microsoft.com/en-us/power-automate/web-api'
    },
    airtable: {
        id: 'airtable',
        name: 'Airtable',
        description: 'Spreadsheet-database hybrid with automation',
        color: '#18BFFF',
        fields: [
            { key: 'api_key', label: 'API Key / Personal Access Token', type: 'password', required: true, placeholder: 'pat... or key...' }
        ],
        testEndpoint: 'https://api.airtable.com/v0/meta/whoami',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://airtable.com/developers/web/api/introduction'
    },
    notion: {
        id: 'notion',
        name: 'Notion',
        description: 'All-in-one workspace with database automation',
        color: '#000000',
        // No `prefix` here deliberately: legacy Notion internal-integration
        // tokens start `secret_`, but tokens issued via OAuth (since late
        // 2024, and every token the Brain2 OAuth-connect flow stores) start
        // `ntn_`. A single startsWith() prefix can't accept both, so this
        // field accepts either shape rather than 400ing on real OAuth
        // tokens (BRAIN2-OAUTH-NOTION).
        fields: [
            { key: 'integration_token', label: 'Integration Token', type: 'password', required: true, placeholder: 'secret_... or ntn_...' }
        ],
        testEndpoint: 'https://api.notion.com/v1/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.integration_token}`,
            'Notion-Version': '2022-06-28'
        }),
        docs: 'https://developers.notion.com/'
    },
    // BRAIN2-OAUTH-GDRIVE: mirrors the notion entry above. integration_token
    // holds the short-lived Drive access token issued by the Brain2
    // OAuth-connect flow (services/auth/routes/oauth-connect.js); refresh
    // is not yet implemented (see oauthConnectProviders.js's gdrive entry),
    // so this field is populated by the OAuth callback, not typed by hand.
    gdrive: {
        id: 'gdrive',
        name: 'Google Drive',
        description: 'Docs and files from a connected Google Drive account',
        color: '#0F9D58',
        fields: [
            { key: 'integration_token', label: 'Access Token', type: 'password', required: true, placeholder: 'ya29...' }
        ],
        testEndpoint: 'https://www.googleapis.com/drive/v3/about?fields=user',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.integration_token}`
        }),
        docs: 'https://developers.google.com/drive/api/guides/about-sdk'
    },
    // GOOGLE-GSC groundwork (2026-09-03, owner request "add it to vault now
    // so it's there when we come to do the plugin"): a Google Cloud SERVICE
    // ACCOUNT credential, the auth shape the Search Console plugin (and any
    // future server-to-server Google API plugin: GA4, Indexing API) rides.
    // The whole downloaded JSON key is stored as one secret field; consumers
    // parse it and mint short-lived RS256-JWT bearer tokens themselves, so
    // no derived token is ever persisted. property_url is the non-secret
    // GSC property this account was granted on (e.g. sc-domain:example.com).
    google_service_account: {
        id: 'google_service_account',
        name: 'Google Service Account',
        description: 'Server-to-server Google API credential (Search Console, Analytics): the downloaded service-account JSON key',
        color: '#4285F4',
        category: 'integrations',
        fields: [
            { key: 'service_account_json', label: 'Service Account Key (JSON)', type: 'password', required: true, placeholder: '{ "type": "service_account", ... }' },
            { key: 'property_url', label: 'Property / Scope Hint', type: 'text', required: false, placeholder: 'sc-domain:example.com' }
        ],
        // No static testEndpoint: a service account is proven by signing a
        // JWT and exchanging it, which the consuming plugin does; a bare
        // GET cannot exercise it without embedding that flow here.
        // VAULT-INTEG P8: this entry previously had neither testEndpoint
        // nor validateCredentials, so testConnection() fell through to
        // "No test endpoint configured" for every save — the one registry
        // entry with a real gap, not a deliberate format-only choice. Add
        // the same well-formed-JSON check the aws/gcp/bigquery/firebase
        // service-account entries already use.
        validateCredentials: (creds) => {
            let json;
            try {
                json = typeof creds.service_account_json === 'string'
                    ? JSON.parse(creds.service_account_json)
                    : creds.service_account_json;
            } catch (e) {
                return { valid: false, error: 'Invalid JSON format' };
            }
            const required = ['type', 'client_email', 'private_key'];
            const missing = required.filter(key => !json?.[key]);
            if (missing.length > 0) {
                return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
            }
            if (json.type !== 'service_account') {
                return { valid: false, error: 'JSON type must be "service_account"' };
            }
            return { valid: true };
        },
        docs: 'https://developers.google.com/identity/protocols/oauth2/service-account'
    },
    obsidian: {
        id: 'obsidian',
        name: 'Obsidian',
        description: 'Knowledge base with local REST API plugin',
        color: '#7C3AED',
        category: 'productivity',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Local REST API key' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: false, placeholder: 'https://127.0.0.1:27124' }
        ],
        testEndpoint: (creds) => `${creds.base_url || 'https://127.0.0.1:27124'}/`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://github.com/coddingtonbear/obsidian-local-rest-api'
    },
    roam_research: {
        id: 'roam_research',
        name: 'Roam Research',
        description: 'Networked thought and note-taking',
        color: '#0066FF',
        category: 'productivity',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Roam API token' },
            { key: 'graph_name', label: 'Graph Name', type: 'text', required: true, placeholder: 'your-graph' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.graph_name || creds.graph_name.length < 1) {
                return { valid: false, error: 'Graph name is required' };
            }
            return { valid: true };
        },
        docs: 'https://roamresearch.com/#/app/developer-documentation'
    },
    logseq: {
        id: 'logseq',
        name: 'Logseq',
        description: 'Privacy-first knowledge base',
        color: '#85C8C8',
        category: 'productivity',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Logseq API token' },
            { key: 'base_url', label: 'API URL', type: 'url', required: false, placeholder: 'http://127.0.0.1:12315' }
        ],
        testEndpoint: (creds) => `${creds.base_url || 'http://127.0.0.1:12315'}/api`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.logseq.com/'
    },
    telegram: {
        id: 'telegram',
        name: 'Telegram Bot',
        description: 'Telegram messaging bot',
        color: '#0088CC',
        fields: [
            { key: 'bot_token', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...' }
        ],
        testEndpoint: (creds) => `https://api.telegram.org/bot${creds.bot_token}/getMe`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://core.telegram.org/bots/api'
    },
    slack: {
        id: 'slack',
        name: 'Slack',
        description: 'Slack workspace integration',
        color: '#4A154B',
        fields: [
            { key: 'bot_token', label: 'Bot Token', type: 'password', required: true, prefix: 'xoxb-', placeholder: 'xoxb-...' },
            { key: 'signing_secret', label: 'Signing Secret', type: 'password', required: false, placeholder: 'Optional' }
        ],
        testEndpoint: 'https://slack.com/api/auth.test',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.bot_token}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }),
        docs: 'https://api.slack.com/docs'
    },
    whatsapp: {
        id: 'whatsapp',
        name: 'WhatsApp Business API',
        description: 'WhatsApp Business messaging platform',
        color: '#25D366',
        fields: [
            { key: 'phone_number_id', label: 'Phone Number ID', type: 'text', required: true, placeholder: 'Your phone number ID' },
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' }
        ],
        testEndpoint: (creds) => `https://graph.facebook.com/v21.0/${creds.phone_number_id}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api'
    },
    messenger: {
        id: 'messenger',
        name: 'Facebook Messenger',
        description: 'Facebook Messenger bot platform',
        color: '#0084FF',
        fields: [
            { key: 'page_access_token', label: 'Page Access Token', type: 'password', required: true, placeholder: 'Your page access token' }
        ],
        testEndpoint: 'https://graph.facebook.com/v21.0/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.page_access_token}` }),
        docs: 'https://developers.facebook.com/docs/messenger-platform'
    },
    viber: {
        id: 'viber',
        name: 'Viber Bot',
        description: 'Viber messaging bot platform',
        color: '#665CAC',
        fields: [
            { key: 'auth_token', label: 'Auth Token', type: 'password', required: true, placeholder: 'Your Viber auth token' }
        ],
        testEndpoint: 'https://chatapi.viber.com/pa/get_account_info',
        testMethod: 'POST',
        testHeaders: (creds) => ({ 'X-Viber-Auth-Token': creds.auth_token }),
        testBody: {},
        docs: 'https://developers.viber.com/docs/api/rest-bot-api/'
    },
    line: {
        id: 'line',
        name: 'LINE Messaging',
        description: 'LINE Messaging API platform',
        color: '#00B900',
        fields: [
            { key: 'channel_access_token', label: 'Channel Access Token', type: 'password', required: true, placeholder: 'Your channel access token' }
        ],
        testEndpoint: 'https://api.line.me/v2/bot/info',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.channel_access_token}` }),
        docs: 'https://developers.line.biz/en/docs/messaging-api/'
    },
    wechat: {
        id: 'wechat',
        name: 'WeChat Official',
        description: 'WeChat Official Account platform',
        color: '#07C160',
        fields: [
            { key: 'app_id', label: 'App ID', type: 'text', required: true, placeholder: 'Your WeChat App ID' },
            { key: 'app_secret', label: 'App Secret', type: 'password', required: true, placeholder: 'Your WeChat App Secret' }
        ],
        testEndpoint: 'https://api.weixin.qq.com/cgi-bin/token',
        testMethod: 'GET',
        testHeaders: () => ({}),
        testParams: (creds) => ({ grant_type: 'client_credential', appid: creds.app_id, secret: creds.app_secret }),
        docs: 'https://developers.weixin.qq.com/doc/offiaccount/en/Getting_Started/Overview.html'
    },
    intercom: {
        id: 'intercom',
        name: 'Intercom',
        description: 'Customer messaging platform',
        color: '#1F8DED',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Intercom access token' }
        ],
        testEndpoint: 'https://api.intercom.io/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.intercom.com/docs'
    },
    drift: {
        id: 'drift',
        name: 'Drift (Salesloft)',
        description: 'Conversational marketing (acquired by Salesloft 2024)',
        deprecated: true,
        color: '#0176FF',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Drift access token' }
        ],
        testEndpoint: 'https://driftapi.com/users/current',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://devdocs.drift.com/'
    },
    crisp: {
        id: 'crisp',
        name: 'Crisp',
        description: 'Customer messaging and support platform',
        color: '#1972F5',
        fields: [
            { key: 'identifier', label: 'Identifier', type: 'text', required: true, placeholder: 'Your Crisp identifier' },
            { key: 'key', label: 'Key', type: 'password', required: true, placeholder: 'Your Crisp key' }
        ],
        testEndpoint: 'https://api.crisp.chat/v1/website',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.identifier}:${creds.key}`).toString('base64')}`
        }),
        docs: 'https://docs.crisp.chat/api/v1/'
    },
    tawk: {
        id: 'tawk',
        name: 'Tawk.to',
        description: 'Live chat and messaging platform',
        color: '#03A84E',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Tawk.to API key' }
        ],
        testEndpoint: 'https://api.tawk.to/v1/property',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.api_key}`,
            'x-tawk-api-key': creds.api_key
        }),
        docs: 'https://developer.tawk.to/'
    },
    zendeskchat: {
        id: 'zendeskchat',
        name: 'Zendesk Chat',
        description: 'Zendesk live chat platform',
        color: '#03363D',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Zendesk Chat access token' }
        ],
        testEndpoint: 'https://chat.zendesk.com/api/v2/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.zendesk.com/api-reference/live-chat/chat-api/introduction/'
    },
    custom: {
        id: 'custom',
        name: 'Custom Integration',
        description: 'Custom API with configurable auth',
        color: '#6B7280',
        fields: [
            { key: 'api_key', label: 'API Key / Token', type: 'password', required: true, placeholder: 'Your API key or token' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://api.example.com' },
            { key: 'auth_header', label: 'Auth Header', type: 'text', required: false, default: 'Authorization', placeholder: 'Authorization' },
            { key: 'auth_prefix', label: 'Auth Prefix', type: 'text', required: false, default: 'Bearer', placeholder: 'Bearer' }
        ],
        testEndpoint: null, // Uses base_url
        testMethod: 'GET',
        testHeaders: (creds) => {
            const header = creds.auth_header || 'Authorization';
            const prefix = creds.auth_prefix ? `${creds.auth_prefix} ` : '';
            return { [header]: `${prefix}${creds.api_key}` };
        },
        docs: null
    },

    // ========================================================================
    // Developer Tools
    // ========================================================================
    github: {
        id: 'github',
        name: 'GitHub',
        description: 'GitHub repositories and CI/CD',
        category: 'developer',
        color: '#24292E',
        // No `prefix` here deliberately: GitHub PATs come in several valid
        // shapes and a single startsWith() can't accept them all. Classic
        // PATs start `ghp_`, but fine-grained PATs (the recommended, per-repo
        // scoped kind) start `github_pat_`, and app/OAuth tokens start
        // `gho_`/`ghu_`/`ghs_`/`ghr_`. Pinning `ghp_` 400'd real fine-grained
        // tokens; the testEndpoint below validates the token for real anyway
        // (mirrors the notion entry's multi-prefix reasoning).
        fields: [
            { key: 'token', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'ghp_... or github_pat_...' }
        ],
        testEndpoint: 'https://api.github.com/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.token}`,
            'Accept': 'application/vnd.github.v3+json'
        }),
        docs: 'https://docs.github.com/en/rest'
    },
    gitlab: {
        id: 'gitlab',
        name: 'GitLab',
        description: 'GitLab repositories and CI/CD',
        color: '#FC6D26',
        fields: [
            { key: 'private_token', label: 'Private Token', type: 'password', required: true, prefix: 'glpat-', placeholder: 'glpat-...' },
            { key: 'base_url', label: 'GitLab URL', type: 'url', required: false, default: 'https://gitlab.com', placeholder: 'https://gitlab.com' }
        ],
        testEndpoint: '/api/v4/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'PRIVATE-TOKEN': creds.private_token }),
        docs: 'https://docs.gitlab.com/ee/api/'
    },
    bitbucket: {
        id: 'bitbucket',
        name: 'Bitbucket',
        description: 'Bitbucket repositories and pipelines',
        color: '#0052CC',
        fields: [
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Your Bitbucket username' },
            { key: 'app_password', label: 'App Password', type: 'password', required: true, placeholder: 'App password' }
        ],
        testEndpoint: 'https://api.bitbucket.org/2.0/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.username}:${creds.app_password}`).toString('base64')}`
        }),
        docs: 'https://developer.atlassian.com/cloud/bitbucket/rest/intro/'
    },
    circleci: {
        id: 'circleci',
        name: 'CircleCI',
        description: 'CircleCI pipelines and workflows',
        color: '#343434',
        fields: [
            { key: 'token', label: 'API Token', type: 'password', required: true, placeholder: 'CircleCI API token' }
        ],
        testEndpoint: 'https://circleci.com/api/v2/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Circle-Token': creds.token }),
        docs: 'https://circleci.com/docs/api/v2/'
    },
    jenkins: {
        id: 'jenkins',
        name: 'Jenkins',
        description: 'Jenkins CI/CD server',
        color: '#D33833',
        fields: [
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Jenkins username' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Jenkins API token' },
            { key: 'base_url', label: 'Jenkins URL', type: 'url', required: true, placeholder: 'https://jenkins.example.com' }
        ],
        testEndpoint: '/api/json',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.username}:${creds.api_token}`).toString('base64')}`
        }),
        docs: 'https://www.jenkins.io/doc/book/using/remote-access-api/'
    },
    docker: {
        id: 'docker',
        name: 'Docker Hub',
        description: 'Docker Hub registry and images',
        color: '#2496ED',
        fields: [
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Docker Hub username' },
            { key: 'token', label: 'Access Token', type: 'password', required: true, placeholder: 'Docker Hub access token' }
        ],
        testEndpoint: (creds) => `https://hub.docker.com/v2/users/${creds.username}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://docs.docker.com/docker-hub/api/latest/'
    },
    vercel: {
        id: 'vercel',
        name: 'Vercel',
        description: 'Vercel deployments and projects',
        color: '#000000',
        fields: [
            { key: 'token', label: 'Access Token', type: 'password', required: true, placeholder: 'Vercel access token' }
        ],
        testEndpoint: 'https://api.vercel.com/v2/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://vercel.com/docs/rest-api'
    },
    netlify: {
        id: 'netlify',
        name: 'Netlify',
        description: 'Netlify sites and deployments',
        color: '#00C7B7',
        fields: [
            { key: 'token', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'Netlify access token' }
        ],
        testEndpoint: 'https://api.netlify.com/api/v1/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://docs.netlify.com/api/get-started/'
    },
    railway: {
        id: 'railway',
        name: 'Railway',
        description: 'Railway deployments and services',
        color: '#0B0D0E',
        fields: [
            { key: 'token', label: 'API Token', type: 'password', required: true, placeholder: 'Railway API token' }
        ],
        testEndpoint: 'https://backboard.railway.app/graphql/v2',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.token}`,
            'Content-Type': 'application/json'
        }),
        testBody: { query: '{ me { id email } }' },
        docs: 'https://docs.railway.app/reference/public-api'
    },
    render: {
        id: 'render',
        name: 'Render',
        description: 'Render services and deployments',
        color: '#46E3B7',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'rnd_', placeholder: 'rnd_...' }
        ],
        testEndpoint: 'https://api.render.com/v1/owners',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://api-docs.render.com/'
    },

    // ========================================================================
    // Cloud Services
    // ========================================================================
    aws: {
        id: 'aws',
        name: 'AWS',
        description: 'Amazon Web Services',
        color: '#FF9900',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'Secret access key' },
            { key: 'region', label: 'Default Region', type: 'text', required: false, default: 'us-east-1', placeholder: 'us-east-1' }
        ],
        // AWS uses signature-based auth, validate key format instead
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA') || creds.access_key_id.length !== 20) {
                return { valid: false, error: 'Invalid Access Key ID format' };
            }
            if (!creds.secret_access_key || creds.secret_access_key.length !== 40) {
                return { valid: false, error: 'Invalid Secret Access Key format' };
            }
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/general/latest/gr/aws-apis.html'
    },
    gcp: {
        id: 'gcp',
        name: 'Google Cloud',
        description: 'Google Cloud Platform',
        color: '#4285F4',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: '{"type": "service_account", ...}' }
        ],
        // GCP uses service account JSON, validate structure
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            try {
                const json = typeof creds.service_account_json === 'string'
                    ? JSON.parse(creds.service_account_json)
                    : creds.service_account_json;
                const required = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email'];
                const missing = required.filter(key => !json[key]);
                if (missing.length > 0) {
                    return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
                }
                if (json.type !== 'service_account') {
                    return { valid: false, error: 'JSON type must be "service_account"' };
                }
                return { valid: true };
            } catch (e) {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://cloud.google.com/docs/authentication'
    },
    azure: {
        id: 'azure',
        name: 'Azure',
        description: 'Microsoft Azure cloud services',
        color: '#0078D4',
        fields: [
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Azure tenant ID' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Application client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Client secret' }
        ],
        testEndpoint: (creds) => `https://login.microsoftonline.com/${creds.tenant_id}/oauth2/v2.0/token`,
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        testBody: (creds) => new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            scope: 'https://management.azure.com/.default'
        }).toString(),
        docs: 'https://learn.microsoft.com/en-us/azure/developer/'
    },
    digitalocean: {
        id: 'digitalocean',
        name: 'DigitalOcean',
        description: 'DigitalOcean cloud infrastructure',
        color: '#0080FF',
        fields: [
            { key: 'token', label: 'API Token', type: 'password', required: true, prefix: 'dop_v1_', placeholder: 'dop_v1_...' }
        ],
        testEndpoint: 'https://api.digitalocean.com/v2/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://docs.digitalocean.com/reference/api/'
    },
    cloudflare: {
        id: 'cloudflare',
        name: 'Cloudflare',
        description: 'Cloudflare DNS, CDN, and security',
        color: '#F38020',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Cloudflare API token' }
        ],
        testEndpoint: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://developers.cloudflare.com/api/'
    },
    linode: {
        id: 'linode',
        name: 'Linode (Akamai)',
        description: 'Akamai cloud computing (formerly Linode)',
        color: '#00A95C',
        fields: [
            { key: 'api_token', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'Your Linode API token' }
        ],
        testEndpoint: 'https://api.linode.com/v4/profile',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://www.linode.com/docs/api/'
    },
    vultr: {
        id: 'vultr',
        name: 'Vultr',
        description: 'High-performance cloud compute',
        color: '#007BFC',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Vultr API key' }
        ],
        testEndpoint: 'https://api.vultr.com/v2/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://www.vultr.com/api/'
    },
    hetzner: {
        id: 'hetzner',
        name: 'Hetzner Cloud',
        description: 'European cloud infrastructure',
        color: '#D50C2D',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Hetzner API token' }
        ],
        testEndpoint: 'https://api.hetzner.cloud/v1/datacenters',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.hetzner.cloud/'
    },
    ovh: {
        id: 'ovh',
        name: 'OVH Cloud',
        description: 'European cloud and hosting provider',
        color: '#123F6D',
        fields: [
            { key: 'application_key', label: 'Application Key', type: 'text', required: true, placeholder: 'OVH application key' },
            { key: 'application_secret', label: 'Application Secret', type: 'password', required: true, placeholder: 'OVH application secret' },
            { key: 'consumer_key', label: 'Consumer Key', type: 'password', required: true, placeholder: 'OVH consumer key' },
            { key: 'endpoint', label: 'API Endpoint', type: 'text', required: false, default: 'ovh-eu', placeholder: 'ovh-eu, ovh-us, ovh-ca' }
        ],
        // OVH uses signature-based auth, validate key formats
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.application_key || creds.application_key.length < 10) {
                return { valid: false, error: 'Invalid Application Key format' };
            }
            if (!creds.application_secret || creds.application_secret.length < 20) {
                return { valid: false, error: 'Invalid Application Secret format' };
            }
            if (!creds.consumer_key || creds.consumer_key.length < 20) {
                return { valid: false, error: 'Invalid Consumer Key format' };
            }
            return { valid: true };
        },
        docs: 'https://api.ovh.com/'
    },
    oracle: {
        id: 'oracle',
        name: 'Oracle Cloud (OCI)',
        description: 'Oracle Cloud Infrastructure',
        color: '#F80000',
        fields: [
            { key: 'tenancy_ocid', label: 'Tenancy OCID', type: 'text', required: true, placeholder: 'ocid1.tenancy.oc1...' },
            { key: 'user_ocid', label: 'User OCID', type: 'text', required: true, placeholder: 'ocid1.user.oc1...' },
            { key: 'fingerprint', label: 'API Key Fingerprint', type: 'text', required: true, placeholder: 'aa:bb:cc:...' },
            { key: 'private_key', label: 'Private Key (PEM)', type: 'textarea', required: true, placeholder: '-----BEGIN RSA PRIVATE KEY-----' },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-ashburn-1', placeholder: 'us-ashburn-1' }
        ],
        // OCI uses signature-based auth, validate key formats
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.tenancy_ocid?.startsWith('ocid1.tenancy.')) {
                return { valid: false, error: 'Tenancy OCID must start with ocid1.tenancy.' };
            }
            if (!creds.user_ocid?.startsWith('ocid1.user.')) {
                return { valid: false, error: 'User OCID must start with ocid1.user.' };
            }
            if (!creds.fingerprint || !/^[a-f0-9:]{47}$/i.test(creds.fingerprint)) {
                return { valid: false, error: 'Invalid fingerprint format (expected aa:bb:cc:...)' };
            }
            if (!creds.private_key?.includes('-----BEGIN')) {
                return { valid: false, error: 'Private key must be in PEM format' };
            }
            return { valid: true };
        },
        docs: 'https://docs.oracle.com/en-us/iaas/api/'
    },
    ibm: {
        id: 'ibm',
        name: 'IBM Cloud',
        description: 'IBM Cloud infrastructure and services',
        color: '#054ADA',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'IBM Cloud API key' },
            { key: 'region', label: 'Region', type: 'text', required: false, default: 'us-south', placeholder: 'us-south' }
        ],
        testEndpoint: 'https://iam.cloud.ibm.com/identity/token',
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        testBody: (creds) => new URLSearchParams({
            grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
            apikey: creds.api_key
        }).toString(),
        docs: 'https://cloud.ibm.com/apidocs'
    },
    alibaba: {
        id: 'alibaba',
        name: 'Alibaba Cloud',
        description: 'Alibaba Cloud (Aliyun) services',
        color: '#FF6A00',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, placeholder: 'LTAI...' },
            { key: 'access_key_secret', label: 'Access Key Secret', type: 'password', required: true, placeholder: 'Your access key secret' },
            { key: 'region', label: 'Region', type: 'text', required: false, default: 'cn-hangzhou', placeholder: 'cn-hangzhou, us-west-1' }
        ],
        // Alibaba uses signature-based auth, validate key formats
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.access_key_id || creds.access_key_id.length < 16) {
                return { valid: false, error: 'Invalid Access Key ID format' };
            }
            if (!creds.access_key_secret || creds.access_key_secret.length < 20) {
                return { valid: false, error: 'Invalid Access Key Secret format' };
            }
            return { valid: true };
        },
        docs: 'https://www.alibabacloud.com/help/'
    },

    // ========================================================================
    // Social Media
    // ========================================================================
    twitter: {
        id: 'twitter',
        name: 'Twitter/X',
        description: 'X (Twitter) API for governed posting and analytics. OAuth 1.0a user context.',
        color: '#1DA1F2',
        category: 'social',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'From the X developer portal, Keys and tokens tab' },
            { key: 'api_secret', label: 'API Key Secret', type: 'password', required: true, placeholder: 'From the X developer portal, Keys and tokens tab' },
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'From the X developer portal, Keys and tokens tab' },
            { key: 'access_secret', label: 'Access Token Secret', type: 'password', required: true, placeholder: 'From the X developer portal, Keys and tokens tab' }
        ],
        testEndpoint: 'https://api.x.com/2/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': buildTwitterOAuth1Header(creds, 'https://api.x.com/2/users/me') }),
        docs: 'https://developer.x.com/en/docs'
    },
    linkedin: {
        id: 'linkedin',
        name: 'LinkedIn',
        description: 'LinkedIn API for profiles and posts',
        color: '#0A66C2',
        // LI-OVERHAUL P5: LinkedIn OAuth access tokens live exactly 60 days
        // and standard apps get no refresh token. Stamped onto expires_at at
        // save/rotate time (db/integrations.js) so the health scanner's
        // expiry warning actually fires for the pasted-token flow.
        tokenLifetimeDays: 60,
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'LinkedIn OAuth access token' }
        ],
        testEndpoint: 'https://api.linkedin.com/v2/userinfo',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://learn.microsoft.com/en-us/linkedin/'
    },
    meta: {
        id: 'meta',
        name: 'Meta (Facebook/Instagram)',
        description: 'Meta Graph API for Facebook and Instagram',
        color: '#1877F2',
        // FB-1: Meta long-lived user/page tokens live about 60 days; stamped
        // at save/rotate like linkedin (db/integrations.js lifetimeExpiryFor).
        tokenLifetimeDays: 60,
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Meta Graph API access token' },
            { key: 'page_id', label: 'Default Page ID', type: 'text', required: false, placeholder: 'Optional: default Facebook Page ID' }
        ],
        testEndpoint: 'https://graph.facebook.com/me',
        testMethod: 'GET',
        testHeaders: () => ({}),
        testParams: (creds) => ({ access_token: creds.access_token }),
        docs: 'https://developers.facebook.com/docs/graph-api/'
    },
    tiktok: {
        id: 'tiktok',
        name: 'TikTok',
        description: 'TikTok API for content, publishing, and analytics',
        color: '#000000',
        // TT-1: TikTok access tokens live exactly 24 hours (86400s,
        // live-verified against developers.tiktok.com); refresh tokens live
        // 365 days and ROTATE on every use of the refresh endpoint. There is
        // no auto-refresh built in this phase (the shared vault write-back
        // machinery that would rotate a stored credential in place is a
        // separate stream, YT-O-2), so the honest contract today is a daily
        // re-paste or manual rotate of access_token. tokenLifetimeDays:1
        // stamps expires_at honestly at that 24h horizon rather than
        // pretending the token outlives it. refresh_token/client_key/
        // client_secret are collected NOW (all required) so the credential
        // already holds what the refresh call needs the day auto-refresh
        // lands — a credential missing refresh_token is dead in 24h with no
        // recovery path, so it is not optional.
        tokenLifetimeDays: 1,
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'TikTok OAuth access token (lives 24 hours)' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'TikTok OAuth refresh token (rotates every refresh; required, or the credential cannot outlive 24 hours)' },
            { key: 'client_key', label: 'Client Key', type: 'text', required: true, placeholder: 'TikTok app client key' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'TikTok app client secret' }
        ],
        testEndpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        validateCredentials: (creds) => {
            if (!creds.access_token || creds.access_token.length < 20) {
                return { valid: false, error: 'Invalid access token format' };
            }
            if (!creds.refresh_token || creds.refresh_token.length < 10) {
                return { valid: false, error: 'Invalid refresh token format' };
            }
            if (!creds.client_key || creds.client_key.length < 10) {
                return { valid: false, error: 'Invalid client key format' };
            }
            if (!creds.client_secret || creds.client_secret.length < 10) {
                return { valid: false, error: 'Invalid client secret format' };
            }
            return { valid: true };
        },
        docs: 'https://developers.tiktok.com/doc/overview/'
    },
    youtube: {
        id: 'youtube',
        name: 'YouTube',
        description: 'YouTube Data API',
        color: '#FF0000',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' },
            { key: 'access_token', label: 'OAuth Access Token', type: 'password', required: false, placeholder: 'Optional OAuth token' }
        ],
        testEndpoint: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        testMethod: 'GET',
        testHeaders: (creds) => creds.access_token
            ? { 'Authorization': `Bearer ${creds.access_token}` }
            : {},
        testParams: (creds) => creds.access_token ? {} : { key: creds.api_key },
        docs: 'https://developers.google.com/youtube/v3'
    },
    pinterest: {
        id: 'pinterest',
        name: 'Pinterest',
        description: 'Pinterest API for pins and boards',
        color: '#E60023',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Pinterest access token' }
        ],
        testEndpoint: 'https://api.pinterest.com/v5/user_account',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.pinterest.com/docs/api/v5/'
    },
    snapchat: {
        id: 'snapchat',
        name: 'Snapchat Marketing',
        description: 'Snapchat Marketing API',
        color: '#FFFC00',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'OAuth refresh token' }
        ],
        // OAuth refresh_token cannot be used as Bearer — validate format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.client_id || creds.client_id.length < 5) return { valid: false, error: 'Invalid Client ID' };
            if (!creds.client_secret || creds.client_secret.length < 5) return { valid: false, error: 'Invalid Client Secret' };
            if (!creds.refresh_token || creds.refresh_token.length < 10) return { valid: false, error: 'Invalid Refresh Token' };
            return { valid: true };
        },
        docs: 'https://developers.snap.com/api/marketing-api/'
    },
    reddit: {
        id: 'reddit',
        name: 'Reddit',
        description: 'Reddit API for posts and comments',
        color: '#FF4500',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'OAuth refresh token' }
        ],
        // OAuth refresh_token cannot be used as Bearer — validate format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.client_id || creds.client_id.length < 5) return { valid: false, error: 'Invalid Client ID' };
            if (!creds.client_secret || creds.client_secret.length < 5) return { valid: false, error: 'Invalid Client Secret' };
            if (!creds.refresh_token || creds.refresh_token.length < 10) return { valid: false, error: 'Invalid Refresh Token' };
            return { valid: true };
        },
        docs: 'https://www.reddit.com/dev/api/'
    },
    tumblr: {
        id: 'tumblr',
        name: 'Tumblr',
        description: 'Tumblr API for posts and blogs',
        color: '#36465D',
        fields: [
            { key: 'consumer_key', label: 'Consumer Key', type: 'text', required: true, placeholder: 'Your consumer key' },
            { key: 'consumer_secret', label: 'Consumer Secret', type: 'password', required: true, placeholder: 'Your consumer secret' },
            { key: 'token', label: 'Token', type: 'password', required: true, placeholder: 'OAuth token' },
            { key: 'token_secret', label: 'Token Secret', type: 'password', required: true, placeholder: 'OAuth token secret' }
        ],
        // Tumblr uses OAuth1, validate credentials format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.consumer_key || creds.consumer_key.length < 10) {
                return { valid: false, error: 'Invalid consumer key format' };
            }
            if (!creds.consumer_secret || creds.consumer_secret.length < 10) {
                return { valid: false, error: 'Invalid consumer secret format' };
            }
            if (!creds.token || creds.token.length < 10) {
                return { valid: false, error: 'Invalid token format' };
            }
            if (!creds.token_secret || creds.token_secret.length < 10) {
                return { valid: false, error: 'Invalid token secret format' };
            }
            return { valid: true };
        },
        docs: 'https://www.tumblr.com/docs/en/api/v2'
    },
    threads: {
        id: 'threads',
        name: 'Threads (Meta)',
        description: 'Threads API (Instagram/Meta)',
        color: '#000000',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Threads access token' }
        ],
        testEndpoint: 'https://graph.threads.net/v1.0/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.facebook.com/docs/threads'
    },
    bluesky: {
        id: 'bluesky',
        name: 'Bluesky',
        description: 'Bluesky/AT Protocol',
        color: '#0085FF',
        fields: [
            { key: 'handle', label: 'Handle', type: 'text', required: true, placeholder: 'yourname.bsky.social' },
            { key: 'app_password', label: 'App Password', type: 'password', required: true, placeholder: 'App password' }
        ],
        testEndpoint: 'https://bsky.social/xrpc/com.atproto.server.createSession',
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/json' }),
        testBody: (creds) => JSON.stringify({ identifier: creds.handle, password: creds.app_password }),
        docs: 'https://docs.bsky.app/'
    },
    mastodon: {
        id: 'mastodon',
        name: 'Mastodon',
        description: 'Mastodon/Fediverse API',
        color: '#6364FF',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' },
            { key: 'instance_url', label: 'Instance URL', type: 'url', required: true, placeholder: 'https://mastodon.social' }
        ],
        testEndpoint: (creds) => {
            const base = creds.instance_url?.replace(/\/$/, '') || 'https://mastodon.social';
            return `${base}/api/v1/accounts/verify_credentials`;
        },
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://docs.joinmastodon.org/api/'
    },

    // ========================================================================
    // Documents & E-Signature
    // ========================================================================
    docusign: {
        id: 'docusign',
        name: 'DocuSign',
        description: 'DocuSign e-signature and agreements',
        color: '#FFCC22',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'DocuSign OAuth access token' },
            { key: 'account_id', label: 'Account ID', type: 'text', required: true, placeholder: 'DocuSign account ID' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: false, default: 'https://demo.docusign.net', placeholder: 'https://demo.docusign.net' }
        ],
        testEndpoint: (creds) => {
            const base = creds.base_url || 'https://demo.docusign.net';
            return `${base.replace(/\/$/, '')}/restapi/v2.1/accounts/${creds.account_id}`;
        },
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.docusign.com/docs/'
    },
    adobesign: {
        id: 'adobesign',
        name: 'Adobe Sign',
        description: 'Adobe Acrobat Sign e-signatures',
        color: '#FA0F00',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Adobe Sign OAuth access token' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: false, default: 'https://api.na1.adobesign.com', placeholder: 'https://api.na1.adobesign.com' }
        ],
        testEndpoint: (creds) => {
            const base = creds.base_url || 'https://api.na1.adobesign.com';
            return `${base.replace(/\/$/, '')}/api/rest/v6/users/me`;
        },
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://www.adobe.io/apis/documentcloud/sign.html'
    },
    adobepdf: {
        id: 'adobepdf',
        name: 'Adobe PDF Services',
        description: 'Adobe PDF creation and manipulation',
        color: '#FA0F00',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Adobe PDF Services client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Client secret' }
        ],
        // Adobe PDF uses OAuth client credentials, validate format
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.client_id || creds.client_id.length < 10) {
                return { valid: false, error: 'Invalid client ID format' };
            }
            if (!creds.client_secret || creds.client_secret.length < 10) {
                return { valid: false, error: 'Invalid client secret format' };
            }
            return { valid: true };
        },
        docs: 'https://developer.adobe.com/document-services/apis/pdf-services/'
    },
    dropboxsign: {
        id: 'dropboxsign',
        name: 'Dropbox Sign',
        description: 'Dropbox Sign (HelloSign) e-signatures',
        color: '#0061FF',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Dropbox Sign API key' }
        ],
        testEndpoint: 'https://api.hellosign.com/v3/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:`).toString('base64')}`
        }),
        docs: 'https://developers.hellosign.com/'
    },
    pandadoc: {
        id: 'pandadoc',
        name: 'PandaDoc',
        description: 'PandaDoc document automation',
        color: '#42B983',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'PandaDoc API key' }
        ],
        testEndpoint: 'https://api.pandadoc.com/public/v1/members/current',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `API-Key ${creds.api_key}` }),
        docs: 'https://developers.pandadoc.com/'
    },

    // ========================================================================
    // Creative & Design
    // ========================================================================
    figma: {
        id: 'figma',
        name: 'Figma',
        description: 'Collaborative design platform',
        color: '#F24E1E',
        fields: [
            { key: 'personal_access_token', label: 'Personal Access Token', type: 'password', required: true, prefix: 'figd_', placeholder: 'figd_...' }
        ],
        testEndpoint: 'https://api.figma.com/v1/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.personal_access_token}` }),
        docs: 'https://www.figma.com/developers/api'
    },
    canva: {
        id: 'canva',
        name: 'Canva',
        description: 'Online design and publishing tool',
        color: '#00C4CC',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Canva API key' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: false, placeholder: 'Only for the connector OAuth refresh flow' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: false, placeholder: 'Only for the connector OAuth refresh flow' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: false, placeholder: 'Only for the connector OAuth refresh flow' }
        ],
        testEndpoint: 'https://api.canva.com/rest/v1/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://www.canva.dev/docs/connect/'
    },
    adobecc: {
        id: 'adobecc',
        name: 'Adobe Creative Cloud',
        description: 'Adobe Creative Cloud APIs',
        color: '#FF0000',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your Adobe client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' },
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'OAuth access token' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: false, placeholder: 'Only for the connector OAuth refresh flow' }
        ],
        testEndpoint: 'https://ims-na1.adobelogin.com/ims/profile/v1',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.adobe.com/creative-cloud-libraries/docs/'
    },
    shutterstock: {
        id: 'shutterstock',
        name: 'Shutterstock',
        description: 'Stock photos, images, and media',
        color: '#EE2B24',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Shutterstock API key' },
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true, placeholder: 'Your API secret' }
        ],
        testEndpoint: 'https://api.shutterstock.com/v2/images/search?query=nature&per_page=1',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64')}`
        }),
        docs: 'https://developers.shutterstock.com/'
    },
    gettyimages: {
        id: 'gettyimages',
        name: 'Getty Images',
        description: 'Premium stock photos and editorial images',
        color: '#000000',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Getty Images API key' }
        ],
        testEndpoint: 'https://api.gettyimages.com/v3/search/images',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Api-Key': creds.api_key }),
        testParams: () => ({ phrase: 'test' }),
        docs: 'https://developers.gettyimages.com/'
    },
    unsplash: {
        id: 'unsplash',
        name: 'Unsplash',
        description: 'Free high-resolution photos',
        color: '#000000',
        fields: [
            { key: 'access_key', label: 'Access Key', type: 'password', required: true, placeholder: 'Your Unsplash access key' }
        ],
        testEndpoint: 'https://api.unsplash.com/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Client-ID ${creds.access_key}` }),
        docs: 'https://unsplash.com/documentation'
    },
    pexels: {
        id: 'pexels',
        name: 'Pexels',
        description: 'Free stock photos and videos',
        color: '#05A081',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Pexels API key' }
        ],
        testEndpoint: 'https://api.pexels.com/v1/curated',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': creds.api_key }),
        docs: 'https://www.pexels.com/api/documentation/'
    },

    // ========================================================================
    // Communication - Email Services
    // ========================================================================
    mailchimp: {
        id: 'mailchimp',
        name: 'Mailchimp',
        description: 'Email marketing and automation',
        color: '#FFE01B',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'xxxxxxxxxxxxxxxx-usX' }
        ],
        // Mailchimp uses datacenter from API key (e.g., key-us21 -> us21.api.mailchimp.com)
        testEndpoint: (creds) => {
            const dc = creds.api_key?.split('-').pop() || 'us1';
            return `https://${dc}.api.mailchimp.com/3.0/`;
        },
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`anystring:${creds.api_key}`).toString('base64')}`
        }),
        docs: 'https://mailchimp.com/developer/marketing/api/'
    },
    mailgun: {
        id: 'mailgun',
        name: 'Mailgun',
        description: 'Email API for developers',
        color: '#F06B66',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'key-xxxxxxxxxxxxxxxx' },
            { key: 'domain', label: 'Domain', type: 'text', required: false, placeholder: 'mg.yourdomain.com' }
        ],
        testEndpoint: 'https://api.mailgun.net/v3/domains',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`api:${creds.api_key}`).toString('base64')}`
        }),
        docs: 'https://documentation.mailgun.com/en/latest/api_reference.html'
    },
    postmark: {
        id: 'postmark',
        name: 'Postmark',
        description: 'Fast transactional email',
        color: '#FFDE00',
        fields: [
            { key: 'server_token', label: 'Server Token', type: 'password', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }
        ],
        testEndpoint: 'https://api.postmarkapp.com/server',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'X-Postmark-Server-Token': creds.server_token,
            'Accept': 'application/json'
        }),
        docs: 'https://postmarkapp.com/developer'
    },
    ses: {
        id: 'ses',
        name: 'Amazon SES',
        description: 'AWS Simple Email Service',
        color: '#FF9900',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true, placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'Your secret key' },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1', placeholder: 'us-east-1' }
        ],
        // SES uses AWS signature auth, validate credentials only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.access_key_id || creds.access_key_id.length < 16) {
                return { valid: false, error: 'Invalid Access Key ID format' };
            }
            if (!creds.secret_access_key || creds.secret_access_key.length < 30) {
                return { valid: false, error: 'Invalid Secret Access Key format' };
            }
            if (!creds.region) {
                return { valid: false, error: 'Region is required' };
            }
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/ses/latest/APIReference/'
    },

    // ========================================================================
    // Communication - SMS/Voice
    // ========================================================================
    vonage: {
        id: 'vonage',
        name: 'Vonage (Nexmo)',
        description: 'Communication APIs for SMS, voice, video',
        color: '#7B00FF',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'text', required: true, placeholder: 'Your API key' },
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true, placeholder: 'Your API secret' }
        ],
        testEndpoint: (creds) => `https://api.nexmo.com/account/get-balance?api_key=${creds.api_key}&api_secret=${creds.api_secret}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://developer.vonage.com/api'
    },
    plivo: {
        id: 'plivo',
        name: 'Plivo',
        description: 'Cloud communications platform',
        color: '#00B16A',
        fields: [
            { key: 'auth_id', label: 'Auth ID', type: 'text', required: true, placeholder: 'Your Auth ID' },
            { key: 'auth_token', label: 'Auth Token', type: 'password', required: true, placeholder: 'Your Auth Token' }
        ],
        testEndpoint: (creds) => `https://api.plivo.com/v1/Account/${creds.auth_id}/`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.auth_id}:${creds.auth_token}`).toString('base64')}`
        }),
        docs: 'https://www.plivo.com/docs/sms/api/'
    },
    messagebird: {
        id: 'messagebird',
        name: 'MessageBird',
        description: 'Omnichannel messaging platform',
        color: '#2481D7',
        fields: [
            { key: 'access_key', label: 'Access Key', type: 'password', required: true, placeholder: 'Your access key' }
        ],
        testEndpoint: 'https://rest.messagebird.com/balance',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `AccessKey ${creds.access_key}` }),
        docs: 'https://developers.messagebird.com/api/'
    },
    bandwidth: {
        id: 'bandwidth',
        name: 'Bandwidth',
        description: 'Enterprise communications APIs',
        color: '#079CEE',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your API token' },
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true, placeholder: 'Your API secret' },
            { key: 'account_id', label: 'Account ID', type: 'text', required: true, placeholder: 'Your account ID' }
        ],
        testEndpoint: (creds) => `https://dashboard.bandwidth.com/api/accounts/${creds.account_id}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_token}:${creds.api_secret}`).toString('base64')}`
        }),
        docs: 'https://dev.bandwidth.com/docs/'
    },

    // ========================================================================
    // Communication - Team Chat
    // ========================================================================
    discord: {
        id: 'discord',
        name: 'Discord Bot',
        description: 'Discord messaging and bot integration',
        color: '#5865F2',
        fields: [
            { key: 'bot_token', label: 'Bot Token', type: 'password', required: true, placeholder: 'Your bot token' }
        ],
        testEndpoint: 'https://discord.com/api/v10/users/@me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bot ${creds.bot_token}` }),
        docs: 'https://discord.com/developers/docs/intro'
    },
    msteams: {
        id: 'msteams',
        name: 'Microsoft Teams',
        description: 'Microsoft Teams integration',
        color: '#6264A7',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Azure AD Application ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' },
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Azure AD Tenant ID' }
        ],
        // MS Teams uses Azure OAuth flow
        testEndpoint: (creds) => `https://login.microsoftonline.com/${creds.tenant_id}/oauth2/v2.0/token`,
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        testBody: (creds) => new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            scope: 'https://graph.microsoft.com/.default'
        }).toString(),
        docs: 'https://learn.microsoft.com/en-us/graph/teams-concept-overview'
    },
    webex: {
        id: 'webex',
        name: 'Cisco Webex',
        description: 'Webex messaging and meetings',
        color: '#00BCF2',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' }
        ],
        testEndpoint: 'https://webexapis.com/v1/people/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.webex.com/docs/api/getting-started'
    },
    zoom: {
        id: 'zoom',
        name: 'Zoom',
        description: 'Zoom meetings and webinars',
        color: '#2D8CFF',
        fields: [
            { key: 'account_id', label: 'Account ID', type: 'text', required: true, placeholder: 'Your account ID' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' }
        ],
        // Zoom Server-to-Server OAuth
        testEndpoint: 'https://zoom.us/oauth/token',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }),
        testBody: (creds) => new URLSearchParams({
            grant_type: 'account_credentials',
            account_id: creds.account_id
        }).toString(),
        docs: 'https://developers.zoom.us/docs/api/'
    },

    // ========================================================================
    // Communication - Push Notifications
    // ========================================================================
    onesignal: {
        id: 'onesignal',
        name: 'OneSignal',
        description: 'Push notifications and in-app messaging',
        color: '#E54B4D',
        fields: [
            { key: 'app_id', label: 'App ID', type: 'text', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
            { key: 'rest_api_key', label: 'REST API Key', type: 'password', required: true, placeholder: 'Your REST API key' }
        ],
        testEndpoint: (creds) => `https://onesignal.com/api/v1/apps/${creds.app_id}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Basic ${creds.rest_api_key}` }),
        docs: 'https://documentation.onesignal.com/reference'
    },
    firebase: {
        id: 'firebase',
        name: 'Firebase Cloud Messaging',
        description: 'Google push notifications service',
        color: '#FFCA28',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: '{"type": "service_account", ...}' }
        ],
        // Firebase uses service account, validate structure like GCP
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            try {
                const json = typeof creds.service_account_json === 'string'
                    ? JSON.parse(creds.service_account_json)
                    : creds.service_account_json;
                const required = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email'];
                const missing = required.filter(key => !json[key]);
                if (missing.length > 0) {
                    return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
                }
                if (json.type !== 'service_account') {
                    return { valid: false, error: 'JSON type must be "service_account"' };
                }
                return { valid: true };
            } catch (e) {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://firebase.google.com/docs/cloud-messaging'
    },
    pusher: {
        id: 'pusher',
        name: 'Pusher',
        description: 'Real-time messaging and notifications',
        color: '#300D4F',
        fields: [
            { key: 'app_id', label: 'App ID', type: 'text', required: true, placeholder: 'Your app ID' },
            { key: 'key', label: 'Key', type: 'text', required: true, placeholder: 'Your app key' },
            { key: 'secret', label: 'Secret', type: 'password', required: true, placeholder: 'Your app secret' },
            { key: 'cluster', label: 'Cluster', type: 'text', required: true, default: 'us2', placeholder: 'us2' }
        ],
        // Pusher uses signed requests, validate credentials only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.app_id || creds.app_id.length < 1) {
                return { valid: false, error: 'App ID is required' };
            }
            if (!creds.key || creds.key.length < 10) {
                return { valid: false, error: 'Invalid key format' };
            }
            if (!creds.secret || creds.secret.length < 10) {
                return { valid: false, error: 'Invalid secret format' };
            }
            if (!creds.cluster) {
                return { valid: false, error: 'Cluster is required' };
            }
            return { valid: true };
        },
        docs: 'https://pusher.com/docs/channels/server_api/overview/'
    },

    // ========================================================================
    // CRM & Sales
    // ========================================================================
    salesforce: {
        id: 'salesforce',
        name: 'Salesforce',
        description: 'Enterprise CRM platform',
        color: '#00A1E0',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your connected app client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'OAuth refresh token' },
            { key: 'instance_url', label: 'Instance URL', type: 'url', required: true, placeholder: 'https://yourorg.salesforce.com' }
        ],
        // OAuth refresh_token cannot be used as Bearer — validate format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.client_id || creds.client_id.length < 10) {
                return { valid: false, error: 'Invalid Client ID format' };
            }
            if (!creds.client_secret || creds.client_secret.length < 10) {
                return { valid: false, error: 'Invalid Client Secret format' };
            }
            if (!creds.refresh_token || creds.refresh_token.length < 20) {
                return { valid: false, error: 'Invalid Refresh Token format' };
            }
            if (!creds.instance_url) {
                return { valid: false, error: 'Instance URL is required' };
            }
            try {
                new URL(creds.instance_url);
            } catch {
                return { valid: false, error: 'Invalid instance URL format' };
            }
            return { valid: true };
        },
        docs: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/'
    },
    hubspot: {
        id: 'hubspot',
        name: 'HubSpot',
        description: 'Marketing, sales, and CRM platform',
        color: '#FF7A59',
        fields: [
            { key: 'private_app_token', label: 'Private App Token', type: 'password', required: true, prefix: 'pat-', placeholder: 'pat-...' }
        ],
        testEndpoint: 'https://api.hubapi.com/crm/v3/objects/contacts',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.private_app_token}` }),
        testParams: () => ({ limit: 1 }),
        docs: 'https://developers.hubspot.com/docs/api/overview'
    },
    pipedrive: {
        id: 'pipedrive',
        name: 'Pipedrive',
        description: 'Sales CRM and pipeline management',
        color: '#017737',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Pipedrive API token' }
        ],
        testEndpoint: (creds) => `https://api.pipedrive.com/v1/users/me?api_token=${creds.api_token}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://developers.pipedrive.com/docs/api/v1'
    },
    zoho_crm: {
        id: 'zoho_crm',
        name: 'Zoho CRM',
        description: 'Cloud-based CRM for businesses',
        color: '#C8202B',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your Zoho client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'OAuth refresh token' }
        ],
        // Zoho requires token exchange, validate format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.client_id || creds.client_id.length < 10) {
                return { valid: false, error: 'Invalid Client ID format' };
            }
            if (!creds.client_secret || creds.client_secret.length < 10) {
                return { valid: false, error: 'Invalid Client Secret format' };
            }
            if (!creds.refresh_token || creds.refresh_token.length < 20) {
                return { valid: false, error: 'Invalid Refresh Token format' };
            }
            return { valid: true };
        },
        docs: 'https://www.zoho.com/crm/developer/docs/api/v5/'
    },
    freshsales: {
        id: 'freshsales',
        name: 'Freshsales',
        description: 'Freshworks CRM for sales teams',
        color: '#F36C3D',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Freshsales API key' },
            { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'yourcompany' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}.myfreshworks.com/crm/sales/api/contacts/view`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token token=${creds.api_key}` }),
        testParams: () => ({ page: 1, per_page: 1 }),
        docs: 'https://developers.freshworks.com/crm/api/'
    },
    copper: {
        id: 'copper',
        name: 'Copper',
        description: 'CRM for Google Workspace',
        color: '#4A154B',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Copper API key' },
            { key: 'email', label: 'User Email', type: 'text', required: true, placeholder: 'your@email.com' }
        ],
        testEndpoint: 'https://api.copper.com/developer_api/v1/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'X-PW-AccessToken': creds.api_key,
            'X-PW-UserEmail': creds.email,
            'X-PW-Application': 'developer_api',
            'Content-Type': 'application/json'
        }),
        docs: 'https://developer.copper.com/'
    },
    close: {
        id: 'close',
        name: 'Close',
        description: 'Sales CRM for startups and SMBs',
        color: '#1463FF',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Close API key' }
        ],
        testEndpoint: 'https://api.close.com/api/v1/me/',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:`).toString('base64')}`
        }),
        docs: 'https://developer.close.com/'
    },
    monday: {
        id: 'monday',
        name: 'Monday.com',
        description: 'Work OS and CRM platform',
        color: '#FF3D57',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your monday.com API token' }
        ],
        testEndpoint: 'https://api.monday.com/v2',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.api_token}`,
            'Content-Type': 'application/json'
        }),
        testBody: { query: '{ me { id name } }' },
        docs: 'https://developer.monday.com/api-reference/docs'
    },

    // ========================================================================
    // Support & Helpdesk
    // ========================================================================
    zendesk: {
        id: 'zendesk',
        name: 'Zendesk',
        description: 'Customer service and support platform',
        color: '#03363D',
        fields: [
            { key: 'subdomain', label: 'Subdomain', type: 'text', required: true, placeholder: 'yourcompany' },
            { key: 'email', label: 'Email', type: 'text', required: true, placeholder: 'admin@yourcompany.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Zendesk API token' }
        ],
        testEndpoint: (creds) => `https://${creds.subdomain}.zendesk.com/api/v2/users/me`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.email}/token:${creds.api_token}`).toString('base64')}`
        }),
        docs: 'https://developer.zendesk.com/api-reference/'
    },
    freshdesk: {
        id: 'freshdesk',
        name: 'Freshdesk',
        description: 'Helpdesk and ticketing system',
        color: '#22C55E',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Freshdesk API key' },
            { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'yourcompany' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}.freshdesk.com/api/v2/tickets`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:X`).toString('base64')}`
        }),
        testParams: () => ({ per_page: 1 }),
        docs: 'https://developers.freshdesk.com/api/'
    },
    helpscout: {
        id: 'helpscout',
        name: 'Help Scout',
        description: 'Customer service software',
        color: '#1292EE',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Help Scout API key' },
            { key: 'client_id', label: 'App ID', type: 'text', required: false, placeholder: 'Only for the connector OAuth client-credentials flow' },
            { key: 'client_secret', label: 'App Secret', type: 'password', required: false, placeholder: 'Only for the connector OAuth client-credentials flow' }
        ],
        testEndpoint: 'https://api.helpscout.net/v2/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developer.helpscout.com/'
    },
    front: {
        id: 'front',
        name: 'Front',
        description: 'Shared inbox and customer communication',
        color: '#001B38',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Front API token' }
        ],
        testEndpoint: 'https://api2.frontapp.com/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://dev.frontapp.com/docs/getting-started'
    },

    // ========================================================================
    // E-Commerce - Payment Processors
    // ========================================================================
    paypal: {
        id: 'paypal',
        name: 'PayPal',
        description: 'Online payments and checkout',
        color: '#003087',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your PayPal client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your PayPal client secret' }
        ],
        testEndpoint: 'https://api-m.paypal.com/v1/oauth2/token',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }),
        testBody: 'grant_type=client_credentials',
        docs: 'https://developer.paypal.com/docs/api/overview/'
    },
    square: {
        id: 'square',
        name: 'Square',
        description: 'Payment processing and POS',
        color: '#006AFF',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Square access token' }
        ],
        testEndpoint: 'https://connect.squareup.com/v2/merchants',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.squareup.com/docs'
    },
    braintree: {
        id: 'braintree',
        name: 'Braintree',
        description: 'Full-stack payment platform',
        color: '#003366',
        fields: [
            { key: 'merchant_id', label: 'Merchant ID', type: 'text', required: true, placeholder: 'Your Braintree merchant ID' },
            { key: 'public_key', label: 'Public Key', type: 'text', required: true, placeholder: 'Your public key' },
            { key: 'private_key', label: 'Private Key', type: 'password', required: true, placeholder: 'Your private key' }
        ],
        // Braintree uses SDK-based auth, validate credentials format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.merchant_id || creds.merchant_id.length < 5) {
                return { valid: false, error: 'Invalid Merchant ID format' };
            }
            if (!creds.public_key || creds.public_key.length < 5) {
                return { valid: false, error: 'Invalid Public Key format' };
            }
            if (!creds.private_key || creds.private_key.length < 10) {
                return { valid: false, error: 'Invalid Private Key format' };
            }
            return { valid: true };
        },
        docs: 'https://developer.paypal.com/braintree/docs'
    },
    adyen: {
        id: 'adyen',
        name: 'Adyen',
        description: 'Global payment platform',
        color: '#0ABF53',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Adyen API key' },
            { key: 'merchant_account', label: 'Merchant Account', type: 'text', required: true, placeholder: 'Your merchant account name' }
        ],
        testEndpoint: 'https://checkout-test.adyen.com/v71/paymentMethods',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'x-API-key': creds.api_key,
            'Content-Type': 'application/json'
        }),
        testBody: (creds) => JSON.stringify({ merchantAccount: creds.merchant_account }),
        docs: 'https://docs.adyen.com/api-explorer/'
    },
    klarna: {
        id: 'klarna',
        name: 'Klarna',
        description: 'Buy now, pay later solutions',
        color: '#FFB3C7',
        fields: [
            { key: 'api_key', label: 'API Key (Base64)', type: 'password', required: true, placeholder: 'Base64 encoded username:password' }
        ],
        testEndpoint: 'https://api.klarna.com/payments/v1/sessions',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Basic ${creds.api_key}` }),
        docs: 'https://docs.klarna.com/'
    },

    // ========================================================================
    // E-Commerce - Platforms
    // ========================================================================
    shopify: {
        id: 'shopify',
        name: 'Shopify',
        description: 'E-commerce platform',
        color: '#96BF48',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, prefix: 'shpat_', placeholder: 'shpat_...' },
            { key: 'shop_domain', label: 'Shop Domain', type: 'text', required: true, placeholder: 'your-store.myshopify.com' }
        ],
        testEndpoint: (creds) => `https://${creds.shop_domain}/admin/api/2025-01/shop.json`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-Shopify-Access-Token': creds.access_token }),
        docs: 'https://shopify.dev/docs/api'
    },
    woocommerce: {
        id: 'woocommerce',
        name: 'WooCommerce',
        description: 'WordPress e-commerce plugin',
        color: '#96588A',
        fields: [
            { key: 'consumer_key', label: 'Consumer Key', type: 'text', required: true, prefix: 'ck_', placeholder: 'ck_...' },
            { key: 'consumer_secret', label: 'Consumer Secret', type: 'password', required: true, prefix: 'cs_', placeholder: 'cs_...' },
            { key: 'store_url', label: 'Store URL', type: 'url', required: true, placeholder: 'https://your-store.com' }
        ],
        testEndpoint: (creds) => `${creds.store_url.replace(/\/$/, '')}/wp-json/wc/v3/system_status`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.consumer_key}:${creds.consumer_secret}`).toString('base64')}`
        }),
        docs: 'https://woocommerce.github.io/woocommerce-rest-api-docs/'
    },
    bigcommerce: {
        id: 'bigcommerce',
        name: 'BigCommerce',
        description: 'Enterprise e-commerce platform',
        color: '#121118',
        fields: [
            { key: 'store_hash', label: 'Store Hash', type: 'text', required: true, placeholder: 'Your store hash' },
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' }
        ],
        testEndpoint: (creds) => `https://api.bigcommerce.com/stores/${creds.store_hash}/v2/store`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-Auth-Token': creds.access_token }),
        docs: 'https://developer.bigcommerce.com/docs/rest'
    },
    magento: {
        id: 'magento',
        name: 'Adobe Commerce (Magento)',
        description: 'Enterprise e-commerce platform',
        color: '#EE672F',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your integration access token' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://your-store.com' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/rest/V1/store/storeConfigs`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.adobe.com/commerce/webapi/'
    },
    wix: {
        id: 'wix',
        name: 'Wix',
        description: 'Website builder and e-commerce',
        color: '#000000',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Wix API key' },
            { key: 'site_id', label: 'Site ID', type: 'text', required: true, placeholder: 'Your Wix site ID' }
        ],
        testEndpoint: 'https://www.wixapis.com/site-list/v2/sites',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': creds.api_key }),
        docs: 'https://dev.wix.com/docs/rest'
    },
    etsy: {
        id: 'etsy',
        name: 'Etsy',
        description: 'Handmade and vintage marketplace',
        color: '#F45800',
        fields: [
            { key: 'api_key', label: 'API Key (Keystring)', type: 'text', required: true, placeholder: 'Your Etsy API keystring' },
            { key: 'oauth_token', label: 'OAuth Token', type: 'password', required: true, placeholder: 'Your OAuth access token' }
        ],
        testEndpoint: 'https://openapi.etsy.com/v3/application/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'x-api-key': creds.api_key,
            'Authorization': `Bearer ${creds.oauth_token}`
        }),
        docs: 'https://developers.etsy.com/documentation/'
    },
    amazon_sp: {
        id: 'amazon_sp',
        name: 'Amazon Selling Partner',
        description: 'Amazon marketplace API',
        color: '#FF9900',
        fields: [
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'Your LWA refresh token' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your LWA client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your LWA client secret' },
            { key: 'aws_access_key', label: 'AWS Access Key', type: 'text', required: true, placeholder: 'AKIA...' },
            { key: 'aws_secret_key', label: 'AWS Secret Key', type: 'password', required: true, placeholder: 'Your AWS secret key' },
            { key: 'aws_role_arn', label: 'IAM Role ARN', type: 'text', required: false, placeholder: 'arn:aws:iam::...' }
        ],
        // Amazon SP-API uses complex signature-based auth, validate credentials format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.refresh_token || creds.refresh_token.length < 20) {
                return { valid: false, error: 'Invalid refresh token format' };
            }
            if (!creds.client_id || creds.client_id.length < 10) {
                return { valid: false, error: 'Invalid client ID format' };
            }
            if (!creds.client_secret || creds.client_secret.length < 10) {
                return { valid: false, error: 'Invalid client secret format' };
            }
            if (!creds.aws_access_key || !creds.aws_access_key.startsWith('AKIA')) {
                return { valid: false, error: 'Invalid AWS Access Key format (should start with AKIA)' };
            }
            if (!creds.aws_secret_key || creds.aws_secret_key.length < 30) {
                return { valid: false, error: 'Invalid AWS Secret Key format' };
            }
            return { valid: true };
        },
        docs: 'https://developer-docs.amazon.com/sp-api/'
    },

    // ========================================================================
    // Data & Analytics
    // ========================================================================
    snowflake: {
        id: 'snowflake',
        name: 'Snowflake',
        description: 'Cloud data warehouse',
        color: '#29B5E8',
        fields: [
            { key: 'account_identifier', label: 'Account Identifier', type: 'text', required: true, placeholder: 'xy12345.us-east-1' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Your username' },
            { key: 'password', label: 'Password', type: 'password', required: false, placeholder: 'Your password' },
            { key: 'private_key', label: 'Private Key', type: 'textarea', required: false, placeholder: '-----BEGIN PRIVATE KEY-----' }
        ],
        // Snowflake requires SDK for connection, validate credentials format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.account_identifier || creds.account_identifier.length < 5) {
                return { valid: false, error: 'Invalid account identifier format' };
            }
            if (!creds.username || creds.username.length < 1) {
                return { valid: false, error: 'Username is required' };
            }
            if (!creds.password && !creds.private_key) {
                return { valid: false, error: 'Either password or private key is required' };
            }
            if (creds.private_key && !creds.private_key.includes('PRIVATE KEY')) {
                return { valid: false, error: 'Invalid private key format' };
            }
            return { valid: true };
        },
        docs: 'https://docs.snowflake.com/'
    },
    databricks: {
        id: 'databricks',
        name: 'Databricks',
        description: 'Unified analytics platform',
        color: '#FF3621',
        fields: [
            { key: 'host', label: 'Workspace URL', type: 'url', required: true, placeholder: 'https://dbc-12345678-abcd.cloud.databricks.com' },
            { key: 'token', label: 'Access Token', type: 'password', required: true, prefix: 'dapi', placeholder: 'dapi...' }
        ],
        testEndpoint: (creds) => `${creds.host.replace(/\/$/, '')}/api/2.0/clusters/list`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://docs.databricks.com/'
    },
    bigquery: {
        id: 'bigquery',
        name: 'Google BigQuery',
        description: 'Serverless data warehouse',
        color: '#4285F4',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: '{ "type": "service_account", ... }' }
        ],
        // BigQuery uses GCP SDK, validate JSON format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.service_account_json) {
                return { valid: false, error: 'Service account JSON is required' };
            }
            try {
                const parsed = JSON.parse(creds.service_account_json);
                if (parsed.type !== 'service_account') {
                    return { valid: false, error: 'JSON must be a service account key (type: "service_account")' };
                }
                if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
                    return { valid: false, error: 'Missing required fields in service account JSON' };
                }
            } catch {
                return { valid: false, error: 'Invalid JSON format' };
            }
            return { valid: true };
        },
        docs: 'https://cloud.google.com/bigquery/docs'
    },
    mongodb: {
        id: 'mongodb',
        name: 'MongoDB Atlas',
        description: 'Document database as a service',
        color: '#47A248',
        fields: [
            { key: 'connection_string', label: 'Connection String', type: 'password', required: true, prefix: 'mongodb+srv://', placeholder: 'mongodb+srv://user:password@cluster.mongodb.net/database' }
        ],
        // MongoDB requires driver for connection, validate connection string format
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.connection_string) {
                return { valid: false, error: 'Connection string is required' };
            }
            if (!creds.connection_string.startsWith('mongodb+srv://') && !creds.connection_string.startsWith('mongodb://')) {
                return { valid: false, error: 'Connection string must start with mongodb+srv:// or mongodb://' };
            }
            // Basic format validation
            if (!creds.connection_string.includes('@')) {
                return { valid: false, error: 'Connection string must include credentials (user:password@host)' };
            }
            return { valid: true };
        },
        docs: 'https://www.mongodb.com/docs/atlas/'
    },
    postgresql: {
        id: 'postgresql',
        name: 'PostgreSQL',
        description: 'Open source relational database',
        color: '#336791',
        fields: [
            { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.example.com' },
            { key: 'port', label: 'Port', type: 'number', required: true, default: '5432', placeholder: '5432' },
            { key: 'database', label: 'Database', type: 'text', required: true, placeholder: 'mydb' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'postgres' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your password' }
        ],
        // PostgreSQL requires driver for connection, validate credentials format
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.host || creds.host.length < 1) {
                return { valid: false, error: 'Host is required' };
            }
            if (!creds.port || isNaN(parseInt(creds.port))) {
                return { valid: false, error: 'Valid port number is required' };
            }
            if (!creds.database || creds.database.length < 1) {
                return { valid: false, error: 'Database name is required' };
            }
            if (!creds.username || creds.username.length < 1) {
                return { valid: false, error: 'Username is required' };
            }
            if (!creds.password || creds.password.length < 1) {
                return { valid: false, error: 'Password is required' };
            }
            return { valid: true };
        },
        docs: 'https://www.postgresql.org/docs/'
    },
    redis: {
        id: 'redis',
        name: 'Redis',
        description: 'In-memory data store',
        color: '#DC382D',
        fields: [
            { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'redis.example.com' },
            { key: 'port', label: 'Port', type: 'number', required: true, default: '6379', placeholder: '6379' },
            { key: 'password', label: 'Password', type: 'password', required: false, placeholder: 'Your password (optional)' },
            { key: 'tls', label: 'Use TLS', type: 'boolean', required: false, default: false }
        ],
        // Redis requires driver for connection, validate credentials format
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.host || creds.host.length < 1) {
                return { valid: false, error: 'Host is required' };
            }
            if (!creds.port || isNaN(parseInt(creds.port))) {
                return { valid: false, error: 'Valid port number is required' };
            }
            return { valid: true };
        },
        docs: 'https://redis.io/docs/'
    },
    elasticsearch: {
        id: 'elasticsearch',
        name: 'Elasticsearch',
        description: 'Distributed search and analytics',
        color: '#FEC514',
        fields: [
            { key: 'cloud_id', label: 'Cloud ID', type: 'text', required: false, placeholder: 'my-deployment:dXMtY2VudHJhbDEuZ2Nw...' },
            { key: 'host', label: 'Host URL', type: 'url', required: false, placeholder: 'https://localhost:9200' },
            { key: 'api_key', label: 'API Key', type: 'password', required: false, placeholder: 'Your API key' },
            { key: 'username', label: 'Username', type: 'text', required: false, placeholder: 'elastic' },
            { key: 'password', label: 'Password', type: 'password', required: false, placeholder: 'Your password' }
        ],
        testEndpoint: (creds) => {
            if (creds.host) {
                return `${creds.host.replace(/\/$/, '')}/_cluster/health`;
            }
            return null;
        },
        testMethod: 'GET',
        testHeaders: (creds) => {
            if (creds.api_key) {
                return { 'Authorization': `ApiKey ${creds.api_key}` };
            } else if (creds.username && creds.password) {
                const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
                return { 'Authorization': `Basic ${auth}` };
            }
            return {};
        },
        validateCredentials: (creds) => {
            if (!creds.cloud_id && !creds.host) {
                return { valid: false, error: 'Either Cloud ID or Host URL is required' };
            }
            if (!creds.api_key && !(creds.username && creds.password)) {
                return { valid: false, error: 'Either API Key or Username/Password is required' };
            }
            return { valid: true };
        },
        docs: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/'
    },
    tableau: {
        id: 'tableau',
        name: 'Tableau',
        description: 'Business intelligence and analytics',
        color: '#E97627',
        fields: [
            { key: 'server_url', label: 'Server URL', type: 'url', required: true, placeholder: 'https://your-server.online.tableau.com' },
            { key: 'site_id', label: 'Site ID', type: 'text', required: true, placeholder: 'your-site-id' },
            { key: 'token_name', label: 'Token Name', type: 'text', required: true, placeholder: 'my-token' },
            { key: 'token_value', label: 'Token Value', type: 'password', required: true, placeholder: 'Your token value' }
        ],
        testEndpoint: (creds) => `${creds.server_url.replace(/\/$/, '')}/api/3.21/auth/signin`,
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/json' }),
        testBody: (creds) => ({
            credentials: {
                personalAccessTokenName: creds.token_name,
                personalAccessTokenSecret: creds.token_value,
                site: { contentUrl: creds.site_id }
            }
        }),
        docs: 'https://help.tableau.com/current/api/rest_api/en-us/'
    },
    looker: {
        id: 'looker',
        name: 'Looker (Google)',
        description: 'Business intelligence platform',
        color: '#4285F4',
        fields: [
            { key: 'base_url', label: 'Instance URL', type: 'url', required: true, placeholder: 'https://your-instance.looker.com' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your client secret' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/4.0/login`,
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        testBodyForm: (creds) => `client_id=${encodeURIComponent(creds.client_id)}&client_secret=${encodeURIComponent(creds.client_secret)}`,
        docs: 'https://cloud.google.com/looker/docs/api-reference'
    },

    // =========================================================================
    // Security & Identity
    // =========================================================================

    okta: {
        id: 'okta',
        name: 'Okta',
        description: 'Identity and access management',
        color: '#007DC1',
        fields: [
            { key: 'domain', label: 'Okta Domain', type: 'text', required: true, placeholder: 'dev-123456.okta.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Okta API token' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}/api/v1/users/me`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `SSWS ${creds.api_token}` }),
        docs: 'https://developer.okta.com/docs/reference/'
    },
    auth0: {
        id: 'auth0',
        name: 'Auth0',
        description: 'Authentication and authorization platform',
        color: '#EB5424',
        fields: [
            { key: 'domain', label: 'Auth0 Domain', type: 'text', required: true, placeholder: 'your-tenant.auth0.com' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your application Client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your application Client Secret' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}/oauth/token`,
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/json' }),
        testBody: (creds) => ({
            grant_type: 'client_credentials',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            audience: `https://${creds.domain}/api/v2/`
        }),
        docs: 'https://auth0.com/docs/api'
    },
    onelogin: {
        id: 'onelogin',
        name: 'OneLogin',
        description: 'Identity and access management',
        color: '#000000',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your API client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your API client secret' },
            { key: 'region', label: 'Region', type: 'select', required: true, options: [{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }] }
        ],
        testEndpoint: (creds) => `https://api.${creds.region}.onelogin.com/auth/oauth2/v2/token`,
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }),
        testBodyRaw: 'grant_type=client_credentials',
        docs: 'https://developers.onelogin.com/api-docs/2/getting-started/dev-overview'
    },
    crowdstrike: {
        id: 'crowdstrike',
        name: 'CrowdStrike',
        description: 'Endpoint security and threat intelligence',
        color: '#FC0000',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your API client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your API client secret' }
        ],
        testEndpoint: 'https://api.crowdstrike.com/oauth2/token',
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        testBodyRaw: (creds) => `client_id=${encodeURIComponent(creds.client_id)}&client_secret=${encodeURIComponent(creds.client_secret)}`,
        docs: 'https://falcon.crowdstrike.com/documentation/'
    },
    snyk: {
        id: 'snyk',
        name: 'Snyk',
        description: 'Security scanning and vulnerability management',
        color: '#4C4A73',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Snyk API token' }
        ],
        testEndpoint: 'https://api.snyk.io/v1/user/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `token ${creds.api_token}` }),
        docs: 'https://docs.snyk.io/snyk-api'
    },
    vault: {
        id: 'vault',
        name: 'HashiCorp Vault',
        description: 'Secrets management and data protection',
        color: '#000000',
        fields: [
            { key: 'address', label: 'Vault Address', type: 'url', required: true, placeholder: 'https://vault.example.com:8200' },
            { key: 'token', label: 'Vault Token', type: 'password', required: false, placeholder: 'hvs.xxx...' },
            { key: 'role_id', label: 'AppRole Role ID', type: 'text', required: false, placeholder: 'Role ID for AppRole auth' },
            { key: 'secret_id', label: 'AppRole Secret ID', type: 'password', required: false, placeholder: 'Secret ID for AppRole auth' }
        ],
        testEndpoint: (creds) => `${creds.address.replace(/\/$/, '')}/v1/sys/health`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.token ? ({ 'X-Vault-Token': creds.token }) : ({}),
        validateCredentials: (creds) => {
            if (!creds.token && (!creds.role_id || !creds.secret_id)) {
                return { valid: false, error: 'Either Vault Token or both AppRole Role ID and Secret ID are required' };
            }
            return { valid: true };
        },
        docs: 'https://developer.hashicorp.com/vault/api-docs'
    },
    '1password': {
        id: '1password',
        name: '1Password Connect',
        description: 'Password and secrets management',
        color: '#0094F5',
        fields: [
            { key: 'connect_host', label: 'Connect Server Host', type: 'url', required: true, placeholder: 'http://localhost:8080' },
            { key: 'connect_token', label: 'Connect Token', type: 'password', required: true, placeholder: 'Your 1Password Connect token' }
        ],
        testEndpoint: (creds) => `${creds.connect_host.replace(/\/$/, '')}/v1/vaults`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.connect_token}` }),
        docs: 'https://developer.1password.com/docs/connect/'
    },

    // ========================================================================
    // DevOps & Observability
    // ========================================================================
    newrelic: {
        id: 'newrelic',
        name: 'New Relic',
        description: 'Full-stack observability platform',
        color: '#008C99',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'NRAK-', placeholder: 'NRAK-...' }
        ],
        testEndpoint: 'https://api.newrelic.com/graphql',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'API-Key': creds.api_key,
            'Content-Type': 'application/json'
        }),
        testBody: { query: '{ actor { user { name } } }' },
        docs: 'https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/'
    },
    splunk: {
        id: 'splunk',
        name: 'Splunk',
        description: 'Log management and SIEM platform',
        color: '#000000',
        fields: [
            { key: 'base_url', label: 'Splunk URL', type: 'url', required: true, placeholder: 'https://your-splunk-instance:8089' },
            { key: 'token', label: 'Auth Token', type: 'password', required: true, placeholder: 'Your Splunk auth token' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/services/authentication/current-context`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTprolog'
    },
    sentry: {
        id: 'sentry',
        name: 'Sentry',
        description: 'Error tracking and performance monitoring',
        color: '#362D59',
        fields: [
            { key: 'auth_token', label: 'Auth Token', type: 'password', required: true, placeholder: 'Your Sentry auth token' }
        ],
        testEndpoint: 'https://sentry.io/api/0/projects/',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.auth_token}` }),
        docs: 'https://docs.sentry.io/api/'
    },
    pagerduty: {
        id: 'pagerduty',
        name: 'PagerDuty',
        description: 'Incident management and alerting',
        color: '#06AC38',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your PagerDuty API key' }
        ],
        testEndpoint: 'https://api.pagerduty.com/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token token=${creds.api_key}` }),
        docs: 'https://developer.pagerduty.com/api-reference/'
    },
    opsgenie: {
        id: 'opsgenie',
        name: 'OpsGenie',
        description: 'Alert and incident management',
        color: '#172B4D',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your OpsGenie API key' }
        ],
        testEndpoint: 'https://api.opsgenie.com/v2/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `GenieKey ${creds.api_key}` }),
        docs: 'https://docs.opsgenie.com/docs/api-overview'
    },
    prometheus: {
        id: 'prometheus',
        name: 'Prometheus',
        description: 'Metrics monitoring and alerting',
        color: '#E6522C',
        fields: [
            { key: 'base_url', label: 'Prometheus URL', type: 'url', required: true, placeholder: 'http://prometheus:9090' },
            { key: 'username', label: 'Username', type: 'text', required: false, placeholder: 'Optional basic auth username' },
            { key: 'password', label: 'Password', type: 'password', required: false, placeholder: 'Optional basic auth password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v1/status/config`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            if (creds.username && creds.password) {
                const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
                return { 'Authorization': `Basic ${auth}` };
            }
            return {};
        },
        docs: 'https://prometheus.io/docs/prometheus/latest/querying/api/'
    },
    launchdarkly: {
        id: 'launchdarkly',
        name: 'LaunchDarkly',
        description: 'Feature flag management',
        color: '#405BFF',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your LaunchDarkly API key' }
        ],
        testEndpoint: 'https://app.launchdarkly.com/api/v2/projects',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': creds.api_key }),
        docs: 'https://apidocs.launchdarkly.com/'
    },
    terraform: {
        id: 'terraform',
        name: 'Terraform Cloud',
        description: 'Infrastructure as code platform',
        color: '#7B42BC',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Terraform Cloud API token' }
        ],
        testEndpoint: 'https://app.terraform.io/api/v2/account/details',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://developer.hashicorp.com/terraform/cloud-docs/api-docs'
    },

    // ========================================================================
    // HR & Recruiting
    // ========================================================================
    workday: {
        id: 'workday',
        name: 'Workday',
        description: 'Enterprise HR and finance platform',
        color: '#0875E1',
        fields: [
            { key: 'tenant', label: 'Tenant', type: 'text', required: true, placeholder: 'Your Workday tenant name' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'OAuth client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'OAuth client secret' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'OAuth refresh token' }
        ],
        // Workday uses complex OAuth flow, validate credentials format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.tenant || creds.tenant.length < 2) {
                return { valid: false, error: 'Invalid tenant format' };
            }
            if (!creds.client_id || creds.client_id.length < 10) {
                return { valid: false, error: 'Invalid client ID format' };
            }
            if (!creds.client_secret || creds.client_secret.length < 10) {
                return { valid: false, error: 'Invalid client secret format' };
            }
            if (!creds.refresh_token || creds.refresh_token.length < 20) {
                return { valid: false, error: 'Invalid refresh token format' };
            }
            return { valid: true };
        },
        docs: 'https://community.workday.com/sites/default/files/file-hosting/restapi/'
    },
    bamboohr: {
        id: 'bamboohr',
        name: 'BambooHR',
        description: 'HR software for small and medium businesses',
        color: '#73C41D',
        fields: [
            { key: 'subdomain', label: 'Subdomain', type: 'text', required: true, placeholder: 'yourcompany' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your BambooHR API key' }
        ],
        testEndpoint: (creds) => `https://api.bamboohr.com/api/gateway.php/${creds.subdomain}/v1/employees/directory`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:x`).toString('base64')}`
        }),
        docs: 'https://documentation.bamboohr.com/reference'
    },
    greenhouse: {
        id: 'greenhouse',
        name: 'Greenhouse',
        description: 'Applicant tracking and recruiting',
        color: '#24A47F',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Greenhouse API key' }
        ],
        testEndpoint: 'https://harvest.greenhouse.io/v1/users',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:`).toString('base64')}`
        }),
        docs: 'https://developers.greenhouse.io/harvest.html'
    },
    lever: {
        id: 'lever',
        name: 'Lever',
        description: 'Recruiting software and ATS',
        color: '#1F3037',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Lever API key' }
        ],
        testEndpoint: 'https://api.lever.co/v1/users',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:`).toString('base64')}`
        }),
        docs: 'https://hire.lever.co/developer/documentation'
    },
    adp: {
        id: 'adp',
        name: 'ADP',
        description: 'Payroll and HR management',
        color: '#ED1C24',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your ADP client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Your ADP client secret' },
            { key: 'cert', label: 'SSL Certificate', type: 'textarea', required: true, placeholder: '-----BEGIN CERTIFICATE-----' },
            { key: 'key', label: 'Private Key', type: 'textarea', required: true, placeholder: '-----BEGIN PRIVATE KEY-----' }
        ],
        // ADP requires certificate-based auth, validate credentials format only
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.client_id || creds.client_id.length < 10) {
                return { valid: false, error: 'Invalid client ID format' };
            }
            if (!creds.client_secret || creds.client_secret.length < 10) {
                return { valid: false, error: 'Invalid client secret format' };
            }
            if (!creds.cert || !creds.cert.includes('CERTIFICATE')) {
                return { valid: false, error: 'Certificate must be in PEM format' };
            }
            if (!creds.key || !creds.key.includes('PRIVATE KEY')) {
                return { valid: false, error: 'Private key must be in PEM format' };
            }
            return { valid: true };
        },
        docs: 'https://developers.adp.com/'
    },
    gusto: {
        id: 'gusto',
        name: 'Gusto',
        description: 'Payroll, benefits, and HR',
        color: '#F45D48',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your Gusto access token' }
        ],
        testEndpoint: 'https://api.gusto.com/v1/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://docs.gusto.com/app-integrations/reference'
    },

    // ========================================================================
    // Project Management
    // ========================================================================
    asana: {
        id: 'asana',
        name: 'Asana',
        description: 'Work management and team collaboration',
        color: '#F06A6A',
        fields: [
            { key: 'access_token', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'Your Asana PAT' }
        ],
        testEndpoint: 'https://app.asana.com/api/1.0/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.asana.com/docs'
    },
    trello: {
        id: 'trello',
        name: 'Trello',
        description: 'Visual project boards and collaboration',
        color: '#0052CC',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'text', required: true, placeholder: 'Your Trello API key' },
            { key: 'token', label: 'Token', type: 'password', required: true, placeholder: 'Your Trello token' }
        ],
        testEndpoint: (creds) => `https://api.trello.com/1/members/me?key=${creds.api_key}&token=${creds.token}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://developer.atlassian.com/cloud/trello/'
    },
    clickup: {
        id: 'clickup',
        name: 'ClickUp',
        description: 'All-in-one productivity platform',
        color: '#7B68EE',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your ClickUp API key' }
        ],
        testEndpoint: 'https://api.clickup.com/api/v2/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': creds.api_key }),
        docs: 'https://clickup.com/api'
    },
    confluence: {
        id: 'confluence',
        name: 'Confluence',
        description: 'Team wiki and documentation',
        color: '#172B4D',
        fields: [
            { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'yourcompany.atlassian.net' },
            { key: 'email', label: 'Email', type: 'text', required: true, placeholder: 'your@email.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Atlassian API token' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}/wiki/rest/api/user/current`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64')}`
        }),
        docs: 'https://developer.atlassian.com/cloud/confluence/rest/v1/'
    },

    // ========================================================================
    // Productivity
    // ========================================================================
    dropbox: {
        id: 'dropbox',
        name: 'Dropbox',
        description: 'Cloud file storage and sharing',
        color: '#0061FF',
        category: 'productivity',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, prefix: 'sl.', placeholder: 'sl....' }
        ],
        testEndpoint: 'https://api.dropboxapi.com/2/users/get_current_account',
        testMethod: 'POST',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://www.dropbox.com/developers/documentation'
    },
    box: {
        id: 'box',
        name: 'Box',
        description: 'Cloud content management and file sharing',
        color: '#0061D5',
        category: 'productivity',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' }
        ],
        testEndpoint: 'https://api.box.com/2.0/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.box.com/reference/'
    },
    googledrive: {
        id: 'googledrive',
        name: 'Google Drive',
        description: 'Cloud storage and collaboration',
        color: '#4285F4',
        category: 'productivity',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: false, placeholder: '{"type": "service_account", ...}' },
            { key: 'oauth_token', label: 'OAuth Token', type: 'password', required: false, placeholder: 'Your OAuth access token' }
        ],
        testEndpoint: 'https://www.googleapis.com/drive/v3/about?fields=user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.oauth_token}` }),
        validateCredentials: (creds) => {
            if (!creds.service_account_json && !creds.oauth_token) {
                return { valid: false, error: 'Either Service Account JSON or OAuth Token is required' };
            }
            return { valid: true };
        },
        docs: 'https://developers.google.com/drive/api'
    },
    calendly: {
        id: 'calendly',
        name: 'Calendly',
        description: 'Scheduling and appointment booking',
        color: '#006BFF',
        category: 'productivity',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.calendly.com/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developer.calendly.com/'
    },
    typeform: {
        id: 'typeform',
        name: 'Typeform',
        description: 'Interactive forms and surveys',
        color: '#262627',
        category: 'productivity',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, prefix: 'tfp_', placeholder: 'tfp_...' }
        ],
        testEndpoint: 'https://api.typeform.com/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.typeform.com/'
    },
    jotform: {
        id: 'jotform',
        name: 'JotForm',
        description: 'Online form builder',
        color: '#09F',
        category: 'productivity',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `https://api.jotform.com/user?apiKey=${creds.api_key}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://api.jotform.com/docs/'
    },
    surveymonkey: {
        id: 'surveymonkey',
        name: 'SurveyMonkey',
        description: 'Survey creation and analytics',
        color: '#00BF6F',
        category: 'productivity',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' }
        ],
        testEndpoint: 'https://api.surveymonkey.com/v3/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.surveymonkey.com/'
    },

    // ========================================================================
    // Analytics
    // ========================================================================
    mixpanel: {
        id: 'mixpanel',
        name: 'Mixpanel',
        description: 'Product analytics and user tracking',
        color: '#7856FF',
        category: 'analytics',
        fields: [
            { key: 'project_token', label: 'Project Token', type: 'password', required: true, placeholder: 'Your project token' },
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true, placeholder: 'Your API secret' }
        ],
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.project_token || creds.project_token.length < 10) {
                return { valid: false, error: 'Invalid project token format' };
            }
            if (!creds.api_secret || creds.api_secret.length < 10) {
                return { valid: false, error: 'Invalid API secret format' };
            }
            return { valid: true };
        },
        docs: 'https://developer.mixpanel.com/'
    },
    amplitude: {
        id: 'amplitude',
        name: 'Amplitude',
        description: 'Product analytics platform',
        color: '#0061FF',
        category: 'analytics',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' },
            { key: 'secret_key', label: 'Secret Key', type: 'password', required: true, placeholder: 'Your secret key' }
        ],
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.api_key || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            if (!creds.secret_key || creds.secret_key.length < 10) {
                return { valid: false, error: 'Invalid secret key format' };
            }
            return { valid: true };
        },
        docs: 'https://www.docs.developers.amplitude.com/'
    },
    segment: {
        id: 'segment',
        name: 'Segment',
        description: 'Customer data platform',
        color: '#52BD95',
        category: 'analytics',
        fields: [
            { key: 'write_key', label: 'Write Key', type: 'password', required: true, placeholder: 'Your write key' }
        ],
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.write_key || creds.write_key.length < 10) {
                return { valid: false, error: 'Invalid write key format' };
            }
            // Check if it's valid base64
            try {
                Buffer.from(creds.write_key + ':', 'utf8').toString('base64');
            } catch {
                return { valid: false, error: 'Invalid write key format' };
            }
            return { valid: true };
        },
        docs: 'https://segment.com/docs/'
    },
    posthog: {
        id: 'posthog',
        name: 'PostHog',
        description: 'Open-source product analytics',
        color: '#1D4AFF',
        category: 'analytics',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'phc_', placeholder: 'phc_...' },
            { key: 'host', label: 'Host', type: 'url', required: false, default: 'https://app.posthog.com', placeholder: 'https://app.posthog.com' }
        ],
        testEndpoint: (creds) => `${(creds.host || 'https://app.posthog.com').replace(/\/$/, '')}/api/projects`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://posthog.com/docs/api'
    },

    // ========================================================================
    // Utilities
    // ========================================================================
    bitly: {
        id: 'bitly',
        name: 'Bitly',
        description: 'URL shortening and link management',
        color: '#EE6123',
        category: 'utilities',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' }
        ],
        testEndpoint: 'https://api-ssl.bitly.com/v4/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://dev.bitly.com/'
    },
    deepl: {
        id: 'deepl',
        name: 'DeepL',
        description: 'AI-powered translation',
        color: '#042B48',
        category: 'utilities',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.deepl.com/v2/usage',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'DeepL-Auth-Key': creds.api_key }),
        docs: 'https://www.deepl.com/docs-api'
    },
    algolia: {
        id: 'algolia',
        name: 'Algolia',
        description: 'Search and discovery platform',
        color: '#003DFF',
        category: 'utilities',
        fields: [
            { key: 'app_id', label: 'Application ID', type: 'text', required: true, placeholder: 'Your Application ID' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `https://${creds.app_id}.algolia.net/1/indexes`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'X-Algolia-API-Key': creds.api_key,
            'X-Algolia-Application-Id': creds.app_id
        }),
        docs: 'https://www.algolia.com/doc/'
    },
    supabase: {
        id: 'supabase',
        name: 'Supabase',
        description: 'Open-source Firebase alternative',
        color: '#3ECF8E',
        category: 'utilities',
        fields: [
            { key: 'project_url', label: 'Project URL', type: 'url', required: true, placeholder: 'https://your-project.supabase.co' },
            { key: 'anon_key', label: 'Anon Key', type: 'password', required: true, placeholder: 'Your anon/public key' },
            { key: 'service_role_key', label: 'Service Role Key', type: 'password', required: false, placeholder: 'Your service role key' }
        ],
        testEndpoint: (creds) => `${creds.project_url.replace(/\/$/, '')}/rest/v1/`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'apikey': creds.anon_key }),
        docs: 'https://supabase.com/docs'
    },
    pinecone: {
        id: 'pinecone',
        name: 'Pinecone',
        description: 'Vector database for AI applications',
        color: '#000000',
        category: 'utilities',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: 'https://api.pinecone.io/indexes',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Api-Key': creds.api_key }),
        docs: 'https://docs.pinecone.io/'
    },
    openweathermap: {
        id: 'openweathermap',
        name: 'OpenWeatherMap',
        description: 'Weather data and forecasts',
        color: '#EB6E4B',
        category: 'utilities',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `https://api.openweathermap.org/data/2.5/weather?q=London&appid=${creds.api_key}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://openweathermap.org/api'
    },

    // ========================================================================
    // Ticketing & Support
    // ========================================================================

    servicenow: {
        id: 'servicenow',
        name: 'ServiceNow',
        description: 'IT service management and ticketing platform',
        color: '#81B5A1',
        category: 'ticketing',
        fields: [
            { key: 'instance_url', label: 'Instance URL', type: 'url', required: true, placeholder: 'https://your-instance.service-now.com' },
            { key: 'username', label: 'Username', type: 'text', required: false, placeholder: 'Your username' },
            { key: 'password', label: 'Password', type: 'password', required: false, placeholder: 'Your password' },
            { key: 'oauth_token', label: 'OAuth Token', type: 'password', required: false, placeholder: 'OAuth access token' }
        ],
        testEndpoint: (creds) => `${creds.instance_url.replace(/\/$/, '')}/api/now/table/incident?sysparm_limit=1`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            if (creds.oauth_token) {
                return { 'Authorization': `Bearer ${creds.oauth_token}` };
            }
            const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://developer.servicenow.com/dev.do#!/reference/api/latest/rest'
    },
    freshservice: {
        id: 'freshservice',
        name: 'Freshservice',
        description: 'IT service desk and asset management',
        color: '#2ECC40',
        category: 'ticketing',
        fields: [
            { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'your-company' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}.freshservice.com/api/v2/tickets`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.api_key}:X`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://api.freshservice.com/'
    },
    zoho_desk: {
        id: 'zoho_desk',
        name: 'Zoho Desk',
        description: 'Customer service and helpdesk software',
        color: '#C8202B',
        category: 'ticketing',
        fields: [
            { key: 'org_id', label: 'Organization ID', type: 'text', required: true, placeholder: 'Your org ID' },
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'OAuth access token' }
        ],
        testEndpoint: 'https://desk.zoho.com/api/v1/tickets',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Zoho-oauthtoken ${creds.access_token}`,
            'orgId': creds.org_id
        }),
        docs: 'https://desk.zoho.com/DeskAPIDocument'
    },
    kayako: {
        id: 'kayako',
        name: 'Kayako',
        deprecated: true,
        description: 'Customer service and helpdesk platform (discontinued — acquired by Paddle 2023)',
        color: '#F26522',
        category: 'ticketing',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://your-company.kayako.com' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' },
            { key: 'secret_key', label: 'Secret Key', type: 'password', required: true, placeholder: 'Your secret key' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v1/me`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:${creds.secret_key}`).toString('base64')}`
        }),
        docs: 'https://developer.kayako.com/'
    },
    happyfox: {
        id: 'happyfox',
        name: 'HappyFox',
        description: 'Helpdesk and customer support ticketing',
        color: '#FF6B00',
        category: 'ticketing',
        fields: [
            { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'your-company' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' },
            { key: 'auth_code', label: 'Auth Code', type: 'password', required: true, placeholder: 'Your auth code' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}.happyfox.com/api/1.1/json/tickets/`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.api_key}:${creds.auth_code}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://support.happyfox.com/kb/section/6/'
    },
    spiceworks: {
        id: 'spiceworks',
        name: 'Spiceworks Cloud',
        description: 'Free IT helpdesk and network monitoring',
        color: '#A1C900',
        category: 'ticketing',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: null,
        testMethod: 'GET',
        testHeaders: () => ({}),
        validateCredentials: (creds) => {
            if (!creds.api_key || creds.api_key.length < 10) {
                return { valid: false, error: 'Invalid API key format' };
            }
            return { valid: true };
        },
        docs: 'https://community.spiceworks.com/support/help-desk-cloud-edition/'
    },
    osticket: {
        id: 'osticket',
        name: 'osTicket',
        description: 'Open-source support ticket system',
        color: '#97C93E',
        category: 'ticketing',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://support.yourcompany.com' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/tickets.json`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-API-Key': creds.api_key }),
        docs: 'https://docs.osticket.com/en/latest/Developer%20Documentation/API.html'
    },
    zammad: {
        id: 'zammad',
        name: 'Zammad',
        description: 'Open-source helpdesk and ticketing system',
        color: '#FFB300',
        category: 'ticketing',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://zammad.yourcompany.com' },
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, placeholder: 'Your access token' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v1/users/me`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://docs.zammad.org/en/latest/api/intro.html'
    },
    request_tracker: {
        id: 'request_tracker',
        name: 'Request Tracker (RT)',
        description: 'Enterprise-grade issue tracking system',
        color: '#444444',
        category: 'ticketing',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://rt.yourcompany.com' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Your RT username' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your RT password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/REST/2.0/user/${creds.username}`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://docs.bestpractical.com/rt/latest/RT/REST2.html'
    },

    // ============================================================================
    // Cloud Security & Key Management
    // ============================================================================

    aws_kms: {
        id: 'aws_kms',
        name: 'AWS KMS',
        description: 'AWS Key Management Service for encryption keys',
        color: '#FF9900',
        category: 'cloudsecurity',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'Your secret key' },
            { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) {
                return { valid: false, error: 'Access Key ID should start with AKIA' };
            }
            if (creds.secret_access_key?.length < 20) {
                return { valid: false, error: 'Secret Access Key appears too short' };
            }
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/kms/latest/developerguide/'
    },
    aws_secrets_manager: {
        id: 'aws_secrets_manager',
        name: 'AWS Secrets Manager',
        description: 'Secure secrets storage and rotation',
        color: '#FF9900',
        category: 'cloudsecurity',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'Your secret key' },
            { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) {
                return { valid: false, error: 'Access Key ID should start with AKIA' };
            }
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/secretsmanager/latest/userguide/'
    },
    azure_keyvault: {
        id: 'azure_keyvault',
        name: 'Azure Key Vault',
        description: 'Azure secrets and key management',
        color: '#0078D4',
        category: 'cloudsecurity',
        fields: [
            { key: 'vault_url', label: 'Vault URL', type: 'url', required: true, placeholder: 'https://your-vault.vault.azure.net/' },
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Your Azure tenant ID' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Application client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Application client secret' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.vault_url?.includes('vault.azure.net')) {
                return { valid: false, error: 'Vault URL should contain vault.azure.net' };
            }
            return { valid: true };
        },
        docs: 'https://docs.microsoft.com/en-us/azure/key-vault/'
    },
    gcp_kms: {
        id: 'gcp_kms',
        name: 'GCP Cloud KMS',
        description: 'Google Cloud Key Management Service',
        color: '#4285F4',
        category: 'cloudsecurity',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: '{"type": "service_account", ...}' },
            { key: 'project_id', label: 'Project ID', type: 'text', required: true, placeholder: 'your-project-id' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try {
                const parsed = JSON.parse(creds.service_account_json);
                if (parsed.type !== 'service_account') {
                    return { valid: false, error: 'Invalid service account JSON' };
                }
                return { valid: true };
            } catch {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://cloud.google.com/kms/docs'
    },
    microsoft_sentinel: {
        id: 'microsoft_sentinel',
        name: 'Microsoft Sentinel',
        description: 'Cloud-native SIEM and SOAR',
        color: '#0078D4',
        category: 'cloudsecurity',
        fields: [
            { key: 'workspace_id', label: 'Workspace ID', type: 'text', required: true, placeholder: 'Log Analytics workspace ID' },
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Azure tenant ID' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Application client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Application client secret' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (creds.workspace_id?.length < 10) {
                return { valid: false, error: 'Workspace ID appears invalid' };
            }
            return { valid: true };
        },
        docs: 'https://docs.microsoft.com/en-us/azure/sentinel/'
    },
    wiz: {
        id: 'wiz',
        name: 'Wiz',
        description: 'Cloud security posture management',
        color: '#1A56DB',
        category: 'cloudsecurity',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Service account client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Service account secret' },
            { key: 'auth_url', label: 'Auth URL', type: 'url', required: true, placeholder: 'https://auth.app.wiz.io/oauth/token' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.auth_url?.includes('wiz.io')) {
                return { valid: false, error: 'Auth URL should be a Wiz URL' };
            }
            return { valid: true };
        },
        docs: 'https://docs.wiz.io/'
    },
    orca: {
        id: 'orca',
        name: 'Orca Security',
        description: 'Cloud security platform',
        color: '#00D4AA',
        category: 'cloudsecurity',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Orca API token' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: false, placeholder: 'https://api.orcasecurity.io' }
        ],
        testEndpoint: (creds) => `${creds.base_url || 'https://api.orcasecurity.io'}/api/v1/user/action/my_identity`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token ${creds.api_token}` }),
        docs: 'https://docs.orcasecurity.io/'
    },
    sentinelone: {
        id: 'sentinelone',
        name: 'SentinelOne',
        description: 'Endpoint detection and response',
        color: '#6B21A8',
        category: 'cloudsecurity',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your API token' },
            { key: 'base_url', label: 'Console URL', type: 'url', required: true, placeholder: 'https://your-console.sentinelone.net' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/web/api/v2.1/system/status`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `ApiToken ${creds.api_token}` }),
        docs: 'https://usea1-partners.sentinelone.net/api-doc/overview'
    },
    cortex_xsoar: {
        id: 'cortex_xsoar',
        name: 'Cortex XSOAR',
        description: 'Palo Alto security orchestration',
        color: '#F04E23',
        category: 'cloudsecurity',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://your-xsoar.paloaltonetworks.com' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/info`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': creds.api_key }),
        docs: 'https://xsoar.pan.dev/'
    },
    prisma_cloud: {
        id: 'prisma_cloud',
        name: 'Prisma Cloud',
        description: 'Cloud native security platform',
        color: '#F04E23',
        category: 'cloudsecurity',
        fields: [
            { key: 'access_key', label: 'Access Key', type: 'text', required: true, placeholder: 'Your access key ID' },
            { key: 'secret_key', label: 'Secret Key', type: 'password', required: true, placeholder: 'Your secret key' },
            { key: 'api_url', label: 'API URL', type: 'url', required: true, placeholder: 'https://api.prismacloud.io' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.api_url?.includes('prismacloud')) {
                return { valid: false, error: 'API URL should be a Prisma Cloud URL' };
            }
            return { valid: true };
        },
        docs: 'https://prisma.pan.dev/'
    },
    google_chronicle: {
        id: 'google_chronicle',
        name: 'Google Chronicle',
        description: 'Google Cloud security analytics',
        color: '#4285F4',
        category: 'cloudsecurity',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: '{"type": "service_account", ...}' },
            { key: 'region', label: 'Region', type: 'select', required: true, options: ['US', 'Europe', 'Asia'] }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try {
                JSON.parse(creds.service_account_json);
                return { valid: true };
            } catch {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://cloud.google.com/chronicle/docs'
    },

    // ============================================================================
    // Zero Trust & Network Security
    // ============================================================================

    cloudflare_zero_trust: {
        id: 'cloudflare_zero_trust',
        name: 'Cloudflare Zero Trust',
        description: 'Zero trust network access',
        color: '#F38020',
        category: 'zerotrust',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Cloudflare API token' },
            { key: 'account_id', label: 'Account ID', type: 'text', required: true, placeholder: 'Your account ID' }
        ],
        testEndpoint: (creds) => `https://api.cloudflare.com/client/v4/accounts/${creds.account_id}/access/apps`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://developers.cloudflare.com/api/'
    },
    zscaler: {
        id: 'zscaler',
        name: 'Zscaler',
        description: 'Cloud security platform',
        color: '#049FD9',
        category: 'zerotrust',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' },
            { key: 'cloud', label: 'Cloud', type: 'text', required: true, placeholder: 'zscaler.net' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'admin@company.com' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your password' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.cloud?.includes('zscaler')) {
                return { valid: false, error: 'Cloud should be a Zscaler domain' };
            }
            return { valid: true };
        },
        docs: 'https://help.zscaler.com/zia/api'
    },
    tailscale: {
        id: 'tailscale',
        name: 'Tailscale',
        description: 'Zero config VPN mesh network',
        color: '#242424',
        category: 'zerotrust',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'tskey-api-...' },
            { key: 'tailnet', label: 'Tailnet', type: 'text', required: true, placeholder: 'your-tailnet.ts.net' }
        ],
        testEndpoint: (creds) => `https://api.tailscale.com/api/v2/tailnet/${creds.tailnet}/devices`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://tailscale.com/kb/1101/api/'
    },
    teleport: {
        id: 'teleport',
        name: 'Teleport',
        description: 'Identity-aware infrastructure access',
        color: '#512FC9',
        category: 'zerotrust',
        fields: [
            { key: 'proxy_addr', label: 'Proxy Address', type: 'url', required: true, placeholder: 'https://teleport.example.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your machine ID token' }
        ],
        testEndpoint: (creds) => `${creds.proxy_addr.replace(/\/$/, '')}/v1/webapi/ping`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://goteleport.com/docs/'
    },

    // ============================================================================
    // Kubernetes & Platform Engineering
    // ============================================================================

    kubernetes_api: {
        id: 'kubernetes_api',
        name: 'Kubernetes API',
        description: 'Direct Kubernetes cluster access',
        color: '#326CE5',
        category: 'kubernetes',
        fields: [
            { key: 'api_server', label: 'API Server URL', type: 'url', required: true, placeholder: 'https://kubernetes.default.svc' },
            { key: 'token', label: 'Bearer Token', type: 'password', required: true, placeholder: 'Service account token' },
            { key: 'ca_cert', label: 'CA Certificate', type: 'textarea', required: false, placeholder: 'Base64 encoded CA cert (optional)' }
        ],
        testEndpoint: (creds) => `${creds.api_server.replace(/\/$/, '')}/api/v1/namespaces`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://kubernetes.io/docs/reference/kubernetes-api/'
    },
    argocd: {
        id: 'argocd',
        name: 'ArgoCD',
        description: 'GitOps continuous delivery',
        color: '#EF7B4D',
        category: 'kubernetes',
        fields: [
            { key: 'server_url', label: 'Server URL', type: 'url', required: true, placeholder: 'https://argocd.example.com' },
            { key: 'auth_token', label: 'Auth Token', type: 'password', required: true, placeholder: 'ArgoCD API token' }
        ],
        testEndpoint: (creds) => `${creds.server_url.replace(/\/$/, '')}/api/v1/applications`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.auth_token}` }),
        docs: 'https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/'
    },
    backstage: {
        id: 'backstage',
        name: 'Backstage',
        description: 'Developer portal platform',
        color: '#36BAA2',
        category: 'kubernetes',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://backstage.example.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: false, placeholder: 'Bearer token (if auth enabled)' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/catalog/entities?limit=1`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.api_token ? { 'Authorization': `Bearer ${creds.api_token}` } : {},
        docs: 'https://backstage.io/docs/'
    },
    jfrog_artifactory: {
        id: 'jfrog_artifactory',
        name: 'JFrog Artifactory',
        description: 'Universal artifact repository',
        color: '#40BE46',
        category: 'kubernetes',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://your-org.jfrog.io/artifactory' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key or access token' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/system/ping`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-JFrog-Art-Api': creds.api_key }),
        docs: 'https://jfrog.com/help/r/jfrog-rest-apis/'
    },
    sonatype_nexus: {
        id: 'sonatype_nexus',
        name: 'Sonatype Nexus',
        description: 'Repository manager',
        color: '#1B1C1D',
        category: 'kubernetes',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://nexus.example.com' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'admin' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/service/rest/v1/status`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://help.sonatype.com/repomanager3/integrations/rest-and-integration-api'
    },

    // ============================================================================
    // Data Movement & ETL
    // ============================================================================

    airbyte: {
        id: 'airbyte',
        name: 'Airbyte',
        description: 'Data integration platform',
        color: '#615EFF',
        category: 'datamovement',
        fields: [
            { key: 'base_url', label: 'API URL', type: 'url', required: true, placeholder: 'https://api.airbyte.com' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/v1/workspaces`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://reference.airbyte.com/'
    },
    fivetran: {
        id: 'fivetran',
        name: 'Fivetran',
        description: 'Automated data movement',
        color: '#0073FF',
        category: 'datamovement',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'text', required: true, placeholder: 'Your API key' },
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true, placeholder: 'Your API secret' }
        ],
        testEndpoint: 'https://api.fivetran.com/v1/users',
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://fivetran.com/docs/rest-api'
    },
    dbt_cloud: {
        id: 'dbt_cloud',
        name: 'dbt Cloud',
        description: 'Data transformation platform',
        color: '#FF694A',
        category: 'datamovement',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your service token' },
            { key: 'account_id', label: 'Account ID', type: 'text', required: true, placeholder: 'Your account ID' }
        ],
        testEndpoint: (creds) => `https://cloud.getdbt.com/api/v2/accounts/${creds.account_id}/`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token ${creds.api_token}` }),
        docs: 'https://docs.getdbt.com/docs/dbt-cloud-apis/overview'
    },
    confluent: {
        id: 'confluent',
        name: 'Confluent Cloud',
        description: 'Kafka as a service',
        color: '#171A21',
        category: 'datamovement',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'text', required: true, placeholder: 'Cloud API key' },
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true, placeholder: 'Cloud API secret' }
        ],
        testEndpoint: 'https://api.confluent.cloud/org/v2/organizations',
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://docs.confluent.io/cloud/current/api.html'
    },

    // ============================================================================
    // Data Catalogs & Governance
    // ============================================================================

    collibra: {
        id: 'collibra',
        name: 'Collibra',
        description: 'Data intelligence platform',
        color: '#00875A',
        category: 'datacatalog',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://your-org.collibra.com' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Your username' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/rest/2.0/users/current`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://developer.collibra.com/'
    },
    alation: {
        id: 'alation',
        name: 'Alation',
        description: 'Data catalog and governance',
        color: '#0066CC',
        category: 'datacatalog',
        fields: [
            { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://your-org.alationcatalog.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your API access token' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/integration/v1/user/`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Token': creds.api_token }),
        docs: 'https://developer.alation.com/'
    },
    datahub: {
        id: 'datahub',
        name: 'DataHub',
        description: 'Open source data catalog',
        color: '#4C8C4A',
        category: 'datacatalog',
        fields: [
            { key: 'gms_url', label: 'GMS URL', type: 'url', required: true, placeholder: 'https://datahub.example.com:8080' },
            { key: 'token', label: 'Access Token', type: 'password', required: false, placeholder: 'Personal access token (if auth enabled)' }
        ],
        testEndpoint: (creds) => `${creds.gms_url.replace(/\/$/, '')}/config`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.token ? { 'Authorization': `Bearer ${creds.token}` } : {},
        docs: 'https://datahubproject.io/docs/'
    },

    // ============================================================================
    // Document Intelligence
    // ============================================================================

    aws_textract: {
        id: 'aws_textract',
        name: 'AWS Textract',
        description: 'Document text and data extraction',
        color: '#FF9900',
        category: 'documentai',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'Your secret key' },
            { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) {
                return { valid: false, error: 'Access Key ID should start with AKIA' };
            }
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/textract/'
    },
    azure_form_recognizer: {
        id: 'azure_form_recognizer',
        name: 'Azure Document Intelligence',
        description: 'Document intelligence service (formerly Form Recognizer)',
        color: '#0078D4',
        category: 'documentai',
        fields: [
            { key: 'endpoint', label: 'Endpoint', type: 'url', required: true, placeholder: 'https://your-resource.cognitiveservices.azure.com/' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `${creds.endpoint.replace(/\/$/, '')}/documentintelligence/documentModels?api-version=2024-11-30`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Ocp-Apim-Subscription-Key': creds.api_key }),
        docs: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/'
    },
    google_document_ai: {
        id: 'google_document_ai',
        name: 'Google Document AI',
        description: 'Document processing and extraction',
        color: '#4285F4',
        category: 'documentai',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: '{"type": "service_account", ...}' },
            { key: 'project_id', label: 'Project ID', type: 'text', required: true, placeholder: 'your-project-id' },
            { key: 'location', label: 'Location', type: 'text', required: true, placeholder: 'us or eu' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try {
                JSON.parse(creds.service_account_json);
                return { valid: true };
            } catch {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://cloud.google.com/document-ai/docs'
    },

    // ============================================================================
    // Browser Automation
    // ============================================================================

    browserless: {
        id: 'browserless',
        name: 'Browserless',
        description: 'Headless browser as a service',
        color: '#00D8FF',
        category: 'browser',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your API token' },
            { key: 'base_url', label: 'Base URL', type: 'url', required: false, placeholder: 'https://chrome.browserless.io (default)' }
        ],
        testEndpoint: (creds) => `${creds.base_url || 'https://chrome.browserless.io'}/pressure?token=${creds.api_token}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://www.browserless.io/docs/'
    },
    apify: {
        id: 'apify',
        name: 'Apify',
        description: 'Web scraping and automation platform',
        color: '#00AAFF',
        category: 'browser',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your API token' }
        ],
        testEndpoint: 'https://api.apify.com/v2/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.apify.com/api/v2'
    },

    // Website login credentials (Browser-Q)
    browser_login: {
        id: 'browser_login',
        name: 'Website Login',
        description: 'Username and password for website login (used by Browser-Q automations)',
        color: '#06b6d4',
        category: 'browser',
        fields: [
            { key: 'domain', label: 'Website / Domain', type: 'url', required: true, placeholder: 'https://console.hetzner.cloud' },
            { key: 'username', label: 'Username or Email', type: 'text', required: true, placeholder: 'user@example.com' },
            { key: 'password', label: 'Password', type: 'password', required: true },
            { key: 'login_url', label: 'Login Page URL (optional)', type: 'url', required: false, placeholder: 'https://console.hetzner.cloud/login' },
            { key: 'notes', label: 'Notes', type: 'text', required: false, placeholder: 'e.g. Has 2FA, use authenticator app' }
        ],
        validateCredentials: (creds) => {
            if (!creds.domain) return { valid: false, error: 'Domain is required' };
            if (!creds.username) return { valid: false, error: 'Username is required' };
            if (!creds.password) return { valid: false, error: 'Password is required' };
            return { valid: true };
        },
        docs: null
    },

    // ============================================================================
    // Finance & ERP
    // ============================================================================

    netsuite: {
        id: 'netsuite',
        name: 'NetSuite',
        description: 'Oracle ERP cloud suite',
        color: '#0A0A0A',
        category: 'finance',
        fields: [
            { key: 'account_id', label: 'Account ID', type: 'text', required: true, placeholder: 'Your NetSuite account ID' },
            { key: 'consumer_key', label: 'Consumer Key', type: 'text', required: true, placeholder: 'OAuth consumer key' },
            { key: 'consumer_secret', label: 'Consumer Secret', type: 'password', required: true, placeholder: 'OAuth consumer secret' },
            { key: 'token_id', label: 'Token ID', type: 'text', required: true, placeholder: 'Token ID' },
            { key: 'token_secret', label: 'Token Secret', type: 'password', required: true, placeholder: 'Token secret' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.account_id || creds.account_id.length < 3) {
                return { valid: false, error: 'Account ID is required' };
            }
            return { valid: true };
        },
        docs: 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1529086055.html'
    },
    dynamics_365: {
        id: 'dynamics_365',
        name: 'Microsoft Dynamics 365',
        description: 'Microsoft ERP and CRM',
        color: '#002050',
        category: 'finance',
        fields: [
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Azure AD tenant ID' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Application client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Application client secret' },
            { key: 'environment_url', label: 'Environment URL', type: 'url', required: true, placeholder: 'https://your-org.crm.dynamics.com' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.environment_url?.includes('dynamics.com')) {
                return { valid: false, error: 'Environment URL should be a Dynamics 365 URL' };
            }
            return { valid: true };
        },
        docs: 'https://docs.microsoft.com/en-us/dynamics365/'
    },
    quickbooks: {
        id: 'quickbooks',
        name: 'QuickBooks Online',
        description: 'Intuit accounting software',
        color: '#2CA01C',
        category: 'finance',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'OAuth client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'OAuth client secret' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'OAuth refresh token' },
            { key: 'realm_id', label: 'Realm ID', type: 'text', required: true, placeholder: 'Company ID' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.realm_id || creds.realm_id.length < 5) {
                return { valid: false, error: 'Realm ID is required' };
            }
            return { valid: true };
        },
        docs: 'https://developer.intuit.com/app/developer/qbo/docs/get-started'
    },
    xero: {
        id: 'xero',
        name: 'Xero',
        description: 'Cloud accounting platform',
        color: '#13B5EA',
        category: 'finance',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'OAuth client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'OAuth client secret' },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true, placeholder: 'OAuth refresh token' },
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Xero tenant ID' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.tenant_id) {
                return { valid: false, error: 'Tenant ID is required' };
            }
            return { valid: true };
        },
        docs: 'https://developer.xero.com/documentation/'
    },
    ramp: {
        id: 'ramp',
        name: 'Ramp',
        description: 'Corporate card and spend management',
        color: '#000000',
        category: 'finance',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'OAuth client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'OAuth client secret' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.client_id || !creds.client_secret) {
                return { valid: false, error: 'Client credentials are required' };
            }
            return { valid: true };
        },
        docs: 'https://docs.ramp.com/'
    },
    brex: {
        id: 'brex',
        name: 'Brex',
        description: 'Business financial services',
        color: '#FF6633',
        category: 'finance',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your API token' }
        ],
        testEndpoint: 'https://platform.brexapis.com/v2/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://developer.brex.com/'
    },

    // ============================================================================
    // Compliance & eDiscovery
    // ============================================================================

    microsoft_purview: {
        id: 'microsoft_purview',
        name: 'Microsoft Purview',
        description: 'Data governance and compliance',
        color: '#0078D4',
        category: 'compliance',
        fields: [
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Azure AD tenant ID' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Application client ID' },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Application client secret' },
            { key: 'purview_account', label: 'Purview Account', type: 'text', required: true, placeholder: 'Your Purview account name' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.purview_account) {
                return { valid: false, error: 'Purview account name is required' };
            }
            return { valid: true };
        },
        docs: 'https://docs.microsoft.com/en-us/azure/purview/'
    },
    google_vault: {
        id: 'google_vault',
        name: 'Google Vault',
        description: 'eDiscovery and information governance',
        color: '#4285F4',
        category: 'compliance',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: '{"type": "service_account", ...}' },
            { key: 'delegated_user', label: 'Delegated User Email', type: 'email', required: true, placeholder: 'admin@yourdomain.com' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try {
                JSON.parse(creds.service_account_json);
                return { valid: true };
            } catch {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://developers.google.com/vault'
    },

    // ============================================================================
    // Vector Databases
    // ============================================================================

    weaviate: {
        id: 'weaviate',
        name: 'Weaviate',
        description: 'Vector search engine',
        color: '#46B480',
        category: 'vectordb',
        fields: [
            { key: 'host', label: 'Host URL', type: 'url', required: true, placeholder: 'https://your-cluster.weaviate.network' },
            { key: 'api_key', label: 'API Key', type: 'password', required: false, placeholder: 'Your API key (if auth enabled)' }
        ],
        testEndpoint: (creds) => `${creds.host.replace(/\/$/, '')}/v1/meta`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.api_key ? { 'Authorization': `Bearer ${creds.api_key}` } : {},
        docs: 'https://weaviate.io/developers/weaviate'
    },
    qdrant: {
        id: 'qdrant',
        name: 'Qdrant',
        description: 'Vector similarity search',
        color: '#DC382D',
        category: 'vectordb',
        fields: [
            { key: 'host', label: 'Host URL', type: 'url', required: true, placeholder: 'https://your-cluster.qdrant.io' },
            { key: 'api_key', label: 'API Key', type: 'password', required: false, placeholder: 'Your API key' }
        ],
        testEndpoint: (creds) => `${creds.host.replace(/\/$/, '')}/collections`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.api_key ? { 'api-key': creds.api_key } : {},
        docs: 'https://qdrant.tech/documentation/'
    },
    milvus: {
        id: 'milvus',
        name: 'Milvus / Zilliz',
        description: 'Vector database for AI',
        color: '#00A1EA',
        category: 'vectordb',
        fields: [
            { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'your-cluster.zillizcloud.com' },
            { key: 'port', label: 'Port', type: 'text', required: true, placeholder: '19530' },
            { key: 'token', label: 'Token', type: 'password', required: false, placeholder: 'API token (for Zilliz Cloud)' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.host) {
                return { valid: false, error: 'Host is required' };
            }
            return { valid: true };
        },
        docs: 'https://milvus.io/docs/'
    },

    // ========================================================================
    // Payments & Financial
    // ========================================================================
    stripe: {
        id: 'stripe',
        name: 'Stripe',
        description: 'Payment processing and billing platform',
        color: '#635BFF',
        category: 'ecommerce',
        fields: [
            { key: 'api_key', label: 'Secret Key', type: 'password', required: true, prefix: 'sk_', placeholder: 'sk_live_... or sk_test_...' }
        ],
        testEndpoint: 'https://api.stripe.com/v1/balance',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.stripe.com/api'
    },
    plaid: {
        id: 'plaid',
        name: 'Plaid',
        description: 'Financial data and banking API',
        color: '#00D64F',
        category: 'ecommerce',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Your Plaid client ID' },
            { key: 'secret', label: 'Secret', type: 'password', required: true, placeholder: 'Your Plaid secret' },
            { key: 'environment', label: 'Environment', type: 'select', required: true, options: ['sandbox', 'production'], default: 'sandbox' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.client_id || !creds.secret) {
                return { valid: false, error: 'Client ID and Secret are required' };
            }
            return { valid: true };
        },
        docs: 'https://plaid.com/docs/'
    },

    // ========================================================================
    // Communication & Messaging
    // ========================================================================
    twilio: {
        id: 'twilio',
        name: 'Twilio',
        description: 'SMS, voice, and messaging APIs',
        color: '#F22F46',
        category: 'communication',
        fields: [
            { key: 'account_sid', label: 'Account SID', type: 'text', required: true, prefix: 'AC', placeholder: 'AC...' },
            { key: 'auth_token', label: 'Auth Token', type: 'password', required: true, placeholder: 'Your auth token' }
        ],
        testEndpoint: (creds) => `https://api.twilio.com/2010-04-01/Accounts/${creds.account_sid}.json`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.account_sid}:${creds.auth_token}`).toString('base64')}`
        }),
        docs: 'https://www.twilio.com/docs/usage/api'
    },
    sendgrid: {
        id: 'sendgrid',
        name: 'SendGrid',
        description: 'Email delivery and marketing platform',
        color: '#1A82E2',
        category: 'communication',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'SG.', placeholder: 'SG....' }
        ],
        testEndpoint: 'https://api.sendgrid.com/v3/user/profile',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.sendgrid.com/api-reference/'
    },
    resend: {
        id: 'resend',
        name: 'Resend',
        description: 'Modern email API for developers',
        color: '#000000',
        category: 'communication',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 're_', placeholder: 're_...' }
        ],
        testEndpoint: 'https://api.resend.com/domains',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://resend.com/docs/api-reference'
    },

    // ========================================================================
    // Project Management
    // ========================================================================
    jira: {
        id: 'jira',
        name: 'Jira',
        description: 'Atlassian project and issue tracking',
        color: '#0052CC',
        category: 'developer',
        fields: [
            { key: 'email', label: 'Email', type: 'email', required: true, placeholder: 'you@company.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Atlassian API token' },
            { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'your-company.atlassian.net' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}/rest/api/3/myself`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64')}`
        }),
        docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/'
    },
    linear: {
        id: 'linear',
        name: 'Linear',
        description: 'Modern issue tracking and project management',
        color: '#5E6AD2',
        category: 'developer',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'lin_api_', placeholder: 'lin_api_...' }
        ],
        testEndpoint: 'https://api.linear.app/graphql',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': creds.api_key,
            'Content-Type': 'application/json'
        }),
        testBody: JSON.stringify({ query: '{ viewer { id name } }' }),
        docs: 'https://developers.linear.app/docs'
    },

    // ========================================================================
    // Observability & Monitoring
    // ========================================================================
    datadog: {
        id: 'datadog',
        name: 'Datadog',
        description: 'Cloud monitoring and analytics platform',
        color: '#632CA6',
        category: 'devops',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Datadog API key' },
            { key: 'app_key', label: 'Application Key', type: 'password', required: true, placeholder: 'Your application key' },
            { key: 'site', label: 'Datadog Site', type: 'select', required: true, options: ['datadoghq.com', 'datadoghq.eu', 'us3.datadoghq.com', 'us5.datadoghq.com'], default: 'datadoghq.com' }
        ],
        testEndpoint: (creds) => `https://api.${creds.site || 'datadoghq.com'}/api/v1/validate`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'DD-API-KEY': creds.api_key,
            'DD-APPLICATION-KEY': creds.app_key
        }),
        docs: 'https://docs.datadoghq.com/api/'
    },
    grafana: {
        id: 'grafana',
        name: 'Grafana',
        lanAllowed: true,
        description: 'Open-source monitoring and visualization',
        color: '#F46800',
        category: 'devops',
        fields: [
            { key: 'api_key', label: 'Service Account Token', type: 'password', required: true, prefix: 'glsa_', placeholder: 'glsa_...' },
            { key: 'base_url', label: 'Grafana URL', type: 'url', required: true, placeholder: 'https://your-grafana.grafana.net' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/org`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://grafana.com/docs/grafana/latest/developers/http_api/'
    },
    rabbitmq: {
        id: 'rabbitmq',
        name: 'RabbitMQ',
        lanAllowed: true,
        description: 'Message broker management API (overview, queues, nodes, exchanges)',
        color: '#FF6600',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'Management URL', type: 'url', required: true, placeholder: 'http://rabbitmq-host:15672' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'guest' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your RabbitMQ password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/overview`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` }),
        docs: 'https://www.rabbitmq.com/docs/management#http-api'
    },
    netdata: {
        id: 'netdata',
        name: 'Netdata',
        lanAllowed: true,
        description: 'Real-time per-second infrastructure monitoring agent',
        color: '#00AB44',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'Netdata Agent URL', type: 'url', required: true, placeholder: 'http://netdata-host:19999' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v1/info`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api'
    },
    opensearch: {
        id: 'opensearch',
        name: 'OpenSearch',
        lanAllowed: true,
        description: 'Open-source search and analytics engine (Elasticsearch fork)',
        color: '#005EB8',
        category: 'data_ai',
        fields: [
            { key: 'base_url', label: 'OpenSearch URL', type: 'url', required: true, placeholder: 'https://opensearch-host:9200' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'admin' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your OpenSearch password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/_cluster/health`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` }),
        docs: 'https://opensearch.org/docs/latest/api-reference/'
    },
    alertmanager: {
        id: 'alertmanager',
        name: 'Prometheus Alertmanager',
        lanAllowed: true,
        description: 'Prometheus Alertmanager: active alerts, silences and cluster status',
        color: '#E6522C',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'Alertmanager URL', type: 'url', required: true, placeholder: 'http://alertmanager-host:9093' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v2/status`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml'
    },
    loki: {
        id: 'loki',
        name: 'Grafana Loki',
        lanAllowed: true,
        description: 'Grafana Loki log aggregation: labels, series and LogQL queries',
        color: '#F5A623',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'Loki URL', type: 'url', required: true, placeholder: 'http://loki-host:3100' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/loki/api/v1/labels`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://grafana.com/docs/loki/latest/reference/loki-http-api/'
    },
    nats: {
        id: 'nats',
        name: 'NATS',
        lanAllowed: true,
        description: 'NATS server monitoring: server info, connections, subscriptions and JetStream',
        color: '#27AAE1',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'NATS Monitoring URL', type: 'url', required: true, placeholder: 'http://nats-host:8222' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/varz`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://docs.nats.io/running-a-nats-service/nats_admin/monitoring'
    },
    traefik: {
        id: 'traefik',
        name: 'Traefik',
        lanAllowed: true,
        description: 'Traefik reverse proxy: overview, routers, services and middlewares',
        color: '#24A1C1',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'Traefik API URL', type: 'url', required: true, placeholder: 'http://traefik-host:8080' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/overview`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://doc.traefik.io/traefik/operations/api/'
    },
    victoriametrics: {
        id: 'victoriametrics',
        name: 'VictoriaMetrics',
        lanAllowed: true,
        description: 'VictoriaMetrics time-series database: PromQL queries, labels and TSDB status',
        color: '#621773',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'VictoriaMetrics URL', type: 'url', required: true, placeholder: 'http://victoriametrics-host:8428' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v1/status/tsdb`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://docs.victoriametrics.com/url-examples/'
    },

    // ========================================================================
    // Google Workspace
    // ========================================================================
    google_sheets: {
        id: 'google_sheets',
        name: 'Google Sheets',
        description: 'Google Sheets spreadsheet API',
        color: '#0F9D58',
        category: 'documents',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: 'Paste service account JSON key' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try {
                const parsed = JSON.parse(creds.service_account_json);
                if (!parsed.client_email || !parsed.private_key) {
                    return { valid: false, error: 'Service account JSON must contain client_email and private_key' };
                }
                return { valid: true };
            } catch (e) {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://developers.google.com/sheets/api'
    },
    google_calendar: {
        id: 'google_calendar',
        name: 'Google Calendar',
        description: 'Google Calendar scheduling API',
        color: '#4285F4',
        category: 'documents',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true, placeholder: 'Paste service account JSON key' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try {
                const parsed = JSON.parse(creds.service_account_json);
                if (!parsed.client_email || !parsed.private_key) {
                    return { valid: false, error: 'Service account JSON must contain client_email and private_key' };
                }
                return { valid: true };
            } catch (e) {
                return { valid: false, error: 'Invalid JSON format' };
            }
        },
        docs: 'https://developers.google.com/calendar/api'
    },

    // ========================================================================
    // Infrastructure
    // ========================================================================
    proxmox: {
        id: 'proxmox',
        name: 'Proxmox VE',
        lanAllowed: true,
        description: 'Proxmox Virtual Environment hypervisor API',
        color: '#E57000',
        category: 'infra',
        fields: [
            { key: 'base_url', label: 'Proxmox URL', type: 'url', required: true, placeholder: 'https://hyp-01.example.com:8006' },
            { key: 'token_id', label: 'API Token ID', type: 'text', required: true, placeholder: 'user@pam!tokenname' },
            { key: 'token_secret', label: 'Token Secret', type: 'password', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
            { key: 'tls_fingerprint', label: 'TLS Fingerprint (SHA-256, optional)', type: 'text', required: false, placeholder: 'AA:BB:CC:... (pins the Proxmox certificate)' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api2/json/version`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `PVEAPIToken=${creds.token_id}=${creds.token_secret}` }),
        docs: 'https://pve.proxmox.com/pve-docs/api-viewer/'
    },
    fly_io: {
        id: 'fly_io',
        name: 'Fly.io',
        description: 'Global application platform',
        color: '#7B36ED',
        category: 'cloud',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, prefix: 'FlyV1 ', placeholder: 'FlyV1 ...' }
        ],
        testEndpoint: 'https://api.machines.dev/v1/apps',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://fly.io/docs/machines/api/'
    },
    upstash: {
        id: 'upstash',
        name: 'Upstash',
        description: 'Serverless Redis and Kafka',
        color: '#00E9A3',
        category: 'data',
        fields: [
            { key: 'email', label: 'Email', type: 'email', required: true, placeholder: 'you@company.com' },
            { key: 'api_key', label: 'Management API Key', type: 'password', required: true, placeholder: 'Your Upstash management API key' }
        ],
        testEndpoint: 'https://api.upstash.com/v2/redis/databases',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.email}:${creds.api_key}`).toString('base64')}`
        }),
        docs: 'https://upstash.com/docs/devops/developer-api'
    },

    // ========================================================================
    // Vector Databases (additional)
    // ========================================================================
    chroma: {
        id: 'chroma',
        name: 'Chroma',
        description: 'Open-source AI-native embedding database',
        color: '#FFD700',
        category: 'data',
        fields: [
            { key: 'base_url', label: 'Chroma URL', type: 'url', required: true, default: 'http://localhost:8000', placeholder: 'http://localhost:8000' },
            { key: 'api_key', label: 'API Key', type: 'password', required: false, placeholder: 'API key (if auth enabled)' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v2/heartbeat`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.api_key ? ({ 'Authorization': `Bearer ${creds.api_key}` }) : ({}),
        docs: 'https://docs.trychroma.com/'
    },

    // ========================================================================
    // Databases
    // ========================================================================
    mysql: {
        id: 'mysql',
        name: 'MySQL',
        description: 'MySQL relational database',
        color: '#4479A1',
        category: 'data',
        fields: [
            { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
            { key: 'port', label: 'Port', type: 'text', required: true, default: '3306', placeholder: '3306' },
            { key: 'username', label: 'Username', type: 'text', required: true },
            { key: 'password', label: 'Password', type: 'password', required: true },
            { key: 'database', label: 'Database', type: 'text', required: false }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.host || !creds.username) return { valid: false, error: 'Host and username are required' };
            return { valid: true };
        },
        docs: 'https://dev.mysql.com/doc/'
    },
    mariadb: {
        id: 'mariadb',
        name: 'MariaDB',
        description: 'MariaDB relational database',
        color: '#003545',
        category: 'data',
        fields: [
            { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
            { key: 'port', label: 'Port', type: 'text', required: true, default: '3306', placeholder: '3306' },
            { key: 'username', label: 'Username', type: 'text', required: true },
            { key: 'password', label: 'Password', type: 'password', required: true },
            { key: 'database', label: 'Database', type: 'text', required: false }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.host || !creds.username) return { valid: false, error: 'Host and username are required' };
            return { valid: true };
        },
        docs: 'https://mariadb.com/kb/en/documentation/'
    },
    cockroachdb: {
        id: 'cockroachdb',
        name: 'CockroachDB',
        description: 'Distributed SQL database',
        color: '#6933FF',
        category: 'data',
        fields: [
            { key: 'connection_string', label: 'Connection String', type: 'password', required: true, placeholder: 'postgresql://user:pass@host:26257/db?sslmode=verify-full' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.connection_string) return { valid: false, error: 'Connection string is required' };
            return { valid: true };
        },
        docs: 'https://www.cockroachlabs.com/docs/'
    },
    planetscale: {
        id: 'planetscale',
        name: 'PlanetScale',
        description: 'Serverless MySQL platform',
        color: '#000000',
        category: 'data',
        fields: [
            { key: 'service_token_id', label: 'Service Token ID', type: 'text', required: true, placeholder: 'Your service token ID' },
            { key: 'service_token', label: 'Service Token', type: 'password', required: true, placeholder: 'pscale_tkn_...' },
            { key: 'organization', label: 'Organization', type: 'text', required: true }
        ],
        testEndpoint: (creds) => `https://api.planetscale.com/v1/organizations/${creds.organization}/databases`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `${creds.service_token_id}:${creds.service_token}` }),
        docs: 'https://api-docs.planetscale.com/'
    },
    neon: {
        id: 'neon',
        name: 'Neon',
        description: 'Serverless Postgres with branching',
        color: '#00E699',
        category: 'data',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Your Neon API key' }
        ],
        testEndpoint: 'https://console.neon.tech/api/v2/projects',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://api-docs.neon.tech/reference/'
    },
    turso: {
        id: 'turso',
        name: 'Turso',
        description: 'Edge-hosted distributed SQLite (libSQL)',
        color: '#4FF8D2',
        category: 'data',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true, placeholder: 'Your Turso platform API token' }
        ],
        testEndpoint: 'https://api.turso.tech/v1/organizations',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.turso.tech/api-reference/'
    },
    fauna: {
        id: 'fauna',
        name: 'Fauna',
        description: 'Document-relational database',
        color: '#3A1AB6',
        category: 'data',
        fields: [
            { key: 'secret', label: 'Secret Key', type: 'password', required: true, placeholder: 'fnAE...' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.secret) return { valid: false, error: 'Secret key is required' };
            return { valid: true };
        },
        docs: 'https://docs.fauna.com/'
    },
    couchdb: {
        id: 'couchdb',
        name: 'CouchDB',
        description: 'Apache CouchDB document database',
        color: '#E42528',
        category: 'data',
        fields: [
            { key: 'base_url', label: 'CouchDB URL', type: 'url', required: true, placeholder: 'http://localhost:5984' },
            { key: 'username', label: 'Username', type: 'text', required: true },
            { key: 'password', label: 'Password', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/_session`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
        }),
        docs: 'https://docs.couchdb.org/'
    },
    neo4j: {
        id: 'neo4j',
        name: 'Neo4j',
        description: 'Graph database platform',
        color: '#008CC1',
        category: 'data',
        fields: [
            { key: 'uri', label: 'Connection URI', type: 'text', required: true, placeholder: 'neo4j+s://xxxxx.databases.neo4j.io' },
            { key: 'username', label: 'Username', type: 'text', required: true, default: 'neo4j' },
            { key: 'password', label: 'Password', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.uri || !creds.password) return { valid: false, error: 'URI and password are required' };
            return { valid: true };
        },
        docs: 'https://neo4j.com/docs/'
    },
    influxdb: {
        id: 'influxdb',
        name: 'InfluxDB',
        description: 'Time series database',
        color: '#22ADF6',
        category: 'data',
        fields: [
            { key: 'url', label: 'InfluxDB URL', type: 'url', required: true, placeholder: 'http://localhost:8086' },
            { key: 'token', label: 'API Token', type: 'password', required: true, placeholder: 'Your InfluxDB token' },
            { key: 'org', label: 'Organization', type: 'text', required: true }
        ],
        testEndpoint: (creds) => `${creds.url.replace(/\/$/, '')}/api/v2/orgs`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Token ${creds.token}` }),
        docs: 'https://docs.influxdata.com/influxdb/'
    },
    clickhouse: {
        id: 'clickhouse',
        name: 'ClickHouse',
        description: 'Column-oriented analytics database',
        color: '#FFCC00',
        category: 'data',
        fields: [
            { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'your-instance.clickhouse.cloud' },
            { key: 'port', label: 'Port', type: 'text', required: false, default: '8443' },
            { key: 'username', label: 'Username', type: 'text', required: true, default: 'default' },
            { key: 'password', label: 'Password', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.host || !creds.password) return { valid: false, error: 'Host and password are required' };
            return { valid: true };
        },
        docs: 'https://clickhouse.com/docs/'
    },
    timescaledb: {
        id: 'timescaledb',
        name: 'TimescaleDB',
        description: 'Time-series database on PostgreSQL',
        color: '#FDB515',
        category: 'data',
        fields: [
            { key: 'connection_string', label: 'Connection String', type: 'password', required: true, placeholder: 'postgres://user:pass@host:port/db' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.connection_string) return { valid: false, error: 'Connection string is required' };
            return { valid: true };
        },
        docs: 'https://docs.timescale.com/'
    },
    singlestore: {
        id: 'singlestore',
        name: 'SingleStore',
        description: 'Distributed SQL database for analytics and transactions',
        color: '#AA00FF',
        category: 'data',
        fields: [
            { key: 'api_key', label: 'Management API Key', type: 'password', required: true, placeholder: 'Your management API key' }
        ],
        testEndpoint: 'https://api.singlestore.com/v1/workspaceGroups',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.singlestore.com/'
    },

    // ========================================================================
    // AWS Service Breakouts
    // ========================================================================
    aws_s3: {
        id: 'aws_s3',
        name: 'AWS S3',
        description: 'Amazon Simple Storage Service',
        color: '#569A31',
        category: 'cloud',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/s3/'
    },
    aws_lambda: {
        id: 'aws_lambda',
        name: 'AWS Lambda',
        description: 'Serverless compute service',
        color: '#FF9900',
        category: 'cloud',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/lambda/'
    },
    aws_sqs: {
        id: 'aws_sqs',
        name: 'AWS SQS',
        description: 'Simple Queue Service',
        color: '#FF9900',
        category: 'cloud',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/sqs/'
    },
    aws_sns: {
        id: 'aws_sns',
        name: 'AWS SNS',
        description: 'Simple Notification Service',
        color: '#FF9900',
        category: 'cloud',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/sns/'
    },
    aws_dynamodb: {
        id: 'aws_dynamodb',
        name: 'AWS DynamoDB',
        description: 'NoSQL key-value and document database',
        color: '#4053D6',
        category: 'cloud',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/dynamodb/'
    },
    aws_cloudwatch: {
        id: 'aws_cloudwatch',
        name: 'AWS CloudWatch',
        description: 'Monitoring and observability service',
        color: '#FF4F8B',
        category: 'devops',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/cloudwatch/'
    },
    aws_ecs: {
        id: 'aws_ecs',
        name: 'AWS ECS',
        description: 'Elastic Container Service',
        color: '#FF9900',
        category: 'cloud',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/ecs/'
    },
    aws_route53: {
        id: 'aws_route53',
        name: 'AWS Route 53',
        description: 'DNS and domain management',
        color: '#8C4FFF',
        category: 'cloud',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/route53/'
    },

    // ========================================================================
    // Azure Service Breakouts
    // ========================================================================
    azure_devops: {
        id: 'azure_devops',
        name: 'Azure DevOps',
        description: 'Azure DevOps Services (repos, pipelines, boards)',
        color: '#0078D7',
        category: 'developer',
        fields: [
            { key: 'organization', label: 'Organization', type: 'text', required: true, placeholder: 'your-org' },
            { key: 'pat', label: 'Personal Access Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://dev.azure.com/${creds.organization}/_apis/projects?api-version=7.1`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`:${creds.pat}`).toString('base64')}`
        }),
        docs: 'https://learn.microsoft.com/en-us/rest/api/azure/devops/'
    },
    azure_blob: {
        id: 'azure_blob',
        name: 'Azure Blob Storage',
        description: 'Azure object storage service',
        color: '#0078D4',
        category: 'cloud',
        fields: [
            { key: 'account_name', label: 'Storage Account Name', type: 'text', required: true },
            { key: 'account_key', label: 'Account Key', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.account_name || !creds.account_key) return { valid: false, error: 'Account name and key are required' };
            return { valid: true };
        },
        docs: 'https://learn.microsoft.com/en-us/azure/storage/blobs/'
    },
    azure_functions: {
        id: 'azure_functions',
        name: 'Azure Functions',
        description: 'Serverless compute platform',
        color: '#0078D4',
        category: 'cloud',
        fields: [
            { key: 'subscription_id', label: 'Subscription ID', type: 'text', required: true },
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.subscription_id || !creds.client_id || !creds.client_secret) return { valid: false, error: 'Subscription, client ID, and secret are required' };
            return { valid: true };
        },
        docs: 'https://learn.microsoft.com/en-us/azure/azure-functions/'
    },
    azure_cosmos_db: {
        id: 'azure_cosmos_db',
        name: 'Azure Cosmos DB',
        description: 'Globally distributed multi-model database',
        color: '#0078D4',
        category: 'data',
        fields: [
            { key: 'endpoint', label: 'Account Endpoint', type: 'url', required: true, placeholder: 'https://your-account.documents.azure.com:443/' },
            { key: 'primary_key', label: 'Primary Key', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.endpoint || !creds.primary_key) return { valid: false, error: 'Endpoint and primary key are required' };
            return { valid: true };
        },
        docs: 'https://learn.microsoft.com/en-us/azure/cosmos-db/'
    },

    // ========================================================================
    // GCP Service Breakouts
    // ========================================================================
    gcp_cloud_run: {
        id: 'gcp_cloud_run',
        name: 'Google Cloud Run',
        description: 'Serverless container platform',
        color: '#4285F4',
        category: 'cloud',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://cloud.google.com/run/docs'
    },
    gcp_pubsub: {
        id: 'gcp_pubsub',
        name: 'Google Pub/Sub',
        description: 'Messaging and event streaming',
        color: '#4285F4',
        category: 'cloud',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://cloud.google.com/pubsub/docs'
    },
    gcp_cloud_functions: {
        id: 'gcp_cloud_functions',
        name: 'Google Cloud Functions',
        description: 'Serverless functions platform',
        color: '#4285F4',
        category: 'cloud',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://cloud.google.com/functions/docs'
    },
    gcp_storage: {
        id: 'gcp_storage',
        name: 'Google Cloud Storage',
        description: 'Object storage service',
        color: '#4285F4',
        category: 'cloud',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://cloud.google.com/storage/docs'
    },
    vertex_ai: {
        id: 'vertex_ai',
        name: 'Google Vertex AI',
        description: 'Google Cloud ML platform',
        color: '#4285F4',
        category: 'ai',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true },
            { key: 'project_id', label: 'Project ID', type: 'text', required: true },
            { key: 'location', label: 'Location', type: 'text', required: true, default: 'us-central1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://cloud.google.com/vertex-ai/docs'
    },

    // ========================================================================
    // Dev Tools (CI/CD, Code Quality)
    // ========================================================================
    sonarqube: {
        id: 'sonarqube',
        name: 'SonarQube',
        description: 'Code quality and security analysis',
        color: '#4E9BCD',
        category: 'developer',
        fields: [
            { key: 'base_url', label: 'SonarQube URL', type: 'url', required: true, placeholder: 'https://sonarqube.example.com' },
            { key: 'token', label: 'User Token', type: 'password', required: true, prefix: 'squ_', placeholder: 'squ_...' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/authentication/validate`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.token}:`).toString('base64')}`
        }),
        docs: 'https://docs.sonarsource.com/sonarqube/'
    },
    sonarcloud: {
        id: 'sonarcloud',
        name: 'SonarCloud',
        description: 'Cloud-based code quality analysis',
        color: '#F3702A',
        category: 'developer',
        fields: [
            { key: 'token', label: 'Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://sonarcloud.io/api/authentication/validate',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.token}:`).toString('base64')}`
        }),
        docs: 'https://docs.sonarsource.com/sonarcloud/'
    },
    codecov: {
        id: 'codecov',
        name: 'Codecov',
        description: 'Code coverage reporting',
        color: '#F01F7A',
        category: 'developer',
        fields: [
            { key: 'token', label: 'Global Upload Token', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.token) return { valid: false, error: 'Upload token is required' };
            return { valid: true };
        },
        docs: 'https://docs.codecov.com/'
    },
    buildkite: {
        id: 'buildkite',
        name: 'Buildkite',
        description: 'CI/CD platform for scalable pipelines',
        color: '#14CC80',
        category: 'developer',
        fields: [
            { key: 'api_token', label: 'API Access Token', type: 'password', required: true, prefix: 'bkua_', placeholder: 'bkua_...' }
        ],
        testEndpoint: 'https://api.buildkite.com/v2/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://buildkite.com/docs/apis/rest-api'
    },
    teamcity: {
        id: 'teamcity',
        name: 'TeamCity',
        description: 'JetBrains CI/CD server',
        color: '#000000',
        category: 'developer',
        fields: [
            { key: 'base_url', label: 'TeamCity URL', type: 'url', required: true, placeholder: 'https://teamcity.example.com' },
            { key: 'token', label: 'Access Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/app/rest/server`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.token}`,
            'Accept': 'application/json'
        }),
        docs: 'https://www.jetbrains.com/help/teamcity/rest-api.html'
    },
    pulumi: {
        id: 'pulumi',
        name: 'Pulumi',
        description: 'Infrastructure as Code platform',
        color: '#8A3391',
        category: 'developer',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, prefix: 'pul-', placeholder: 'pul-...' }
        ],
        testEndpoint: 'https://api.pulumi.com/api/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `token ${creds.access_token}` }),
        docs: 'https://www.pulumi.com/docs/pulumi-cloud/reference/cloud-rest-api/'
    },
    docker_hub: {
        id: 'docker_hub',
        name: 'Docker Hub',
        description: 'Container image registry',
        color: '#2496ED',
        category: 'developer',
        fields: [
            { key: 'username', label: 'Username', type: 'text', required: true },
            { key: 'access_token', label: 'Personal Access Token', type: 'password', required: true, prefix: 'dckr_pat_', placeholder: 'dckr_pat_...' }
        ],
        testEndpoint: 'https://hub.docker.com/v2/user/login',
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/json' }),
        testBody: (creds) => JSON.stringify({ username: creds.username, password: creds.access_token }),
        docs: 'https://docs.docker.com/docker-hub/api/'
    },
    harbor: {
        id: 'harbor',
        name: 'Harbor',
        description: 'Open source container image registry',
        color: '#60B932',
        category: 'developer',
        fields: [
            { key: 'base_url', label: 'Harbor URL', type: 'url', required: true, placeholder: 'https://harbor.example.com' },
            { key: 'username', label: 'Username', type: 'text', required: true },
            { key: 'password', label: 'Password', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/v2.0/users/current`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
        }),
        docs: 'https://goharbor.io/docs/'
    },

    // ========================================================================
    // API Gateways & Developer Tools
    // ========================================================================
    postman: {
        id: 'postman',
        name: 'Postman',
        description: 'API development and testing platform',
        color: '#FF6C37',
        category: 'developer',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'PMAK-', placeholder: 'PMAK-...' }
        ],
        testEndpoint: 'https://api.getpostman.com/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-API-Key': creds.api_key }),
        docs: 'https://www.postman.com/postman/postman-public-workspace/documentation/12946884/postman-api'
    },
    kong: {
        id: 'kong',
        name: 'Kong',
        description: 'API gateway and service mesh',
        color: '#003459',
        category: 'developer',
        fields: [
            { key: 'admin_url', label: 'Admin API URL', type: 'url', required: true, placeholder: 'http://localhost:8001' },
            { key: 'api_key', label: 'API Key', type: 'password', required: false, placeholder: 'Admin API key (if secured)' }
        ],
        testEndpoint: (creds) => `${creds.admin_url.replace(/\/$/, '')}/status`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.api_key ? ({ 'apikey': creds.api_key }) : ({}),
        docs: 'https://docs.konghq.com/'
    },

    // ========================================================================
    // Communication (more)
    // ========================================================================
    ringcentral: {
        id: 'ringcentral',
        name: 'RingCentral',
        description: 'Cloud communications and phone system',
        color: '#F80',
        category: 'communication',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true },
            { key: 'jwt_token', label: 'JWT Credential', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.client_id || !creds.client_secret) return { valid: false, error: 'Client ID and secret are required' };
            return { valid: true };
        },
        docs: 'https://developers.ringcentral.com/api-reference'
    },
    dialpad: {
        id: 'dialpad',
        name: 'Dialpad',
        description: 'AI-powered communications platform',
        color: '#7C52FF',
        category: 'communication',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://dialpad.com/api/v2/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developers.dialpad.com/'
    },
    telnyx: {
        id: 'telnyx',
        name: 'Telnyx',
        description: 'Telephony and messaging API',
        color: '#00C08B',
        category: 'communication',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'KEY', placeholder: 'KEY...' }
        ],
        testEndpoint: 'https://api.telnyx.com/v2/available_phone_numbers',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developers.telnyx.com/'
    },
    mailjet: {
        id: 'mailjet',
        name: 'Mailjet',
        description: 'Email delivery and marketing',
        color: '#FFC844',
        category: 'communication',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'text', required: true },
            { key: 'secret_key', label: 'Secret Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.mailjet.com/v3/REST/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:${creds.secret_key}`).toString('base64')}`
        }),
        docs: 'https://dev.mailjet.com/'
    },
    pushover: {
        id: 'pushover',
        name: 'Pushover',
        description: 'Push notifications for mobile and desktop',
        color: '#249DF1',
        category: 'notification',
        fields: [
            { key: 'api_token', label: 'Application Token', type: 'password', required: true },
            { key: 'user_key', label: 'User Key', type: 'password', required: true }
        ],
        // VAULT-INTEG P8: Pushover documents a dedicated credential-check
        // endpoint (POST /1/users/validate.json with token+user as form
        // params). It does not send a push and returns a real HTTP 400 on
        // bad credentials, not a 200-with-error-body false positive.
        testEndpoint: 'https://api.pushover.net/1/users/validate.json',
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        testBody: (creds) => new URLSearchParams({ token: creds.api_token, user: creds.user_key }).toString(),
        docs: 'https://pushover.net/api#verification'
    },

    // ========================================================================
    // CRM & Sales
    // ========================================================================
    outreach: {
        id: 'outreach',
        name: 'Outreach',
        description: 'Sales engagement platform',
        color: '#5951FF',
        category: 'crm',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.outreach.io/api/v2/users?page[size]=1',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://api.outreach.io/api/v2/docs'
    },
    apollo: {
        id: 'apollo',
        name: 'Apollo.io',
        description: 'Sales intelligence and engagement',
        color: '#6B57FF',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.apollo.io/v1/auth/health',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-Api-Key': creds.api_key }),
        docs: 'https://apolloio.github.io/apollo-api-docs/'
    },
    clearbit: {
        id: 'clearbit',
        name: 'Clearbit',
        description: 'Business intelligence and data enrichment',
        color: '#3E5BF5',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'sk_', placeholder: 'sk_...' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.api_key) return { valid: false, error: 'API key is required' };
            return { valid: true };
        },
        docs: 'https://dashboard.clearbit.com/docs'
    },
    gong: {
        id: 'gong',
        name: 'Gong',
        description: 'Revenue intelligence and conversation analytics',
        color: '#7C3AED',
        category: 'crm',
        fields: [
            { key: 'access_key', label: 'Access Key', type: 'text', required: true },
            { key: 'access_key_secret', label: 'Access Key Secret', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.gong.io/v2/users',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.access_key}:${creds.access_key_secret}`).toString('base64')}`
        }),
        docs: 'https://gong.app.gong.io/settings/api/documentation'
    },
    salesloft: {
        id: 'salesloft',
        name: 'Salesloft',
        description: 'Sales engagement and workflow platform',
        color: '#00B4D8',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.salesloft.com/v2/me.json',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developers.salesloft.com/api.html'
    },
    zendesk_sell: {
        id: 'zendesk_sell',
        name: 'Zendesk Sell',
        description: 'Sales CRM and pipeline management',
        color: '#03363D',
        category: 'crm',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.getbase.com/v2/users/self',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developer.zendesk.com/api-reference/sales-crm/introduction/'
    },

    // ========================================================================
    // HR & Payroll
    // ========================================================================
    rippling: {
        id: 'rippling',
        name: 'Rippling',
        description: 'HR, IT, and finance platform',
        color: '#FED501',
        category: 'custom',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.rippling.com/platform/api/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developer.rippling.com/'
    },
    deel: {
        id: 'deel',
        name: 'Deel',
        description: 'Global payroll and compliance',
        color: '#15357A',
        category: 'custom',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.letsdeel.com/rest/v2/organizations',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://developer.deel.com/'
    },
    personio: {
        id: 'personio',
        name: 'Personio',
        description: 'HR management and recruiting',
        color: '#00B8A9',
        category: 'custom',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.client_id || !creds.client_secret) return { valid: false, error: 'Client ID and secret are required' };
            return { valid: true };
        },
        docs: 'https://developer.personio.de/reference'
    },
    hibob: {
        id: 'hibob',
        name: 'HiBob',
        description: 'HR platform for modern businesses',
        color: '#FFD100',
        category: 'custom',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true },
            { key: 'service_user_id', label: 'Service User ID', type: 'text', required: true }
        ],
        testEndpoint: 'https://api.hibob.com/v1/profiles',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Basic ${Buffer.from(`${creds.service_user_id}:${creds.api_token}`).toString('base64')}` }),
        docs: 'https://apidocs.hibob.com/'
    },

    // ========================================================================
    // Marketing & Email Marketing
    // ========================================================================
    activecampaign: {
        id: 'activecampaign',
        name: 'ActiveCampaign',
        description: 'Email marketing and CRM automation',
        color: '#356AE6',
        category: 'crm',
        fields: [
            { key: 'base_url', label: 'Account URL', type: 'url', required: true, placeholder: 'https://youraccountname.api-us1.com' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/3/users/me`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Api-Token': creds.api_key }),
        docs: 'https://developers.activecampaign.com/reference/'
    },
    klaviyo: {
        id: 'klaviyo',
        name: 'Klaviyo',
        description: 'Email and SMS marketing automation',
        color: '#000000',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'Private API Key', type: 'password', required: true, prefix: 'pk_', placeholder: 'pk_...' }
        ],
        testEndpoint: 'https://a.klaviyo.com/api/accounts/',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Klaviyo-API-Key ${creds.api_key}`,
            'revision': '2024-10-15'
        }),
        docs: 'https://developers.klaviyo.com/en/reference/'
    },
    braze: {
        id: 'braze',
        name: 'Braze',
        description: 'Customer engagement platform',
        color: '#000000',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'REST API Key', type: 'password', required: true },
            { key: 'rest_endpoint', label: 'REST Endpoint', type: 'url', required: true, placeholder: 'https://rest.iad-01.braze.com' }
        ],
        testEndpoint: (creds) => `${creds.rest_endpoint.replace(/\/$/, '')}/email/hard_bounces?start_date=2020-01-01&end_date=2020-01-02`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://www.braze.com/docs/api/'
    },
    convertkit: {
        id: 'convertkit',
        name: 'Kit (ConvertKit)',
        description: 'Creator-focused email marketing',
        color: '#FB6970',
        category: 'crm',
        fields: [
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://api.convertkit.com/v3/account?api_secret=${creds.api_secret}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://developers.kit.com/v4'
    },
    beehiiv: {
        id: 'beehiiv',
        name: 'beehiiv',
        description: 'Newsletter platform for creators',
        color: '#FFD73C',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.beehiiv.com/v2/publications',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developers.beehiiv.com/'
    },
    customer_io: {
        id: 'customer_io',
        name: 'Customer.io',
        description: 'Automated messaging and customer data',
        color: '#FFD200',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'App API Key', type: 'password', required: true },
            { key: 'site_id', label: 'Site ID', type: 'text', required: true }
        ],
        // VAULT-INTEG P8: Customer.io documents a "test your credentials"
        // GET on the Track API root, Basic-auth'd with site_id:api_key — a
        // real HTTP 401 on bad creds, not a 200-with-error-body false
        // positive.
        testEndpoint: 'https://track.customer.io/auth',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.site_id}:${creds.api_key}`).toString('base64')}`
        }),
        docs: 'https://customer.io/docs/api/'
    },
    google_ads: {
        id: 'google_ads',
        name: 'Google Ads',
        description: 'Google advertising platform',
        color: '#4285F4',
        category: 'social',
        fields: [
            { key: 'developer_token', label: 'Developer Token', type: 'password', required: true },
            { key: 'client_id', label: 'OAuth Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'OAuth Client Secret', type: 'password', required: true },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.developer_token || !creds.client_id) return { valid: false, error: 'Developer token and OAuth credentials are required' };
            return { valid: true };
        },
        docs: 'https://developers.google.com/google-ads/api/docs/start'
    },
    facebook_ads: {
        id: 'facebook_ads',
        name: 'Meta Ads',
        description: 'Facebook and Instagram advertising',
        color: '#1877F2',
        category: 'social',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true },
            { key: 'ad_account_id', label: 'Ad Account ID', type: 'text', required: true, placeholder: 'act_123456789' }
        ],
        testEndpoint: (creds) => `https://graph.facebook.com/v21.0/${creds.ad_account_id}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.facebook.com/docs/marketing-apis'
    },

    // ========================================================================
    // Analytics & Product
    // ========================================================================
    google_analytics: {
        id: 'google_analytics',
        name: 'Google Analytics',
        description: 'Google Analytics 4 (GA4) reporting',
        color: '#E37400',
        category: 'data',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true },
            { key: 'property_id', label: 'GA4 Property ID', type: 'text', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://developers.google.com/analytics/devguides/reporting/data/v1'
    },
    hotjar: {
        id: 'hotjar',
        name: 'Hotjar',
        description: 'Heatmaps, recordings, and feedback',
        color: '#FD3A5C',
        category: 'data',
        fields: [
            { key: 'api_key', label: 'Personal API Key', type: 'password', required: true },
            { key: 'site_id', label: 'Site ID', type: 'text', required: true }
        ],
        testEndpoint: (creds) => `https://api.hotjar.com/v2/sites/${creds.site_id}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developer.hotjar.com/'
    },
    heap: {
        id: 'heap',
        name: 'Heap',
        description: 'Digital analytics and session replay',
        color: '#FF6F61',
        category: 'data',
        fields: [
            { key: 'app_id', label: 'App ID', type: 'text', required: true },
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.app_id || !creds.api_key) return { valid: false, error: 'App ID and API key are required' };
            return { valid: true };
        },
        docs: 'https://developers.heap.io/'
    },
    logrocket: {
        id: 'logrocket',
        name: 'LogRocket',
        description: 'Session replay and error tracking',
        color: '#764ABC',
        category: 'data',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true },
            { key: 'org_slug', label: 'Organization Slug', type: 'text', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.api_key || !creds.org_slug) return { valid: false, error: 'API key and org slug are required' };
            return { valid: true };
        },
        docs: 'https://docs.logrocket.com/'
    },
    plausible: {
        id: 'plausible',
        name: 'Plausible',
        description: 'Privacy-friendly web analytics',
        color: '#5850EC',
        category: 'data',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true },
            { key: 'base_url', label: 'Instance URL', type: 'url', required: false, default: 'https://plausible.io', placeholder: 'https://plausible.io' }
        ],
        testEndpoint: (creds) => `${(creds.base_url || 'https://plausible.io').replace(/\/$/, '')}/api/v1/stats/realtime/visitors?site_id=example.com`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://plausible.io/docs/stats-api'
    },

    // ========================================================================
    // E-Commerce (more)
    // ========================================================================
    squarespace: {
        id: 'squarespace',
        name: 'Squarespace',
        description: 'Website builder and e-commerce platform',
        color: '#000000',
        category: 'ecommerce',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.squarespace.com/1.0/authorization/website',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developers.squarespace.com/'
    },
    lemon_squeezy: {
        id: 'lemon_squeezy',
        name: 'Lemon Squeezy',
        description: 'Payments, tax, and subscriptions for SaaS',
        color: '#FFC233',
        category: 'ecommerce',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.lemonsqueezy.com/v1/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.api_key}`,
            'Accept': 'application/vnd.api+json'
        }),
        docs: 'https://docs.lemonsqueezy.com/api'
    },
    paddle: {
        id: 'paddle',
        name: 'Paddle',
        description: 'Payments and billing for SaaS',
        color: '#003049',
        category: 'ecommerce',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true },
            { key: 'environment', label: 'Environment', type: 'select', required: true, options: ['sandbox', 'production'], default: 'sandbox' }
        ],
        testEndpoint: (creds) => `https://${creds.environment === 'sandbox' ? 'sandbox-' : ''}api.paddle.com/products`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://developer.paddle.com/api-reference/'
    },
    chargebee: {
        id: 'chargebee',
        name: 'Chargebee',
        description: 'Subscription billing and revenue management',
        color: '#FF6633',
        category: 'ecommerce',
        fields: [
            { key: 'site', label: 'Site Name', type: 'text', required: true, placeholder: 'your-site' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://${creds.site}.chargebee.com/api/v2/subscriptions?limit=1`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:`).toString('base64')}`
        }),
        docs: 'https://apidocs.chargebee.com/docs/api/'
    },
    recurly: {
        id: 'recurly',
        name: 'Recurly',
        description: 'Subscription management and billing',
        color: '#F26B33',
        category: 'ecommerce',
        fields: [
            { key: 'api_key', label: 'Private API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://v3.recurly.com/sites',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:`).toString('base64')}`,
            'Accept': 'application/vnd.recurly.v2021-02-25'
        }),
        docs: 'https://developers.recurly.com/'
    },
    gumroad: {
        id: 'gumroad',
        name: 'Gumroad',
        description: 'Digital product sales platform',
        color: '#FF90E8',
        category: 'ecommerce',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://api.gumroad.com/v2/user?access_token=${creds.access_token}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://app.gumroad.com/api'
    },

    // ========================================================================
    // Security & Identity (more)
    // ========================================================================
    hashicorp_consul: {
        id: 'hashicorp_consul',
        name: 'HashiCorp Consul',
        description: 'Service mesh and service discovery',
        color: '#DC477D',
        category: 'security',
        fields: [
            { key: 'base_url', label: 'Consul URL', type: 'url', required: true, placeholder: 'http://localhost:8500' },
            { key: 'token', label: 'ACL Token', type: 'password', required: false }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/v1/agent/self`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.token ? ({ 'X-Consul-Token': creds.token }) : ({}),
        docs: 'https://developer.hashicorp.com/consul/api-docs'
    },
    hashicorp_nomad: {
        id: 'hashicorp_nomad',
        name: 'HashiCorp Nomad',
        description: 'Workload orchestrator',
        color: '#00CA8E',
        category: 'infra',
        fields: [
            { key: 'base_url', label: 'Nomad URL', type: 'url', required: true, placeholder: 'http://localhost:4646' },
            { key: 'token', label: 'ACL Token', type: 'password', required: false }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/v1/agent/self`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.token ? ({ 'X-Nomad-Token': creds.token }) : ({}),
        docs: 'https://developer.hashicorp.com/nomad/api-docs'
    },
    bitwarden: {
        id: 'bitwarden',
        name: 'Bitwarden',
        description: 'Password manager and secrets management',
        color: '#175DDC',
        category: 'security',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true },
            { key: 'base_url', label: 'Server URL', type: 'url', required: false, default: 'https://vault.bitwarden.com' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.client_id || !creds.client_secret) return { valid: false, error: 'Client ID and secret are required' };
            return { valid: true };
        },
        docs: 'https://bitwarden.com/help/public-api/'
    },

    // ========================================================================
    // Storage & CDN
    // ========================================================================
    cloudinary: {
        id: 'cloudinary',
        name: 'Cloudinary',
        description: 'Image and video management platform',
        color: '#3448C5',
        category: 'creative',
        fields: [
            { key: 'cloud_name', label: 'Cloud Name', type: 'text', required: true },
            { key: 'api_key', label: 'API Key', type: 'text', required: true },
            { key: 'api_secret', label: 'API Secret', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://api.cloudinary.com/v1_1/${creds.cloud_name}/usage`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.api_key}:${creds.api_secret}`).toString('base64')}`
        }),
        docs: 'https://cloudinary.com/documentation/'
    },
    backblaze_b2: {
        id: 'backblaze_b2',
        name: 'Backblaze B2',
        description: 'S3-compatible cloud object storage',
        color: '#E21D38',
        category: 'cloud',
        fields: [
            { key: 'application_key_id', label: 'Application Key ID', type: 'text', required: true },
            { key: 'application_key', label: 'Application Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.application_key_id}:${creds.application_key}`).toString('base64')}`
        }),
        docs: 'https://www.backblaze.com/docs/cloud-storage'
    },
    minio: {
        id: 'minio',
        name: 'MinIO',
        description: 'S3-compatible object storage',
        color: '#C72C48',
        category: 'infra',
        fields: [
            { key: 'endpoint', label: 'MinIO Endpoint', type: 'url', required: true, placeholder: 'http://localhost:9000' },
            { key: 'access_key', label: 'Access Key', type: 'text', required: true },
            { key: 'secret_key', label: 'Secret Key', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.endpoint || !creds.access_key || !creds.secret_key) return { valid: false, error: 'Endpoint, access key, and secret key are required' };
            return { valid: true };
        },
        docs: 'https://min.io/docs/minio/linux/developers/minio-drivers.html'
    },
    fastly: {
        id: 'fastly',
        name: 'Fastly',
        description: 'Edge cloud and CDN platform',
        color: '#FF282D',
        category: 'cloud',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.fastly.com/current_customer',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Fastly-Key': creds.api_token }),
        docs: 'https://www.fastly.com/documentation/reference/api/'
    },
    bunny_cdn: {
        id: 'bunny_cdn',
        name: 'Bunny.net',
        description: 'CDN, storage, and edge platform',
        color: '#FF6900',
        category: 'cloud',
        fields: [
            { key: 'api_key', label: 'Account API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.bunny.net/user',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'AccessKey': creds.api_key }),
        docs: 'https://docs.bunny.net/reference/'
    },

    // ========================================================================
    // Productivity & Collaboration
    // ========================================================================
    todoist: {
        id: 'todoist',
        name: 'Todoist',
        description: 'Task management and to-do lists',
        color: '#E44332',
        category: 'custom',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.todoist.com/rest/v2/projects',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://developer.todoist.com/rest/v2/'
    },
    basecamp: {
        id: 'basecamp',
        name: 'Basecamp',
        description: 'Project management and team communication',
        color: '#1D2D35',
        category: 'custom',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true },
            { key: 'account_id', label: 'Account ID', type: 'text', required: true }
        ],
        testEndpoint: 'https://launchpad.37signals.com/authorization.json',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://github.com/basecamp/bc3-api'
    },
    wrike: {
        id: 'wrike',
        name: 'Wrike',
        description: 'Work management and project collaboration',
        color: '#08CF65',
        category: 'custom',
        fields: [
            { key: 'access_token', label: 'Permanent Access Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://www.wrike.com/api/v4/contacts?me=true',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.wrike.com/'
    },
    smartsheet: {
        id: 'smartsheet',
        name: 'Smartsheet',
        description: 'Work management and collaboration platform',
        color: '#0073E6',
        category: 'custom',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.smartsheet.com/2.0/users/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://smartsheet.redoc.ly/'
    },
    coda: {
        id: 'coda',
        name: 'Coda',
        description: 'All-in-one docs and workflow platform',
        color: '#F46A54',
        category: 'documents',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://coda.io/apis/v1/whoami',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://coda.io/developers/apis/v1'
    },
    google_docs: {
        id: 'google_docs',
        name: 'Google Docs',
        description: 'Google Docs document API',
        color: '#4285F4',
        category: 'documents',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://developers.google.com/docs/api'
    },

    // ========================================================================
    // AI/ML (more)
    // ========================================================================
    bedrock: {
        id: 'bedrock',
        name: 'AWS Bedrock',
        description: 'Foundation models as a service',
        color: '#FF9900',
        category: 'ai',
        fields: [
            { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, prefix: 'AKIA', placeholder: 'AKIA...' },
            { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.access_key_id?.startsWith('AKIA')) return { valid: false, error: 'Access Key ID should start with AKIA' };
            return { valid: true };
        },
        docs: 'https://docs.aws.amazon.com/bedrock/'
    },
    ollama: {
        id: 'ollama',
        name: 'Ollama',
        // CLI-QUOX B3: self-hosted by nature (a model server on the operator's LAN), so it uses
        // the existing VAULT-INTEG LAN-target rule: RFC1918 base_url passes ONLY when the
        // operator enables the instance gate `allow_lan_integration_targets` (default off);
        // loopback and link-local stay blocked. The collector separately requires the exact
        // origin in allow_private_origin before calling it (lib/ollamaProvider.js).
        lanAllowed: true,
        description: 'Local LLM server',
        color: '#000000',
        category: 'ai',
        fields: [
            { key: 'base_url', label: 'Ollama URL', type: 'url', required: true, default: 'http://localhost:11434', placeholder: 'http://localhost:11434' },
            // CLI-QUOX B3 (chat provider `ollama`): optional default model for chat, and the
            // explicit private-address allowance the collector requires before calling a LAN
            // host (must equal the origin of base_url; loopback/link-local stay blocked).
            { key: 'default_model', label: 'Default chat model', type: 'text', required: false, placeholder: 'qwen2.5:7b' },
            { key: 'allow_private_origin', label: 'Allow this private address (origin)', type: 'text', required: false, placeholder: 'http://<lan-ip>:11434' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/tags`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://github.com/ollama/ollama/blob/main/docs/api.md'
    },
    // CLI-QUOX B5: OpenAI-compatible chat presets (collector lib/openaiCompatProvider.js).
    // LM Studio and vLLM are self-hosted by nature, so they use the same LAN-target rule as Ollama:
    // an RFC1918/CGNAT base_url is accepted ONLY with the instance gate allow_lan_integration_targets
    // on (default off), and the collector additionally requires the exact origin in
    // allow_private_origin; loopback and link-local stay blocked. The base_url is the server's
    // OpenAI-compatible root (http://<host>:1234 or .../v1; a bare origin is served at /v1).
    lmstudio: {
        id: 'lmstudio',
        name: 'LM Studio',
        lanAllowed: true,
        description: 'Local model server (OpenAI-compatible)',
        color: '#4F46E5',
        category: 'ai',
        fields: [
            { key: 'base_url', label: 'LM Studio server URL', type: 'url', required: true, placeholder: 'http://<lan-ip>:1234' },
            { key: 'default_model', label: 'Default chat model', type: 'text', required: false, placeholder: 'qwen2.5-7b-instruct' },
            { key: 'allow_private_origin', label: 'Allow this private address (origin)', type: 'text', required: false, placeholder: 'http://<lan-ip>:1234' }
        ],
        testEndpoint: (creds) => `${openAiCompatRoot(creds.base_url)}/models`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://lmstudio.ai/docs/app/api/endpoints/openai'
    },
    vllm: {
        id: 'vllm',
        name: 'vLLM',
        lanAllowed: true,
        description: 'Self-hosted inference server (OpenAI-compatible)',
        color: '#30A2FF',
        category: 'ai',
        fields: [
            { key: 'base_url', label: 'vLLM server URL', type: 'url', required: true, placeholder: 'http://<lan-ip>:8000' },
            { key: 'api_key', label: 'API key (if started with --api-key)', type: 'password', required: false, placeholder: 'optional' },
            { key: 'default_model', label: 'Default chat model', type: 'text', required: false, placeholder: 'meta-llama/Llama-3.1-8B-Instruct' },
            { key: 'allow_private_origin', label: 'Allow this private address (origin)', type: 'text', required: false, placeholder: 'http://<lan-ip>:8000' }
        ],
        testEndpoint: (creds) => `${openAiCompatRoot(creds.base_url)}/models`,
        testMethod: 'GET',
        testHeaders: (creds) => (creds.api_key ? { 'Authorization': `Bearer ${creds.api_key}` } : {}),
        docs: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html'
    },
    // CLI-QUOX B5 "custom": any PUBLIC https OpenAI-compatible endpoint, optional key. Not
    // lanAllowed (a server on your own network is what lmstudio/vllm are for); the collector
    // refuses http:// and any non-public address for it at call time.
    openai_compatible: {
        id: 'openai_compatible',
        name: 'OpenAI-compatible endpoint',
        description: 'Any OpenAI-compatible chat API over https',
        color: '#64748B',
        category: 'ai',
        fields: [
            { key: 'base_url', label: 'Base URL (https)', type: 'url', required: true, placeholder: 'https://llm.example.com/v1' },
            { key: 'api_key', label: 'API key', type: 'password', required: false, placeholder: 'optional' },
            { key: 'default_model', label: 'Default chat model', type: 'text', required: false, placeholder: 'model id' }
        ],
        testEndpoint: (creds) => `${openAiCompatRoot(creds.base_url)}/models`,
        testMethod: 'GET',
        testHeaders: (creds) => (creds.api_key ? { 'Authorization': `Bearer ${creds.api_key}` } : {}),
        docs: 'https://platform.openai.com/docs/api-reference/chat'
    },
    langsmith: {
        id: 'langsmith',
        name: 'LangSmith',
        description: 'LLM observability and evaluation',
        color: '#1C3C3C',
        category: 'ai',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'lsv2_', placeholder: 'lsv2_...' }
        ],
        testEndpoint: 'https://api.smith.langchain.com/api/v1/sessions?limit=1',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'x-api-key': creds.api_key }),
        docs: 'https://docs.smith.langchain.com/'
    },
    weights_biases: {
        id: 'weights_biases',
        name: 'Weights & Biases',
        description: 'ML experiment tracking and model registry',
        color: '#FFBE00',
        category: 'ai',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.wandb.ai/graphql',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Basic api:${creds.api_key}`,
            'Content-Type': 'application/json'
        }),
        testBody: JSON.stringify({ query: '{ viewer { id } }' }),
        docs: 'https://docs.wandb.ai/'
    },
    assemblyai: {
        id: 'assemblyai',
        name: 'AssemblyAI',
        description: 'Speech-to-text and audio intelligence',
        color: '#0000FF',
        category: 'ai',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.assemblyai.com/v2/transcript?limit=1',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': creds.api_key }),
        docs: 'https://www.assemblyai.com/docs'
    },
    roboflow: {
        id: 'roboflow',
        name: 'Roboflow',
        description: 'Computer vision model training and deployment',
        color: '#6706CE',
        category: 'ai',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://api.roboflow.com/?api_key=${creds.api_key}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://docs.roboflow.com/'
    },

    // ========================================================================
    // Scheduling
    // ========================================================================
    cal_com: {
        id: 'cal_com',
        name: 'Cal.com',
        description: 'Open-source scheduling platform',
        color: '#292929',
        category: 'custom',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true, prefix: 'cal_', placeholder: 'cal_...' }
        ],
        testEndpoint: 'https://api.cal.com/v2/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://cal.com/docs/api-reference/'
    },
    acuity: {
        id: 'acuity',
        name: 'Acuity Scheduling',
        description: 'Online appointment scheduling',
        color: '#3896E3',
        category: 'custom',
        fields: [
            { key: 'user_id', label: 'User ID', type: 'text', required: true },
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://acuityscheduling.com/api/v1/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.user_id}:${creds.api_key}`).toString('base64')}`
        }),
        docs: 'https://developers.acuityscheduling.com/'
    },

    // ========================================================================
    // IoT & Home Automation
    // ========================================================================
    home_assistant: {
        id: 'home_assistant',
        name: 'Home Assistant',
        lanAllowed: true,
        description: 'Open-source home automation',
        color: '#41BDF5',
        category: 'infra',
        fields: [
            { key: 'base_url', label: 'Home Assistant URL', type: 'url', required: true, placeholder: 'http://homeassistant.local:8123' },
            { key: 'access_token', label: 'Long-Lived Access Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://developers.home-assistant.io/docs/api/rest/'
    },
    mqtt: {
        id: 'mqtt',
        name: 'MQTT',
        description: 'MQTT message broker',
        color: '#660066',
        category: 'infra',
        fields: [
            { key: 'broker_url', label: 'Broker URL', type: 'text', required: true, placeholder: 'mqtt://broker.example.com:1883' },
            { key: 'username', label: 'Username', type: 'text', required: false },
            { key: 'password', label: 'Password', type: 'password', required: false }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.broker_url) return { valid: false, error: 'Broker URL is required' };
            return { valid: true };
        },
        docs: 'https://mqtt.org/mqtt-specification/'
    },

    // ========================================================================
    // Advertising & Marketing (more)
    // ========================================================================
    linkedin_ads: {
        id: 'linkedin_ads',
        name: 'LinkedIn Ads',
        description: 'LinkedIn advertising and campaign management',
        color: '#0A66C2',
        category: 'social',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true },
            { key: 'ad_account_id', label: 'Ad Account ID', type: 'text', required: true }
        ],
        testEndpoint: 'https://api.linkedin.com/v2/userinfo',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://learn.microsoft.com/en-us/linkedin/marketing/'
    },
    tiktok_ads: {
        id: 'tiktok_ads',
        name: 'TikTok Ads',
        description: 'TikTok advertising platform',
        color: '#000000',
        category: 'social',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true },
            { key: 'advertiser_id', label: 'Advertiser ID', type: 'text', required: true }
        ],
        testEndpoint: 'https://business-api.tiktok.com/open_api/v1.3/user/info/',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Access-Token': creds.access_token }),
        docs: 'https://business-api.tiktok.com/portal/docs'
    },
    marketo: {
        id: 'marketo',
        name: 'Marketo',
        description: 'B2B marketing automation (Adobe)',
        color: '#5C4C9F',
        category: 'crm',
        fields: [
            { key: 'munchkin_id', label: 'Munchkin ID', type: 'text', required: true, placeholder: '123-ABC-456' },
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.munchkin_id || !creds.client_id || !creds.client_secret) return { valid: false, error: 'Munchkin ID, client ID, and secret are required' };
            return { valid: true };
        },
        docs: 'https://developers.marketo.com/rest-api/'
    },
    iterable: {
        id: 'iterable',
        name: 'Iterable',
        description: 'Cross-channel marketing platform',
        color: '#6747ED',
        category: 'crm',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.iterable.com/api/channels',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Api-Key': creds.api_key }),
        docs: 'https://api.iterable.com/api/docs'
    },

    // ========================================================================
    // Support & Service Desk (more)
    // ========================================================================
    jira_sm: {
        id: 'jira_sm',
        name: 'Jira Service Management',
        description: 'Atlassian ITSM and service desk',
        color: '#0052CC',
        category: 'developer',
        fields: [
            { key: 'email', label: 'Email', type: 'email', required: true },
            { key: 'api_token', label: 'API Token', type: 'password', required: true },
            { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'your-company.atlassian.net' }
        ],
        testEndpoint: (creds) => `https://${creds.domain}/rest/servicedeskapi/info`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64')}`
        }),
        docs: 'https://developer.atlassian.com/cloud/jira/service-desk/rest/intro/'
    },
    statuspage: {
        id: 'statuspage',
        name: 'Statuspage',
        description: 'Atlassian status and incident communication',
        color: '#2684FF',
        category: 'devops',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true },
            { key: 'page_id', label: 'Page ID', type: 'text', required: true }
        ],
        testEndpoint: (creds) => `https://api.statuspage.io/v1/pages/${creds.page_id}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `OAuth ${creds.api_key}` }),
        docs: 'https://developer.statuspage.io/'
    },

    // ========================================================================
    // Feature Flags & Experimentation
    // ========================================================================
    split: {
        id: 'split',
        name: 'Split',
        description: 'Feature flagging and experimentation',
        color: '#01B286',
        category: 'developer',
        fields: [
            { key: 'api_key', label: 'Admin API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.split.io/internal/api/v2/workspaces',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://docs.split.io/reference/introduction-to-admin-api'
    },
    flagsmith: {
        id: 'flagsmith',
        name: 'Flagsmith',
        description: 'Open-source feature flag management',
        color: '#3D4CDB',
        category: 'developer',
        fields: [
            { key: 'api_key', label: 'Environment Key', type: 'password', required: true },
            { key: 'base_url', label: 'API URL', type: 'url', required: false, default: 'https://edge.api.flagsmith.com/api/v1' }
        ],
        testEndpoint: (creds) => `${(creds.base_url || 'https://edge.api.flagsmith.com/api/v1').replace(/\/$/, '')}/flags/`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-Environment-Key': creds.api_key }),
        docs: 'https://docs.flagsmith.com/'
    },
    unleash: {
        id: 'unleash',
        name: 'Unleash',
        description: 'Open-source feature management',
        color: '#1A4049',
        category: 'developer',
        fields: [
            { key: 'base_url', label: 'Unleash URL', type: 'url', required: true, placeholder: 'https://unleash.example.com' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/admin/features`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': creds.api_token }),
        docs: 'https://docs.getunleash.io/reference/api/'
    },

    // ========================================================================
    // Error & Log Management
    // ========================================================================
    bugsnag: {
        id: 'bugsnag',
        name: 'Bugsnag',
        description: 'Error monitoring and stability management',
        color: '#4949E4',
        category: 'devops',
        fields: [
            { key: 'auth_token', label: 'Personal Auth Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.bugsnag.com/user/organizations',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `token ${creds.auth_token}` }),
        docs: 'https://bugsnagapiv2.docs.apiary.io/'
    },
    rollbar: {
        id: 'rollbar',
        name: 'Rollbar',
        description: 'Error tracking and monitoring',
        color: '#2980B9',
        category: 'devops',
        fields: [
            { key: 'access_token', label: 'Account Access Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.rollbar.com/api/1/projects',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-Rollbar-Access-Token': creds.access_token }),
        docs: 'https://docs.rollbar.com/reference/'
    },
    logdna: {
        id: 'logdna',
        name: 'Mezmo (LogDNA)',
        description: 'Log management and analysis',
        color: '#0072F5',
        category: 'devops',
        fields: [
            { key: 'service_key', label: 'Service Key', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.service_key) return { valid: false, error: 'Service key is required' };
            return { valid: true };
        },
        docs: 'https://docs.mezmo.com/'
    },
    papertrail: {
        id: 'papertrail',
        name: 'Papertrail',
        description: 'Cloud-hosted log management',
        color: '#279BDA',
        category: 'devops',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://papertrailapp.com/api/v1/systems.json',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-Papertrail-Token': creds.api_token }),
        docs: 'https://www.papertrail.com/help/api/'
    },

    // ========================================================================
    // Payment & Fintech (more)
    // ========================================================================
    wise: {
        id: 'wise',
        name: 'Wise',
        description: 'International money transfers API',
        color: '#9FE870',
        category: 'ecommerce',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.wise.com/v1/profiles',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.wise.com/'
    },
    mercury: {
        id: 'mercury',
        name: 'Mercury',
        description: 'Banking for startups',
        color: '#5B5FED',
        category: 'ecommerce',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.mercury.com/api/v1/accounts',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.mercury.com/reference/'
    },

    // ========================================================================
    // Notifications & Webhooks
    // ========================================================================
    ntfy: {
        id: 'ntfy',
        name: 'ntfy',
        description: 'Simple HTTP-based push notifications',
        color: '#317F6F',
        category: 'notification',
        fields: [
            { key: 'base_url', label: 'Server URL', type: 'url', required: false, default: 'https://ntfy.sh', placeholder: 'https://ntfy.sh' },
            { key: 'token', label: 'Access Token', type: 'password', required: false, placeholder: 'tk_...' }
        ],
        testEndpoint: (creds) => `${(creds.base_url || 'https://ntfy.sh').replace(/\/$/, '')}/v1/health`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.token ? ({ 'Authorization': `Bearer ${creds.token}` }) : ({}),
        docs: 'https://docs.ntfy.sh/'
    },
    slack_webhook: {
        id: 'slack_webhook',
        name: 'Slack Webhook',
        description: 'Slack incoming webhook for notifications',
        color: '#4A154B',
        category: 'notification',
        fields: [
            { key: 'webhook_url', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://hooks.slack.com/services/...' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.webhook_url?.includes('hooks.slack.com')) return { valid: false, error: 'Must be a valid Slack webhook URL' };
            return { valid: true };
        },
        docs: 'https://api.slack.com/messaging/webhooks'
    },
    discord_webhook: {
        id: 'discord_webhook',
        name: 'Discord Webhook',
        description: 'Discord channel webhook for notifications',
        color: '#5865F2',
        category: 'notification',
        fields: [
            { key: 'webhook_url', label: 'Webhook URL', type: 'password', required: true, placeholder: 'https://discord.com/api/webhooks/...' }
        ],
        // VAULT-INTEG P8: unlike Slack/Google Chat webhooks (POST-only, no
        // safe probe — see slack_webhook / 'google-chat' above), Discord's
        // webhook resource documents a GET on the webhook URL itself
        // ("Get Webhook") that returns the webhook object, 404s if
        // deleted/invalid, and never posts a message — a real,
        // side-effect-free live check.
        testEndpoint: (creds) => creds.webhook_url,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://discord.com/developers/docs/resources/webhook#get-webhook'
    },

    // ========================================================================
    // Forms & Surveys (more)
    // ========================================================================
    google_forms: {
        id: 'google_forms',
        name: 'Google Forms',
        description: 'Google Forms API',
        color: '#673AB7',
        category: 'documents',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://developers.google.com/forms/api'
    },
    tally: {
        id: 'tally',
        name: 'Tally',
        description: 'Simple online form builder',
        color: '#000000',
        category: 'documents',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.tally.so/me',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://tally.so/help/webhooks'
    },

    // ========================================================================
    // Cloud Platforms (more)
    // ========================================================================
    heroku: {
        id: 'heroku',
        name: 'Heroku',
        description: 'Cloud application platform',
        color: '#430098',
        category: 'cloud',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.heroku.com/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.api_key}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        }),
        docs: 'https://devcenter.heroku.com/articles/platform-api-reference'
    },
    scaleway: {
        id: 'scaleway',
        name: 'Scaleway',
        description: 'European cloud infrastructure',
        color: '#4F0599',
        category: 'cloud',
        fields: [
            { key: 'access_key', label: 'Access Key', type: 'text', required: true, prefix: 'SCW', placeholder: 'SCW...' },
            { key: 'secret_key', label: 'Secret Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.scaleway.com/account/v3/projects',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-Auth-Token': creds.secret_key }),
        docs: 'https://www.scaleway.com/en/developers/api/'
    },
    upcloud: {
        id: 'upcloud',
        name: 'UpCloud',
        description: 'European cloud infrastructure',
        color: '#7B00FF',
        category: 'cloud',
        fields: [
            { key: 'username', label: 'Username', type: 'text', required: true },
            { key: 'password', label: 'Password', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.upcloud.com/1.3/account',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
        }),
        docs: 'https://developers.upcloud.com/'
    },

    // ========================================================================
    // Misc / High-Value
    // ========================================================================
    twitch: {
        id: 'twitch',
        name: 'Twitch',
        description: 'Twitch streaming and chat API',
        color: '#9146FF',
        category: 'social',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: false, placeholder: 'Only for the connector OAuth client-credentials flow' },
            { key: 'access_token', label: 'Access Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.twitch.tv/helix/users',
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'Authorization': `Bearer ${creds.access_token}`,
            'Client-Id': creds.client_id
        }),
        docs: 'https://dev.twitch.tv/docs/api/'
    },
    spotify: {
        id: 'spotify',
        name: 'Spotify',
        description: 'Spotify Web API for music data',
        color: '#1DB954',
        category: 'social',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true }
        ],
        // VAULT-INTEG P8: Client Credentials Flow (same documented shape
        // already used by the azure/power_automate entries below/above):
        // the token exchange returns a real HTTP 400 on a bad
        // client_id/client_secret pair, not a 200-with-error-body false
        // positive.
        testEndpoint: 'https://accounts.spotify.com/api/token',
        testMethod: 'POST',
        testHeaders: (creds) => ({
            'Authorization': `Basic ${Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }),
        testBody: () => new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        docs: 'https://developer.spotify.com/documentation/web-api'
    },
    open_meteo: {
        id: 'open_meteo',
        name: 'Open-Meteo',
        description: 'Free weather API (no key required)',
        color: '#FF6B35',
        category: 'custom',
        fields: [],
        testEndpoint: 'https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&current_weather=true',
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://open-meteo.com/en/docs'
    },
    ip_api: {
        id: 'ip_api',
        name: 'ip-api',
        description: 'IP geolocation API',
        color: '#2196F3',
        category: 'custom',
        fields: [],
        testEndpoint: 'http://ip-api.com/json/',
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://ip-api.com/docs'
    },
    wolfram_alpha: {
        id: 'wolfram_alpha',
        name: 'Wolfram Alpha',
        description: 'Computational knowledge engine',
        color: '#DD1100',
        category: 'ai',
        fields: [
            { key: 'app_id', label: 'App ID', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://api.wolframalpha.com/v2/query?appid=${creds.app_id}&input=1%2B1&output=json`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://products.wolframalpha.com/api'
    },
    imgbb: {
        id: 'imgbb',
        name: 'ImgBB',
        description: 'Image hosting and sharing API',
        color: '#3DB36B',
        category: 'creative',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.api_key) return { valid: false, error: 'API key is required' };
            return { valid: true };
        },
        docs: 'https://api.imgbb.com/'
    },
    uptimerobot: {
        id: 'uptimerobot',
        name: 'UptimeRobot',
        description: 'Website uptime monitoring',
        color: '#3BD671',
        category: 'devops',
        fields: [
            { key: 'api_key', label: 'API Key', type: 'password', required: true }
        ],
        testEndpoint: 'https://api.uptimerobot.com/v2/getAccountDetails',
        testMethod: 'POST',
        testHeaders: () => ({ 'Content-Type': 'application/json' }),
        testBody: (creds) => JSON.stringify({ api_key: creds.api_key }),
        docs: 'https://uptimerobot.com/api/'
    },
    betterstack: {
        id: 'betterstack',
        name: 'Better Stack',
        description: 'Uptime monitoring, logging, and incident management',
        color: '#000000',
        category: 'devops',
        fields: [
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: 'https://uptime.betterstack.com/api/v2/monitors',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://betterstack.com/docs/uptime/api/getting-started-with-uptime-api/'
    },
    google_meet: {
        id: 'google_meet',
        name: 'Google Meet',
        description: 'Google Meet video conferencing API',
        color: '#00897B',
        category: 'communication',
        fields: [
            { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            try { const p = JSON.parse(creds.service_account_json); if (!p.client_email) return { valid: false, error: 'Invalid service account JSON' }; return { valid: true }; }
            catch (e) { return { valid: false, error: 'Invalid JSON format' }; }
        },
        docs: 'https://developers.google.com/meet/api'
    },
    microsoft_365: {
        id: 'microsoft_365',
        name: 'Microsoft 365',
        description: 'Microsoft Graph API for 365 services',
        color: '#0078D4',
        category: 'documents',
        fields: [
            { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true },
            { key: 'client_id', label: 'Application (Client) ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.tenant_id || !creds.client_id || !creds.client_secret) return { valid: false, error: 'Tenant ID, client ID, and secret are required' };
            return { valid: true };
        },
        docs: 'https://learn.microsoft.com/en-us/graph/overview'
    },
    mapbox: {
        id: 'mapbox',
        name: 'Mapbox',
        description: 'Maps and location APIs',
        color: '#4264FB',
        category: 'custom',
        fields: [
            { key: 'access_token', label: 'Access Token', type: 'password', required: true, prefix: 'pk.', placeholder: 'pk.ey...' }
        ],
        testEndpoint: (creds) => `https://api.mapbox.com/tokens/v2?access_token=${creds.access_token}`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://docs.mapbox.com/api/'
    },
    airtable_personal: {
        id: 'airtable_personal',
        name: 'Airtable (Personal Token)',
        description: 'Airtable personal access token auth',
        color: '#18BFFF',
        category: 'data',
        fields: [
            { key: 'personal_token', label: 'Personal Access Token', type: 'password', required: true, prefix: 'pat', placeholder: 'pat...' }
        ],
        testEndpoint: 'https://api.airtable.com/v0/meta/whoami',
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.personal_token}` }),
        docs: 'https://airtable.com/developers/web/api/introduction'
    },
    vercel_blob: {
        id: 'vercel_blob',
        name: 'Vercel Blob',
        description: 'Vercel edge-first object storage',
        color: '#000000',
        category: 'cloud',
        fields: [
            { key: 'token', label: 'Blob Read/Write Token', type: 'password', required: true, prefix: 'vercel_blob_rw_', placeholder: 'vercel_blob_rw_...' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.token?.startsWith('vercel_blob_rw_')) return { valid: false, error: 'Token should start with vercel_blob_rw_' };
            return { valid: true };
        },
        docs: 'https://vercel.com/docs/storage/vercel-blob'
    },
    sanity: {
        id: 'sanity',
        name: 'Sanity',
        description: 'Structured content platform (headless CMS)',
        color: '#F03E2F',
        category: 'documents',
        fields: [
            { key: 'project_id', label: 'Project ID', type: 'text', required: true },
            { key: 'token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://${creds.project_id}.api.sanity.io/v2024-01-01/data/query/production?query=*%5B_type%3D%3D%22__ping__%22%5D`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://www.sanity.io/docs/http-api'
    },
    contentful: {
        id: 'contentful',
        name: 'Contentful',
        description: 'Headless content management platform',
        color: '#2478CC',
        category: 'documents',
        fields: [
            { key: 'space_id', label: 'Space ID', type: 'text', required: true },
            { key: 'access_token', label: 'Content Delivery API Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://cdn.contentful.com/spaces/${creds.space_id}`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.access_token}` }),
        docs: 'https://www.contentful.com/developers/docs/'
    },
    strapi: {
        id: 'strapi',
        name: 'Strapi',
        description: 'Open-source headless CMS',
        color: '#4945FF',
        category: 'documents',
        fields: [
            { key: 'base_url', label: 'Strapi URL', type: 'url', required: true, placeholder: 'http://localhost:1337' },
            { key: 'api_token', label: 'API Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/users/me`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_token}` }),
        docs: 'https://docs.strapi.io/dev-docs/api/rest'
    },
    directus: {
        id: 'directus',
        name: 'Directus',
        description: 'Open-source data platform and headless CMS',
        color: '#6644FF',
        category: 'documents',
        fields: [
            { key: 'base_url', label: 'Directus URL', type: 'url', required: true, placeholder: 'https://your-instance.directus.app' },
            { key: 'token', label: 'Static Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/users/me`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://docs.directus.io/reference/introduction.html'
    },
    ghost: {
        id: 'ghost',
        name: 'Ghost',
        description: 'Publishing and newsletter platform',
        color: '#15171A',
        category: 'documents',
        fields: [
            { key: 'base_url', label: 'Ghost URL', type: 'url', required: true, placeholder: 'https://your-site.ghost.io' },
            { key: 'admin_api_key', label: 'Admin API Key', type: 'password', required: true, placeholder: 'id:secret format' }
        ],
        testEndpoint: null,
        validateCredentials: (creds) => {
            if (!creds.base_url || !creds.admin_api_key) return { valid: false, error: 'URL and admin API key are required' };
            if (!creds.admin_api_key.includes(':')) return { valid: false, error: 'Admin API key must be in id:secret format' };
            return { valid: true };
        },
        docs: 'https://ghost.org/docs/admin-api/'
    },
    algolia_search: {
        id: 'algolia_search',
        name: 'Algolia Search',
        description: 'Algolia search API with search-only key',
        color: '#003DFF',
        category: 'data',
        fields: [
            { key: 'app_id', label: 'Application ID', type: 'text', required: true },
            { key: 'admin_key', label: 'Admin API Key', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `https://${creds.app_id}-dsn.algolia.net/1/keys`,
        testMethod: 'GET',
        testHeaders: (creds) => ({
            'X-Algolia-Application-Id': creds.app_id,
            'X-Algolia-API-Key': creds.admin_key
        }),
        docs: 'https://www.algolia.com/doc/rest-api/search/'
    },
    typesense: {
        id: 'typesense',
        name: 'Typesense',
        description: 'Open-source search engine',
        color: '#D63AF9',
        category: 'data',
        fields: [
            { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'your-cluster.a1.typesense.net' },
            { key: 'api_key', label: 'API Key', type: 'password', required: true },
            { key: 'port', label: 'Port', type: 'text', required: false, default: '443' }
        ],
        testEndpoint: (creds) => `https://${creds.host}:${creds.port || '443'}/health`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'X-TYPESENSE-API-KEY': creds.api_key }),
        docs: 'https://typesense.org/docs/'
    },
    meilisearch: {
        id: 'meilisearch',
        name: 'Meilisearch',
        description: 'Lightning-fast search engine',
        color: '#FF5CAA',
        category: 'data',
        fields: [
            { key: 'host', label: 'Meilisearch URL', type: 'url', required: true, placeholder: 'http://localhost:7700' },
            { key: 'api_key', label: 'Master Key', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.host.replace(/\/$/, '')}/health`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.api_key}` }),
        docs: 'https://www.meilisearch.com/docs/reference/api/'
    },
    zep: {
        id: 'zep',
        name: 'Zep',
        description: 'Long-term memory for AI assistants',
        color: '#6C47FF',
        category: 'ai',
        fields: [
            { key: 'api_url', label: 'Zep API URL', type: 'url', required: true, default: 'http://localhost:8000', placeholder: 'http://localhost:8000' },
            { key: 'api_key', label: 'API Key', type: 'password', required: false }
        ],
        testEndpoint: (creds) => `${creds.api_url.replace(/\/$/, '')}/healthz`,
        testMethod: 'GET',
        testHeaders: (creds) => creds.api_key ? ({ 'Authorization': `Bearer ${creds.api_key}` }) : ({}),
        docs: 'https://docs.getzep.com/'
    },
    windmill: {
        id: 'windmill',
        name: 'Windmill',
        description: 'Open-source developer platform for scripts and workflows',
        color: '#3B82F6',
        category: 'automation',
        fields: [
            { key: 'base_url', label: 'Windmill URL', type: 'url', required: true, placeholder: 'https://app.windmill.dev' },
            { key: 'token', label: 'User Token', type: 'password', required: true }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/users/whoami`,
        testMethod: 'GET',
        testHeaders: (creds) => ({ 'Authorization': `Bearer ${creds.token}` }),
        docs: 'https://app.windmill.dev/openapi.html'
    },

    // ============================================================================
    // NOC Infrastructure (NQ-1)
    // ============================================================================

    wazuh: {
        id: 'wazuh',
        name: 'Wazuh',
        lanAllowed: true,
        description: 'Open source security monitoring (SIEM/XDR)',
        color: '#00A9E5',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'Wazuh API URL', type: 'url', required: true, placeholder: 'https://wazuh-host:55000' },
            { key: 'username', label: 'API Username', type: 'text', required: true, placeholder: 'wazuh-wui' },
            { key: 'password', label: 'API Password', type: 'password', required: true, placeholder: 'Your Wazuh API password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/security/user/authenticate`,
        testMethod: 'POST',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://documentation.wazuh.com/current/user-manual/api/reference.html'
    },
    mikrotik_routeros: {
        id: 'mikrotik_routeros',
        name: 'MikroTik RouterOS',
        lanAllowed: true,
        description: 'Network router and switch management',
        color: '#293239',
        category: 'infra',
        fields: [
            { key: 'base_url', label: 'Router API URL', type: 'url', required: true, placeholder: 'https://198.51.100.1' },
            { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'admin' },
            { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Your RouterOS password' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/rest/system/identity`,
        testMethod: 'GET',
        testHeaders: (creds) => {
            const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
            return { 'Authorization': `Basic ${auth}` };
        },
        docs: 'https://help.mikrotik.com/docs/display/ROS/REST+API'
    },
    uptime_kuma: {
        id: 'uptime_kuma',
        name: 'Uptime Kuma',
        lanAllowed: true,
        description: 'Self-hosted uptime monitoring',
        color: '#5CDD8B',
        category: 'devops',
        fields: [
            { key: 'base_url', label: 'Uptime Kuma URL', type: 'url', required: true, placeholder: 'https://status.example.com' },
            { key: 'api_key', label: 'API Key', type: 'password', required: false, placeholder: 'Optional API key for authenticated endpoints' }
        ],
        testEndpoint: (creds) => `${creds.base_url.replace(/\/$/, '')}/api/status-page/heartbeat/default`,
        testMethod: 'GET',
        testHeaders: () => ({}),
        docs: 'https://github.com/louislam/uptime-kuma/wiki/API'
    },
    // QN Phase 1: shared secret for a self-hosted RepoBrain (QuoxNucleus)
    // backend. The row this credential is attached to lives in
    // repobrain_connections; this type entry only lets the existing Vault
    // CRUD (POST /orgs/:orgId/integrations) accept the type. No public
    // testEndpoint: the backend URL is per-connection, so connection
    // testing goes through the collector proxy, not a fixed provider URL.
    repobrain: {
        id: 'repobrain',
        name: 'RepoBrain Backend',
        description: 'Shared secret for a self-hosted RepoBrain (QuoxNucleus) backend',
        color: '#7C5CFF',
        category: 'developer',
        fields: [
            { key: 'shared_secret', label: 'Shared Secret', type: 'password', required: true,
              placeholder: 'Value of REPOBRAIN_SHARED_KEY on the backend host' }
        ],
        validateCredentials: (creds) =>
            (creds.shared_secret || '').length >= 16
                ? { valid: true }
                : { valid: false, message: 'Shared secret must be at least 16 characters' },
    }
};

/**
 * Get a type definition by ID
 */
export function getType(id) {
    return INTEGRATION_TYPES[id] || null;
}

/**
 * List all types (returns array of type objects)
 */
export function listTypes() {
    return Object.values(INTEGRATION_TYPES);
}

/**
 * Get field schema for a type
 */
export function getFieldSchema(typeId) {
    const type = INTEGRATION_TYPES[typeId];
    return type ? type.fields : null;
}

/**
 * Get test configuration for a type (endpoint, method, headers, body)
 */
export function getTestConfig(typeId) {
    const type = INTEGRATION_TYPES[typeId];
    if (!type) return null;
    return {
        testEndpoint: type.testEndpoint,
        testMethod: type.testMethod,
        testHeaders: type.testHeaders,
        testBody: type.testBody,
        testParams: type.testParams,
        validateCredentials: type.validateCredentials
    };
}

/**
 * VAULT-INTEG P8: classify how deep testConnection() can actually verify a
 * saved credential for a given type definition, so callers (the /types
 * route, the health service's result_kind, the frontend badge) never have
 * to re-derive this from testEndpoint truthiness by hand:
 *   - 'live'        — testConnection() makes a real authenticated network
 *                      call against the provider (testEndpoint is set).
 *   - 'format-only'  — no real call is possible (OAuth refresh dance,
 *                      SigV4/signature auth, mTLS, no documented safe
 *                      probe); testConnection() only checks shape via
 *                      validateCredentials().
 *   - 'none'         — neither is configured (e.g. 'custom', whose test
 *                      endpoint is supplied per-save via endpoint_url, not
 *                      the registry).
 *
 * @param {object|null} type - a value from INTEGRATION_TYPES, or null/undefined
 * @returns {'live'|'format-only'|'none'}
 */
export function getTestDepth(type) {
    if (!type) return 'none';
    if (typeof type.testEndpoint === 'function') return 'live';
    if (typeof type.testEndpoint === 'string' && type.testEndpoint.length > 0) return 'live';
    if (typeof type.validateCredentials === 'function') return 'format-only';
    return 'none';
}

/**
 * Integration categories for grouping
 */
export const INTEGRATION_CATEGORIES = {
    ai: { id: 'ai', name: 'AI & ML', description: 'AI and machine learning services' },
    developer: { id: 'developer', name: 'Developer Tools', description: 'Source control, CI/CD, and deployment' },
    cloud: { id: 'cloud', name: 'Cloud Services', description: 'Cloud infrastructure and platforms' },
    automation: { id: 'automation', name: 'Automation', description: 'Workflow and automation tools' },
    messaging: { id: 'messaging', name: 'Messaging', description: 'Communication and messaging platforms' },
    communication: { id: 'communication', name: 'Communication', description: 'Email, SMS, and messaging platforms' },
    social: { id: 'social', name: 'Social Media', description: 'Social media platforms and APIs' },
    documents: { id: 'documents', name: 'Documents & E-Signatures', description: 'Document management and signing' },
    creative: { id: 'creative', name: 'Creative & Design', description: 'Design tools and creative platforms' },
    ecommerce: { id: 'ecommerce', name: 'E-Commerce', description: 'Payment processing and online stores' },
    custom: { id: 'custom', name: 'Custom', description: 'Custom integrations' },
    crm: { id: 'crm', name: 'CRM & Sales', description: 'Customer relationship management and sales tools' },
    data: { id: 'data', name: 'Data & Analytics', description: 'Databases, data warehouses, and BI tools' },
    security: { id: 'security', name: 'Security & Identity', description: 'SSO, authentication, and security tools' },
    devops: { id: 'devops', name: 'DevOps & Observability', description: 'Monitoring, logging, alerting, and infrastructure' },
    infra: { id: 'infra', name: 'Infrastructure', description: 'SSH, bastion, and network management' },
    notification: { id: 'notification', name: 'Notifications', description: 'Notification channels and alerting' },
    browser: { id: 'browser', name: 'Browser & Scraping', description: 'Headless browsers, web scraping, and website login credentials' }
};

/**
 * Get types grouped by category
 */
export function getTypesByCategory(category) {
    return Object.values(INTEGRATION_TYPES).filter(t => (t.category || 'custom') === category);
}

export default INTEGRATION_TYPES;
