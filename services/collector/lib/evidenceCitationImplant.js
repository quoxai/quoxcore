/**
 * Evidence-Cited Answers — prompt directive (COMMANDERQ P3 / E1)
 *
 * The teaching half of the pair with evidenceCitationVerifier.js. That module
 * MEASURES whether a live-state claim carried a source; this one TEACHES the
 * agent to attach one. Appended to finalSystemPrompt in handleCollectorChat
 * alongside the other surface directives (group-chat, surface-context).
 *
 * Kept short on purpose — it rides in every tool-capable chat turn's system
 * prompt, so the token budget matters. It names the exact inline marker the
 * verifier recognises — `(source: <tool_name>)` — so teaching and measurement
 * agree on one convention.
 *
 * Never throws; the caller degrades to no directive on any failure.
 */

'use strict';

function isEnabled(env = process.env) {
  return env.QUOX_EVIDENCE_CITED_ENABLED !== 'false';
}

const EVIDENCE_CITED_DIRECTIVE = `[EVIDENCE-CITED ANSWERS]
When you state a fact about LIVE system state — a count, status, health, or existence claim about infrastructure, streams, approvals, deployments, tools, policies, or evidence (e.g. "3 approvals pending", "the collector is running", "5 of 12 phases done") — it MUST come from a tool you actually called THIS turn, and you cite it inline by ending the sentence with (source: <tool_name>), using the real tool's name.
If you did NOT verify it this turn, do not assert it as current fact: say so plainly ("I haven't checked this turn", "from memory, may be stale") instead. Never invent a receipt id, a count, or a source name. A live-state claim with no tool behind it and no such disclaimer is a defect, not a convenience.`;

/**
 * @param {object} [env] process.env override (tests)
 * @returns {string} the directive, or '' when disabled.
 */
function buildEvidenceCitationDirective(env = process.env) {
  try {
    return isEnabled(env) ? EVIDENCE_CITED_DIRECTIVE : '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  buildEvidenceCitationDirective,
  EVIDENCE_CITED_DIRECTIVE,
  isEnabled,
};
