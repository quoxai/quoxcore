-- 029-topic-subscriptions.sql — ONE-BRAIN CX6: "tell my slot when new notes
-- about X land". A subscription is (user, topic query, slot). The collector
-- scheduler polls active rows, searches as the subscribing user, and posts new
-- hits to the slot. Failure accounting is durable: consecutive_failures counts
-- errors (never "no new notes"); after 10 the row is disabled with a reason
-- instead of being retried forever. last_notified_note_ids is a bounded JSON
-- array (last 200) so a note is announced once. Additive.
CREATE TABLE IF NOT EXISTS topic_subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  query TEXT NOT NULL,
  slot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_notified_note_ids TEXT NOT NULL DEFAULT '[]',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  disabled_reason TEXT,
  UNIQUE (org_id, user_id, query, slot)
);
CREATE INDEX IF NOT EXISTS idx_topic_subscriptions_active ON topic_subscriptions (disabled_at, org_id);
CREATE INDEX IF NOT EXISTS idx_topic_subscriptions_user ON topic_subscriptions (user_id);
