/**
 * Signed-artifact schema family (COMMANDERQ P4) — schema + validation.
 *
 * ONE base artifact envelope that many TYPES ride on. Defined ONCE here so the
 * net-new work downstream (P5 Plan-as-Artifact, P7 routing verdicts, P8
 * commitment ledger, P9 consent, P10 telephony call summaries) shares a single
 * spine: same header, same provenance shape, same signing, same WARD witness.
 *
 * Validation is HAND-ROLLED (the collector has no ajv/zod — see
 * quoxchatEnvelopes.js's buildWidgetEnvelope for the house pattern: allow-list
 * membership + explicit checks). We return an errors[] rather than throwing so
 * callers can decide; artifactStore.createArtifact refuses to sign an invalid
 * artifact.
 *
 * Canonicalization is IMPORTED from bundleSigner.js so an artifact is
 * canonicalized byte-for-byte the same way VOLT bundle manifests are — the
 * signature and its verification agree on one canonical form.
 *
 * This module is PURE: no crypto key access, no storage, no ward/server
 * require. Signing/storage/witnessing live in artifactStore.js and take their
 * primitives by injection. Keeps the schema testable in isolation.
 */

'use strict';

const crypto = require('crypto');
const { canonicalize } = require('../bundleSigner.js');

const SCHEMA_VERSION = 1;

const ARTIFACT_TYPES = new Set([
  'plan',
  'routing_verdict',
  'commitment',
  'consent',
  'call_summary',
]);

// sha256 hex over a canonical string — content digest for signing/binding.
function sha256(str) {
  return crypto.createHash('sha256').update(String(str), 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Small typed-field helpers (hand-rolled — no schema lib in this service).
// ---------------------------------------------------------------------------
function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function isArr(v) { return Array.isArray(v); }
function isBool(v) { return typeof v === 'boolean'; }

function reqStr(body, field, errors) {
  if (!isStr(body[field])) errors.push(`body.${field} must be a non-empty string`);
}

// ---------------------------------------------------------------------------
// Per-type body validators. Each returns an array of error strings (empty = ok).
// Kept deliberately shallow: required fields + coarse types. The point of P4 is
// the shared spine, not exhaustive per-field constraint — consumers (P5+) add
// their own domain rules on top.
// ---------------------------------------------------------------------------
function validatePlanBody(body, errors) {
  reqStr(body, 'title', errors);
  reqStr(body, 'intent', errors);
  if (!isArr(body.steps) || body.steps.length === 0) {
    errors.push('body.steps must be a non-empty array');
  } else {
    body.steps.forEach((s, i) => {
      if (!isObj(s)) { errors.push(`body.steps[${i}] must be an object`); return; }
      if (!isStr(s.id)) errors.push(`body.steps[${i}].id must be a non-empty string`);
      if (!isStr(s.description)) errors.push(`body.steps[${i}].description must be a non-empty string`);
    });
  }
  if (body.deviation_policy !== undefined &&
      !['gated', 'notify', 'free'].includes(body.deviation_policy)) {
    errors.push("body.deviation_policy must be one of 'gated'|'notify'|'free'");
  }
}

function validateRoutingVerdictBody(body, errors) {
  reqStr(body, 'task_class', errors);
  reqStr(body, 'chosen_agent', errors);
  if (!isArr(body.candidates)) errors.push('body.candidates must be an array');
}

function validateCommitmentBody(body, errors) {
  reqStr(body, 'promise', errors);
  reqStr(body, 'owner', errors);
  if (!['open', 'fulfilled', 'escalated', 'cancelled'].includes(body.status)) {
    errors.push("body.status must be one of 'open'|'fulfilled'|'escalated'|'cancelled'");
  }
}

function validateConsentBody(body, errors) {
  reqStr(body, 'subject', errors);
  reqStr(body, 'scope', errors);
  reqStr(body, 'channel', errors);
  reqStr(body, 'granted_at', errors);
  reqStr(body, 'basis', errors);
}

function validateCallSummaryBody(body, errors) {
  reqStr(body, 'call_ref', errors);
  reqStr(body, 'started_at', errors);
  reqStr(body, 'summary', errors);
  if (body.participants !== undefined && !isArr(body.participants)) {
    errors.push('body.participants must be an array when present');
  }
}

const BODY_VALIDATORS = {
  plan: validatePlanBody,
  routing_verdict: validateRoutingVerdictBody,
  commitment: validateCommitmentBody,
  consent: validateConsentBody,
  call_summary: validateCallSummaryBody,
};

/**
 * Validate the base artifact shape + dispatch to the type body validator.
 * @param {object} artifact
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateArtifact(artifact) {
  const errors = [];
  if (!isObj(artifact)) return { valid: false, errors: ['artifact must be an object'] };

  if (!isStr(artifact.artifact_id)) errors.push('artifact_id must be a non-empty string');
  if (!ARTIFACT_TYPES.has(artifact.artifact_type)) {
    errors.push(`artifact_type must be one of ${[...ARTIFACT_TYPES].join('|')}`);
  }
  if (artifact.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!isStr(artifact.created_at)) errors.push('created_at must be an ISO timestamp string');
  if (!isStr(artifact.org_id)) errors.push('org_id must be a non-empty string');
  if (!isStr(artifact.created_by)) errors.push('created_by must be a non-empty string');
  if (!isObj(artifact.body)) errors.push('body must be an object');

  // provenance is the honesty spine — required, though its fields may be empty.
  if (!isObj(artifact.provenance)) {
    errors.push('provenance must be an object');
  } else {
    if (!isArr(artifact.provenance.tools_used)) errors.push('provenance.tools_used must be an array');
    if (!isArr(artifact.provenance.evidence_refs)) errors.push('provenance.evidence_refs must be an array');
  }

  // Dispatch to the type body validator only when the base is coherent enough.
  if (isObj(artifact.body) && ARTIFACT_TYPES.has(artifact.artifact_type)) {
    BODY_VALIDATORS[artifact.artifact_type](artifact.body, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The canonical signed MESSAGE for an artifact: identity header + content
 * hashes (never the raw body — keeps the signed message compact and binds the
 * signature to the full content via digests, the same way bundleSigner signs a
 * manifest of hashes rather than raw events).
 */
function artifactSignatureMessage(artifact) {
  return {
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.artifact_type,
    schema_version: artifact.schema_version,
    created_at: artifact.created_at,
    org_id: artifact.org_id,
    created_by: artifact.created_by,
    corr: artifact.corr || null,
    body_hash: sha256(canonicalize(artifact.body || {})),
    provenance_hash: sha256(canonicalize(artifact.provenance || {})),
  };
}

module.exports = {
  SCHEMA_VERSION,
  ARTIFACT_TYPES,
  validateArtifact,
  artifactSignatureMessage,
  canonicalize,
  sha256,
  // exported for focused tests
  BODY_VALIDATORS,
};
