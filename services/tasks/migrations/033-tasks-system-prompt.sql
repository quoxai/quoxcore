-- 033-tasks-system-prompt.sql — MACH-FOLLOWUP WI-D
--
-- Companion to 032-objectives-system-prompt.sql. Every decomposed task
-- inherits objective.system_prompt verbatim at insert time (see
-- decomposer.js insertTask) so the owner-authored persona/voice can be
-- carried per-task through dispatch/conversion without re-reading the
-- objectives row on every hop.
ALTER TABLE tasks ADD COLUMN system_prompt TEXT;
