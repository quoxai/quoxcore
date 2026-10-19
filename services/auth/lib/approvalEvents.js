/**
 * AUDIT-REAL-1 — Durable, append-only, signed approval audit log.
 *
 * Problem: `pending_command_approvals` (services/auth/routes/bastion-approvals.js)
 * is UPDATE-in-place operational state — status/reviewed_by/reviewed_at get
 * mutated as an approval moves through its lifecycle. That's fine for "what
 * is the current state" but it means the historical record of *how* an
 * approval got there can be silently rewritten. There is no tamper-evidence.
 *
 * Fix: every lifecycle transition (created / approved / rejected /
 * changes_requested / cancelled / expired / auto_resolved) additionally
 * appends an immutable, hash-chained, Ed25519-signed row to
 * `approval_events` (migrations/071-approval-events.sql). The existing
 * UPDATE-in-place table and its behavior are NOT changed by this module —
 * this is a parallel audit trail, not a replacement.
 *
 * Design decisions:
 *   - One chain PER ORG (chain id "approval:org/<org_id>") — multi-tenant
 *     isolation. Compromising or auditing one org's chain reveals nothing
 *     about another org's chain.
 *   - The hash chain reuses WARD's own primitives byte-for-byte
 *     (genesisHash/chainHash/payloadHash from services/ward/lib/crypto.js)
 *     rather than reinventing a hashing scheme. "chainId" for these
 *     functions is the approval chain id above; "sourceKind"/"sourceId" are
 *     'APPROVAL'/<approval_id>; "wardEntryId" is this row's own id.
 *   - Each event is individually signed with the SAME persistent Ed25519
 *     keypair WARD/VOLT already use in production
 *     (WARD_KEY_DIR, default /var/lib/quox/ward-keys/{ward-pub,ward-priv}.pem)
 *     via services/ward/lib/signing.js's ensureKeypair/signTipHash/
 *     verifyTipSignature — no new crypto primitives introduced here.
 *   - Best-effort witnessing into the existing WARD meta-chain (source_kind
 *     'EXTERNAL', tag 'approval') happens fire-and-forget via
 *     services/auth/lib/wardAdapter.js, mirroring the existing
 *     witnessAuthAudit() pattern. WARD witnessing failing/being disabled
 *     NEVER blocks or fails the append to approval_events — this table is
 *     the primary durable record.
 *   - Append-only is enforced twice: application code here NEVER issues
 *     UPDATE/DELETE against approval_events, and the migration adds SQLite
 *     triggers that hard-fail any UPDATE/DELETE attempt as defense in depth.
 *     The actual tamper-evidence guarantee is cryptographic
 *     (verifyApprovalChain), matching WARD's own model (see
 *     services/ward/lib/verify.js) — even a caller with raw DB file access
 *     who drops the triggers and edits a row is caught by hash/signature
 *     mismatch on verification.
 */

import { mkdirSync } from 'node:fs';
import { sign as edSign } from 'node:crypto';
import { dirname } from 'node:path';
import { getDb, prepare } from '../db/index.js';
import { ulid } from '../utils/helpers.js';
import { genesisHash, chainHash, payloadHash as computePayloadHash } from '../../ward/lib/crypto.js';
import { ensureKeypair, signTipHash, verifyTipSignature } from '../../ward/lib/signing.js';

const SOURCE_KIND = 'APPROVAL';

// QUOXTRUST F8: the current append scheme. v1 (legacy) committed only `payload`
// into the hash, leaving action/actor_type/actor_id unbound (tamperable while
// still verifying INTACT). v2 binds them. Existing v1 rows keep verifying with
// their original algorithm; every new append is v2.
const HASH_VERSION = 2;

const VALID_ACTIONS = new Set([
  'created', 'approved', 'rejected', 'changes_requested', 'cancelled', 'expired', 'auto_resolved',
]);

/**
 * The payload commitment fed to chainHash's payloadHash slot — the ONLY content
 * lever into the fixed WARD chainHash primitive. v1 commits the payload alone
 * (legacy, action/actor UNBOUND). v2 commits a wrapper that ALSO binds
 * action/actor_type/actor_id, so who-decided-what is covered by the hash →
 * event_hash → signature and cannot be silently rewritten.
 *
 * @param {number} version 1 | 2
 * @param {{action: string, actorType: string, actorId: string|null, payload: object}} f
 */
export function commitmentHash(version, { action, actorType, actorId, payload }) {
  if (version >= 2) {
    return computePayloadHash({
      v: 2,
      action,
      actor_type: actorType ?? null,
      actor_id: actorId ?? null,
      payload: payload || {},
    });
  }
  return computePayloadHash(payload || {});
}

let cachedKeypair = null;
let cachedKeyPaths = null;

/**
 * Chain id for an org's approval-event chain. Same string is fed to
 * genesisHash/chainHash so the algorithm is identical to WARD's, just
 * scoped to a distinct namespace ("approval:org/..." vs WARD's
 * "ward:org/..." / "ward:meta/...").
 */
export function getApprovalChainId(orgId) {
  return `approval:org/${orgId}`;
}

function resolveKeyPaths() {
  const dir = process.env.WARD_KEY_DIR || '/var/lib/quox/ward-keys';
  return {
    pub: process.env.WARD_KEY_PUB_PATH || `${dir}/ward-pub.pem`,
    priv: process.env.WARD_KEY_PRIV_PATH || `${dir}/ward-priv.pem`,
  };
}

/**
 * Lazily load (or generate, on first boot) the persistent Ed25519 keypair
 * shared with WARD/VOLT. Cached per-process; cache is invalidated if the
 * configured key paths change (this only happens in tests).
 */
function ensureSigningKeypair() {
  const paths = resolveKeyPaths();
  if (cachedKeypair && cachedKeyPaths && cachedKeyPaths.pub === paths.pub && cachedKeyPaths.priv === paths.priv) {
    return cachedKeypair;
  }
  // The auth container does not share the collector's ward-keys dir; ensureKeypair
  // writes a fresh persistent keypair on first use, but its exportKeypair() does not
  // mkdir the parent. Create it so signing never silently degrades to unsigned.
  mkdirSync(dirname(paths.pub), { recursive: true });
  cachedKeypair = ensureKeypair(paths.pub, paths.priv);
  cachedKeyPaths = paths;
  return cachedKeypair;
}

/**
 * LOOSEN-GUARD: sign an arbitrary statement (utf8 string) with the same persistent Ed25519 key.
 * Returns { signature: base64url, keyId }. Verifiers hold only the public key.
 */
export function signWithApprovalKey(statement) {
  const kp = ensureSigningKeypair();
  return { signature: edSign(null, Buffer.from(String(statement), 'utf8'), kp.privateKey).toString('base64url'), keyId: kp.keyId };
}

/**
 * @internal test-only — force the next call to reload the keypair from disk.
 */
export function _resetSigningKeypairCache() {
  cachedKeypair = null;
  cachedKeyPaths = null;
}

function getChainHead(orgId) {
  return prepare(`
    SELECT seq, event_hash FROM approval_events
    WHERE org_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(orgId);
}

/**
 * Append a new approval lifecycle event. NEVER updates or deletes an
 * existing row — every call is a new row with seq = previous seq + 1.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.approvalId - id of the pending_command_approvals row (or other approval source)
 * @param {string} params.action - one of VALID_ACTIONS
 * @param {string} [params.actorType='user']
 * @param {string} [params.actorId]
 * @param {object} [params.payload={}] - content-free-ish summary; do not include secrets
 * @returns {object} the inserted approval_event row
 */
export function appendApprovalEvent({ orgId, approvalId, action, actorType = 'user', actorId = null, payload = {} }) {
  if (!orgId) throw new Error('appendApprovalEvent: orgId is required');
  if (!approvalId) throw new Error('appendApprovalEvent: approvalId is required');
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`appendApprovalEvent: invalid action "${action}" (must be one of ${[...VALID_ACTIONS].join(', ')})`);
  }

  getDb(); // ensure schema/migrations applied before touching approval_events

  const chainId = getApprovalChainId(orgId);
  const head = getChainHead(orgId);
  const seq = head ? head.seq + 1 : 1;
  const prevHash = head ? head.event_hash : genesisHash(chainId);

  const id = ulid();
  const createdAt = new Date().toISOString();
  // QUOXTRUST F8: v2 binds action/actor_type/actor_id into the commitment.
  const pHash = commitmentHash(HASH_VERSION, { action, actorType, actorId, payload: payload || {} });

  const eventHash = chainHash({
    prevChainHash: prevHash,
    chainId,
    seq,
    wardEntryId: id,
    timestamp: createdAt,
    sourceKind: SOURCE_KIND,
    sourceId: approvalId,
    payloadHash: pHash,
  });

  let signature = null;
  let keyId = null;
  try {
    const keypair = ensureSigningKeypair();
    signature = signTipHash(eventHash, keypair.privateKey);
    keyId = keypair.keyId;
  } catch (err) {
    // Signing is best-effort-hardened, not fire-and-forget-optional: log
    // loudly, but do not lose the append (an unsigned-but-chained event is
    // still strictly better than no audit record at all, and verification
    // will flag it as unsigned).
    console.warn('[AUDIT-REAL-1] approval event signing failed (event will be unsigned):', err.message);
  }

  const row = {
    id,
    org_id: orgId,
    approval_id: approvalId,
    seq,
    action,
    actor_type: actorType,
    actor_id: actorId,
    payload_json: JSON.stringify(payload || {}),
    payload_hash: pHash,
    prev_hash: prevHash,
    event_hash: eventHash,
    signature,
    key_id: keyId,
    ward_entry_id: null,
    created_at: createdAt,
    hash_version: HASH_VERSION,
  };

  prepare(`
    INSERT INTO approval_events (
      id, org_id, approval_id, seq, action, actor_type, actor_id,
      payload_json, payload_hash, prev_hash, event_hash, signature, key_id,
      ward_entry_id, created_at, hash_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.org_id, row.approval_id, row.seq, row.action, row.actor_type, row.actor_id,
    row.payload_json, row.payload_hash, row.prev_hash, row.event_hash, row.signature, row.key_id,
    row.ward_entry_id, row.created_at, row.hash_version,
  );

  return row;
}

/**
 * List approval events for an org, optionally filtered to one approval_id.
 * Read-only — never mutates.
 */
export function getApprovalEvents(orgId, { approvalId } = {}) {
  if (approvalId) {
    return prepare(`
      SELECT * FROM approval_events WHERE org_id = ? AND approval_id = ? ORDER BY seq ASC
    `).all(orgId, approvalId);
  }
  return prepare(`
    SELECT * FROM approval_events WHERE org_id = ? ORDER BY seq ASC
  `).all(orgId);
}

/**
 * Verify an org's approval-event chain end to end:
 *   1. Genesis check (first row's prev_hash must equal genesisHash(chainId))
 *   2. Sequence contiguity (no gaps — catches deleted rows)
 *   3. Linkage (each row's prev_hash must equal the previous row's event_hash)
 *   4. Payload hash recomputation (catches payload_json tampering)
 *   5. Event hash recomputation (catches any field tampering)
 *   6. Signature verification, when present (catches hash tampering even if
 *      an attacker recomputes a consistent-looking chain without the
 *      private key)
 *
 * Mirrors the status/reason contract of services/ward/lib/verify.js's
 * verifyChain() so the two are easy to reason about side by side.
 *
 * @param {string} orgId
 * @returns {{status: 'INTACT'|'BROKEN', org_id: string, entry_count: number, [reason]: string, [details]: object, signatures_verified?: number, warnings?: string[]}}
 */
export function verifyApprovalChain(orgId) {
  getDb();
  const chainId = getApprovalChainId(orgId);
  const rows = getApprovalEvents(orgId);

  if (rows.length === 0) {
    return {
      status: 'INTACT',
      org_id: orgId,
      entry_count: 0,
      head_seq: 0,
      head_hash: genesisHash(chainId),
      signatures_verified: 0,
      warnings: [],
    };
  }

  let publicKey = null;
  try {
    publicKey = ensureSigningKeypair().publicKey;
  } catch {
    // No key available — signature checks below will be skipped with a warning.
  }

  const warnings = [];
  let signaturesVerified = 0;
  let prevHash = genesisHash(chainId);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expectedSeq = i + 1;

    if (row.seq !== expectedSeq) {
      return {
        status: 'BROKEN',
        org_id: orgId,
        reason: 'SEQ_GAP',
        details: { expected_seq: expectedSeq, found_seq: row.seq, event_id: row.id },
      };
    }

    if (row.prev_hash !== prevHash) {
      return {
        status: 'BROKEN',
        org_id: orgId,
        reason: 'CHAIN_LINK_BROKEN',
        details: { seq: row.seq, event_id: row.id, expected_prev: prevHash, found_prev: row.prev_hash },
      };
    }

    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
    // QUOXTRUST F8: recompute with the row's own scheme. v2 binds
    // action/actor_type/actor_id (from the row) into the commitment, so a
    // rewritten action/actor produces a mismatch here. v1 (legacy) rows commit
    // payload only — their action/actor are NOT integrity-protected; flag it.
    const rowHashVersion = row.hash_version || 1;
    if (rowHashVersion < 2) {
      warnings.push(`Event ${row.id} (seq ${row.seq}) uses legacy hash v1 — action/actor are not integrity-protected`);
    }
    const recomputedPayloadHash = commitmentHash(rowHashVersion, {
      action: row.action,
      actorType: row.actor_type,
      actorId: row.actor_id,
      payload,
    });
    if (recomputedPayloadHash !== row.payload_hash) {
      return {
        status: 'BROKEN',
        org_id: orgId,
        reason: 'PAYLOAD_HASH_MISMATCH',
        details: { seq: row.seq, event_id: row.id, expected: recomputedPayloadHash, found: row.payload_hash },
      };
    }

    const recomputedEventHash = chainHash({
      prevChainHash: row.prev_hash,
      chainId,
      seq: row.seq,
      wardEntryId: row.id,
      timestamp: row.created_at,
      sourceKind: SOURCE_KIND,
      sourceId: row.approval_id,
      payloadHash: row.payload_hash,
    });

    if (recomputedEventHash !== row.event_hash) {
      return {
        status: 'BROKEN',
        org_id: orgId,
        reason: 'EVENT_HASH_MISMATCH',
        details: { seq: row.seq, event_id: row.id, expected: recomputedEventHash, found: row.event_hash },
      };
    }

    if (row.signature) {
      if (!publicKey) {
        warnings.push(`Event ${row.id} has a signature but no public key was available for verification`);
      } else {
        const valid = verifyTipSignature(row.event_hash, row.signature, publicKey);
        if (!valid) {
          return {
            status: 'BROKEN',
            org_id: orgId,
            reason: 'SIGNATURE_INVALID',
            details: { seq: row.seq, event_id: row.id, key_id: row.key_id },
          };
        }
        signaturesVerified++;
      }
    } else {
      warnings.push(`Event ${row.id} (seq ${row.seq}) is unsigned`);
    }

    prevHash = row.event_hash;
  }

  return {
    status: 'INTACT',
    org_id: orgId,
    entry_count: rows.length,
    head_seq: rows[rows.length - 1].seq,
    head_hash: rows[rows.length - 1].event_hash,
    signatures_verified: signaturesVerified,
    warnings,
  };
}
