-- 000-baseline.sql — collector Feedback database (feedback.db)
--
-- The CURRENT full schema for feedback.db (verbatim copy of the inline
-- CREATE statements previously executed directly in server.js at boot),
-- wrapped in idempotent CREATE ... IF NOT EXISTS form so a genuinely FRESH
-- database builds cleanly from migrations alone. On an EXISTING database
-- (tables already present, e.g. the live dev db), every statement below is
-- a no-op — nothing is dropped or recreated.

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'feedback',
  name TEXT,
  email TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(type);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

CREATE TABLE IF NOT EXISTS error_reports (
  id TEXT PRIMARY KEY,
  error_type TEXT NOT NULL DEFAULT 'manual',
  message TEXT NOT NULL,
  stack TEXT,
  component_stack TEXT,
  url TEXT,
  context TEXT,
  user_description TEXT,
  status TEXT NOT NULL DEFAULT 'unread',
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_error_reports_status ON error_reports(status);
CREATE INDEX IF NOT EXISTS idx_error_reports_type ON error_reports(error_type);
CREATE INDEX IF NOT EXISTS idx_error_reports_created ON error_reports(created_at);
