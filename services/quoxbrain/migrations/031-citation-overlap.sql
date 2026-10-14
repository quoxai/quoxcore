-- 031-citation-overlap.sql: honest labels for citation support.
-- A lexical-only pass means the source shares the claim's words; it was NOT
-- checked for meaning. supported_count now counts semantic entailment passes
-- only; overlap_count counts lexical-only passes. NULL overlap_count = the
-- collector predates the split. support_method on a record is 'entailment',
-- 'overlap' (lexical pass only) or NULL. Additive, nullable.
ALTER TABLE citation_events ADD COLUMN overlap_count INTEGER;
ALTER TABLE citation_records ADD COLUMN support_method TEXT;
