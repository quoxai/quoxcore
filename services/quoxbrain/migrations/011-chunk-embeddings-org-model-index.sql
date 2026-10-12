-- BRAIN2-AUDIT (2026-10-05): startup warm runs SELECT DISTINCT org_id and,
-- per org, SELECT DISTINCT model FROM chunk_embeddings on the main thread.
-- With no index both scanned every row, and each row carries a ~3KB vector
-- BLOB, so the event loop stalled ~8s on a 74k-vector org. A covering index
-- makes both index-only.
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_org_model ON chunk_embeddings(org_id, model);
