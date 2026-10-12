'use strict';

/**
 * crossOrgVerifier.js
 *
 * AGH-CHAIN-3: CrossOrgVerifier interface + v1 nameOnlyVerifier implementation.
 *
 * CONTRACT + STUB-ADAPTER architecture:
 *   - The interface defines one method: verify({ orgName, requestingOrgId, conversationId, claim, claimAction })
 *   - v1 ships name-only (trust-roots-name lookup + chain presence). NO Ed25519.
 *   - Future WARD-CRYPTO stream ships wardSignedVerifier as drop-in replacement.
 *   - The single call site in enforceChainGuards.js uses deps.crossOrgVerifier.verify(...)
 *     — NEVER calls nameOnlyVerifier directly. This is the swap-point contract.
 *
 * @typedef {object} VerifyArgs
 * @property {string} orgName            — verbatim org name as captured in response text
 * @property {string} requestingOrgId    — caller's org_id (multi-tenant boundary)
 * @property {string} conversationId     — corr / conversation id for chain lookup
 * @property {string} claim              — full claim phrase (verbatim)
 * @property {string} claimAction        — verb (lowercase): 'approved', 'confirmed', 'authorised', ...
 *
 * @typedef {object} VerifyResult
 * @property {boolean} verified          — true ONLY when full path verified
 * @property {string}  reason            — 'unknown_counterparty' | 'no_chain_match' | 'signature_invalid' | 'verified' | 'missing_deps'
 * @property {boolean|null} signatureValid — null for nameOnlyVerifier; populated by signed-envelope verifiers
 * @property {object} [evidence]         — optional metadata (envelopes_found, counterparty_org_id, etc.)
 *
 * Future implementations: wardSignedVerifier (WARD-CRYPTO), drop-in replacement.
 */

/**
 * createNameOnlyVerifier({ trustRootsStore, aeeChainWalker })
 *
 * v1 implementation: trust-roots-name lookup + chain presence check.
 * NO signature verification (signatureValid is always null).
 *
 * @param {object} opts
 * @param {object} opts.trustRootsStore  — crossOrgTrustRootsStore instance
 * @param {object} opts.aeeChainWalker   — aeeChainWalker instance
 * @returns {{ verify: function }}
 */
function createNameOnlyVerifier({ trustRootsStore, aeeChainWalker }) {
  return {
    /**
     * @param {VerifyArgs} args
     * @returns {VerifyResult}
     */
    verify({ orgName, requestingOrgId, conversationId, claim, claimAction }) {
      if (!trustRootsStore || !aeeChainWalker) {
        return { verified: false, reason: 'missing_deps', signatureValid: null };
      }

      // Step 1: trust-roots name lookup (case-insensitive, org-scoped)
      const row = trustRootsStore.findByCounterpartyName(requestingOrgId, orgName);
      if (!row) {
        return { verified: false, reason: 'unknown_counterparty', signatureValid: null };
      }

      // Step 2: chain presence check — look for inbound envelopes from counterparty org
      // in 2h lookback window. AEE 'from' field uses 'org.<org_id>' for cross-org envelopes.
      const sinceTs = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const envelopes = aeeChainWalker.findOrgEnvelopesInWindow(
        conversationId,
        row.counterparty_org_id,
        sinceTs,
        { limit: 50, windowMs: 2 * 3600 * 1000 }
      );

      if (envelopes.length === 0) {
        return {
          verified: false,
          reason: 'no_chain_match',
          signatureValid: null,
          evidence: { counterparty_org_id: row.counterparty_org_id },
        };
      }

      return {
        verified: true,
        reason: 'verified',
        signatureValid: null,
        evidence: {
          counterparty_org_id: row.counterparty_org_id,
          envelopes_found: envelopes.length,
        },
      };
    },
  };
}

module.exports = { createNameOnlyVerifier };
