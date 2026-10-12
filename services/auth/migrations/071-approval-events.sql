-- AUDIT-REAL-1: durable, append-only, hash-chained, Ed25519-signed approval
-- audit log.
--
-- Sibling to pending_command_approvals (bastion-hitl.sql / 294 in
-- 000-baseline.sql) which remains UPDATE-in-place for OPERATIONAL state
-- (status/reviewed_by/reviewed_at). This table is the durable AUDIT record:
-- one row per lifecycle transition (created / approved / rejected /
-- changes_requested / cancelled / expired / auto_resolved), NEVER updated
-- or deleted. A resolution is always a NEW row, never a mutation of an
-- earlier one.
--
-- Chaining model mirrors services/ward/lib/crypto.js (genesisHash + chainHash)
-- exactly — see services/auth/lib/approvalEvents.js, which imports those
-- functions directly rather than reimplementing the hash chain. Each org
-- gets its own chain (chain id "approval:org/<org_id>"), so a compromise or
-- audit of one org's log carries no data about another org's chain
-- (multi-tenant isolation).
--
-- Each event is individually Ed25519-signed using the SAME persistent
-- keypair WARD/VOLT already use (WARD_KEY_DIR, default
-- /var/lib/quox/ward-keys/{ward-pub,ward-priv}.pem) — see
-- services/auth/lib/approvalEvents.js's use of services/ward/lib/signing.js.
--
-- Belt-and-braces: triggers below make UPDATE/DELETE hard-fail at the SQLite
-- layer (defense in depth on top of the application-level "never emit
-- UPDATE/DELETE" contract and the cryptographic chain, which is what
-- actually proves tamper-evidence — see verifyApprovalChain()).
CREATE TABLE IF NOT EXISTS approval_events (
    id            TEXT PRIMARY KEY,              -- ULID, unique event id
    org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    approval_id   TEXT NOT NULL,                  -- ref: pending_command_approvals.id (no FK — approval sources may vary)
    seq           INTEGER NOT NULL,               -- 1-based sequence number within this org's approval-event chain
    action        TEXT NOT NULL CHECK (action IN ('created', 'approved', 'rejected', 'changes_requested', 'cancelled', 'expired', 'auto_resolved')),
    actor_type    TEXT NOT NULL DEFAULT 'user',
    actor_id      TEXT,
    payload_json  TEXT NOT NULL DEFAULT '{}',     -- content-free-ish summary (command hash, host, comment) — canonicalized before hashing
    payload_hash  TEXT NOT NULL,                  -- SHA-256 of canonical payload (services/ward/lib/crypto.js payloadHash())
    prev_hash     TEXT NOT NULL,                  -- event_hash of the previous approval_event for this org (genesisHash if seq = 1)
    event_hash    TEXT NOT NULL,                  -- chainHash({prevChainHash: prev_hash, chainId: approval:org/<org_id>, seq, wardEntryId: id, timestamp: created_at, sourceKind: 'APPROVAL', sourceId: approval_id, payloadHash: payload_hash})
    signature     TEXT,                           -- base64 Ed25519 signature over event_hash, signed with the WARD/VOLT keypair
    key_id        TEXT,                           -- fingerprint of the signing key used (null if signing unavailable)
    ward_entry_id TEXT,                            -- WARD ward_entry_id this event was ALSO witnessed as (source_kind EXTERNAL, tag "approval"), null if WARD witnessing unavailable/disabled
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_events_org_seq ON approval_events(org_id, seq);
CREATE INDEX IF NOT EXISTS idx_approval_events_org_created ON approval_events(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approval_events_approval ON approval_events(approval_id);

-- Append-only enforcement: no UPDATE, no DELETE, ever. A resolution is a new
-- row with the next seq, not a mutation of an earlier one.
CREATE TRIGGER IF NOT EXISTS trg_approval_events_no_update
BEFORE UPDATE ON approval_events
BEGIN
    SELECT RAISE(ABORT, 'approval_events is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_approval_events_no_delete
BEFORE DELETE ON approval_events
BEGIN
    SELECT RAISE(ABORT, 'approval_events is append-only: DELETE is not permitted');
END;
