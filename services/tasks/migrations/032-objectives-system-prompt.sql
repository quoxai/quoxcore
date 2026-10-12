-- 032-objectives-system-prompt.sql — MACH-FOLLOWUP WI-D
--
-- First-class per-task/objective system_prompt channel (owner-authored
-- persona/voice). See docs/STREAM_MACH_FOLLOWUP_PLAN.md §4.4. Rides
-- objective -> task rows -> agent:invoke node config -> quoxflow executor
-- body -> collector invoke -> /chat's existing caller-system_prompt merge.
ALTER TABLE objectives ADD COLUMN system_prompt TEXT;
