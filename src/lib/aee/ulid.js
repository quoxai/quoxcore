/**
 * ULID Generator
 * Universally Unique Lexicographically Sortable Identifier
 *
 * @fileoverview Generates ULIDs for AEE envelope IDs.
 * ULIDs are time-sortable unique identifiers (26 characters).
 *
 * Format: TTTTTTTTTTRRRRRRRRRRRRRRR
 * - T = timestamp (10 chars, 48 bits - ms since Unix epoch)
 * - R = randomness (16 chars, 80 bits)
 *
 * Uses Crockford's Base32 encoding (excludes I, L, O, U to avoid ambiguity)
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LENGTH = 32
const ULID_LENGTH = 26
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16

// Maximum timestamp (10889-08-02T05:31:50.655Z)
const MAX_TIME = Math.pow(2, 48) - 1

// Track last timestamp and random values for monotonicity
let lastTime = 0
let lastRandom = new Array(RANDOM_LENGTH).fill(0)

/**
 * Encodes a timestamp to Crockford's Base32
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} - 10 character encoded string
 */
function encodeTime(timestamp) {
  if (timestamp > MAX_TIME) {
    throw new Error('ULID timestamp overflow')
  }

  let str = ''
  for (let i = TIME_LENGTH - 1; i >= 0; i--) {
    const mod = timestamp % ENCODING_LENGTH
    str = CROCKFORD_BASE32[mod] + str
    timestamp = Math.floor(timestamp / ENCODING_LENGTH)
  }
  return str
}

/**
 * Generates random component using crypto API
 * Requires a cryptographically secure random source - does not fall back to Math.random()
 * @returns {number[]} Array of 16 random values (0-31 each)
 * @throws {Error} If crypto.getRandomValues is not available
 */
function generateRandomness() {
  const random = new Array(RANDOM_LENGTH)

  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(RANDOM_LENGTH)
    crypto.getRandomValues(bytes)
    for (let i = 0; i < RANDOM_LENGTH; i++) {
      random[i] = bytes[i] % ENCODING_LENGTH
    }
  } else {
    // Do not fall back to Math.random() - it is not cryptographically secure
    throw new Error('crypto.getRandomValues is required for secure ULID generation')
  }

  return random
}

/**
 * Encodes random component to Crockford's Base32
 * @param {number[]} random - Array of 16 random values (0-31 each)
 * @returns {string} - 16 character encoded string
 */
function encodeRandom(random) {
  return random.map(v => CROCKFORD_BASE32[v]).join('')
}

/**
 * Increments the random component for monotonicity
 * @param {number[]} random - Current random values
 * @returns {number[]} - Incremented random values
 */
function incrementRandom(random) {
  const newRandom = [...random]
  for (let i = RANDOM_LENGTH - 1; i >= 0; i--) {
    if (newRandom[i] < ENCODING_LENGTH - 1) {
      newRandom[i]++
      return newRandom
    }
    newRandom[i] = 0
  }
  throw new Error('ULID random overflow (too many IDs in same millisecond)')
}

/**
 * Generates a new ULID
 *
 * @param {number} [timestamp] - Optional timestamp (defaults to Date.now())
 * @returns {string} - 26 character ULID string
 *
 * @example
 * const id = ulid() // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
 *
 * @example
 * const id = ulid(1469918176385) // With specific timestamp
 */
export function ulid(timestamp = Date.now()) {
  // Ensure monotonicity within same millisecond
  if (timestamp <= lastTime) {
    lastRandom = incrementRandom(lastRandom)
  } else {
    lastTime = timestamp
    lastRandom = generateRandomness()
  }

  return encodeTime(timestamp) + encodeRandom(lastRandom)
}

/**
 * Extracts the timestamp from a ULID
 *
 * @param {string} id - ULID string
 * @returns {number} - Unix timestamp in milliseconds
 *
 * @example
 * const ts = ulidTime("01ARZ3NDEKTSV4RRFFQ69G5FAV") // 1469918176385
 */
export function ulidTime(id) {
  if (typeof id !== 'string' || id.length !== ULID_LENGTH) {
    throw new Error('Invalid ULID format')
  }

  const timeChars = id.slice(0, TIME_LENGTH).toUpperCase()
  let timestamp = 0

  for (const char of timeChars) {
    const index = CROCKFORD_BASE32.indexOf(char)
    if (index === -1) {
      throw new Error(`Invalid character in ULID: ${char}`)
    }
    timestamp = timestamp * ENCODING_LENGTH + index
  }

  return timestamp
}

/**
 * Validates a ULID format
 *
 * @param {string} id - String to validate
 * @returns {boolean} - True if valid ULID format
 */
export function isValidUlid(id) {
  if (typeof id !== 'string' || id.length !== ULID_LENGTH) {
    return false
  }

  const upper = id.toUpperCase()
  for (const char of upper) {
    if (!CROCKFORD_BASE32.includes(char)) {
      return false
    }
  }

  return true
}

/**
 * Generates a ULID with a specific prefix for categorization
 *
 * @param {string} prefix - Category prefix (e.g., "CONV", "HB", "JOB")
 * @returns {string} - ULID with prefix: "PREFIX_01ARZ3NDEKTSV4RRFFQ69G5FAV"
 *
 * @example
 * const convId = prefixedUlid("CONV") // "CONV_01ARZ3NDEKTSV4RRFFQ69G5FAV"
 */
export function prefixedUlid(prefix) {
  return `${prefix}_${ulid()}`
}

/**
 * Compares two ULIDs for sorting
 *
 * @param {string} a - First ULID
 * @param {string} b - Second ULID
 * @returns {number} - Negative if a < b, positive if a > b, 0 if equal
 */
export function compareUlid(a, b) {
  return a.localeCompare(b)
}

export default ulid
