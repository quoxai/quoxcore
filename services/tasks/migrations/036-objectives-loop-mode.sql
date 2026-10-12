-- 036-objectives-loop-mode.sql — DEVSUITE-DEVMODE loop-mode execution.
--
-- The quoxified loop (an Objective running the model's own native agentic
-- loop instead of a one-shot DAG decomposition) needs three fields on the
-- objective. All additive and safe on existing rows:
--
--   execution_mode  — 'dag' (today's fixed-plan mode, the default) or 'loop'
--                     (turn-by-turn native loop). makeDecision() already
--                     forces ESCALATE on a SCHEDULED 'loop' objective
--                     (services/tasks/lib/autonomyDecision.js).
--   capability_scope — the signed deny-by-default allowlist of tool names the
--                      loop session may call; makeDecision() escalates any
--                      out-of-scope tool fail-closed (JSON array as TEXT).
--   loop_session_id  — the dev.sessions tmux/--resume handle for the run;
--                      NULL for dag rows.
--
-- No dispatch/schema for the loop RUN itself here — this is only the objective
-- surface that the gate primitives already in makeDecision() read.
ALTER TABLE objectives ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'dag';
ALTER TABLE objectives ADD COLUMN capability_scope TEXT;
ALTER TABLE objectives ADD COLUMN loop_session_id TEXT;
