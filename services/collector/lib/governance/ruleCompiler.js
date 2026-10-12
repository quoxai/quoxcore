/**
 * OPGOV quox#582 phase 2 — deterministic natural-language rule compiler.
 *
 * Compiles a SMALL, documented grammar of plain-language rules into
 * quox-policy.v1 drafts (lib/governance/policyDsl.js). Deliberately not an
 * LLM: every rule below compiles the same way every time, the compiled
 * policy is inspectable, and anything outside the grammar returns
 * compileUnknown() instead of an approximation. An LLM-assisted producer can
 * be added later; its output would land in the SAME draft-review-arm flow,
 * never straight to enforcement.
 *
 * Grammar (case-insensitive; <pattern> is a tool/credential id, trailing *
 * glob allowed):
 *   1. agents must not (use|call|run) <pattern> [without approval]
 *   2. <agentId> must not (use|call|run) <pattern> [without approval]
 *   3. agents must not (touch|use) credential[s] <pattern> [without approval]
 *   4. <agentId> must not (touch|use) credential[s] <pattern> [without approval]
 *
 * "without approval" compiles to effect require_approval (the action is
 * allowed once a human approves); its absence compiles to deny.
 */

'use strict';

const { POLICY_SCHEMA, validatePolicy, compileUnknown } = require('./policyDsl.js');

const TOOL_RULE = /^(agents|[a-z0-9_.-]+) must not (?:use|call|run) ([a-z0-9_.*-]+)( without approval)?$/i;
const CRED_RULE = /^(agents|[a-z0-9_.-]+) must not (?:touch|use) credentials? ([a-z0-9_.*-]+)( without approval)?$/i;

function normalise(ruleText) {
  return String(ruleText || '').trim().replace(/\s+/g, ' ').replace(/[.]$/, '');
}

/**
 * @param {string} ruleText plain-language rule
 * @param {{id?: string}} opts optional stable id (tests); defaults to a time-based id
 * @returns {{ok: true, policy: object} | {ok: false, unknown: true, rule_text, reason}}
 */
function compileRule(ruleText, opts = {}) {
  const text = normalise(ruleText);
  if (!text) return compileUnknown(ruleText, 'empty rule');

  const toolMatch = text.match(TOOL_RULE);
  const credMatch = toolMatch ? null : text.match(CRED_RULE);
  const m = toolMatch || credMatch;
  if (!m) {
    return compileUnknown(text,
      'rule not in the deterministic grammar (see lib/governance/ruleCompiler.js); refusing to approximate');
  }

  const [, subjectRaw, pattern, withoutApproval] = m;
  const subject = subjectRaw.toLowerCase();
  const policy = {
    v: 1,
    schema: POLICY_SCHEMA,
    id: opts.id || `pol_${Date.now().toString(36)}_${Math.abs(hashCode(text)).toString(36)}`,
    rule_text: text,
    effect: withoutApproval ? 'require_approval' : 'deny',
    state: 'draft',
    ...(subject === 'agents' ? {} : { subjects: { agents: [subject] } }),
    ...(toolMatch
      ? { actions: { tools: [pattern.toLowerCase()] } }
      : { resources: { credentials: [pattern.toLowerCase()] } }),
  };

  const valid = validatePolicy(policy);
  if (!valid.ok) {
    // The grammar produced something the DSL refuses: that is a compiler
    // defect surfaced honestly, not a policy to store.
    return compileUnknown(text, `compiled draft failed DSL validation: ${valid.errors.map((e) => e.message).join('; ')}`);
  }
  return { ok: true, policy };
}

// Deterministic string hash for stable-ish ids without Date-only collisions.
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

module.exports = { compileRule, TOOL_RULE, CRED_RULE };
