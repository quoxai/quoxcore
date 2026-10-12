/**
 * approvalGrantSigningKey.js — TRUST-PROOF slice 4: per-org Ed25519
 * "Approval Grant Signing Key" (AGSK) custody for QuoxBastion's
 * X-Bastion-Approval-Grant gate.
 *
 * QuoxBastion's internal/approval/grant.go defines a signed Grant envelope
 * (Sign(grant, privateKey)) minted when a HITL inbox item is approved, but
 * has no server-side place the raw Ed25519 private key can safely live.
 * Auth is the sole custodian of each org's AGSK — the collector computes
 * the canonical grant fields (lib/approvalGrant.js buildUnsignedGrant() +
 * signedBytes()) and calls in here (in-process, via
 * routes/internal-approval-grants.js) to have those exact bytes signed.
 * This module never parses or understands grant structure, it only
 * generates/stores/uses raw Ed25519 key material. The private key is
 * encrypted at rest via utils/encryption.js encrypt()/decrypt() (the same
 * vault-KEK envelope used for every other secret in this service) and
 * NEVER leaves this process in plaintext.
 *
 * This is a DEDICATED keypair mechanism, structurally identical to
 * lib/devCapabilitySigningKey.js and lib/crystalSigningKey.js but never
 * sharing or referencing DCSK/CSK key material — a compromised/rotated
 * Dev Capability Signing Key or Crystal Signing Key has zero effect on
 * approval-grant signing and vice versa.
 *
 * Key storage is per-ORG: one org has one active AGSK, used to sign grants
 * for any of that org's HITL-approved actions across any target host.
 *
 * Public-key encoding mirrors devCapabilitySigningKey.js / crystalSigningKey.js
 * / utils/plugins.js verifyPluginSignature(): raw 32-byte Ed25519 public key
 * stored/returned as lowercase hex, wrapped in the constant Ed25519
 * SubjectPublicKeyInfo DER prefix only at the point crypto needs a KeyObject.
 * A base64 encoding of the same raw 32 bytes is also returned (QuoxBastion's
 * ed25519.PublicKey config expects base64, matching internal/approval
 * xlang_test.go's xlangPublicKeyB64 fixture).
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
// 32-byte public key (same constant as devCapabilitySigningKey.js /
// crystalSigningKey.js / utils/plugins.js).
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

function generateAgsk() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = rawPublicKeyHex(publicKey);
    const privateKeyDerHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
    return { publicKeyHex, privateKeyDerHex };
}

/**
 * Return the org's active AGSK row, generating one on first use. Idempotent
 * + concurrent-safe: on a UNIQUE(org_id, status) violation from a racing
 * request, re-reads the row the other request just inserted rather than
 * erroring.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @returns {{ id: string, org_id: string, key_id: string, algorithm: string,
 *             public_key_hex: string, private_key_encrypted: string,
 *             status: string, created_at: string }}
 */
export function ensureOrgApprovalGrantSigningKey(db, orgId) {
    const existing = db.prepare(
        `SELECT * FROM approval_grant_signing_keys WHERE org_id = ? AND status = 'active'`
    ).get(orgId);
    if (existing) return existing;

    const { publicKeyHex, privateKeyDerHex } = generateAgsk();
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
            `INSERT INTO approval_grant_signing_keys
                (id, org_id, key_id, algorithm, public_key_hex, private_key_encrypted, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(row.id, row.org_id, row.key_id, row.algorithm, row.public_key_hex, row.private_key_encrypted, row.status);
    } catch (err) {
        // UNIQUE(org_id, status) violation — a concurrent request already
        // created the active key for this org. Re-read rather than fail.
        if (/UNIQUE constraint failed/i.test(err.message)) {
            const raced = db.prepare(
                `SELECT * FROM approval_grant_signing_keys WHERE org_id = ? AND status = 'active'`
            ).get(orgId);
            if (raced) return raced;
        }
        throw err;
    }

    return db.prepare(`SELECT * FROM approval_grant_signing_keys WHERE id = ?`).get(row.id);
}

/**
 * Sign opaque bytes with the org's AGSK, generating the key on first use.
 *
 * This function does NOT interpret or canonicalize `bytes` in any way — it
 * signs whatever it is given. The caller (routes/internal-approval-grants.js)
 * is responsible for producing the exact byte sequence QuoxBastion's
 * internal/approval/grant.go signedBytes() would produce for the same Grant
 * (via lib/approvalGrant.js's canonicalGrant()/signedBytes()), so that
 * ed25519.Verify() on the QuoxBastion side succeeds against the signature
 * returned here — mirrors signDevCapabilityProfile()'s opaque-bytes contract.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {Buffer} bytes - the exact bytes to sign
 * @returns {{ key_id: string, algorithm: string, signature: string,
 *             public_key_hex: string, public_key_base64: string }}
 *             signature is base64-encoded (QuoxBastion Grant.Signature is
 *             base64(ed25519.Sign(...)), never hex).
 */
export function signApprovalGrant(db, orgId, bytes) {
    const keyRow = ensureOrgApprovalGrantSigningKey(db, orgId);
    const privateKeyDerHex = decrypt(keyRow.private_key_encrypted);
    const privateKeyObj = toPrivateKeyObject(privateKeyDerHex);
    const signature = cryptoSign(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), privateKeyObj);
    return {
        key_id: keyRow.key_id,
        algorithm: keyRow.algorithm,
        signature: signature.toString('base64'),
        public_key_hex: keyRow.public_key_hex,
        public_key_base64: Buffer.from(keyRow.public_key_hex, 'hex').toString('base64'),
    };
}

/**
 * Return the org's AGSK public key (hex + base64), generating the key on
 * first use. Used both for bastion config provisioning (GET
 * /api/internal/approval-grants/public-key) and as the shared shape
 * signApprovalGrant() also returns alongside a signature.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @returns {{ key_id: string, algorithm: string, public_key_hex: string,
 *             public_key_base64: string, status: string }}
 */
export function getApprovalGrantPublicKey(db, orgId) {
    const keyRow = ensureOrgApprovalGrantSigningKey(db, orgId);
    return {
        key_id: keyRow.key_id,
        algorithm: keyRow.algorithm,
        public_key_hex: keyRow.public_key_hex,
        public_key_base64: Buffer.from(keyRow.public_key_hex, 'hex').toString('base64'),
        status: keyRow.status,
    };
}

/**
 * Verify a signature produced by signApprovalGrant() against the given
 * public_key_hex. Exposed primarily for test round-trips (independent of
 * the module's own signing path), mirroring
 * verifyDevCapabilitySignature()'s role in devCapabilitySigningKey.js.
 *
 * @param {Buffer} bytes
 * @param {string} signatureBase64
 * @param {string} publicKeyHex
 * @returns {boolean}
 */
export function verifyApprovalGrantSignature(bytes, signatureBase64, publicKeyHex) {
    try {
        const pubKeyObj = toPublicKeyObject(publicKeyHex);
        return cryptoVerify(
            null,
            Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
            pubKeyObj,
            Buffer.from(signatureBase64, 'base64')
        );
    } catch {
        return false;
    }
}
