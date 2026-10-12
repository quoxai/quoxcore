/**
 * lib/licenseVerify.js — LICENSE-ENFORCE LE-2
 *
 * Ed25519 verification for license-key-v2 objects and lease tokens, per the
 * locked wire contract (docs/STREAM_LICENSE_ENFORCE.md §11.1). Fail closed:
 * no trial markers, no HMAC:-prefix accept path, no "no crypto support"
 * accept path — every object must present a real ED25519: signature that
 * verifies against the embedded public key or it is rejected.
 *
 * The real quox.ai signing key ships in LE-3 (LICENSE-ENFORCE is
 * "issuance first, then burn bridges" — this phase builds the verifier
 * against a placeholder constant). Overridable via env LICENSE_PUBLIC_KEY
 * so LE-1 (quox.ai) and tests can inject their own key without a code
 * change here.
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';

// LE-3.0: DEV licensing public key. The private half lives ONLY in
// quox-website api/.env (LICENSE_SIGNING_KEY) — never in any repo. Prod
// cutover mints its own keypair and overrides via env LICENSE_PUBLIC_KEY.
export const LICENSE_PUBLIC_KEY_BASE64 = '/BHDWJ2RPT6UmwnCB2z9CJZ+oJhhYgRkMEc/ZrtYFWw=';

// Ed25519 SubjectPublicKeyInfo DER prefix for a raw 32-byte public key (same
// constant used elsewhere in this service — utils/plugins.js
// verifyPluginSignature() and routes/setup.js PLUGIN_LICENSE_ED25519_SPKI_PREFIX).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const SIG_PREFIX = 'ED25519:';

// SECURITY (LE-AUDIT CRITICAL): the signed payloads are `|`-delimited. Even
// though issuance now restricts client-controlled fields, the verifier ALSO
// enforces field formats so a delimiter can never be smuggled across a field
// boundary and re-partitioned into a higher-entitlement object bearing the
// same signature. A field containing `|` (or a non-ISO date, or a bad plugin
// id) is rejected BEFORE the signature is trusted.
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_ENTITLEMENT_RE = /^[A-Za-z0-9._@=-]{1,64}$/; // allows `quoxchat@orgs=3`
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isSafeId(v) { return typeof v === 'string' && SAFE_ID_RE.test(v); }
function isCleanIsoDate(v) {
  return typeof v === 'string' && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
}
function areSafeEntitlements(a) {
  return Array.isArray(a) && a.every(e => typeof e === 'string' && SAFE_ENTITLEMENT_RE.test(e));
}

// LICENSE-LAUNCH prod-authority cutover: the verifier trusts a LIST of public
// keys, not one, so introducing the production signing key is ADDITIVE — the
// existing key keeps verifying every already-issued licence while the new key
// starts verifying freshly-signed ones. A single-key SWAP would instantly
// invalidate every licence signed by the old key (there are live ones), which
// is the disaster this avoids. Rotation/retirement is then just dropping a key
// from the list after its licences have aged out.
//
// Precedence (first = PRIMARY, used for catalogue signing verification):
//   1. LICENSE_PUBLIC_KEYS  — comma-separated base64 raw keys (the cutover seam)
//   2. LICENSE_PUBLIC_KEY   — single key, back-compat with every prior deploy
//   3. LICENSE_PUBLIC_KEY_BASE64 — the embedded default, trusted unless
//      LICENSE_DROP_EMBEDDED_KEY=1 explicitly retires it (hardening step).
function getTrustedPublicKeysBase64() {
    const keys = [];
    const csv = process.env.LICENSE_PUBLIC_KEYS;
    if (csv) {
        csv.split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => keys.push(k));
    }
    if (process.env.LICENSE_PUBLIC_KEY) keys.push(process.env.LICENSE_PUBLIC_KEY.trim());
    if (process.env.LICENSE_DROP_EMBEDDED_KEY !== '1') keys.push(LICENSE_PUBLIC_KEY_BASE64);
    // Dedupe, preserve order (primary first).
    return [...new Set(keys)];
}

// Back-compat: the single PRIMARY key base64 (first trusted key).
function getPublicKeyBase64() {
    return getTrustedPublicKeysBase64()[0];
}

function buildPublicKey(rawB64) {
    const keyBytes = Buffer.from(rawB64, 'base64');
    return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
        format: 'der',
        type: 'spki',
    });
}

/**
 * The PRIMARY licensing public key as a KeyObject. Exported (LICENSE-LAUNCH
 * LL-4b) so lib/signedCatalog.js verifies the signed product catalogue against
 * exactly the same key material as a licence, through exactly the same env
 * override seam — two key-loading paths would be two things to drift. The
 * catalogue is signed by the primary (current) key; licences may verify against
 * any trusted key (see loadTrustedPublicKeys / verifySignedPayload).
 */
export function loadLicensePublicKey() {
    return buildPublicKey(getPublicKeyBase64());
}

/** All trusted public keys as KeyObjects (primary first). */
export function loadTrustedPublicKeys() {
    return getTrustedPublicKeysBase64().map(buildPublicKey);
}

const loadPublicKey = loadLicensePublicKey;

/**
 * Verify a `payload` string against a `sig` field that MUST be exactly
 * `'ED25519:' + base64(signature)`. No other signature scheme is accepted.
 */
function verifySignedPayload(payload, sig) {
    if (typeof sig !== 'string' || !sig.startsWith(SIG_PREFIX)) {
        return { valid: false, error: 'missing_or_malformed_signature' };
    }

    let pubKeys;
    let sigBytes;
    try {
        pubKeys = loadTrustedPublicKeys();
        sigBytes = Buffer.from(sig.slice(SIG_PREFIX.length), 'base64');
    } catch (err) {
        return { valid: false, error: `verify_setup_failed: ${err.message}` };
    }

    // Valid if the signature verifies against ANY trusted key. Still fail-closed:
    // a signature that matches none is rejected. Additive trust, not a swap.
    const msg = Buffer.from(payload, 'utf-8');
    let lastErr = 'bad_signature';
    for (const pubKey of pubKeys) {
        try {
            if (cryptoVerify(null, msg, pubKey, sigBytes)) return { valid: true }; // Ed25519: no digest algorithm
        } catch (err) {
            // A malformed signature buffer (wrong length etc.) throws rather than
            // returning false — treat identically to a bad signature and keep trying.
            lastErr = `verify_error: ${err.message}`;
        }
    }
    return { valid: false, error: lastErr };
}

/**
 * Verify a license-key-v2 object.
 * Signed payload (exact concat): `v2|` + id + `|` + customer_id + `|` +
 * JSON.stringify(entitlements) + `|` + issued_at + `|` + expires_at.
 *
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyLicenseKeyV2(obj) {
    if (!obj || typeof obj !== 'object') return { valid: false, error: 'missing_object' };

    const { id, customer_id, entitlements, issued_at, expires_at, sig } = obj;
    if (!id || !customer_id || !Array.isArray(entitlements) || !issued_at || !expires_at) {
        return { valid: false, error: 'missing_required_fields' };
    }
    // Delimiter-injection defense: every field that feeds the `|`-joined
    // payload must be free of the delimiter and well-formed.
    if (!isSafeId(id) || !isSafeId(customer_id) || !areSafeEntitlements(entitlements) ||
        !isCleanIsoDate(issued_at) || !isCleanIsoDate(expires_at)) {
        return { valid: false, error: 'malformed_field' };
    }

    const payload = `v2|${id}|${customer_id}|${JSON.stringify(entitlements)}|${issued_at}|${expires_at}`;
    return verifySignedPayload(payload, sig);
}

/**
 * Verify a lease object.
 * Signed payload: `lease1|` + license_id + `|` + instance_id + `|` +
 * JSON.stringify(entitlements) + `|` + issued_at + `|` + expires_at.
 *
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyLease(obj) {
    if (!obj || typeof obj !== 'object') return { valid: false, error: 'missing_object' };

    const { license_id, instance_id, entitlements, issued_at, expires_at, sig } = obj;
    if (!license_id || !instance_id || !Array.isArray(entitlements) || !issued_at || !expires_at) {
        return { valid: false, error: 'missing_required_fields' };
    }
    // Delimiter-injection defense (LE-AUDIT CRITICAL): reject any field that
    // could carry the `|` delimiter or a smuggled sub-payload. This is what
    // makes the "smuggle a paid plugin through instance_id / issued_at" forge
    // fail at verification even if a malformed payload were ever signed.
    if (!isSafeId(license_id) || !isSafeId(instance_id) || !areSafeEntitlements(entitlements) ||
        !isCleanIsoDate(issued_at) || !isCleanIsoDate(expires_at)) {
        return { valid: false, error: 'malformed_field' };
    }

    const payload = `lease1|${license_id}|${instance_id}|${JSON.stringify(entitlements)}|${issued_at}|${expires_at}`;
    return verifySignedPayload(payload, sig);
}

export default { verifyLicenseKeyV2, verifyLease, LICENSE_PUBLIC_KEY_BASE64 };
