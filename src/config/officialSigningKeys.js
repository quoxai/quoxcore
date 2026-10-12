/**
 * Official Quox plugin publisher keys.
 *
 * LICENSE-LAUNCH LL-7. A first-party bundle earns two privileges the community
 * plugin format does not get: it may claim a ROOT route (/quoxbox rather than
 * /plugins/quoxbox-macmini/quoxbox) and it lands in the trusted "Official" nav
 * section. Both are granted only when the install carries an Ed25519 signature
 * from one of the keys below AND its manifest declares official === true.
 * The manifest alone proves nothing — anyone can write `"official": true`.
 *
 * These are PUBLIC keys: the raw 32-byte Ed25519 key, base64-encoded, which is
 * the same `keyId` scripts/sign-plugin.js writes into signature.json. Private
 * keys never live in this repo. The build/sign flow reads its private key from
 * outside the working tree (see scripts/build-first-party-plugin.mjs).
 *
 * Adding a key here is a deliberate, reviewed act: it grants root-route reach
 * over the whole dashboard to anything it signs.
 */

export const OFFICIAL_SIGNING_KEYS = [
    {
        // LL-7 pilot signing key, generated 2026-08-28 on the dev box via
        // scripts/generate-signing-key.js. Private half lives at
        // ~/.config/quox/plugin-signing/quox-signing.key, never committed.
        // This is a DEV publisher key, not the production release key: when
        // the release key exists it is added alongside and this one retires.
        keyId: 'SXrktTWt+cOYgtw19j3sKSqgMqRI1Q1nedSb4UYHTgQ=',
        label: 'Quox first-party dev signing key (LL-7 pilot)',
        environment: 'dev',
    },
];

/** Set of accepted publisher key ids, for O(1) membership checks. */
export const OFFICIAL_SIGNING_KEY_IDS = new Set(OFFICIAL_SIGNING_KEYS.map((k) => k.keyId));

export default OFFICIAL_SIGNING_KEYS;
