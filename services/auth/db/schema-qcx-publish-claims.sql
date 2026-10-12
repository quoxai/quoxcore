-- QCX-2.4 — Widget publish governance claims.
--
-- Every successful widget publish writes a row here. claim_id +
-- manifest_hash are the WARD-compatible identifiers; canonical_payload
-- is the RFC 8785 JSON canonicalisation so a downstream witness can
-- rehash + verify without re-canonicalising. Append-only — claims are
-- never mutated, only new rows added on re-publish.

CREATE TABLE IF NOT EXISTS widget_publish_claims (
    claim_id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    manifest_hash TEXT NOT NULL,          -- sha256 hex of canonical_payload
    canonical_payload TEXT NOT NULL,      -- RFC 8785 JSON bytes (verifiable)
    payload_json TEXT NOT NULL,           -- human-readable JSON (same fields, unsorted)

    security_score INTEGER,               -- null when dev_only
    simulation_run_id TEXT,               -- null when dev_only
    dev_only INTEGER NOT NULL DEFAULT 0,  -- 1 when published via dev-domain bypass
    published_by_user_id TEXT NOT NULL,

    issued_at TEXT NOT NULL               -- ISO-8601, equals published_at
);

CREATE INDEX IF NOT EXISTS idx_widget_publish_claims_widget ON widget_publish_claims(widget_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_publish_claims_org ON widget_publish_claims(org_id, issued_at DESC);
