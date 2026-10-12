-- orgs.description (db/index.js applyMigrations, original top-level ALTER)
ALTER TABLE orgs ADD COLUMN description TEXT;
