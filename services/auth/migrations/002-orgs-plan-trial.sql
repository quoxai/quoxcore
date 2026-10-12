-- ET-1: plan trial tracking columns on orgs
ALTER TABLE orgs ADD COLUMN plan_started_at TEXT;
ALTER TABLE orgs ADD COLUMN plan_expires_at TEXT;
