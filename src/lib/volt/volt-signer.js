/**
 * VOLT Signer — V0.1 (Spec §15.1)
 *
 * Ed25519 attestation for Evidence Bundles.
 * Signs a structured message object:
 *   { run_id, bundle_id, hash_alg, first_event_hash, last_event_hash, event_count }
 *
 * Uses Web Crypto API (Ed25519 support requires Node 18+ or modern browsers).
 * Falls back to HMAC-SHA256 signing when Ed25519 is not available.
 *
 * Signature record format:
 *   {
 *     sig_version: '0.1',
 *     sig_type: 'ed25519' | 'hmac-sha256',
 *     key_id, signer_id,
 *     signed_ts: "ISO 8601",
 *     scope: 'bundle',
 *     message: { run_id, bundle_id, hash_alg, first_event_hash, last_event_hash, event_count },
 *     signature: "base64...",
 *     public_key: "base64..." (Ed25519 only)
 *   }
 */

import { canonicalize } from './volt-canonical.js'

/**
 * Generates an Ed25519 key pair for signing.
 * Falls back to HMAC key if Ed25519 is not supported.
 *
 * @param {string} signerId - Identifier for the signing entity
 * @param {string} keyId - Key identifier for rotation tracking
 * @returns {Promise<{signerId: string, keyId: string, algorithm: string, privateKey: CryptoKey, publicKey: string|null}>}
 */
export async function generateSigningKey(signerId, keyId) {
  try {
    // Try Ed25519 first
    const keyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true, // extractable
      ['sign', 'verify']
    )

    // Export public key
    const pubKeyBuffer = await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)
    const publicKey = bufferToBase64(pubKeyBuffer)

    return {
      signerId,
      keyId,
      algorithm: 'Ed25519',
      privateKey: keyPair.privateKey,
      publicKeyObj: keyPair.publicKey,
      publicKey
    }
  } catch {
    // Ed25519 not supported — fall back to HMAC-SHA256
    const key = await globalThis.crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    )

    return {
      signerId,
      keyId,
      algorithm: 'HMAC-SHA256',
      privateKey: key,
      publicKeyObj: key, // HMAC is symmetric
      publicKey: null
    }
  }
}

/**
 * Signs a bundle's structured message object per spec §15.1.
 *
 * @param {Object} options
 * @param {Object} options.manifest - Bundle manifest
 * @param {Object} options.key - Key object from generateSigningKey()
 * @returns {Promise<Object>} Signature record
 */
export async function signBundle({ manifest, key }) {
  const message = {
    run_id: manifest.run_id,
    bundle_id: manifest.bundle_id,
    hash_alg: manifest.hash_alg || 'sha256',
    first_event_hash: manifest.first_event_hash,
    last_event_hash: manifest.last_event_hash,
    event_count: manifest.event_count
  }

  const canonical = canonicalize(message)
  const encoder = new TextEncoder()
  const data = encoder.encode(canonical)

  let signatureBuffer
  if (key.algorithm === 'Ed25519') {
    signatureBuffer = await globalThis.crypto.subtle.sign(
      { name: 'Ed25519' },
      key.privateKey,
      data
    )
  } else {
    signatureBuffer = await globalThis.crypto.subtle.sign(
      { name: 'HMAC' },
      key.privateKey,
      data
    )
  }

  const sigType = key.algorithm === 'Ed25519' ? 'ed25519' : 'hmac-sha256'

  return {
    sig_version: '0.1',
    sig_type: sigType,
    key_id: key.keyId,
    signer_id: key.signerId,
    signed_ts: new Date().toISOString(),
    scope: 'bundle',
    message,
    signature: bufferToBase64(signatureBuffer),
    public_key: key.publicKey
  }
}

/**
 * Verifies a signature against a bundle's signed message.
 *
 * @param {Object} options
 * @param {Object} options.signatureObj - Signature record from signBundle()
 * @param {Object} options.key - Key object with publicKeyObj
 * @returns {Promise<boolean>}
 */
export async function verifySignature({ signatureObj, key }) {
  const canonical = canonicalize(signatureObj.message)
  const encoder = new TextEncoder()
  const data = encoder.encode(canonical)
  const sigBuffer = base64ToBuffer(signatureObj.signature)

  if (signatureObj.sig_type === 'ed25519') {
    return globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key.publicKeyObj,
      sigBuffer,
      data
    )
  } else {
    return globalThis.crypto.subtle.verify(
      { name: 'HMAC' },
      key.publicKeyObj,
      sigBuffer,
      data
    )
  }
}

/**
 * Derives the key_id for a raw Ed25519 public key (base64): first 16 hex
 * chars (8 bytes) of the raw 32-byte key. Matches the collector bundle signer.
 * @param {string} publicKeyB64
 * @returns {string}
 */
export function deriveKeyId(publicKeyB64) {
  const raw = base64ToBuffer(publicKeyB64)
  return Array.from(raw.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Imports a raw base64 Ed25519 public key as a verify-only CryptoKey.
 * @param {string} publicKeyB64
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(publicKeyB64) {
  const raw = base64ToBuffer(publicKeyB64)
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes')
  return globalThis.crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify'])
}

/**
 * Converts an ArrayBuffer to a base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary)
}

/**
 * Converts a base64 string to a Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBuffer(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
