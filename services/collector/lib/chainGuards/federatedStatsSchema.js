'use strict';

/**
 * AGH-CHAIN-5: Federated stats payload schema validator.
 *
 * Validates the outgoing stats payload before it is sent to the Quox aggregator.
 * This is a defensive schema check — it catches accidental future regressions
 * where someone adds a text/ID/envelope field to the payload.
 *
 * No external dependencies (no zod) — manual validation only.
 */

const ALLOWED_RESPONSE_CATEGORIES = new Set([
  'phantom_email_claims',
  'phantom_task_claims',
  'phantom_workflow_claims',
  'phantom_subagent_claims',
  'phantom_hitl_claims',
  'phantom_crystal_claims',
]);

const ALLOWED_CHAIN_CATEGORIES = new Set([
  'phantom_past_action',
  'phantom_cross_agent',
  'phantom_cross_org',
]);

const ALLOWED_TOP_LEVEL = new Set([
  'response_contract_fires',
  'chain_verification_fires',
  'total_fires',
  'window',
  'k_anon_applied',
  'schema_version',
]);

/**
 * validateFederatedStatsPayload(payload)
 * Returns { valid: true } | { valid: false, errors: string[] }
 */
function validateFederatedStatsPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload must be a non-array object'] };
  }

  // Reject any unknown top-level key (catches accidental text/ID/envelope leaks)
  for (const k of Object.keys(payload)) {
    if (!ALLOWED_TOP_LEVEL.has(k)) {
      errors.push(`disallowed top-level key: ${k}`);
    }
  }

  // schema_version must be the expected string
  if (payload.schema_version !== 'agh-chain-stats-v1') {
    errors.push(`schema_version must be 'agh-chain-stats-v1'`);
  }

  // window must be one of 24h/7d/30d
  if (!['24h', '7d', '30d'].includes(payload.window)) {
    errors.push(`window must be one of 24h/7d/30d`);
  }

  // total_fires must be a non-negative integer
  if (!Number.isInteger(payload.total_fires) || payload.total_fires < 0) {
    errors.push('total_fires must be a non-negative integer');
  }

  // k_anon_applied must be boolean
  if (typeof payload.k_anon_applied !== 'boolean') {
    errors.push('k_anon_applied must be boolean');
  }

  // response_contract_fires: each key in allowed set, each value non-negative integer
  if (payload.response_contract_fires && typeof payload.response_contract_fires === 'object') {
    for (const [k, v] of Object.entries(payload.response_contract_fires)) {
      if (!ALLOWED_RESPONSE_CATEGORIES.has(k)) {
        errors.push(`response_contract_fires.${k}: disallowed key`);
      }
      if (!Number.isInteger(v) || v < 0) {
        errors.push(`response_contract_fires.${k}: must be non-negative integer`);
      }
    }
  } else {
    errors.push('response_contract_fires must be an object');
  }

  // chain_verification_fires: same rule
  if (payload.chain_verification_fires && typeof payload.chain_verification_fires === 'object') {
    for (const [k, v] of Object.entries(payload.chain_verification_fires)) {
      if (!ALLOWED_CHAIN_CATEGORIES.has(k)) {
        errors.push(`chain_verification_fires.${k}: disallowed key`);
      }
      if (!Number.isInteger(v) || v < 0) {
        errors.push(`chain_verification_fires.${k}: must be non-negative integer`);
      }
    }
  } else {
    errors.push('chain_verification_fires must be an object');
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

module.exports = { validateFederatedStatsPayload };
