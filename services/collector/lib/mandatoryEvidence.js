'use strict';
/**
 * QUOXTRUST WP4.1a (D6, codex B5) — mandatory execution evidence.
 *
 * The org privacy toggle DISABLE_TRANSCRIPT_STORAGE used to make
 * storeAuditEnvelope return BEFORE storing/witnessing for EVERY envelope type,
 * so a single settings flip silently erased fact-of-execution receipts — which
 * falsified the flagship "catching everything ... lands here without asking"
 * claim on the running system (gauge run 2026-09-28, D6 investigator).
 *
 * The contract split: TRANSCRIPT retention is an org privacy preference and
 * the toggle rightly governs it. EXECUTION RECEIPTS are the platform's
 * fact-of-execution commitment and are CONTENT-FREE BY CONSTRUCTION
 * (tool name, principal ids, duration, success flag, a bounded error slice,
 * and the canonical-action commitment: digests and per-field hashes, never
 * plaintext args — see lib/toolEvidence.js payload). Privacy governs content;
 * it never governs whether the fact of an execution is recorded.
 *
 * Detection is by the evidence CHANNEL, not by intent string: per-tool
 * receipts address `to: 'system.tools'` and AOCL traces `to: 'system.aocl'`
 * (entity tools substitute their own intent names via _aeeIntent, so intent
 * matching would leak). Audited 2026-09-28: all 16 producers of these two
 * addresses are tool-execution evidence paths (toolEvidence.js, the gold
 * routes at server.js ~9578/9655/9874/9898, the dispatchers). A NEW producer
 * addressing these channels inherits mandatory storage — which is the correct
 * default for anything claiming to be tool evidence.
 *
 * KNOWN BOUNDED LEAK, deliberate: the receipt's `error` field carries up to
 * 200 chars of the provider error, which can echo fragments of content.
 * Documented in docs/trust/ evidence notes; tightening that slice is a
 * follow-on, not a reason to let receipts be erasable.
 */

const MANDATORY_EVIDENCE_ADDRESSES = Object.freeze(['system.tools', 'system.aocl']);

function isMandatoryExecutionEvidence(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  return MANDATORY_EVIDENCE_ADDRESSES.includes(envelope.to);
}

module.exports = { isMandatoryExecutionEvidence, MANDATORY_EVIDENCE_ADDRESSES };
