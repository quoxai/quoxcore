/**
 * VOLT Canonical JSON Serialization
 *
 * Deterministic JSON serialization for hash computation.
 * Based on RFC 8785 (JSON Canonicalization Scheme):
 * - Sorted object keys (lexicographic)
 * - No whitespace
 * - UTF-8 encoding
 * - Numbers as shortest representation
 * - No trailing commas
 */

/**
 * Recursively sorts object keys and serializes to canonical JSON.
 * Arrays preserve order. Null values are preserved.
 * undefined values are omitted (standard JSON behavior).
 *
 * @param {*} value - The value to serialize
 * @returns {string} Canonical JSON string
 */
export function canonicalize(value) {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }

  if (typeof value === 'string') {
    // quox#511: the server-side writer (services/collector/lib/voltEmitter.js
    // canonicalJSON) NFC-normalizes every string before hashing, so every
    // chain on disk hashed NFC bytes. A verifier that skips normalization
    // reports EVENT_HASH_MISMATCH on honestly written non-NFC Unicode
    // payloads. The written chains are the fixed point: normalize here too.
    return JSON.stringify(value.normalize('NFC'))
  }

  if (Array.isArray(value)) {
    const items = value.map(item => canonicalize(item))
    return '[' + items.join(',') + ']'
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const pairs = []
    for (const key of keys) {
      if (value[key] === undefined) continue
      pairs.push(JSON.stringify(key) + ':' + canonicalize(value[key]))
    }
    return '{' + pairs.join(',') + '}'
  }

  return JSON.stringify(value)
}

/**
 * Computes SHA-256 hash of a string.
 * Works in both browser (Web Crypto API) and Node.js (crypto module).
 *
 * @param {string} data - The string to hash
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 */
export async function sha256(data) {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(data)

  // Browser and modern Node.js: Web Crypto API
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return bufferToHex(hashBuffer)
  }

  throw new Error('No SHA-256 implementation available')
}

/**
 * Converts an ArrayBuffer to a hex string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer)
  const hex = []
  for (const b of bytes) {
    hex.push(b.toString(16).padStart(2, '0'))
  }
  return hex.join('')
}
