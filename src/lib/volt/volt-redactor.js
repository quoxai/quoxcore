/**
 * VOLT Redactor — V0.1 (Spec-Aligned)
 *
 * Two redaction modes:
 *
 * 1. Simple omit-at-source (spec v0.1 conformant):
 *    - Fields are replaced with undefined (omitted from JSON)
 *    - `payload.redacted: true` flag is set
 *    - No cryptographic proof, no chain recomputation
 *    - Use omitFields() for this mode
 *
 * 2. Cryptographic redaction (v0.2 extension, ahead of spec):
 *    - Fields are replaced with "[REDACTED]"
 *    - Salted SHA-256 commitments stored for each redacted field
 *    - Hash chain is recomputed to remain self-consistent
 *    - Use redactEvents() for this mode
 *
 * Redactions manifest format (spec-aligned):
 *   {
 *     volt_version: '0.1',
 *     run_id,
 *     items: [
 *       { event_id, fields_removed: [...], reason: 'secret' }
 *     ]
 *   }
 */

import { canonicalize, sha256 } from './volt-canonical.js'

const REDACTED = '[REDACTED]'

/**
 * Generates a random salt for redaction commitments.
 * @returns {string} 32-character hex string
 */
function generateSalt() {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // Fallback for testing
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')
}

/**
 * Gets a nested value from an object using a dot-separated path.
 * @param {Object} obj
 * @param {string} path - e.g., "payload.credentials.token"
 * @returns {*}
 */
function getNestedValue(obj, path) {
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/**
 * Sets a nested value on an object using a dot-separated path.
 * @param {Object} obj
 * @param {string} path
 * @param {*} value
 */
function setNestedValue(obj, path, value) {
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {}
    }
    current = current[parts[i]]
  }
  current[parts[parts.length - 1]] = value
}

/**
 * Deletes a nested value from an object using a dot-separated path.
 * @param {Object} obj
 * @param {string} path
 */
function deleteNestedValue(obj, path) {
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') return
    current = current[parts[i]]
  }
  delete current[parts[parts.length - 1]]
}

/**
 * Simple omit-at-source redaction (spec v0.1 conformant).
 * Fields are removed from the event and a redacted flag is set.
 * No chain recomputation — the original hashes remain.
 *
 * @param {Object[]} events - Original VOLT events
 * @param {string[]} fieldPaths - Dot-separated field paths to omit
 * @param {string} [reason='secret'] - Reason for redaction
 * @returns {{redactedEvents: Object[], redactionMap: Object}}
 */
export function omitFields(events, fieldPaths, reason = 'secret') {
  const items = []
  const redactedEvents = []

  for (const event of events) {
    const clone = JSON.parse(JSON.stringify(event))
    const fieldsRemoved = []

    for (const fieldPath of fieldPaths) {
      const value = getNestedValue(clone, fieldPath)
      if (value === undefined) continue

      deleteNestedValue(clone, fieldPath)
      fieldsRemoved.push(fieldPath)
    }

    if (fieldsRemoved.length > 0) {
      // Set redacted flag in payload
      if (!clone.payload) clone.payload = {}
      clone.payload.redacted = true

      items.push({
        event_id: clone.event_id,
        fields_removed: fieldsRemoved,
        reason
      })
    }

    redactedEvents.push(clone)
  }

  const redactionMap = {
    volt_version: '0.1',
    run_id: events[0]?.run_id,
    items
  }

  return { redactedEvents, redactionMap }
}

/**
 * Cryptographic redaction with salted commitments (v0.2 extension).
 * Fields are replaced with "[REDACTED]" and the hash chain is recomputed.
 *
 * @param {Object[]} events - Original VOLT events
 * @param {string[]} fieldPaths - Dot-separated field paths to redact
 * @returns {Promise<{redactedEvents: Object[], redactionMap: Object}>}
 */
export async function redactEvents(events, fieldPaths) {
  const redactionEntries = []
  const items = []
  const redactedEvents = []
  let prevHash = events[0]?.prev_hash || '0'.repeat(64)

  for (let i = 0; i < events.length; i++) {
    const event = JSON.parse(JSON.stringify(events[i])) // deep clone
    const eventRedactions = []
    const fieldsRemoved = []

    for (const fieldPath of fieldPaths) {
      const originalValue = getNestedValue(event, fieldPath)
      if (originalValue === undefined || originalValue === REDACTED) continue

      const salt = generateSalt()
      const commitment = await sha256(salt + JSON.stringify(originalValue))

      setNestedValue(event, fieldPath, REDACTED)
      fieldsRemoved.push(fieldPath)

      eventRedactions.push({
        field: fieldPath,
        salt,
        commitment,
        original_hash: events[i].hash
      })
    }

    if (eventRedactions.length > 0) {
      // Recompute hash for redacted event
      event.prev_hash = prevHash
      const { hash: _, ...eventBody } = event
      event.hash = await sha256(canonicalize(eventBody))

      redactionEntries.push({
        seq: event.seq,
        original_hash: events[i].hash,
        redacted_hash: event.hash,
        fields: eventRedactions
      })

      // Spec-aligned items entry
      items.push({
        event_id: event.event_id,
        fields_removed: fieldsRemoved,
        reason: 'secret'
      })
    } else {
      // No redaction needed but we still need to update prev_hash
      // if a previous event was redacted
      if (event.prev_hash !== prevHash) {
        event.prev_hash = prevHash
        const { hash: _, ...eventBody } = event
        event.hash = await sha256(canonicalize(eventBody))
      }
    }

    prevHash = event.hash
    redactedEvents.push(event)
  }

  const redactionMap = {
    volt_version: '0.1',
    run_id: events[0]?.run_id,
    created_ts: new Date().toISOString(),
    field_paths: fieldPaths,
    entry_count: redactionEntries.length,
    entries: redactionEntries,
    // Spec-aligned items format
    items
  }

  return { redactedEvents, redactionMap }
}

/**
 * Verifies a redaction commitment.
 * Given the original value and salt, checks if the commitment matches.
 *
 * @param {*} originalValue - The original (unredacted) value
 * @param {string} salt - The salt from the redaction map
 * @param {string} commitment - The expected commitment hash
 * @returns {Promise<boolean>}
 */
export async function verifyRedactionCommitment(originalValue, salt, commitment) {
  const computed = await sha256(salt + JSON.stringify(originalValue))
  return computed === commitment
}

export { REDACTED }
