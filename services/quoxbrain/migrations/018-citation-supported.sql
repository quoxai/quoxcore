-- 018-citation-supported.sql — BRAIN2-W2 2: cited vs supported.
-- supported_count = how many of cited_count citations passed the collector's
-- deterministic LEXICAL support check (content-word overlap between the
-- sentence carrying the [B1] handle and the cited passage). NULL = the
-- collector predates the check (not measured), distinct from 0 (measured, none
-- supported). Additive, nullable: older collectors keep posting unchanged.
ALTER TABLE citation_events ADD COLUMN supported_count INTEGER;
