-- BACKUP #727: id of the detached quox-backup-<id> container running this backup.
-- NULL for runs that used the child-process fallback. Used by the stale sweep
-- (a row whose container is still running is not stale) and by adoption.
ALTER TABLE backups ADD COLUMN container_id TEXT;
