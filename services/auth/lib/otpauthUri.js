/**
 * LAUNCH-SPINE — build the otpauth:// URI an authenticator app scans.
 *
 * Lives in its own module with no side-effect imports so it can be unit tested
 * without booting the rate limiter or opening the auth DB.
 *
 * Exists as a named, tested helper because the account label was silently
 * broken in production: otplib 13 destructures `label`, and routes/mfa.js
 * passed `accountName`, so the field was ignored and every QR encoded
 * "otpauth://totp/Quox:undefined". The secret and issuer were correct, so TOTP
 * still verified and no test caught it — the defect was visible only to a human
 * reading their authenticator app. Found by live verification 2026-07-30.
 *
 * Any future option rename in otplib now fails a test rather than shipping a
 * cosmetically broken QR.
 */

import { generateURI } from 'otplib';

export const OTPAUTH_ISSUER = 'Quox';

export function buildOtpauthUri({ secret, email }) {
    return generateURI({
        secret,
        issuer: OTPAUTH_ISSUER,
        label:  email,
    });
}

export default buildOtpauthUri;
