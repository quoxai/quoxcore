/**
 * LAUNCH-SPINE — single owner of the access_token cookie policy.
 *
 * Extracted 2026-07-30 because the policy was written out longhand in three
 * identical blocks in routes/auth.js (login, refresh, org-switch) and a fourth
 * caller was about to be added in routes/mfa.js when MFA verification started
 * re-minting the token. Four copies of a cookie's security attributes is a
 * drift waiting to happen: the day one of them loses `httpOnly` or `sameSite`,
 * nothing fails visibly.
 *
 * The values are unchanged from the three original blocks.
 */

import { readInstanceConfigBoolean } from './instanceConfigOverrides.js';

// Set COOKIE_SECURE=false in environment to allow cookies over HTTP.
export const COOKIE_SECURE =
    process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production';

// VAULT-INTEG P17: instance_config ('cookie_secure', written by the setup
// wizard) wins over the env-derived default above when set. Evaluated at
// call time (not module load) so a wizard write takes effect without a
// restart.
export function resolveCookieSecure() {
    const override = readInstanceConfigBoolean('cookie_secure');
    return override !== null ? override : COOKIE_SECURE;
}

export const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export function accessTokenCookieOptions() {
    return {
        httpOnly: true,
        secure:   resolveCookieSecure(),
        // 'lax' allows top-level navigation while protecting against CSRF on
        // cross-site POST.
        sameSite: 'lax',
        maxAge:   ACCESS_TOKEN_COOKIE_MAX_AGE_MS,
    };
}

export function setAccessTokenCookie(res, accessToken) {
    res.cookie('access_token', accessToken, accessTokenCookieOptions());
}

export default setAccessTokenCookie;
