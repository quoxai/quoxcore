/**
 * Official-plugin signature verification (LICENSE-LAUNCH LL-7).
 *
 * Decides, host-side, whether an installed bundle is genuinely a Quox
 * first-party plugin, which is what unlocks the root-route privilege in
 * thirdPartyPluginHost.activateThirdPartyPlugin. The rule from
 * docs/LL7_LOADER_CONTRACT_PLAN.md is: Quox-signed AND manifest.official, and
 * "never trusted from the manifest alone".
 *
 * The signed artefact is the CANONICAL MANIFEST — every key sorted, the
 * `signature` field removed, SHA-256'd — which is exactly what
 * scripts/sign-plugin.js signs. Verifying the manifest (not the bundle bytes)
 * is what matters here, because the manifest is what declares `official`,
 * `routes` and `sidebar`: the three things the privilege acts on.
 *
 * Failure is always a REFUSAL, never a pass. If WebCrypto has no Ed25519 on
 * this browser we return { official: false, reason: 'crypto_unavailable' } and
 * the plugin loads under the ordinary /plugins/{id}/ namespace. Degrading
 * closed keeps a missing primitive from becoming a privilege escalation.
 */

import { OFFICIAL_SIGNING_KEY_IDS } from '../config/officialSigningKeys';

/**
 * Recursively sort object keys and drop `signature`, matching
 * scripts/sign-plugin.js canonicalSort() byte for byte.
 */
function canonicalSort(value) {
    if (Array.isArray(value)) return value.map(canonicalSort);
    if (value !== null && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            if (key === 'signature') continue;
            sorted[key] = canonicalSort(value[key]);
        }
        return sorted;
    }
    return value;
}

/** The exact JSON string the digest is taken over. Exported for tests. */
export function canonicalManifestJson(manifest) {
    return JSON.stringify(canonicalSort(manifest));
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function subtle() {
    return globalThis.crypto?.subtle || null;
}

/** Base64 SHA-256 of the canonical manifest — the value signature.json's `digest` must equal. */
export async function manifestDigestB64(manifest) {
    const s = subtle();
    if (!s) throw new Error('crypto.subtle unavailable');
    const bytes = new TextEncoder().encode(canonicalManifestJson(manifest));
    const digest = await s.digest('SHA-256', bytes);
    return bytesToBase64(new Uint8Array(digest));
}

/**
 * Verify an install's official status.
 *
 * @param {object} manifest — the manifest as installed (server row / IDB record)
 * @param {object|null} signatureData — parsed signature.json, or null when unsigned
 * @param {{trustedKeyIds?: Set<string>, bundleCode?: string, cssCode?: string|null}} [options] — injectable for tests
 * @returns {Promise<{official: boolean, reason: string, keyId?: string}>}
 *   reason ∈ unsigned · not_official · unsupported_algorithm · untrusted_key ·
 *            digest_mismatch · signature_invalid · crypto_unavailable ·
 *            integrity_missing · integrity_mismatch · ok
 */
export async function isOfficialInstall(manifest, signatureData, options = {}) {
    const trustedKeyIds = options.trustedKeyIds || OFFICIAL_SIGNING_KEY_IDS;

    if (!signatureData || !signatureData.signature || !signatureData.digest || !signatureData.keyId) {
        return { official: false, reason: 'unsigned' };
    }
    if (manifest?.official !== true) {
        return { official: false, reason: 'not_official' };
    }
    if (signatureData.algorithm !== 'Ed25519') {
        return { official: false, reason: 'unsupported_algorithm' };
    }
    if (!trustedKeyIds.has(signatureData.keyId)) {
        return { official: false, reason: 'untrusted_key', keyId: signatureData.keyId };
    }

    // The signature covers the digest, so the digest must be re-derived from
    // the manifest we actually hold. Skipping this would let a valid signature
    // over an OLD manifest bless an edited one.
    let expectedDigest;
    try {
        expectedDigest = await manifestDigestB64(manifest);
    } catch {
        return { official: false, reason: 'crypto_unavailable' };
    }
    if (expectedDigest !== signatureData.digest) {
        return { official: false, reason: 'digest_mismatch' };
    }

    const s = subtle();
    try {
        const key = await s.importKey(
            'raw',
            base64ToBytes(signatureData.keyId),
            { name: 'Ed25519' },
            false,
            ['verify'],
        );
        const ok = await s.verify(
            { name: 'Ed25519' },
            key,
            base64ToBytes(signatureData.signature),
            base64ToBytes(signatureData.digest),
        );
        if (!ok) return { official: false, reason: 'signature_invalid', keyId: signatureData.keyId };
    } catch (err) {
        // NotSupportedError on browsers without Ed25519 in WebCrypto lands
        // here. Named honestly rather than folded into signature_invalid, so
        // the console line tells an operator WHY the plugin lost its route.
        return { official: false, reason: 'crypto_unavailable', detail: err?.message };
    }

    // F2: the signature above covers the manifest only. The manifest's signed
    // `integrity` block is what binds the actual bundle + css bytes, so a genuine
    // manifest+signature cannot be paired with arbitrary JS. Fails closed.
    const integrity = await checkIntegrity(manifest, options.bundleCode, options.cssCode);
    if (!integrity.ok) {
        return { official: false, reason: integrity.reason, keyId: signatureData.keyId };
    }
    return { official: true, reason: 'ok', keyId: signatureData.keyId };
}

async function sha256Hex(text) {
    const s = subtle();
    if (!s) throw new Error('crypto.subtle unavailable');
    const digest = await s.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const HEX64 = /^[0-9a-f]{64}$/;

async function checkIntegrity(manifest, bundleCode, cssCode) {
    const integrity = manifest?.integrity;
    if (!integrity || typeof integrity.bundle_sha256 !== 'string' || !HEX64.test(integrity.bundle_sha256)) {
        return { ok: false, reason: 'integrity_missing' };
    }
    const cssHash = integrity.css_sha256;
    if (cssHash !== null && (typeof cssHash !== 'string' || !HEX64.test(cssHash))) {
        return { ok: false, reason: 'integrity_missing' };
    }
    if (typeof bundleCode !== 'string') return { ok: false, reason: 'integrity_mismatch' };
    const hasCss = typeof cssCode === 'string' && cssCode.length > 0;
    if (cssHash === null && hasCss) return { ok: false, reason: 'integrity_mismatch' };
    if (cssHash !== null && !hasCss) return { ok: false, reason: 'integrity_mismatch' };
    try {
        if ((await sha256Hex(bundleCode)) !== integrity.bundle_sha256) {
            return { ok: false, reason: 'integrity_mismatch' };
        }
        if (cssHash !== null && (await sha256Hex(cssCode)) !== cssHash) {
            return { ok: false, reason: 'integrity_mismatch' };
        }
    } catch {
        return { ok: false, reason: 'integrity_mismatch' };
    }
    return { ok: true };
}

export default { canonicalManifestJson, manifestDigestB64, isOfficialInstall };
