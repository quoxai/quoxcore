'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const NODE_ENV = process.env.NODE_ENV || 'development';

function getMasterKey() {
  const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY;
  if (MASTER_KEY) {
    const keyBuffer = Buffer.from(MASTER_KEY, 'base64');
    if (keyBuffer.length < 32) {
      throw new Error(
        '[SECURITY] MASTER_ENCRYPTION_KEY is too short. ' +
        'Key must be at least 32 bytes (256 bits) for AES-256. ' +
        'Generate a new key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
      );
    }
    return keyBuffer.length > 32 ? keyBuffer.subarray(0, 32) : keyBuffer;
  }

  if (NODE_ENV === 'production') {
    throw new Error(
      '[SECURITY] MASTER_ENCRYPTION_KEY environment variable is required in production.\n\n' +
      'To fix:\n' +
      '  1. Generate a secure 32-byte key:\n' +
      '     node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
      '  2. Add to your environment:\n' +
      '     export MASTER_ENCRYPTION_KEY="<generated-key>"\n' +
      '  3. Restart the application\n\n' +
      'IMPORTANT: Store this key securely and separately from other secrets.'
    );
  }

  throw new Error(
    '[SECURITY] MASTER_ENCRYPTION_KEY environment variable is required.\n\n' +
    'Even in development, encryption keys must be explicitly configured.\n' +
    'Generate a key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
    'Then set: export MASTER_ENCRYPTION_KEY="<generated-key>"'
  );
}

function isHexFormat(str) {
  return /^[0-9a-f]+$/i.test(str) && str.length === 32;
}

function decryptBase64Format(ciphertext) {
  const [ivB64, authTagB64, encrypted] = ciphertext.split(':');
  if (!ivB64 || !authTagB64 || !encrypted) {
    throw new Error('Invalid base64 ciphertext format');
  }

  const key = getMasterKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

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

function encrypt(plaintext) {
  const key = getMasterKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

function decrypt(ciphertext) {
  if (!ciphertext || !ciphertext.includes(':')) {
    throw new Error('Invalid ciphertext format');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format - expected iv:authTag:data');
  }

  if (isHexFormat(parts[0])) {
    return decryptHexFormat(ciphertext);
  }
  return decryptBase64Format(ciphertext);
}

module.exports = { encrypt, decrypt, getMasterKey };
