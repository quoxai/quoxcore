/**
 * Audit Export Signing — detached Ed25519 signatures for evidence bundles.
 *
 * Produces WARD-compatible canonical payload hashes (reusing WARD's
 * canonicalize + sha256 primitives) so future streams can promote these
 * receipts into the full WARD witness chain without a schema change.
 *
 * Phase: ET-5. Follow-up stream will bridge into services/ward/ witness().
 */

import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign as nodeSign,
    verify as nodeVerify,
} from 'crypto';

import { canonicalize, sha256 } from '../../ward/lib/crypto.js';

export const AUDIT_EXPORT_ALGORITHM = 'ed25519';
export const AUDIT_EXPORT_TOOL_VERSION = '1.0.0';

/**
 * Canonicalise an audit-export payload. Deterministic bytes for the
 * same inputs (key insertion order doesn't matter).
 *
 * @param {object} input
 * @param {Array<object>} input.events        Audit event rows
 * @param {string}        input.org_id
 * @param {object}        input.filters       Applied query filters
 * @param {string}        input.exported_by   User id that triggered the export
 * @param {string}        input.exported_at   ISO timestamp
 * @param {string}        input.tool_version  Schema version
 * @returns {string} canonical UTF-8 payload
 */
export function canonicalizeAuditPayload({
    events,
    org_id,
    filters,
    exported_by,
    exported_at,
    tool_version,
}) {
    const body = {
        events: events || [],
        filters: filters || {},
        org_id,
        exported_by,
        exported_at,
        tool_version: tool_version || AUDIT_EXPORT_TOOL_VERSION,
    };
    return canonicalize(body);
}

/**
 * Generate a new Ed25519 keypair for audit export signing.
 * Keys are returned in PEM form for persistence in instance_config.
 */
export function generateAuditSignerKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
        publicKey:  publicKey.export({ type: 'spki',  format: 'pem' }),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
}

const CFG_PRIVATE_KEY = 'audit_signer_private_key';
const CFG_PUBLIC_KEY  = 'audit_signer_public_key';
const CFG_SIGNER_ID   = 'audit_signer_id';

/**
 * Load the audit signer keypair from instance_config, lazily
 * generating + persisting one on first use.
 *
 * @param {object} db  better-sqlite3 handle (from getDb())
 * @returns {{ publicKey: string, privateKey: string, signerId: string }}
 */
export function loadOrCreateAuditSigner(db) {
    const readCfg = (key) => {
        const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(key);
        return row ? row.value : null;
    };
    const writeCfg = (key, value, description) => {
        db.prepare(`
            INSERT INTO instance_config (key, value, value_type, encrypted, description)
            VALUES (?, ?, 'string', 0, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value, description);
    };

    let publicKey  = readCfg(CFG_PUBLIC_KEY);
    let privateKey = readCfg(CFG_PRIVATE_KEY);
    let signerId   = readCfg(CFG_SIGNER_ID);

    if (!publicKey || !privateKey) {
        const kp = generateAuditSignerKeypair();
        publicKey  = kp.publicKey;
        privateKey = kp.privateKey;
        signerId   = signerId || `audit-signer-${new Date().toISOString().slice(0, 10)}`;
        writeCfg(CFG_PRIVATE_KEY, privateKey, 'Audit export Ed25519 private key (PEM)');
        writeCfg(CFG_PUBLIC_KEY,  publicKey,  'Audit export Ed25519 public key (PEM, publicly readable)');
        writeCfg(CFG_SIGNER_ID,   signerId,   'Audit export signer identity');
    }

    return { publicKey, privateKey, signerId };
}

/**
 * Sign an audit payload. Returns the detached-signature receipt.
 * The receipt carries the payload_hash so verifiers can confirm
 * that the signed payload matches the shipped bundle.
 *
 * @param {string} payload     Canonical payload bytes
 * @param {object} opts
 * @param {string} opts.privateKey  PEM-encoded Ed25519 private key
 * @param {string} opts.signerId    Stable signer identity
 * @param {string} [opts.ts]        Override timestamp (for deterministic tests)
 * @returns {object} evidence receipt
 */
export function signAuditExport(payload, { privateKey, signerId, ts }) {
    if (!privateKey) throw new Error('signAuditExport: privateKey required');
    if (!signerId)   throw new Error('signAuditExport: signerId required');

    const keyObj   = createPrivateKey(privateKey);
    const hashHex  = sha256(payload);
    const message  = Buffer.from(hashHex, 'utf8');
    const sigBuf   = nodeSign(null, message, keyObj);

    return {
        payload_hash: hashHex,
        algorithm:    AUDIT_EXPORT_ALGORITHM,
        signer_id:    signerId,
        ts:           ts || new Date().toISOString(),
        signature:    sigBuf.toString('base64'),
    };
}

/**
 * Verify an evidence receipt against its payload + the signer's public key.
 *
 * @param {object} receipt      The receipt object produced by signAuditExport
 * @param {string} payload      The canonical payload to verify against
 * @param {string} publicKey    PEM-encoded Ed25519 public key
 * @returns {boolean}
 */
export function verifyAuditReceipt(receipt, payload, publicKey) {
    if (!receipt || !publicKey) return false;
    try {
        const expectedHash = sha256(payload);
        if (receipt.payload_hash !== expectedHash) return false;

        const keyObj  = createPublicKey(publicKey);
        const message = Buffer.from(receipt.payload_hash, 'utf8');
        const sigBuf  = Buffer.from(receipt.signature, 'base64');
        return nodeVerify(null, message, keyObj, sigBuf);
    } catch {
        return false;
    }
}
