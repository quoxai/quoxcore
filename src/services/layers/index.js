/**
 * Layer Services Index
 *
 * Exports AOCL layer plugin management services.
 * Part of AOCL Developer Kit (Pro)
 */

// Plugin Registry
export {
  initializeRegistry,
  registerLayerPlugin,
  unregisterLayerPlugin,
  enablePlugin,
  disablePlugin,
  updatePlugin,
  getRegisteredPlugins,
  getPlugin,
  getActivePlugins,
  isPluginActive,
  executePluginLayer,
  getPluginsForPosition,
  getPluginExecutionOrder,
  exportPlugins,
  importPlugins
} from './pluginRegistry'

// Plugin Validator
export {
  validatePluginManifest,
  validatePluginCode,
  validatePlugin,
  validatePluginWithSignature,
  sandboxPlugin,
  getValidationSummary,
  VALID_LAYER_POSITIONS,
  VALID_POSITION_MODES,
  REFERENCE_LAYERS
} from './pluginValidator'

// Plugin Loader
export {
  loadPluginFromFile,
  loadAndInstallPlugin,
  createPluginTemplate,
  generatePluginFile,
  downloadPlugin
} from './pluginLoader'

// Plugin Signature Verification (Security Fix #70)
export {
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
} from './pluginSignature'

// Policy Gate (L3)
export {
  checkPolicy,
  getRateLimitStatus,
  resetRateLimits
} from './policyGate'

// Response Verifier (L8)
export {
  verifyResponse,
  validateChunk
} from './responseVerifier'

// AOCL Enforcer (L1 + L3 + L8 coordination)
export {
  enforceL1Identity,
  enforceL3Policy,
  enforceL8Response,
  getEnforcementConfig
} from './aoclEnforcer'
