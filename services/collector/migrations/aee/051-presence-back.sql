-- 051-presence-back.sql: PRESENCE auto-clear (owner 2026-10-19). An away flag cleared by the human's first
-- real action records when and how they came back, so a client can say "Welcome back, you were away 2d 10h"
-- exactly once (welcomed flips to 1 when it has been shown).
ALTER TABLE user_presence ADD COLUMN back_at TEXT;
ALTER TABLE user_presence ADD COLUMN back_via TEXT;
ALTER TABLE user_presence ADD COLUMN away_since_prev TEXT;
ALTER TABLE user_presence ADD COLUMN welcomed INTEGER NOT NULL DEFAULT 1;
