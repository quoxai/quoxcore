-- 032-citation-fabricated.sql: fabricated citations. An answer that cites a
-- handle never retrieved for the turn ([B99]) is counted here instead of being
-- ignored. NULL = the collector predates the count. Per-reference rows for a
-- fabricated handle are stored in citation_records with support_method
-- 'fabricated' and an empty note_id. Additive, nullable.
ALTER TABLE citation_events ADD COLUMN fabricated_count INTEGER;
