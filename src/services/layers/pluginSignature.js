/**
 * Plugin Signature Verification - Code Signing for AOCL Plugins
 *
 * Provides cryptographic verification of plugin authenticity using Ed25519 signatures.
 * Ensures plugins come from trusted sources and haven't been tampered with.
 * Part of AOCL Security (Issue #70)
 */

// Trusted public keys for plugin verification
// In production, these would be loaded from a secure configuration
const TRUSTED_SIGNING_KEYS = new Map()

// Plugin signature settings
const SIGNATURE_CONFIG = {
  // Whether to require signatures for all plugins
  requireSignatures: true,
  // Whether to allow unsigned plugins in development mode
  allowUnsignedInDev: false,
  // Algorithm used for signing
  algorithm: 'Ed25519',
  // Hash algorithm for manifest digest
  hashAlgorithm: 'SHA-256'
}

// Consolidated storage key
import { queueSync } from '../serverSyncQueue'

const CONSOLIDATED_KEY = 'aocl-signature-state'
const OLD_TRUSTED_KEY = 'aocl_trusted_signing_keys'
const OLD_CONFIG_KEY = 'aocl_signature_config'

function loadSignatureState() {
  try {
    const raw = localStorage.getItem(CONSOLIDATED_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* fall through */ }

  // Migrate from old keys
  let state = { trustedKeys: [], config: null }
  let migrated = false
  try {
    const oldKeys = localStorage.getItem(OLD_TRUSTED_KEY)
    if (oldKeys) { state.trustedKeys = JSON.parse(oldKeys); migrated = true; localStorage.removeItem(OLD_TRUSTED_KEY) }
  } catch { /* skip */ }
  try {
    const oldConfig = localStorage.getItem(OLD_CONFIG_KEY)
    if (oldConfig) { state.config = JSON.parse(oldConfig); migrated = true; localStorage.removeItem(OLD_CONFIG_KEY) }
  } catch { /* skip */ }
  if (migrated) {
    localStorage.setItem(CONSOLIDATED_KEY, JSON.stringify(state))
    queueSync('aoclSignatureState', state)
    console.log('[PluginSignature] Migrated to consolidated storage')
  }
  return state
}

function saveSignatureState() {
  const keys = Array.from(TRUSTED_SIGNING_KEYS.entries()).map(([keyId, data]) => ({ keyId, ...data }))
  const state = { trustedKeys: keys, config: SIGNATURE_CONFIG }
  try {
    localStorage.setItem(CONSOLIDATED_KEY, JSON.stringify(state))
    queueSync('aoclSignatureState', state)
  } catch { /* quota */ }
}

/**
 * Initialize signature verification system
 * Loads trusted keys from storage
 */
export function initializeSignatureVerification() {
  try {
    const state = loadSignatureState()

    if (state.trustedKeys) {
      for (const key of state.trustedKeys) {
        TRUSTED_SIGNING_KEYS.set(key.keyId, {
          publicKey: key.publicKey,
          name: key.name,
          addedAt: key.addedAt,
          trusted: key.trusted
        })
      }
    }

    if (state.config) {
      Object.assign(SIGNATURE_CONFIG, state.config)
    }

    console.log('[PluginSignature] Initialized with', TRUSTED_SIGNING_KEYS.size, 'trusted keys')
  } catch (err) {
    console.error('[PluginSignature] Failed to initialize:', err)
  }
}

/**
 * Add a trusted signing key
 * @param {object} keyData - Key data
 * @param {string} keyData.keyId - Unique key identifier
 * @param {string} keyData.publicKey - Base64-encoded public key
 * @param {string} keyData.name - Human-readable key name
 * @returns {{success: boolean, error?: string}}
 */
export function addTrustedKey(keyData) {
  try {
    if (!keyData.keyId || !keyData.publicKey || !keyData.name) {
      return { success: false, error: 'Missing required key fields (keyId, publicKey, name)' }
    }

    // Validate key format (base64)
    if (!isValidBase64(keyData.publicKey)) {
      return { success: false, error: 'Invalid public key format (must be base64)' }
    }

    TRUSTED_SIGNING_KEYS.set(keyData.keyId, {
      publicKey: keyData.publicKey,
      name: keyData.name,
      addedAt: new Date().toISOString(),
      trusted: true
    })

    saveTrustedKeys()
    console.log('[PluginSignature] Added trusted key:', keyData.keyId)
    return { success: true }
  } catch (err) {
    console.error('[PluginSignature] Failed to add key:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Remove a trusted signing key
 * @param {string} keyId - Key identifier to remove
 * @returns {{success: boolean, error?: string}}
 */
export function removeTrustedKey(keyId) {
  if (!TRUSTED_SIGNING_KEYS.has(keyId)) {
    return { success: false, error: `Key "${keyId}" not found` }
  }

  TRUSTED_SIGNING_KEYS.delete(keyId)
  saveTrustedKeys()
  console.log('[PluginSignature] Removed trusted key:', keyId)
  return { success: true }
}

/**
 * Get all trusted signing keys
 * @returns {object[]}
 */
export function getTrustedKeys() {
  return Array.from(TRUSTED_SIGNING_KEYS.entries()).map(([keyId, data]) => ({
    keyId,
    ...data
  }))
}

/**
 * Get signature configuration
 * @returns {object}
 */
export function getSignatureConfig() {
  return { ...SIGNATURE_CONFIG }
}

/**
 * Update signature configuration
 * @param {object} updates - Config updates
 * @returns {{success: boolean}}
 */
export function updateSignatureConfig(updates) {
  const allowedFields = ['requireSignatures', 'allowUnsignedInDev']
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      SIGNATURE_CONFIG[field] = updates[field]
    }
  }
  saveSignatureConfig()
  console.log('[PluginSignature] Updated config:', SIGNATURE_CONFIG)
  return { success: true }
}

/**
 * Verify a plugin's signature
 * @param {object} plugin - Plugin manifest with signature data
 * @returns {Promise<{valid: boolean, error?: string, keyId?: string, warnings: string[]}>}
 */
export async function verifyPluginSignature(plugin) {
  const warnings = []

  // Check if plugin has signature data
  if (!plugin.signature) {
    if (SIGNATURE_CONFIG.requireSignatures) {
      if (SIGNATURE_CONFIG.allowUnsignedInDev && isDevelopmentMode()) {
        warnings.push('Plugin is unsigned - allowed in development mode only')
        console.warn('[PluginSignature] Unsigned plugin allowed in dev mode:', plugin.id)
        return { valid: true, unsigned: true, warnings }
      }
      console.warn('[PluginSignature] Rejected unsigned plugin:', plugin.id)
      return { valid: false, error: 'Plugin is not signed. Code signing is required for security.', warnings }
    }
    warnings.push('Plugin is unsigned')
    return { valid: true, unsigned: true, warnings }
  }

  // Extract signature data
  const { keyId, digest, signature, algorithm, timestamp } = plugin.signature

  // Validate signature structure
  if (!keyId || !digest || !signature) {
    return { valid: false, error: 'Incomplete signature data (missing keyId, digest, or signature)', warnings }
  }

  // Check if we trust this key
  const trustedKey = TRUSTED_SIGNING_KEYS.get(keyId)
  if (!trustedKey) {
    console.warn('[PluginSignature] Unknown signing key:', keyId)
    return { valid: false, error: `Unknown signing key: ${keyId}. Add the key to trusted keys to install this plugin.`, warnings }
  }

  if (!trustedKey.trusted) {
    return { valid: false, error: `Signing key "${keyId}" is not trusted`, warnings }
  }

  // Verify the manifest digest
  const computedDigest = await computeManifestDigest(plugin)
  if (computedDigest !== digest) {
    console.warn('[PluginSignature] Digest mismatch for plugin:', plugin.id)
    return {
      valid: false,
      error: 'Plugin manifest has been modified. The digest does not match the signature.',
      warnings
    }
  }

  // Verify the cryptographic signature
  try {
    const isValid = await verifySignature(digest, signature, trustedKey.publicKey)
    if (!isValid) {
      console.warn('[PluginSignature] Invalid signature for plugin:', plugin.id)
      return { valid: false, error: 'Invalid cryptographic signature', warnings }
    }
  } catch (err) {
    console.error('[PluginSignature] Signature verification failed:', err)
    return { valid: false, error: `Signature verification error: ${err.message}`, warnings }
  }

  // Check signature timestamp if present
  if (timestamp) {
    const signedAt = new Date(timestamp)
    const now = new Date()
    const maxAge = 365 * 24 * 60 * 60 * 1000 // 1 year
    if (now - signedAt > maxAge) {
      warnings.push('Signature is older than 1 year - consider requesting a re-signed version')
    }
  }

  console.log('[PluginSignature] Verified plugin:', plugin.id, 'signed by:', keyId)
  return {
    valid: true,
    keyId,
    signedAt: timestamp,
    signedBy: trustedKey.name,
    warnings
  }
}

/**
 * Compute the digest of a plugin manifest
 * Creates a canonical representation and hashes it
 * @param {object} plugin - Plugin manifest
 * @returns {Promise<string>} - Base64-encoded digest
 */
export async function computeManifestDigest(plugin) {
  // Create canonical manifest representation (excluding signature)
  const canonicalManifest = createCanonicalManifest(plugin)
  const manifestString = JSON.stringify(canonicalManifest)

  // Compute SHA-256 hash
  const encoder = new TextEncoder()
  const data = encoder.encode(manifestString)

  // Use SubtleCrypto for hashing
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)
  return arrayToBase64(hashArray)
}

/**
 * Create a canonical representation of the manifest for signing
 * Removes signature field and sorts keys for consistent hashing
 * @param {object} plugin - Plugin manifest
 * @returns {object}
 */
function createCanonicalManifest(plugin) {
  const manifest = { ...plugin }

  // Remove signature from canonical form
  delete manifest.signature

  // Sort keys recursively for deterministic serialization
  return sortObjectKeys(manifest)
}

/**
 * Recursively sort object keys
 * @param {any} obj - Object to sort
 * @returns {any}
 */
function sortObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys)
  }

  const sorted = {}
  const keys = Object.keys(obj).sort()
  for (const key of keys) {
    sorted[key] = sortObjectKeys(obj[key])
  }
  return sorted
}

/**
 * Verify a cryptographic signature using Web Crypto API
 * @param {string} digest - Base64-encoded digest
 * @param {string} signature - Base64-encoded signature
 * @param {string} publicKeyBase64 - Base64-encoded public key
 * @returns {Promise<boolean>}
 */
async function verifySignature(digest, signature, publicKeyBase64) {
  try {
    // Decode base64 values
    const signatureBytes = base64ToArray(signature)
    const publicKeyBytes = base64ToArray(publicKeyBase64)
    const digestBytes = base64ToArray(digest)

    // Import the public key
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      {
        name: 'Ed25519'
      },
      false,
      ['verify']
    )

    // Verify the signature
    const isValid = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signatureBytes,
      digestBytes
    )

    return isValid
  } catch (err) {
    // Ed25519 may not be available in all browsers
    // Fall back to a warning if not supported
    if (err.name === 'NotSupportedError') {
      console.warn('[PluginSignature] Ed25519 not supported in this browser, using fallback verification')
      return verifySignatureFallback(digest, signature, publicKeyBase64)
    }
    throw err
  }
}

/**
 * Fallback signature verification for browsers without Ed25519 support
 * Uses ECDSA P-256 as a fallback
 * @param {string} digest - Base64-encoded digest
 * @param {string} signature - Base64-encoded signature
 * @param {string} publicKeyBase64 - Base64-encoded public key
 * @returns {Promise<boolean>}
 */
async function verifySignatureFallback(digest, signature, publicKeyBase64) {
  try {
    const signatureBytes = base64ToArray(signature)
    const publicKeyBytes = base64ToArray(publicKeyBase64)
    const digestBytes = base64ToArray(digest)

    // Try ECDSA P-256 as fallback
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      {
        name: 'ECDSA',
        namedCurve: 'P-256'
      },
      false,
      ['verify']
    )

    const isValid = await crypto.subtle.verify(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' }
      },
      publicKey,
      signatureBytes,
      digestBytes
    )

    return isValid
  } catch (err) {
    console.error('[PluginSignature] Fallback verification failed:', err)
    throw new Error('Signature verification not supported in this browser')
  }
}

/**
 * Sign a plugin manifest (for plugin developers)
 * @param {object} plugin - Plugin manifest to sign
 * @param {CryptoKey} privateKey - Private signing key
 * @param {string} keyId - Identifier for the signing key
 * @returns {Promise<object>} - Signed plugin manifest
 */
export async function signPlugin(plugin, privateKey, keyId) {
  // Compute manifest digest
  const digest = await computeManifestDigest(plugin)

  // Sign the digest
  const digestBytes = base64ToArray(digest)
  const signatureBuffer = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    digestBytes
  )

  const signature = arrayToBase64(new Uint8Array(signatureBuffer))

  // Return plugin with signature
  return {
    ...plugin,
    signature: {
      keyId,
      digest,
      signature,
      algorithm: 'Ed25519',
      timestamp: new Date().toISOString()
    }
  }
}

/**
 * Generate a new signing key pair (for plugin developers)
 * @returns {Promise<{publicKey: string, privateKey: CryptoKey, keyId: string}>}
 */
export async function generateSigningKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    'Ed25519',
    true,
    ['sign', 'verify']
  )

  // Export public key
  const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  const publicKey = arrayToBase64(new Uint8Array(publicKeyBuffer))

  // Generate key ID from public key hash
  const keyIdBuffer = await crypto.subtle.digest('SHA-256', publicKeyBuffer)
  const keyId = arrayToBase64(new Uint8Array(keyIdBuffer)).slice(0, 16)

  return {
    publicKey,
    privateKey: keyPair.privateKey,
    keyId
  }
}

// Helper functions

function isValidBase64(str) {
  try {
    return btoa(atob(str)) === str
  } catch {
    return false
  }
}

function arrayToBase64(array) {
  return btoa(String.fromCharCode.apply(null, array))
}

function base64ToArray(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function isDevelopmentMode() {
  return import.meta.env?.DEV || window.location.hostname === 'localhost'
}

function saveTrustedKeys() {
  saveSignatureState()
}

function saveSignatureConfig() {
  saveSignatureState()
}

// Initialize on module load
initializeSignatureVerification()

export default {
  initializeSignatureVerification,
  verifyPluginSignature,
  computeManifestDigest,
  addTrustedKey,
  removeTrustedKey,
  getTrustedKeys,
  getSignatureConfig,
  updateSignatureConfig,
  signPlugin,
  generateSigningKeyPair
}
