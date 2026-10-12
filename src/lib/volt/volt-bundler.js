/**
 * VOLT Evidence Bundler — V0.1 (Spec-Aligned)
 *
 * Creates portable Evidence Bundles from completed VOLT runs.
 *
 * Bundle structure:
 *   manifest.json    — Run metadata, integrity anchors, producer info
 *   events.ndjson    — Hash-chained trace events
 *   redactions.json  — Optional field-level redaction map
 *   signatures/      — Optional Ed25519/HMAC attestations
 *   attachments/     — Optional tool outputs, model responses
 *
 * Integrity anchors: first_event_hash + last_event_hash (required),
 * merkle_root (optional v0.2 extension).
 */

import { sha256 } from './volt-canonical.js'
import { VOLT_VERSION, HASH_ALG } from './volt-recorder.js'
import { verifyChain } from './volt-verifier.js'
import { prefixedUlid } from '../aee/ulid.js'

/**
 * @typedef {Object} EvidenceBundle
 * @property {Object} manifest - Bundle manifest
 * @property {string} eventsNDJSON - NDJSON string of events
 * @property {Object|null} redactions - Redaction map (if redacted)
 * @property {Object[]} signatures - Array of signature objects
 * @property {Object[]} attachments - Array of attachment metadata
 */

/**
 * Computes a Merkle root from an array of hex hash strings.
 * Uses a binary tree with SHA-256 at each level.
 *
 * @param {string[]} hashes - Array of hex-encoded hashes
 * @returns {Promise<string>} Merkle root as hex string
 */
export async function computeMerkleRoot(hashes) {
  if (hashes.length === 0) {
    return '0'.repeat(64)
  }

  if (hashes.length === 1) {
    return hashes[0]
  }

  // Build tree bottom-up
  let level = [...hashes]

  while (level.length > 1) {
    const nextLevel = []

    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        // Hash pair
        nextLevel.push(await sha256(level[i] + level[i + 1]))
      } else {
        // Odd node — promote to next level
        nextLevel.push(level[i])
      }
    }

    level = nextLevel
  }

  return level[0]
}

/**
 * Creates an Evidence Bundle from a run snapshot.
 *
 * @param {Object} options
 * @param {Object} options.run - Run snapshot from getRunSnapshot()
 * @param {Object} [options.redactions] - Redaction result from volt-redactor
 * @param {Object[]} [options.signatures=[]] - Signature objects from volt-signer
 * @param {Object[]} [options.attachments=[]] - Attachment metadata
 * @returns {Promise<EvidenceBundle>}
 * @throws {Error} If run is still active
 */
export async function createBundle({ run, redactions = null, signatures = [], attachments = [], timestamps = [] }) {
  if (!run) {
    throw new Error('VOLT Bundler: No run provided')
  }
  if (run.status === 'active') {
    throw new Error('VOLT Bundler: Cannot bundle an active run — complete it first')
  }

  const events = redactions?.redactedEvents || run.events
  const eventHashes = events.map(e => e.hash)
  const merkleRoot = await computeMerkleRoot(eventHashes)

  // Integrity anchors (spec §16)
  const firstEventHash = events.length > 0 ? events[0].hash : null
  const lastEventHash = events.length > 0 ? events[events.length - 1].hash : null

  // Extract unique actor IDs
  const agentsInvolved = [...new Set(events.map(e => e.actor.actor_id).filter(Boolean))]

  // Extract policy IDs from AOCL policy events
  const policyIdsEvaluated = events
    .filter(e => e.event_type === 'aocl.policy.evaluated')
    .map(e => e.payload?.policy_id)
    .filter(Boolean)

  // Count HITL decisions (spec §8)
  const hitlDecisions = events.filter(e =>
    e.event_type === 'hitl.approved' ||
    e.event_type === 'hitl.denied'
  ).length

  const bundle_id = prefixedUlid('BDL')

  const manifest = {
    volt_version: VOLT_VERSION,
    bundle_id,
    bundle_mode: 'final',
    run_id: run.run_id,
    correlation_id: run.corr,
    hash_alg: HASH_ALG,
    created_ts: new Date().toISOString(),
    event_count: events.length,
    events_file: 'events.ndjson',

    // Integrity anchors (spec required)
    first_event_hash: firstEventHash,
    last_event_hash: lastEventHash,

    // Merkle root (v0.2 extension — ahead of spec, kept for extra integrity)
    merkle_root: merkleRoot,

    // Run metadata
    agents_involved: agentsInvolved,
    policy_ids_evaluated: policyIdsEvaluated,
    hitl_decisions: hitlDecisions,
    attachments_count: attachments.length,
    redactions_present: !!redactions,
    signed: signatures.length > 0,
    run_status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,

    // Timestamps (RFC 3161 TSA receipts)
    timestamps: timestamps.length > 0 ? timestamps : undefined,

    // Producer info
    producer: {
      name: 'quox-core',
      version: VOLT_VERSION
    }
  }

  const eventsNDJSON = events.map(e => JSON.stringify(e)).join('\n') + '\n'

  return {
    manifest,
    eventsNDJSON,
    redactions: redactions?.redactionMap || null,
    signatures,
    attachments
  }
}

/**
 * Validates a bundle's internal consistency.
 * Checks integrity anchors, event count, chain, and redaction map.
 *
 * @param {EvidenceBundle} bundle
 * @returns {Promise<{valid: boolean, errors: string[]}>}
 */
export async function validateBundle(bundle) {
  const errors = []

  if (!bundle.manifest) {
    errors.push('Missing manifest')
    return { valid: false, errors }
  }

  // Parse events from NDJSON
  const events = bundle.eventsNDJSON
    .trim()
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l))

  // Check event count
  if (events.length !== bundle.manifest.event_count) {
    errors.push(
      `Event count mismatch: manifest says ${bundle.manifest.event_count}, got ${events.length}`
    )
  }

  // Verify first_event_hash
  if (bundle.manifest.first_event_hash && events.length > 0) {
    if (events[0].hash !== bundle.manifest.first_event_hash) {
      errors.push(
        `First event hash mismatch: manifest says ${String(bundle.manifest.first_event_hash).slice(0, 16)}..., ` +
        `got ${String(events[0].hash).slice(0, 16)}...`
      )
    }
  }

  // Verify last_event_hash
  if (bundle.manifest.last_event_hash && events.length > 0) {
    if (events[events.length - 1].hash !== bundle.manifest.last_event_hash) {
      errors.push(
        `Last event hash mismatch: manifest says ${String(bundle.manifest.last_event_hash).slice(0, 16)}..., ` +
        `got ${String(events[events.length - 1].hash).slice(0, 16)}...`
      )
    }
  }

  // Verify Merkle root — ONLY when the manifest carries one.
  //
  // merkle_root is an OPTIONAL v0.2 extension (see this file's header), and
  // volt-certifier.js:432 already treats its absence as a distinct, reported
  // condition rather than a mismatch. This function did neither: for a v0.1
  // bundle with no merkle_root it compared `computed !== undefined`, took the
  // mismatch branch, and then threw on `undefined.slice(0, 16)`.
  //
  // 2026-08-19: that crash is what `quox volt verify` returned for a real
  // bundle the product itself produced — "Cannot read properties of undefined
  // (reading 'slice')" — while the chain had in fact verified PASS. An opaque
  // crash in the flagship verification path reads as "your evidence is
  // broken", which is both alarming and untrue.
  if (bundle.manifest.merkle_root) {
    const eventHashes = events.map(e => e.hash)
    const computedRoot = await computeMerkleRoot(eventHashes)

    if (computedRoot !== bundle.manifest.merkle_root) {
      errors.push(
        `Merkle root mismatch: manifest says ${String(bundle.manifest.merkle_root).slice(0, 16)}..., ` +
        `computed ${String(computedRoot).slice(0, 16)}...`
      )
    }
  }

  // Verify hash chain integrity (re-hash each event, check prev_hash links)
  const chainResult = await verifyChain(events)
  if (!chainResult.chain_valid) {
    errors.push(
      `Hash chain verification failed: ${chainResult.first_failure?.reason || 'unknown'}`
    )
  }
  if (!chainResult.sequence_valid) {
    errors.push('Event sequence numbers are not monotonically increasing')
  }

  // Check redaction consistency
  if (bundle.manifest.redactions_present && !bundle.redactions) {
    errors.push('Manifest says redacted but no redaction map found')
  }

  // Validate timestamps (structural only — full TSA sig verify is v0.2)
  if (bundle.manifest.timestamps && bundle.manifest.timestamps.length > 0) {
    for (const ts of bundle.manifest.timestamps) {
      if (!ts.tsr_base64) {
        errors.push('Timestamp record missing tsr_base64')
      }
      if (!ts.hash) {
        errors.push('Timestamp record missing hash')
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Serializes a bundle to a plain object suitable for JSON.stringify or storage.
 *
 * @param {EvidenceBundle} bundle
 * @returns {Object}
 */
export function serializeBundle(bundle) {
  return {
    manifest: bundle.manifest,
    events_ndjson: bundle.eventsNDJSON,
    redactions: bundle.redactions,
    signatures: bundle.signatures,
    attachments: bundle.attachments
  }
}

/**
 * Deserializes a bundle from a plain object.
 *
 * @param {Object} obj
 * @returns {EvidenceBundle}
 */
export function deserializeBundle(obj) {
  return {
    manifest: obj.manifest,
    eventsNDJSON: obj.events_ndjson,
    redactions: obj.redactions || null,
    signatures: obj.signatures || [],
    attachments: obj.attachments || []
  }
}
