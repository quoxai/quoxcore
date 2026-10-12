-- LAUNCH-SPINE — MFA enrolment tickets
--
-- A user in an org with mode=required who has not yet enrolled is refused at
-- login with 403 mfa_enrollment_required and gets NO session. The enrolment
-- endpoints (/mfa/setup, /mfa/verify-setup) sit behind authenticate(), so that
-- user had no way to enrol: a deadlock that made the org's MFA requirement
-- unsatisfiable for anyone not already enrolled.
--
-- This table backs a single-purpose credential minted at the moment of that
-- refusal, AFTER the password has been verified. It is not a session and must
-- never be accepted as one: it authorises only MFA enrolment.
--
-- Shape mirrors action_tokens (hash at rest, expiry, single-use tracking).

CREATE TABLE IF NOT EXISTS mfa_enrolment_tickets (
    id TEXT PRIMARY KEY,

    -- Who this ticket enrols, and which org's policy demanded it.
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,

    -- Only the SHA-256 hash is stored. The ticket itself is returned once, in
    -- the 403 body, and is never recoverable from this table.
    ticket_hash TEXT NOT NULL UNIQUE,

    -- Short-lived by design.
    expires_at TEXT NOT NULL,

    -- Single-use: stamped when enrolment completes. A consumed ticket is dead
    -- even if it has not yet expired.
    consumed_at TEXT,

    -- Context captured at mint time, for audit and for binding checks.
    issued_ip TEXT,
    consumed_ip TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mfa_tickets_hash ON mfa_enrolment_tickets(ticket_hash);
CREATE INDEX IF NOT EXISTS idx_mfa_tickets_user ON mfa_enrolment_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_tickets_expires ON mfa_enrolment_tickets(expires_at);
