/**
 * ET-2 Phase C — SSO-only enforcement helper.
 *
 * Used in the password-login path: if a user's email domain matches
 * an enabled provider with sso_only=1, password login is refused with
 * sso_required and the caller is redirected to the IdP.
 *
 * This is a DOMAIN-level check, not a user-level check — it runs
 * before user lookup to avoid user-existence oracles.
 */

import { findProviderByEmailDomain } from './ssoProviders.js';

export function enforceSsoOnlyForEmail(db, email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const provider = findProviderByEmailDomain(db, email);
    if (!provider) return null;
    if (!provider.sso_only) return null;
    return {
        provider_id:   provider.id,
        provider_key:  provider.provider_key,
        display_name:  provider.display_name || provider.provider_key,
        login_url:     `/api/sso/providers/${provider.id}/login`,
    };
}
