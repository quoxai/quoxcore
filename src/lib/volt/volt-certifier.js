/**
 * VOLT Certification Tiers — Phase 5.B
 *
 * Four-tier trust seal system for AI agent execution traces.
 * Extends volt-verifier.js with graduated compliance checks.
 *
 * Tiers:
 *   Bronze   — VOLT-Compatible: AEE envelopes present, valid schema
 *   Silver   — VOLT-Verified:   Hash chain intact, all events recorded, no gaps
 *   Gold     — VOLT-Attested:   External timestamp (RFC 3161), signed tips, 30-day retention
 *   Platinum — VOLT-Enterprise:  Third-party audit, SOC 2 evidence, compliance bundle
 *
 * Each tier includes all requirements of the tier below it.
 */

import { verifyChain, FAILURE_CODES } from './volt-verifier.js'
import { validateBundle, computeMerkleRoot, deserializeBundle } from './volt-bundler.js'
import { validateTimestamp } from './volt-timestamp.js'
import { prefixedUlid } from '../aee/ulid.js'

/**
 * Certification tier identifiers
 */
export const CERT_TIERS = {
  BRONZE: 'bronze',
  SILVER: 'silver',
  GOLD: 'gold',
  PLATINUM: 'platinum'
}

/**
 * Tier display metadata
 */
export const TIER_META = {
  [CERT_TIERS.BRONZE]: {
    name: 'VOLT-Compatible',
    label: 'Bronze',
    color: '#CD7F32',
    description: 'AEE envelopes present with valid schema',
    icon: '◆'
  },
  [CERT_TIERS.SILVER]: {
    name: 'VOLT-Verified',
    label: 'Silver',
    color: '#C0C0C0',
    description: 'Hash chain intact, all events recorded, no gaps',
    icon: '◆◆'
  },
  [CERT_TIERS.GOLD]: {
    name: 'VOLT-Attested',
    label: 'Gold',
    color: '#FFD700',
    description: 'External timestamp, signed bundle, 30-day retention',
    icon: '◆◆◆'
  },
  [CERT_TIERS.PLATINUM]: {
    name: 'VOLT-Enterprise',
    label: 'Platinum',
    color: '#E5E4E2',
    description: 'Third-party audit, SOC 2 evidence, compliance bundle',
    icon: '◆◆◆◆'
  }
}

/**
 * Tier ordering for comparison
 */
const TIER_ORDER = [CERT_TIERS.BRONZE, CERT_TIERS.SILVER, CERT_TIERS.GOLD, CERT_TIERS.PLATINUM]

/**
 * Default certification validity period (90 days)
 */
const DEFAULT_VALIDITY_DAYS = 90

/**
 * Certification check result codes
 */
export const CERT_CODES = {
  // Bronze checks
  NO_EVENTS: 'NO_EVENTS',
  MISSING_AEE_ENVELOPES: 'MISSING_AEE_ENVELOPES',
  INVALID_EVENT_SCHEMA: 'INVALID_EVENT_SCHEMA',
  MISSING_ACTOR: 'MISSING_ACTOR',
  MISSING_CONTEXT: 'MISSING_CONTEXT',
  MISSING_RUN_LIFECYCLE: 'MISSING_RUN_LIFECYCLE',

  // Silver checks
  CHAIN_INTEGRITY_FAILED: 'CHAIN_INTEGRITY_FAILED',
  SEQUENCE_GAPS: 'SEQUENCE_GAPS',
  MISSING_EVENT_TYPES: 'MISSING_EVENT_TYPES',
  MERKLE_ROOT_MISSING: 'MERKLE_ROOT_MISSING',
  MERKLE_ROOT_MISMATCH: 'MERKLE_ROOT_MISMATCH',
  BUNDLE_VALIDATION_FAILED: 'BUNDLE_VALIDATION_FAILED',

  // Gold checks
  NO_TIMESTAMP: 'NO_TIMESTAMP',
  TIMESTAMP_INVALID: 'TIMESTAMP_INVALID',
  NO_SIGNATURE: 'NO_SIGNATURE',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  RETENTION_TOO_SHORT: 'RETENTION_TOO_SHORT',

  // Platinum checks
  NO_THIRD_PARTY_AUDIT: 'NO_THIRD_PARTY_AUDIT',
  NO_COMPLIANCE_BUNDLE: 'NO_COMPLIANCE_BUNDLE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE'
}

/**
 * Required VOLT event fields per spec §6
 */
const REQUIRED_EVENT_FIELDS = [
  'volt_version', 'event_id', 'run_id', 'seq', 'ts',
  'event_type', 'actor', 'context', 'prev_hash', 'hash'
]

/**
 * Required actor fields per spec §6.1
 */
const REQUIRED_ACTOR_FIELDS = ['actor_type', 'actor_id']

/**
 * AEE-related event types that indicate envelope integration
 */
const AEE_EVENT_TYPES = [
  'aee.envelope.received', 'aee.envelope.sent',
  'aee.message.parsed', 'aee.message.rejected'
]

/**
 * Core event types that a complete run should contain
 */
const LIFECYCLE_EVENT_TYPES = ['run.started', 'run.completed']

/**
 * @typedef {Object} CertCheck
 * @property {string} code - Check identifier
 * @property {boolean} passed - Whether the check passed
 * @property {string} message - Human-readable result
 * @property {string} tier - Which tier this check belongs to
 */

/**
 * @typedef {Object} CertificationResult
 * @property {string} cert_id - Unique certification ID
 * @property {string} run_id - The run that was certified
 * @property {string|null} bundle_id - Bundle ID if applicable
 * @property {string} tier - Highest tier achieved
 * @property {string} tier_name - Display name for the tier
 * @property {Object} tiers - Per-tier pass/fail status
 * @property {CertCheck[]} checks - All checks performed
 * @property {string} certified_at - ISO timestamp
 * @property {string} expires_at - ISO timestamp
 * @property {Object} summary - Summary statistics
 */

/**
 * Certify a VOLT run against the four certification tiers.
 *
 * Accepts either:
 * - An array of events (for Bronze/Silver checks)
 * - A serialized bundle JSON string (for full Gold/Platinum checks)
 * - A bundle object (deserialized)
 *
 * @param {Object} input
 * @param {Object[]} [input.events] - Array of VOLT events
 * @param {string} [input.bundleJson] - Serialized bundle JSON
 * @param {Object} [input.bundle] - Deserialized bundle object
 * @param {Object} [input.retentionInfo] - { earliest_event_ts, retention_days }
 * @param {Object} [input.auditInfo] - { auditor, audit_date, audit_id, report_url }
 * @param {Object} [input.complianceInfo] - { frameworks: ['SOC2', 'ISO27001', ...], evidence_count }
 * @param {Object} [options]
 * @param {number} [options.validityDays=90] - Certificate validity period
 * @returns {Promise<CertificationResult>}
 */
export async function certifyRun(input, options = {}) {
  const validityDays = options.validityDays || DEFAULT_VALIDITY_DAYS
  const checks = []
  let events = input.events || []
  let bundle = input.bundle || null
  let manifest = null

  // If bundleJson provided, parse it
  if (input.bundleJson && !bundle) {
    try {
      const parsed = JSON.parse(input.bundleJson)
      bundle = deserializeBundle(parsed)
      manifest = parsed.manifest || bundle.manifest
    } catch (err) {
      checks.push({
        code: 'PARSE_ERROR',
        passed: false,
        message: `Failed to parse bundle JSON: ${err.message}`,
        tier: CERT_TIERS.SILVER
      })
    }
  }

  // Extract events from bundle if not provided directly
  if (bundle && events.length === 0 && bundle.eventsNDJSON) {
    try {
      events = bundle.eventsNDJSON
        .trim()
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l))
    } catch {
      // Events extraction failed — will be caught by Bronze checks
    }
  }

  if (bundle) {
    manifest = bundle.manifest
  }

  // Run all tier checks
  const bronzeChecks = checkBronze(events)
  const silverChecks = await checkSilver(events, bundle, manifest)
  const goldChecks = checkGold(bundle, manifest, input.retentionInfo)
  const platinumChecks = checkPlatinum(input.auditInfo, input.complianceInfo)

  checks.push(...bronzeChecks, ...silverChecks, ...goldChecks, ...platinumChecks)

  // Determine highest tier achieved
  const tiers = {
    [CERT_TIERS.BRONZE]: bronzeChecks.every(c => c.passed),
    [CERT_TIERS.SILVER]: bronzeChecks.every(c => c.passed) && silverChecks.every(c => c.passed),
    [CERT_TIERS.GOLD]: bronzeChecks.every(c => c.passed) && silverChecks.every(c => c.passed) && goldChecks.every(c => c.passed),
    [CERT_TIERS.PLATINUM]: bronzeChecks.every(c => c.passed) && silverChecks.every(c => c.passed) && goldChecks.every(c => c.passed) && platinumChecks.every(c => c.passed)
  }

  let highestTier = null
  for (const tier of TIER_ORDER) {
    if (tiers[tier]) highestTier = tier
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000)

  const run_id = events.length > 0 ? events[0].run_id : manifest?.run_id || null
  const bundle_id = manifest?.bundle_id || null

  return {
    cert_id: prefixedUlid('CERT'),
    run_id,
    bundle_id,
    tier: highestTier,
    tier_name: highestTier ? TIER_META[highestTier].name : 'None',
    tiers,
    checks,
    certified_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    summary: {
      total_checks: checks.length,
      passed: checks.filter(c => c.passed).length,
      failed: checks.filter(c => !c.passed).length,
      event_count: events.length,
      has_bundle: !!bundle,
      has_signatures: !!(bundle?.signatures?.length),
      has_timestamps: !!(manifest?.timestamps?.length)
    }
  }
}

/**
 * Bronze tier checks: VOLT-Compatible
 * - Events exist
 * - AEE envelope events present
 * - Valid event schema (required fields)
 * - Actor fields present
 * - Context fields present
 * - Run lifecycle events (started + completed)
 */
function checkBronze(events) {
  const checks = []

  // Check 1: Events exist
  if (events.length === 0) {
    checks.push({
      code: CERT_CODES.NO_EVENTS,
      passed: false,
      message: 'No events found — at least one event required',
      tier: CERT_TIERS.BRONZE
    })
    return checks
  }

  checks.push({
    code: CERT_CODES.NO_EVENTS,
    passed: true,
    message: `${events.length} events found`,
    tier: CERT_TIERS.BRONZE
  })

  // Check 2: AEE envelope events present (at least one)
  const aeeEvents = events.filter(e => AEE_EVENT_TYPES.includes(e.event_type))
  const hasAeeContext = events.some(e => e.context?.aee_envelope_id)
  const aeePresent = aeeEvents.length > 0 || hasAeeContext

  checks.push({
    code: CERT_CODES.MISSING_AEE_ENVELOPES,
    passed: aeePresent,
    message: aeePresent
      ? `AEE integration confirmed (${aeeEvents.length} AEE events, ${events.filter(e => e.context?.aee_envelope_id).length} with envelope IDs)`
      : 'No AEE envelope events or envelope IDs found — VOLT-Compatible requires AEE integration',
    tier: CERT_TIERS.BRONZE
  })

  // Check 3: Valid event schema
  let schemaErrors = 0
  const missingFields = new Set()
  for (const event of events) {
    for (const field of REQUIRED_EVENT_FIELDS) {
      if (event[field] === undefined || event[field] === null) {
        schemaErrors++
        missingFields.add(field)
      }
    }
  }

  checks.push({
    code: CERT_CODES.INVALID_EVENT_SCHEMA,
    passed: schemaErrors === 0,
    message: schemaErrors === 0
      ? `All ${events.length} events have valid schema`
      : `${schemaErrors} schema violations across events (missing: ${[...missingFields].join(', ')})`,
    tier: CERT_TIERS.BRONZE
  })

  // Check 4: Actor fields
  let actorErrors = 0
  for (const event of events) {
    if (!event.actor) {
      actorErrors++
      continue
    }
    for (const field of REQUIRED_ACTOR_FIELDS) {
      if (!event.actor[field]) actorErrors++
    }
  }

  checks.push({
    code: CERT_CODES.MISSING_ACTOR,
    passed: actorErrors === 0,
    message: actorErrors === 0
      ? 'All events have valid actor fields'
      : `${actorErrors} actor field violations`,
    tier: CERT_TIERS.BRONZE
  })

  // Check 5: Context fields
  const contextMissing = events.filter(e => !e.context).length
  checks.push({
    code: CERT_CODES.MISSING_CONTEXT,
    passed: contextMissing === 0,
    message: contextMissing === 0
      ? 'All events have context fields'
      : `${contextMissing} events missing context`,
    tier: CERT_TIERS.BRONZE
  })

  // Check 6: Run lifecycle
  const hasStarted = events.some(e => e.event_type === 'run.started')
  const hasCompleted = events.some(e => e.event_type === 'run.completed' || e.event_type === 'run.failed')
  const lifecycleOk = hasStarted && hasCompleted

  checks.push({
    code: CERT_CODES.MISSING_RUN_LIFECYCLE,
    passed: lifecycleOk,
    message: lifecycleOk
      ? 'Run lifecycle complete (started + completed/failed)'
      : `Missing lifecycle events: ${!hasStarted ? 'run.started' : ''} ${!hasCompleted ? 'run.completed/failed' : ''}`.trim(),
    tier: CERT_TIERS.BRONZE
  })

  return checks
}

/**
 * Silver tier checks: VOLT-Verified
 * - Hash chain integrity (every event, every link)
 * - Sequence numbers monotonic with no gaps
 * - Merkle root present and valid (if bundle)
 * - Bundle validation passes (if bundle)
 */
async function checkSilver(events, bundle, manifest) {
  const checks = []

  if (events.length === 0) {
    checks.push({
      code: CERT_CODES.CHAIN_INTEGRITY_FAILED,
      passed: false,
      message: 'Cannot verify chain — no events',
      tier: CERT_TIERS.SILVER
    })
    return checks
  }

  // Check 1: Hash chain integrity
  const chainResult = await verifyChain(events)

  checks.push({
    code: CERT_CODES.CHAIN_INTEGRITY_FAILED,
    passed: chainResult.chain_valid,
    message: chainResult.chain_valid
      ? `Hash chain intact (${chainResult.valid_count}/${chainResult.event_count} events verified)`
      : `Chain broken: ${chainResult.first_failure?.detail || chainResult.reason}`,
    tier: CERT_TIERS.SILVER
  })

  // Check 2: Sequence numbers
  checks.push({
    code: CERT_CODES.SEQUENCE_GAPS,
    passed: chainResult.sequence_valid,
    message: chainResult.sequence_valid
      ? `Sequence numbers monotonic (1 to ${events.length})`
      : 'Sequence gaps or non-monotonic sequence detected',
    tier: CERT_TIERS.SILVER
  })

  // Check 3: Genesis event valid
  checks.push({
    code: CERT_CODES.MISSING_EVENT_TYPES,
    passed: chainResult.genesis_valid,
    message: chainResult.genesis_valid
      ? 'Genesis event valid (seq=1, type=run.started, prev_hash=zeros)'
      : 'Genesis event invalid',
    tier: CERT_TIERS.SILVER
  })

  // Check 4: Merkle root (if bundle present)
  if (bundle && manifest) {
    if (!manifest.merkle_root) {
      checks.push({
        code: CERT_CODES.MERKLE_ROOT_MISSING,
        passed: false,
        message: 'Bundle manifest missing merkle_root',
        tier: CERT_TIERS.SILVER
      })
    } else {
      const eventHashes = events.map(e => e.hash)
      const computed = await computeMerkleRoot(eventHashes)
      const merkleMatch = computed === manifest.merkle_root

      checks.push({
        code: CERT_CODES.MERKLE_ROOT_MISMATCH,
        passed: merkleMatch,
        message: merkleMatch
          ? 'Merkle root verified'
          : `Merkle root mismatch: manifest=${manifest.merkle_root.slice(0, 16)}..., computed=${computed.slice(0, 16)}...`,
        tier: CERT_TIERS.SILVER
      })
    }

    // Check 5: Full bundle validation
    const bundleResult = await validateBundle(bundle)
    checks.push({
      code: CERT_CODES.BUNDLE_VALIDATION_FAILED,
      passed: bundleResult.valid,
      message: bundleResult.valid
        ? 'Bundle validation passed (event count, hash anchors, chain)'
        : `Bundle validation failed: ${bundleResult.errors.join('; ')}`,
      tier: CERT_TIERS.SILVER
    })
  }

  return checks
}

/**
 * Gold tier checks: VOLT-Attested
 * - RFC 3161 external timestamp present and structurally valid
 * - Ed25519/HMAC bundle signature present
 * - 30-day retention evidence
 */
function checkGold(bundle, manifest, retentionInfo) {
  const checks = []

  // Check 1: External timestamp
  const timestamps = manifest?.timestamps || []
  if (timestamps.length === 0) {
    checks.push({
      code: CERT_CODES.NO_TIMESTAMP,
      passed: false,
      message: 'No RFC 3161 external timestamp found — Gold requires TSA attestation',
      tier: CERT_TIERS.GOLD
    })
  } else {
    let allValid = true
    const tsErrors = []
    for (const ts of timestamps) {
      const result = validateTimestamp(ts)
      if (!result.valid) {
        allValid = false
        tsErrors.push(...result.errors)
      }
    }
    checks.push({
      code: CERT_CODES.TIMESTAMP_INVALID,
      passed: allValid,
      message: allValid
        ? `${timestamps.length} RFC 3161 timestamp(s) structurally valid`
        : `Timestamp validation failed: ${tsErrors.join('; ')}`,
      tier: CERT_TIERS.GOLD
    })
  }

  // Check 2: Bundle signature
  const signatures = bundle?.signatures || []
  if (signatures.length === 0) {
    checks.push({
      code: CERT_CODES.NO_SIGNATURE,
      passed: false,
      message: 'No bundle signature found — Gold requires signed attestation',
      tier: CERT_TIERS.GOLD
    })
  } else {
    // Structural check: each signature has required fields
    let allValid = true
    for (const sig of signatures) {
      if (!sig.signature || !sig.key_id || !sig.message || !sig.sig_type) {
        allValid = false
      }
    }
    checks.push({
      code: CERT_CODES.SIGNATURE_INVALID,
      passed: allValid,
      message: allValid
        ? `${signatures.length} signature(s) structurally valid (${signatures.map(s => s.sig_type).join(', ')})`
        : 'One or more signatures missing required fields',
      tier: CERT_TIERS.GOLD
    })
  }

  // Check 3: Retention evidence (30 days)
  if (retentionInfo) {
    const retentionOk = retentionInfo.retention_days >= 30
    checks.push({
      code: CERT_CODES.RETENTION_TOO_SHORT,
      passed: retentionOk,
      message: retentionOk
        ? `Retention policy: ${retentionInfo.retention_days} days (minimum 30)`
        : `Retention too short: ${retentionInfo.retention_days} days (minimum 30 required)`,
      tier: CERT_TIERS.GOLD
    })
  } else {
    // Infer from event timestamps if possible
    if (manifest?.started_at) {
      const startDate = new Date(manifest.started_at)
      const now = new Date()
      const daysSinceStart = Math.floor((now - startDate) / (24 * 60 * 60 * 1000))
      // If data is still available and older than 30 days, retention is proven
      const retentionProven = daysSinceStart >= 30
      checks.push({
        code: CERT_CODES.RETENTION_TOO_SHORT,
        passed: retentionProven,
        message: retentionProven
          ? `Data retained for ${daysSinceStart} days (minimum 30 satisfied)`
          : `Data is ${daysSinceStart} day(s) old — 30-day retention not yet proven (run must persist for 30 days)`,
        tier: CERT_TIERS.GOLD
      })
    } else {
      checks.push({
        code: CERT_CODES.RETENTION_TOO_SHORT,
        passed: false,
        message: 'No retention information available — provide retentionInfo or wait 30 days',
        tier: CERT_TIERS.GOLD
      })
    }
  }

  return checks
}

/**
 * Platinum tier checks: VOLT-Enterprise
 * - Third-party independent audit record
 * - Compliance evidence bundle (SOC 2, ISO 27001, etc.)
 * - Minimum evidence threshold
 */
function checkPlatinum(auditInfo, complianceInfo) {
  const checks = []

  // Check 1: Third-party audit
  if (auditInfo && auditInfo.auditor && auditInfo.audit_date) {
    checks.push({
      code: CERT_CODES.NO_THIRD_PARTY_AUDIT,
      passed: true,
      message: `Third-party audit by ${auditInfo.auditor} on ${auditInfo.audit_date}`,
      tier: CERT_TIERS.PLATINUM
    })
  } else {
    checks.push({
      code: CERT_CODES.NO_THIRD_PARTY_AUDIT,
      passed: false,
      message: 'No third-party audit record — Platinum requires independent verification',
      tier: CERT_TIERS.PLATINUM
    })
  }

  // Check 2: Compliance bundle
  if (complianceInfo && complianceInfo.frameworks && complianceInfo.frameworks.length > 0) {
    checks.push({
      code: CERT_CODES.NO_COMPLIANCE_BUNDLE,
      passed: true,
      message: `Compliance evidence for: ${complianceInfo.frameworks.join(', ')}`,
      tier: CERT_TIERS.PLATINUM
    })
  } else {
    checks.push({
      code: CERT_CODES.NO_COMPLIANCE_BUNDLE,
      passed: false,
      message: 'No compliance framework evidence — Platinum requires at least one (SOC 2, ISO 27001, HIPAA, GDPR, ISO 42001)',
      tier: CERT_TIERS.PLATINUM
    })
  }

  // Check 3: Minimum evidence count
  const evidenceCount = complianceInfo?.evidence_count || 0
  const minEvidence = 10
  checks.push({
    code: CERT_CODES.INSUFFICIENT_EVIDENCE,
    passed: evidenceCount >= minEvidence,
    message: evidenceCount >= minEvidence
      ? `${evidenceCount} evidence items attached (minimum ${minEvidence})`
      : `Only ${evidenceCount} evidence items — Platinum requires at least ${minEvidence}`,
    tier: CERT_TIERS.PLATINUM
  })

  return checks
}

/**
 * Compare two tiers. Returns -1, 0, or 1.
 */
export function compareTiers(a, b) {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  return TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b)
}

/**
 * Check if a certification has expired.
 */
export function isCertExpired(cert) {
  return new Date(cert.expires_at) < new Date()
}

/**
 * Get the next tier above the given tier (or null if already at max).
 */
export function nextTier(currentTier) {
  if (!currentTier) return CERT_TIERS.BRONZE
  const idx = TIER_ORDER.indexOf(currentTier)
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null
  return TIER_ORDER[idx + 1]
}

/**
 * Get failed checks for a specific tier from a certification result.
 */
export function getFailedChecksForTier(certResult, tier) {
  return certResult.checks.filter(c => c.tier === tier && !c.passed)
}

/**
 * Format a certification result as a human-readable report.
 */
export function formatCertReport(cert) {
  const lines = [
    'VOLT Certification Report',
    '========================',
    `Cert ID:    ${cert.cert_id}`,
    `Run ID:     ${cert.run_id || 'N/A'}`,
    `Bundle:     ${cert.bundle_id || 'N/A'}`,
    `Tier:       ${cert.tier ? `${TIER_META[cert.tier].label} — ${cert.tier_name}` : 'None (no tier achieved)'}`,
    `Certified:  ${cert.certified_at}`,
    `Expires:    ${cert.expires_at}`,
    '',
    `Checks: ${cert.summary.passed}/${cert.summary.total_checks} passed`,
    ''
  ]

  for (const tier of TIER_ORDER) {
    const tierChecks = cert.checks.filter(c => c.tier === tier)
    const allPassed = tierChecks.every(c => c.passed)
    lines.push(`${TIER_META[tier].icon} ${TIER_META[tier].label} (${TIER_META[tier].name}): ${allPassed ? 'PASS' : 'FAIL'}`)
    for (const check of tierChecks) {
      lines.push(`  ${check.passed ? '✓' : '✗'} ${check.message}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(`RESULT: ${cert.tier ? TIER_META[cert.tier].name : 'NOT CERTIFIED'}`)

  return lines.join('\n')
}
