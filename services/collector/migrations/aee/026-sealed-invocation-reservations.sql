-- 026-sealed-invocation-reservations.sql, collector AEE database (aee.db)
--
-- SKILLRIGHTS ASTRA audit round 3 (2026-09-11), findings 1 and 9.
--
-- CORRECTION TO 025-sealed-skills.sql's header. That file's bytes are left
-- exactly as applied (migrations are append-only, and rewriting an applied
-- file's text makes every existing deployment log a checksum mismatch), so
-- the correction lands here instead.
--
-- SUPERSEDED, from 025: "Sealed execution keeps the text of your methodology
-- out of every model's context and every provider's training pipeline; it
-- does not prevent someone who can call the capability from learning what it
-- does." The external audit refuted it: lib/sealedExecutor.js puts the
-- plaintext methodology into the prompt it sends to the executing model, so
-- every successful invocation contradicted the first half, and nothing in the
-- implementation establishes any provider-training exclusion.
--
-- The binding sentence, from 2026-09-11, on every surface:
--   "Sealed execution keeps the text of your methodology out of the calling
--    model's context; the executing model and its provider do see it, under
--    that provider's data terms, and nothing here prevents someone who can
--    call the capability from learning what it does."
--
-- Finding 9 (rate limiter): usage was CHECKED before the run and RECORDED
-- after it, so N concurrent calls under a limit of 1 all passed. The limiter
-- now RESERVES before the first await by inserting the row up front with
-- status 'pending', inside the same synchronous transaction as the count, and
-- updates that row to its final status when the run settles. So status gains:
--   'pending'  a reservation held by a run that is in flight
-- A pending row whose process died is swept by the next reservation (it never
-- became a witnessed invocation: no envelope, no output hash), so a crash
-- cannot hold an org's quota hostage.
--
-- The org-wide ceiling (SEALED_INVOKE_ORG_RATE_PER_HOUR) counts every sealed
-- invocation by an org in the window, across skills, so it needs its own
-- index: the 025 index leads with (org_id, sealed_id) and cannot serve a
-- query that does not name a skill.

CREATE INDEX IF NOT EXISTS idx_sealed_invocations_org_created
  ON sealed_invocations(org_id, created_at);

-- The sweep and the pending-reservation count both filter on status first.
CREATE INDEX IF NOT EXISTS idx_sealed_invocations_status_created
  ON sealed_invocations(status, created_at);
