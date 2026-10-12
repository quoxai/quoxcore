-- BRAIN2-V3 B2 (2026-10-05): QuoxDream consolidates by INGESTION order.
-- The old cursor was (occurred_at, id), so a historical import ingested after
-- the cursor had passed its date (older occurred_at) was never read. The cursor
-- now also records the notes rowid (monotonic per insert) of the last note
-- consolidated; getNotesSinceCursor({afterIngestSeq}) reads rowid > seq.
-- Nullable: a legacy cursor (NULL) re-sweeps once from 0, which is idempotent
-- because every write is dedup-checked against QuoxMemory.
ALTER TABLE dream_cursor ADD COLUMN last_ingest_seq INTEGER;
