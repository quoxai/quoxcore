-- BRAIN2-W8: server-side capture draft (one per org + user). User content, so it
-- lives server-side, never browser-only. Cleared on successful save.
CREATE TABLE IF NOT EXISTS capture_drafts (
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
