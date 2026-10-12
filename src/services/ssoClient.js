/**
 * ET-2 Phase D — SSO admin frontend client.
 *
 * Pure validators + provider templates + fetch wrappers.
 */

export const SSO_PROVIDER_KEYS = ['google', 'okta', 'azure', 'oidc', 'saml'];
export const OIDC_PROVIDER_KEYS = ['google', 'okta', 'azure', 'oidc'];
export const SAML_PROVIDER_KEYS = ['saml'];

export function isSamlProviderKey(key) {
    return SAML_PROVIDER_KEYS.includes(key);
}

export function isValidIssuerUrl(input) {
    if (typeof input !== 'string' || !input) return false;
    try {
        const u = new URL(input);
        return u.protocol === 'https:';
    } catch {
        return false;
    }
}

export function isValidHttpsUrl(input) {
    if (typeof input !== 'string' || !input) return false;
    try {
        const u = new URL(input);
        return u.protocol === 'https:';
    } catch {
        return false;
    }
}

export function isValidX509Pem(input) {
    if (typeof input !== 'string' || !input) return false;
    return /-----BEGIN CERTIFICATE-----/.test(input)
        && /-----END CERTIFICATE-----/.test(input);
}

export function isValidEmailDomain(input) {
    if (typeof input !== 'string' || !input) return false;
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input);
}

const TEMPLATES = {
    google: {
        providerKey: 'google',
        displayName: 'Google Workspace',
        issuer:      'https://accounts.google.com',
        authzUrl:    'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl:    'https://oauth2.googleapis.com/token',
        userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        scopes:      ['openid', 'email', 'profile'],
    },
    okta: {
        providerKey: 'okta',
        displayName: 'Okta',
        issuer:      'https://{okta-domain}.okta.com',
        scopes:      ['openid', 'email', 'profile'],
    },
    azure: {
        providerKey: 'azure',
        displayName: 'Microsoft Entra ID',
        issuer:      'https://login.microsoftonline.com/{tenant-id}/v2.0',
        authzUrl:    'https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/authorize',
        tokenUrl:    'https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token',
        scopes:      ['openid', 'email', 'profile'],
    },
    oidc: {
        providerKey: 'oidc',
        displayName: 'Custom OIDC',
        issuer:      '',
        scopes:      ['openid', 'email', 'profile'],
    },
    saml: {
        providerKey:  'saml',
        protocol:     'saml',
        displayName:  'SAML 2.0',
        entityId:     '',
        ssoUrl:       '',
        sloUrl:       '',
        x509Cert:     '',
        nameidFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMap: { email: 'email', firstName: 'givenName', lastName: 'surname', groups: 'groups' },
        groupRoleMap: {},
    },
};

export function providerTemplate(key) {
    return TEMPLATES[key] ? { ...TEMPLATES[key] } : null;
}

async function parseOrEmpty(response) {
    try { return await response.json(); } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────

export async function fetchSsoProviders(orgId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/sso/providers`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchSsoProviders: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.providers || [];
}

export async function createSsoProvider(orgId, input, authFetch) {
    const isSaml = input.protocol === 'saml' || isSamlProviderKey(input.providerKey);
    if (isSaml) {
        if (!input.entityId)                 throw new Error('entity_id is required');
        if (!isValidHttpsUrl(input.ssoUrl))  throw new Error('sso_url must be https://…');
        if (input.sloUrl && !isValidHttpsUrl(input.sloUrl)) {
            throw new Error('slo_url must be https://…');
        }
        if (!isValidX509Pem(input.x509Cert)) throw new Error('x509_cert must be a PEM certificate');
    } else {
        if (!isValidIssuerUrl(input.issuer)) {
            throw new Error(`invalid issuer URL "${input.issuer}" — must be https://…`);
        }
        if (!input.clientId)     throw new Error('client_id is required');
        if (!input.clientSecret) throw new Error('client_secret is required');
    }

    const res = await authFetch(`/api/orgs/${orgId}/sso/providers`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(input),
    });
    if (res.status === 409) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || 'provider_exists');
    }
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `createSsoProvider: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.provider;
}

export async function updateSsoProvider(orgId, providerId, patch, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/sso/providers/${providerId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
    });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `updateSsoProvider: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.provider;
}

export async function deleteSsoProvider(orgId, providerId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/sso/providers/${providerId}`, { method: 'DELETE' });
    if (res.status === 204 || res.ok) return true;
    throw new Error(`deleteSsoProvider: ${res.status}`);
}

export function loginUrlFor(providerId, redirectTo = null) {
    if (!redirectTo) return `/api/sso/providers/${providerId}/login`;
    const params = new URLSearchParams({ redirect_to: redirectTo });
    return `/api/sso/providers/${providerId}/login?${params.toString()}`;
}

/**
 * Given an email address, ask the server whether an SSO provider is
 * configured for its domain. Public, unauthenticated — returns
 * { provider_id: null } when no provider matches.
 *
 * Accepts a plain fetch (no auth) so it can be called from the login
 * page before the user has a session.
 */
export async function fetchSsoDiscovery(email, fetchImpl = globalThis.fetch) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const url = `/api/sso/discover?email=${encodeURIComponent(email)}`;
    const res = await fetchImpl(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || !body.provider_id) return null;
    return body;
}
