/**
 * AEE (Agent Envelope Exchange) Type Definitions
 * "HTTP headers for agent swarms"
 *
 * @fileoverview Defines the AEE envelope structure and related types.
 * See: https://github.com/quoxai/aee
 */

/**
 * @typedef {'task' | 'result' | 'event' | 'error' | 'stream'} EnvelopeType
 */

/**
 * @typedef {'low' | 'normal' | 'high' | 'urgent'} Priority
 */

/**
 * @typedef {Object} TraceContext
 * @property {string} trace_id - Distributed trace ID
 * @property {string} span_id - Current span ID
 */

/**
 * @typedef {Object} Requirements
 * @property {number} [timeout_ms] - Operation timeout in milliseconds
 * @property {boolean} [evidence] - Whether evidence bundle is required
 * @property {boolean} [approval] - Whether human approval is required
 */

/**
 * @typedef {Object} AEEEnvelope
 * @property {'1'} v - Protocol version (always "1")
 * @property {string} id - ULID (sortable unique ID)
 * @property {string} ts - ISO 8601 timestamp
 * @property {EnvelopeType} type - Message type
 * @property {string} from - Sender identifier (e.g., "human.adam", "agent.cipher", "quoxagent.docker01")
 * @property {string} to - Recipient identifier
 * @property {string} intent - Namespaced action (e.g., "quox.chat.query", "quoxagent.heartbeat.report")
 * @property {string} corr - Correlation ID (same across entire conversation)
 * @property {string|null} reply_to - Parent message ID (creates causality chain)
 * @property {Object} payload - Intent-specific data
 * @property {TraceContext} [trace] - Distributed tracing context
 * @property {Priority} [priority] - Message priority
 * @property {Requirements} [requires] - Execution requirements
 * @property {string|null} [sig] - Cryptographic signature
 * @property {string[]} [evidence_refs] - References to collected evidence (QuoxFlow)
 */

/**
 * Valid envelope types
 * @type {EnvelopeType[]}
 */
export const ENVELOPE_TYPES = ['task', 'result', 'event', 'error', 'stream']

/**
 * Valid priority levels
 * @type {Priority[]}
 */
export const PRIORITY_LEVELS = ['low', 'normal', 'high', 'urgent']

/**
 * Protocol version
 * @type {string}
 */
export const PROTOCOL_VERSION = '1'

/**
 * Required fields for a valid AEE envelope
 * @type {string[]}
 */
export const REQUIRED_FIELDS = [
  'v', 'id', 'ts', 'type', 'from', 'to', 'intent', 'corr', 'reply_to', 'payload'
]

/**
 * Validates an envelope structure
 * @param {Object} envelope - The envelope to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateEnvelope(envelope) {
  const errors = []

  // Handle null/undefined/non-objects
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return {
      valid: false,
      errors: ['Envelope must be a non-null object']
    }
  }

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in envelope)) {
      errors.push(`Missing required field: ${field}`)
    }
  }

  // Validate version
  if (envelope.v && envelope.v !== PROTOCOL_VERSION) {
    errors.push(`Invalid protocol version: ${envelope.v} (expected ${PROTOCOL_VERSION})`)
  }

  // Validate type
  if (envelope.type && !ENVELOPE_TYPES.includes(envelope.type)) {
    errors.push(`Invalid envelope type: ${envelope.type}`)
  }

  // Validate priority if present
  if (envelope.priority && !PRIORITY_LEVELS.includes(envelope.priority)) {
    errors.push(`Invalid priority level: ${envelope.priority}`)
  }

  // Validate id format (should be ULID-like)
  if (envelope.id && typeof envelope.id !== 'string') {
    errors.push('ID must be a string')
  }

  // Validate timestamp format
  if (envelope.ts) {
    const parsed = Date.parse(envelope.ts)
    if (isNaN(parsed)) {
      errors.push(`Invalid timestamp format: ${envelope.ts}`)
    }
  }

  // Validate from/to are non-empty strings
  if (envelope.from && (typeof envelope.from !== 'string' || envelope.from.length === 0)) {
    errors.push('Field "from" must be a non-empty string')
  }
  if (envelope.to && (typeof envelope.to !== 'string' || envelope.to.length === 0)) {
    errors.push('Field "to" must be a non-empty string')
  }

  // Validate intent is namespaced
  if (envelope.intent && typeof envelope.intent === 'string') {
    if (!envelope.intent.includes('.')) {
      errors.push('Intent should be namespaced (e.g., "quox.chat.query")')
    }
  }

  // Validate corr is a string
  if (envelope.corr && typeof envelope.corr !== 'string') {
    errors.push('Correlation ID (corr) must be a string')
  }

  // Validate reply_to is string or null
  if (envelope.reply_to !== undefined && envelope.reply_to !== null && typeof envelope.reply_to !== 'string') {
    errors.push('reply_to must be a string or null')
  }

  // Validate payload is an object
  if (envelope.payload && (typeof envelope.payload !== 'object' || Array.isArray(envelope.payload))) {
    errors.push('Payload must be an object')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Type guard to check if an object is a valid AEE envelope
 * @param {any} obj - Object to check
 * @returns {boolean}
 */
export function isAEEEnvelope(obj) {
  return validateEnvelope(obj).valid
}
