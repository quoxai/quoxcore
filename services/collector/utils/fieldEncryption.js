/**
 * Field-level encryption for AEE envelope storage
 * Uses AES-256-GCM with per-instance master key
 *
 * Encrypts sensitive fields (payload, raw envelope) before database storage
 * to protect user prompts and conversation content at rest.
 */

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

// Master key from environment (32 bytes, base64 encoded)
const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY;

// Configuration for transcript storage
const DISABLE_TRANSCRIPT_STORAGE = process.env.DISABLE_TRANSCRIPT_STORAGE === 'true';

/**
 * Check if transcript storage is disabled
 * @returns {boolean}
 */
function isStorageDisabled() {
  return DISABLE_TRANSCRIPT_STORAGE;
}

/**
 * Get the master encryption key
 * SECURITY: MASTER_ENCRYPTION_KEY is required — no fallback derivation.
 * Deriving from JWT_SECRET is dangerous: if JWT_SECRET leaks, all encrypted data is exposed.
 * @returns {Buffer} - 32-byte encryption key
 */
function getMasterKey() {
  if (!MASTER_KEY) {
    throw new Error(
      '[FATAL] MASTER_ENCRYPTION_KEY environment variable is required.\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }

  const key = Buffer.from(MASTER_KEY, 'base64');
  if (key.length < 32) {
    throw new Error(
      '[FATAL] MASTER_ENCRYPTION_KEY too short — must be at least 32 bytes when base64-decoded.\n' +
      'Generate a new key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return key.subarray(0, 32); // AES-256 requires exactly 32 bytes
}

/**
 * Check if encryption is properly configured
 * @returns {{ configured: boolean, warning?: string }}
 */
function checkEncryptionConfig() {
  if (MASTER_KEY) {
    try {
      const key = Buffer.from(MASTER_KEY, 'base64');
      if (key.length >= 32) {
        return { configured: true };
      }
      return { configured: false, warning: 'MASTER_ENCRYPTION_KEY too short (need 32+ bytes)' };
    } catch (e) {
      return { configured: false, warning: 'MASTER_ENCRYPTION_KEY invalid base64' };
    }
  }
  return { configured: false, warning: 'MASTER_ENCRYPTION_KEY not set — encryption unavailable' };
}

/**
 * Encrypt a plaintext value using AES-256-GCM
 * @param {string} plaintext - Value to encrypt
 * @returns {string} - Encrypted value in format: enc:v1:iv:authTag:ciphertext (all base64)
 */
function encryptField(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    return plaintext;
  }

  try {
    const key = getMasterKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    // Format: enc:v1:iv:authTag:ciphertext (prefix indicates encrypted data)
    return `enc:v1:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  } catch (err) {
    console.error('[ENCRYPTION] Encrypt error:', err.message);
    throw new Error('Field encryption failed');
  }
}

/**
 * Check if a value is encrypted (has our encryption prefix)
 * @param {string} value - Value to check
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

/**
 * Decrypt an encrypted value
 * @param {string} ciphertext - Encrypted value from encryptField()
 * @returns {string} - Decrypted plaintext
 */
function decryptField(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    return ciphertext;
  }

  // Check for encryption prefix
  if (!isEncrypted(ciphertext)) {
    // Return as-is if not encrypted (legacy data or plaintext)
    return ciphertext;
  }

  try {
    // Parse format: enc:v1:iv:authTag:ciphertext
    const parts = ciphertext.split(':');
    if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
      console.warn('[ENCRYPTION] Invalid encrypted format, returning as-is');
      return ciphertext;
    }

    const [, , ivB64, authTagB64, encrypted] = parts;

    const key = getMasterKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // Redact crypto details — only surface that decryption failed
    console.error('[ENCRYPTION] Decrypt failed for encrypted field');
    throw new Error('Field decryption failed — check MASTER_ENCRYPTION_KEY');
  }
}

/**
 * Encrypt envelope fields for storage
 * @param {object} envelope - The envelope to process
 * @returns {{ payload: string, raw: string }} - Encrypted payload and raw fields
 */
function encryptEnvelopeFields(envelope) {
  const payloadJson = JSON.stringify(envelope.payload || {});
  const rawJson = JSON.stringify(envelope);

  return {
    payload: encryptField(payloadJson),
    raw: encryptField(rawJson)
  };
}

/**
 * Decrypt envelope fields when reading from database
 * @param {object} row - Database row with encrypted fields
 * @returns {object} - Decrypted envelope object
 */
function decryptEnvelopeRow(row) {
  if (!row) return null;

  try {
    const decryptedRaw = decryptField(row.raw);
    return JSON.parse(decryptedRaw);
  } catch (err) {
    console.error(`[ENCRYPTION] Failed to process envelope ${row.id}`);
    return null;
  }
}

/**
 * Generate a new master encryption key (for setup scripts)
 * @returns {string} - Base64-encoded 32-byte key
 */
function generateMasterKey() {
  return randomBytes(32).toString('base64');
}

module.exports = {
  encryptField,
  decryptField,
  isEncrypted,
  encryptEnvelopeFields,
  decryptEnvelopeRow,
  checkEncryptionConfig,
  generateMasterKey,
  isStorageDisabled
};
