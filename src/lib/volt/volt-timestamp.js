/**
 * VOLT Trusted Timestamps — V0.1
 *
 * RFC 3161 TSA integration for third-party temporal proof.
 * Hash a bundle manifest → POST to FreeTSA.org → store signed receipt.
 *
 * v0.1 scope: Store and structurally validate TSR.
 * Full TSA signature verification (PKCS7/CMS) is v0.2 — see VOLT_FUTURE.md.
 * The raw TSR IS the legal proof — auditors verify with `openssl ts -verify`.
 *
 * ASN.1 DER encoding is hand-rolled (~60 lines) for the fixed TimeStampReq structure.
 * Only needs: SEQUENCE, INTEGER, OID, OCTET STRING, BOOLEAN.
 */

import { sha256 } from './volt-canonical.js'

const DEFAULT_TSA_URL = 'https://freetsa.org/tsr'

// SHA-256 OID: 2.16.840.1.101.3.4.2.1
const SHA256_OID = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]

// --- ASN.1 DER encoding helpers ---

function derLength(len) {
  if (len < 0x80) return [len]
  if (len < 0x100) return [0x81, len]
  return [0x82, (len >> 8) & 0xff, len & 0xff]
}

function derSequence(contents) {
  const body = concatBytes(contents)
  return new Uint8Array([0x30, ...derLength(body.length), ...body])
}

function derInteger(value) {
  if (value < 0x80) return new Uint8Array([0x02, 0x01, value])
  // Multi-byte integers (not needed for our fixed values, but safe)
  const bytes = []
  let v = value
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  if (bytes[0] & 0x80) bytes.unshift(0x00) // prevent sign bit
  return new Uint8Array([0x02, bytes.length, ...bytes])
}

function derOid(oidBytes) {
  return new Uint8Array([0x06, oidBytes.length, ...oidBytes])
}

function derOctetString(bytes) {
  return new Uint8Array([0x04, ...derLength(bytes.length), ...bytes])
}

function derBoolean(value) {
  return new Uint8Array([0x01, 0x01, value ? 0xff : 0x00])
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

/**
 * Build a DER-encoded RFC 3161 TimeStampReq.
 *
 * Structure:
 *   SEQUENCE {
 *     INTEGER 1               -- version
 *     SEQUENCE {              -- messageImprint
 *       SEQUENCE {            -- hashAlgorithm (AlgorithmIdentifier)
 *         OID sha256
 *       }
 *       OCTET STRING hash     -- hashedMessage
 *     }
 *     BOOLEAN TRUE            -- certReq
 *   }
 *
 * @param {Uint8Array} hashBytes - 32-byte SHA-256 hash
 * @returns {Uint8Array} DER-encoded TimeStampReq
 */
export function buildTimestampRequest(hashBytes) {
  const version = derInteger(1)
  const algId = derSequence([derOid(new Uint8Array(SHA256_OID))])
  const messageImprint = derSequence([algId, derOctetString(hashBytes)])
  const certReq = derBoolean(true)

  return derSequence([version, messageImprint, certReq])
}

/**
 * Request a timestamp from a TSA.
 *
 * @param {string} hexHash - Hex-encoded SHA-256 hash to timestamp
 * @param {Object} [opts]
 * @param {string} [opts.tsaUrl] - TSA URL (default: FreeTSA.org)
 * @returns {Promise<Object>} Timestamp record
 */
export async function requestTimestamp(hexHash, opts = {}) {
  const tsaUrl = opts.tsaUrl || DEFAULT_TSA_URL
  const hashBytes = hexToBytes(hexHash)
  const tsReq = buildTimestampRequest(hashBytes)

  const response = await fetch(tsaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: tsReq
  })

  if (!response.ok) {
    throw new Error(`TSA request failed: HTTP ${response.status}`)
  }

  const tsrBuffer = await response.arrayBuffer()
  const tsrBytes = new Uint8Array(tsrBuffer)

  // Encode response as base64
  let tsr_base64
  if (typeof btoa === 'function') {
    tsr_base64 = btoa(String.fromCharCode(...tsrBytes))
  } else {
    tsr_base64 = Buffer.from(tsrBytes).toString('base64')
  }

  return {
    ts_version: '0.1',
    tsa_url: tsaUrl,
    requested_at: new Date().toISOString(),
    hash_alg: 'sha256',
    hash: hexHash,
    tsr_base64
  }
}

/**
 * Convenience: hash a bundle manifest and request a timestamp.
 *
 * @param {Object} manifest - Bundle manifest
 * @param {Object} [opts] - Options for requestTimestamp
 * @returns {Promise<Object>} Timestamp record
 */
export async function timestampBundle(manifest, opts = {}) {
  // Hash the canonical manifest JSON
  const manifestJson = JSON.stringify(manifest)
  const hash = await sha256(manifestJson)
  return requestTimestamp(hash, opts)
}

/**
 * Structural validation of a timestamp record.
 * v0.1: checks format, base64, ASN.1 tag, hash match.
 * v0.2 will add full TSA signature verification.
 *
 * @param {Object} tsRecord - Timestamp record
 * @param {string} [expectedHash] - Expected hash (for cross-check)
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateTimestamp(tsRecord, expectedHash) {
  const errors = []

  if (!tsRecord) {
    errors.push('Timestamp record is null')
    return { valid: false, errors }
  }

  if (!tsRecord.ts_version) errors.push('Missing ts_version')
  if (!tsRecord.tsa_url) errors.push('Missing tsa_url')
  if (!tsRecord.hash_alg) errors.push('Missing hash_alg')
  if (!tsRecord.hash) errors.push('Missing hash')
  if (!tsRecord.tsr_base64) errors.push('Missing tsr_base64')

  if (errors.length > 0) return { valid: false, errors }

  // Verify hash matches if expected hash provided
  if (expectedHash && tsRecord.hash !== expectedHash) {
    errors.push(`Hash mismatch: expected ${expectedHash.slice(0, 16)}..., got ${tsRecord.hash.slice(0, 16)}...`)
  }

  // Decode base64 and check ASN.1 structure
  try {
    let raw
    if (typeof atob === 'function') {
      raw = atob(tsRecord.tsr_base64)
    } else {
      raw = Buffer.from(tsRecord.tsr_base64, 'base64').toString('binary')
    }

    if (raw.length < 4) {
      errors.push('TSR too short (less than 4 bytes)')
    } else if (raw.charCodeAt(0) !== 0x30) {
      errors.push(`TSR does not start with ASN.1 SEQUENCE tag (got 0x${raw.charCodeAt(0).toString(16)})`)
    }
  } catch (err) {
    errors.push(`Invalid base64: ${err.message}`)
  }

  return { valid: errors.length === 0, errors }
}
