/**
 * ET-2 Phase B — OIDC flow pure helpers.
 *
 * No network, no DB — just crypto + URL construction. The route
 * layer composes these with the state store (ssoAuthState.js) and
 * the real OIDC client (oidcClient.js) to run the full handshake.
 */

import { randomBytes, createHash } from 'crypto';

// RFC 7636 §4.1 — code_verifier is 43-128 chars, unreserved charset.
// 32 random bytes → 43 base64url chars (perfect minimum).
export function generatePkceVerifier() {
    return randomBytes(32).toString('base64url');
}

export function codeChallengeFromVerifier(verifier) {
    return createHash('sha256').update(verifier).digest('base64url');
}

export function generateState() {
    return randomBytes(24).toString('base64url');
}

export function buildAuthzUrl(provider, { state, codeChallenge, redirectUri }) {
    if (!state)         throw new Error('state is required');
    if (!codeChallenge) throw new Error('code_challenge is required');
    if (!redirectUri)   throw new Error('redirect_uri is required');

    const base = provider.authz_url || `${provider.issuer.replace(/\/$/, '')}/authorize`;
    const scopes = Array.isArray(provider.scopes) && provider.scopes.length
        ? provider.scopes
        : ['openid', 'email', 'profile'];

    const url = new URL(base);
    url.searchParams.set('response_type',         'code');
    url.searchParams.set('client_id',             provider.client_id);
    url.searchParams.set('redirect_uri',          redirectUri);
    url.searchParams.set('scope',                 scopes.join(' '));
    url.searchParams.set('state',                 state);
    url.searchParams.set('code_challenge',        codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
}

export function parseCallbackQuery(query) {
    if (query.error) {
        const desc = query.error_description ? `: ${query.error_description}` : '';
        return { code: null, state: query.state || null, error: `${query.error}${desc}` };
    }
    if (!query.code)  return { code: null, state: query.state || null, error: 'missing code in callback' };
    if (!query.state) return { code: null, state: null,                error: 'missing state in callback' };
    return { code: query.code, state: query.state, error: null };
}
