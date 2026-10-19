-- 041-agent-performance-task-index.sql — QUOXMIND-PROOF (2026-10-15)
--
-- The QuoxFlow poller writes agent_performance again (one row per completed or
-- failed task) and checks task_id first so a reconciler re-poll never
-- double-counts. This index keeps that once-per-task check cheap.
CREATE INDEX IF NOT EXISTS idx_agent_perf_task ON agent_performance(task_id);
