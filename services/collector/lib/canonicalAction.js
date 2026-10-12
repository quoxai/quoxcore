'use strict';
/**
 * QUOXTRUST T1 / D1 (evidence commits to the effective action) — the ONE
 * canonical action representation.
 *
 * WHY THIS EXISTS (codex worthiness audit 2026-09-25, #1 cited reason): the
 * evidence witness bound only envelope metadata + an opaque whole-payload
 * digest, and the tool-evidence payload carried NO action fields at all
 * (only tool_name / agent_id / user_id / org_id / duration_ms / success). So
 * two different commands — an email to the CFO and an email to an attacker —
 * produced byte-identical "INTACT" witnesses. The receipt could not prove
 * WHAT ran or WHERE. An evidence-first product cannot ship that.
 *
 * The cure is a single canonical action, produced once at the executeTool
 * entry, consumed by ALL FOUR downstream surfaces from the same source:
 *   - policy      (conditionEvaluator.buildToolContext — matchable fields)
 *   - approval    (approvalGate.buildAgentGateProposal — what the human sees)
 *   - execution   (the adapter that actually runs the effect)
 *   - evidence    (toolEvidence.emitToolEvidence + the WARD witness recipe)
 *
 * A CanonicalAction carries TWO kinds of thing, kept strictly separate:
 *   (1) `args` — the normalized PLAINTEXT of the effective action. For
 *       IN-PROCESS consumers only (policy matching, approval rendering).
 *       NEVER witnessed, never persisted into WARD tags.
 *   (2) `content_commit` + `field_hashes` + `digest` — CONTENT-FREE
 *       commitments (SHA-256 digests, never plaintext) that ARE safe to fold
 *       into the witness / persist into evidence. This is what makes the
 *       action tamper-evident without broadcasting the plaintext.
 *
 * The hashing recipe is byte-identical to WARD's (services/ward/lib/crypto.js
 * canonicalize + sha256) so an independent verifier — including the offline
 * QuoxProof path — recomputes the SAME field hashes and digest. That
 * duplication is deliberate (the collector is CommonJS, WARD is ESM); it is
 * pinned by a cross-implementation AGREEMENT test
 * (test/w-t1-canonical-action-ward-agreement.test.js). If you touch the recipe
 * here, that test must stay green or the witness stops being recomputable.
 *
 * VERSIONED: `version` is stamped into the digest. A future recipe change
 * bumps the version so old receipts stay explicitly limited and are never
 * silently treated as if they were bound under the new rules.
 */

const { createHash } = require('crypto');

const CANONICAL_ACTION_VERSION = 'qtca-1';
// C3 stable effect identity (docs/trust/C3-EFFECT-IDENTITY.md). Immutable once
// shipped — changes mint qtei-2 alongside, never mutate (same discipline as qtca-1).
const EFFECT_IDENTITY_VERSION = 'qtei-1';

/**
 * SHA-256 → lowercase hex. Byte-identical to WARD crypto.js sha256().
 */
function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical JSON. Byte-identical to WARD crypto.js canonicalize() (SPEC §3.2):
 * keys sorted lexicographically at every level, no whitespace, NFC-normalized
 * strings, no exponent notation. Kept in lockstep by the agreement test.
 */
function canonicalize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj.normalize('NFC'));

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }

  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
  return '{' + pairs.join(',') + '}';
}

function payloadHash(obj) {
  return sha256(canonicalize(obj));
}

/**
 * A field name is PLATFORM CONTROL METADATA (not part of the effective action)
 * iff it starts with an underscore. These are injected server-side across the
 * approval lifecycle (`_approvalId`, `_connectorRequiresApproval`, `_resumeToken`
 * …); their VALUES mutate between the proposed and the resumed call, so binding
 * them would make one logical action produce two different identities. We
 * therefore exclude them from the action identity — but we RECORD THEIR NAMES
 * (see `control_fields`) and bind that list into the digest, so a verifier can
 * see that control fields were present and cannot be tricked into thinking a
 * bare action was witnessed when it was not. This is the T8 discipline
 * (don't broadly drop fields from signatures) applied honestly: names bound,
 * lifecycle-mutable values excluded on purpose and declared.
 */
function isControlField(key) {
  return typeof key === 'string' && key.startsWith('_');
}

/**
 * Build the canonical action for a tool execution.
 *
 * @param {string} toolName            the tool being executed
 * @param {*}       input              the tool input (usually an object; may be
 *                                     a scalar/array/null for odd tools)
 * @param {object}  [ctx]              { orgId, agentId, userId, attachLeaseId, holderUserId }
 * @returns {object} a frozen CanonicalAction:
 *   {
 *     version, tool, tenant,
 *     identity: { agent, user, attach_lease, holder_user },
 *     args,                 // normalized PLAINTEXT effect args (in-process only)
 *     control_fields,       // sorted names of excluded underscore fields
 *     field_hashes,         // { <argKey>: sha256 } content-free per-field commitment
 *     content_commit,       // sha256 over the full normalized args
 *     digest,               // sha256 over the identity+commitments (the action id)
 *   }
 */
function buildCanonicalAction(toolName, input, ctx = {}) {
  const tenant = ctx.orgId != null ? ctx.orgId : null;
  const identity = {
    agent: ctx.agentId != null ? ctx.agentId : null,
    user: ctx.userId != null ? ctx.userId : null,
    attach_lease: ctx.attachLeaseId != null ? ctx.attachLeaseId : null,
    holder_user: ctx.holderUserId != null ? ctx.holderUserId : null,
  };

  // Normalize the input into the effective-action args + the excluded control
  // field names. Non-object inputs (scalar/array/null) are carried whole under
  // a single `_value` arg so the commitment still covers them faithfully.
  let args;
  const controlFields = [];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    args = {};
    for (const key of Object.keys(input)) {
      if (isControlField(key)) {
        controlFields.push(key);
      } else {
        args[key] = input[key];
      }
    }
  } else {
    // scalar, array, null, or undefined — bind it whole, no control fields.
    args = { value: input === undefined ? null : input };
  }
  controlFields.sort();

  // Per-field content-free commitments over the effective-action args only.
  const fieldHashes = {};
  for (const key of Object.keys(args).sort()) {
    fieldHashes[key] = payloadHash(args[key]);
  }

  const contentCommit = payloadHash(args);

  // The action identity binds: format version, tool, tenant, principal
  // identity, the whole-action commitment, the per-field commitments, and the
  // NAMES of any excluded control fields. Plaintext `args` is deliberately NOT
  // in the digest (it is recomputable from field_hashes/content_commit and must
  // never be needed to verify the receipt).
  const digest = payloadHash({
    version: CANONICAL_ACTION_VERSION,
    tool: toolName != null ? toolName : null,
    tenant,
    identity,
    content_commit: contentCommit,
    field_hashes: fieldHashes,
    control_fields: controlFields,
  });

  // QUOXTRUST C3 (docs/trust/C3-EFFECT-IDENTITY.md, qtei-1) — the STABLE effect
  // identity: what the action DOES, invariant across the authorization
  // lifecycle. qtca-1's `digest` binds the NAMES of excluded control fields, so
  // proposal input (no _approvalId) and resumed input (with it) digest
  // DIFFERENTLY for the identical effect — correct for evidence (it commits to
  // the exact invocation) but unusable as the proposal→approval→resume→intent→
  // receipt join key. effect_id excludes control-field names, actor identity,
  // and attempt metadata BY DESIGN; the execution ledger's action_digest and
  // the intent↔receipt join both bind to it (C3 rules 1 and 3). qtca-1's
  // digest is unchanged for wire/storage compatibility.
  const effectId = payloadHash({
    v: EFFECT_IDENTITY_VERSION,
    tool: toolName != null ? toolName : null,
    tenant,
    field_hashes: fieldHashes,
    content_commit: contentCommit,
  });

  return Object.freeze({
    version: CANONICAL_ACTION_VERSION,
    tool: toolName != null ? toolName : null,
    tenant,
    identity: Object.freeze(identity),
    args,
    control_fields: controlFields,
    field_hashes: fieldHashes,
    content_commit: contentCommit,
    digest,
    effect_id: effectId,
    effect_id_version: EFFECT_IDENTITY_VERSION,
  });
}

/**
 * The content-free evidence view of a canonical action: everything EXCEPT the
 * plaintext `args`. This is what emitToolEvidence stamps into the AEE payload
 * and what the WARD witness binds. Safe to persist and to publish.
 */
function actionEvidenceCommitment(action) {
  if (!action || typeof action !== 'object') return null;
  return {
    version: action.version,
    tool: action.tool,
    tenant: action.tenant,
    identity: action.identity,
    content_commit: action.content_commit,
    field_hashes: action.field_hashes,
    control_fields: action.control_fields,
    digest: action.digest,
    // C3 rule 3: the receipt carries the same effect_id as the durable intent
    // row — the reconciler's intent → receipt join key. Content-free.
    effect_id: action.effect_id,
    effect_id_version: action.effect_id_version,
  };
}

module.exports = {
  CANONICAL_ACTION_VERSION,
  EFFECT_IDENTITY_VERSION,
  buildCanonicalAction,
  actionEvidenceCommitment,
  // exported for the cross-implementation agreement test only
  _canonicalize: canonicalize,
  _payloadHash: payloadHash,
  _sha256: sha256,
};
