/**
 * OPGOV quox#582 phase 1 — the governance compiler's compile TARGET.
 *
 * A tiny, deterministic policy DSL. A natural-language rule compiles (phase
 * 2) to this shape; the gate path (phase 3, blocked on IMPACT #491's
 * approval-binds-dispatch primitive) enforces it. This module is pure and
 * self-contained: validation, matching and multi-policy evaluation are
 * deterministic functions with no LLM, no I/O and no clock, so a human can
 * read a compiled policy and know exactly what it will do, and a test can
 * prove it.
 *
 * Honesty gate (from the issue, load-bearing):
 * - No free-form logic: only the fields and operators defined here exist.
 * - Matching is exact string or trailing-* glob, nothing cleverer.
 * - evaluatePolicies precedence is fixed: deny > require_approval > allow;
 *   nothing matched = no_policy (the caller's default posture applies).
 * - A rule that cannot be expressed in this shape is UNKNOWN, not
 *   approximated; compileUnknown() is the one honest way to say so.
 */

'use strict';

const POLICY_SCHEMA = 'quox-policy.v1';
const EFFECTS = ['deny', 'require_approval', 'allow'];
const SELECTOR_KEYS = {
  subjects: ['agents', 'sources'],
  actions: ['tools', 'intents'],
  resources: ['credentials', 'hosts', 'egress'],
};

/** Exact match, or trailing-* prefix glob ('github_*'). '*' matches all. */
function patternMatches(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

function listMatches(patterns, value) {
  // Absent selector list = unconstrained on that axis.
  if (patterns === undefined) return true;
  if (!Array.isArray(patterns) || !patterns.length) return false;
  if (value === undefined || value === null) return false;
  return patterns.some((p) => patternMatches(p, String(value)));
}

/**
 * Deterministic structural validation. Returns { ok, errors: [{path, message}] }.
 * Precise paths so phase 2's review UI can point at the offending field.
 */
function validatePolicy(policy) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { ok: false, errors: [{ path: '', message: 'policy must be an object' }] };
  }
  if (policy.v !== 1) err('v', 'v must be 1');
  if (policy.schema !== POLICY_SCHEMA) err('schema', `schema must be "${POLICY_SCHEMA}"`);
  if (!policy.id || typeof policy.id !== 'string') err('id', 'id is required (string)');
  if (!policy.rule_text || typeof policy.rule_text !== 'string') {
    err('rule_text', 'rule_text is required: the plain-language rule this policy compiled from');
  }
  if (!EFFECTS.includes(policy.effect)) err('effect', `effect must be one of ${EFFECTS.join(', ')}`);
  if (policy.state !== undefined && !['draft', 'armed'].includes(policy.state)) {
    err('state', 'state must be draft or armed');
  }

  for (const [section, keys] of Object.entries(SELECTOR_KEYS)) {
    const value = policy[section];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      err(section, `${section} must be an object of selector lists`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        err(`${section}.${key}`, `unknown selector; allowed: ${keys.join(', ')}`);
        continue;
      }
      const list = value[key];
      if (!Array.isArray(list) || !list.length || !list.every((s) => typeof s === 'string' && s.length)) {
        err(`${section}.${key}`, 'selector must be a non-empty array of non-empty strings');
      }
    }
  }

  const hasAnySelector = ['subjects', 'actions', 'resources'].some(
    (s) => policy[s] && Object.keys(policy[s]).length,
  );
  if (!hasAnySelector) {
    err('', 'policy constrains nothing (no subjects, actions or resources): refusing a rule that silently matches everything');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Does one policy match one action?
 * action: { agent_id, source, tool, intent, credential_id, host, egress }
 * Every PRESENT selector must match (AND across axes; OR within a list).
 */
function matchPolicy(policy, action) {
  const a = action || {};
  const s = policy.subjects || {};
  const act = policy.actions || {};
  const r = policy.resources || {};
  const checks = [
    listMatches(s.agents, a.agent_id),
    listMatches(s.sources, a.source),
    listMatches(act.tools, a.tool),
    listMatches(act.intents, a.intent),
    listMatches(r.credentials, a.credential_id),
    listMatches(r.hosts, a.host),
    listMatches(r.egress, a.egress),
  ];
  return checks.every(Boolean);
}

/**
 * Evaluate a set of policies against one action. Only ARMED policies decide
 * (a draft nobody approved must never gate a real action); precedence is
 * deny > require_approval > allow; no armed match = no_policy so the
 * caller's existing default posture applies unchanged.
 */
function evaluatePolicies(policies, action) {
  const armed = (policies || []).filter((p) => p && p.state === 'armed');
  const matched = armed.filter((p) => matchPolicy(p, action));
  for (const effect of EFFECTS) {
    const winners = matched.filter((p) => p.effect === effect);
    if (winners.length) {
      return { decision: effect, matched_policy_ids: matched.map((p) => p.id), deciding_policy_id: winners[0].id };
    }
  }
  return { decision: 'no_policy', matched_policy_ids: [], deciding_policy_id: null };
}

/**
 * The one honest way to say a rule does not fit this DSL. Phase 2's
 * NL-to-DSL step returns this instead of approximating; nothing downstream
 * may treat it as coverage.
 */
function compileUnknown(ruleText, reason) {
  return { ok: false, unknown: true, rule_text: String(ruleText || ''), reason: String(reason || 'rule not expressible in quox-policy.v1') };
}

module.exports = {
  POLICY_SCHEMA,
  EFFECTS,
  validatePolicy,
  matchPolicy,
  evaluatePolicies,
  compileUnknown,
  patternMatches,
};
