/**
 * VOLT — Verifiable Operations Ledger & Trace
 *
 * The third protocol pillar of Quox:
 *   AEE (transport) → AOCL (governance) → VOLT (proof)
 *
 * VOLT records hash-chained trace events for every agent action,
 * enabling tamper-evident audit trails and Evidence Bundles.
 *
 * @module volt
 */

export {
  startRun,
  recordEvent,
  completeRun,
  getRunSnapshot,
  exportRunAsNDJSON,
  getActiveRuns,
  getAllRunIds,
  pruneRun,
  _resetAllRuns,
  _onEvent,
  _onRunChange,
  VOLT_VERSION,
  GENESIS_HASH,
  HASH_ALG
} from './volt-recorder.js'

export {
  verifyChain,
  verifyNDJSON,
  formatReport,
  FAILURE_CODES
} from './volt-verifier.js'

export {
  canonicalize,
  sha256
} from './volt-canonical.js'

export {
  default as voltBridge,
  onEnvelopeStored,
  onToolCall,
  onModelResponse,
  onCredentialAccessed,
  getRunForCorrelation,
  getActiveCorrelations,
  getBridgeStats
} from './volt-bridge.js'

export {
  createBundle,
  validateBundle,
  computeMerkleRoot,
  serializeBundle,
  deserializeBundle
} from './volt-bundler.js'

export {
  redactEvents,
  omitFields,
  verifyRedactionCommitment,
  REDACTED
} from './volt-redactor.js'

export {
  generateSigningKey,
  signBundle,
  verifySignature
} from './volt-signer.js'

export {
  initVoltStore,
  closeVoltDB,
  persistEvent,
  persistRun,
  persistBundle,
  loadRuns,
  loadRunEvents,
  loadBundleByRunId,
  queryRuns,
  getStoreStats
} from './volt-store.js'

export {
  verifyEvidenceBundle,
  VERIFY_CODES
} from './volt-verify.js'

export {
  buildTimestampRequest,
  requestTimestamp,
  timestampBundle,
  validateTimestamp
} from './volt-timestamp.js'

export {
  certifyRun,
  CERT_TIERS,
  TIER_META,
  CERT_CODES,
  compareTiers,
  isCertExpired,
  nextTier,
  getFailedChecksForTier,
  formatCertReport
} from './volt-certifier.js'

export {
  generateBadgeSVG,
  generateBadgeInlineSVG,
  svgToDataUri
} from './volt-badge.js'
