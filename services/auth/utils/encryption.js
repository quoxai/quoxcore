/**
 * Encryption utilities for API key storage
 * Uses AES-256-GCM with per-instance master key
 */

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'crypto';
// getDb is imported for LAZY resolution of the vault KEK salt/version from
// instance_config. IMPORTANT (ESM cycle db/index.js -> legacyDataMigrations.js
// -> encryption.js): getDb() MUST only ever be called INSIDE functions, never
// at module top-level, or the cycle deadlocks at import time.
import { getDb } from '../db/index.js';

// Master key from environment (32 bytes, base64 encoded)
const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ============================================================================
// VAULT-AUDIT P1 — v2 envelope encryption (HKDF-derived KEK wraps a per-
// credential random DEK; the DEK encrypts the secret). Self-describing format:
//   v2:<kdf>:<kekVer>:<wrappedDek_b64>:<iv_b64>:<tag_b64>:<ct_b64>
// See migrations/073-vault-kek-bootstrap.sql for the salt/version bootstrap.
// ============================================================================

const KDF_LABEL = 'hkdf-sha256';       // literal kdf field in the envelope
const KEK_INFO = 'quox-vault-kek-v2';  // HKDF info string (domain separation)

// Lazily-resolved vault metadata (salt + current KEK version) read once from
// instance_config, and a derived-KEK cache keyed by master||salt so we never
// re-derive per call.
let _vaultMeta = null;                  // { salt: Buffer, version: number }
const _kekCache = new Map();            // `${masterHex}:${saltHex}` -> Buffer(32)

/**
 * Resolve the vault salt + current KEK version from instance_config (lazily,
 * cached). Called only from inside functions to respect the ESM cycle.
 * @returns {{ salt: Buffer, version: number }}
 */
function getVaultMeta() {
    if (_vaultMeta) return _vaultMeta;
    const db = getDb();
    const saltRow = db.prepare("SELECT value FROM instance_config WHERE key = 'vault_kek_salt'").get();
    const versionRow = db.prepare("SELECT value FROM instance_config WHERE key = 'vault_kek_version'").get();
    if (!saltRow || !versionRow) {
        throw new Error(
            '[SECURITY] vault_kek_salt / vault_kek_version missing from instance_config ' +
            '(migration 073-vault-kek-bootstrap.sql not applied).'
        );
    }
    _vaultMeta = {
        salt: Buffer.from(saltRow.value, 'hex'),
        version: parseInt(versionRow.value, 10),
    };
    return _vaultMeta;
}

/**
 * Normalize a base64 master key to an exactly-32-byte Buffer, matching
 * getMasterKey()'s handling (truncate if longer, reject if shorter).
 * @param {string} keyB64
 * @returns {Buffer|null}
 */
function normalizeMaster(keyB64) {
    if (!keyB64) return null;
    const buf = Buffer.from(keyB64, 'base64');
    if (buf.length < 32) return null;
    return buf.length > 32 ? buf.subarray(0, 32) : buf;
}

/** Previous master key (dual-key rotation window), or null if not set. */
function getPreviousMasterKey() {
    return normalizeMaster(process.env.MASTER_ENCRYPTION_KEY_PREVIOUS);
}

/**
 * Derive the 32-byte KEK from a master key + salt via HKDF-SHA256.
 * The master is already 256 bits of strong random key material, so HKDF (not
 * a password KDF like argon2/scrypt) is correct — and it is synchronous.
 * @param {Buffer} masterKeyBuf
 * @param {Buffer} saltBuf
 * @returns {Buffer} 32-byte KEK
 */
export function deriveKek(masterKeyBuf, saltBuf) {
    return Buffer.from(hkdfSync('sha256', masterKeyBuf, saltBuf, KEK_INFO, 32));
}

/** Cached KEK derivation keyed by master||salt. */
function getCachedKek(masterKeyBuf, saltBuf) {
    const cacheKey = `${masterKeyBuf.toString('hex')}:${saltBuf.toString('hex')}`;
    let kek = _kekCache.get(cacheKey);
    if (!kek) {
        kek = deriveKek(masterKeyBuf, saltBuf);
        _kekCache.set(cacheKey, kek);
    }
    return kek;
}

/**
 * Build the default KEK resolver for decrypt(): maps an envelope's kekVer to a
 * KEK using the current master (version V) or the previous master (version
 * V-1, dual-key window). Throws for any other version.
 * @returns {(kekVer: number) => Buffer}
 */
function buildDefaultKekResolver() {
    const { salt, version } = getVaultMeta();
    const master = getMasterKey();
    const prevMaster = getPreviousMasterKey();
    return (kekVer) => {
        if (kekVer === version) return getCachedKek(master, salt);
        if (kekVer === version - 1 && prevMaster) return getCachedKek(prevMaster, salt);
        throw new Error(
            `[SECURITY] No KEK available for vault version ${kekVer} ` +
            `(current=${version}, previous ${prevMaster ? 'set' : 'absent'}).`
        );
    };
}

/**
 * Encrypt plaintext into a v2 envelope: a random 32-byte DEK is wrapped under
 * the given KEK (AES-256-GCM), and the DEK encrypts the plaintext (AES-256-GCM).
 * @param {string} plaintext
 * @param {Buffer} kekBuf - 32-byte KEK
 * @param {number} kekVersion - version stamped into the envelope
 * @returns {string} v2:<kdf>:<kekVer>:<wrappedDek_b64>:<iv_b64>:<tag_b64>:<ct_b64>
 */
export function encryptEnvelope(plaintext, kekBuf, kekVersion) {
    // Random per-credential DEK.
    const dek = randomBytes(32);

    // Wrap the DEK under the KEK: wrapIv(16) || wrapTag(16) || ct(32).
    const wrapIv = randomBytes(16);
    const wrapCipher = createCipheriv('aes-256-gcm', kekBuf, wrapIv);
    const wrappedDekCt = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();
    const wrappedDek = Buffer.concat([wrapIv, wrapTag, wrappedDekCt]); // 64 bytes

    // Encrypt the plaintext under the DEK.
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        'v2',
        KDF_LABEL,
        String(kekVersion),
        wrappedDek.toString('base64'),
        iv.toString('base64'),
        tag.toString('base64'),
        ct.toString('base64'),
    ].join(':');
}

/** Parse + validate a v2 envelope into its 7 components. */
function parseEnvelope(v2string) {
    const parts = v2string.split(':');
    if (parts.length !== 7 || parts[0] !== 'v2') {
        throw new Error('Invalid v2 envelope format');
    }
    const [, kdf, kekVerStr, wrappedDekB64, ivB64, tagB64, ctB64] = parts;
    if (kdf !== KDF_LABEL) {
        throw new Error(`Unsupported vault KDF: ${kdf}`);
    }
    const kekVer = parseInt(kekVerStr, 10);
    if (!Number.isInteger(kekVer)) {
        throw new Error('Invalid vault KEK version');
    }
    return { kekVer, wrappedDekB64, ivB64, tagB64, ctB64 };
}

/** Unwrap the DEK from a wrappedDek buffer under the given KEK. */
function unwrapDek(wrappedDekB64, kekBuf) {
    const wrappedDek = Buffer.from(wrappedDekB64, 'base64');
    if (wrappedDek.length !== 64) {
        throw new Error('Invalid wrapped DEK length — expected 64 bytes');
    }
    const wrapIv = wrappedDek.subarray(0, 16);
    const wrapTag = wrappedDek.subarray(16, 32);
    const wrappedDekCt = wrappedDek.subarray(32, 64);
    const unwrap = createDecipheriv('aes-256-gcm', kekBuf, wrapIv);
    unwrap.setAuthTag(wrapTag);
    return Buffer.concat([unwrap.update(wrappedDekCt), unwrap.final()]); // 32-byte DEK
}

/**
 * Decrypt a v2 envelope. kekResolver(kekVer) -> KEK Buffer (throws if unknown).
 * GCM tag verification means any tamper (ct, tag, or wrappedDek) throws.
 * @param {string} v2string
 * @param {(kekVer: number) => Buffer} kekResolver
 * @returns {string} plaintext
 */
export function decryptEnvelope(v2string, kekResolver) {
    const { kekVer, wrappedDekB64, ivB64, tagB64, ctB64 } = parseEnvelope(v2string);
    const kek = kekResolver(kekVer);
    if (!kek) throw new Error(`No KEK available for vault version ${kekVer}`);

    const dek = unwrapDek(wrappedDekB64, kek);

    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
}

/**
 * Re-wrap the DEK of a v2 envelope under a new KEK (the rotation primitive).
 * The secret's iv/tag/ct are left byte-for-byte untouched — only the wrappedDek
 * and kekVer change. This makes master-key rotation a cheap DEK re-wrap rather
 * than a full secret re-encrypt.
 * @param {string} v2string
 * @param {(kekVer: number) => Buffer} oldKekResolver - resolves the CURRENT wrap KEK
 * @param {Buffer} newKekBuf
 * @param {number} newKekVersion
 * @returns {string} new v2 envelope
 */
export function rewrapEnvelope(v2string, oldKekResolver, newKekBuf, newKekVersion) {
    const { kekVer, wrappedDekB64, ivB64, tagB64, ctB64 } = parseEnvelope(v2string);
    const oldKek = oldKekResolver(kekVer);
    if (!oldKek) throw new Error(`No KEK available for vault version ${kekVer}`);

    // Unwrap the DEK under the old KEK, then re-wrap under the new KEK.
    const dek = unwrapDek(wrappedDekB64, oldKek);
    const newWrapIv = randomBytes(16);
    const wrapCipher = createCipheriv('aes-256-gcm', newKekBuf, newWrapIv);
    const newWrappedDekCt = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const newWrapTag = wrapCipher.getAuthTag();
    const newWrappedDek = Buffer.concat([newWrapIv, newWrapTag, newWrappedDekCt]);

    // iv/tag/ct preserved exactly.
    return [
        'v2',
        KDF_LABEL,
        String(newKekVersion),
        newWrappedDek.toString('base64'),
        ivB64,
        tagB64,
        ctB64,
    ].join(':');
}

/**
 * Validate and return the master encryption key
 * SECURITY: The encryption key MUST be independent from other secrets (e.g., JWT_SECRET)
 * to prevent cascading compromise if one secret is leaked.
 *
 * @throws {Error} If MASTER_ENCRYPTION_KEY is not configured in production
 * @returns {Buffer} 32-byte encryption key
 */
function getMasterKey() {
    if (MASTER_KEY) {
        const keyBuffer = Buffer.from(MASTER_KEY, 'base64');
        if (keyBuffer.length < 32) {
            throw new Error(
                '[SECURITY] MASTER_ENCRYPTION_KEY is too short. ' +
                'Key must be at least 32 bytes (256 bits) for AES-256. ' +
                'Generate a new key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
            );
        }
        // AES-256 requires exactly 32 bytes — truncate if longer
        return keyBuffer.length > 32 ? keyBuffer.subarray(0, 32) : keyBuffer;
    }

    // In production, MASTER_ENCRYPTION_KEY is required
    if (NODE_ENV === 'production') {
        throw new Error(
            '[SECURITY] MASTER_ENCRYPTION_KEY environment variable is required in production.\n\n' +
            'SECURITY RISK: Deriving encryption keys from other secrets (like JWT_SECRET) is dangerous:\n' +
            '  - If JWT_SECRET is compromised, all encrypted data is also compromised\n' +
            '  - JWT secrets may be weaker than required for encryption\n' +
            '  - Violates defense-in-depth security principle\n\n' +
            'To fix:\n' +
            '  1. Generate a secure 32-byte key:\n' +
            '     node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
            '  2. Add to your environment:\n' +
            '     export MASTER_ENCRYPTION_KEY="<generated-key>"\n' +
            '  3. Restart the application\n\n' +
            'IMPORTANT: Store this key securely and separately from other secrets.'
        );
    }

    // Development only: warn and fail
    // NOTE: We no longer provide a fallback even in development to prevent
    // accidentally running with weak encryption
    throw new Error(
        '[SECURITY] MASTER_ENCRYPTION_KEY environment variable is required.\n\n' +
        'Even in development, encryption keys must be explicitly configured.\n' +
        'Generate a key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
        'Then set: export MASTER_ENCRYPTION_KEY="<generated-key>"'
    );
}

/**
 * Encrypt a plaintext value (e.g., API key) into a v2 envelope.
 * Resolves the current KEK + version lazily from instance_config.
 * @param {string} plaintext - Value to encrypt
 * @returns {string} - v2 envelope (see encryptEnvelope). Synchronous.
 */
export function encrypt(plaintext) {
    const master = getMasterKey();
    const { salt, version } = getVaultMeta();
    const kek = getCachedKek(master, salt);
    return encryptEnvelope(plaintext, kek, version);
}

/**
 * Encrypt a plaintext value into the OLD 3-part legacy format:
 *   iv:authTag:ciphertext  (all base64)
 * using the raw master key (getMasterKey()) + a random 16-byte IV + AES-256-GCM
 * — i.e. exactly what encrypt() produced BEFORE VAULT-AUDIT P1.
 *
 * Legacy 3-part format retained ONLY for the collector transition-window copy in
 * config_json (collector/lib/encryption.js has no v2 reader); all canonical
 * storage uses encrypt()/v2. Remove when the collector reads secrets via the
 * internal resolve endpoint instead of the config_json copy.
 *
 * @param {string} plaintext - Value to encrypt
 * @returns {string} - iv:authTag:ciphertext (all base64). Synchronous.
 */
export function encryptLegacy(plaintext) {
    const key = getMasterKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Check if a string is hex-encoded (legacy format from setup.js)
 * @param {string} str - String to check
 * @returns {boolean}
 */
function isHexFormat(str) {
    // Hex IV is 32 chars (16 bytes * 2), base64 IV is ~24 chars
    return /^[0-9a-f]+$/i.test(str) && str.length === 32;
}

/**
 * Decrypt base64-encoded format (standard)
 * Format: iv:authTag:ciphertext (all base64)
 */
function decryptBase64Format(ciphertext) {
    const [ivB64, authTagB64, encrypted] = ciphertext.split(':');
    if (!ivB64 || !authTagB64 || !encrypted) {
        throw new Error('Invalid base64 ciphertext format');
    }

    const key = getMasterKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');

    // Validate IV (16 bytes) and authTag (16 bytes for GCM)
    if (iv.length !== 16) {
        throw new Error('Invalid IV length — expected 16 bytes');
    }
    if (authTag.length !== 16) {
        throw new Error('Invalid auth tag length — expected 16 bytes');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Decrypt hex-encoded format (legacy from setup.js inline encryption)
 * Format: iv:authTag:ciphertext (all hex)
 */
function decryptHexFormat(ciphertext) {
    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
    if (!ivHex || !authTagHex || !encrypted) {
        throw new Error('Invalid hex ciphertext format');
    }

    const key = getMasterKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Decrypt an encrypted value (auto-detects format)
 * Supports both base64 (standard) and hex (legacy) formats
 * @param {string} ciphertext - Encrypted value from encrypt()
 * @returns {string} - Decrypted plaintext
 */
export function decrypt(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.includes(':')) {
        throw new Error('Invalid ciphertext format');
    }

    // v2 envelope: HKDF-KEK-wrapped DEK. Detected by the self-describing prefix;
    // legacy 3-part (hex or base64) never starts with 'v2:', so no collision.
    if (ciphertext.startsWith('v2:')) {
        return decryptEnvelope(ciphertext, buildDefaultKekResolver());
    }

    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid ciphertext format - expected iv:authTag:data');
    }

    // Auto-detect format by checking if IV is hex or base64
    if (isHexFormat(parts[0])) {
        return decryptHexFormat(ciphertext);
    }
    return decryptBase64Format(ciphertext);
}

/**
 * Get preview of an API key (last 4 characters)
 * @param {string} apiKey - Full API key
 * @returns {string} - Preview string like "...sk-abc1"
 */
export function getKeyPreview(apiKey) {
    if (!apiKey || apiKey.length < 8) {
        return '****';
    }
    return '...' + apiKey.slice(-4);
}

/**
 * Generate masked preview of an API key (****XXXX format)
 * @param {string} apiKey - Full API key
 * @returns {string} - Preview string like "****ghij"
 */
export function generateKeyPreview(apiKey) {
    if (!apiKey || apiKey.length < 4) {
        return '****';
    }
    return '****' + apiKey.slice(-4);
}

/**
 * Validate that an API key looks valid for a provider
 * @param {string} provider - Provider name
 * @param {string} apiKey - API key to validate
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateApiKeyFormat(provider, apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
        return { valid: false, message: 'API key is required' };
    }

    const trimmed = apiKey.trim();

    switch (provider) {
        case 'anthropic':
            if (!trimmed.startsWith('sk-ant-')) {
                return { valid: false, message: 'Anthropic keys should start with sk-ant-' };
            }
            break;

        case 'openai':
            if (!trimmed.startsWith('sk-')) {
                return { valid: false, message: 'OpenAI keys should start with sk-' };
            }
            break;

        case 'google':
            if (trimmed.length < 20) {
                return { valid: false, message: 'Google API key seems too short' };
            }
            break;

        case 'elevenlabs':
            if (trimmed.length < 20) {
                return { valid: false, message: 'ElevenLabs API key seems too short' };
            }
            break;

        default:
            // Unknown provider, just check it's not empty
            if (trimmed.length < 10) {
                return { valid: false, message: 'API key seems too short' };
            }
    }

    return { valid: true };
}

/**
 * Generate a new master encryption key
 * @returns {string} - Base64-encoded 32-byte key
 */
export function generateMasterKey() {
    return randomBytes(32).toString('base64');
}

/**
 * Validate that a key is the correct length for AES-256
 * @param {string} keyBase64 - Base64-encoded key
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateMasterKey(keyBase64) {
    if (!keyBase64 || typeof keyBase64 !== 'string') {
        return { valid: false, message: 'Key is required' };
    }

    try {
        const keyBuffer = Buffer.from(keyBase64, 'base64');
        if (keyBuffer.length < 32) {
            return { valid: false, message: `Key too short: ${keyBuffer.length} bytes (need 32)` };
        }
        return { valid: true };
    } catch (err) {
        return { valid: false, message: 'Invalid base64 encoding' };
    }
}

/**
 * Re-encrypt a ciphertext with a new key
 * Used during key rotation to migrate encrypted values
 * @param {string} ciphertext - Existing encrypted value
 * @param {Buffer} oldKey - Previous 32-byte key
 * @param {Buffer} newKey - New 32-byte key
 * @returns {string} - Re-encrypted value using new key
 */
export function reencrypt(ciphertext, oldKey, newKey) {
    if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.includes(':')) {
        throw new Error('Invalid ciphertext format');
    }

    // v2 envelope: rotation normally uses rewrapEnvelope (a cheap DEK re-wrap).
    // reencrypt() is not the preferred path for v2, but tolerate it via a safe
    // full decrypt(old master KEK) -> encryptEnvelope(new master KEK) fallback so
    // callers that only know the legacy (oldKey, newKey) contract still work.
    if (ciphertext.startsWith('v2:')) {
        const { salt, version } = getVaultMeta();
        const oldKek = deriveKek(oldKey, salt);
        const newKek = deriveKek(newKey, salt);
        const plaintext = decryptEnvelope(ciphertext, () => oldKek);
        return encryptEnvelope(plaintext, newKek, version);
    }

    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid ciphertext format - expected iv:authTag:data');
    }

    // Decrypt with old key
    let plaintext;
    if (isHexFormat(parts[0])) {
        // Legacy hex format
        const [ivHex, authTagHex, encrypted] = parts;
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = createDecipheriv('aes-256-gcm', oldKey, iv);
        decipher.setAuthTag(authTag);
        plaintext = decipher.update(encrypted, 'hex', 'utf8');
        plaintext += decipher.final('utf8');
    } else {
        // Standard base64 format
        const [ivB64, authTagB64, encrypted] = parts;
        const iv = Buffer.from(ivB64, 'base64');
        const authTag = Buffer.from(authTagB64, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', oldKey, iv);
        decipher.setAuthTag(authTag);
        plaintext = decipher.update(encrypted, 'base64', 'utf8');
        plaintext += decipher.final('utf8');
    }

    // Re-encrypt with new key (always use base64 format)
    const newIv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', newKey, newIv);
    let newEncrypted = cipher.update(plaintext, 'utf8', 'base64');
    newEncrypted += cipher.final('base64');
    const newAuthTag = cipher.getAuthTag();

    return `${newIv.toString('base64')}:${newAuthTag.toString('base64')}:${newEncrypted}`;
}

export default {
    encrypt,
    encryptLegacy,
    decrypt,
    getKeyPreview,
    generateKeyPreview,
    validateApiKeyFormat,
    generateMasterKey,
    validateMasterKey,
    reencrypt,
    deriveKek,
    encryptEnvelope,
    decryptEnvelope,
    rewrapEnvelope
};
