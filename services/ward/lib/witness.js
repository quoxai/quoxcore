/**
 * WARD Witness Service — core witnessing logic.
 *
 * Receives source event references (kind, id, payload_hash) and appends
 * ward entries to the appropriate chain. Fire-and-forget — failures are
 * logged but never propagate to callers.
 *
 * SPEC §10, §11, INTEGRATION.md §1
 */

import { randomUUID } from 'crypto';
import { chainHash, genesisHash } from './crypto.js';
import { getChain, appendEntry, getEntryBySeq } from './store.js';

const VALID_KINDS = new Set(['AEE', 'AOCL', 'VOLT', 'WARD', 'EXTERNAL']);
const WARD_VERSION = '0.1';

let issuerId = 'ward:default';
let enabled = false;

// Counters for observability
const counters = {
  witnessed: 0,
  duplicates: 0,
  errors: 0,
  lastWitnessedAt: null
};

/**
 * Configure the witness service.
 * @param {object} opts
 * @param {string} opts.issuerId - Identifier for this WARD instance
 */
export function configure(opts = {}) {
  if (opts.issuerId) issuerId = opts.issuerId;
}

export function enable() { enabled = true; }
export function disable() { enabled = false; }
export function isEnabled() { return enabled; }
export function getWitnessStats() { return { enabled, issuerId, ...counters }; }
export function resetWitnessStats() { counters.witnessed = 0; counters.duplicates = 0; counters.errors = 0; counters.lastWitnessedAt = null; }

/**
 * Witness a source event. Fire-and-forget.
 *
 * @param {object} params
 * @param {string} params.chainId - Target chain ID
 * @param {string} params.sourceKind - AEE | AOCL | VOLT | WARD | EXTERNAL
 * @param {string} params.sourceId - Identifier of the source event
 * @param {string} params.payloadHash - SHA-256 hex of source event canonical content
 * @param {string} [params.sourceTs] - ISO 8601 timestamp from the source event
 * @param {string[]} [params.tags] - Optional tags for filtering
 * @param {string} [params.scope] - Scope description (used if chain auto-created)
 * @param {string} [params.orgId] - ORG-VIEW-SCOPE: nullable row attribute/tag
 *   for scoping the DISPLAYED witness count to an org. Never affects chain
 *   selection, seq assignment, or hash linkage — the chain stays global.
 *   Null means genuinely unknown — never fabricated.
 * @returns {object|null} The ward entry, or null if duplicate/error
 */
export function witness({ chainId, sourceKind, sourceId, payloadHash, sourceTs, tags, scope, orgId }) {
  if (!enabled) return null;

  if (!VALID_KINDS.has(sourceKind)) {
    counters.errors++;
    console.warn(`[WARD] rejected unknown source_kind: ${sourceKind}`);
    return null;
  }

  try {
    // Get or auto-create chain
    const chain = getChain(chainId, { autoCreate: true, scope: scope || chainId });
    if (!chain) {
      counters.errors++;
      return null;
    }

    if (chain.status === 'sealed') {
      counters.errors++;
      console.warn(`[WARD] chain ${chainId} is sealed — cannot append`);
      return null;
    }

    // Compute entry fields
    const seq = chain.head_seq + 1;
    const prevHash = chain.head_chain_hash; // genesis_hash for seq=1
    const wardEntryId = randomUUID();
    const witnessedAt = new Date().toISOString();

    const hash = chainHash({
      prevChainHash: prevHash,
      chainId,
      seq,
      wardEntryId,
      timestamp: witnessedAt,
      sourceKind,
      sourceId,
      payloadHash
    });

    const entry = {
      ward_entry_id: wardEntryId,
      chain_id: chainId,
      seq,
      witnessed_at: witnessedAt,
      source_kind: sourceKind,
      source_id: sourceId,
      payload_hash: payloadHash,
      prev_chain_hash: prevHash,
      chain_hash: hash,
      issuer_id: issuerId,
      ward_version: WARD_VERSION,
      source_ts: sourceTs || null,
      tags: tags || null,
      sig: null,
      org_id: orgId || null
    };

    const result = appendEntry(entry);
    if (result === null) {
      // Duplicate — expected on retry, not an error
      counters.duplicates++;
      return null;
    }

    counters.witnessed++;
    counters.lastWitnessedAt = witnessedAt;
    return entry;
  } catch (err) {
    counters.errors++;
    console.error(`[WARD] witness error:`, err.message);
    return null;
  }
}

/**
 * Witness an AEE envelope. Convenience wrapper.
 * @param {string} [orgId] - ORG-VIEW-SCOPE: optional, additive. Trailing
 *   param so existing callers (fewer args) are unaffected.
 * @param {object} [tags] - QUOXTRUST T1/D1: optional, additive, TRAILING (after
 *   orgId so every existing caller is unaffected). wardHookAEE passes a
 *   per-field content-hash breakdown of the canonical action here (mirroring
 *   the AOCL path's `_field_hashes`) so a reconciliation pass can name exactly
 *   which action field diverged. Tags are stored verbatim and do NOT enter the
 *   payload/chain hash — the action commitment itself is bound via the
 *   envelope payload's canonical_action (covered by payload_commit), so the
 *   witness recipe is unchanged and pre-D1 receipts remain byte-comparable.
 */
export function witnessAEE(chainId, envelopeId, envelopePayloadHash, sourceTs, orgId, tags) {
  return witness({
    chainId,
    sourceKind: 'AEE',
    sourceId: envelopeId,
    payloadHash: envelopePayloadHash,
    sourceTs,
    tags,
    orgId
  });
}

/**
 * Witness an AOCL decision. Convenience wrapper.
 *
 * @param {string[]|object} [tags] - Optional, additive. VAULT-P6.I passes a
 *   per-field content-hash breakdown here (see wardHookAOCL) so a later
 *   reconciliation pass can name exactly which source column diverged —
 *   `witness()` already accepts arbitrary JSON-serializable tags and stores
 *   them verbatim; this param was simply never threaded through before.
 * @param {string} [orgId] - ORG-VIEW-SCOPE: optional, additive. Trailing
 *   param so existing callers (fewer args) are unaffected.
 */
export function witnessAOCL(chainId, decisionId, decisionPayloadHash, sourceTs, tags, orgId) {
  return witness({
    chainId,
    sourceKind: 'AOCL',
    sourceId: decisionId,
    payloadHash: decisionPayloadHash,
    sourceTs,
    tags,
    orgId
  });
}

/**
 * Witness a VOLT bundle commitment. Convenience wrapper.
 * @param {string} [orgId] - ORG-VIEW-SCOPE: optional, additive. Trailing
 *   param so existing callers (fewer args) are unaffected.
 */
export function witnessVOLT(chainId, bundleOrEventId, commitmentHash, sourceTs, orgId) {
  return witness({
    chainId,
    sourceKind: 'VOLT',
    sourceId: bundleOrEventId,
    payloadHash: commitmentHash,
    sourceTs,
    orgId
  });
}
