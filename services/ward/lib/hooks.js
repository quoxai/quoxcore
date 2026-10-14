/**
 * WARD Integration Hooks — fire-and-forget witnessing for AEE/AOCL/VOLT.
 * SPEC §10, INTEGRATION.md §1
 *
 * These hooks are called from persistence points in the collector and
 * frontend bridges. They MUST NOT block or throw — all errors are
 * logged and swallowed per SPEC §2.2.
 *
 * Usage:
 *   import { initWardHooks, wardHookAEE, wardHookAOCL, wardHookVOLT } from './hooks.js'
 *   initWardHooks({ dbPath, chainId, issuerId })
 *   // Then call wardHookAEE(envelope) after each AEE persistence
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { payloadHash } from './crypto.js';
import { initWardStore, closeWardStore, updateTipReceipt } from './store.js';
import { configure, enable, disable, isEnabled, witness, witnessAEE, witnessAOCL, witnessVOLT } from './witness.js';
import { createTip, shouldCreateTip, witnessTipInMetaChain } from './tips.js';
import { voltBundleDigest } from './voltDigest.js';
import { ensureKeypair } from './signing.js';
import { getDb } from './store.js';

let hookChainId = null;
let sinkModule = null; // Lazy-loaded CJS module
let metaChainId = null;
let tipInterval = 100;
let keypair = null;
let initialized = false;
// QUOXTRUST FND_..SQJP: count runtime witness FAILURES (the catch blocks below) so a witnessing
// subsystem that is up but silently failing individual witness writes is VISIBLE on /health,
// instead of the "catch that returns null and only console.warns" swallowing it. Surfaced via
// getWitnessErrorCount() -> wardHooksStatus() -> /health. (The whole-subsystem-down case is
// covered separately by isWardActive() now gating wardHooksStatus().ready.)
let witnessErrors = 0;
export function getWitnessErrorCount() { return witnessErrors; }
export function isSigningEnabled() { return keypair !== null; }

/**
 * Initialise WARD hooks. Call once at service startup.
 *
 * @param {object} opts
 * @param {string} opts.dbPath - Path to WARD SQLite database
 * @param {string} opts.chainId - Chain ID for this deployment (e.g. "ward:org/quox/env/production")
 * @param {string} [opts.issuerId] - Issuer ID (default: "ward:collector")
 * @param {number} [opts.tipInterval] - Auto-tip every N entries (default: 100)
 * @param {string} [opts.keyPubPath] - Path to Ed25519 public key PEM (enables signed tips)
 * @param {string} [opts.keyPrivPath] - Path to Ed25519 private key PEM
 * @param {string} [opts.metaChainId] - Meta-chain ID for cross-chain witnessing (e.g. "ward:meta/quox-global")
 */
export function initWardHooks(opts) {
  if (initialized) return;

  try {
    initWardStore(opts.dbPath);
    configure({ issuerId: opts.issuerId || 'ward:collector' });
    hookChainId = opts.chainId;
    tipInterval = opts.tipInterval || 100;
    metaChainId = opts.metaChainId || null;

    // Load or generate signing keypair if paths provided
    if (opts.keyPubPath && opts.keyPrivPath) {
      try {
        // Ensure key directory exists
        mkdirSync(dirname(opts.keyPubPath), { recursive: true });
        keypair = ensureKeypair(opts.keyPubPath, opts.keyPrivPath);
        console.log(`[WARD] Signing keypair loaded — keyId=${keypair.keyId}`);
      } catch (err) {
        console.warn('[WARD] Keypair load failed (tips will be unsigned):', err.message);
        keypair = null;
      }
    }

    enable();
    initialized = true;
    console.log(`[WARD] Hooks initialised — chain=${hookChainId}${metaChainId ? ` meta=${metaChainId}` : ''}${keypair ? ' signing=enabled' : ''}`);
  } catch (err) {
    console.error('[WARD] Failed to initialise hooks:', err.message);
  }
}

/**
 * Shut down WARD hooks gracefully.
 */
export function closeWardHooks() {
  if (!initialized) return;
  try {
    disable();
    closeWardStore();
    initialized = false;
    keypair = null;
    metaChainId = null;
    hookChainId = null;
  } catch (err) {
    console.error('[WARD] Failed to close hooks:', err.message);
  }
}

/**
 * Check if WARD hooks are active.
 */
export function isWardActive() {
  return initialized && isEnabled();
}

/**
 * Get the current signing keypair (for API use). Returns null if not configured.
 */
export function getHookKeypair() {
  return keypair;
}

/**
 * Get the configured meta-chain ID. Returns null if not configured.
 */
export function getHookMetaChainId() {
  return metaChainId;
}

/**
 * Get the configured chain ID for this hook instance.
 */
export function getHookChainId() {
  return hookChainId;
}

/**
 * Check if an auto-tip should be created (entry count threshold reached).
 */
function shouldAutoTip() {
  return shouldCreateTip(hookChainId, tipInterval);
}

/**
 * Auto-tip with optional signing, meta-chain witnessing, and external publication.
 * Called after each successful witness when shouldAutoTip() returns true.
 */
function signedAutoTip(chainId) {
  try {
    const opts = { notes: `Auto-tip at interval ${tipInterval}` };
    if (keypair) opts.keypair = keypair;
    const tip = createTip(chainId, opts);

    if (tip && metaChainId) {
      witnessTipInMetaChain(metaChainId, tip);
    }

    // WARD-EXT: publish to external sinks (non-blocking, async fire-and-forget)
    if (tip) {
      publishTipToSinks(tip);
    }
  } catch (err) {
    console.warn('[WARD] Auto-tip error (non-fatal):', err.message);
  }
}

/**
 * WARD-EXT: Publish a tip to all configured external sinks.
 * Async fire-and-forget — errors are logged, never thrown.
 */
async function publishTipToSinks(tip) {
  try {
    // Lazy-load sinks module — retry on each call if previous import failed
    if (!sinkModule) {
      try {
        sinkModule = await import('./sinks.js');
      } catch (importErr) {
        console.warn('[WARD] Sinks module import failed (will retry next tip):', importErr.message);
        sinkModule = null; // Ensure retry on next call
        return;
      }
    }
    if (!sinkModule?.publishToAllSinks) return;

    const results = await sinkModule.publishToAllSinks(tip);
    const successRefs = results.filter(r => r.success).map(r => r.sink_ref);

    if (successRefs.length > 0) {
      try {
        getDb().prepare('UPDATE ward_tips SET sink_ref = ? WHERE tip_id = ?')
          .run(successRefs.join(','), tip.tip_id);
      } catch { /* non-fatal — tip published, just couldn't update local record */ }
    }

    // AUDIT-REAL #3: persist the RFC 3161 receipt DER from the `tsa` sink.
    // publishToAllSinks() previously discarded tsr_base64 and kept only the
    // sink_ref string — the receipt was requested, briefly held in memory,
    // and then dropped, making it impossible to re-verify the timestamp
    // later. tsa.js is the only sink that returns tsr_base64.
    const tsaResult = results.find(r => r.type === 'tsa' && r.success && r.tsr_base64);
    if (tsaResult) {
      try {
        updateTipReceipt(tip.tip_id, tsaResult.tsr_base64);
      } catch (err) {
        console.warn('[WARD] Failed to persist TSA receipt (non-fatal):', err.message);
      }
    }
  } catch (err) {
    console.warn('[WARD] Sink publish error (non-fatal):', err.message);
  }
}

/**
 * Witness an AEE envelope. Fire-and-forget.
 *
 * Called after storeAuditEnvelope() in collector.
 * Computes payload hash from envelope canonical JSON (excluding raw/encrypted fields).
 *
 * @param {object} envelope - The AEE envelope (id, type, from, to, intent, corr, payload)
 * @returns {object|null} The ward entry, or null
 */
/**
 * Run a burst of witness calls (a sync batch) in ONE ward.db transaction instead of one commit
 * per entry. Same calls, same order, so the same chain. fn must only make witness calls (they
 * are idempotent: the (chain, source) uniqueness check never witnesses twice). If fn itself
 * throws, the batch rolls back and the error is re-raised. If only the COMMIT fails, the batch
 * is re-run item by item so no witness is lost. Speed audit 2026-10-10.
 */
export function wardBatch(fn) {
  if (!initialized) return fn();
  let fnErr = null;
  try {
    return getDb().transaction(() => {
      try { return fn(); } catch (e) { fnErr = e; throw e; }
    })();
  } catch (err) {
    if (fnErr) throw fnErr;
    console.warn('[WARD] batch commit failed, witnessing item by item:', err.message);
    return fn();
  }
}

export function wardHookAEE(envelope) {
  if (!initialized) return null;

  try {
    const envelopeId = envelope.id;
    if (!envelopeId) return null;

    // Compute payload hash from the canonical envelope fields (content-free per SPEC §2.1).
    // QUOXTRUST T1 (codex worthiness audit 2026-09-25, #1 cited reason): the witness MUST bind
    // the effective action, not just metadata. Previously this hash omitted `payload`, so two
    // different commands to two different hosts produced identical INTACT witnesses — the receipt
    // could not prove what ran or where. We now fold a CONTENT COMMITMENT (a digest of the
    // canonical payload) into the witness. This preserves content-free (a digest, never the
    // plaintext) while making the action tamper-evident. Envelopes with no payload commit to null.
    // Pre-fix AEE receipts are metadata-only and remain explicitly limited — they are NOT
    // retroactively payload-bound (a payload-aware recompute will not match them, which is correct).
    const hash = payloadHash({
      id: envelope.id,
      v: envelope.v || '1',
      ts: envelope.ts,
      type: envelope.type,
      from: envelope.from,
      to: envelope.to,
      intent: envelope.intent,
      corr: envelope.corr,
      reply_to: envelope.reply_to || null,
      payload_commit: envelope.payload != null ? payloadHash(envelope.payload) : null,
      // QUOXTRUST F10 (re-scoped from the HITL premise — HITL/AOCL data lives in
      // envelope.payload and is already covered by payload_commit): bind org_id
      // into the content commitment. org_id is otherwise a BARE ward_entries
      // column (witness.js) that the store TRUSTS for tenant visibility
      // (store.js getEntryCountByOrg / list scoping: `org_id = ? OR org_id IS
      // NULL`), yet it was in NO hash — a rewritten org_id (or org_id -> NULL,
      // visible to every org) re-attributed evidence while verification stayed
      // green. Binding it here makes an org_id rewrite tamper-EVIDENT on a
      // source recompute, exactly as payload_commit did for the action. Pre-fix
      // AEE receipts remain metadata-limited (same versioning stance as above).
      org_id: envelope.org_id || null
    });

    // QUOXTRUST T1/D1: when the AEE payload carries a canonical action (the
    // content-free commitment emitToolEvidence / the gold path stamp in — see
    // services/collector/lib/canonicalAction.js), persist its per-field hash
    // breakdown into WARD's `tags` column, exactly as the AOCL path does with
    // `_field_hashes`. This lets a reconciliation pass name WHICH action field
    // diverged (recipient vs subject vs command), not just "something changed".
    // Purely ADDITIVE: the action digest is already bound via `payload_commit`
    // above (it is inside envelope.payload), so this does not alter the hash;
    // envelopes without a canonical_action get `tags: undefined`, unchanged.
    const ca = envelope.payload && envelope.payload.canonical_action;
    // WP4/D1 (gauge-A finding 2026-09-28): also lift the qtei-1 effect_id into
    // the tags so the durable-intent row (execution_intents.action_digest =
    // effect_id) JOINS to the witnessed receipt on an EXTERNALLY-readable
    // surface — before this, the join existed only behind the collector's
    // encrypted payload (intent digest never matched the qtca-1 tag digest by
    // design; a skeptic could not verify intent↔receipt without decrypting).
    // Additive like the rest of tags: covered against tamper via payload_commit
    // (effect_id is inside envelope.payload.canonical_action).
    // QUOXHAT P5: lift the turn-authority digests of a quoxhat.manifest.resolved
    // receipt into WARD's externally-readable tags column, exactly as effect_id
    // is lifted above — before this, the digests sat only behind the collector's
    // encrypted payload, so a skeptic could not join "which manifest did this
    // turn wear" to the witnessed entry without decrypting. Additive: the
    // digests are already tamper-bound via payload_commit (they are inside
    // envelope.payload); envelopes of any other intent are untouched.
    const qh = (envelope.intent === 'quoxhat.manifest.resolved' && envelope.payload)
      ? envelope.payload
      : null;
    const tags = (ca && ca.field_hashes)
      ? {
          _kind: 'tool_action_v1',
          version: ca.version,
          action_digest: ca.digest,
          fields: ca.field_hashes,
          ...(ca.effect_id ? { effect_id: ca.effect_id, effect_id_version: ca.effect_id_version } : {}),
        }
      : qh
        ? {
            _kind: 'quoxhat_manifest_v1',
            hat_key: qh.hat_key || null,
            hat_revision: qh.hat_revision ?? null,
            // T0 re-drive lesson (2026-10-02): a collector rebuild erased the
            // only record that a turn's hat came from auto_agent_match (it
            // lived in the in-memory stats + docker logs). Selection
            // provenance is part of the authority story — lift it too.
            hat_source: qh.hat_source || null,
            agent: qh.agent || null,
            definition_digest: qh.definition_digest || null,
            manifest_digest: qh.manifest_digest || null,
            manifest_size: qh.manifest_size ?? null,
            enforced: qh.enforced === true,
          }
        : undefined;

    // ORG-VIEW-SCOPE: tag the row with the source envelope's org_id (set by
    // the collector's deriveEnvelopeOrgId()/req.user.org_id choke point) —
    // additive, never fabricated; null when the caller has none.
    const entry = witnessAEE(hookChainId, envelopeId, hash, envelope.ts, envelope.org_id || null, tags);

    // Auto-tip check (signed if keypair configured, meta-chain witnessed if configured)
    if (entry && shouldAutoTip()) {
      signedAutoTip(hookChainId);
    }

    return entry;
  } catch (err) {
    witnessErrors++;
    console.warn('[WARD] AEE hook error (non-fatal):', err.message);
    return null;
  }
}

/**
 * Witness an AOCL layer event. Fire-and-forget.
 *
 * Called when an AOCL layer event envelope is stored.
 * Filters to only witness layer completion/rejection events (not starts).
 *
 * @param {object} envelope - The AOCL layer event envelope
 * @returns {object|null} The ward entry, or null
 */
export function wardHookAOCL(envelope) {
  if (!initialized) return null;

  try {
    const intent = envelope.intent || '';
    // Only witness completed layer decisions, not starts
    if (intent === 'aocl.layer.start' || intent === 'aocl.run.start') return null;
    // BUG 9 (quoxflow#9): other aocl.* intents (e.g. aocl.verify.passed) are
    // not layer decisions but ARE stored AEE envelopes; they were silently
    // dropped here, so `ward verify --envelope` said SOURCE_NOT_FOUND. Witness
    // them as AEE (keyed by envelope id) like every sibling envelope.
    if (!intent.startsWith('aocl.layer.') && !intent.startsWith('aocl.run.')) {
      return wardHookAEE(envelope);
    }

    const decisionId = envelope.id;
    if (!decisionId) return null;

    // VAULT-P6.I FINDING (fixed here): this hash previously used only
    // envelope-level fields (id/intent/ts/corr/layer/status/allowed) — it
    // silently ignored `envelope.payload._payload_hash`, the richer
    // content hash wardAdapter.js's `_buildAuditPayloadHash()` computes
    // over the actual audit_events row (actor_id, target_id, org_id,
    // action, status, created_at). That hash was built and attached to
    // every payload but never actually fed the value durably stored as
    // `ward_entries.payload_hash` — so an attacker who rewrote
    // actor_id/target_id directly in audit_events (never touching
    // ward.db) produced a row whose recomputed content hash still
    // matched what was stored, because the stored hash never depended on
    // those columns in the first place. Folding `_payload_hash` in here
    // (additive: null for every other AOCL envelope kind, which never set
    // it) closes that gap for every witness going forward. Existing
    // entries remain verifiable under whatever inputs were true when they
    // were witnessed — this only changes the hash formula for NEW writes.
    const hash = payloadHash({
      id: envelope.id,
      intent: envelope.intent,
      ts: envelope.ts,
      corr: envelope.corr,
      layer: envelope.payload?.layer || null,
      status: envelope.payload?.status || null,
      allowed: envelope.payload?.allowed ?? null,
      content_hash: envelope.payload?._payload_hash || null
    });

    // VAULT-P6.I: when the caller attaches a per-field hash breakdown
    // (`_field_hashes`, see wardAdapter.js witnessAuthAudit), persist it in
    // WARD's own `tags` column (unused for AOCL entries until now) so a
    // later reconciliation pass can name exactly which source column
    // diverged, not just "something changed". Purely additive — entries
    // without `_field_hashes` get `tags: undefined`, unchanged from before.
    const tags = envelope.payload?._field_hashes
      ? { _kind: 'auth_audit_v1', fields: envelope.payload._field_hashes }
      : undefined;

    // ORG-VIEW-SCOPE: same source as wardHookAEE above — additive, null-safe.
    const entry = witnessAOCL(hookChainId, decisionId, hash, envelope.ts, tags, envelope.org_id || null);

    if (entry && shouldAutoTip()) {
      signedAutoTip(hookChainId);
    }

    return entry;
  } catch (err) {
    witnessErrors++;
    console.warn('[WARD] AOCL hook error (non-fatal):', err.message);
    return null;
  }
}

/**
 * Witness a VOLT event or bundle. Fire-and-forget.
 *
 * @param {object} event - A VOLT event (event_id, hash, run_id, event_type)
 *                         OR a VOLT bundle manifest (bundle_id, first_event_hash, last_event_hash)
 * @returns {object|null} The ward entry, or null
 */
export function wardHookVOLT(event) {
  if (!initialized) return null;

  try {
    // Bundle finalization
    if (event.bundle_id) {
      // LL-9i4: the hash recipe now lives in the shared voltBundleDigest() so
      // the local witness and the Quox Verified countersignature attest the
      // exact same digest (byte-identical to the previous inline recipe).
      const hash = voltBundleDigest(event);

      const entry = witnessVOLT(hookChainId, event.bundle_id, hash, event.created_ts, event.org_id || null);
      if (entry && shouldAutoTip()) signedAutoTip(hookChainId);
      return entry;
    }

    // Individual VOLT event
    if (event.event_id && event.hash) {
      const entry = witnessVOLT(hookChainId, event.event_id, event.hash, event.ts, event.org_id || null);
      if (entry && shouldAutoTip()) signedAutoTip(hookChainId);
      return entry;
    }

    return null;
  } catch (err) {
    witnessErrors++;
    console.warn('[WARD] VOLT hook error (non-fatal):', err.message);
    return null;
  }
}

/**
 * Witness an approval lifecycle event (AUDIT-REAL-1). Fire-and-forget.
 *
 * Approval events are additionally recorded in a dedicated hash-chained,
 * signed table (services/auth/lib/approvalEvents.js) which is the primary
 * durable record — this witnesses the SAME event into WARD's own meta-chain
 * as cross-system corroborating evidence.
 *
 * Uses source_kind 'EXTERNAL' (tagged 'approval') rather than introducing a
 * new 'APPROVAL' source_kind, because the ward_entries table's source_kind
 * CHECK constraint is baked into the live production ward.db schema
 * (696k+ rows) and SQLite cannot ALTER a CHECK constraint without a full
 * table rebuild — 'EXTERNAL' is WARD's existing, intended escape valve for
 * exactly this case (see VALID_KINDS in witness.js).
 *
 * @param {object} params
 * @param {string} params.eventId - approval_events.id (WARD source_id)
 * @param {string} params.eventHash - approval_events.event_hash (WARD payload_hash)
 * @param {string} [params.ts] - ISO timestamp
 * @returns {object|null} The ward entry, or null
 */
export function wardHookApproval({ eventId, eventHash, ts } = {}) {
  if (!initialized) return null;
  if (!eventId || !eventHash) return null;

  try {
    const entry = witness({
      chainId: hookChainId,
      sourceKind: 'EXTERNAL',
      sourceId: eventId,
      payloadHash: eventHash,
      sourceTs: ts,
      tags: ['approval'],
    });

    if (entry && shouldAutoTip()) signedAutoTip(hookChainId);
    return entry;
  } catch (err) {
    witnessErrors++;
    console.warn('[WARD] Approval hook error (non-fatal):', err.message);
    return null;
  }
}
