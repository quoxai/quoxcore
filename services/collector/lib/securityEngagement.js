'use strict';

/**
 * QUOX-SECURITY Phase 0: the Engagement/scope object and the policy gate
 * every future security capability call must pass before it may run.
 *
 * No agent capability exists yet (Phase 1's job). This module is pure
 * CRUD, validation, and a policy decision function, dependency-injected
 * (deps.db, and for verifyTarget deps.lookupDnsTxt/deps.fetchWellKnown) so
 * it is fully testable with an in-memory SQLite db and no live network
 * calls, see test/securityEngagement.test.js.
 *
 * Schema: migrations/security/000-baseline.sql (security_engagements,
 * security_targets). AOCL's risk/autonomy fields were found to be
 * decorative, not enforced, elsewhere in this codebase (TOOL-RETRIEVAL/
 * QUOX-SECURITY research, 2026-08-08), this module deliberately does NOT
 * repeat that mistake: risk_ceiling and requiresApproval are derived and
 * checked here for real, not just stored as metadata.
 */

const crypto = require('crypto');
const { generateUlid } = require('./imageStore.js');

// Ordered least- to most-dangerous. Index comparison is the risk-tier
// ordering used throughout checkEngagementPolicy.
const RISK_TIERS = ['passive', 'discovery', 'safe_active', 'intrusive', 'credential_sensitive', 'exploit_emulation'];
const ENVIRONMENT_TIERS = ['dev', 'staging', 'production'];
const TARGET_TYPES = ['domain', 'cidr', 'repo', 'cloud_account', 'url'];
const VERIFICATION_METHODS = ['dns_txt', 'well_known_file', 'quoxagent_install', 'signed_attestation'];
const ENGAGEMENT_STATUSES = ['draft', 'active', 'paused', 'closed'];

// Production defaults to the lowest tier that still does real work
// (discovery), and Phase 0 offers no elevation path at all, per the
// architecture decisions, production-target support with a full
// authorization ladder is explicitly Phase 4, not built here.
const PRODUCTION_MAX_RISK = 'discovery';

function riskIndex(tier) {
  return RISK_TIERS.indexOf(tier);
}

/**
 * Canonicalize a `url`-type target value into the exact string that both the
 * policy gate and the scanner will use verbatim. Normalizing here, once, at
 * addTarget time is deliberate: the gate matches security_targets.value by
 * exact string equality and the scanner runs `nuclei -u <value>` unchanged, so
 * a single canonical form is what keeps the two in sync. Do NOT normalize at
 * scan time, that would desync the exact-match gate.
 *
 * Rules: prepend http:// when no scheme is present, require a non-empty host,
 * allow only http/https, and drop a trailing-slash-only path so
 * http://host:port stays http://host:port (nuclei-friendly). Deterministic and
 * idempotent: canonicalizeUrlTarget(canonicalizeUrlTarget(x)) === canonicalizeUrlTarget(x).
 *
 * @param {string} value
 * @returns {string}
 */
function canonicalizeUrlTarget(value) {
  let raw = String(value == null ? '' : value).trim();
  if (!raw) throw new Error('url target value is required');
  if (!/:\/\//.test(raw)) raw = `http://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new Error(`url target value "${value}" is not a valid URL`);
  }
  if (!url.hostname) throw new Error(`url target value "${value}" has no host`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`url target scheme "${url.protocol}" is not allowed (only http and https)`);
  }

  let canonical = `${url.protocol}//${url.host}`;
  if (url.pathname && url.pathname !== '/') canonical += url.pathname;
  return canonical;
}

/**
 * The value to hand to a fleet-membership lookup, which matches a bare host or
 * IP exactly. For a `url` target the stored value is a full URL, so extract its
 * hostname; every other type stores a bare host/IP already.
 *
 * @param {{type:string, value:string}} target
 * @returns {string}
 */
function fleetLookupValue(target) {
  if (target && target.type === 'url') {
    return new URL(target.value).hostname;
  }
  return target ? target.value : undefined;
}

function requiresApprovalForRisk(capabilityRisk) {
  return riskIndex(capabilityRisk) >= riskIndex('intrusive');
}

// A gripe_repo is a GitHub "owner/name" pair. Validate loosely (a single
// slash, no whitespace, non-empty owner and name), rejecting obviously
// malformed input rather than trying to prove the repo actually exists (that
// only surfaces at file time as a 404). Throws on a bad shape.
function validateGripeRepoShape(repo) {
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())) {
    throw new Error(`gripe_repo must be an "owner/name" GitHub repo, got "${repo}"`);
  }
}

function parseEngagementRow(row) {
  if (!row) return null;
  return {
    ...row,
    exclusions: JSON.parse(row.exclusions_json || '[]'),
    authorization_record: row.authorization_record_json ? JSON.parse(row.authorization_record_json) : null,
  };
}

function parseTargetRow(row) {
  if (!row) return null;
  return { ...row };
}

/**
 * @param {object} input
 * @param {object} deps - { db }
 */
function createEngagement(input, deps) {
  const { db } = deps;
  const { org_id, name, environment_tier, exclusions, time_window, credentials_ref,
    evidence_retention_days, responsible_org_id, responsible_project, authorization_record, created_by,
    gripe_repo, gripe_connector_org_id } = input || {};
  let { risk_ceiling } = input || {};

  if (!org_id) throw new Error('org_id is required');
  if (!name) throw new Error('name is required');
  if (!ENVIRONMENT_TIERS.includes(environment_tier)) {
    throw new Error(`environment_tier must be one of ${ENVIRONMENT_TIERS.join(', ')}`);
  }

  if (environment_tier === 'production') {
    if (risk_ceiling === undefined || risk_ceiling === null) {
      risk_ceiling = PRODUCTION_MAX_RISK;
    } else if (riskIndex(risk_ceiling) > riskIndex(PRODUCTION_MAX_RISK)) {
      throw new Error(
        `environment_tier "production" caps risk_ceiling at "${PRODUCTION_MAX_RISK}" in Phase 0 ` +
        `(no elevation path yet, requested "${risk_ceiling}")`
      );
    }
  }
  if (!RISK_TIERS.includes(risk_ceiling)) {
    throw new Error(`risk_ceiling must be one of ${RISK_TIERS.join(', ')}`);
  }

  if (gripe_repo != null) validateGripeRepoShape(gripe_repo);

  const id = `ENG_${generateUlid()}`;
  db.prepare(`
    INSERT INTO security_engagements (
      id, org_id, name, status, environment_tier, risk_ceiling, exclusions_json,
      time_window_start, time_window_end, credentials_ref, evidence_retention_days,
      responsible_org_id, responsible_project, authorization_record_json, created_by,
      gripe_repo, gripe_connector_org_id
    ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, org_id, name, environment_tier, risk_ceiling, JSON.stringify(exclusions || []),
    time_window?.start || null, time_window?.end || null, credentials_ref || null,
    evidence_retention_days ?? null, responsible_org_id || null, responsible_project || null,
    authorization_record ? JSON.stringify(authorization_record) : null, created_by || null,
    gripe_repo || null, gripe_connector_org_id || null
  );

  return getEngagement(id, org_id, deps);
}

function getEngagement(id, orgId, deps) {
  const row = deps.db.prepare('SELECT * FROM security_engagements WHERE id = ? AND org_id = ?').get(id, orgId);
  return parseEngagementRow(row);
}

function listEngagements(orgId, deps) {
  const rows = deps.db.prepare('SELECT * FROM security_engagements WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
  return rows.map(parseEngagementRow);
}

/**
 * Sets (or clears) an engagement's per-engagement gripe target: which repo a
 * finding raised from this engagement files into (gripe_repo) and which org's
 * GitHub connector token files it (gripe_connector_org_id). Both are cleared
 * to null by passing null. Loads the engagement org-scoped first (throws if
 * missing or not authorized for this org), so a cross-org id can never touch
 * another org's engagement. Returns the updated engagement.
 *
 * @param {string} engagementId
 * @param {string} orgId
 * @param {{gripe_repo?:string|null, gripe_connector_org_id?:string|null}} input
 * @param {object} deps - { db }
 */
function setEngagementGripeTarget(engagementId, orgId, input, deps) {
  const { db } = deps;
  const engagement = getEngagement(engagementId, orgId, deps);
  if (!engagement) throw new Error(`Engagement "${engagementId}" not found or not authorized for org "${orgId}"`);

  const { gripe_repo, gripe_connector_org_id } = input || {};
  const repoValue = gripe_repo == null ? null : String(gripe_repo).trim() || null;
  const connectorValue = gripe_connector_org_id == null ? null : String(gripe_connector_org_id).trim() || null;
  if (repoValue != null) validateGripeRepoShape(repoValue);

  db.prepare(`
    UPDATE security_engagements
    SET gripe_repo = ?, gripe_connector_org_id = ?, updated_at = datetime('now')
    WHERE id = ? AND org_id = ?
  `).run(repoValue, connectorValue, engagementId, orgId);

  return getEngagement(engagementId, orgId, deps);
}

/**
 * @param {string} engagementId
 * @param {string} orgId
 * @param {{type:string, value:string, verification_method?:string}} input
 * @param {object} deps - { db }
 */
function addTarget(engagementId, orgId, input, deps) {
  const { db } = deps;
  const engagement = getEngagement(engagementId, orgId, deps);
  if (!engagement) throw new Error(`Engagement "${engagementId}" not found or not authorized for org "${orgId}"`);

  const { type, verification_method } = input || {};
  let { value } = input || {};
  if (!TARGET_TYPES.includes(type)) throw new Error(`type must be one of ${TARGET_TYPES.join(', ')}`);
  if (!value) throw new Error('value is required');
  if (verification_method && !VERIFICATION_METHODS.includes(verification_method)) {
    throw new Error(`verification_method must be one of ${VERIFICATION_METHODS.join(', ')}`);
  }

  // Canonicalize once, at add time, so the stored value is the exact string the
  // policy gate matches and the scanner passes to nuclei verbatim (see
  // canonicalizeUrlTarget's header for why normalization must not happen later).
  if (type === 'url') value = canonicalizeUrlTarget(value);

  const existing = db.prepare(
    'SELECT id FROM security_targets WHERE engagement_id = ? AND type = ? AND value = ?'
  ).get(engagementId, type, value);
  if (existing) throw new Error(`Target already exists for this engagement (duplicate ${type}:${value})`);

  const id = `TGT_${generateUlid()}`;
  const token = verification_method ? `sec_${crypto.randomBytes(16).toString('hex')}` : null;

  db.prepare(`
    INSERT INTO security_targets (
      id, engagement_id, org_id, type, value, verification_method, verification_token, verification_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified')
  `).run(id, engagementId, orgId, type, value, verification_method || null, token);

  return parseTargetRow(db.prepare('SELECT * FROM security_targets WHERE id = ?').get(id));
}

function getTarget(targetId, orgId, deps) {
  const row = deps.db.prepare('SELECT * FROM security_targets WHERE id = ? AND org_id = ?').get(targetId, orgId);
  return parseTargetRow(row);
}

/**
 * Runs the target's declared verification challenge and records the result.
 * Fails CLOSED, not open: a target whose verification_method needs a
 * network-lookup dependency that wasn't injected throws rather than
 * silently marking anything verified.
 *
 * @param {string} targetId
 * @param {string} orgId
 * @param {object} deps - { db, lookupDnsTxt?, fetchWellKnown?, checkFleetMembership? }
 */
async function verifyTarget(targetId, orgId, deps) {
  const { db } = deps;
  const target = getTarget(targetId, orgId, deps);
  if (!target) throw new Error(`Target "${targetId}" not found or not authorized for org "${orgId}"`);
  if (!target.verification_method) throw new Error(`Target "${targetId}" has no verification_method set`);

  let verified = false;
  let ref = null;

  if (target.verification_method === 'dns_txt') {
    if (typeof deps.lookupDnsTxt !== 'function') {
      throw new Error('lookupDnsTxt dependency is required to verify a dns_txt target');
    }
    // #1007: a url target's TXT record lives on its hostname, not on the whole URL
    const records = await deps.lookupDnsTxt(fleetLookupValue(target));
    const expected = `quox-verify=${target.verification_token}`;
    const match = (records || []).find((r) => r === expected);
    verified = !!match;
    ref = match || null;
  } else if (target.verification_method === 'well_known_file') {
    if (typeof deps.fetchWellKnown !== 'function') {
      throw new Error('fetchWellKnown dependency is required to verify a well_known_file target');
    }
    // #1007: a url target is challenged at its own origin (scheme, host, port), never the whole URL
    const body = await deps.fetchWellKnown(target.type === 'url' ? new URL(target.value).origin : target.value);
    verified = body === target.verification_token;
    ref = verified ? body : null;
  } else if (target.verification_method === 'quoxagent_install') {
    // Proof of control for private/internal targets that the dns_txt and
    // well_known_file challenges can never reach (the SSRF guard correctly
    // blocks private-LAN fetches, and that guard is not to be weakened for
    // this). Instead: the target is already a known, governed member of the
    // real fleet (QuoxBastion/quoxagent), which is itself proof of control,
    // no new install or config change on the target is performed here.
    if (typeof deps.checkFleetMembership !== 'function') {
      throw new Error('checkFleetMembership dependency is required to verify a quoxagent_install target');
    }
    // A url-type target stores a full URL; the fleet lookup matches a bare
    // host/IP exactly, so hand it the hostname, never the whole URL.
    const membership = await deps.checkFleetMembership(fleetLookupValue(target));
    verified = !!(membership && membership.member);
    ref = verified ? `fleet:${membership.hostId || target.value}` : null;
  } else {
    // signed_attestation: honest-absent, not built in Phase 0 (signed-document
    // review is a real product surface, not a stub to fake here).
    throw new Error(`verification_method "${target.verification_method}" is not implemented in Phase 0`);
  }

  const status = verified ? 'verified' : 'failed';
  const verifiedAt = verified ? new Date().toISOString() : null;
  db.prepare(`
    UPDATE security_targets
    SET verification_status = ?, verified_at = ?, verification_ref = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, verifiedAt, ref, targetId);

  return getTarget(targetId, orgId, deps);
}

/**
 * The hard gate. Every future capability-provider execution call must pass
 * this before running. Never grants access on its own, a caller integrates
 * the result with withApprovalGate (see approvalGate.js) for anything where
 * requiresApproval is true.
 *
 * @param {{engagementId:string, orgId:string, targetValue:string, capabilityRisk:string}} args
 * @param {object} deps - { db, now? }
 * @returns {{allowed:boolean, reason?:string, requiresApproval:boolean}}
 */
function checkEngagementPolicy({ engagementId, orgId, targetValue, capabilityRisk }, deps) {
  if (!RISK_TIERS.includes(capabilityRisk)) {
    throw new Error(`capabilityRisk must be one of ${RISK_TIERS.join(', ')}`);
  }
  const requiresApproval = requiresApprovalForRisk(capabilityRisk);

  const engagement = getEngagement(engagementId, orgId, deps);
  if (!engagement) {
    return { allowed: false, reason: `Engagement "${engagementId}" not found or not authorized for org "${orgId}"`, requiresApproval };
  }

  const target = deps.db.prepare(
    'SELECT * FROM security_targets WHERE engagement_id = ? AND org_id = ? AND value = ?'
  ).get(engagementId, orgId, targetValue);
  if (!target) {
    return { allowed: false, reason: `Target "${targetValue}" is not part of this engagement's scope (add it first)`, requiresApproval };
  }
  if (target.verification_status !== 'verified') {
    return { allowed: false, reason: `Target "${targetValue}" is not verified for this engagement (status: ${target.verification_status})`, requiresApproval };
  }
  if (riskIndex(capabilityRisk) > riskIndex(engagement.risk_ceiling)) {
    return { allowed: false, reason: `Requested capability risk "${capabilityRisk}" exceeds this engagement's risk_ceiling "${engagement.risk_ceiling}"`, requiresApproval };
  }

  const now = deps.now || new Date();
  if (engagement.time_window_start && now < new Date(engagement.time_window_start)) {
    return { allowed: false, reason: `Current time is before this engagement's time_window (starts ${engagement.time_window_start})`, requiresApproval };
  }
  if (engagement.time_window_end && now > new Date(engagement.time_window_end)) {
    return { allowed: false, reason: `Current time is after this engagement's time_window (ended ${engagement.time_window_end})`, requiresApproval };
  }

  return { allowed: true, requiresApproval };
}

module.exports = {
  RISK_TIERS,
  ENVIRONMENT_TIERS,
  TARGET_TYPES,
  VERIFICATION_METHODS,
  ENGAGEMENT_STATUSES,
  createEngagement,
  getEngagement,
  listEngagements,
  setEngagementGripeTarget,
  addTarget,
  getTarget,
  verifyTarget,
  checkEngagementPolicy,
  canonicalizeUrlTarget,
  fleetLookupValue,
};
