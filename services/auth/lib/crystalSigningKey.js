/**
 * crystalSigningKey.js — REPLAY-ONLY .B1a: per-org crystal signing oracle.
 *
 * Auth is the sole custodian of each org's Ed25519 "Crystal Signing Key"
 * (CSK). quoxflow computes the canonical hash of a crystal's action snapshot
 * and sends the opaque hash bytes to auth to be signed — this module never
 * parses or understands crystal structure, it only generates/stores/uses raw
 * Ed25519 key material. The private key is encrypted at rest via
 * utils/encryption.js encrypt()/decrypt() (the same vault-KEK envelope used
 * for every other secret in this service) and NEVER leaves this process in
 * plaintext.
 *
 * Public-key encoding mirrors utils/plugins.js verifyPluginSignature(): raw
 * 32-byte Ed25519 public key stored/returned as lowercase hex, wrapped in the
 * constant Ed25519 SubjectPublicKeyInfo DER prefix only at the point crypto
 * needs a KeyObject.
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
// 32-byte public key (same constant as utils/plugins.js).
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

function generateCsk() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = rawPublicKeyHex(publicKey);
    const privateKeyDerHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
    return { publicKeyHex, privateKeyDerHex };
}

/**
 * Return the org's active CSK row, generating one on first use.
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
export function ensureOrgCrystalSigningKey(db, orgId) {
    const existing = db.prepare(
        `SELECT * FROM org_crystal_signing_keys WHERE org_id = ? AND status = 'active'`
    ).get(orgId);
    if (existing) return existing;

    const { publicKeyHex, privateKeyDerHex } = generateCsk();
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
            `INSERT INTO org_crystal_signing_keys
                (id, org_id, key_id, algorithm, public_key_hex, private_key_encrypted, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(row.id, row.org_id, row.key_id, row.algorithm, row.public_key_hex, row.private_key_encrypted, row.status);
    } catch (err) {
        // UNIQUE(org_id, status) violation — a concurrent request already
        // created the active key for this org. Re-read rather than fail.
        if (/UNIQUE constraint failed/i.test(err.message)) {
            const raced = db.prepare(
                `SELECT * FROM org_crystal_signing_keys WHERE org_id = ? AND status = 'active'`
            ).get(orgId);
            if (raced) return raced;
        }
        throw err;
    }

    return db.prepare(`SELECT * FROM org_crystal_signing_keys WHERE id = ?`).get(row.id);
}

/**
 * Sign an opaque hash (hex-encoded digest bytes, e.g. a sha256 hex string
 * computed by quoxflow over a canonical crystal snapshot) with the org's
 * CSK, generating the key on first use.
 *
 * This function does NOT interpret or canonicalize `hashHex` in any way — it
 * signs whatever bytes it is given. Structural/canonicalization concerns are
 * entirely quoxflow's responsibility.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} hashHex - hex-encoded digest bytes to sign
 * @returns {{ key_id: string, algorithm: string, signature: string, public_key_hex: string }}
 */
export function signCrystalHash(db, orgId, hashHex) {
    const keyRow = ensureOrgCrystalSigningKey(db, orgId);
    const privateKeyDerHex = decrypt(keyRow.private_key_encrypted);
    const privateKeyObj = toPrivateKeyObject(privateKeyDerHex);
    const signature = cryptoSign(null, Buffer.from(hashHex, 'hex'), privateKeyObj);
    return {
        key_id: keyRow.key_id,
        algorithm: keyRow.algorithm,
        signature: signature.toString('hex'),
        public_key_hex: keyRow.public_key_hex,
    };
}

/**
 * Verify a signature produced by signCrystalHash() against the given
 * public_key_hex. Exposed primarily for test round-trips, but is also the
 * building block any future auth-side verification endpoint would use.
 *
 * @param {string} hashHex
 * @param {string} signatureHex
 * @param {string} publicKeyHex
 * @returns {boolean}
 */
export function verifyCrystalSignature(hashHex, signatureHex, publicKeyHex) {
    try {
        const pubKeyObj = toPublicKeyObject(publicKeyHex);
        return cryptoVerify(null, Buffer.from(hashHex, 'hex'), pubKeyObj, Buffer.from(signatureHex, 'hex'));
    } catch {
        return false;
    }
}
