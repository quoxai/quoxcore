-- PRESENCE (owner 2026-10-16): a human says they are not at their terminal (/afk, /sleep in quox).
-- One row per (org, user). Sessions and LLMs read it so they stop waiting on approvals, which still
-- queue normally: presence never approves, denies or skips anything.
-- state: present | away | sleeping. auto_away_minutes NULL = auto-away off (the default).
CREATE TABLE IF NOT EXISTS user_presence (
  org_id            TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  email             TEXT,
  who               TEXT NOT NULL,
  state             TEXT NOT NULL,
  since             TEXT NOT NULL,
  note              TEXT,
  slots             TEXT,
  auto_away_minutes INTEGER,
  last_active_at    TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
