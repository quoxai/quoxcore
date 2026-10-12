-- Codex cycle 4 (2026-10-10): retractions used to retire after 8 failures of
-- any kind, so a memory-service outage stopped forgetting for good. Retirement
-- now needs a permanent rejection (HTTP 4xx other than 408/429). Resume every
-- row that was retired for anything else.
UPDATE belief_retraction_outbox
SET retired_at = NULL, attempts = 0, next_attempt_at = queued_at
WHERE retired_at IS NOT NULL
  AND (last_error IS NULL OR last_error NOT GLOB '*HTTP 4[0-9][0-9]*' OR last_error GLOB '*HTTP 408*' OR last_error GLOB '*HTTP 429*');
