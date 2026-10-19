-- 033-notes-status-index.sql: /brain/status counts (newest note, notes by
-- scope) read every note row, bodies included: ~1.15s of synchronous SQLite
-- per status call on the dev brain, stalling /brain/context calls that landed
-- meanwhile (quox#1108, 2026-10-16). This covering index answers them from
-- the index alone. Additive.
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(scope, org_id, owner_user_id, created_at);
