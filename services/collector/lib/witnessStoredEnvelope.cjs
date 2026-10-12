'use strict';

/**
 * P2/W2 — witness an externally-stored AEE envelope into WARD.
 *
 * POST /aee/store (server.js) inserts the envelope but historically never
 * witnessed it — only the internal storeAuditEnvelope() did (server.js:2787-2792),
 * so external AEE POSTs (the Matrix room-DAG bridge, plugins, other services)
 * were stored-but-unwitnessed. This is the exact intent-fork storeAuditEnvelope
 * uses, factored out so the /aee/store handler and its test share one code path:
 *   aocl.* → wardHookAOCL, everything else → wardHookAEE.
 *
 * Fire-and-forget / fail-soft (SPEC §10.3): a witness error must NEVER break the
 * store — the envelope is already persisted; witnessing is additive. WARD hashes
 * only envelope metadata (id/ts/type/from/to/intent/corr), never payload, so this
 * is content-free by construction.
 *
 * @param {object} envelope  the stored envelope (must carry id + intent)
 * @param {string|null} orgId  derived org (row attribute/tag only; never affects chain/seq/hash)
 * @param {{wardHookAEE:Function, wardHookAOCL:Function}} hooks  the WARD hooks from server scope
 */
function witnessStoredEnvelope(envelope, orgId, hooks) {
  try {
    const intent = (envelope && envelope.intent) || '';
    const tagged = { ...envelope, org_id: orgId };
    if (intent.startsWith('aocl.')) {
      hooks.wardHookAOCL(tagged);
    } else {
      hooks.wardHookAEE(tagged);
    }
  } catch (err) {
    console.warn('[AEE] WARD witness failed (store still ok):', err && err.message);
  }
}

module.exports = { witnessStoredEnvelope };
