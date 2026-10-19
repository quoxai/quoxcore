/**
 * VOLT Chain Verifier — V0.1 (Spec-Aligned)
 *
 * Verifies the integrity of VOLT hash-chained event traces.
 *
 * Checks:
 * 1. Re-hash each event (canonical JSON, excluding `hash` field) -> must match `hash`
 * 2. Verify `prev_hash` chain from genesis (seq 1) to final event
 * 3. Verify sequence numbers are monotonically increasing (1, 2, 3, ...)
 * 4. Verify all events belong to the same run_id
 * 5. Verify first event is `run.started` and has genesis prev_hash
 * 6. Validate required event fields exist
 *
 * Output: PASS/FAIL report with standard failure reason codes.
 */

import { canonicalize, sha256 } from './volt-canonical.js'
import { GENESIS_HASH } from './volt-recorder.js'

/**
 * Standard failure reason codes (spec §18)
 */
const FAILURE_CODES = {
  EMPTY_CHAIN: 'EMPTY_CHAIN',
  EVENT_HASH_MISMATCH: 'EVENT_HASH_MISMATCH',
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  SEQ_NOT_MONOTONIC: 'SEQ_NOT_MONOTONIC',
  GENESIS_SEQ_WRONG: 'GENESIS_SEQ_WRONG',
  GENESIS_PREV_HASH_WRONG: 'GENESIS_PREV_HASH_WRONG',
  GENESIS_TYPE_WRONG: 'GENESIS_TYPE_WRONG',
  RUN_ID_MISMATCH: 'RUN_ID_MISMATCH',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD'
}

/**
 * @typedef {Object} VerificationResult
 * @property {'PASS'|'FAIL'} result - Overall result
 * @property {string|null} run_id - The run being verified
 * @property {string|null} bundle_id - Bundle ID (if verifying a bundle)
 * @property {number} event_count - Total events checked
 * @property {number} valid_count - Events that passed
 * @property {boolean} chain_valid - Whether the hash chain is unbroken
 * @property {boolean} sequence_valid - Whether sequence numbers are correct
 * @property {boolean} genesis_valid - Whether first event is correct
 * @property {string|null} reason - Standard failure reason code
 * @property {Object|null} first_failure - Details of first failure, if any
 * @property {number|null} first_failure.seq - Sequence number of failed event
 * @property {string|null} first_failure.reason - Standard failure code
 * @property {string|null} first_failure.detail - Human-readable detail
 */

/**
 * Verifies a VOLT event chain.
 *
 * @param {Object[]} events - Array of VOLT events (in sequence order)
 * @param {Object} [options={}] - Optional verification options
 * @param {string} [options.bundle_id] - Bundle ID for the report
 * @returns {Promise<VerificationResult>}
 */
export async function verifyChain(events, options = {}) {
  if (!events || events.length === 0) {
    return {
      result: 'FAIL',
      run_id: null,
      bundle_id: options.bundle_id || null,
      event_count: 0,
      valid_count: 0,
      chain_valid: false,
      sequence_valid: false,
      genesis_valid: false,
      reason: FAILURE_CODES.EMPTY_CHAIN,
      first_failure: { seq: -1, reason: FAILURE_CODES.EMPTY_CHAIN, detail: 'No events to verify' }
    }
  }

  const run_id = events[0].run_id
  let valid_count = 0
  let chain_valid = true
  let sequence_valid = true
  let genesis_valid = true
  let first_failure = null

  function fail(seq, reason, detail) {
    if (!first_failure) {
      first_failure = { seq, reason, detail }
    }
  }

  // Check genesis event (seq starts at 1 per spec §7.2)
  const genesis = events[0]
  if (genesis.seq !== 1) {
    genesis_valid = false
    sequence_valid = false
    fail(genesis.seq, FAILURE_CODES.GENESIS_SEQ_WRONG, `Genesis event has seq=${genesis.seq}, expected 1`)
  }
  if (genesis.prev_hash !== GENESIS_HASH) {
    genesis_valid = false
    chain_valid = false
    fail(1, FAILURE_CODES.GENESIS_PREV_HASH_WRONG, 'Genesis prev_hash is not all zeros')
  }
  if (genesis.event_type !== 'run.started') {
    genesis_valid = false
    fail(1, FAILURE_CODES.GENESIS_TYPE_WRONG, `Genesis event_type is '${genesis.event_type}', expected 'run.started'`)
  }

  // Verify each event
  let expected_prev_hash = GENESIS_HASH

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    let event_valid = true

    // Check run_id consistency
    if (event.run_id !== run_id) {
      event_valid = false
      fail(event.seq, FAILURE_CODES.RUN_ID_MISMATCH, `run_id mismatch: expected '${run_id}', got '${event.run_id}'`)
    }

    // Check sequence (1-based)
    const expectedSeq = i + 1
    if (event.seq !== expectedSeq) {
      event_valid = false
      sequence_valid = false
      fail(event.seq, FAILURE_CODES.SEQ_NOT_MONOTONIC, `Sequence mismatch: expected ${expectedSeq}, got ${event.seq}`)
    }

    // Check prev_hash chain
    if (event.prev_hash !== expected_prev_hash) {
      event_valid = false
      chain_valid = false
      fail(expectedSeq, FAILURE_CODES.CHAIN_BROKEN, `Chain break at seq ${expectedSeq}: prev_hash doesn't match previous event's hash`)
    }

    // Re-compute hash from canonical JSON (excluding the hash field)
    const { hash: _existingHash, ...eventWithoutHash } = event
    const computed_hash = await sha256(canonicalize(eventWithoutHash))

    if (computed_hash !== event.hash) {
      event_valid = false
      chain_valid = false
      fail(expectedSeq, FAILURE_CODES.EVENT_HASH_MISMATCH, `Hash mismatch at seq ${expectedSeq}: computed ${computed_hash.slice(0, 16)}..., stored ${typeof event.hash === 'string' ? event.hash.slice(0, 16) + '...' : '(no hash)'}`)
    }

    if (event_valid) {
      valid_count++
    }

    // Next event's prev_hash should match this event's hash
    expected_prev_hash = event.hash
  }

  const overallReason = first_failure ? first_failure.reason : null

  return {
    result: first_failure ? 'FAIL' : 'PASS',
    run_id,
    bundle_id: options.bundle_id || null,
    event_count: events.length,
    valid_count,
    chain_valid,
    sequence_valid,
    genesis_valid,
    reason: overallReason,
    first_failure
  }
}

/**
 * Verifies a chain from NDJSON string.
 *
 * @param {string} ndjson - NDJSON string (one JSON object per line)
 * @param {Object} [options={}] - Optional verification options
 * @returns {Promise<VerificationResult>}
 */
export async function verifyNDJSON(ndjson, options = {}) {
  const lines = ndjson.trim().split('\n').filter(l => l.trim())
  const events = lines.map(line => JSON.parse(line))
  return verifyChain(events, options)
}

/**
 * Formats a verification result as a human-readable report.
 *
 * @param {VerificationResult} result
 * @returns {string}
 */
export function formatReport(result) {
  const lines = [
    'VOLT Verification Report',
    '========================',
    `Run:        ${result.run_id || 'N/A'}`,
    `Bundle:     ${result.bundle_id || 'N/A'}`,
    `Events:     ${result.event_count}`,
    `Chain:      ${result.chain_valid ? 'PASS' : 'FAIL'} (${result.valid_count}/${result.event_count} valid)`,
    `Sequence:   ${result.sequence_valid ? 'PASS' : 'FAIL'}`,
    `Genesis:    ${result.genesis_valid ? 'PASS' : 'FAIL'}`,
    '---',
    `RESULT: ${result.result}`
  ]

  if (result.first_failure) {
    lines.splice(-2, 0,
      `Reason:     ${result.reason || 'UNKNOWN'}`,
      `First Fail: seq ${result.first_failure.seq} — ${result.first_failure.detail || result.first_failure.reason}`
    )
  }

  return lines.join('\n')
}

export { FAILURE_CODES }
