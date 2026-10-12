/**
 * ET-2 Phase B — SSO callback orchestrator.
 *
 * Pure integration layer — composes ssoAuthState + oidcClient +
 * ssoProvisioning. The route layer handles session issuance and
 * cookie setting after this returns.
 */

import { consumeAuthState } from './ssoAuthState.js';
import { getDecryptedClientSecret } from './ssoProviders.js';
import { exchangeCodeForTokens, fetchUserInfo } from './oidcClient.js';
import { provisionSsoUser, upsertSsoSession } from './ssoProvisioning.js';

export async function handleSsoCallback({
    db,
    providerId,
    code,
    state,
    redirectUri,
    fetchImpl,
}) {
    if (!code)  throw new Error('code required');
    if (!state) throw new Error('state required');

    // 1. Consume + validate state.
    const stored = consumeAuthState(db, state);
    if (!stored) {
        throw new Error('state not found, expired, or already used');
    }
    if (stored.provider_id !== providerId) {
        throw new Error('state/provider mismatch');
    }

    // 2. Look up the full provider row (with encrypted secret).
    const providerRow = db.prepare(`
        SELECT id, org_id, client_id, issuer, token_url, userinfo_url, enabled
        FROM sso_providers WHERE id = ?
    `).get(providerId);
    if (!providerRow)         throw new Error('provider not found');
    if (!providerRow.enabled) throw new Error('provider disabled');
    const clientSecret = getDecryptedClientSecret(db, providerId);
    if (!clientSecret) throw new Error('provider client_secret unavailable');

    // 3. Exchange code for tokens.
    const tokens = await exchangeCodeForTokens(providerRow, {
        code,
        codeVerifier: stored.code_verifier,
        redirectUri,
        clientSecret,
        fetchImpl,
    });
    if (!tokens.access_token) {
        throw new Error('token response missing access_token');
    }

    // 4. Fetch userinfo (IdP-validated claims).
    const claims = await fetchUserInfo(providerRow, {
        accessToken: tokens.access_token,
        fetchImpl,
    });

    // 5. Provision (or attach identity to existing user).
    const { userId } = provisionSsoUser(db, {
        providerId,
        orgId:  providerRow.org_id,
        claims,
    });

    // 6. Record the SSO session row.
    upsertSsoSession(db, {
        providerId,
        userId,
        subject: claims.sub,
        email:   claims.email ? String(claims.email).toLowerCase() : null,
    });

    return {
        userId,
        orgId:      providerRow.org_id,
        email:      claims.email ? String(claims.email).toLowerCase() : null,
        redirectTo: stored.redirect_to || '/',
    };
}
