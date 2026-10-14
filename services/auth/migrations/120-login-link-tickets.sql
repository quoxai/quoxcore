-- QUOXON-C2c: one-time dashboard sign-in links.
--
-- A fresh install ends with the CLI signed in and the browser not. The CLI asks
-- for a ticket as the signed-in owner and prints a link; opening it once installs
-- a normal browser session for the same user in the same org.
--
-- Hash at rest, 10 minute expiry, single-use, bound to one user AND one org.
-- Shape mirrors mfa_enrolment_tickets (089).

CREATE TABLE IF NOT EXISTS login_link_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    -- Only the SHA-256 hash. The ticket itself is returned once and never stored.
    ticket_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    -- Single-use: stamped when the link is opened. A consumed ticket is dead.
    consumed_at TEXT,
    issued_ip TEXT,
    consumed_ip TEXT,
    issued_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_link_tickets_user ON login_link_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_login_link_tickets_expires ON login_link_tickets(expires_at);
