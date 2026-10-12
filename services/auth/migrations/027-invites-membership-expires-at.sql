-- AUD-WS-1: auditor invite membership deadline
ALTER TABLE invites ADD COLUMN membership_expires_at TEXT;
