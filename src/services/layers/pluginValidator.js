/**
 * Plugin Validator - AOCL Layer Plugin Validation
 *
 * Validates plugin manifests and code for safety and correctness.
 * Includes cryptographic signature verification for plugin authenticity.
 * Part of AOCL Developer Kit (Pro)
 */

import { verifyPluginSignature, getSignatureConfig } from './pluginSignature'

// Valid layer positions for custom plugins
export const VALID_LAYER_POSITIONS = ['L1', 'L4', 'L6', 'L11']

// Position modes
export const VALID_POSITION_MODES = ['before', 'after', 'replace']

// Reference layers that can be used as anchors
export const REFERENCE_LAYERS = ['L0', 'L2', 'L3', 'L5', 'L7', 'L8', 'L9', 'L10']

// Dangerous patterns to check for in code
const DANGEROUS_PATTERNS = [
  { pattern: /eval\s*\(/, message: 'Use of eval() is not allowed' },
  { pattern: /new\s+Function\s*\(/, message: 'Dynamic function creation is not allowed' },
  { pattern: /document\.cookie/, message: 'Access to cookies is not allowed' },
  { pattern: /localStorage\s*\.\s*(?!getItem|setItem)/, message: 'Direct localStorage manipulation is restricted' },
  { pattern: /window\.open/, message: 'Opening new windows is not allowed' },
  { pattern: /fetch\s*\(/, message: 'Network requests require explicit permission' },
  { pattern: /XMLHttpRequest/, message: 'Network requests require explicit permission' },
  { pattern: /import\s*\(/, message: 'Dynamic imports are not allowed' },
  { pattern: /require\s*\(/, message: 'CommonJS require is not allowed' },
  { pattern: /process\./, message: 'Access to process is not allowed' },
  { pattern: /__proto__/, message: 'Prototype manipulation is not allowed' },
  { pattern: /constructor\s*\[/, message: 'Constructor access is not allowed' }
]

// Maximum code size (100KB)
const MAX_CODE_SIZE = 100 * 1024

// Schema for plugin manifest
const MANIFEST_SCHEMA = {
  id: { required: true, type: 'string', pattern: /^[a-z0-9-]+$/, maxLength: 64 },
  name: { required: true, type: 'string', maxLength: 128 },
  version: { required: false, type: 'string', pattern: /^\d+\.\d+\.\d+$/ },
  author: { required: false, type: 'string', maxLength: 128 },
  description: { required: false, type: 'string', maxLength: 500 },
  layer: { required: true, type: 'object' },
  configSchema: { required: false, type: 'object' },
  permissions: { required: false, type: 'array' },
  signature: { required: false, type: 'object' }
}

// Schema for plugin signature (code signing)
const SIGNATURE_SCHEMA = {
  keyId: { required: true, type: 'string', maxLength: 64 },
  digest: { required: true, type: 'string', maxLength: 128 },
  signature: { required: true, type: 'string', maxLength: 256 },
  algorithm: { required: false, type: 'string', pattern: /^(Ed25519|ECDSA-P256)$/ },
  timestamp: { required: false, type: 'string' }
}

/**
 * Validate a plugin manifest
 * @param {object} manifest - Plugin manifest
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validatePluginManifest(manifest) {
  const errors = []
  const warnings = []

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'], warnings: [] }
  }

  // Validate required and optional fields
  for (const [field, rules] of Object.entries(MANIFEST_SCHEMA)) {
    const value = manifest[field]

    // Check required
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`Missing required field: ${field}`)
      continue
    }

    if (value === undefined || value === null) continue

    // Check type
    if (rules.type === 'string' && typeof value !== 'string') {
      errors.push(`Field "${field}" must be a string`)
    } else if (rules.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      errors.push(`Field "${field}" must be an object`)
    } else if (rules.type === 'array' && !Array.isArray(value)) {
      errors.push(`Field "${field}" must be an array`)
    }

    // Check pattern
    if (rules.pattern && typeof value === 'string' && !rules.pattern.test(value)) {
      errors.push(`Field "${field}" has invalid format`)
    }

    // Check maxLength
    if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
      errors.push(`Field "${field}" exceeds max length of ${rules.maxLength}`)
    }
  }

  // Validate layer configuration
  if (manifest.layer && typeof manifest.layer === 'object') {
    const layerResult = validateLayerConfig(manifest.layer)
    errors.push(...layerResult.errors)
    warnings.push(...layerResult.warnings)
  }

  // Validate config schema if present
  if (manifest.configSchema && typeof manifest.configSchema === 'object') {
    const schemaResult = validateConfigSchema(manifest.configSchema)
    warnings.push(...schemaResult.warnings)
  }

  // Check for reserved IDs
  const reservedIds = ['core', 'system', 'aocl', 'quox', 'admin']
  if (reservedIds.some(r => manifest.id?.toLowerCase().startsWith(r))) {
    errors.push('Plugin ID uses a reserved prefix')
  }

  // Validate signature structure if present
  if (manifest.signature && typeof manifest.signature === 'object') {
    const sigResult = validateSignatureStructure(manifest.signature)
    errors.push(...sigResult.errors)
    warnings.push(...sigResult.warnings)
  } else {
    // Warn about missing signature
    const sigConfig = getSignatureConfig()
    if (sigConfig.requireSignatures) {
      warnings.push('Plugin is not signed. Code signing is recommended for security.')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Validate signature structure (not cryptographic validity)
 */
function validateSignatureStructure(signature) {
  const errors = []
  const warnings = []

  // Validate required signature fields
  for (const [field, rules] of Object.entries(SIGNATURE_SCHEMA)) {
    const value = signature[field]

    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`Missing required signature field: ${field}`)
      continue
    }

    if (value === undefined || value === null) continue

    if (rules.type === 'string' && typeof value !== 'string') {
      errors.push(`Signature field "${field}" must be a string`)
    }

    if (rules.pattern && typeof value === 'string' && !rules.pattern.test(value)) {
      errors.push(`Signature field "${field}" has invalid format`)
    }

    if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
      errors.push(`Signature field "${field}" exceeds max length of ${rules.maxLength}`)
    }
  }

  // Warn about old signatures
  if (signature.timestamp) {
    try {
      const signedAt = new Date(signature.timestamp)
      const now = new Date()
      const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000
      if (now - signedAt > sixMonths) {
        warnings.push('Plugin signature is older than 6 months')
      }
    } catch {
      warnings.push('Invalid signature timestamp format')
    }
  }

  return { errors, warnings }
}

/**
 * Validate layer configuration
 */
function validateLayerConfig(layer) {
  const errors = []
  const warnings = []

  // Check position
  if (!layer.position) {
    errors.push('Layer position is required')
  } else if (!VALID_LAYER_POSITIONS.includes(layer.position)) {
    errors.push(`Invalid layer position "${layer.position}". Valid positions: ${VALID_LAYER_POSITIONS.join(', ')}`)
  }

  // Check position mode
  if (layer.positionMode && !VALID_POSITION_MODES.includes(layer.positionMode)) {
    errors.push(`Invalid position mode "${layer.positionMode}". Valid modes: ${VALID_POSITION_MODES.join(', ')}`)
  }

  // Check reference layer
  if (layer.referenceLayer && !REFERENCE_LAYERS.includes(layer.referenceLayer)) {
    warnings.push(`Unknown reference layer "${layer.referenceLayer}"`)
  }

  // Warn about replace mode
  if (layer.positionMode === 'replace') {
    warnings.push('Replace mode will disable the original layer - use with caution')
  }

  return { errors, warnings }
}

/**
 * Validate config schema
 */
function validateConfigSchema(schema) {
  const warnings = []

  // Check for common issues
  for (const [key, def] of Object.entries(schema)) {
    if (!def.type) {
      warnings.push(`Config field "${key}" should have a type`)
    }
    if (def.type === 'string' && !def.maxLength) {
      warnings.push(`Config field "${key}" should have a maxLength for strings`)
    }
  }

  return { warnings }
}

/**
 * Validate plugin code for security
 * @param {string} code - Plugin execute function code
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validatePluginCode(code) {
  const errors = []
  const warnings = []

  if (!code || typeof code !== 'string') {
    return { valid: false, errors: ['Code must be a non-empty string'], warnings: [] }
  }

  // Check code size
  if (code.length > MAX_CODE_SIZE) {
    errors.push(`Code exceeds maximum size of ${MAX_CODE_SIZE / 1024}KB`)
  }

  // Check for dangerous patterns
  for (const { pattern, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(message)
    }
  }

  // Check for common issues
  if (!code.includes('return')) {
    warnings.push('Plugin code should return a result object')
  }

  if (code.includes('while(true)') || code.includes('while (true)')) {
    errors.push('Infinite loops are not allowed')
  }

  // Check for async handling
  if (!code.includes('async') && (code.includes('await') || code.includes('.then('))) {
    warnings.push('Consider using async/await syntax for async operations')
  }

  // Syntax check
  try {
    // Try to parse the code
    new Function(`return ${code}`)
  } catch (err) {
    errors.push(`Syntax error: ${err.message}`)
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Validate a complete plugin (manifest + code)
 * @param {object} plugin - Plugin with manifest and code
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validatePlugin(plugin) {
  const manifestResult = validatePluginManifest(plugin)
  const codeResult = validatePluginCode(plugin.execute || plugin.executeCode)

  return {
    valid: manifestResult.valid && codeResult.valid,
    errors: [...manifestResult.errors, ...codeResult.errors],
    warnings: [...manifestResult.warnings, ...codeResult.warnings]
  }
}

/**
 * Validate a complete plugin with cryptographic signature verification
 * This is the recommended validation method for production use
 * @param {object} plugin - Plugin with manifest, code, and signature
 * @returns {Promise<{valid: boolean, errors: string[], warnings: string[], signatureValid: boolean}>}
 */
export async function validatePluginWithSignature(plugin) {
  // First do basic validation
  const basicResult = validatePlugin(plugin)

  // Then verify cryptographic signature
  const signatureResult = await verifyPluginSignature(plugin)

  const errors = [...basicResult.errors]
  const warnings = [...basicResult.warnings, ...signatureResult.warnings]

  if (!signatureResult.valid) {
    errors.push(signatureResult.error)
  }

  // Log security-relevant events
  if (!signatureResult.valid) {
    console.warn('[PluginValidator] SECURITY: Plugin signature verification failed:', plugin.id, signatureResult.error)
  } else if (signatureResult.unsigned) {
    console.warn('[PluginValidator] SECURITY: Unsigned plugin loaded:', plugin.id)
  } else {
    console.log('[PluginValidator] Plugin signature verified:', plugin.id, 'signed by:', signatureResult.signedBy)
  }

  return {
    valid: basicResult.valid && signatureResult.valid,
    errors,
    warnings,
    signatureValid: signatureResult.valid && !signatureResult.unsigned,
    signedBy: signatureResult.signedBy,
    signedAt: signatureResult.signedAt,
    unsigned: signatureResult.unsigned
  }
}

/**
 * Sandbox a plugin for safe execution
 * Creates a restricted execution environment
 * @param {object} plugin - Plugin to sandbox
 * @returns {object} - Sandboxed plugin with safe executor
 */
export function sandboxPlugin(plugin) {
  // Create a proxy that restricts access
  const createSafeProxy = (target, allowedKeys) => {
    return new Proxy(target, {
      get(obj, prop) {
        if (allowedKeys.includes(prop)) {
          return obj[prop]
        }
        console.warn(`[Sandbox] Blocked access to: ${String(prop)}`)
        return undefined
      },
      set() {
        console.warn('[Sandbox] Property assignment is not allowed')
        return false
      }
    })
  }

  // Safe globals
  const safeGlobals = {
    console: createSafeProxy(console, ['log', 'warn', 'error', 'info', 'debug']),
    Math: Math,
    Date: Date,
    JSON: JSON,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Promise: Promise,
    Map: Map,
    Set: Set,
    RegExp: RegExp,
    Error: Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30000)), // Max 30s
    clearTimeout,
    // No setInterval to prevent long-running loops
  }

  return {
    ...plugin,
    sandbox: safeGlobals,
    isSandboxed: true
  }
}

/**
 * Get validation summary for UI display
 * @param {{valid: boolean, errors: string[], warnings: string[]}} result
 * @returns {{status: string, message: string, details: string[]}}
 */
export function getValidationSummary(result) {
  if (result.valid && result.warnings.length === 0) {
    return {
      status: 'success',
      message: 'Plugin is valid and ready to install',
      details: []
    }
  }

  if (result.valid && result.warnings.length > 0) {
    return {
      status: 'warning',
      message: `Plugin is valid with ${result.warnings.length} warning(s)`,
      details: result.warnings
    }
  }

  return {
    status: 'error',
    message: `Plugin has ${result.errors.length} error(s)`,
    details: [...result.errors, ...result.warnings]
  }
}

export default {
  validatePluginManifest,
  validatePluginCode,
  validatePlugin,
  validatePluginWithSignature,
  sandboxPlugin,
  getValidationSummary,
  VALID_LAYER_POSITIONS,
  VALID_POSITION_MODES,
  REFERENCE_LAYERS
}
