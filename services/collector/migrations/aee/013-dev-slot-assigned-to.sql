-- 013-dev-slot-assigned-to.sql — DEVSUITE-SLOTS "Option B" assign model
-- (design in QuoxPlan DEVSUITE-SLOTS plan v2, note #2831).
--
-- assigned_to records the EXPECTED holder of a slot: the owner assigns a
-- slot to a session name ahead of time, the slot stays FREE (this column
-- does not touch state/holder_session), and a session claims its assigned
-- slots at startup via POST /api/v1/slots/claim. This is additive to the
-- existing anonymous checkout/release flow; assigned_to is advisory only,
-- any session can still checkout a free slot directly by name.

ALTER TABLE dev_slots ADD COLUMN assigned_to TEXT;
