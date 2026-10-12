-- 039-tasks-kind-assignee.sql — HV2-6 Human Objective Steps
--
-- A task is normally an AGENT step. This adds the ability to mark a task as a
-- HUMAN step assigned to a named user: when that user responds in the inbox,
-- QuoxFlow resumes and the objective advances. Backward-compatible: every
-- existing task defaults to kind='agent', assignee_id NULL.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE tasks ADD COLUMN assignee_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
