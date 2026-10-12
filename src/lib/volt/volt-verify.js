/**
 * VOLT Standalone Evidence Verifier — V0.1
 *
 * Pure function: takes a raw JSON string (serialized bundle),
 * returns a comprehensive verification verdict.
 *
 * 10-check pipeline:
 *  1. Parse JSON
 *  2. Structural checks (manifest, events_ndjson)
 *  3. Version check (volt_version supported)
 *  4. Deserialize bundle
 *  5. Validate bundle (event count, first/last hash, Merkle root)
 *  6. Verify hash chain (every event, every link)
 *  7. Redaction consistency
 *  8. Signature format validation
 *  9. Timestamp structural validation
 * 10. Collect results
 *
 * No IndexedDB, no fetch, no app state — pure function.
 */

import { deserializeBundle, validateBundle } from './volt-bundler.js'
import { verifyChain, FAILURE_CODES } from './volt-verifier.js'
import { verifySignature, deriveKeyId, importPublicKey } from './volt-signer.js'

const SUPPORTED_VERSIONS = ['0.1']

/**
 * Extended verification codes (superset of FAILURE_CODES)
 */
export const VERIFY_CODES = {
  ...FAILURE_CODES,
  PARSE_ERROR: 'PARSE_ERROR',
  MISSING_MANIFEST: 'MISSING_MANIFEST',
  MISSING_EVENTS: 'MISSING_EVENTS',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  EVENT_COUNT_MISMATCH: 'EVENT_COUNT_MISMATCH',
  FIRST_HASH_MISMATCH: 'FIRST_HASH_MISMATCH',
  LAST_HASH_MISMATCH: 'LAST_HASH_MISMATCH',
  MERKLE_ROOT_MISMATCH: 'MERKLE_ROOT_MISMATCH',
  REDACTION_INCONSISTENT: 'REDACTION_INCONSISTENT',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  SIGNATURE_MISMATCH: 'SIGNATURE_MISMATCH',
  SIGNER_UNPINNED: 'SIGNER_UNPINNED',
  SIGNER_UNTRUSTED: 'SIGNER_UNTRUSTED',
  KEY_ID_MISMATCH: 'KEY_ID_MISMATCH',
  SIGNATURE_MISSING: 'SIGNATURE_MISSING',
  TIMESTAMP_INVALID: 'TIMESTAMP_INVALID',
  BUNDLE_VALIDATION_FAILED: 'BUNDLE_VALIDATION_FAILED'
}

/**
 * Verify an evidence bundle from a raw JSON string.
 *
 * @param {string} jsonString - Raw JSON string of a serialized bundle
 * @param {Object} [options]
 * @param {Object[]} [options.keys] - TRUSTED keys ({publicKey: base64 raw Ed25519, keyId?}). When given,
 *   signatures must verify against one of them. Otherwise the embedded public_key is used
 *   (internal consistency only, reported as signature_trust 'embedded-unpinned').
 * @param {boolean} [options.strict] - unsigned or unpinned signatures are errors
 * @returns {Promise<{
 *   valid: boolean,
 *   errors: Array<{code: string, message: string, detail?: string}>,
 *   warnings: Array<{code: string, message: string}>,
 *   summary: Object,
 *   chainReport: Object|null,
 *   bundleReport: Object|null
 * }>}
 */
export async function verifyEvidenceBundle(jsonString, options = {}) {
  const errors = []
  const warnings = []
  let chainReport = null
  let bundleReport = null
  let bundle = null
  let events = []

  // 1. Parse JSON
  let parsed
  try {
    parsed = JSON.parse(jsonString)
  } catch (err) {
    errors.push({
      code: VERIFY_CODES.PARSE_ERROR,
      message: 'Failed to parse JSON',
      detail: err.message
    })
    return buildResult(false, errors, warnings, {}, null, null)
  }

  // 2. Structural checks
  if (!parsed.manifest) {
    errors.push({
      code: VERIFY_CODES.MISSING_MANIFEST,
      message: 'Bundle is missing manifest'
    })
    return buildResult(false, errors, warnings, {}, null, null)
  }

  if (!parsed.events_ndjson) {
    errors.push({
      code: VERIFY_CODES.MISSING_EVENTS,
      message: 'Bundle is missing events_ndjson'
    })
    return buildResult(false, errors, warnings, {}, null, null)
  }

  // 3. Version check
  const version = parsed.manifest.volt_version
  if (!SUPPORTED_VERSIONS.includes(version)) {
    errors.push({
      code: VERIFY_CODES.UNSUPPORTED_VERSION,
      message: `Unsupported VOLT version: ${version}`,
      detail: `Supported: ${SUPPORTED_VERSIONS.join(', ')}`
    })
    return buildResult(false, errors, warnings, { volt_version: version }, null, null)
  }

  // 4. Deserialize bundle
  bundle = deserializeBundle(parsed)

  // Parse events for detailed checks
  try {
    events = bundle.eventsNDJSON
      .trim()
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
  } catch (err) {
    errors.push({
      code: VERIFY_CODES.PARSE_ERROR,
      message: 'Failed to parse events NDJSON',
      detail: err.message
    })
    return buildResult(false, errors, warnings, {}, null, null)
  }

  // 5. Validate bundle (event count, first/last hash, Merkle root)
  try {
    bundleReport = await validateBundle(bundle)
    if (!bundleReport.valid) {
      for (const err of bundleReport.errors) {
        errors.push({
          code: VERIFY_CODES.BUNDLE_VALIDATION_FAILED,
          message: err
        })
      }
    }
  } catch (err) {
    errors.push({
      code: VERIFY_CODES.BUNDLE_VALIDATION_FAILED,
      message: 'Bundle validation threw an error',
      detail: err.message
    })
  }

  // 6. Verify hash chain
  try {
    chainReport = await verifyChain(events, {
      bundle_id: parsed.manifest.bundle_id
    })
    if (chainReport.result === 'FAIL') {
      errors.push({
        code: chainReport.reason || VERIFY_CODES.CHAIN_BROKEN,
        message: chainReport.first_failure?.detail || 'Hash chain verification failed',
        detail: `${chainReport.valid_count}/${chainReport.event_count} events valid`
      })
    }
  } catch (err) {
    errors.push({
      code: VERIFY_CODES.CHAIN_BROKEN,
      message: 'Chain verification threw an error',
      detail: err.message
    })
  }

  // 7. Redaction consistency
  if (parsed.manifest.redactions_present && !bundle.redactions) {
    errors.push({
      code: VERIFY_CODES.REDACTION_INCONSISTENT,
      message: 'Manifest indicates redactions but no redaction map found'
    })
  }
  if (!parsed.manifest.redactions_present && bundle.redactions) {
    warnings.push({
      code: VERIFY_CODES.REDACTION_INCONSISTENT,
      message: 'Redaction map present but manifest does not indicate redactions'
    })
  }

  // 8. Signature verification (always cryptographic)
  const signaturesChecked = bundle.signatures?.length || 0
  const signatureResults = []
  const trustedKeys = Array.isArray(options.keys) ? options.keys : []
  let trust = 'none'
  const chainFirst = events.length ? events[0].hash : undefined
  const chainLast = events.length ? events[events.length - 1].hash : undefined
  const bundleBinding = {
    run_id: parsed.manifest.run_id,
    bundle_id: parsed.manifest.bundle_id,
    first_event_hash: chainFirst,
    last_event_hash: chainLast,
    event_count: events.length
  }
  for (const sig of bundle.signatures || []) {
    const res = { key_id: sig.key_id, signer_id: sig.signer_id, valid: false, trust: 'none' }
    signatureResults.push(res)
    if (!sig.signature || !sig.key_id || !sig.message) {
      errors.push({
        code: VERIFY_CODES.SIGNATURE_INVALID,
        message: `Signature ${sig.key_id || 'unknown'} missing required fields`
      })
      continue
    }
    // Binding: the signed message must describe THIS bundle's verified chain
    let bound = true
    for (const [field, expected] of Object.entries(bundleBinding)) {
      if (expected !== undefined && sig.message[field] !== expected) {
        bound = false
        errors.push({
          code: VERIFY_CODES.SIGNATURE_MISMATCH,
          message: `Signed message ${field} does not match this bundle`,
          detail: `signed=${sig.message[field]} bundle=${expected}`
        })
      }
    }
    // Pick the verification key
    let verifyKey = null
    let keyTrust = 'embedded-unpinned'
    try {
      if (trustedKeys.length > 0) {
        const trusted = trustedKeys.find(k =>
          (k.keyId || (k.publicKey ? deriveKeyId(k.publicKey) : undefined)) === sig.key_id)
        if (!trusted) {
          errors.push({
            code: VERIFY_CODES.SIGNER_UNTRUSTED,
            message: `Signature key ${sig.key_id} is not among the supplied trusted keys`
          })
          continue
        }
        verifyKey = trusted.publicKeyObj
          ? trusted
          : { publicKeyObj: await importPublicKey(trusted.publicKey) }
        keyTrust = 'trusted'
      } else if (sig.public_key) {
        const derived = deriveKeyId(sig.public_key)
        if (derived !== sig.key_id) {
          errors.push({
            code: VERIFY_CODES.KEY_ID_MISMATCH,
            message: `Embedded public key derives key_id ${derived}, signature claims ${sig.key_id}`
          })
          continue
        }
        verifyKey = { publicKeyObj: await importPublicKey(sig.public_key) }
      } else {
        errors.push({
          code: VERIFY_CODES.SIGNATURE_INVALID,
          message: `Signature ${sig.key_id} has no embedded public key and no trusted key was supplied`
        })
        continue
      }
      const ok = await verifySignature({ signatureObj: sig, key: verifyKey })
      if (ok !== true) {
        errors.push({
          code: VERIFY_CODES.SIGNATURE_INVALID,
          message: `Signature by ${sig.signer_id || sig.key_id} failed cryptographic verification`
        })
        continue
      }
    } catch (err) {
      errors.push({
        code: VERIFY_CODES.SIGNATURE_INVALID,
        message: `Signature verification error: ${err.message}`
      })
      continue
    }
    if (!bound) continue
    res.valid = true
    res.trust = keyTrust
    if (keyTrust === 'embedded-unpinned') {
      warnings.push({
        code: VERIFY_CODES.SIGNER_UNPINNED,
        message: 'signature is valid but the signing key is not pinned; pass --key/--trusted-keys to prove WHO signed'
      })
    }
  }
  if (signatureResults.length > 0 && signatureResults.every(r => r.valid)) {
    trust = signatureResults.every(r => r.trust === 'trusted') ? 'trusted' : 'embedded-unpinned'
  }
  if (options.strict) {
    if (signaturesChecked === 0) {
      errors.push({ code: VERIFY_CODES.SIGNATURE_MISSING, message: 'Strict mode: bundle has no signature' })
    } else if (trust !== 'trusted') {
      errors.push({
        code: VERIFY_CODES.SIGNER_UNPINNED,
        message: 'Strict mode: signing key is not pinned to a trusted key'
      })
    }
  }

  // 9. Timestamp structural validation
  const timestamps = parsed.manifest.timestamps || []
  for (const ts of timestamps) {
    if (!ts.tsr_base64) {
      errors.push({
        code: VERIFY_CODES.TIMESTAMP_INVALID,
        message: 'Timestamp record missing tsr_base64'
      })
      continue
    }
    // Structural check: base64 decodes, starts with ASN.1 SEQUENCE tag (0x30)
    try {
      const raw = atob(ts.tsr_base64)
      if (raw.length < 4 || raw.charCodeAt(0) !== 0x30) {
        warnings.push({
          code: VERIFY_CODES.TIMESTAMP_INVALID,
          message: 'Timestamp response does not start with ASN.1 SEQUENCE tag'
        })
      }
      // Check hash matches what was timestamped
      if (ts.hash && parsed.manifest.last_event_hash) {
        // We only warn — full TSA sig verification is v0.2
      }
    } catch (err) {
      errors.push({
        code: VERIFY_CODES.TIMESTAMP_INVALID,
        message: 'Timestamp tsr_base64 is not valid base64',
        detail: err.message
      })
    }
  }

  // 10. Build summary
  const summary = {
    bundle_id: parsed.manifest.bundle_id,
    run_id: parsed.manifest.run_id,
    volt_version: parsed.manifest.volt_version,
    event_count: events.length,
    chain_valid: chainReport?.chain_valid ?? false,
    signatures_checked: signaturesChecked,
    signatures_valid: signatureResults.filter(r => r.valid).length,
    signature_trust: trust,
    signatures: signatureResults,
    timestamps_checked: timestamps.length,
    redactions_present: !!parsed.manifest.redactions_present,
    created_ts: parsed.manifest.created_ts
  }

  return buildResult(errors.length === 0, errors, warnings, summary, chainReport, bundleReport)
}

function buildResult(valid, errors, warnings, summary, chainReport, bundleReport) {
  return { valid, errors, warnings, summary, chainReport, bundleReport }
}
