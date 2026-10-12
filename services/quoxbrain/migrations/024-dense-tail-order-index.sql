-- ONE-BRAIN CX1 (2026-10-09 incident): the dense fallback tail walks
-- chunk_embeddings newest first in keyset pages. With no index on that order,
-- every page scanned and sorted the whole visible set (3.4s per page at 100k
-- vectors), pinning the brain's main thread. Pages now read this index in order.
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_updated ON chunk_embeddings(updated_at DESC, chunk_id DESC);
