/**
 * Plugin signature v2: what the signature binds, in the exact form the
 * QuoxCORE host recomputes. This is the ESM twin of quox-plugin-sdk
 * packages/quox-plugin-vite/src/cli/signature-v2.js (the signer side); the two
 * must stay line-for-line equivalent, so change both together.
 *
 * v1 (quox-plugin-vite 0.2.0) signed only the sha256 of dist/plugin.esm.js, so
 * the manifest (permissions, backend image) and the CSS could be rewritten
 * under a valid signature. v2 signs one canonical JSON payload:
 *
 *   { files: { "plugin.esm.js": <sha256>, "plugin.css": <sha256, if shipped> },
 *     format: "quox-plugin-signature/v2",
 *     manifest_sha256: <sha256 of canonicalJson(manifest minus signature fields)>,
 *     plugin_id: manifest.id,
 *     plugin_version: manifest.version }
 *
 * canonicalJson sorts object keys recursively, keeps array order, drops
 * undefined, and emits no whitespace, so key order and formatting in
 * manifest.json never change the binding. The Ed25519 message is the UTF-8
 * bytes of canonicalJson(payload). A v1 message is always exactly 32 raw
 * digest bytes and a v2 message is always JSON starting with "{", so one
 * signature can never be replayed as the other.
 */
import crypto from 'crypto';

const FORMAT_V2 = 'quox-plugin-signature/v2';
const BUNDLE_FILE = 'plugin.esm.js';
const CSS_FILE = 'plugin.css';
const MANIFEST_EXCLUDED_KEYS = ['signature', 'signatures'];

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
    }
    return JSON.stringify(value);
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function manifestSha256(manifest) {
    const copy = { ...manifest };
    for (const k of MANIFEST_EXCLUDED_KEYS) delete copy[k];
    return sha256Hex(Buffer.from(canonicalJson(copy), 'utf8'));
}

/** The file map the signature must equal: exactly the files that ship. */
function filesMap(bundleSha256, cssSha256) {
    const files = { [BUNDLE_FILE]: bundleSha256 };
    if (cssSha256) files[CSS_FILE] = cssSha256;
    return files;
}

function v2Payload({ manifest, bundleSha256, cssSha256 }) {
    return {
        files: filesMap(bundleSha256, cssSha256),
        format: FORMAT_V2,
        manifest_sha256: manifestSha256(manifest),
        plugin_id: manifest.id,
        plugin_version: manifest.version,
    };
}

function v2Message(payload) {
    return Buffer.from(canonicalJson(payload), 'utf8');
}

export {
    FORMAT_V2, BUNDLE_FILE, CSS_FILE, canonicalJson, sha256Hex, manifestSha256, filesMap, v2Payload, v2Message,
};
