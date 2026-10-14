/**
 * widgetEvidenceSigningKey.js: per-org Ed25519 key for QuoxChat evidence
 * bundles (Wave 11). Same custody pattern as lib/devCapabilitySigningKey.js:
 * private key PKCS8 DER hex, encrypted at rest with utils/encryption.js,
 * never leaves this process. Public key is raw 32-byte hex. Signs opaque
 * hex-encoded bytes; the caller supplies the canonical bytes.
 */

import {
    generateKeyPairSync,
    createPrivateKey,
    createPublicKey,
    sign as cryptoSign,
    verify as cryptoVerify,
} from 'crypto';
import { ulid } from '../utils/helpers.js';
import { encrypt, decrypt } from '../utils/encryption.js';

// Constant DER header for an Ed25519 SubjectPublicKeyInfo wrapping a raw
// 32-byte public key (same constant as crystalSigningKey.js / utils/plugins.js).
const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKeyHex(publicKeyObj) {
    const der = publicKeyObj.export({ type: 'spki', format: 'der' });
    // 44-byte SPKI DER = 12-byte prefix + 32-byte raw key.
    return der.subarray(der.length - 32).toString('hex');
}

function toPublicKeyObject(publicKeyHex) {
    return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_DER_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
        format: 'der',
        type: 'spki',
    });
}

function toPrivateKeyObject(privateKeyDerHex) {
    return createPrivateKey({
        key: Buffer.from(privateKeyDerHex, 'hex'),
        format: 'der',
        type: 'pkcs8',
    });
}

function generateKey() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = rawPublicKeyHex(publicKey);
    const privateKeyDerHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
    return { publicKeyHex, privateKeyDerHex };
}

/**
 * Return the org's active DCSK row, generating one on first use.
 * Idempotent + concurrent-safe: on a UNIQUE(org_id, status) violation from a
 * racing request, re-reads the row the other request just inserted rather
 * than erroring.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @returns {{ id: string, org_id: string, key_id: string, algorithm: string,
 *             public_key_hex: string, private_key_encrypted: string,
 *             status: string, created_at: string }}
 */
export function ensureOrgWidgetEvidenceSigningKey(db, orgId) {
    const existing = db.prepare(
        `SELECT * FROM widget_evidence_signing_keys WHERE org_id = ? AND status = 'active'`
    ).get(orgId);
    if (existing) return existing;

    const { publicKeyHex, privateKeyDerHex } = generateKey();
    const row = {
        id: ulid(),
        org_id: orgId,
        key_id: ulid(),
        algorithm: 'Ed25519',
        public_key_hex: publicKeyHex,
        private_key_encrypted: encrypt(privateKeyDerHex),
        status: 'active',
    };

    try {
        db.prepare(
            `INSERT INTO widget_evidence_signing_keys
                (id, org_id, key_id, algorithm, public_key_hex, private_key_encrypted, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(row.id, row.org_id, row.key_id, row.algorithm, row.public_key_hex, row.private_key_encrypted, row.status);
    } catch (err) {
        // UNIQUE(org_id, status) violation — a concurrent request already
        // created the active key for this org. Re-read rather than fail.
        if (/UNIQUE constraint failed/i.test(err.message)) {
            const raced = db.prepare(
                `SELECT * FROM widget_evidence_signing_keys WHERE org_id = ? AND status = 'active'`
            ).get(orgId);
            if (raced) return raced;
        }
        throw err;
    }

    return db.prepare(`SELECT * FROM widget_evidence_signing_keys WHERE id = ?`).get(row.id);
}

/**
 * Sign opaque canonical bytes (hex-encoded) with the org's DCSK, generating
 * the key on first use.
 *
 * This function does NOT interpret or canonicalize `canonicalBytesHex` in
 * any way — it signs whatever bytes it is given. The caller is responsible
 * for producing the exact byte sequence quoxagent's
 * internal/plugins/dev/profile.go buildProfileSignedData() would produce for
 * the same CapabilityProfile (so that ed25519.Verify() on the quoxagent side
 * succeeds against the signature returned here); structural/canonicalization
 * concerns are entirely the caller's responsibility, mirroring
 * crystalSigningKey.js's signCrystalHash().
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} canonicalBytesHex - hex-encoded bytes to sign
 * @returns {{ key_id: string, algorithm: string, signature: string, public_key_hex: string }}
 */
export function signWidgetEvidence(db, orgId, canonicalBytesHex) {
    const keyRow = ensureOrgWidgetEvidenceSigningKey(db, orgId);
    const privateKeyDerHex = decrypt(keyRow.private_key_encrypted);
    const privateKeyObj = toPrivateKeyObject(privateKeyDerHex);
    const signature = cryptoSign(null, Buffer.from(canonicalBytesHex, 'hex'), privateKeyObj);
    return {
        key_id: keyRow.key_id,
        algorithm: keyRow.algorithm,
        signature: signature.toString('hex'),
        public_key_hex: keyRow.public_key_hex,
    };
}

/**
 * Verify a signature produced by signWidgetEvidence() against the
 * given public_key_hex. Exposed primarily for test round-trips, but is also
 * the building block any future auth-side verification endpoint would use.
 *
 * @param {string} canonicalBytesHex
 * @param {string} signatureHex
 * @param {string} publicKeyHex
 * @returns {boolean}
 */
export function verifyWidgetEvidenceSignature(canonicalBytesHex, signatureHex, publicKeyHex) {
    try {
        const pubKeyObj = toPublicKeyObject(publicKeyHex);
        return cryptoVerify(null, Buffer.from(canonicalBytesHex, 'hex'), pubKeyObj, Buffer.from(signatureHex, 'hex'));
    } catch {
        return false;
    }
}
