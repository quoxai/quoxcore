-- Add description column to orgs table
-- Run: sqlite3 /path/to/auth.db < schema-desc-fix.sql

ALTER TABLE orgs ADD COLUMN description TEXT;

-- Add description to divisions if not exists (should already be there)
-- ALTER TABLE divisions ADD COLUMN description TEXT;
