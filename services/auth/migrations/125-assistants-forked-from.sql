-- #996: POST /orgs/:orgId/assistants and the fork route write assistants.forked_from,
-- but 000-baseline.sql never created it, so every fresh install 500'd on assistant
-- create. Older boxes already have the column from pre-baseline schema; the runner
-- tolerates "duplicate column name", so this is a no-op there.
ALTER TABLE assistants ADD COLUMN forked_from TEXT REFERENCES assistants(id);
