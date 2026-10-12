-- QUOXCHAT-BRUTALOOP ITER7: durable per-source storage accounting so the
-- published knowledge-storage limit (1 GB Standard / 5 GB Professional) can be
-- enforced. size_bytes = uploaded file size (file), extracted page text bytes
-- (url), utf8 bytes of question+answer (qa). NULL = legacy row written before
-- this column existed; usage reports those as ESTIMATED (chunk_count * a
-- documented constant, see routes/widgets.js KNOWLEDGE_EST_BYTES_PER_CHUNK).
ALTER TABLE widget_knowledge_sources ADD COLUMN size_bytes INTEGER;
