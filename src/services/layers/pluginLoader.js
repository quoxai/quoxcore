/**
 * Plugin Loader - Load AOCL Plugins from Files
 *
 * Handles loading plugins from files and parsing plugin formats.
 * Includes cryptographic signature verification for plugin security.
 * Part of AOCL Developer Kit (Pro)
 */

import { validatePlugin, validatePluginWithSignature, getValidationSummary } from './pluginValidator'
import { registerLayerPlugin } from './pluginRegistry'
import { verifyPluginSignature, getSignatureConfig } from './pluginSignature'
import { AOCL_PLUGIN_JS_WARNING, isDynamicPluginExtension } from '../pluginTrustModel'

/**
 * Load a plugin from a File object
 * @param {File} file - File to load
 * @param {object} options - Loading options
 * @param {boolean} options.skipSignatureCheck - Skip signature verification (not recommended)
 * @returns {Promise<{success: boolean, plugin?: object, error?: string}>}
 */
export async function loadPluginFromFile(file, options = {}) {
  try {
    // Check file type
    const validTypes = ['application/json', 'text/javascript', 'application/javascript']
    const validExtensions = ['.json', '.js', '.mjs']

    const hasValidType = validTypes.includes(file.type)
    const hasValidExt = validExtensions.some(ext => file.name.endsWith(ext))

    if (!hasValidType && !hasValidExt) {
      return {
        success: false,
        error: 'Invalid file type. Supported: .json, .js'
      }
    }

    if (isDynamicPluginExtension(file.name) && options.allowDynamicJsPlugins !== true) {
      return {
        success: false,
        error: `${AOCL_PLUGIN_JS_WARNING} Re-run this install with explicit trusted-admin approval.`
      }
    }

    // Read file content
    const content = await readFileContent(file)

    // Parse based on extension
    let plugin
    if (file.name.endsWith('.json')) {
      plugin = parseJsonPlugin(content)
    } else {
      plugin = parseJsPlugin(content, file.name)
    }

    // Validate the plugin with signature verification (security fix #70)
    let validation
    if (options.skipSignatureCheck) {
      console.warn('[PluginLoader] SECURITY WARNING: Signature verification skipped for:', file.name)
      validation = validatePlugin(plugin)
    } else {
      validation = await validatePluginWithSignature(plugin)
    }

    if (!validation.valid) {
      // Log security event for failed signature verification
      if (validation.errors.some(e => e.includes('signature') || e.includes('signed'))) {
        console.error('[PluginLoader] SECURITY: Plugin rejected due to signature failure:', file.name)
      }
      return {
        success: false,
        error: `Validation failed: ${validation.errors.join(', ')}`,
        validation
      }
    }

    // Add signature metadata to plugin
    if (validation.signatureValid) {
      plugin._signatureVerified = true
      plugin._signedBy = validation.signedBy
      plugin._signedAt = validation.signedAt
    } else if (validation.unsigned) {
      plugin._signatureVerified = false
      plugin._unsigned = true
    }

    return {
      success: true,
      plugin,
      validation,
      signatureVerified: validation.signatureValid,
      signedBy: validation.signedBy
    }
  } catch (err) {
    console.error('[PluginLoader] Failed to load file:', err)
    return {
      success: false,
      error: err.message
    }
  }
}

/**
 * Load and install a plugin from a File
 * @param {File} file - File to load and install
 * @param {object} options - Installation options
 * @param {boolean} options.skipSignatureCheck - Skip signature verification (not recommended)
 * @returns {Promise<{success: boolean, pluginId?: string, error?: string}>}
 */
export async function loadAndInstallPlugin(file, options = {}) {
  const loadResult = await loadPluginFromFile(file, options)

  if (!loadResult.success) {
    return loadResult
  }

  // Log installation with signature status
  const sigConfig = getSignatureConfig()
  if (loadResult.signatureVerified) {
    console.log('[PluginLoader] Installing verified plugin:', loadResult.plugin.id, 'signed by:', loadResult.signedBy)
  } else if (sigConfig.requireSignatures) {
    console.warn('[PluginLoader] Installing unsigned plugin (signature enforcement may reject):', loadResult.plugin.id)
  }

  const registerResult = registerLayerPlugin(loadResult.plugin)

  if (registerResult.success) {
    // Emit security audit event
    window.dispatchEvent(new CustomEvent('quox-security-audit', {
      detail: {
        type: 'plugin-install',
        pluginId: loadResult.plugin.id,
        signatureVerified: loadResult.signatureVerified || false,
        signedBy: loadResult.signedBy || null,
        timestamp: new Date().toISOString()
      }
    }))
  }

  return {
    ...registerResult,
    signatureVerified: loadResult.signatureVerified,
    signedBy: loadResult.signedBy
  }
}

/**
 * Parse a JSON plugin file
 */
function parseJsonPlugin(content) {
  const data = JSON.parse(content)

  // Handle different JSON formats
  if (data.manifest && data.code) {
    // Format: { manifest: {...}, code: "..." }
    return {
      ...data.manifest,
      execute: data.code
    }
  }

  if (data.executeCode || data.execute) {
    // Format: Plugin object with embedded code
    return {
      ...data,
      execute: data.execute || data.executeCode
    }
  }

  throw new Error('Invalid JSON plugin format')
}

/**
 * Parse a JavaScript plugin file
 */
function parseJsPlugin(content, filename) {
  // Extract plugin definition from JS file
  // Expected formats:
  // 1. export default { ... }
  // 2. module.exports = { ... }
  // 3. const plugin = { ... }

  // Remove comments
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  // Try to find plugin object
  let pluginMatch = null

  // Check for export default
  const exportDefaultMatch = withoutComments.match(/export\s+default\s+({[\s\S]*?})(?:\s*;?\s*$)/m)
  if (exportDefaultMatch) {
    pluginMatch = exportDefaultMatch[1]
  }

  // Check for module.exports
  if (!pluginMatch) {
    const moduleExportsMatch = withoutComments.match(/module\.exports\s*=\s*({[\s\S]*?})(?:\s*;?\s*$)/m)
    if (moduleExportsMatch) {
      pluginMatch = moduleExportsMatch[1]
    }
  }

  // Check for const plugin =
  if (!pluginMatch) {
    const constMatch = withoutComments.match(/const\s+plugin\s*=\s*({[\s\S]*?})(?:\s*;?\s*$)/m)
    if (constMatch) {
      pluginMatch = constMatch[1]
    }
  }

  if (!pluginMatch) {
    throw new Error('Could not find plugin definition in JS file')
  }

  // SECURITY: Pre-screen the extracted object text for dangerous patterns
  // before passing to new Function(). The regex extraction above should only
  // capture object literals, but a crafted file could inject executable code.
  const dangerousPatterns = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bimport\s*\(/,
    /\brequire\s*\(/,
    /\bprocess\b/,
    /\b__proto__\b/,
    /\bconstructor\s*\[/,
    /\bdocument\.cookie\b/,
    /\blocalStorage\b/,
    /\bwindow\.open\b/,
    /\bglobalThis\b/,
    /\.\.\./,
    /\bnew\s+[A-Z][A-Za-z0-9_]*\s*\(/,
    /\b(?:get|set)\s+[A-Za-z_$][\w$]*\s*\(/,
    /\[[^\]]+\]\s*:/
  ]

  for (const pattern of dangerousPatterns) {
    if (pattern.test(pluginMatch)) {
      throw new Error(`Plugin definition contains potentially dangerous code: ${pattern.source}`)
    }
  }

  // Try to evaluate the object literal
  try {
    // Use Function to parse the object literal (no safer alternative in browser context)
    const fn = new Function(`return ${pluginMatch}`)
    const plugin = fn()

    // Validate that the result is a plain object (not a function, class, etc.)
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      throw new Error('Plugin definition must be a plain object')
    }

    assertSafePluginValue(plugin, 'plugin', true)

    // Extract execute function if it's a function
    if (typeof plugin.execute === 'function') {
      plugin.execute = plugin.execute.toString()
    }

    return plugin
  } catch (err) {
    throw new Error(`Failed to parse plugin object: ${err.message}`)
  }
}

function assertSafePluginValue(value, path, allowExecuteFunction = false) {
  if (value === null) return

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return
  }

  if (valueType === 'function') {
    if (allowExecuteFunction && path === 'plugin.execute') {
      return
    }
    throw new Error(`Plugin contains unsupported function value at ${path}`)
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafePluginValue(item, `${path}[${index}]`, false))
    return
  }

  if (valueType !== 'object') {
    throw new Error(`Plugin contains unsupported value at ${path}`)
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`Plugin contains non-plain object at ${path}`)
  }

  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) {
      throw new Error(`Plugin contains accessor property at ${path}.${key}`)
    }
    const allowFunctionHere = allowExecuteFunction && path === 'plugin' && key === 'execute'
    assertSafePluginValue(descriptor.value, `${path}.${key}`, allowFunctionHere)
  }
}

/**
 * Read file content as text
 */
function readFileContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.onerror = (e) => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

/**
 * Create a plugin template
 * @param {string} type - Template type ('basic', 'filter', 'validator', 'transformer')
 * @returns {object}
 */
export function createPluginTemplate(type = 'basic') {
  const templates = {
    basic: {
      id: 'my-custom-plugin',
      name: 'My Custom Plugin',
      version: '1.0.0',
      author: 'Your Name',
      description: 'A custom AOCL layer plugin',
      layer: {
        position: 'L4',
        positionMode: 'after',
        referenceLayer: 'L3'
      },
      configSchema: {
        enabled: { type: 'boolean', default: true },
        threshold: { type: 'number', default: 0.5, min: 0, max: 1 }
      },
      execute: `async (ctx) => {
  const { input, config, utils } = ctx;
  const { log } = utils;

  log('Processing input...');

  // Your custom logic here
  const result = {
    status: 'complete',
    processed: true,
    input: input
  };

  return result;
}`
    },

    filter: {
      id: 'content-filter',
      name: 'Content Filter',
      version: '1.0.0',
      author: 'Your Name',
      description: 'Filters content based on rules',
      layer: {
        position: 'L4',
        positionMode: 'after',
        referenceLayer: 'L3'
      },
      configSchema: {
        blockedWords: { type: 'array', default: [] },
        caseSensitive: { type: 'boolean', default: false }
      },
      execute: `async (ctx) => {
  const { input, config, utils } = ctx;
  const query = input.query || '';
  const blocked = config.blockedWords || [];
  const caseSensitive = config.caseSensitive;

  const checkText = caseSensitive ? query : query.toLowerCase();
  const checkBlocked = caseSensitive ? blocked : blocked.map(w => w.toLowerCase());

  const foundBlocked = checkBlocked.filter(word => checkText.includes(word));

  if (foundBlocked.length > 0) {
    return {
      status: 'reject',
      reason: 'Content contains blocked words',
      blockedWords: foundBlocked
    };
  }

  return {
    status: 'complete',
    filtered: true,
    checkedWords: blocked.length
  };
}`
    },

    validator: {
      id: 'response-validator',
      name: 'Response Validator',
      version: '1.0.0',
      author: 'Your Name',
      description: 'Validates response quality',
      layer: {
        position: 'L6',
        positionMode: 'before',
        referenceLayer: 'L8'
      },
      configSchema: {
        minLength: { type: 'number', default: 50 },
        maxLength: { type: 'number', default: 10000 },
        requiredKeywords: { type: 'array', default: [] }
      },
      execute: `async (ctx) => {
  const { input, config } = ctx;
  const response = input.response || '';
  const warnings = [];

  // Check length
  if (response.length < config.minLength) {
    warnings.push('Response is too short');
  }
  if (response.length > config.maxLength) {
    warnings.push('Response is too long');
  }

  // Check required keywords
  for (const keyword of config.requiredKeywords || []) {
    if (!response.toLowerCase().includes(keyword.toLowerCase())) {
      warnings.push(\`Missing required keyword: \${keyword}\`);
    }
  }

  return {
    status: warnings.length > 0 ? 'warning' : 'complete',
    valid: warnings.length === 0,
    warnings,
    length: response.length
  };
}`
    },

    transformer: {
      id: 'response-transformer',
      name: 'Response Transformer',
      version: '1.0.0',
      author: 'Your Name',
      description: 'Transforms response content',
      layer: {
        position: 'L6',
        positionMode: 'after',
        referenceLayer: 'L7'
      },
      configSchema: {
        uppercase: { type: 'boolean', default: false },
        addPrefix: { type: 'string', default: '' },
        addSuffix: { type: 'string', default: '' }
      },
      execute: `async (ctx) => {
  const { input, config } = ctx;
  let response = input.response || '';

  // Apply transformations
  if (config.uppercase) {
    response = response.toUpperCase();
  }
  if (config.addPrefix) {
    response = config.addPrefix + response;
  }
  if (config.addSuffix) {
    response = response + config.addSuffix;
  }

  return {
    status: 'complete',
    transformed: true,
    response,
    originalLength: input.response?.length || 0,
    newLength: response.length
  };
}`
    }
  }

  return templates[type] || templates.basic
}

/**
 * Generate plugin file content for download
 * @param {object} plugin - Plugin object
 * @param {string} format - 'json' or 'js'
 * @returns {string}
 */
export function generatePluginFile(plugin, format = 'json') {
  if (format === 'json') {
    return JSON.stringify({
      manifest: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        author: plugin.author,
        description: plugin.description,
        layer: plugin.layer,
        configSchema: plugin.configSchema
      },
      code: plugin.execute || plugin.executeCode
    }, null, 2)
  }

  // JavaScript format
  return `/**
 * ${plugin.name}
 * ${plugin.description}
 *
 * @version ${plugin.version}
 * @author ${plugin.author}
 */

export default {
  id: '${plugin.id}',
  name: '${plugin.name}',
  version: '${plugin.version}',
  author: '${plugin.author}',
  description: '${plugin.description}',
  layer: ${JSON.stringify(plugin.layer, null, 4)},
  configSchema: ${JSON.stringify(plugin.configSchema, null, 4)},
  execute: ${plugin.execute || plugin.executeCode}
}
`
}

/**
 * Download a plugin as a file
 * @param {object} plugin - Plugin object
 * @param {string} format - 'json' or 'js'
 */
export function downloadPlugin(plugin, format = 'json') {
  const content = generatePluginFile(plugin, format)
  const mimeType = format === 'json' ? 'application/json' : 'text/javascript'
  const extension = format === 'json' ? 'json' : 'js'
  const filename = `${plugin.id}.${extension}`

  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  URL.revokeObjectURL(url)
}

export default {
  loadPluginFromFile,
  loadAndInstallPlugin,
  createPluginTemplate,
  generatePluginFile,
  downloadPlugin
}

export const __testables = {
  parseJsPlugin,
  assertSafePluginValue,
}
