-- QUOXON-STEPUP: per-USER step-up PIN. Slow hash only (argon2id over an HMAC-peppered PIN), never plaintext,
-- never in the vault or env. Set/changed only from a human web session after fresh password re-auth.
CREATE TABLE IF NOT EXISTS user_step_up_pins (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    pin_hash      TEXT NOT NULL,
    pin_set_at    TEXT NOT NULL DEFAULT (datetime('now')),
    failed_count  INTEGER NOT NULL DEFAULT 0,
    locked_until  TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
