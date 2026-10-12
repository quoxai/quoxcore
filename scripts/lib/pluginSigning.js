/**
 * Shared first-party plugin signing helpers (used by scripts/sign-plugin.js
 * and scripts/resign-first-party-plugins.mjs).
 *
 * F2 (trust-proof-plugin-frame-c1): the signed canonical manifest must bind the
 * bundle and css BYTES, so manifest.integrity is embedded BEFORE signing.
 */
import crypto from 'crypto';

/** Recursively sort keys and drop `signature`; matches src/services/officialPluginSignature.js. */
export function canonicalSort(obj) {
    if (Array.isArray(obj)) return obj.map(canonicalSort);
    if (obj !== null && typeof obj === 'object') {
        const sorted = {};
        for (const key of Object.keys(obj).sort()) {
            if (key === 'signature') continue;
            sorted[key] = canonicalSort(obj[key]);
        }
        return sorted;
    }
    return obj;
}

export function computeDigest(manifest) {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalSort(manifest))).digest('base64');
}

export function sha256Hex(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Return a copy of the manifest with integrity = hashes of the exact bytes. css may be null/undefined. */
export function embedIntegrity(manifest, { bundle, css }) {
    if (!bundle) throw new Error('embedIntegrity: bundle bytes required');
    return {
        ...manifest,
        integrity: {
            bundle_sha256: sha256Hex(bundle),
            css_sha256: css ? sha256Hex(css) : null,
        },
    };
}

/** Sign the canonical manifest digest. privateKey: KeyObject or PEM string. Returns signature.json content. */
export function signManifest(manifest, privateKey) {
    const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
    const digest = computeDigest(manifest);
    const rawPub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
    const keyId = rawPub.slice(rawPub.length - 32).toString('base64');
    const signature = crypto.sign(null, Buffer.from(digest, 'base64'), key).toString('base64');
    return {
        keyId,
        digest,
        signature,
        algorithm: 'Ed25519',
        hashAlgorithm: 'SHA-256',
        timestamp: new Date().toISOString(),
        pluginId: manifest.id,
        pluginVersion: manifest.version,
    };
}
