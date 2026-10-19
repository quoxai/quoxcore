-- 040-checkpoint-inbox-mirror.sql — quox#896
--
-- An objective checkpoint waiting for a human was invisible to the Approvals
-- inbox, LUCID's "needs you" and the chat's pending count. Each pending
-- checkpoint now raises ONE Approvals inbox item; these columns make that
-- idempotent and let the reconciler close the item once the checkpoint is
-- decided elsewhere (CLI, dashboard objective view) and retire items it could
-- never raise.
ALTER TABLE checkpoints ADD COLUMN inbox_item_id TEXT;
ALTER TABLE checkpoints ADD COLUMN inbox_closed_at TEXT;
ALTER TABLE checkpoints ADD COLUMN inbox_raise_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_checkpoints_inbox_item ON checkpoints(inbox_item_id);
