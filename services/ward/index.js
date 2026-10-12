/**
 * WARD — Write-once Append-only Receipt Digests
 * Protocol v0.1 implementation for QuoxCORE
 *
 * Public API for the WARD witness service.
 */

export { sha256, genesisHash, chainHash, canonicalize, payloadHash } from './lib/crypto.js';
export { initWardStore, closeWardStore, getDb, createChain, getChain, getEntry, getEntryBySeq, getEntryBySource, getEntryBySourceAnyChain, getEntries, getEntriesRange, getStats, getEntryCountByOrg, getCoveringTip } from './lib/store.js';
export { configure, enable, disable, isEnabled, getWitnessStats, resetWitnessStats, witness, witnessAEE, witnessAOCL, witnessVOLT } from './lib/witness.js';
export { verifyChain, verifyReceipt } from './lib/verify.js';
export { createTip, shouldCreateTip, autoTip, tipPayloadHash, witnessTipInMetaChain } from './lib/tips.js';
export { generateKeypair, signTipHash, verifyTipSignature, exportKeypair, loadKeypair, ensureKeypair } from './lib/signing.js';
export { publishTipToGitea, createAndPublishTip } from './lib/sinks.js';
export { initWardHooks, closeWardHooks, isWardActive, getHookKeypair, getHookMetaChainId, getHookChainId, wardHookAEE, wardHookAOCL, wardHookVOLT, wardHookApproval } from './lib/hooks.js';
