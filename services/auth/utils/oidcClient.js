/**
 * ET-2 Phase B — OIDC HTTP calls (token exchange + userinfo).
 *
 * Pure functions with an injectable `fetchImpl` (defaults to the
 * global fetch). The route layer owns state/provisioning; these
 * helpers own only the protocol I/O so the test suite can exercise
 * them without a real IdP.
 *
 * ID token signature verification is deliberately deferred — userinfo
 * is served under the access token which the IdP validates on each
 * call, so the claims returned there are already IdP-attested. Full
 * JWKS-based ID token verification lands with the discovery phase.
 */

function resolveUrl(explicit, issuer, path) {
    if (explicit) return explicit;
    if (!issuer)  return null;
    return `${issuer.replace(/\/$/, '')}${path}`;
}

export async function exchangeCodeForTokens(provider, {
    code,
    codeVerifier,
    redirectUri,
    clientSecret,
    fetchImpl = globalThis.fetch,
}) {
    if (!code)          throw new Error('code required');
    if (!codeVerifier)  throw new Error('codeVerifier required');
    if (!redirectUri)   throw new Error('redirectUri required');
    if (!clientSecret)  throw new Error('clientSecret required');

    const url = resolveUrl(provider.token_url, provider.issuer, '/token');
    if (!url) throw new Error('provider.token_url (or issuer) required');

    const body = new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri:  redirectUri,
        client_id:     provider.client_id,
        client_secret: clientSecret,
    }).toString();

    const res = await fetchImpl(url, {
        method:  'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept':       'application/json',
        },
        body,
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = payload.error_description || payload.error || `token exchange failed (${res.status})`;
        throw new Error(msg);
    }
    return payload;
}

export async function fetchUserInfo(provider, { accessToken, fetchImpl = globalThis.fetch }) {
    const url = resolveUrl(provider.userinfo_url, provider.issuer, '/userinfo');
    if (!url) throw new Error('provider.userinfo_url (or issuer) required');

    const res = await fetchImpl(url, {
        method:  'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept:        'application/json',
        },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = payload.error_description || payload.error || `userinfo failed (${res.status})`;
        throw new Error(msg);
    }
    return payload;
}
