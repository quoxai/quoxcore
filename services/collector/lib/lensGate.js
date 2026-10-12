/**
 * lensGate — QUOXLENS P7
 *
 * lensContract (P1) enforces what one Lens is allowed to claim. lensPanel
 * (P5) runs several Lenses over one artifact and refuses to blend their
 * disagreement into a false average. lensFindings (P3) tracks a finding's
 * lifecycle across sweeps. Every one of those modules produces information —
 * a verdict, a disposition, a state. None of them DECIDE anything; nothing
 * upstream of this file stops a release, blocks a merge, or holds a deploy.
 * This module is the last engine phase before QuoxLens can be a control
 * instead of an advisor: it turns a set of Lens results plus a declared
 * policy into exactly one of three outcomes — allow, block, review — and it
 * can always explain, in prose, why.
 *
 * Two rules make this file worth trusting more than skipping:
 *
 *   1. FAIL CLOSED ON ABSENCE. If a policy names a Lens as mandatory for a
 *      boundary and that Lens did not run, errored, or was skipped, the
 *      decision is "block" or "review" — never "allow". A gate that quietly
 *      allows when its own check never happened is worse than no gate at
 *      all, because it manufactures the appearance of a check that was
 *      never performed. See evaluateGate() and its first test in
 *      test/lensGate.test.js, which is deliberately the loudest test in the
 *      file.
 *
 *   2. AN UNPROVEN LENS DOES NOT SILENTLY BLOCK. Our own flagship Lens
 *      (honesty-and-claims) is `unproven` today — eval/lenses/unprovenGate.mjs
 *      has not shown it beats baseline on the current version — and it is
 *      not alone; any Lens without a positive measured lift on its current
 *      version carries the same flag. Letting an unproven Lens block a
 *      release by default is the exact governance theatre this whole
 *      product refuses to ship: a check nobody has shown works, gating
 *      something real. An unproven Lens can still raise a finding worth a
 *      human's attention — decision "review" — but it can only reach
 *      "block" when a policy opts in explicitly via `allow_unproven_block`.
 *
 * Deliberately dependency-free, same reason as lensContract/lensPanel/
 * lensFindings: no external policy-engine or JSON Schema library in the
 * collector's package.json, and this module only needs Node's built-in
 * crypto for policyFingerprint.
 *
 * NOT WIRED TO ANYTHING YET. This is a library. No route calls it, no
 * boundary (CI, deploy, plugin activation) consults it. See
 * docs/QUOXLENS_GATE.md for what a real caller still has to assemble.
 */

'use strict';

const crypto = require('crypto');

// Same ordering as docs/LENS_CONTRACT.md's finding.severity enum. Exported
// so a caller can compare severities the same way this module does, instead
// of re-deriving an ordering that has to match this one exactly.
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const SEVERITIES = Object.keys(SEVERITY_RANK);

// A Lens result's status, one entry per Lens a boundary asked to run. 'ok'
// is the only status that ever contributes findings to a decision; 'error'
// and 'skipped' are both treated as "did not run" by the fail-closed rule,
// deliberately not distinguished further — a caller who needs to know WHY a
// Lens did not run keeps that detail in `entry.error`/`entry.reason` for its
// own logging, but the gate's decision does not vary by which kind of
// absence it was.
const DID_NOT_RUN_STATUSES = ['error', 'skipped'];

// Valid values for policy.on_missing — the decision to use when a mandatory
// Lens did not run. 'allow' is deliberately NOT in this list: a policy
// author cannot configure their way around the fail-closed rule, only
// choose how strict the fallback is between 'block' and 'review'.
const VALID_ON_MISSING = ['block', 'review'];

// Default max tolerated severity when a policy does not declare one. Blocks
// on medium and above, tolerates low/info as noise a gate should not stop a
// release over. A policy that wants a stricter or looser ceiling declares
// max_severity explicitly; this default exists so a minimally-specified
// policy still fails closed toward "some things block" rather than "nothing
// ever blocks".
const DEFAULT_MAX_SEVERITY = 'medium';

/**
 * Resolve a policy's `on_missing` to one of VALID_ON_MISSING, defaulting to
 * the strictest option and refusing to honour an attempt to set it to
 * 'allow' (or anything else not on the list). This is the single place the
 * fail-closed-on-absence rule is actually enforced structurally — every
 * other branch in evaluateGate just calls this and trusts the result.
 *
 * @param {object|null|undefined} policy
 * @returns {{ value: 'block'|'review', overridden: boolean, requested: any }}
 */
function resolveOnMissing(policy) {
  const requested = policy && policy.on_missing;
  if (VALID_ON_MISSING.includes(requested)) {
    return { value: requested, overridden: false, requested };
  }
  return { value: 'block', overridden: requested !== undefined, requested };
}

/**
 * Resolve a policy's `max_severity` to a known severity, defaulting when
 * absent or unrecognised. An unrecognised value is treated the same as
 * absent (fall back to the default) rather than throwing — a gate library
 * should not crash a boundary over a typo in a policy file; it should still
 * enforce SOME ceiling rather than none.
 *
 * @param {object|null|undefined} policy
 * @returns {string}
 */
function resolveMaxSeverity(policy) {
  const requested = policy && policy.max_severity;
  return SEVERITIES.includes(requested) ? requested : DEFAULT_MAX_SEVERITY;
}

/**
 * Find the result entry for a lens id in a gate verdict's results array, or
 * null if that lens id has no entry at all. A lens with no entry is
 * indistinguishable from one whose entry says status 'skipped' — both mean
 * "this boundary has no evidence this Lens ran" — which is exactly how
 * evaluateGate treats them.
 *
 * @param {Array<object>} results
 * @param {string} lensId
 * @returns {object|null}
 */
function findResult(results, lensId) {
  return (Array.isArray(results) ? results : []).find((entry) => entry && entry.lens_id === lensId) || null;
}

/**
 * True when a mandatory lens's result counts as "did not run" for the
 * fail-closed rule: missing entirely, explicitly errored, explicitly
 * skipped, or present with a status this module does not recognise as 'ok'.
 * The last case matters as much as the first two — a typo'd status string
 * must fail closed exactly like a missing entry, not be silently treated as
 * having run.
 *
 * @param {object|null} entry
 * @returns {boolean}
 */
function didNotRun(entry) {
  if (!entry) return true;
  if (entry.status === 'ok') return false;
  // Covers the two named DID_NOT_RUN_STATUSES ('error', 'skipped') AND any
  // unrecognised status string, on purpose — see the module-level comment
  // on DID_NOT_RUN_STATUSES.
  return true;
}

/**
 * evaluateGate — the decision function. Turns a set of Lens results
 * (`verdict.results`, one entry per Lens the boundary asked to run) plus a
 * policy into { decision, reasons, blocking_findings }.
 *
 * `verdict` shape:
 *   { results: [
 *       { lens_id, status: 'ok'|'error'|'skipped',
 *         verdict?: { summary, disposition, confidence },
 *         findings?: Array<finding>,               // required when status 'ok'
 *         applied?: { version, unproven, ... },     // required when status 'ok'
 *         error?: string },                          // present when status 'error'
 *       ...
 *   ] }
 *
 * `policy` shape:
 *   { id?: string,
 *     mandatory_lens_ids: string[],   // Lenses this boundary REQUIRES to have run
 *     max_severity?: string,          // ceiling; a finding strictly above this can block (default 'medium')
 *     allow_unproven_block?: boolean, // opt-in: let an unproven mandatory Lens's findings reach 'block' (default false)
 *     on_missing?: 'block'|'review' } // decision when a mandatory Lens did not run (default 'block'; 'allow' is rejected)
 *
 * Severity is evaluated across every Lens that actually ran (status 'ok'),
 * not only the mandatory ones — a Lens a caller chose to run in addition to
 * the mandatory set still contributes findings to the block/review decision
 * if it finds something over the ceiling. "Mandatory" governs whether a
 * Lens's ABSENCE fails the gate closed; it does not limit which Lenses'
 * findings are allowed to matter once they did run.
 *
 * @param {{results: Array<object>}|null|undefined} verdict
 * @param {object|null|undefined} policy
 * @returns {{decision: 'allow'|'block'|'review', reasons: string[], blocking_findings: Array<object>, missing_lenses: string[], policy_id: string|null, policy_fingerprint: string}}
 */
const KNOWN_POLICY_FIELDS = new Set([
  'id', 'mandatory_lens_ids', 'max_severity', 'on_missing',
  'allow_unproven_block', 'applies_to',
]);

/**
 * Reject a policy carrying a field we do not recognise, rather than ignoring it.
 *
 * Found by writing `mandatory_lenses` instead of `mandatory_lens_ids` by hand: the gate
 * silently saw zero mandatory Lenses, allowed everything, and cheerfully reported that
 * "Every mandatory Lens ran". For an advisory tool a typo is an inconvenience; for a
 * control it is a silent bypass that looks exactly like a pass. A misconfigured gate must
 * refuse to answer, never answer permissively.
 */
function assertKnownPolicyFields(policy) {
  if (!policy || typeof policy !== 'object') return;
  const unknown = Object.keys(policy).filter((k) => !KNOWN_POLICY_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(
      `lensGate: unrecognised policy field(s): ${unknown.join(', ')}. `
      + `Known fields: ${[...KNOWN_POLICY_FIELDS].join(', ')}. `
      + 'Refusing to evaluate, because an ignored field silently weakens the gate.'
    );
  }
}

function evaluateGate(verdict, policy) {
  assertKnownPolicyFields(policy);
  const results = (verdict && Array.isArray(verdict.results)) ? verdict.results : [];
  const mandatoryLensIds = (policy && Array.isArray(policy.mandatory_lens_ids)) ? policy.mandatory_lens_ids : [];
  const maxSeverity = resolveMaxSeverity(policy);
  const ceilingRank = SEVERITY_RANK[maxSeverity];
  const allowUnprovenBlock = !!(policy && policy.allow_unproven_block === true);
  const onMissing = resolveOnMissing(policy);
  const policyFp = policyFingerprint(policy);
  const policyId = (policy && policy.id) || null;

  // ── Rule 1: fail closed on absence. Checked FIRST and unconditionally —
  // nothing about how clean every OTHER Lens's findings look can buy back a
  // mandatory Lens that never ran. This is deliberately not folded into the
  // severity loop below: absence is not "zero findings", it is "no evidence
  // this check happened at all", and those two things must never look the
  // same to a caller reading `decision`.
  const missingLenses = mandatoryLensIds.filter((lensId) => didNotRun(findResult(results, lensId)));

  if (missingLenses.length > 0) {
    const reasons = missingLenses.map((lensId) => {
      const entry = findResult(results, lensId);
      const why = !entry ? 'did not run (no result recorded)' : entry.status === 'error' ? `errored: ${entry.error || 'no error detail supplied'}` : `was skipped (status: ${entry.status})`;
      return `Mandatory lens "${lensId}" ${why}. A mandatory check that did not happen cannot be treated as passed.`;
    });
    if (onMissing.overridden) {
      reasons.push(
        `Policy requested on_missing="${String(onMissing.requested)}", which is not a valid fallback for a missing mandatory Lens; forced to "${onMissing.value}" instead. Absence never resolves to "allow".`
      );
    }
    return {
      decision: onMissing.value,
      reasons,
      blocking_findings: [],
      missing_lenses: missingLenses,
      policy_id: policyId,
      policy_fingerprint: policyFp,
    };
  }

  // ── Rule 2: severity ceiling, split by whether the Lens that raised the
  // finding is proven. hardBlockers can reach 'block' unconditionally;
  // reviewOnlyBlockers can only reach 'block' if the policy explicitly
  // opted in via allow_unproven_block, and otherwise cap out at 'review'.
  const hardBlockers = [];
  const reviewOnlyBlockers = [];

  for (const entry of results) {
    if (!entry || entry.status !== 'ok') continue;
    const findings = Array.isArray(entry.findings) ? entry.findings : [];
    const unproven = !!(entry.applied && entry.applied.unproven === true);
    const lensVersion = (entry.applied && entry.applied.version) || null;

    for (const finding of findings) {
      const rank = SEVERITY_RANK[finding && finding.severity];
      // An unrecognised severity is not silently ignored as "fine" — that
      // would let a malformed finding slip past a gate that exists
      // specifically to catch things. It is treated as if it exceeded the
      // ceiling, the same fail-closed direction as everything else in this
      // file: uncertain input pushes toward more scrutiny, not less.
      const exceedsCeiling = rank === undefined ? true : rank > ceilingRank;
      if (!exceedsCeiling) continue;

      const stamped = { ...finding, lens_id: entry.lens_id, lens_version: lensVersion };
      if (unproven) reviewOnlyBlockers.push(stamped);
      else hardBlockers.push(stamped);
    }
  }

  if (hardBlockers.length > 0 || (allowUnprovenBlock && reviewOnlyBlockers.length > 0)) {
    const blocking = allowUnprovenBlock ? hardBlockers.concat(reviewOnlyBlockers) : hardBlockers;
    const reasons = blocking.map((finding) =>
      `${finding.lens_id}${finding.lens_version ? `@${finding.lens_version}` : ''} reported a ${finding.severity} "${finding.class}" finding, above the max tolerated severity "${maxSeverity}".`
    );
    return {
      decision: 'block',
      reasons,
      blocking_findings: blocking,
      missing_lenses: [],
      policy_id: policyId,
      policy_fingerprint: policyFp,
    };
  }

  if (reviewOnlyBlockers.length > 0) {
    const reasons = reviewOnlyBlockers.map((finding) =>
      `${finding.lens_id}${finding.lens_version ? `@${finding.lens_version}` : ''} is unproven and reported a ${finding.severity} "${finding.class}" finding above the max tolerated severity "${maxSeverity}"; held to review rather than block because allow_unproven_block is not set.`
    );
    return {
      decision: 'review',
      reasons,
      blocking_findings: reviewOnlyBlockers,
      missing_lenses: [],
      policy_id: policyId,
      policy_fingerprint: policyFp,
    };
  }

  return {
    decision: 'allow',
    reasons: ['Every mandatory Lens ran, and no finding from any Lens that ran exceeded the max tolerated severity.'],
    blocking_findings: [],
    missing_lenses: [],
    policy_id: policyId,
    policy_fingerprint: policyFp,
  };
}

/**
 * requiredLensesFor — which Lenses a boundary demands, across a set of
 * policies. A policy with no `applies_to` is global (applies to every
 * boundary); a policy that declares `applies_to` only contributes its
 * mandatory Lenses when the requested boundary is in that list. Multiple
 * matching policies union their mandatory_lens_ids — a boundary is gated by
 * everything any applicable policy requires, not just the first match.
 *
 * @param {string|{boundary?: string}|null|undefined} context - a boundary name, or an object carrying one
 * @param {Array<object>} policies
 * @returns {{ boundary: string|null, lens_ids: string[], policies: Array<object> }}
 */
function requiredLensesFor(context, policies) {
  const boundary = typeof context === 'string' ? context : (context && context.boundary) || null;
  const list = Array.isArray(policies) ? policies : [];

  const matched = list.filter((policy) => {
    if (!policy || !Array.isArray(policy.applies_to) || policy.applies_to.length === 0) return true;
    return boundary !== null && policy.applies_to.includes(boundary);
  });

  const lensIds = new Set();
  for (const policy of matched) {
    for (const lensId of (Array.isArray(policy.mandatory_lens_ids) ? policy.mandatory_lens_ids : [])) {
      lensIds.add(lensId);
    }
  }

  return { boundary, lens_ids: Array.from(lensIds), policies: matched };
}

/**
 * explainDecision — a readable paragraph naming the Lens(es), version(s)
 * and finding(s) that drove an evaluateGate() result, or the missing
 * mandatory Lens(es) when the decision came from the fail-closed rule.
 *
 * Enforces the same accountability rule evaluateGate() already guarantees
 * on its own output ("a refusal must be explainable") defensively here too,
 * since this function has to accept whatever object a caller hands it, not
 * only ones evaluateGate() itself produced. A block/review with no reasons
 * is not trusted just because the shape looks right — it is reported as an
 * invalid refusal and treated as allow, matching evaluateGate()'s own rule
 * rather than silently rendering an unaccountable "BLOCKED." with nothing
 * under it.
 *
 * @param {{decision: string, reasons?: string[], blocking_findings?: Array<object>, policy_fingerprint?: string, missing_lenses?: string[]}|null|undefined} result
 * @returns {string}
 */
function explainDecision(result) {
  if (!result || typeof result !== 'object') {
    return 'No gate result was supplied to explain.';
  }

  const decision = result.decision;
  const reasons = Array.isArray(result.reasons) ? result.reasons : [];
  const blocking = Array.isArray(result.blocking_findings) ? result.blocking_findings : [];

  if (decision !== 'allow' && reasons.length === 0) {
    return `Gate reported "${decision}" with no supporting reasons attached, which is not a valid refusal. A decision that cannot name what drove it is overridden and ignored: treat this as allow.`;
  }

  const verb = decision === 'block' ? 'BLOCKED' : decision === 'review' ? 'sent this to REVIEW' : 'ALLOWED';
  const sentences = [`Gate ${verb}.`];

  for (const reason of reasons) {
    sentences.push(reason.endsWith('.') ? reason : `${reason}.`);
  }

  for (const finding of blocking) {
    const lensLabel = finding && finding.lens_id
      ? `${finding.lens_id}${finding.lens_version ? `@${finding.lens_version}` : ' (version unknown)'}`
      : 'an unnamed lens';
    const claimPart = finding && finding.claim ? `: "${finding.claim}"` : '';
    sentences.push(`${lensLabel} raised a ${(finding && finding.severity) || 'unknown-severity'} "${(finding && finding.class) || 'unlabelled'}" finding${claimPart}.`);
  }

  if (result.policy_fingerprint) {
    sentences.push(`Evaluated against policy fingerprint ${result.policy_fingerprint}.`);
  }

  return sentences.join(' ');
}

/**
 * Deterministically stringify a value with object keys sorted, so two
 * policies that are equal in substance but were typed with keys in a
 * different order fingerprint identically, and any actual change in value —
 * including one that weakens the gate — fingerprints differently.
 *
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * policyFingerprint — a stable hash over a policy's full substance. Exists
 * so weakening a gate leaves a trace: raise max_severity, drop a lens from
 * mandatory_lens_ids, or flip allow_unproven_block to true, and the
 * fingerprint changes, even though nothing about HOW the policy is invoked
 * changed. A caller that logs this fingerprint alongside every gate decision
 * (see docs/QUOXLENS_GATE.md) gets an audit trail of policy drift for free,
 * without needing a separate policy-versioning system.
 *
 * @param {object|null|undefined} policy
 * @returns {string}
 */
function policyFingerprint(policy) {
  return `sha256-${crypto.createHash('sha256').update(stableStringify(policy || {}), 'utf8').digest('hex')}`;
}

module.exports = {
  SEVERITY_RANK,
  SEVERITIES,
  DEFAULT_MAX_SEVERITY,
  VALID_ON_MISSING,
  evaluateGate,
  requiredLensesFor,
  explainDecision,
  policyFingerprint,
};
